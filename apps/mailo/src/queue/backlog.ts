import type { Queryable } from "../db/index.js";
import { PRIORITIES, PRIORITY_RANK, type Priority } from "./priority.js";

/** `dueCount`를 세는 상한. 이 수를 넘으면 정확한 수를 세지 않고 `truncated`로 알린다. */
export const BACKLOG_COUNT_LIMIT = 10_000;

export interface QueueBacklog {
  /** 점유 대상인 작업 수(`PENDING`·`RETRY_WAIT`이고 `next_attempt_at`이 지남). 최대 `BACKLOG_COUNT_LIMIT`. */
  dueCount: number;
  /** `dueCount`가 상한에 닿아 실제로는 더 많을 수 있다. */
  truncated: boolean;
  /** 가장 오래 기다린 작업이 점유 가능해진 뒤 지난 초. 대기 작업이 없으면 null. */
  oldestDueAgeSeconds: number | null;
  /**
   * 등급별 값(RQ-037). 네 등급이 모두 키로 있다. 등급마다 `dueCount`와 같은 상한·후보 조건으로 따로 센다.
   * 등급별 합은 `dueCount`와 다를 수 있다(상한이 등급마다 걸린다).
   */
  byPriority: Record<
    Priority,
    { dueCount: number; truncated: boolean; oldestDueAgeSeconds: number | null }
  >;
}

function ageSeconds(age: number | null): number | null {
  return age === null ? null : Math.max(0, Math.round(age));
}

/**
 * 점유 대상 작업의 적체를 한 문장으로 본다. 헬스 응답이 쓴다(RQ-031·037).
 * - 전체 값: `mail_jobs_claim_idx`를 `next_attempt_at` 순으로 읽다가 상한에서 멈추므로 적체가 커도 비용이 상한으로 막힌다.
 * - 등급별 값: 등급마다 `LATERAL ... LIMIT 상한+1`로 `mail_jobs_priority_claim_idx`(priority, next_attempt_at)를 읽는다.
 *   등급 목록은 `PRIORITY_RANK`의 고정 숫자 배열을 매개변수로 넘긴다. 정의되지 않은 순위의 행은 세지 않는다.
 * - 두 값을 한 문장(`UNION ALL`)으로 읽는다. 헬스가 거는 문 시간제한(`statement_timeout`) 하나 안에 끝나게 하기 위해서다.
 *   `rank`가 NULL인 행이 전체 값이다.
 * 차단기가 open이거나 호출처 할당에 걸린 작업도 포함한다. 정지 판단에는 차단기 상태와 함께 본다.
 * 시각은 DB `now()`로 계산한다(ADR-0002 결정 10). 작업 ID·수신자·본문은 읽지 않는다.
 */
export async function getQueueBacklog(db: Queryable): Promise<QueueBacklog> {
  const ranks = PRIORITIES.map((p) => PRIORITY_RANK[p]);
  const { rows } = await db.query<{
    rank: number | null;
    due_count: number;
    oldest_age: number | null;
  }>(
    `SELECT NULL::smallint AS rank, count(*)::int AS due_count,
            EXTRACT(EPOCH FROM (now() - min(next_attempt_at)))::float8 AS oldest_age
       FROM (SELECT next_attempt_at FROM mail_jobs
              WHERE status IN ('PENDING', 'RETRY_WAIT') AND next_attempt_at <= now()
              ORDER BY next_attempt_at
              LIMIT $1) due
     UNION ALL
     SELECT g.rank, count(due.next_attempt_at)::int,
            EXTRACT(EPOCH FROM (now() - min(due.next_attempt_at)))::float8
       FROM unnest($2::smallint[]) AS g(rank)
       LEFT JOIN LATERAL (
         SELECT next_attempt_at FROM mail_jobs
          WHERE status IN ('PENDING', 'RETRY_WAIT') AND next_attempt_at <= now()
            AND priority = g.rank
          ORDER BY next_attempt_at
          LIMIT $1) due ON true
      GROUP BY g.rank`,
    [BACKLOG_COUNT_LIMIT + 1, ranks],
  );
  const row = rows.find((r) => r.rank === null)!;
  const truncated = row.due_count > BACKLOG_COUNT_LIMIT;
  const graded = rows.filter((r) => r.rank !== null);

  const byRank = new Map(graded.map((r) => [r.rank, r]));
  const byPriority = {} as QueueBacklog["byPriority"];
  for (const priority of PRIORITIES) {
    const r = byRank.get(PRIORITY_RANK[priority]);
    const count = r?.due_count ?? 0;
    byPriority[priority] = {
      dueCount: Math.min(count, BACKLOG_COUNT_LIMIT),
      truncated: count > BACKLOG_COUNT_LIMIT,
      oldestDueAgeSeconds: ageSeconds(r?.oldest_age ?? null),
    };
  }

  return {
    dueCount: Math.min(row.due_count, BACKLOG_COUNT_LIMIT),
    truncated,
    oldestDueAgeSeconds: ageSeconds(row.oldest_age),
    byPriority,
  };
}

