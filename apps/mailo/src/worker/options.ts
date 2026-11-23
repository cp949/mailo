import type { BreakerConfig, RetryPolicy } from "../queue/index.js";
import { defaultBreakerConfig, defaultRetryPolicy } from "../queue/index.js";

export interface RetentionOptions {
  /** 종결 후 본문 컬럼을 비우기까지의 유예(초). 기본 1일(ADR-0008 결정 7). */
  bodyGraceSeconds: number;
  /** 종결 후 작업 행·시도 기록·이벤트를 지우기까지의 보존(초). 기본 30일(ADR-0005 결정 7). */
  recordSeconds: number;
}

export interface WorkerOptions {
  retry: RetryPolicy;
  breaker: BreakerConfig;
  /** 점유 lease(초). MAILO_LEASE_SECONDS와 같은 값이어야 한다. SMTP 타임아웃 검증은 `checkSmtpTimeouts`가 한다. */
  leaseSeconds: number;
  /** 새 작업이 없을 때 다음 점유까지 기다리는 시간(ms). 인스턴스 사이에 ±10% 흩뿌린다. */
  pollMs: number;
  /** 동시에 전송하는 작업 수의 상한. 이 값이 커질수록 DB 커넥션을 더 쓴다(작업당 순간 1개). */
  concurrency: number;
  /** 만료·lease 복구 sweep 주기(ms). 상태 조회 정확도를 정한다. */
  sweepIntervalMs: number;
  /** 본문 삭제·보존 삭제 주기(ms). */
  cleanupIntervalMs: number;
  retention: RetentionOptions;
  /** SIGTERM 뒤 진행 중 전송을 기다리는 시간 상한(ms). 컨테이너 `stop_grace_period`보다 짧아야 한다. */
  drainTimeoutMs: number;
  /**
   * Mailo 내부 오류(본문 복호화 실패, 잘못된 작업 데이터 등)로 처리하지 못한 작업을 이 횟수째 시도에서
   * FAILED로 만든다(독성 작업 격리). 추정값이다. 계정 상태 오류가 아니라 작업 데이터 문제일 가능성이 높아
   * 최대 시도 횟수(기본 8)까지 계속 재시도하지 않는다.
   */
  poisonMaxAttempts: number;
  /**
   * 호출처별 24시간 rolling 발송 할당(RQ-032). 키는 호출처 ID다. 생략하거나 없는 호출처는 무제한이다.
   * 호출처 레지스트리의 `sendQuota24h`에서 만든다.
   */
  callerQuotas?: ReadonlyMap<string, number>;
}

/** 호출처 할당의 rolling 창(초, RQ-032). */
const QUOTA_WINDOW_SECONDS = 86_400;

export class WorkerOptionsError extends Error {
  constructor(readonly field: string) {
    super(`invalid worker option (field=${field})`);
    this.name = "WorkerOptionsError";
  }
}

/**
 * 기본 옵션(모두 추정). 운영은 config 값으로 덮어쓴다.
 * drain 상한은 lease보다 10초 짧게 둔다. `stop_grace_period`(lease 이상)가 끝나기 전에 스스로 포기하고,
 * 포기한 작업은 lease 복구가 다룬다.
 */
export function defaultWorkerOptions(leaseSeconds = 120): WorkerOptions {
  return {
    retry: defaultRetryPolicy(),
    breaker: defaultBreakerConfig(),
    leaseSeconds,
    pollMs: 1_000,
    concurrency: 4,
    sweepIntervalMs: 30_000,
    cleanupIntervalMs: 10 * 60_000,
    retention: { bodyGraceSeconds: 24 * 3600, recordSeconds: 30 * 24 * 3600 },
    drainTimeoutMs: Math.max(1_000, (leaseSeconds - 10) * 1000),
    poisonMaxAttempts: 3,
  };
}

export function validateWorkerOptions(options: WorkerOptions): void {
  const positive: Array<[string, number]> = [
    ["leaseSeconds", options.leaseSeconds],
    ["pollMs", options.pollMs],
    ["concurrency", options.concurrency],
    ["sweepIntervalMs", options.sweepIntervalMs],
    ["cleanupIntervalMs", options.cleanupIntervalMs],
    ["drainTimeoutMs", options.drainTimeoutMs],
    ["poisonMaxAttempts", options.poisonMaxAttempts],
    ["retention.bodyGraceSeconds", options.retention.bodyGraceSeconds],
    ["retention.recordSeconds", options.retention.recordSeconds],
  ];
  for (const [field, value] of positive) {
    if (!Number.isFinite(value) || value <= 0)
      throw new WorkerOptionsError(field);
  }
  if (!Number.isInteger(options.concurrency))
    throw new WorkerOptionsError("concurrency");
  if (!Number.isInteger(options.poisonMaxAttempts))
    throw new WorkerOptionsError("poisonMaxAttempts");
  for (const quota of options.callerQuotas?.values() ?? []) {
    if (!Number.isInteger(quota) || quota < 1)
      throw new WorkerOptionsError("callerQuotas");
  }
  // 호출처 할당은 최근 24시간의 시도 기록(`mail_attempts`)을 센다. 기록이 24시간 전에 지워지면 할당이 느슨해진다(RQ-032).
  if (
    options.callerQuotas &&
    options.callerQuotas.size > 0 &&
    options.retention.recordSeconds < QUOTA_WINDOW_SECONDS
  ) {
    throw new WorkerOptionsError("callerQuotas.retention");
  }
  // ADR-0005 결정 7: 본문 유예 <= 작업 행 보존. 순서가 어긋나면 본문보다 행이 먼저 사라진다.
  if (options.retention.bodyGraceSeconds > options.retention.recordSeconds) {
    throw new WorkerOptionsError("retention");
  }
  if (options.drainTimeoutMs >= options.leaseSeconds * 1000)
    throw new WorkerOptionsError("drainTimeoutMs");
}
