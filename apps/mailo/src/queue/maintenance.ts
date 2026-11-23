import type pg from "pg";
import { withTransaction } from "../db/index.js";
import { recordJobEvent, type JsonValue } from "../events/index.js";

const DEFAULT_BATCH = 500;

/**
 * 만료 시각이 지난 `PENDING`·`RETRY_WAIT` 작업을 `EXPIRED`로 바꾼다(ADR-0002 결정 7 주기 sweep).
 * 전역 차단기 상태를 보지 않으므로 `open`이어도 동작한다(ADR-0007 결정 6).
 * 작업 전이와 `JOB_EXPIRED` 이벤트를 같은 트랜잭션에서 쓴다(ADR-0006 결정 2). 이벤트 쓰기가 실패하면 전이도 롤백한다.
 * `SENDING` 작업은 진행 중인 시도를 중단하지 않으므로 대상이 아니다.
 * @returns 이번 호출에서 전이한 작업 수. 배치 크기와 같으면 남은 대상이 있을 수 있다.
 */
export async function sweepExpired(
  pool: pg.Pool,
  batchSize = DEFAULT_BATCH,
): Promise<number> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      id: string;
      caller_id: string;
      idempotency_key: string;
      attempts: number;
      recipients: JsonValue;
    }>(
      `WITH due AS (
         SELECT id FROM mail_jobs
          WHERE status IN ('PENDING', 'RETRY_WAIT') AND expires_at <= now()
          ORDER BY expires_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE mail_jobs SET
         status = 'EXPIRED', failure_reason = 'EXPIRED', finished_at = now()
       FROM due WHERE mail_jobs.id = due.id
       RETURNING mail_jobs.id, caller_id, idempotency_key, attempts, recipients`,
      [batchSize],
    );
    for (const row of rows) {
      await recordJobEvent(client, {
        type: "JOB_EXPIRED",
        callerId: row.caller_id,
        jobId: row.id,
        idempotencyKey: row.idempotency_key,
        failureReason: "EXPIRED",
        attemptCount: row.attempts,
        recipients: row.recipients,
      });
    }
    return rows.length;
  });
}

/**
 * 종결 후 유예 기간이 지난 작업의 본문 컬럼을 비운다(ADR-0008 결정 7).
 * 행, Key, 지문은 남긴다(ADR-0005 결정 7).
 * @param graceSeconds 종결 후 유예(기본 1일은 설정에서 넘긴다)
 * @returns 비운 작업 수
 */
export async function deleteExpiredBodies(
  pool: pg.Pool,
  graceSeconds: number,
  batchSize = DEFAULT_BATCH,
): Promise<number> {
  const result = await pool.query(
    `WITH due AS (
       SELECT id FROM mail_jobs
        WHERE finished_at IS NOT NULL AND body_ciphertext IS NOT NULL
          AND finished_at <= now() - make_interval(secs => $1::double precision)
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE mail_jobs SET
       body_ciphertext = NULL, body_nonce = NULL, body_key_version = NULL,
       body_deleted_at = now()
     FROM due WHERE mail_jobs.id = due.id`,
    [graceSeconds, batchSize],
  );
  return result.rowCount ?? 0;
}

export interface RetentionResult {
  jobs: number;
  rejections: number;
}

/**
 * 보존 기간이 지난 기록을 삭제한다(ADR-0005 결정 7, ADR-0006 결정 8).
 * - 작업 행: 종결 시각 기준. 종결되지 않은 작업의 Key는 지우지 않는다.
 *   `mail_attempts`와 작업의 `mail_events`는 외래 키 `ON DELETE CASCADE`로 함께 지운다.
 * - 수집 거부 기록: 생성 시각 기준. `INTAKE_REJECTED` 이벤트는 같은 방식으로 함께 지운다.
 * 삭제 뒤 같은 Key는 새 요청이다.
 */
export async function deleteExpiredRecords(
  pool: pg.Pool,
  retentionSeconds: number,
  batchSize = DEFAULT_BATCH,
): Promise<RetentionResult> {
  return withTransaction(pool, async (client) => {
    const jobs = await client.query(
      `DELETE FROM mail_jobs WHERE id IN (
         SELECT id FROM mail_jobs
          WHERE finished_at IS NOT NULL
            AND finished_at <= now() - make_interval(secs => $1::double precision)
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )`,
      [retentionSeconds, batchSize],
    );
    const rejections = await client.query(
      `DELETE FROM mail_intake_rejections WHERE id IN (
         SELECT id FROM mail_intake_rejections
          WHERE created_at <= now() - make_interval(secs => $1::double precision)
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )`,
      [retentionSeconds, batchSize],
    );
    return { jobs: jobs.rowCount ?? 0, rejections: rejections.rowCount ?? 0 };
  });
}
