/**
 * 지표 카탈로그(RQ-049, ADR-0012 결정 3·4·6). 이름·종류·분류·라벨 이름·허용 값은 이 파일 한 곳에만 있다.
 * 이 모듈은 다른 앱 모듈을 import하지 않는 leaf다(`logging/`과 같다).
 *
 * - 분류 `global`: DB(또는 설정)에서 정해지는 gauge. 어느 인스턴스가 내도 같다. 합칠 때 `max`를 쓰고 `sum`을 쓰지 않는다.
 * - 분류 `instance`: 이 프로세스가 한 일(counter, 재시작하면 0)과 이 프로세스의 상태(gauge)다.
 * - 분류 `process`: Prometheus 관례 이름의 프로세스 지표다.
 * - HELP는 "전역." 또는 "인스턴스."로 시작한다. 읽는 사람이 합치는 법을 HELP에서 알 수 있게 한다.
 */

/** 시리즈 라벨 이름으로 쓸 수 있는 것의 전체 목록. 앞의 셋이 열린 값이고 나머지는 값이 코드의 닫힌 집합이다(결정 6). */
export const ALLOWED_LABELS = [
  "caller_id",
  "account_id",
  "reason",
  "state",
  "priority",
  "result",
  "stage",
  "status",
  "group",
] as const;

export type LabelName = (typeof ALLOWED_LABELS)[number];

/** 레지스트리에 없는 호출처를 묶는 값(결정 6). 가짜 호출처 ID로 시리즈를 늘리지 못하게 한다. */
export const UNREGISTERED_CALLER = "unregistered";

/** 환경 변수로 정의한 계정의 ID. `account_id`를 생략한 증가의 기본 값이다. `config/`의 `DEFAULT_SMTP_ACCOUNT_ID`와 같은 상수다(leaf라 따로 둔다). */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * 구성에 없는 계정의 작업을 묶는 값(ADR-0013 결정 5). 계정이 구성에서 빠진 뒤 남은 작업이 만료 sweep으로 종결되는 경우다.
 * 계정 ID 형식 검사가 이 값을 예약어로 거부하므로(`config/`의 `RESERVED_ACCOUNT_ID`) 구성한 계정과 겹치지 않는다.
 */
export const UNREGISTERED_ACCOUNT = "unregistered";

export type LabelSpec =
  /** 호출처 ID. 기동 때 읽은 레지스트리에 있는 값만 쓰고 그 밖은 `unregistered`다. */
  | { readonly kind: "caller" }
  /** 계정 ID. 기동 때 구성한 계정 ID와 `unregistered`뿐이다(ADR-0013 결정 5). */
  | { readonly kind: "account" }
  /** 값이 코드의 닫힌 집합이다. 집합 밖의 값은 `fallback`으로 센다. `fallback`이 없으면 버린다. */
  | {
      readonly kind: "enum";
      readonly values: readonly string[];
      readonly fallback?: string;
    };

export type MetricType = "counter" | "gauge";
export type MetricScope = "global" | "instance" | "process";

export interface MetricDef {
  readonly name: string;
  readonly type: MetricType;
  readonly scope: MetricScope;
  readonly help: string;
  /** 라벨 이름 → 값 규칙. 선언 순서가 출력 순서다. */
  readonly labels: Readonly<Record<string, LabelSpec>>;
  /**
   * true이면 counter를 시작할 때 라벨 조합마다 0으로 미리 낸다(호출처는 레지스트리 ID만). 처음 증가하는 순간에 시리즈가 처음 생기면
   * Prometheus `increase()`가 그 첫 이벤트를 놓치기 때문이다. 알림 규칙이 쓰는 counter에만 켠다(ADR-0012 구현 중 확정 15).
   */
  readonly seed?: true;
}

const caller = { kind: "caller" } as const;
const account = { kind: "account" } as const;
const oneOf = <const V extends readonly string[]>(
  values: V,
  fallback?: V[number],
) =>
  ({
    kind: "enum",
    values,
    ...(fallback !== undefined && { fallback }),
  }) as const;

/** 차단기 사유. 헬스 `lastReason`과 같은 어휘다(결정 4). */
const BREAKER_REASONS = [
  "AUTH_FAILED",
  "TLS_FAILED",
  "CONNECTION_FAILED",
  "QUOTA_DAILY",
  "QUOTA_BURST",
  "OTHER",
] as const;

