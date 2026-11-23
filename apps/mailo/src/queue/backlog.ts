import type { Queryable } from "../db/index.js";
import { PRIORITIES, PRIORITY_RANK, type Priority } from "./priority.js";

/**
 * `dueCount`를 세는 상한. 이 수를 넘으면 정확한 수를 세지 않고 `truncated`로 알린다.
 * 계정마다 이 상한으로 읽고 합친 뒤에도 같은 상한으로 자른다. 응답 계약(`openapi.yaml`의 `maximum: 10000`)을 지키려는 것이다.
 * 합이 상한을 넘으면 값은 상한이고 `truncated`는 true다("상한 이상"이라는 포화 의미가 그대로다, ADR-0013 구현 중 확정 6).
 */
export const BACKLOG_COUNT_LIMIT = 10_000;

export interface QueueBacklog {
  /**
   * 점유 대상인 작업 수(`PENDING`·`RETRY_WAIT`이고 `next_attempt_at`이 지남). 구성한 계정의 값을 합친 수이고 최대 `BACKLOG_COUNT_LIMIT`다.
   */
  dueCount: number;
  /** 어느 한 계정이라도 상한에 닿았거나 합이 상한을 넘어 실제로는 더 많을 수 있다. */
  truncated: boolean;
  /** 가장 오래 기다린 작업이 점유 가능해진 뒤 지난 초(계정 중 가장 큰 값). 대기 작업이 없으면 null. */
  oldestDueAgeSeconds: number | null;
  /**
   * 등급별 값(RQ-037). 네 등급이 모두 키로 있다. 계정마다 등급마다 `dueCount`와 같은 상한·후보 조건으로 따로 세고 합친 뒤 상한으로 자른다.
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

function maxAge(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * 점유 대상 작업의 적체를 읽는다. 헬스 응답이 쓴다(RQ-031·037).
 * 계정마다 상수 계정 쿼리 한 문장으로 읽고 합친다(ADR-0013 결정 3 아, 계정이 하나면 문장 하나다).
 * 계정을 합치지 않고 한 문장으로 읽으면 매개변수 계정에서 계획이 흔들린다(ADR-0013 측정 M7).
 * - 전체 값: 계정 부분 인덱스(`mail_jobs_account_claim_idx`)를 `next_attempt_at` 순으로 읽다가 상한에서 멈추므로 적체가 커도 비용이 상한으로 막힌다.
 * - 등급별 값: 등급마다 `LATERAL ... LIMIT 상한+1`로 `mail_jobs_account_priority_claim_idx`(account_id, priority, next_attempt_at)를 읽는다.
 *   등급 목록은 `PRIORITY_RANK`의 고정 숫자 배열을 매개변수로 넘긴다. 정의되지 않은 순위의 행은 세지 않는다.
 * - 한 계정의 두 값을 한 문장(`UNION ALL`)으로 읽는다. 헬스가 거는 문 시간제한(`statement_timeout`) 안에 끝나게 하기 위해서다.
 *   `rank`가 NULL인 행이 전체 값이다.
 * 구성에 없는 계정의 작업은 점유되지 않으므로 세지 않는다(`accountIds`에 넣지 않는다).
 * 차단기가 open이거나 호출처 할당에 걸린 작업도 포함한다. 정지 판단에는 차단기 상태와 함께 본다.
 * 시각은 DB `now()`로 계산한다(ADR-0002 결정 10). 작업 ID·수신자·본문은 읽지 않는다.
 */
export async function getQueueBacklog(
  db: Queryable,
  accountIds: readonly string[],
): Promise<QueueBacklog> {
  const ranks = PRIORITIES.map((p) => PRIORITY_RANK[p]);
  let dueCount = 0;
  let truncated = false;
  let oldest: number | null = null;
  const byPriority = {} as QueueBacklog["byPriority"];
  for (const priority of PRIORITIES)
    byPriority[priority] = {
      dueCount: 0,
      truncated: false,
      oldestDueAgeSeconds: null,
    };

  for (const accountId of new Set(accountIds)) {
    const { rows } = await db.query<{
      rank: number | null;
      due_count: number;
      oldest_age: number | null;
    }>(
      `SELECT NULL::smallint AS rank, count(*)::int AS due_count,
              EXTRACT(EPOCH FROM (now() - min(next_attempt_at)))::float8 AS oldest_age
         FROM (SELECT next_attempt_at FROM mail_jobs
                WHERE status IN ('PENDING', 'RETRY_WAIT') AND next_attempt_at <= now()
                  AND account_id = $3::text
                ORDER BY next_attempt_at
                LIMIT $1) due
       UNION ALL
       SELECT g.rank, count(due.next_attempt_at)::int,
              EXTRACT(EPOCH FROM (now() - min(due.next_attempt_at)))::float8
         FROM unnest($2::smallint[]) AS g(rank)
         LEFT JOIN LATERAL (
           SELECT next_attempt_at FROM mail_jobs
            WHERE status IN ('PENDING', 'RETRY_WAIT') AND next_attempt_at <= now()
              AND account_id = $3::text AND priority = g.rank
            ORDER BY next_attempt_at
            LIMIT $1) due ON true
        GROUP BY g.rank`,
      [BACKLOG_COUNT_LIMIT + 1, ranks, accountId],
    );
    const row = rows.find((r) => r.rank === null)!;
    dueCount += Math.min(row.due_count, BACKLOG_COUNT_LIMIT);
    truncated ||= row.due_count > BACKLOG_COUNT_LIMIT;
    oldest = maxAge(oldest, row.oldest_age);

    const byRank = new Map(
      rows.filter((r) => r.rank !== null).map((r) => [r.rank, r]),
    );
    for (const priority of PRIORITIES) {
      const r = byRank.get(PRIORITY_RANK[priority]);
      const count = r?.due_count ?? 0;
      const entry = byPriority[priority];
      entry.dueCount += Math.min(count, BACKLOG_COUNT_LIMIT);
      entry.truncated ||= count > BACKLOG_COUNT_LIMIT;
      entry.oldestDueAgeSeconds = maxAge(
        entry.oldestDueAgeSeconds,
        r?.oldest_age ?? null,
      );
    }
  }
  // 합친 값도 계약의 상한을 넘지 않게 자르고 잘렸으면 truncated로 알린다.
  for (const priority of PRIORITIES) {
    const entry = byPriority[priority];
    entry.truncated ||= entry.dueCount > BACKLOG_COUNT_LIMIT;
    entry.dueCount = Math.min(entry.dueCount, BACKLOG_COUNT_LIMIT);
    entry.oldestDueAgeSeconds = ageSeconds(entry.oldestDueAgeSeconds);
  }

  return {
    dueCount: Math.min(dueCount, BACKLOG_COUNT_LIMIT),
    truncated: truncated || dueCount > BACKLOG_COUNT_LIMIT,
    oldestDueAgeSeconds: ageSeconds(oldest),
    byPriority,
  };
}

/** 큐 깊이(ADR-0012 결정 4). `due`·`scheduled`는 계정별 값의 합이고 `BACKLOG_COUNT_LIMIT`로 자른다. */
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
 * 큐 깊이를 읽는다. `/metrics`의 `mailo_queue_jobs`가 쓴다(RQ-049, ADR-0012 결정 4·5, ADR-0013 결정 3 아).
 * - `due`는 `getQueueBacklog`에서 가져와 헬스 `queue.dueCount`와 같은 값이다.
 * - `scheduled`는 계정마다 `mail_jobs_account_claim_idx`를 `next_attempt_at > now()` 범위로 상한+1까지만 읽고 합친 뒤 상한으로 자른다.
 * - `sending`은 `mail_jobs_sending_caller_idx`(부분 인덱스) 전용 스캔이다. 계정으로 나누지 않고 첫 계정의 `scheduled` 문장에 함께 담는다.
 * 문장 수는 계정이 N개이면 `getQueueBacklog` N + `scheduled` N이다. N=1이면 2로 묶음 A 이전과 같다.
 * 읽기만 하고 잠그지 않는다. 시각은 DB `now()`다(ADR-0002 결정 10).
 * `PENDING`은 `next_attempt_at` 기본값이 `now()`라 항상 due이고, 미래로 바꾸는 쿼리는 `RETRY_WAIT` 전이뿐이다(`queue/complete.ts`).
 */
export async function getQueueDepth(
  db: Queryable,
  accountIds: readonly string[],
): Promise<QueueDepth> {
  const backlog = await getQueueBacklog(db, accountIds);
  let scheduled = 0;
  let scheduledTruncated = false;
  let sending = 0;
  const ids = [...new Set(accountIds)];
  for (const [index, accountId] of ids.entries()) {
    // `sending`은 계정과 무관한 전체 수라 첫 계정의 문장에서만 읽는다(CASE의 다른 가지는 실행하지 않는다).
    const { rows } = await db.query<{
      scheduled: number;
      sending: number | null;
    }>(
      `SELECT (SELECT count(*) FROM (
                 SELECT 1 FROM mail_jobs
                  WHERE status IN ('PENDING', 'RETRY_WAIT') AND next_attempt_at > now()
                    AND account_id = $2::text
                  ORDER BY next_attempt_at
                  LIMIT $1) s)::int AS scheduled,
              CASE WHEN $3::boolean
                   THEN (SELECT count(*) FROM mail_jobs WHERE status = 'SENDING')::int END AS sending`,
      [BACKLOG_COUNT_LIMIT + 1, accountId, index === 0],
    );
    const n = rows[0]?.scheduled ?? 0;
    scheduled += n;
    scheduledTruncated ||= n > BACKLOG_COUNT_LIMIT;
    if (index === 0) sending = rows[0]?.sending ?? 0;
  }
  if (ids.length === 0) {
    const r = await db.query<{ sending: number }>(
      `SELECT count(*)::int AS sending FROM mail_jobs WHERE status = 'SENDING'`,
    );
    sending = r.rows[0]?.sending ?? 0;
  }
  return {
    due: { count: backlog.dueCount, truncated: backlog.truncated },
    scheduled: {
      count: Math.min(scheduled, BACKLOG_COUNT_LIMIT),
      truncated: scheduledTruncated || scheduled > BACKLOG_COUNT_LIMIT,
    },
    sending,
    backlog,
  };
}

/**
 * 계정별 큐 깊이를 읽는다. `/metrics`의 `mailo_queue_jobs` 등이 계정 라벨로 쓴다(RQ-062, ADR-0013 결정 5).
 * 계정마다 `getQueueBacklog` 한 문장과 `scheduled`·`sending` 한 문장을 보낸다(계정당 2문장). `sending`은 그 계정의 점유 중 수다
 * (`SENDING` 부분 인덱스 `mail_jobs_lease_idx`를 쓰므로 점유 중 행만 읽는다).
 * 구성에 없는 계정은 읽지 않는다. 읽기만 하고 잠그지 않는다. 시각은 DB `now()`다.
 */
export async function getAccountQueueDepths(
  db: Queryable,
  accountIds: readonly string[],
): Promise<Map<string, QueueDepth>> {
  const result = new Map<string, QueueDepth>();
  for (const accountId of new Set(accountIds)) {
    const backlog = await getQueueBacklog(db, [accountId]);
    const { rows } = await db.query<{ scheduled: number; sending: number }>(
      `SELECT (SELECT count(*) FROM (
                 SELECT 1 FROM mail_jobs
                  WHERE status IN ('PENDING', 'RETRY_WAIT') AND next_attempt_at > now()
                    AND account_id = $2::text
                  ORDER BY next_attempt_at
                  LIMIT $1) s)::int AS scheduled,
              (SELECT count(*) FROM mail_jobs
                WHERE status = 'SENDING' AND account_id = $2::text)::int AS sending`,
      [BACKLOG_COUNT_LIMIT + 1, accountId],
    );
    const scheduled = rows[0]?.scheduled ?? 0;
    result.set(accountId, {
      due: { count: backlog.dueCount, truncated: backlog.truncated },
      scheduled: {
        count: Math.min(scheduled, BACKLOG_COUNT_LIMIT),
        truncated: scheduled > BACKLOG_COUNT_LIMIT,
      },
      sending: rows[0]?.sending ?? 0,
      backlog,
    });
  }
  return result;
}

/**
 * 구성한 계정에 없는 계정의 비종결 작업(`PENDING`·`RETRY_WAIT`·`SENDING`) 수를 계정별로 센다(ADR-0013 결정 2).
 * 기동 때 한 번 부르는 점검용이다. 이 작업은 점유되지 않고 만료 sweep이 `EXPIRED`로 만든다.
 * 계정 ID와 건수만 읽는다.
 *
 * 계정 부분 인덱스(`mail_jobs_account_claim_idx`, 0013)의 앞 열 `account_id`를 재귀 CTE로 건너뛰며 대기 중인 계정 ID를 모은다
 * (loose index scan, 계정 수만큼 인덱스를 한 번씩 찾는다). 그다음 구성 밖 계정만 센다. 비용은 테이블 크기가 아니라
 * 구성 밖 계정의 대기 건수에 비례한다. 단순한 `account_id <> ALL(...)` 조건은 인덱스를 못 써서 테이블 전체를 읽는다
 * (2026-11-24 로컬 단일 측정, 작업 74.5만 행: 이전 쿼리는 약 35ms에 16300 buffers, 새 쿼리는 69 buffers이고 `jit = off`에서 0.6ms다.
 기본 설정에서는 비용 추정이 `jit_above_cost`를 넘어 JIT 컴파일이 더해져 약 21ms였다. 기동 때 한 번이라 그대로 둔다).
 * `SENDING`은 부분 인덱스에 없으므로 `mail_jobs_lease_idx`로 따로 읽는다(점유 중인 행은 동시성으로 막힌다).
 */
export async function countOrphanAccountJobs(
  db: Queryable,
  configuredAccountIds: readonly string[],
): Promise<Array<{ accountId: string; count: number }>> {
  const { rows } = await db.query<{ account_id: string; n: number }>(
    `WITH RECURSIVE waiting(account_id) AS (
       (SELECT account_id FROM mail_jobs
         WHERE status IN ('PENDING', 'RETRY_WAIT') ORDER BY account_id LIMIT 1)
       UNION ALL
       SELECT (SELECT j.account_id FROM mail_jobs j
                WHERE j.status IN ('PENDING', 'RETRY_WAIT') AND j.account_id > w.account_id
                ORDER BY j.account_id LIMIT 1)
         FROM waiting w WHERE w.account_id IS NOT NULL
     ), orphans AS (
       SELECT account_id FROM waiting
        WHERE account_id IS NOT NULL AND account_id <> ALL($1::text[])
       UNION
       SELECT account_id FROM mail_jobs
        WHERE status = 'SENDING' AND account_id <> ALL($1::text[])
     )
     SELECT o.account_id,
            ((SELECT count(*) FROM mail_jobs j
               WHERE j.account_id = o.account_id AND j.status IN ('PENDING', 'RETRY_WAIT'))
           + (SELECT count(*) FROM mail_jobs j
               WHERE j.account_id = o.account_id AND j.status = 'SENDING'))::int AS n
       FROM orphans o
      ORDER BY o.account_id`,
    [[...configuredAccountIds]],
  );
  return rows
    .filter((r) => r.n > 0)
    .map((r) => ({ accountId: r.account_id, count: r.n }));
}
