/**
 * 파일 하나의 수집(ADR-0004 결정 5·6, ADR-0006 결정 3, ADR-0008 결정 3).
 *
 * 읽기(`read-file.ts`) → `openRequest`(JWS·스키마·JWE·검증·지문) → `register`(멱등) → DB 커밋 뒤 원본 삭제.
 * 거부는 거부 기록과 `INTAKE_REJECTED` 이벤트를 한 트랜잭션에 쓴 뒤 원본을 삭제한다.
 * 기록 커밋 뒤 삭제 전에 종료돼도 다시 수집될 때 같은 Key(등록)나 같은 `(caller_id, 파일 이름, sha256)`(거부)로 걸러진다.
 *
 * 로그와 거부 기록에는 사유 코드, 크기, sha256, 파일 이름만 남기고 파일 내용은 남기지 않는다(RQ-027).
 */
import { lstat, unlink } from "node:fs/promises";
import type pg from "pg";
import type { CallerEntry } from "../callers/index.js";
import type { QueueBodyCipher, QueueFingerprinter } from "../crypto/index.js";
import { withTransaction } from "../db/index.js";
import {
  openRequest,
  toRegisterInput,
  toRejectionReason,
  type OpenRequestDeps,
  type RejectionReasonCode,
} from "../envelope/index.js";
import { recordIntakeRejection } from "../events/index.js";
import { register } from "../queue/index.js";
import { isSenderAllowed } from "../validation/index.js";
import type { AppLogger } from "../logging/index.js";
import { errnoCode, isStale } from "./errno.js";
import { peekIdempotencyKey } from "./key-hint.js";
import { EMPTY_SHA256, readInboxFile, type FileIdent } from "./read-file.js";

export type IngestOutcome =
  | "registered"
  | "duplicate"
  /** 거부를 새로 기록하고 원본을 지웠다. */
  | "rejected"
  /** 이미 기록된 거부다(재수집). 원본만 지웠다. */
  | "rejected_repeat"
  | "gone"
  | "unreadable";

export interface IngestResult {
  outcome: IngestOutcome;
  /** 원본을 지웠거나 이미 없거나 다른 파일로 바뀌어 건드리지 않았다. 다음 폴링에서 같은 파일을 다시 만나지 않는다. */
  settled: boolean;
  /** 등록·거부 기록은 커밋했지만 원본 삭제에 실패했다(errno 코드). 다음 폴링에서 같은 Key·같은 거부로 걸러진다. */
  deleteFailed?: string;
  /** `gone`의 원인이 열린 뒤 nlink 0이다. 폴러가 같은 경로의 연속 횟수를 센다(`read-file.ts`). */
  nlinkZero?: true;
}

export interface IngestDeps {
  pool: pg.Pool;
  envelope: OpenRequestDeps;
  cipher: QueueBodyCipher;
  fingerprinter: QueueFingerprinter;
  maxFileBytes: number;
  jobExpirySeconds: number;
  /** 기본 발신 주소(`config.smtp.defaultFrom`). 모든 호출처가 쓸 수 있는 발신 주소다. */
  defaultFrom: string;
  logger: AppLogger;
  /** 등록·거부 기록 커밋 뒤, 원본 삭제 전에 부른다. 테스트가 이 시점의 종료·파일 교체를 흉내 낸다. */
  beforeDelete?: (info: {
    callerId: string;
    fileName: string;
    path: string;
  }) => Promise<void> | void;
}

/** 대상이 이미 없다: `ENOENT`이거나 NFS에서 다른 클라이언트가 지워 `ESTALE`이 난 경우(errno.ts). 오류가 아니다. */
function isGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT" || isStale(error);
}

/**
 * 삭제 직전에 이름이 처음 읽은 파일을 가리키는지 확인한다. 읽은 뒤 호출처가 같은 이름으로 새 파일을 rename해 덮었다면
 * 그 파일은 읽은 적이 없으므로 지우지 않는다(다음 폴링이 수집한다). 이 확인과 `unlink` 사이의 짧은 틈은 남는다.
 * 이미 없으면 오류가 아니다(ADR-0004 결정 6).
 */
async function removeSource(
  path: string,
  ident: FileIdent | null,
): Promise<"deleted" | "gone" | "replaced"> {
  if (ident !== null) {
    let current;
    try {
      current = await lstat(path, { bigint: true });
    } catch (error) {
      if (isGone(error)) return "gone";
      throw error;
    }
    if (current.dev !== ident.dev || current.ino !== ident.ino)
      return "replaced";
  }
  try {
    await unlink(path);
    return "deleted";
  } catch (error) {
    if (isGone(error)) return "gone";
    throw error;
  }
}

