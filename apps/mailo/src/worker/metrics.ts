import type { AppMetrics } from "../metrics/index.js";
import type {
  AccountErrorReason,
  AttemptOutcome,
  JobStatus,
  JobTransition,
} from "../queue/index.js";

/**
 * Worker가 올리는 counter(RQ-049, ADR-0012 결정 4·7). 라벨은 닫힌 값만 만든다. SMTP 응답 코드·텍스트와 주소는 쓰지 않는다(ADR-0007 구현 중 확정 5).
 * `queue/`는 `metrics/`를 import하지 않으므로 Worker가 큐의 결과와 콜백을 받아 올린다.
 */

type AttemptResult =
  | "sent"
  | "transient"
  | "permanent"
  | "account"
  | "internal";

/** 시도 결과의 `result` 라벨. 내부 오류(`internal: true`)는 분류와 무관하게 `internal`이다. */
export function attemptResultLabel(outcome: AttemptOutcome): AttemptResult {
  if (outcome.classification === "SENT") return "sent";
  if (outcome.classification === "ACCOUNT") return "account";
  if ("internal" in outcome && outcome.internal === true) return "internal";
  return outcome.classification === "TRANSIENT" ? "transient" : "permanent";
}

const ACCOUNT_REASON: Record<AccountErrorReason, string> = {
  DAILY_LIMIT: "daily_limit",
  RATE_LIMIT: "rate_limit",
  CONNECTION: "connection",
  TLS: "tls",
  AUTH: "auth",
  OTHER: "other",
};

/** 종결 상태의 `status` 라벨. 종결이 아닌 상태(`RETRY_WAIT` 등)는 undefined다. */
function finishedLabel(status: JobStatus): string | undefined {
  switch (status) {
    case "SENT":
      return "sent";
    case "FAILED":
      return "failed";
    case "EXPIRED":
      return "expired";
    case "CANCELED":
      return "canceled";
    default:
      return undefined;
  }
}

/** 종결 전이 하나를 센다(종결이 아니면 무시한다). */
export function countFinished(
  metrics: AppMetrics,
  job: { callerId: string; accountId: string },
  status: JobStatus,
): void {
  const label = finishedLabel(status);
  if (label !== undefined)
    metrics.inc("mailo_jobs_finished_total", {
      caller_id: job.callerId,
      account_id: job.accountId,
      status: label,
    });
}

/**
 * 결과 기록이 적용된 뒤 시도·실패 분류·종결을 센다. `LEASE_LOST`로 버린 결과에는 부르지 않는다(결정 4).
 * `stage`와 `reason`은 카탈로그의 닫힌 집합으로 정규화된다. 집합 밖의 값은 `unknown`·`other`로 센다.
 */
export function countAttempt(
  metrics: AppMetrics,
  job: { callerId: string; accountId: string },
  outcome: AttemptOutcome,
  status: JobStatus,
): void {
  const result = attemptResultLabel(outcome);
  metrics.inc("mailo_attempts_total", {
    caller_id: job.callerId,
    account_id: job.accountId,
    result,
  });
  if (result !== "sent")
    metrics.inc("mailo_attempt_errors_total", {
      account_id: job.accountId,
      result,
      stage: outcome.stage?.toLowerCase() ?? "unknown",
      reason:
        outcome.classification === "ACCOUNT"
          ? (ACCOUNT_REASON[outcome.reason] ?? "other")
          : "none",
    });
  countFinished(metrics, job, status);
}

/** 만료 sweep이 커밋한 전이를 센다. */
export function countSwept(
  metrics: AppMetrics,
  transitions: ReadonlyArray<JobTransition>,
): void {
  for (const t of transitions) countFinished(metrics, t, t.status);
}

/** lease 회수가 커밋한 전이를 센다. 회수 건수와 그 결과 종결을 함께 올린다. */
export function countRecovered(
  metrics: AppMetrics,
  transitions: ReadonlyArray<JobTransition>,
): void {
  for (const t of transitions) {
    metrics.inc("mailo_lease_recovered_total", { account_id: t.accountId });
    countFinished(metrics, t, t.status);
  }
}