/** 큐 깊이(ADR-0012 결정 4). `due`·`scheduled`는 `BACKLOG_COUNT_LIMIT`에서 멈춘다. */
export interface QueueDepth {
  /** 점유 가능(`getQueueBacklog`의 전체 값과 같다). */
  due: { count: number; truncated: boolean };
  /** 재시도·예약 대기(`PENDING`·`RETRY_WAIT`이고 `next_attempt_at`이 미래). */
  scheduled: { count: number; truncated: boolean };
  /** 점유 중(`SENDING`). 상한이 없다. 동시에 점유할 수 있는 수가 Worker 동시 처리 수로 막혀 있다. */
  sending: number;
  /** 등급별 값을 포함한 `getQueueBacklog` 결과. 헬스의 `queue`와 같은 데이터다. */
  backlog: QueueBacklog;
}

/**
 * 큐 깊이를 읽는다. `/metrics`의 `mailo_queue_jobs`가 쓴다(RQ-049, ADR-0012 결정 4·5).
 * - `due`는 `getQueueBacklog`에서 가져와 헬스 `queue.dueCount`와 같은 값이다.
 * - `scheduled`는 `mail_jobs_claim_idx`를 `next_attempt_at > now()` 범위로 상한+1까지만 읽는다.
 * - `sending`은 `mail_jobs_sending_caller_idx`(부분 인덱스) 전용 스캔이다.
 * 읽기만 하고 잠그지 않는다. 시각은 DB `now()`다(ADR-0002 결정 10).
 * `PENDING`은 `next_attempt_at` 기본값이 `now()`라 항상 due이고, 미래로 바꾸는 쿼리는 `RETRY_WAIT` 전이뿐이다(`queue/complete.ts`).
 */
export async function getQueueDepth(db: Queryable): Promise<QueueDepth> {
  const backlog = await getQueueBacklog(db);
  const { rows } = await db.query<{ scheduled: number; sending: number }>(
    `SELECT (SELECT count(*)::int FROM (
               SELECT 1 FROM mail_jobs
                WHERE status IN ('PENDING', 'RETRY_WAIT') AND next_attempt_at > now()
                ORDER BY next_attempt_at
                LIMIT $1) s) AS scheduled,
            (SELECT count(*)::int FROM mail_jobs WHERE status = 'SENDING') AS sending`,
    [BACKLOG_COUNT_LIMIT + 1],
  );
  const scheduled = rows[0]?.scheduled ?? 0;
  return {
    due: { count: backlog.dueCount, truncated: backlog.truncated },
    scheduled: {
      count: Math.min(scheduled, BACKLOG_COUNT_LIMIT),
      truncated: scheduled > BACKLOG_COUNT_LIMIT,
    },
    sending: rows[0]?.sending ?? 0,
    backlog,
  };
}
