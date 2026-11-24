import type pg from "pg";
import { withTransaction } from "../db/index.js";
import { recordJobEvent, type JobEventType } from "../events/index.js";
import type { JsonValue } from "../events/index.js";
import {
  getBreakerState,
  recordAccountFailure,
  recordAccountOk,
} from "./circuit-breaker.js";
import { tryMaintenanceLock } from "./maintenance.js";
import { notifyTransitions } from "./transitions.js";
import { breakerInitialWait, retryDelaySeconds } from "./retry-policy.js";
import { OUTCOME_UNKNOWN, isUncertainOutcome } from "./uncertain.js";
import type {
  AccountErrorReason,
  AttemptDetail,
  AttemptOutcome,
  BreakerConfig,
  BreakerSnapshot,
  CompleteResult,
  JobTransition,
  RetryPolicy,
  TransitionListener,
} from "./types.js";

/** `mail_attempts.instance`에 쓰는 최대 글자 수(migrations/0003의 CHECK와 같다). */
const ATTEMPT_INSTANCE_MAX_CHARS = 128;

export interface CompleteDeps {
  retry: RetryPolicy;
  breaker: BreakerConfig;
}

/** 전이 대상으로 잠근 작업 행 */
interface LockedJob {
  id: string;
  caller_id: string;
  account_id: string;
  idempotency_key: string;
  attempts: number;
  account_trips: number;
  last_account_response: string | null;
  expires_at: Date;
  recipients: JsonValue;
  leased_at: Date | null;
  /** 등록 때 고정된 결과 불명 처리(`retry`·`fail`, RQ-073). */
  on_uncertain: string;
  db_now: Date;
}

/** lease 만료 복구가 쓰는 내부 결과. 공개 분류(`AttemptOutcome`)에는 없다. */
type InternalOutcome = AttemptOutcome | { classification: "LEASE_EXPIRED" };

/** 계정 전체의 한도를 뜻하는 사유. 작업의 `account_trips`와 반복 판정에서 뺀다(ADR-0007 구현 중 확정 8). */
const LIMIT_REASONS: ReadonlySet<AccountErrorReason> = new Set([
  "DAILY_LIMIT",
  "RATE_LIMIT",
]);

const EVENT_TYPE: Record<"SENT" | "FAILED" | "EXPIRED", JobEventType> = {
  SENT: "JOB_SENT",
  FAILED: "JOB_FAILED",
  EXPIRED: "JOB_EXPIRED",
};

const JOB_COLUMNS = `id, caller_id, account_id, idempotency_key, attempts, account_trips,
  last_account_response, expires_at, recipients, leased_at, on_uncertain, now() AS db_now`;

/**
 * 시도 결과를 기록하고 작업 상태를 전이한다. lease_token이 맞을 때만 적용한다(ADR-0002 결정 6).
 * 작업 전이, `mail_attempts`, 종결 이벤트, 차단기 갱신이 한 트랜잭션이다(ADR-0006 결정 2).
 * 늦게 도착한 이전 점유의 결과는 `{ applied: false, reason: "LEASE_LOST" }`로 거부하고 아무것도 쓰지 않는다.
 *
 * 판정 순서(ADR-0002 결정 7): 영구 오류 → FAILED, 시도 횟수 소진 → FAILED, 만료 → EXPIRED, 그 밖 → RETRY_WAIT.
 * 요청이 `fail`을 고른 작업(`on_uncertain`)의 결과 불명 시도(`isUncertainOutcome`)는 `retryOrFinish`보다 먼저
 * `FAILED`·`OUTCOME_UNKNOWN`으로 종결한다. 소진·만료와 겹쳐도 이 사유가 우선한다(ADR-0015 결정 8, RQ-074).
 * 계정 상태 오류는 실패 시점의 차단기 상태로 갈린다(ADR-0007 결정 2, 구현 중 확정 8).
 * - 차단기가 open이거나 이 실패로 open이 되면 계정 단위 장애다. 1·2를 건너뛰고 시도 횟수에 넣지 않는다.
 *   `MAIL FROM` 이후 단계의 오류가 차단기를 `maxAccountTrips`회 연 작업에서 같은 응답으로 다시 나오면 FAILED다(결정 4).
 *   단 한도 사유(DAILY_LIMIT·RATE_LIMIT)는 `account_trips`와 이 판정에서 뺀다. 작업 잘못이 아니라 계정 한도다.
 *   반복으로 판정되면 `recordAccountFailure`를 부르지 않는다. 대표 작업이면 `recordAccountOk`로 차단기를 닫고,
 *   아니면 차단기를 건드리지 않는다(구현 중 확정 9). 시도 횟수는 실패 시점의 차단기 상태가 closed일 때만 센다.
 * - 차단기가 closed로 남으면 차단기를 열지 못한 작업별 오류다. 시도 횟수에 넣고 일반 backoff로 재시도하며
 *   최대 시도에 닿으면 FAILED(`ATTEMPTS_EXHAUSTED`)다.
 */
