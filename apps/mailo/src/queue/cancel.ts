import type pg from "pg";
import { withTransaction } from "../db/index.js";
import { recordJobEvent, type JsonValue } from "../events/index.js";
import type { JobStatus } from "./types.js";

/** 취소한 주체. 저장 값 `failure_reason`은 `CANCELED_BY_<주체>`다(ADR-0011 결정 4). */
export type CanceledBy = "CALLER" | "OPERATOR";

/**
 * 호출처 API의 취소 대상. `callerId` 범위 안에서 작업 ID나 Idempotency-Key로 고른다.
 * 호출처 범위를 푸는 관리 토큰 경로는 `OperatorCancelTarget`을 쓴다.
 */
export type CancelTarget =
  | { callerId: string; jobId: string }
  | { callerId: string; idempotencyKey: string };

export type CancelResult =
  /**
   * 이번 호출이 `CANCELED`로 바꿨다. 이벤트를 썼다.
   * `callerId`는 작업의 호출처다. 호출처 범위가 없는 관리 취소가 지표 라벨을 정하는 데 쓴다(ADR-0012 결정 4).
   */
  | { kind: "canceled"; jobId: string; callerId: string; accountId: string }
  /** 이미 `CANCELED`다. 이벤트와 시각을 새로 쓰지 않았다(멱등). */
  | { kind: "already_canceled"; jobId: string }
  /** `SENDING`이거나 종결 상태다. 아무것도 바꾸지 않았다. */
  | { kind: "not_cancelable"; status: JobStatus }
  /** 없거나 다른 호출처의 작업이다. 두 경우를 구분하지 않는다. */
  | { kind: "not_found" };

/**
 * 관리 토큰 경로의 취소 대상. 호출처 범위를 풀고 작업 ID만으로 고른다(ADR-0011 결정 4).
 * 호출처 API 경로(`CancelTarget`)와 입력 모양을 달리해 호출처 키 경로에서 범위가 풀리는 일이 없게 한다.
 */
export type OperatorCancelTarget = { jobId: string };

// 대상 조건만 다르고 나머지는 같다. 값은 모두 바인드 파라미터로 넘기고 `from`은 첫 대상 파라미터의 번호다.
interface PreparedTarget {
  where: (from: number) => string;
  values: readonly string[];
}

function prepare(target: CancelTarget | OperatorCancelTarget): PreparedTarget {
  if (!("callerId" in target))
    return { where: (n) => `id = $${n}::uuid`, values: [target.jobId] };
  return "jobId" in target
    ? {
        where: (n) => `caller_id = $${n} AND id = $${n + 1}::uuid`,
        values: [target.callerId, target.jobId],
      }
    : {
        where: (n) => `caller_id = $${n} AND idempotency_key = $${n + 1}`,
        values: [target.callerId, target.idempotencyKey],
      };
}

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
  return withTransaction(pool, (client) =>
    cancelWithin(client, prepare(target), canceledBy),
  );
}

/**
 * 관리 토큰 경로의 취소(RQ-044, ADR-0011 결정 4·6). 호출처 범위 없이 작업 ID로 취소하고 `OPERATOR`로 기록한다.
 * 호출자가 연 트랜잭션 안에서 실행한다. 감사 기록을 같은 트랜잭션에 쓰려는 것이다.
 * 이미 `CANCELED`·취소 불가·없음이면 아무것도 쓰지 않으므로 호출자는 `canceled`일 때만 감사를 쓴다.
 */
export function cancelJobAsOperator(
  client: pg.PoolClient,
  target: OperatorCancelTarget,
): Promise<CancelResult> {
  return cancelWithin(client, prepare(target), "OPERATOR");
}

async function cancelWithin(
  client: pg.PoolClient,
  { where, values }: PreparedTarget,
  canceledBy: CanceledBy,
): Promise<CancelResult> {
  const failureReason = `CANCELED_BY_${canceledBy}`;
  const updated = await client.query<{
    id: string;
    caller_id: string;
    account_id: string;
    idempotency_key: string;
    attempts: number;
    recipients: JsonValue;
  }>(
    `UPDATE mail_jobs SET
       status = 'CANCELED', failure_reason = $1, finished_at = now(),
       body_ciphertext = NULL, body_nonce = NULL, body_key_version = NULL, body_deleted_at = now()
     WHERE ${where(2)} AND status IN ('PENDING', 'RETRY_WAIT')
     RETURNING id, caller_id, account_id, idempotency_key, attempts, recipients`,
    [failureReason, ...values],
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
    return {
      kind: "canceled",
      jobId: row.id,
      callerId: row.caller_id,
      accountId: row.account_id,
    } as const;
  }

  // 갱신하지 않았다. 잠금 대기 뒤 커밋된 현재 상태를 읽어 이유를 가른다(READ COMMITTED).
  const current = await client.query<{ id: string; status: JobStatus }>(
    `SELECT id, status FROM mail_jobs WHERE ${where(1)}`,
    [...values],
  );
  const found = current.rows[0];
  if (!found) return { kind: "not_found" } as const;
  if (found.status === "CANCELED")
    return { kind: "already_canceled", jobId: found.id } as const;
  return { kind: "not_cancelable", status: found.status } as const;
}
