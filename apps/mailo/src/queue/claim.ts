import type pg from "pg";
import { withTransaction } from "../db/index.js";
import type { JsonValue } from "../events/index.js";
import { recoverExpiredLeases, type CompleteDeps } from "./complete.js";
import type { ClaimedJob, EncryptedBody } from "./types.js";

/**
 * 점유 경로(RQ-035, ADR-0009). claim 호출마다 하나를 쓴다.
 * - `priority`: `priority DESC, next_attempt_at, id`. 기본 경로다.
 * - `fifo`: 우선순위를 무시한 `next_attempt_at, id`(가장 오래 기다린 순서). 낮은 등급이 완전히 굶지 않게 한다.
 */
export type ClaimOrder = "priority" | "fifo";

/**
 * 경로별 ORDER BY 조각. SQL에 넣는 정렬은 이 표의 고정 문자열뿐이다(외부 값을 이어 붙이지 않는다).
 * 정렬식에 `now()`를 쓰지 않는다. 대기 시간에 따른 승격은 하지 않는다(RQ-035).
 * - `bare`: `mail_jobs`를 별칭 없이 읽는 normal 모드와 `ranked` 순번용.
 * - `job`: 별칭 `j`를 쓰는 half_open 대표 선택용. 첫 정렬 키(직전 차단 작업 후순위) 뒤에 붙인다.
 */
const ORDER_BY: Readonly<Record<ClaimOrder, { bare: string; job: string }>> = {
  priority: {
    bare: "priority DESC, next_attempt_at, id",
    job: "j.priority DESC, j.next_attempt_at, j.id",
  },
  fifo: {
    bare: "next_attempt_at, id",
    job: "j.next_attempt_at, j.id",
  },
};

function orderOf(order: ClaimOrder): { bare: string; job: string } {
  // 타입 밖의 값(JS 호출자)이 SQL에 들어가지 않게 표에 있는 키만 받는다.
  if (!Object.hasOwn(ORDER_BY, order))
    throw new Error("알 수 없는 점유 경로다");
  return ORDER_BY[order];
}

export interface ClaimOptions {
  /** 점유 lease 초(MAILO_LEASE_SECONDS). 연결·greeting·소켓 타임아웃 합보다 길어야 한다(ADR-0002 결정 11). */
  leaseSeconds: number;
  /** 한 번에 점유하는 작업 수. 차단기가 half_open이면 무시하고 1건만 점유한다. */
  limit: number;
  deps: CompleteDeps;
  /**
   * 이번 호출의 점유 경로(RQ-035). 생략하면 `priority`다. 경로 선택(난수)은 호출자(Worker)가 한다.
   * normal 모드의 후보 선택·할당 순번과 half_open 대표 선택의 두 번째 이후 정렬 키가 모두 이 경로를 따른다.
   */
  order?: ClaimOrder;
  /**
   * 호출처별 24시간 rolling 발송 할당(RQ-032, ADR-0007 결정 10). 키는 호출처 ID, 값은 양의 정수다.
   * 여기 없는 호출처는 무제한이다. 비어 있거나 생략하면 할당을 확인하지 않는다.
   */
  callerQuotas?: ReadonlyMap<string, number>;
  /**
   * 점유할 때마다 할당을 넘긴 호출처를 알린다(없으면 빈 배열). 호출처 ID와 한도만 담는다.
   * 로그용이며 Worker가 상태가 바뀔 때만 기록한다. 다른 인스턴스가 점유 중이라 이번에 건너뛴 호출처는 넣지 않는다.
   */
  onQuotaBlocked?: (blocked: ReadonlyArray<QuotaBlock>) => void;
}

export interface QuotaBlock {
  callerId: string;
  /** 설정한 24시간 할당 */
  limit: number;
}

interface JobRow {
  id: string;
  caller_id: string;
  idempotency_key: string;
  lease_token: string;
  lease_until: Date;
  attempts: number;
  account_trips: number;
  expires_at: Date;
  recipients: JsonValue;
  envelope: JsonValue;
  body_ciphertext: Buffer | null;
  body_nonce: Buffer | null;
  body_key_version: number | null;
}

const RETURNING = `mail_jobs.id, mail_jobs.caller_id, idempotency_key, lease_token, lease_until, attempts,
  account_trips, expires_at, recipients, envelope, body_ciphertext, body_nonce, body_key_version`;

