/**
 * 파일 채널 디렉터리(root, `<root>/inbox`, `<root>/inbox/<caller_id>`)의 종류와 권한 검사.
 * 파일은 `O_NOFOLLOW`로 열지만 디렉터리 경로는 따라가므로, 디렉터리가 링크로 바뀌면 다른 곳의 파일을 읽을 수 있다.
 * 그래서 폴링마다 `lstat`으로 링크가 아닌 디렉터리인지 확인한다(링크이면 그 폴링에서 읽지 않는다).
 * 권한이 넓은 것은 거부하지 않고 경고만 한다. NFS·ACL·umask가 어긋난 환경에서 기동과 수집을 막지 않기 위해서다.
 */
import { lstat } from "node:fs/promises";
import { errnoCode, isStale } from "./errno.js";

export type DirKind = "root" | "inbox" | "callerInbox";

export type DirState =
  /** 없거나 경로 중간이 디렉터리가 아니다. 기존 처리(`file_inbox_missing`)가 맡는다. */
  | { kind: "missing" }
  | { kind: "stale" }
  /** 링크이거나 디렉터리가 아니다. 읽지 않는다. */
  | { kind: "unsafe"; why: "SYMLINK" | "NOT_DIRECTORY" }
  | { kind: "ok"; mode: number };

export async function inspectDir(path: string): Promise<DirState> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return { kind: "unsafe", why: "SYMLINK" };
    if (!stat.isDirectory()) return { kind: "unsafe", why: "NOT_DIRECTORY" };
    return { kind: "ok", mode: stat.mode & 0o7777 };
  } catch (error) {
    if (isStale(error)) return { kind: "stale" };
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    throw error;
  }
}

/**
 * 경고할 만큼 넓은 권한인가. 그룹 쓰기는 호출처 폴더에서 제외한다.
 * 호출처 폴더는 권장 구성(default ACL)에서 ACL 마스크가 그룹 비트로 보여 `g+w`가 정상이다.
 * 권장 구성의 root·inbox 모드는 `0755`·`0711`이다(`docs/operations/caller-onboarding.md`).
 */
export function isPermissive(kind: DirKind, mode: number): boolean {
  if ((mode & 0o002) !== 0) return true;
  return kind !== "callerInbox" && (mode & 0o020) !== 0;
}