export async function ingestFile(
  deps: IngestDeps,
  caller: CallerEntry,
  path: string,
  fileName: string,
): Promise<IngestResult> {
  const read = await readInboxFile(path, deps.maxFileBytes);
  if (read.kind === "gone")
    return {
      outcome: "gone",
      settled: true,
      ...(read.nlinkZero && { nlinkZero: true as const }),
    };
  if (read.kind === "unreadable")
    return { outcome: "unreadable", settled: false };

  const ident: FileIdent | null = read.ident;

  // DB 커밋이 끝난 뒤에만 부른다. 삭제 실패는 오류가 아니다. 파일이 남아 다시 수집돼도 중복 등록·중복 기록이 생기지 않는다.
  const finish = async (outcome: IngestOutcome): Promise<IngestResult> => {
    await deps.beforeDelete?.({ callerId: caller.id, fileName, path });
    try {
      await removeSource(path, ident);
    } catch (error) {
      const code = errnoCode(error);
      deps.logger.warn("file_delete_failed", { callerId: caller.id, code });
      return { outcome, settled: false, deleteFailed: code };
    }
    return { outcome, settled: true };
  };

  const reject = async (
    reasonCode: RejectionReasonCode,
    record: { sizeBytes: number; sha256: string; key: string | null },
  ): Promise<IngestResult> => {
    const id = await withTransaction(deps.pool, (client) =>
      recordIntakeRejection(client, {
        callerId: caller.id,
        fileName,
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
        idempotencyKey: record.key,
        reasonCode,
      }),
    );
    if (id !== null)
      deps.logger.info("file_rejected", {
        callerId: caller.id,
        reasonCode,
        // 파일 이름은 호출처가 정하므로 로그에 남기지 않는다. 거부 기록 id로 DB·이벤트 피드에서 찾는다.
        rejectionId: id,
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
      });
    return finish(id !== null ? "rejected" : "rejected_repeat");
  };

  if (read.kind === "not_read")
    return reject("MALFORMED", {
      sizeBytes: 0,
      sha256: EMPTY_SHA256,
      key: null,
    });
  if (read.kind === "oversize")
    return reject("SIZE_EXCEEDED", {
      sizeBytes: read.sizeBytes,
      sha256: read.sha256,
      key: null,
    });

  const opened = await openRequest(
    { kind: "file", bytes: read.bytes },
    {
      ...deps.envelope,
      callerId: caller.id,
      signature: { mode: caller.signature.mode, keys: caller.signature.keys },
    },
  );
  const fileRecord = { sizeBytes: read.sizeBytes, sha256: read.sha256 };
  if (!opened.ok) {
    return reject(toRejectionReason(opened.reason), {
      ...fileRecord,
      key: peekIdempotencyKey(read.bytes, caller.signature.mode, opened.reason),
    });
  }
  const key = opened.idempotencyKey;
  if (key === null)
    return reject("IDEMPOTENCY_KEY_MISSING", { ...fileRecord, key: null });

  const registered = await register(
    deps.pool,
    { cipher: deps.cipher, fingerprinter: deps.fingerprinter },
    toRegisterInput(opened, {
      callerId: caller.id,
      idempotencyKey: key,
      expiresInSeconds: deps.jobExpirySeconds,
      denyNew: !isSenderAllowed(
        opened.request.from,
        deps.defaultFrom,
        caller.allowedFrom,
      ),
    }),
  );
  // 허용되지 않은 발신 주소는 새 작업이 될 때만 거부한다. 이미 등록된 Key는 `duplicate`다(REST와 같은 규칙).
  if (registered.kind === "denied")
    return reject("VALIDATION_FAILED", { ...fileRecord, key });
  if (registered.kind === "fingerprint_mismatch")
    return reject("FINGERPRINT_MISMATCH", { ...fileRecord, key });

  return finish(registered.kind === "created" ? "registered" : "duplicate");
}

/** 점(.) 임시 파일이 오래됐으면 지운다. 디렉터리는 건드리지 않는다. 지웠으면 true. */
export async function removeStaleTemp(
  path: string,
  nowMs: number,
  maxAgeMs: number,
): Promise<boolean> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isGone(error)) return false;
    throw error;
  }
  if (stat.isDirectory() || nowMs - stat.mtimeMs <= maxAgeMs) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isGone(error)) return false;
    throw error;
  }
}