function toClaimed(row: JobRow, isProbe: boolean): ClaimedJob {
  const body: EncryptedBody | null =
    row.body_ciphertext && row.body_nonce && row.body_key_version !== null
      ? {
          ciphertext: row.body_ciphertext,
          nonce: row.body_nonce,
          keyVersion: row.body_key_version,
        }
      : null;
  return {
    id: row.id,
    callerId: row.caller_id,
    idempotencyKey: row.idempotency_key,
    leaseToken: row.lease_token,
    leaseUntil: row.lease_until,
    attempts: row.attempts,
    accountTrips: row.account_trips,
    expiresAt: row.expires_at,
    recipients: row.recipients,
    envelope: row.envelope,
    body,
    isProbe,
  };
}

/** half_open 조건부 UPDATE에서 졌을 때 트랜잭션을 롤백시키기 위한 내부 신호 */
class LostProbeRace extends Error {}

type Mode = "none" | "normal" | "probe";

/**
 * 호출처별 점유 전 할당 판정 결과. `blocked`는 이번 점유에서 뺄 호출처,
 * `remaining`은 할당이 남은 호출처의 점유 가능 건수다(할당이 없는 호출처는 없다).
 */
interface QuotaPlan {
  blocked: string[];
  remainingIds: string[];
  remainingCounts: number[];
}

const NO_QUOTA: QuotaPlan = {
  blocked: [],
  remainingIds: [],
  remainingCounts: [],
};

// advisory lock의 앞 정수(키 공간 구분). 마이그레이터는 1-인자 bigint 형식이라 겹치지 않는다.
const QUOTA_LOCK_CLASS = 7_364_222;

/**
 * 할당이 있는 호출처의 남은 점유 가능 건수를 정한다(RQ-032).
 *
 * 1. 호출처마다 `pg_try_advisory_xact_lock`을 잡는다. 못 잡으면 다른 인스턴스가 같은 호출처를 점유하는 중이므로
 *    이번 점유에서만 뺀다(기다리지 않는다). 잡은 동안 사용량 읽기부터 점유 커밋까지 호출처별로 한 인스턴스만 들어와서
 *    동시 점유로 인한 할당 초과가 없다. 락은 커밋 때 풀린다.
 * 2. 사용량 = 최근 24시간의 할당에 드는 시도 수 + 현재 SENDING 작업 수를 한 문장(한 스냅샷)에서 센다.
 *    두 값을 따로 세면 그 사이에 완료 트랜잭션이 커밋돼 작업 한 건을 놓칠 수 있다.
 *    시도 수는 `mail_attempts_quota_idx`, 점유 수는 `mail_jobs_sending_caller_idx`로 센다.
 *
 * 이 함수(사용량 쿼리)의 비용은 할당을 설정한 호출처 수와 그 호출처의 최근 시도 수에만 비례한다(시도 수는 `LIMIT 할당`으로 자른다).
 * 큐 길이에는 영향받지 않는다. 점유 쿼리는 다르다. 할당 초과 호출처의 대기 작업은 `claim`에서
 * 매 poll 필터로 읽고 버리므로 그 비용은 초과 호출처의 대기 건수에 선형이다(ADR-0007 구현 중 확정 10).
 */
async function planQuotas(
  client: pg.PoolClient,
  quotas: ReadonlyMap<string, number> | undefined,
  onQuotaBlocked: ClaimOptions["onQuotaBlocked"],
): Promise<QuotaPlan> {
  if (!quotas || quotas.size === 0) {
    onQuotaBlocked?.([]);
    return NO_QUOTA;
  }
  const ids = [...quotas.keys()];
  const limits = ids.map((id) => quotas.get(id)!);

  const locked = await client.query<{ caller_id: string }>(
    `SELECT t.caller_id FROM unnest($1::text[]) AS t(caller_id)
      WHERE pg_try_advisory_xact_lock($2::int, hashtext(t.caller_id))`,
    [ids, QUOTA_LOCK_CLASS],
  );
  const lockedIds = new Set(locked.rows.map((r) => r.caller_id));

  const usage = await client.query<{ caller_id: string; used: number }>(
    `SELECT q.caller_id,
            ( (SELECT count(*) FROM (
                 SELECT 1 FROM mail_attempts a
                  WHERE a.caller_id = q.caller_id
                    AND a.counted AND a.stage IS DISTINCT FROM 'WORKER'
                    AND a.finished_at > now() - interval '24 hours'
                  LIMIT q.quota) recent)
              + (SELECT count(*) FROM mail_jobs j
                  WHERE j.caller_id = q.caller_id AND j.status = 'SENDING')
            )::int AS used
       FROM unnest($1::text[], $2::int[]) AS q(caller_id, quota)
      WHERE q.caller_id = ANY($3::text[])`,
    [ids, limits, [...lockedIds]],
  );
  const used = new Map(usage.rows.map((r) => [r.caller_id, r.used]));

  const plan: QuotaPlan = {
    blocked: [],
    remainingIds: [],
    remainingCounts: [],
  };
  const over: QuotaBlock[] = [];
  for (const id of ids) {
    const limit = quotas.get(id)!;
    if (!lockedIds.has(id)) {
      plan.blocked.push(id);
      continue;
    }
    const remaining = limit - (used.get(id) ?? 0);
    if (remaining <= 0) {
      plan.blocked.push(id);
      over.push({ callerId: id, limit });
    } else {
      plan.remainingIds.push(id);
      plan.remainingCounts.push(remaining);
    }
  }
  onQuotaBlocked?.(over);
  return plan;
}

