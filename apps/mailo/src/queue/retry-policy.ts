import type { BreakerConfig, RetryPolicy } from "./types.js";

/** RQ-008 기본값. 모두 추정이며 설정으로 바꾼다. */
export function defaultRetryPolicy(): RetryPolicy {
  return {
    maxAttempts: 8,
    mode: "exponential",
    baseSeconds: 60,
    multiplier: 2,
    capSeconds: 3600,
    jitterRatio: 0.2,
    random: Math.random,
  };
}

/** ADR-0007 결정 4·5 기본값. 모두 추정이며 설정으로 바꾼다. */
export function defaultBreakerConfig(): BreakerConfig {
  return {
    breakerKey: "default",
    failureThreshold: 3,
    initialWaitSeconds: {
      DAILY_LIMIT: 3600,
      RATE_LIMIT: 300,
      CONNECTION: 60,
      TLS: 60,
      AUTH: 60,
      OTHER: 60,
    },
    capFloorSeconds: 1800,
    immediateOpenReasons: ["DAILY_LIMIT", "RATE_LIMIT"],
    maxAccountTrips: 3,
  };
}

/**
 * 시도 `attemptsSoFar`번째 실패 뒤 다음 시도까지의 대기 시간(초).
 * exponential이면 `min(상한, 기준 × 배수^(n-1))`에 jitter를 더한다(ADR-0003 결정 5).
 * fixed이면 기준 간격 그대로다.
 */
export function retryDelaySeconds(
  policy: RetryPolicy,
  attemptsSoFar: number,
): number {
  if (policy.mode === "fixed") return policy.baseSeconds;
  const n = Math.max(attemptsSoFar, 1);
  const raw = Math.min(
    policy.capSeconds,
    policy.baseSeconds * policy.multiplier ** (n - 1),
  );
  const jitter = (policy.random() * 2 - 1) * policy.jitterRatio;
  return Math.max(0, raw * (1 + jitter));
}

/** 사유별 open 초기 대기 시간(초). */
export function breakerInitialWait(
  config: BreakerConfig,
  reason: keyof BreakerConfig["initialWaitSeconds"],
): number {
  return config.initialWaitSeconds[reason];
}

/** open 대기 시간 상한(초). `max(30분, 해당 사유의 초기값)`이다(ADR-0007 결정 5). */
export function breakerWaitCap(
  config: BreakerConfig,
  reason: keyof BreakerConfig["initialWaitSeconds"],
): number {
  return Math.max(config.capFloorSeconds, config.initialWaitSeconds[reason]);
}
