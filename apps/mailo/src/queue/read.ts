/**
 * 작업 조회 읽기 모델(RQ-015). REST가 `Job` 응답을 만들 때 쓴다. `mail_jobs`·`mail_attempts` 소유 모듈이 쿼리를 가진다.
 * 모든 조회는 `caller_id`로 범위를 제한한다. 다른 호출처의 작업은 "없음"과 같다(null).
 * 본문 컬럼과 수신자는 읽지 않는다.
 * 시도 응답 텍스트(`response_text`)는 수신자 주소가 섞일 수 있어 읽지 않는다(ADR-0007).
 */
import type { Queryable } from "../db/index.js";
import type { JsonValue } from "../events/index.js";
import { priorityFromRank, type Priority } from "./priority.js";
import { UNCERTAIN_ATTEMPT_SQL } from "./uncertain.js";
import type { JobStatus } from "./types.js";

export interface JobLastError {
  /** `TRANSIENT`, `PERMANENT`, `ACCOUNT`, `LEASE_EXPIRED` */
  category: string;
  responseCode: number | null;
  enhancedCode: string | null;
  occurredAt: Date;
}

export interface JobView {
  id: string;
  /** 작업의 호출처. 호출처 응답에는 내지 않고 운영자 읽기(`/ops/jobs/{jobId}`)가 쓴다. */
  callerId: string;
  /** 작업의 SMTP 계정 ID(ADR-0013 결정 2). 호출처 응답에는 내지 않고 운영자 읽기가 쓴다(결정 5·6). */
  accountId: string;
  idempotencyKey: string;
  status: JobStatus;
  /** 등록한 우선순위 등급(RQ-037). 도입 전 작업은 `NORMAL`이다. DB 순위 숫자는 내보내지 않는다. */
  priority: Priority;
  attempts: number;
  createdAt: Date;
  expiresAt: Date;
  /** 종결(SENT·FAILED·EXPIRED·CANCELED) 시각. 종결 전이면 null. */
  finishedAt: Date | null;
  /** DB에 저장된 값(`PERMANENT`, `ATTEMPTS_EXHAUSTED`, `ACCOUNT_REPEATED`, `EXPIRED`, 취소는 `CANCELED_BY_CALLER`·`CANCELED_BY_OPERATOR`). 응답 이름 변환은 호출자가 한다. */
  failureReason: string | null;
  lastError: JobLastError | null;
  /**
   * SMTP 서버가 메일을 수락했는지 알 수 없는 시도가 한 건이라도 있었으면 true다(RQ-048, ADR-0011 결정 5).
   * `FAILED`·`EXPIRED`이면 메일이 이미 나갔을 수 있고 `SENT`이면 더 일찍 나갔을 수 있다.
   */
  outcomeUncertain: boolean;
  /** `SENT` 시도가 기록한 거부 수신자. 없으면 null. */
  rejectedRecipients: JsonValue | null;
}

interface JobRow {
  id: string;
  caller_id: string;
  account_id: string;
  idempotency_key: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  created_at: Date;
  expires_at: Date;
  finished_at: Date | null;
  failure_reason: string | null;
  le_classification: string | null;
  le_response_code: number | null;
  le_enhanced_code: string | null;
  le_finished_at: Date | null;
  outcome_uncertain: boolean;
  sent_rejected_recipients: JsonValue | null;
}

// 마지막 오류는 SENT가 아닌 가장 최근 시도다. SENT 작업도 이전 시도의 오류를 보여 준다.
const SELECT_JOB = `
  SELECT j.id, j.caller_id, j.account_id, j.idempotency_key, j.status, j.priority, j.attempts, j.created_at, j.expires_at,
         j.finished_at, j.failure_reason,
         le.classification AS le_classification, le.response_code AS le_response_code,
         le.enhanced_code AS le_enhanced_code, le.finished_at AS le_finished_at,
         EXISTS (SELECT 1 FROM mail_attempts a WHERE a.job_id = j.id AND ${UNCERTAIN_ATTEMPT_SQL}) AS outcome_uncertain,
         sa.rejected_recipients AS sent_rejected_recipients
    FROM mail_jobs j
    LEFT JOIN LATERAL (
      SELECT classification, response_code, enhanced_code, finished_at
        FROM mail_attempts WHERE job_id = j.id AND classification <> 'SENT'
       ORDER BY id DESC LIMIT 1
    ) le ON true
    LEFT JOIN LATERAL (
      SELECT rejected_recipients
        FROM mail_attempts WHERE job_id = j.id AND classification = 'SENT'
       ORDER BY id DESC LIMIT 1
    ) sa ON true`;

