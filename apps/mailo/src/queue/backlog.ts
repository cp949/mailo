import type { Queryable } from "../db/index.js";

/** `dueCount`를 세는 상한. 이 수를 넘으면 정확한 수를 세지 않고 `truncated`로 알린다. */
export const BACKLOG_COUNT_LIMIT = 10_000;

export interface QueueBacklog {
  /** 점유 대상인 작업 수(`PENDING`·`RETRY_WAIT`이고 `next_attempt_at`이 지남). 최대 `BACKLOG_COUNT_LIMIT`. */
  dueCount: number;
  /** `dueCount`가 상한에 닿아 실제로는 더 많을 수 있다. */
  truncated: boolean;
  /** 가장 오래 기다린 작업이 점유 가능해진 뒤 지난 초. 대기 작업이 없으면 null. */
  oldestDueAgeSeconds: number | null;
}

/**
 * 점유 대상 작업의 적체를 한 쿼리로 본다. 헬스 응답이 쓴다(RQ-031).
 * `mail_jobs_claim_idx`를 `next_attempt_at` 순으로 읽다가 상한에서 멈추므로 적체가 커도 비용이 상한으로 막힌다.
 * 차단기가 open이거나 호출처 할당에 걸린 작업도 포함한다. 정지 판단에는 차단기 상태와 함께 본다.
 * 시각은 DB `now()`로 계산한다(ADR-0002 결정 10). 작업 ID·수신자·본문은 읽지 않는다.
 */
export async function getQueueBacklog(db: Queryable): Promise<QueueBacklog> {
  const { rows } = await db.query<{
    due_count: number;
    oldest_age: number | null;
  }>(
    `SELECT count(*)::int AS due_count,
            EXTRACT(EPOCH FROM (now() - min(next_attempt_at)))::float8 AS oldest_age
       FROM (SELECT next_attempt_at FROM mail_jobs
              WHERE status IN ('PENDING', 'RETRY_WAIT') AND next_attempt_at <= now()
              ORDER BY next_attempt_at
              LIMIT $1) due`,
    [BACKLOG_COUNT_LIMIT + 1],
  );
  const row = rows[0]!;
  const truncated = row.due_count > BACKLOG_COUNT_LIMIT;
  return {
    dueCount: Math.min(row.due_count, BACKLOG_COUNT_LIMIT),
    truncated,
    oldestDueAgeSeconds:
      row.oldest_age === null ? null : Math.max(0, Math.round(row.oldest_age)),
  };
}