const CATALOG = [
  // --- 전역 gauge(DB 조회, 결정 4·5) -----------------------------------------
  {
    name: "mailo_queue_jobs",
    type: "gauge",
    scope: "global",
    help: "전역. 큐의 작업 수. due는 점유 가능, scheduled는 재시도·예약 대기, sending은 점유 중이다. due와 scheduled는 10000에서 멈춘다.",
    labels: {
      account_id: account,
      state: oneOf(["due", "scheduled", "sending"]),
    },
  },
  {
    name: "mailo_queue_jobs_truncated",
    type: "gauge",
    scope: "global",
    help: "전역. 1이면 해당 건수가 상한(10000)에 닿아 실제로는 더 많을 수 있다.",
    labels: { account_id: account, state: oneOf(["due", "scheduled"]) },
  },
  {
    name: "mailo_queue_oldest_due_age_seconds",
    type: "gauge",
    scope: "global",
    help: "전역. 등급별로 가장 오래 기다린 점유 가능 작업의 경과 초. 대기 작업이 없으면 0이다. 전체 값은 max by (account_id)다.",
    labels: {
      account_id: account,
      priority: oneOf(["low", "normal", "high", "urgent"]),
    },
  },
  {
    name: "mailo_breaker_state",
    type: "gauge",
    scope: "global",
    help: "전역. 차단기의 현재 상태 시리즈만 1이고 나머지는 0이다.",
    labels: {
      account_id: account,
      state: oneOf(["closed", "open", "half_open"]),
    },
  },
  {
    name: "mailo_breaker_reason_info",
    type: "gauge",
    scope: "global",
    help: "전역. 차단기가 closed가 아니고 사유가 있을 때만 1인 시리즈 하나. reason은 헬스 lastReason과 같은 어휘다.",
    labels: { account_id: account, reason: oneOf(BREAKER_REASONS) },
  },
  {
    name: "mailo_send_paused_all",
    type: "gauge",
    scope: "global",
    help: "전역. 전체 발송 정지 여부(0 또는 1).",
    labels: {},
  },
  {
    name: "mailo_send_paused_callers",
    type: "gauge",
    scope: "global",
    help: "전역. 발송을 정지한 호출처 수. 레지스트리에 없는 호출처의 정지도 센다.",
    labels: {},
  },
  {
    name: "mailo_caller_paused",
    type: "gauge",
    scope: "global",
    help: "전역. 레지스트리 호출처별 발송 정지 여부(0 또는 1).",
    labels: { caller_id: caller },
  },
  {
    name: "mailo_caller_quota_limit",
    type: "gauge",
    scope: "global",
    help: "전역. 호출처의 24시간 발송 할당(sendQuota24h). 설정한 호출처만. 이 인스턴스의 레지스트리 값이다.",
    labels: { caller_id: caller },
  },
  {
    name: "mailo_caller_quota_used",
    type: "gauge",
    scope: "global",
    help: "전역. 최근 24시간 시도 수(한도에서 멈춘 값)와 점유 중 수의 합. 점유 중 수를 더하므로 한도를 넘을 수 있고 limit 대비 비율이 1을 넘을 수 있다. 할당을 설정한 호출처만.",
    labels: { caller_id: caller },
  },
  {
    name: "mailo_send_paused_accounts",
    type: "gauge",
    scope: "global",
    help: "전역. 발송을 정지한 계정 수. 구성에 없는 계정의 정지도 센다.",
    labels: {},
  },
  {
    name: "mailo_account_paused",
    type: "gauge",
    scope: "global",
    help: "전역. 구성한 계정별 발송 정지 여부(0 또는 1).",
    labels: { account_id: account },
  },
  {
    name: "mailo_account_quota_limit",
    type: "gauge",
    scope: "global",
    help: "전역. 계정의 24시간 발송 할당(sendQuota24h). 설정한 계정만. 이 인스턴스의 계정 구성 값이다.",
    labels: { account_id: account },
  },
  {
    name: "mailo_account_quota_used",
    type: "gauge",
    scope: "global",
    help: "전역. 계정의 최근 24시간 시도 수(한도에서 멈춘 값)와 점유 중 수의 합. 점유 중 수를 더하므로 한도를 넘을 수 있고 limit 대비 비율이 1을 넘을 수 있다. 할당을 설정한 계정만.",
    labels: { account_id: account },
  },
  {
    name: "mailo_caller_latest_event_age_seconds",
    type: "gauge",
    scope: "global",
    help: "전역. 호출처 피드에 보이는 최신 이벤트의 경과 초. 이벤트가 없으면 시리즈가 없다. 소비 지연이 아니다.",
    labels: { caller_id: caller },
  },
  {
    name: "mailo_ops_audit_rows",
    type: "gauge",
    scope: "global",
    help: "전역. 운영 감사 테이블의 행 수. 100000에서 멈춘다.",
    labels: {},
  },
  {
    name: "mailo_ops_audit_rows_truncated",
    type: "gauge",
    scope: "global",
    help: "전역. 1이면 감사 행 수가 상한(100000)에 닿았다.",
    labels: {},
  },
  {
    name: "mailo_ops_audit_oldest_age_seconds",
    type: "gauge",
    scope: "global",
    help: "전역. 가장 오래된 감사 행의 경과 초. 행이 없으면 0이다.",
    labels: {},
  },
  // --- 인스턴스 counter(메모리, 재시작하면 0, 결정 4) -------------------------
  {
    name: "mailo_attempts_total",
    type: "counter",
    scope: "instance",
    help: "인스턴스. 이 프로세스가 기록한 시도 결과 수. LEASE_LOST로 버린 결과는 세지 않는다.",
    seed: true,
    labels: {
      caller_id: caller,
      account_id: account,
      result: oneOf(["sent", "transient", "permanent", "account", "internal"]),
    },
  },
  {
    name: "mailo_attempt_errors_total",
    type: "counter",
    scope: "instance",
    help: "인스턴스. 이 프로세스가 기록한 실패 시도의 분류별 수. reason은 result가 account일 때만 none이 아니다.",
    labels: {
      account_id: account,
      result: oneOf(["transient", "permanent", "account", "internal"]),
      stage: oneOf(
        [
          "conn",
          "tls",
          "auth",
          "mail_from",
          "rcpt",
          "data",
          "worker",
          "unknown",
        ],
        "unknown",
      ),
      reason: oneOf(
        [
          "none",
          "daily_limit",
          "rate_limit",
          "connection",
          "tls",
          "auth",
          "other",
        ],
        "other",
      ),
    },
  },
  {
    name: "mailo_jobs_finished_total",
    type: "counter",
    scope: "instance",
    help: "인스턴스. 이 프로세스가 커밋한 종결 전이 수(결과 기록, 만료 sweep, lease 복구, 취소).",
    seed: true,
    labels: {
      caller_id: caller,
      account_id: account,
      status: oneOf(["sent", "failed", "expired", "canceled"]),
    },
  },
  {
    name: "mailo_claim_polls_total",
    type: "counter",
    scope: "instance",
    help: "인스턴스. 점유 루프의 claim 호출 수.",
    seed: true,
    labels: { result: oneOf(["claimed", "empty", "error"]) },
  },
  {
    name: "mailo_claimed_jobs_total",
    type: "counter",
    scope: "instance",
    help: "인스턴스. 이 프로세스가 점유한 작업 수.",
    seed: true,
    labels: { caller_id: caller, account_id: account },
  },
  {
    name: "mailo_lease_recovered_total",
    type: "counter",
    scope: "instance",
    help: "인스턴스. 이 프로세스가 lease 만료로 회수한 작업 수. 중복 발송 가능성의 신호다.",
    seed: true,
    labels: { account_id: account },
  },
  {
    name: "mailo_file_channel_files_total",
    type: "counter",
    scope: "instance",
    help: "인스턴스. 파일 채널이 처리한 파일 수.",
    labels: {
      caller_id: caller,
      result: oneOf([
        "registered",
        "duplicate",
        "rejected",
        "unreadable",
        "delete_failed",
      ]),
    },
  },
  {
    name: "mailo_event_cursor_gap_total",
    type: "counter",
    scope: "instance",
    help: "인스턴스. 이벤트 피드 cursor 공백을 감지한 요청 수.",
    seed: true,
    labels: { caller_id: caller },
  },
  {
    name: "mailo_metrics_dropped_samples_total",
    type: "counter",
    scope: "instance",
    help: "인스턴스. 시리즈 상한이나 값 검증 때문에 버린 증가 수.",
    labels: {},
  },
  // --- 인스턴스 gauge ----------------------------------------------------------
  {
    name: "mailo_worker_state",
    type: "gauge",
    scope: "instance",
    help: "인스턴스. Worker의 현재 상태 시리즈만 1이다(원핫).",
    labels: {
      state: oneOf([
        "disabled",
        "idle",
        "running",
        "paused",
        "stopping",
        "stopped",
      ]),
    },
  },
  {
    name: "mailo_worker_in_flight_jobs",
    type: "gauge",
    scope: "instance",
    help: "인스턴스. 진행 중인 전송 수. Worker가 꺼져 있으면 시리즈가 없다.",
    labels: {},
  },
  {
    name: "mailo_worker_in_flight",
    type: "gauge",
    scope: "instance",
    help: "인스턴스. 계정별 진행 중인 전송 수. 구성한 계정마다 시리즈가 있다. Worker가 꺼져 있으면 시리즈가 없다.",
    labels: { account_id: account },
  },
  {
    name: "mailo_worker_last_poll_age_seconds",
    type: "gauge",
    scope: "instance",
    help: "인스턴스. 점유 루프가 마지막으로 돈 뒤 경과 초. 아직 안 돌았으면 시리즈가 없다.",
    labels: {},
  },
  {
    name: "mailo_worker_claim_failure_streak",
    type: "gauge",
    scope: "instance",
    help: "인스턴스. 연속 점유 실패 수.",
    labels: {},
  },
  {
    name: "mailo_worker_poll_loop_crashed",
    type: "gauge",
    scope: "instance",
    help: "인스턴스. 1이면 점유 루프가 죽어 프로세스가 종료 코드 70으로 끝나는 중이다.",
    labels: {},
  },
  {
    name: "mailo_file_poller_enabled",
    type: "gauge",
    scope: "instance",
    help: "인스턴스. 파일 채널이 켜져 있으면 1.",
    labels: {},
  },
  {
    name: "mailo_file_poller_running",
    type: "gauge",
    scope: "instance",
    help: "인스턴스. 파일 폴러가 동작 중이면 1. 꺼져 있으면 0이다.",
    labels: {},
  },
  {
    name: "mailo_file_poller_callers",
    type: "gauge",
    scope: "instance",
    help: "인스턴스. 폴링 대상 호출처 수.",
    labels: {},
  },
  {
    name: "mailo_file_poller_last_poll_age_seconds",
    type: "gauge",
    scope: "instance",
    help: "인스턴스. 마지막 폴링이 끝난 뒤 경과 초. 아직 안 돌았으면 시리즈가 없다.",
    labels: {},
  },
  {
    name: "mailo_file_poller_last_poll_ok",
    type: "gauge",
    scope: "instance",
    help: "인스턴스. 마지막 폴링이 오류 없이 끝났으면 1. 아직 안 돌았으면 시리즈가 없다.",
    labels: {},
  },
  {
    name: "mailo_metrics_collect_ok",
    type: "gauge",
    scope: "instance",
    help: "인스턴스. 이 인스턴스의 마지막 DB 수집에서 그룹이 성공했으면 1. 0이면 그 그룹의 전역 지표가 응답에 없다.",
    labels: {
      group: oneOf(["queue", "breaker", "controls", "quota", "feed", "audit"]),
    },
  },
  {
    name: "mailo_metrics_snapshot_age_seconds",
    type: "gauge",
    scope: "instance",
    help: "인스턴스. 캐시된 DB 수집이 끝난 뒤 경과 초.",
    labels: {},
  },
  // --- 프로세스(Prometheus 관례 이름) ------------------------------------------
  {
    name: "process_start_time_seconds",
    type: "gauge",
    scope: "process",
    help: "인스턴스. 프로세스 시작 시각(Unix 초). 바뀌면 재시작이다.",
    labels: {},
  },
  {
    name: "process_resident_memory_bytes",
    type: "gauge",
    scope: "process",
    help: "인스턴스. 프로세스 상주 메모리(바이트).",
    labels: {},
  },
  {
    name: "process_cpu_seconds_total",
    type: "counter",
    scope: "process",
    help: "인스턴스. 프로세스의 사용자·시스템 CPU 시간 합(초).",
    labels: {},
  },
] as const satisfies readonly MetricDef[];