/**
 * 발송할 작업을 점유한다(ADR-0002 결정 4·5, ADR-0007 결정 5).
 * 점유 트랜잭션은 SMTP 전송 전에 커밋한다. 전송과 결과 기록은 호출자가 따로 한다(ADR-0002 결정 9).
 *
 * 순서:
 * 1. lease가 지난 SENDING 작업을 복구한다(별도 트랜잭션).
 * 2. 차단기를 읽어 모드를 정한다.
 *    - closed: 점유 대상 중 `limit`건을 `FOR UPDATE SKIP LOCKED`로 잡는다.
 *    - open이고 `open_until` 전: 점유하지 않는다.
 *    - open이고 `open_until` 이후, 또는 half_open이고 `probe_until` 이후: 대표 작업 1건을 점유한다.
 *      조건부 UPDATE에서 이긴 인스턴스만 half_open을 가져가며, 졌거나 후보가 없으면 롤백한다.
 *
 * 호출처별 24시간 rolling 할당(RQ-032): 할당을 넘긴 호출처의 작업은 어느 모드에서도 점유하지 않는다.
 * 제외된 작업은 상태·시도 횟수·`next_attempt_at`을 바꾸지 않고, 할당이 풀리거나 만료 sweep이 처리할 때까지 그대로 둔다.
 * 한 호출처의 초과는 다른 호출처 점유에 영향이 없다. 점유한 작업이 곧 사용량에 들어가고(SENDING 수),
 * 호출처별 advisory lock으로 인스턴스 사이 동시 점유에서도 할당을 넘기지 않는다(`planQuotas`).
 *
 * 점유 순서는 `options.order` 경로를 따른다(RQ-035, ADR-0009). 후보 조건은 두 경로가 같다.
 *
 * 만료된 행(`expires_at <= now()`)은 점유하지 않는다. 상태 전이는 sweep이 맡는다.
 * 대표 작업은 직전에 차단기를 연 작업을 뒤로 미룬다. 그다음 정렬은 선택한 경로를 따른다. 다른 후보가 없으면 그 작업을 쓴다.
 * 제외로 두면 작업이 하나뿐인 큐가 멈추고, `account_trips` 예외가 작동하지 않기 때문이다.
 */
