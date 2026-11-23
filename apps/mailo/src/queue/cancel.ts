import type pg from "pg";
import { withTransaction } from "../db/index.js";
import { recordJobEvent, type JsonValue } from "../events/index.js";
import type { JobStatus } from "./types.js";

/** 취소한 주체. 저장 값 `failure_reason`은 `CANCELED_BY_<주체>`다(ADR-0011 결정 4). */
export type CanceledBy = "CALLER" | "OPERATOR";

/**
 * 취소 대상. `callerId` 범위 안에서 작업 ID나 Idempotency-Key로 고른다.
 * 관리 토큰 경로(다음 단계)는 같은 함수에 호출처 범위를 풀어 쓰는 입력을 더한다.
 */
export type CancelTarget =
  | { callerId: string; jobId: string }
  | { callerId: string; idempotencyKey: string };

export type CancelResult =
  /** 이번 호출이 `CANCELED`로 바꿨다. 이벤트를 썼다. */
  | { kind: "canceled"; jobId: string }
  /** 이미 `CANCELED`다. 이벤트와 시각을 새로 쓰지 않았다(멱등). */
  | { kind: "already_canceled"; jobId: string }
  /** `SENDING`이거나 종결 상태다. 아무것도 바꾸지 않았다. */
  | { kind: "not_cancelable"; status: JobStatus }
  /** 없거나 다른 호출처의 작업이다. 두 경우를 구분하지 않는다. */
  | { kind: "not_found" };

// 대상 조건만 다르고 나머지는 같다. 값은 모두 바인드 파라미터로 넘긴다.
const TARGET_SQL = {
  id: "caller_id = $1 AND id = $2::uuid",
  key: "caller_id = $1 AND idempotency_key = $2",
} as const;

/**
 * 대기 중인 작업을 취소한다(RQ-040, ADR-0011 결정 4). `PENDING`·`RETRY_WAIT`만 `CANCELED`로 바꾼다.
 *
 * - 전이, 본문 삭제, `JOB_CANCELED` 이벤트를 한 트랜잭션에서 쓴다. 이벤트 쓰기가 실패하면 전이도 롤백한다(ADR-0006 결정 2).
 * - 본문 컬럼 세 개를 함께 비운다(`mail_jobs_body_state`). 행, Key, 지문은 남긴다(ADR-0005 결정 7).
 * - `claim`과의 경합은 작업 행 잠금이 직렬화한다. 이 경로는 작업 행만 잠그고 `mail_circuit_breaker`를 건드리지 않아
 *   잠금 순서(작업 행 → 차단기 행)를 어기지 않는다.
 *   - `claim`이 행을 잡고 있으면 UPDATE는 기다린 뒤 `SENDING`을 보고 갱신하지 않으며 `not_cancelable`이 된다.
 *   - 취소가 행을 잡고 있으면 `claim`의 `SKIP LOCKED`가 그 행을 건너뛴다.
 * - 이미 `CANCELED`이면 `already_canceled`다. `canceledBy`가 달라도 처음 값을 바꾸지 않는다.
 * - 진행 중 전송(`SENDING`)은 중단하지 않는다(ADR-0009 결정 8).
 */
export async function cancelJob(
  pool: pg.Pool,
  target: CancelTarget,
  canceledBy: CanceledBy,
): Promise<CancelResult> {
  const [where, value] =
    "jobId" in target
      ? ([TARGET_SQL.id, target.jobId] as const)
      : ([TARGET_SQL.key, target.idempotencyKey] as const);

  return withTransaction(pool, async (client) => {
    const failureReason = `CANCELED_BY_${canceledBy}`;
    const updated = await client.query<{
      id: string;
      caller_id: string;
      idempotency_key: string;
      attempts: number;
      recipients: JsonValue;
    }>(
      `UPDATE mail_jobs SET
         status = 'CANCELED', failure_reason = $3, finished_at = now(),
         body_ciphertext = NULL, body_nonce = NULL, body_key_version = NULL, body_deleted_at = now()
       WHERE ${where} AND status IN ('PENDING', 'RETRY_WAIT')
       RETURNING id, caller_id, idempotency_key, attempts, recipients`,
      [target.callerId, value, failureReason],
    );
    const row = updated.rows[0];
    if (row) {
      await recordJobEvent(client, {
        type: "JOB_CANCELED",
        callerId: row.caller_id,
        jobId: row.id,
        idempotencyKey: row.idempotency_key,
        failureReason,
        attemptCount: row.attempts,
        recipients: row.recipients,
      });
      return { kind: "canceled", jobId: row.id } as const;
    }

    // 갱신하지 않았다. 잠금 대기 뒤 커밋된 현재 상태를 읽어 이유를 가른다(READ COMMITTED).
    const current = await client.query<{ id: string; status: JobStatus }>(
      `SELECT id, status FROM mail_jobs WHERE ${where}`,
      [target.callerId, value],
    );
    const found = current.rows[0];
    if (!found) return { kind: "not_found" } as const;
    if (found.status === "CANCELED")
      return { kind: "already_canceled", jobId: found.id } as const;
    return { kind: "not_cancelable", status: found.status } as const;
  });
}