export type MetricName = (typeof CATALOG)[number]["name"];
/** `AppMetrics.inc`에 쓸 수 있는 이름. 컴파일 때 gauge 이름을 막는다. */
export type CounterName = Extract<
  (typeof CATALOG)[number],
  { type: "counter" }
>["name"];

export const METRICS: readonly MetricDef[] = CATALOG;

/**
 * 카탈로그가 규칙을 지키는지 검사한다. 라벨 이름이 허용 목록 밖이면 던진다(결정 6, 기동 때 부른다).
 * 이름·종류·접두 규칙은 단위 테스트(`test/metrics/catalog.spec.ts`)가 건다.
 */
export function assertCatalog(defs: readonly MetricDef[]): void {
  const allowed: readonly string[] = ALLOWED_LABELS;
  for (const def of defs)
    for (const label of Object.keys(def.labels))
      if (!allowed.includes(label))
        throw new Error(
          `지표 ${def.name}의 라벨 ${label}은 허용 목록에 없다(ADR-0012 결정 6)`,
        );
}

const BY_NAME: ReadonlyMap<string, MetricDef> = new Map(
  METRICS.map((m) => [m.name, m]),
);

/** 이름으로 정의를 찾는다. 없으면 undefined다. */
export function findMetric(name: string): MetricDef | undefined {
  return BY_NAME.get(name);
}
