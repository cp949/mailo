/**
 * Worker가 읽는 옵션. 값은 `loadConfig`가 환경 변수에서 읽어 검증한 뒤 `AppConfig.worker`로 준다.
 * 큐 모듈의 `RetryPolicy`·`BreakerConfig`에서 함수 필드(`random`)와 같은 것을 뺀 구조다.
 * Worker는 이 값에 `random: Math.random`을 붙여 큐 정책 객체를 만든다.
 * 모든 수치는 추정 기본값이며 환경 변수로 바꾼다(RQ-008, ADR-0007 결정 4·5).
 */

/** 계정 상태 오류 사유(큐의 `AccountErrorReason`과 같은 값). */
export type WorkerAccountReason =
  | "DAILY_LIMIT"
  | "RATE_LIMIT"
  | "CONNECTION"
  | "TLS"
  | "AUTH"
  | "OTHER";

export interface WorkerRetryOptions {
  /** 첫 시도를 포함한 최대 시도 횟수. */
  maxAttempts: number;
  mode: "exponential" | "fixed";
  baseSeconds: number;
  multiplier: number;
  capSeconds: number;
  /** ±비율. 0.2면 ±20% 균등. 0 이상 1 미만. */
  jitterRatio: number;
}

export interface WorkerBreakerOptions {
  breakerKey: string;
  /** closed에서 open으로 가는 연속 계정 상태 오류 수. */
  failureThreshold: number;
  /** 사유별 open 초기 대기 시간(초). */
  initialWaitSeconds: Record<WorkerAccountReason, number>;
  /** 대기 시간 상한은 `max(capFloorSeconds, 해당 사유의 초기값)`이다. */
  capFloorSeconds: number;
  /** 한도 초과 사유는 연속 실패 수와 무관하게 즉시 open한다(ADR-0007 결정 5). 설정으로 바꾸지 않는다. */
  immediateOpenReasons: readonly WorkerAccountReason[];
  /** 같은 작업이 차단기를 이 횟수만큼 연 뒤에도 같은 응답을 받으면 FAILED(ADR-0007 결정 4). */
  maxAccountTrips: number;
}

export interface WorkerRetentionOptions {
  /** 종결 후 본문 삭제 유예 초(ADR-0008 결정 7, 기본 1일). */
  bodyGraceSeconds: number;
  /** 종결 후 작업 행·시도·이벤트 보존 초, 거부 기록은 생성 후 초(ADR-0005 결정 7, 기본 30일). */
  recordRetentionSeconds: number;
  /** sweep·보존 삭제를 도는 간격(ms). */
  maintenanceIntervalMs: number;
}

export interface WorkerOptions {
  retry: WorkerRetryOptions;
  breaker: WorkerBreakerOptions;
  /** 작업 점유 lease. `stop_grace_period`는 이 값 이상이어야 한다(ADR-0002 결정 12). */
  lease: { seconds: number };
  /** claim 폴링 간격(ms). */
  pollMs: number;
  /** 동시에 전송하는 작업 수 상한. 값이 클수록 DB 커넥션을 더 쓴다(작업당 순간 1개). */
  concurrency: number;
  retention: WorkerRetentionOptions;
}

/** 종료 신호 뒤 진행 중 전송을 기다리는 상한(ms). lease보다 10초 짧고 최소 1초다(ADR-0002 결정 12). */
export function workerDrainTimeoutMs(leaseSeconds: number): number {
  return Math.max(1_000, (leaseSeconds - 10) * 1000);
}

/** drain 상한 뒤 풀 닫기·폴러 정지에 필요한 여유(ms). `stop_grace_period`는 drain 상한에 이 값을 더한 값 이상이어야 한다. */
export const SHUTDOWN_MARGIN_MS = 10_000;
