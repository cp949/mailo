import type pg from "pg";
import { withTransaction } from "../db/index.js";
import { recordJobEvent, type JobEventType } from "../events/index.js";
import type { JsonValue } from "../events/index.js";
import { recordAccountFailure, recordAccountOk } from "./circuit-breaker.js";
import { breakerInitialWait, retryDelaySeconds } from "./retry-policy.js";
import type {
  AccountErrorReason,
  AttemptDetail,
  AttemptOutcome,
  BreakerConfig,
  BreakerSnapshot,
  CompleteResult,
  RetryPolicy,
} from "./types.js";

export interface CompleteDeps {
  retry: RetryPolicy;
  breaker: BreakerConfig;
}

/** 전이 대상으로 잠근 작업 행 */
interface LockedJob {
  id: string;
  caller_id: string;
  idempotency_key: string;
  attempts: number;
  account_trips: number;
  last_account_response: string | null;
  expires_at: Date;
  recipients: JsonValue;
  leased_at: Date | null;
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

const JOB_COLUMNS = `id, caller_id, idempotency_key, attempts, account_trips,
  last_account_response, expires_at, recipients, leased_at, now() AS db_now`;

/**
 * 시도 결과를 기록하고 작업 상태를 전이한다. lease_token이 맞을 때만 적용한다(ADR-0002 결정 6).
 * 작업 전이, `mail_attempts`, 종결 이벤트, 차단기 갱신이 한 트랜잭션이다(ADR-0006 결정 2).
 * 늦게 도착한 이전 점유의 결과는 `{ applied: false, reason: "LEASE_LOST" }`로 거부하고 아무것도 쓰지 않는다.
 *
 * 판정 순서(ADR-0002 결정 7): 영구 오류 → FAILED, 시도 횟수 소진 → FAILED, 만료 → EXPIRED, 그 밖 → RETRY_WAIT.
 * 계정 상태 오류는 실패 시점의 차단기 상태로 갈린다(ADR-0007 결정 2, 구현 중 확정 8).
 * - 차단기가 open이거나 이 실패로 open이 되면 계정 단위 장애다. 1·2를 건너뛰고 시도 횟수에 넣지 않는다.
 *   `MAIL FROM` 이후 단계의 오류가 차단기를 `maxAccountTrips`회 연 작업에서 같은 응답으로 다시 나오면 FAILED다(결정 4).
 *   단 한도 사유(DAILY_LIMIT·RATE_LIMIT)는 `account_trips`와 이 판정에서 뺀다. 작업 잘못이 아니라 계정 한도다.
 * - 차단기가 closed로 남으면 차단기를 열지 못한 작업별 오류다. 시도 횟수에 넣고 일반 backoff로 재시도하며
 *   최대 시도에 닿으면 FAILED(`ATTEMPTS_EXHAUSTED`)다.
 */
export async function completeAttempt(
  pool: pg.Pool,
  job: { id: string; leaseToken: string },
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
    return applyOutcome(client, row, job.leaseToken, outcome, deps);
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
  deps: CompleteDeps,
): Promise<Extract<CompleteResult, { applied: true }>> {
  const dbNow = job.db_now;
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

    const result = await recordAccountFailure(client, deps.breaker, {
      jobId: job.id,
      reason: outcome.reason,
    });
    breaker = result.snapshot;

    if (breaker.state === "closed") {
      // 차단기를 열지 못했고 실패 시점에도 closed였다. 계정 단위 장애로 볼 근거가 없으므로 작업별 오류로 처리한다.
      counted = true;
      attemptsAfter = job.attempts + 1;
      if (repeated) {
        // 이미 차단기를 3회 연 작업이 같은 응답을 또 받았다. 차단기 상태와 무관하게 이 작업의 문제로 본다.
        target = "FAILED";
        failureReason = "ACCOUNT_REPEATED";
      } else {
        ({ target, failureReason, nextAttemptAt } = retryOrFinish(
          job,
          attemptsAfter,
          deps,
        ));
      }
    } else {
      if (outcome.afterMailFrom) {
        if (result.tripped && !limitReason) accountTrips += 1;
        if (!limitReason)
          lastAccountResponse = response === "" ? null : response;
      }

      // 재개 시각. 차단기가 open이면 open_until, 아니면(half_open의 늦은 실패) 사유별 초기 대기 뒤다.
      const resume =
        breaker.state === "open" && breaker.openUntil
          ? breaker.openUntil
          : new Date(
              dbNow.getTime() +
                breakerInitialWait(deps.breaker, outcome.reason) * 1000,
            );
      if (repeated) {
        target = "FAILED";
        failureReason = "ACCOUNT_REPEATED";
      } else if (afterExpiry(resume)) {
        target = "EXPIRED";
        failureReason = "EXPIRED";
      } else {
        target = "RETRY_WAIT";
        nextAttemptAt = resume;
      }
    }
  } else {
    // TRANSIENT 또는 LEASE_EXPIRED. LEASE_EXPIRED와 내부 오류 TRANSIENT는 계정 상태를 알 수 없어 차단기를 건드리지 않는다.
    if (outcome.classification === "TRANSIENT" && !outcome.internal) {
      breaker = await recordAccountOk(client, deps.breaker, { jobId: job.id });
    }
    ({ target, failureReason, nextAttemptAt } = retryOrFinish(
      job,
      attemptsAfter,
      deps,
    ));
  }

  const terminal = target !== "RETRY_WAIT";
  const updated = await client.query(
    `UPDATE mail_jobs SET
       status = $3::text,
       attempts = $4,
       account_trips = $5,
       last_account_response = $6,
       next_attempt_at = COALESCE($7::timestamptz, next_attempt_at),
       lease_token = NULL, lease_until = NULL, leased_at = NULL,
       failure_reason = $8,
       finished_at = CASE WHEN $9::boolean THEN now() ELSE NULL END
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
        response_text, rejected_recipients, started_at, caller_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, COALESCE($9::timestamptz, now()), $10)`,
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

  return { applied: true, status: target, nextAttemptAt, breaker };
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
 * @returns 복구한 작업 수
 */
export async function recoverExpiredLeases(
  pool: pg.Pool,
  deps: CompleteDeps,
  limit = 100,
): Promise<number> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<LockedJob & { lease_token: string }>(
      `SELECT ${JOB_COLUMNS}, lease_token FROM mail_jobs
        WHERE status = 'SENDING' AND lease_until < now()
        ORDER BY lease_until
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const row of rows) {
      await applyOutcome(
        client,
        row,
        row.lease_token,
        { classification: "LEASE_EXPIRED" },
        deps,
      );
    }
    return rows.length;
  });
}