export async function claim(
  pool: pg.Pool,
  options: ClaimOptions,
): Promise<ClaimedJob[]> {
  const order = orderOf(options.order ?? "priority");
  await recoverExpiredLeases(pool, options.deps);

  return withTransaction(pool, async (client) => {
    const breakerKey = options.deps.breaker.breakerKey;
    const state = await client.query<{
      state: string;
      open_due: boolean;
      probe_due: boolean;
    }>(
      `SELECT state, COALESCE(open_until <= now(), false) AS open_due,
              COALESCE(probe_until <= now(), false) AS probe_due
         FROM mail_circuit_breaker WHERE breaker_key = $1`,
      [breakerKey],
    );
    const b = state.rows[0];
    if (!b) throw new Error("차단기 행이 없다. 마이그레이션을 확인한다");

    let mode: Mode;
    if (b.state === "closed") mode = "normal";
    else if (b.state === "open") mode = b.open_due ? "probe" : "none";
    else mode = b.probe_due ? "probe" : "none";

    if (mode === "none") return [];
    // 할당 판정은 작업 행을 잠그기 전에 한다. advisory lock은 기다리지 않으므로 잠금 순서에 영향이 없다.
    const quota = await planQuotas(
      client,
      options.callerQuotas,
      options.onQuotaBlocked,
    );
    if (mode === "normal") {
      // 할당 초과 호출처는 `caller_id <> ALL`로 뺀다. 할당이 남은 호출처는 이번 배치에서 남은 건수까지만 점유한다.
      // 순위(rn)는 이미 잠근 최대 `limit`건 안에서만 매기므로 큐 길이에 영향받지 않는다.
      // 단 점유 인덱스(`mail_jobs_claim_idx`, `mail_jobs_priority_claim_idx`)에 caller_id가 없어
      // 초과 호출처의 대기 행은 인덱스로 건너뛰지 못하고 매 poll 읽고 버린다.
      // 측정: ADR-0007 구현 중 확정 10(대기 순서), ADR-0009(두 경로). 기본 만료 24시간이 대기 건수를 제한한다.
      // 남은 건수를 넘긴 행은 잠겼지만 갱신하지 않고 커밋 때 풀린다. 이 호출은 `limit`보다 적게 점유할 수 있다.
      // 할당 순번(rn)도 선택한 경로로 매긴다. 우선순위 경로에서 잔여 1건이면 가장 높은 등급을 점유한다(RQ-035).
      const { rows } = await client.query<JobRow>(
        `WITH picked AS (
           SELECT id, caller_id, priority, next_attempt_at FROM mail_jobs
            WHERE status IN ('PENDING', 'RETRY_WAIT')
              AND next_attempt_at <= now() AND expires_at > now()
              AND caller_id <> ALL($3::text[])
            ORDER BY ${order.bare}
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         ),
         ranked AS (
           SELECT id, caller_id,
                  row_number() OVER (PARTITION BY caller_id ORDER BY ${order.bare}) AS rn
             FROM picked
         )
         UPDATE mail_jobs SET
           status = 'SENDING', lease_token = gen_random_uuid(),
           leased_at = now(), lease_until = now() + make_interval(secs => $1::double precision)
         FROM ranked r
         WHERE mail_jobs.id = r.id
           AND r.rn <= COALESCE(
                 (SELECT t.remaining FROM unnest($4::text[], $5::int[]) AS t(caller_id, remaining)
                   WHERE t.caller_id = r.caller_id),
                 r.rn)
         RETURNING ${RETURNING}`,
        [
          options.leaseSeconds,
          options.limit,
          quota.blocked,
          quota.remainingIds,
          quota.remainingCounts,
        ],
      );
      return rows.map((r) => toClaimed(r, false));
    }

    // 대표 작업: 작업 행을 먼저 잠그고 차단기를 갱신한다. 완료 경로와 같은 잠금 순서(작업 → 차단기)라 교착이 없다.
    const picked = await client.query<{ id: string }>(
      `SELECT j.id FROM mail_jobs j, mail_circuit_breaker b
        WHERE b.breaker_key = $1
          AND j.status IN ('PENDING', 'RETRY_WAIT')
          AND j.next_attempt_at <= now() AND j.expires_at > now()
          AND j.caller_id <> ALL($2::text[])
        ORDER BY (j.id IS NOT DISTINCT FROM b.last_trip_job_id), ${order.job}
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED`,
      [breakerKey, quota.blocked],
    );
    const candidate = picked.rows[0];
    if (!candidate) return [];
    const leased = await client.query<JobRow>(
      `UPDATE mail_jobs SET
         status = 'SENDING', lease_token = gen_random_uuid(),
         leased_at = now(), lease_until = now() + make_interval(secs => $2::double precision)
       WHERE id = $1
       RETURNING ${RETURNING}`,
      [candidate.id, options.leaseSeconds],
    );
    const job = leased.rows[0]!;
    // probe_until은 작업 lease와 같은 값이다(같은 트랜잭션의 now()).
    const taken = await client.query(
      `UPDATE mail_circuit_breaker SET
         state = 'half_open', probe_until = $3::timestamptz, probe_job_id = $2::uuid,
         updated_at = now()
       WHERE breaker_key = $1
         AND ((state = 'open' AND open_until <= now())
           OR (state = 'half_open' AND probe_until <= now()))`,
      [breakerKey, job.id, job.lease_until],
    );
    if (taken.rowCount !== 1) {
      // 다른 인스턴스가 먼저 half_open을 가져갔다. 이 트랜잭션의 점유를 롤백으로 되돌린다.
      throw new LostProbeRace();
    }
    return [toClaimed(job, true)];
  }).catch((error: unknown) => {
    if (error instanceof LostProbeRace) return [];
    throw error;
  });
}