export async function completeAttempt(
  pool: pg.Pool,
  job: {
    id: string;
    leaseToken: string;
    /** 결과를 기록하는 인스턴스. 로그의 `instance`와 같은 값이며 `mail_attempts.instance`에 쓴다. 128자까지만 쓴다. */
    instance?: string;
  },
  outcome: AttemptOutcome,
  deps: CompleteDeps,
): Promise<CompleteResult> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query<LockedJob>(
      `SELECT ${JOB_COLUMNS} FROM mail_jobs
        WHERE id = $1 AND status = 'SENDING' AND lease_token = $2
        FOR UPDATE`,
      [job.id, job.leaseToken],
    );
    const row = locked.rows[0];
    if (!row) return { applied: false, reason: "LEASE_LOST" } as const;
    return applyOutcome(
      client,
      row,
      job.leaseToken,
      outcome,
      deps,
      job.instance?.slice(0, ATTEMPT_INSTANCE_MAX_CHARS) ?? null,
    );
  });
}

/**
 * 호출자가 연 트랜잭션 안에서 잠근 SENDING 작업에 결과를 적용한다.
 * `completeAttempt`와 lease 복구가 공유한다.
 */
async function applyOutcome(
  client: pg.PoolClient,
  job: LockedJob,
  leaseToken: string,
  outcome: InternalOutcome,
  baseDeps: CompleteDeps,
  /** 시도를 기록하는 인스턴스. lease 회수는 점유한 인스턴스를 알 수 없어 null이다. */
  instance: string | null = null,
): Promise<Extract<CompleteResult, { applied: true }>> {
  const dbNow = job.db_now;
  // 차단기 행은 작업이 등록 때 고정한 계정의 것이다(ADR-0013 결정 3 나). 요청·호출처 매핑을 다시 읽지 않는다.
  const deps = {
    ...baseDeps,
    breaker: { ...baseDeps.breaker, breakerKey: job.account_id },
  };
  // 계정 상태 오류는 아래에서 차단기 상태를 본 뒤에 시도 횟수에 넣을지 정한다.
  let counted = outcome.classification !== "ACCOUNT";
  let attemptsAfter = job.attempts + (counted ? 1 : 0);
  const detail: AttemptDetail =
    outcome.classification === "LEASE_EXPIRED" ? {} : outcome;

  let target: "SENT" | "RETRY_WAIT" | "FAILED" | "EXPIRED";
  let failureReason: string | null = null;
  let nextAttemptAt: Date | null = null;
  let breaker: BreakerSnapshot | null = null;
  let accountTrips = job.account_trips;
  let lastAccountResponse = job.last_account_response;
  let outcomeUnknown = false;

  const expiresAt = job.expires_at;
  const afterExpiry = (next: Date) =>
    dbNow.getTime() >= expiresAt.getTime() ||
    next.getTime() > expiresAt.getTime();

  if (outcome.classification === "SENT") {
    target = "SENT";
    breaker = await recordAccountOk(client, deps.breaker, { jobId: job.id });
  } else if (outcome.classification === "PERMANENT") {
    target = "FAILED";
    failureReason = "PERMANENT";
    // 내부 오류는 계정 상태를 알려주지 않으므로 차단기를 건드리지 않는다.
    if (!outcome.internal) {
      breaker = await recordAccountOk(client, deps.breaker, { jobId: job.id });
    }
  } else if (outcome.classification === "ACCOUNT") {
    const response =
      `${outcome.responseCode ?? ""} ${outcome.enhancedCode ?? ""}`.trim();
    // 한도 사유는 계정 전체의 문제라서 작업의 account_trips·반복 판정에 넣지 않는다(ADR-0007 구현 중 확정 8).
    const limitReason = LIMIT_REASONS.has(outcome.reason);
    const sameResponse =
      response !== "" && response === job.last_account_response;
    const repeated =
      !limitReason &&
      outcome.afterMailFrom &&
      job.account_trips >= deps.breaker.maxAccountTrips &&
      sameResponse;

    if (repeated) {
      // 이 작업의 문제로 보고 끝낸다. 차단기를 다시 열지 않는다. recordAccountFailure를 먼저 부르면 대표 작업의 실패가
      // 차단기를 되열고 대기가 2배가 된다(일반 PERMANENT가 recordAccountOk를 부르는 것과 어긋난다).
      // 상태 확인은 행을 잠그지 않는 SELECT다. 잠금 순서(작업 행 -> 차단기 행)를 지킨다.
      const current = await getBreakerState(client, deps.breaker);
      const isProbe =
        current.state === "half_open" && current.probeJobId === job.id;
      breaker = isProbe
        ? ((await recordAccountOk(client, deps.breaker, { jobId: job.id })) ??
          current)
        : current;
      // 시도 횟수는 실패 시점의 차단기 상태로 정한다(구현 중 확정 8). closed였으면 작업별 오류로 센다.
      counted = current.state === "closed";
      attemptsAfter = job.attempts + (counted ? 1 : 0);
      target = "FAILED";
      failureReason = "ACCOUNT_REPEATED";
    } else {
      const result = await recordAccountFailure(client, deps.breaker, {
        jobId: job.id,
        reason: outcome.reason,
      });
      breaker = result.snapshot;

      if (breaker.state === "closed") {
        // 차단기를 열지 못했고 실패 시점에도 closed였다. 계정 단위 장애로 볼 근거가 없으므로 작업별 오류로 처리한다.
        counted = true;
        attemptsAfter = job.attempts + 1;
        ({ target, failureReason, nextAttemptAt } = retryOrFinish(
          job,
          attemptsAfter,
          deps,
        ));
      } else {
        if (outcome.afterMailFrom) {
          if (result.tripped && !limitReason) accountTrips += 1;
          if (!limitReason)
            lastAccountResponse = response === "" ? null : response;
        }

        // 재개 시각. 차단기가 open이고 `open_until`이 아직 미래면 `open_until`이다. 그 밖은 사유별 초기 대기 뒤다.
        // - half_open의 늦은 실패.
        // - `open_until`이 이미 지난 open에서 늦게 도착한 실패(대기 시간이 지났지만 대표 작업이 아직 점유되지 않았다).
        //   `open_until`을 그대로 쓰면 재시도 시각이 과거가 되어 같은 작업을 곧바로 다시 점유하고 SMTP를 연달아 부른다.
        //   방금 실패했다는 사실이 더 새로운 증거라서 half_open의 늦은 실패와 같이 초기 대기를 둔다(ADR-0013 결정 3, RQ-054).
        // 시각은 이 트랜잭션의 DB `now()`(`db_now`)다(ADR-0002 결정 10).
        const resume =
          breaker.state === "open" &&
          breaker.openUntil &&
          breaker.openUntil.getTime() > dbNow.getTime()
            ? breaker.openUntil
            : new Date(
                dbNow.getTime() +
                  breakerInitialWait(deps.breaker, outcome.reason) * 1000,
              );
        if (afterExpiry(resume)) {
          target = "EXPIRED";
          failureReason = "EXPIRED";
        } else {
          target = "RETRY_WAIT";
          nextAttemptAt = resume;
        }
      }
    }
  } else {
    // TRANSIENT 또는 LEASE_EXPIRED. LEASE_EXPIRED와 내부 오류 TRANSIENT는 계정 상태를 알 수 없어 차단기를 건드리지 않는다.
    // 차단기 처리는 `on_uncertain`과 무관하게 먼저 하고 정책 분기는 그 뒤에 둔다. `fail`이어도 차단기에 주는 영향은 `retry`와 같다.
    if (outcome.classification === "TRANSIENT" && !outcome.internal) {
      breaker = await recordAccountOk(client, deps.breaker, { jobId: job.id });
    }
    if (job.on_uncertain === "fail" && isUncertainOutcome(outcome)) {
      // 시도 횟수는 기존 규칙대로 센다(`attemptsAfter`는 위에서 이미 `counted`를 반영했다).
      outcomeUnknown = true;
      target = "FAILED";
      failureReason = OUTCOME_UNKNOWN;
    } else {
      ({ target, failureReason, nextAttemptAt } = retryOrFinish(
        job,
        attemptsAfter,
        deps,
      ));
    }
  }

  const terminal = target !== "RETRY_WAIT";
  // 종결이면 같은 문장에서 본문·수신자·봉투를 비운다(RQ-071, ADR-0015 결정 2).
  // 종결 이벤트의 수신자는 위에서 잠그며 읽은 `job.recipients`(비우기 전 값)를 쓴다.
  // 본문 세 열은 함께 NULL이어야 한다(`mail_jobs_body_state`). 재시도(`RETRY_WAIT`)면 아무것도 비우지 않는다.
  const updated = await client.query(
    `UPDATE mail_jobs SET
       status = $3::text,
       attempts = $4,
       account_trips = $5,
       last_account_response = $6,
       next_attempt_at = COALESCE($7::timestamptz, next_attempt_at),
       lease_token = NULL, lease_until = NULL, leased_at = NULL,
       failure_reason = $8,
       finished_at = CASE WHEN $9::boolean THEN now() ELSE NULL END,
       body_ciphertext = CASE WHEN $9::boolean THEN NULL ELSE body_ciphertext END,
       body_nonce = CASE WHEN $9::boolean THEN NULL ELSE body_nonce END,
       body_key_version = CASE WHEN $9::boolean THEN NULL ELSE body_key_version END,
       body_deleted_at = CASE WHEN $9::boolean THEN now() ELSE body_deleted_at END,
       recipients = CASE WHEN $9::boolean THEN '{}'::jsonb ELSE recipients END,
       envelope = CASE WHEN $9::boolean THEN '{}'::jsonb ELSE envelope END
     WHERE id = $1 AND status = 'SENDING' AND lease_token = $2`,
    [
      job.id,
      leaseToken,
      target,
      attemptsAfter,
      accountTrips,
      lastAccountResponse,
      nextAttemptAt,
      failureReason,
      terminal,
    ],
  );
  if (updated.rowCount !== 1) {
    // 같은 트랜잭션에서 행을 잠갔으므로 일어나지 않아야 한다. 일어나면 전체를 롤백한다.
    throw new Error("작업 전이 UPDATE가 1행을 갱신하지 못했다");
  }

  await client.query(
    `INSERT INTO mail_attempts
       (job_id, classification, counted, stage, response_code, enhanced_code,
        response_text, rejected_recipients, started_at, caller_id, instance, account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, COALESCE($9::timestamptz, now()), $10, $11, $12)`,
    [
      job.id,
      outcome.classification,
      counted,
      detail.stage ?? null,
      detail.responseCode ?? null,
      detail.enhancedCode ?? null,
      detail.responseText ?? null,
      outcome.classification === "SENT" && outcome.rejectedRecipients != null
        ? JSON.stringify(outcome.rejectedRecipients)
        : null,
      job.leased_at,
      // 호출처별 할당 사용량 집계용 복사본(RQ-032, migrations/0002).
      job.caller_id,
      // 로그의 `instance`와 행을 잇는다(migrations/0003). 수신자·본문 정보가 아니다.
      instance,
      // 계정 24시간 할당이 조인 없이 세기 위한 복사본이다(migrations/0011, `ACCOUNT_QUOTA_USAGE_SQL`).
      job.account_id,
    ],
  );

  if (target !== "RETRY_WAIT") {
    const failureDetail =
      detail.responseCode != null || detail.enhancedCode != null
        ? `${detail.responseCode ?? ""} ${detail.enhancedCode ?? ""}`.trim()
        : null;
    await recordJobEvent(client, {
      type: EVENT_TYPE[target],
      callerId: job.caller_id,
      jobId: job.id,
      idempotencyKey: job.idempotency_key,
      failureReason,
      failureDetail: target === "SENT" ? null : failureDetail,
      attemptCount: attemptsAfter,
      recipients: job.recipients,
      rejectedRecipients:
        outcome.classification === "SENT"
          ? (outcome.rejectedRecipients ?? null)
          : null,
    });
  }

  return {
    applied: true,
    status: target,
    nextAttemptAt,
    breaker,
    ...(outcomeUnknown && { outcomeUnknown: true as const }),
  };
}