function toView(row: JobRow): JobView {
  return {
    id: row.id,
    callerId: row.caller_id,
    accountId: row.account_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    priority: priorityFromRank(row.priority),
    attempts: row.attempts,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    finishedAt: row.finished_at,
    failureReason: row.failure_reason,
    lastError:
      row.le_classification !== null && row.le_finished_at !== null
        ? {
            category: row.le_classification,
            responseCode: row.le_response_code,
            enhancedCode: row.le_enhanced_code,
            occurredAt: row.le_finished_at,
          }
        : null,
    outcomeUncertain: row.outcome_uncertain,
    rejectedRecipients: row.sent_rejected_recipients,
  };
}

/** 작업 ID로 조회한다. `jobId`는 UUID 형식이어야 한다(호출자가 검증). 없거나 다른 호출처의 작업이면 null. */
export async function findJobById(
  db: Queryable,
  callerId: string,
  jobId: string,
): Promise<JobView | null> {
  const { rows } = await db.query<JobRow>(
    `${SELECT_JOB} WHERE j.caller_id = $1 AND j.id = $2`,
    [callerId, jobId],
  );
  const row = rows[0];
  return row ? toView(row) : null;
}

/**
 * 호출처 범위 없이 작업 ID로 조회한다. 운영자 읽기(`GET /ops/jobs/{jobId}`)만 쓴다(ADR-0011 결정 7).
 * 호출처 API 경로가 쓰지 않도록 `findJobById`와 이름을 나눴다. 없으면 null.
 */
export async function findJobByIdForOperator(
  db: Queryable,
  jobId: string,
): Promise<JobView | null> {
  const { rows } = await db.query<JobRow>(`${SELECT_JOB} WHERE j.id = $1`, [
    jobId,
  ]);
  const row = rows[0];
  return row ? toView(row) : null;
}

/** `Idempotency-Key`로 조회한다(ADR-0006 결정 1). 없거나 다른 호출처의 작업이면 null. */
export async function findJobByKey(
  db: Queryable,
  callerId: string,
  idempotencyKey: string,
): Promise<JobView | null> {
  const { rows } = await db.query<JobRow>(
    `${SELECT_JOB} WHERE j.caller_id = $1 AND j.idempotency_key = $2`,
    [callerId, idempotencyKey],
  );
  const row = rows[0];
  return row ? toView(row) : null;
}

/** 같은 호출처에서 Key로 등록된 작업 ID. 409 응답에 먼저 등록된 작업을 알릴 때 쓴다. */
export async function findJobIdByKey(
  db: Queryable,
  callerId: string,
  idempotencyKey: string,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM mail_jobs WHERE caller_id = $1 AND idempotency_key = $2",
    [callerId, idempotencyKey],
  );
  return rows[0]?.id ?? null;
}

/**
 * 작업 여러 건의 마지막 오류(SENT 아닌 마지막 시도)를 한 번에 읽는다. 이벤트 피드 응답의 `lastError`에 쓴다.
 * 호출자는 호출처 범위로 이미 걸러낸 작업 ID만 넘긴다. 오류가 없는 작업은 결과에 없다.
 */
export async function findLastErrors(
  db: Queryable,
  jobIds: readonly string[],
): Promise<Map<string, JobLastError>> {
  const result = new Map<string, JobLastError>();
  if (jobIds.length === 0) return result;
  const { rows } = await db.query<{
    job_id: string;
    classification: string;
    response_code: number | null;
    enhanced_code: string | null;
    finished_at: Date;
  }>(
    `SELECT DISTINCT ON (job_id) job_id, classification, response_code, enhanced_code, finished_at
       FROM mail_attempts
      WHERE job_id = ANY($1::uuid[]) AND classification <> 'SENT'
      ORDER BY job_id, id DESC`,
    [jobIds],
  );
  for (const row of rows) {
    result.set(row.job_id, {
      category: row.classification,
      responseCode: row.response_code,
      enhancedCode: row.enhanced_code,
      occurredAt: row.finished_at,
    });
  }
  return result;
}

/**
 * 작업 여러 건 중 결과를 알 수 없는 시도가 있는 작업의 ID 집합을 한 번에 읽는다(RQ-048).
 * 이벤트 피드의 `JOB_FAILED`·`JOB_EXPIRED` 응답에 쓴다. 판정은 `findJobById` 등의 `outcomeUncertain`과 같다.
 * 호출자는 호출처 범위로 이미 걸러낸 작업 ID만 넘긴다.
 */
export async function findOutcomeUncertain(
  db: Queryable,
  jobIds: readonly string[],
): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set();
  const { rows } = await db.query<{ job_id: string }>(
    `SELECT DISTINCT a.job_id
       FROM mail_attempts a
      WHERE a.job_id = ANY($1::uuid[]) AND ${UNCERTAIN_ATTEMPT_SQL}`,
    [jobIds],
  );
  return new Set(rows.map((row) => row.job_id));
}
