import type pg from "pg";
import { withTransaction } from "../db/index.js";
import {
  recordJobEvent,
  recordPurgedJobEvents,
  recordPurgedRejectionEvents,
  type JsonValue,
} from "../events/index.js";
import { notifyTransitions } from "./transitions.js";
import type { JobTransition, TransitionListener } from "./types.js";

/**
 * 정리 배치 한 번의 행 수 상한. 한 트랜잭션이 1초 안팎에 끝나도록 잡은 추정값이다.
 * 트랜잭션이 길어지면 xid가 오래 열려 이벤트 피드 cursor(xmin 기반)가 멈추고 `statement_timeout`에 걸리기 쉽다.
 */
export const MAINTENANCE_BATCH_SIZE = 1000;
const DEFAULT_BATCH = MAINTENANCE_BATCH_SIZE;

// advisory lock의 앞 정수(키 공간 구분). 할당 잠금(7364222)·마이그레이터(1-인자 형식)와 겹치지 않는다.
const MAINTENANCE_LOCK_CLASS = 7_364_223;

/** 정리 단계. 단계마다 잠금이 달라 서로 다른 인스턴스가 다른 단계를 동시에 돌 수 있다. */
export type MaintenanceStep = "sweep" | "lease" | "bodies" | "records";
const STEP_LOCK_KEY: Record<MaintenanceStep, number> = {
  sweep: 1,
  lease: 2,
  bodies: 3,
  records: 4,
};

/**
 * 정리 단계의 배타 잠금을 시도한다. 트랜잭션의 첫 문장으로 부르고 기다리지 않는다.
 * 트랜잭션 수준이라 커밋·롤백·연결 폐기 때 풀리므로 해제 누락이 없다.
 * 못 잡으면 다른 인스턴스가 같은 단계를 도는 중이므로 호출자는 이번 단계를 건너뛴다.
 * 배치마다 따로 잡으므로 단계 사이에 다른 인스턴스가 끼어들어도 정합성은 `SKIP LOCKED`가 지킨다.
 */
export async function tryMaintenanceLock(
  client: pg.PoolClient,
  step: MaintenanceStep,
): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS locked",
    [MAINTENANCE_LOCK_CLASS, STEP_LOCK_KEY[step]],
  );
  return rows[0]?.locked === true;
}

/**
 * 만료 시각이 지난 `PENDING`·`RETRY_WAIT` 작업을 `EXPIRED`로 바꾼다(ADR-0002 결정 7 주기 sweep).
 * 전역 차단기 상태를 보지 않으므로 `open`이어도 동작한다(ADR-0007 결정 6).
 * 작업 전이와 `JOB_EXPIRED` 이벤트를 같은 트랜잭션에서 쓴다(ADR-0006 결정 2). 이벤트 쓰기가 실패하면 전이도 롤백한다.
 * `SENDING` 작업은 진행 중인 시도를 중단하지 않으므로 대상이 아니다.
 * 정리 잠금(`tryMaintenanceLock`)을 못 잡으면 아무것도 하지 않고 0을 돌려준다.
 * @param onTransitions 커밋한 뒤 전이한 작업의 호출처와 상태를 한 번 알린다(지표용, ADR-0012 결정 7). 롤백되면 부르지 않는다.
 * @returns 이번 호출에서 전이한 작업 수. 배치 크기와 같으면 남은 대상이 있을 수 있다.
 */
export async function sweepExpired(
  pool: pg.Pool,
  batchSize = DEFAULT_BATCH,
  onTransitions?: TransitionListener,
): Promise<number> {
  const transitions: JobTransition[] = [];
  const count = await withTransaction(pool, async (client) => {
    if (!(await tryMaintenanceLock(client, "sweep"))) return 0;
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
      transitions.push({ callerId: row.caller_id, status: "EXPIRED" });
    }
    return rows.length;
  });
  notifyTransitions(onTransitions, transitions);
  return count;
}

/**
 * 종결 후 유예 기간이 지난 작업의 본문 컬럼을 비운다(ADR-0008 결정 7).
 * 행, Key, 지문은 남긴다(ADR-0005 결정 7).
 * 정리 잠금을 못 잡으면 0을 돌려준다.
 * @param graceSeconds 종결 후 유예(기본 1일은 설정에서 넘긴다)
 * @returns 비운 작업 수
 */
export async function deleteExpiredBodies(
  pool: pg.Pool,
  graceSeconds: number,
  batchSize = DEFAULT_BATCH,
): Promise<number> {
  return withTransaction(pool, async (client) => {
    if (!(await tryMaintenanceLock(client, "bodies"))) return 0;
    const result = await client.query(
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
  });
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
 * - 같은 트랜잭션에서 지워지는 이벤트의 호출처·종류별 최대 `(txid, id)`를 삭제 표지에 올린다(ADR-0011 결정 9, RQ-045).
 *   표지 갱신이나 삭제 중 하나가 실패하면 둘 다 롤백한다.
 * 삭제 뒤 같은 Key는 새 요청이다. 정리 잠금을 못 잡으면 0건이다.
 */
export async function deleteExpiredRecords(
  pool: pg.Pool,
  retentionSeconds: number,
  batchSize = DEFAULT_BATCH,
): Promise<RetentionResult> {
  return withTransaction(pool, async (client) => {
    if (!(await tryMaintenanceLock(client, "records")))
      return { jobs: 0, rejections: 0 };
    // 지울 행을 먼저 잠그고(`SKIP LOCKED`) 이벤트 삭제 표지를 올린 뒤 지운다. 이벤트는 cascade로 지워져
    // `RETURNING`에 나오지 않으므로 삭제 전에 읽어야 한다. 한 트랜잭션이라 표지와 삭제는 함께 커밋·롤백한다(ADR-0011 결정 9).
    const jobIds = await client.query<{ id: string }>(
      `SELECT id FROM mail_jobs
        WHERE finished_at IS NOT NULL
          AND finished_at <= now() - make_interval(secs => $1::double precision)
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [retentionSeconds, batchSize],
    );
    const jobs = await deleteByIds(
      client,
      "mail_jobs",
      "uuid",
      jobIds.rows.map((r) => r.id),
      recordPurgedJobEvents,
    );
    const rejectionIds = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM mail_intake_rejections
        WHERE created_at <= now() - make_interval(secs => $1::double precision)
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [retentionSeconds, batchSize],
    );
    const rejections = await deleteByIds(
      client,
      "mail_intake_rejections",
      "bigint",
      rejectionIds.rows.map((r) => r.id),
      recordPurgedRejectionEvents,
    );
    return { jobs, rejections };
  });
}

/** 표지를 올린 뒤 `ids` 행을 지운다. 호출자가 `ids`를 `FOR UPDATE`로 잡은 같은 트랜잭션의 client를 넘긴다. */
async function deleteByIds(
  client: pg.PoolClient,
  table: "mail_jobs" | "mail_intake_rejections",
  idType: "uuid" | "bigint",
  ids: readonly string[],
  markPurged: (db: pg.PoolClient, ids: readonly string[]) => Promise<void>,
): Promise<number> {
  if (ids.length === 0) return 0;
  await markPurged(client, ids);
  const result = await client.query(
    `DELETE FROM ${table} WHERE id = ANY($1::${idType}[])`,
    [ids],
  );
  return result.rowCount ?? 0;
}