/**
 * 시도 횟수를 넣은 뒤의 전이를 정한다(ADR-0002 결정 7의 2~4). 최대 시도에 닿으면 FAILED, 재시도 시각이
 * 만료 시각을 넘으면 EXPIRED, 그 밖은 일반 backoff로 RETRY_WAIT다.
 */
function retryOrFinish(
  job: LockedJob,
  attemptsAfter: number,
  deps: CompleteDeps,
): {
  target: "RETRY_WAIT" | "FAILED" | "EXPIRED";
  failureReason: string | null;
  nextAttemptAt: Date | null;
} {
  if (attemptsAfter >= deps.retry.maxAttempts) {
    return {
      target: "FAILED",
      failureReason: "ATTEMPTS_EXHAUSTED",
      nextAttemptAt: null,
    };
  }
  const dbNow = job.db_now;
  const next = new Date(
    dbNow.getTime() + retryDelaySeconds(deps.retry, attemptsAfter) * 1000,
  );
  if (
    dbNow.getTime() >= job.expires_at.getTime() ||
    next.getTime() > job.expires_at.getTime()
  ) {
    return { target: "EXPIRED", failureReason: "EXPIRED", nextAttemptAt: null };
  }
  return { target: "RETRY_WAIT", failureReason: null, nextAttemptAt: next };
}

