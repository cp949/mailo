/**
 * 입력 폴더의 파일 하나를 안전하게 읽는다(ADR-0004 결정 5의 1~2단계).
 *
 * - `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`으로 열고 `fstat`으로 확인한다. `lstat` 뒤에 `open`하는 순서는
 *   그 사이에 파일이 바뀔 수 있어 쓰지 않는다.
 * - `O_NONBLOCK`이 없으면 이름이 `*.json`인 FIFO를 여는 순간 폴러가 멈춘다.
 * - 일반 파일이고 `st_nlink == 1`이어야 읽는다. `st_nlink == 0`은 open 뒤에 이름이 지워진 파일이라 `gone`이다. 심볼릭 링크·FIFO·소켓·디렉터리·하드링크는 내용을 읽지 않는다.
 *   하드링크는 다른 파일(다른 호출처의 파일 등)을 가리킬 수 있어, 읽으면 해시로 내용을 추측하는 통로가 된다.
 * - 읽기는 상한 + 1바이트까지만 한다. 호출처가 `rename` 뒤에도 파일을 열어 두고 추가로 쓸 수 있으므로
 *   `fstat` 크기는 읽을 양을 정하는 데 쓰지 않는다.
 *
 * 거부 기록의 sha256 정책(ADR-0004 "구현 중 확정")
 * - 끝까지 읽은 파일: 파일 전체의 sha256.
 * - 크기 초과 파일: 처음 `상한 + 1`바이트의 sha256. 읽기 양이 정확히 정해져 있어 청크 크기와 무관하게 같은 값이 나온다.
 *   파일 전체를 해시하면 계속 커지는 파일이나 매우 큰 파일에서 폴러가 오래 붙잡힌다.
 * - 내용을 읽지 않은 파일: 빈 입력의 sha256과 크기 0.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { errnoCode, isStale } from "./errno.js";

/** 빈 입력의 sha256. 내용을 읽지 않은 파일의 거부 기록에 쓴다. */
export const EMPTY_SHA256 = createHash("sha256").digest("hex");

const OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CHUNK_BYTES = 64 * 1024;

/** 같은 파일인지 확인하는 식별자. 삭제 직전에 이름이 다른 파일로 바뀌지 않았는지 비교한다. */
export interface FileIdent {
  dev: bigint;
  ino: bigint;
}

export type NotReadKind = "SYMLINK" | "NOT_REGULAR" | "HARDLINK";

export type ReadOutcome =
  /** 읽기 전에 이미 사라졌다. 다른 인스턴스가 처리했을 수 있다. */
  | { kind: "gone" }
  /** 권한 때문에 열 수 없다. 운영 구성 오류일 수 있어 거부하지 않고 남겨 둔다. */
  | { kind: "unreadable"; code: string }
  | { kind: "not_read"; why: NotReadKind; ident: FileIdent | null }
  | { kind: "oversize"; sizeBytes: number; sha256: string; ident: FileIdent }
  | {
      kind: "read";
      bytes: Buffer;
      sizeBytes: number;
      sha256: string;
      ident: FileIdent;
    };

async function identOf(path: string): Promise<FileIdent | null> {
  try {
    const stat = await lstat(path, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

export async function readInboxFile(
  path: string,
  maxBytes: number,
  /** `open` 성공 직후, `fstat` 전에 부른다. 테스트가 이 틈에 다른 인스턴스의 삭제를 흉내 낸다. */
  afterOpen?: () => Promise<void> | void,
): Promise<ReadOutcome> {
  let handle;
  try {
    handle = await open(path, OPEN_FLAGS);
  } catch (error) {
    switch (errnoCode(error)) {
      case "ENOENT":
      // NFS에서 다른 인스턴스·호출처가 지운 파일이다(errno.ts). 없어진 것과 같게 다룬다.
      case "ESTALE":
        return { kind: "gone" };
      case "ELOOP":
        return { kind: "not_read", why: "SYMLINK", ident: await identOf(path) };
      case "ENXIO": // 소켓 등. 읽는 쪽 open이 실패하는 특수 파일이다.
        return {
          kind: "not_read",
          why: "NOT_REGULAR",
          ident: await identOf(path),
        };
      case "EACCES":
      case "EPERM":
        return { kind: "unreadable", code: errnoCode(error) };
      default:
        throw error;
    }
  }

  try {
    await afterOpen?.();
    const stat = await handle.stat({ bigint: true });
    const ident = { dev: stat.dev, ino: stat.ino };
    if (!stat.isFile()) return { kind: "not_read", why: "NOT_REGULAR", ident };
    // 열고 나서 fstat 전에 다른 인스턴스·호출처가 이름을 지우면 nlink가 0이다. 하드링크가 아니라 사라진 파일이므로
    // 거부하지 않고 gone으로 다룬다. 다른 인스턴스는 DB 커밋 뒤에만 지우므로 이 파일은 이미 처리됐거나 호출처가 회수했다.
    if (stat.nlink === 0n) return { kind: "gone" };
    if (stat.nlink !== 1n) return { kind: "not_read", why: "HARDLINK", ident };

    const limit = maxBytes + 1;
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < limit) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, limit - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const part = buffer.subarray(0, bytesRead);
      hash.update(part);
      chunks.push(part);
      total += bytesRead;
    }
    const sha256 = hash.digest("hex");
    if (total > maxBytes) {
      return {
        kind: "oversize",
        // fstat 크기는 열 때의 값이라 이후 커진 만큼 작을 수 있다. 읽은 양보다 작게 적지 않는다.
        sizeBytes: Math.max(Number(stat.size), total),
        sha256,
        ident,
      };
    }
    return {
      kind: "read",
      bytes: Buffer.concat(chunks, total),
      sizeBytes: total,
      sha256,
      ident,
    };
  } catch (error) {
    // open 뒤 fstat·read에서 ESTALE이 나는 경우가 있다(NFS에서 파일이 열린 뒤 다른 클라이언트가 지웠다).
    if (isStale(error)) return { kind: "gone" };
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
