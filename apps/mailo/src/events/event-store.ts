import type { Queryable } from "../db/index.js";
import { decodeCursor, encodeCursor, type EventCursor } from "./cursor.js";
import type {
  EventType,
  FeedEvent,
  FeedPage,
  IntakeRejectionInput,
  JobEventInput,
  JsonValue,
  ListEventsOptions,
  RejectionView,
} from "./types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function toJson(value: JsonValue | null | undefined): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * 작업 종결 이벤트를 쓴다. 호출자가 연 트랜잭션의 client를 넘겨야 한다.
 * 종결 전이와 같은 트랜잭션이어야 at-least-once 피드가 성립한다(ADR-0006 결정 2).
 * `txid`는 컬럼 기본값 `pg_current_xact_id()`가 채운다.
 */
export async function recordJobEvent(
  db: Queryable,
  event: JobEventInput,
): Promise<void> {
  await db.query(
    `INSERT INTO mail_events
       (caller_id, type, job_id, idempotency_key, failure_reason, failure_detail,
        attempt_count, recipients, rejected_recipients)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
    [
      event.callerId,
      event.type,
      event.jobId,
      event.idempotencyKey,
      event.failureReason ?? null,
      event.failureDetail ?? null,
      event.attemptCount,
      toJson(event.recipients),
      toJson(event.rejectedRecipients),
    ],
  );
}

/**
 * 수집 거부를 기록하고 `INTAKE_REJECTED` 이벤트를 같은 트랜잭션에서 쓴다.
 * `(caller_id, 파일 이름, sha256)`으로 멱등하다. 기록 커밋 뒤 원본 삭제 전에 종료돼 다시 들어와도 중복 기록이 없다(ADR-0006 결정 3).
 * 호출자가 연 트랜잭션의 client를 넘겨야 한다.
 * @returns 새로 기록했으면 거부 기록 ID, 이미 있으면 null
 */
export async function recordIntakeRejection(
  db: Queryable,
  input: IntakeRejectionInput,
): Promise<string | null> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO mail_intake_rejections
       (caller_id, file_name, size_bytes, sha256, idempotency_key, reason_code)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (caller_id, file_name, sha256) DO NOTHING
     RETURNING id::text AS id`,
    [
      input.callerId,
      input.fileName,
      input.sizeBytes,
      input.sha256,
      input.idempotencyKey ?? null,
      input.reasonCode,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) return null;
  await db.query(
    `INSERT INTO mail_events
       (caller_id, type, rejection_id, idempotency_key, failure_reason)
     VALUES ($1, 'INTAKE_REJECTED', $2, $3, $4)`,
    [input.callerId, id, input.idempotencyKey ?? null, input.reasonCode],
  );
  return id;
}

interface FeedRow {
  id: string;
  txid: string;
  type: EventType;
  job_id: string | null;
  rejection_id: string | null;
  idempotency_key: string | null;
  failure_reason: string | null;
  failure_detail: string | null;
  attempt_count: number | null;
  recipients: JsonValue | null;
  rejected_recipients: JsonValue | null;
  recipients_redacted: boolean;
  created_at: Date;
}

/**
 * 호출처의 종결 이벤트를 cursor 이후부터 반환한다(ADR-0006 결정 2·7).
 * `txid`가 `pg_snapshot_xmin(pg_current_snapshot())`보다 작은 행만 반환한다.
 * xmin보다 작은 xid의 트랜잭션은 모두 끝났으므로, 나중에 커밋된 행이 cursor 앞에 끼어들 수 없다.
 * DB 어디서든 긴 트랜잭션이 있으면 그동안 새 이벤트가 보이지 않는다. 유실은 없다.
 * 수신자를 비운 이벤트(RQ-072)도 같은 `(txid, id)` 위치에서 같은 순서로 나온다. 비움은 두 열의 값만 바꾼다.
 * @throws InvalidCursorError `after`가 이 모듈이 만든 cursor가 아닐 때
 */
export async function listEvents(
  db: Queryable,
  options: ListEventsOptions,
): Promise<FeedPage> {
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1),
    MAX_LIMIT,
  );
  // `types`가 우선한다. 빈 배열은 필터 없음이다.
  const requested = options.types ?? (options.type ? [options.type] : []);
  const typeFilter = requested.length > 0 ? [...requested] : null;
  const start: EventCursor = options.after
    ? decodeCursor(options.after)
    : { txid: "0", id: "0" };

  const { rows } = await db.query<FeedRow>(
    `SELECT id::text AS id, txid::text AS txid, type, job_id, rejection_id::text AS rejection_id,
            idempotency_key, failure_reason, failure_detail, attempt_count,
            recipients, rejected_recipients, recipients_redacted_at IS NOT NULL AS recipients_redacted,
            created_at
       FROM mail_events
      WHERE caller_id = $1
        AND (txid, id) > ($2::xid8, $3::bigint)
        AND txid < pg_snapshot_xmin(pg_current_snapshot())
        AND ($4::text[] IS NULL OR type = ANY($4::text[]))
      -- 별칭 txid·id는 text라 그대로 쓰면 문자열 순이 된다. 원본 컬럼으로 숫자 순을 고정한다.
      ORDER BY mail_events.txid, mail_events.id
      LIMIT $5`,
    [options.callerId, start.txid, start.id, typeFilter, limit],
  );

  const events: FeedEvent[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    jobId: r.job_id,
    rejectionId: r.rejection_id,
    idempotencyKey: r.idempotency_key,
    failureReason: r.failure_reason,
    failureDetail: r.failure_detail,
    attemptCount: r.attempt_count,
    recipients: r.recipients,
    rejectedRecipients: r.rejected_recipients,
    recipientsRedacted: r.recipients_redacted,
    createdAt: r.created_at,
  }));
  const last = rows.at(-1);
  return {
    events,
    nextCursor: last
      ? encodeCursor({ txid: last.txid, id: last.id })
      : (options.after ?? null),
  };
}