/**
 * lease가 지난 SENDING 작업을 복구한다(ADR-0002 결정 5). 점유 쿼리 앞단에서 부른다.
 * 작업마다 `LEASE_EXPIRED` 시도를 기록하고(최대 시도 횟수에 포함) 판정 순서대로 전이한다.
 * SMTP 수락 직후 장애라면 재시도가 중복 발송이 된다(RQ-013).
 * `exclusive`가 true이면 정리 잠금(`tryMaintenanceLock`)을 먼저 시도해 못 잡으면 0을 돌려준다(유지보수 루프용).
 * 점유 앞단의 호출은 잠금 없이 복구한다. 복구 지연이 정체와 중복 발송으로 이어질 수 있어서다(ADR-0002 결정 5).
 * `onRecovered`는 커밋한 뒤 회수한 작업의 호출처와 전이 뒤 상태(`RETRY_WAIT`·`FAILED`·`EXPIRED`)를 한 번 알린다(지표용, ADR-0012 결정 7).
 * 롤백되면 부르지 않는다.
 * @returns 복구한 작업 수
 */
export async function recoverExpiredLeases(
  pool: pg.Pool,
  deps: CompleteDeps,
  limit = 100,
  options: { exclusive?: boolean; onRecovered?: TransitionListener } = {},
): Promise<number> {
  const transitions: JobTransition[] = [];
  const count = await withTransaction(pool, async (client) => {
    if (options.exclusive && !(await tryMaintenanceLock(client, "lease")))
      return 0;
    const { rows } = await client.query<LockedJob & { lease_token: string }>(
      `SELECT ${JOB_COLUMNS}, lease_token FROM mail_jobs
        WHERE status = 'SENDING' AND lease_until < now()
        ORDER BY lease_until
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const row of rows) {
      const result = await applyOutcome(
        client,
        row,
        row.lease_token,
        { classification: "LEASE_EXPIRED" },
        deps,
      );
      transitions.push({
        callerId: row.caller_id,
        accountId: row.account_id,
        status: result.status,
        ...(result.outcomeUnknown && { outcomeUnknown: true as const }),
      });
    }
    return rows.length;
  });
  notifyTransitions(options.onRecovered, transitions);
  return count;
}