/**
 * 거부 기록 ID로 파일 이름·크기·sha256·사유를 읽는다. 호출처 범위로 제한한다.
 * 피드 응답의 `INTAKE_REJECTED` 이벤트를 만들 때 쓴다. 본문은 저장돼 있지 않다(ADR-0006 결정 3).
 */
export async function findRejections(
  db: Queryable,
  callerId: string,
  rejectionIds: readonly string[],
): Promise<Map<string, RejectionView>> {
  const result = new Map<string, RejectionView>();
  if (rejectionIds.length === 0) return result;
  const { rows } = await db.query<{
    id: string;
    file_name: string;
    size_bytes: string;
    sha256: string;
    reason_code: string;
  }>(
    `SELECT id::text AS id, file_name, size_bytes::text AS size_bytes, sha256, reason_code
       FROM mail_intake_rejections
      WHERE caller_id = $1 AND id = ANY($2::bigint[])`,
    [callerId, rejectionIds],
  );
  for (const row of rows) {
    result.set(row.id, {
      id: row.id,
      fileName: row.file_name,
      sizeBytes: Number(row.size_bytes),
      sha256: row.sha256,
      reasonCode: row.reason_code,
    });
  }
  return result;
}

/** 피드 지연 측정값(RQ-017). */
export interface FeedLag {
  /** 피드가 반환할 수 있는 최신 이벤트의 시각. 이벤트가 없으면 null. */
  latestEventAt: Date | null;
  /** DB `now()` − `latestEventAt`(초). 이벤트가 없으면 null. */
  lagSeconds: number | null;
}

/**
 * 호출처 피드 지연 = 현재 시각 − 최신 반환 이벤트 시각(RQ-017).
 * `listEvents`와 같은 가시성 조건(`txid < xmin`)과 정렬(`txid, id`)을 쓴다. 그래야 "반환한 이벤트"와 같은 행을 가리킨다.
 * 긴 트랜잭션으로 피드가 멈추면 이 값이 커진다. 새 이벤트가 없는 때도 커지므로 단독 장애 신호로 쓰지 않는다.
 * 시각은 DB `now()`로 계산한다(ADR-0002 결정 10).
 */
export async function getFeedLag(
  db: Queryable,
  callerId: string,
): Promise<FeedLag> {
  const { rows } = await db.query<{
    created_at: Date;
    lag_seconds: number;
  }>(
    `SELECT created_at, EXTRACT(EPOCH FROM (now() - created_at))::float8 AS lag_seconds
       FROM mail_events
      WHERE caller_id = $1
        AND txid < pg_snapshot_xmin(pg_current_snapshot())
      ORDER BY txid DESC, id DESC
      LIMIT 1`,
    [callerId],
  );
  const row = rows[0];
  if (!row) return { latestEventAt: null, lagSeconds: null };
  return {
    latestEventAt: row.created_at,
    lagSeconds: Math.max(0, Math.round(row.lag_seconds)),
  };
}

/**
 * 호출처마다 피드가 보여 줄 수 있는 최신 이벤트의 경과 초를 한 쿼리로 읽는다(ADR-0012 결정 4).
 * `getFeedLag`와 같은 가시성 조건(`txid < xmin`)·정렬을 `LATERAL`로 호출처마다 한 행만 읽는다(`mail_events_feed_idx` 역방향 스캔).
 * 이벤트가 없는 호출처는 결과에서 뺀다. 호출처 목록이 비면 쿼리하지 않는다. 시각은 DB `now()`다(ADR-0002 결정 10).
 */
export async function getFeedLagsForCallers(
  db: Queryable,
  callerIds: readonly string[],
): Promise<Map<string, number>> {
  if (callerIds.length === 0) return new Map();
  const { rows } = await db.query<{ caller_id: string; lag_seconds: number }>(
    `SELECT c.caller_id,
            EXTRACT(EPOCH FROM (now() - e.created_at))::float8 AS lag_seconds
       FROM unnest($1::text[]) AS c(caller_id)
       CROSS JOIN LATERAL (
         SELECT created_at FROM mail_events
          WHERE caller_id = c.caller_id
            AND txid < pg_snapshot_xmin(pg_current_snapshot())
          ORDER BY txid DESC, id DESC
          LIMIT 1) e`,
    [callerIds],
  );
  return new Map(
    rows.map((r) => [r.caller_id, Math.max(0, Math.round(r.lag_seconds))]),
  );
}
