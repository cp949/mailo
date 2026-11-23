/**
 * SMTP 실패 분류(ADR-0007, RQ-009). 순수 함수와 매핑 표만 둔다.
 *
 * 분류 결과는 세 종류다.
 * - ACCOUNT: 계정 상태 오류. 시도 횟수에 넣지 않고 전역 차단기로 처리한다.
 * - TRANSIENT: 메시지 오류 중 다시 시도하면 성공할 수 있는 것.
 * - PERMANENT: 메시지 오류 중 같은 요청을 다시 보내도 실패하는 것.
 *
 * 근거 표기(RuleSource)
 * - GOOGLE_DOC: 2026-11-23에 Google Workspace 문서
 *   (https://support.google.com/a/answer/3726730, /6140680)를 가져와 확인한 항목이다.
 *   원문 전체를 대조한 것이 아니라 가져온 페이지를 요약 도구로 읽은 결과다.
 *   문서의 URL은 knowledge.workspace.google.com으로 리다이렉트된다.
 * - ADR_0007: ADR이 직접 정한 규칙이다. 원출처는 ADR-0003·0007에 따른다.
 * - ASSUMED(추정): 문서로 확인하지 못했다. 일반 지식이나 안전 쪽 판단이다.
 *
 * 응답 텍스트는 분류 입력으로만 쓰고, 분류 결과에는 넣지 않는다(RQ-027: 수신자 주소가
 * 텍스트에 들어갈 수 있다. 마스킹 방식은 ADR-0003 미결정).
 */

export type SmtpStage = "CONN" | "TLS" | "AUTH" | "MAIL_FROM" | "RCPT" | "DATA";

/** 서버 응답 없이 전송 계층에서 끊긴 경우. */
export type TransportFault = "TIMEOUT" | "DISCONNECT";

/** 어댑터(nodemailer-adapter.ts)가 만드는 라이브러리 비의존 입력. */
export interface SmtpFailure {
  stage: SmtpStage;
  /** 3자리 SMTP 응답 코드. 서버 응답이 없으면 없다. */
  responseCode?: number;
  /** 예: "5.4.5". */
  enhancedStatus?: string;
  /** 서버 응답 텍스트. 분류 판정에만 쓴다. */
  responseText?: string;
  transportFault?: TransportFault;
}

/** 차단기 사유. 사유별 초기 대기는 ACCOUNT_REASON_POLICY에 있다. */
export type AccountReason = "GENERAL" | "DAILY_LIMIT" | "BURST_LIMIT";

export type Classification =
  | { kind: "ACCOUNT"; reason: AccountReason; rule: string }
  | { kind: "TRANSIENT"; rule: string }
  | { kind: "PERMANENT"; rule: string };

export type RuleSource = "GOOGLE_DOC" | "ADR_0007" | "ASSUMED";

export interface AccountReasonPolicy {
  initialOpenSeconds: number;
  maxOpenSeconds: number;
  /** true이면 연속 실패 임계값(3회)을 기다리지 않고 즉시 open이다(RQ-009). */
  opensImmediately: boolean;
}

/**
 * 사유별 open 대기(ADR-0007 결정 4·5, RQ-009). 수치는 모두 추정이다.
 * 상한은 max(30분, 초기값)이다. 일일 한도는 초기값 1시간이 더 커서 1시간 고정이다.
 */
export const ACCOUNT_REASON_POLICY: Readonly<
  Record<AccountReason, AccountReasonPolicy>
> = {
  GENERAL: {
    initialOpenSeconds: 60,
    maxOpenSeconds: 30 * 60,
    opensImmediately: false,
  },
  BURST_LIMIT: {
    initialOpenSeconds: 5 * 60,
    maxOpenSeconds: 30 * 60,
    opensImmediately: true,
  },
  DAILY_LIMIT: {
    initialOpenSeconds: 60 * 60,
    maxOpenSeconds: 60 * 60,
    opensImmediately: true,
  },
};

/**
 * open 대기 시간. 대표 작업이 실패할 때마다 2배로 늘린다(ADR-0007 결정 5).
 * @param probeFailures 대표 작업이 이미 실패한 횟수. 처음 open이면 0.
 */
export function accountOpenSeconds(
  reason: AccountReason,
  probeFailures: number,
): number {
  const policy = ACCOUNT_REASON_POLICY[reason];
  const failures = Math.max(0, Math.floor(probeFailures));
  // 지수가 커져도 Infinity가 되지 않도록 상한을 먼저 쓴다.
  const doubled =
    failures >= 32
      ? policy.maxOpenSeconds
      : policy.initialOpenSeconds * 2 ** failures;
  return Math.min(policy.maxOpenSeconds, doubled);
}

/** 같은 작업이 차단기를 이 횟수만큼 연 뒤에도 같은 응답을 받으면 PERMANENT다(3회는 추정). */
export const ACCOUNT_TRIPS_LIMIT = 3;

const MESSAGE_STAGES: ReadonlySet<SmtpStage> = new Set([
  "MAIL_FROM",
  "RCPT",
  "DATA",
]);

export function isMessageStage(stage: SmtpStage): boolean {
  return MESSAGE_STAGES.has(stage);
}

/**
 * `account_trips` 예외(ADR-0007 결정 4). `MAIL FROM` 이후 단계의 계정 상태 오류만 센다.
 * 같은 응답인지 비교하는 일은 호출하는 쪽(queue)이 한다.
 * @param previousTrips 이 작업이 이미 차단기를 연 횟수.
 */
export function shouldPromoteToPermanent(
  stage: SmtpStage,
  previousTrips: number,
): boolean {
  return isMessageStage(stage) && previousTrips >= ACCOUNT_TRIPS_LIMIT;
}

type Outcome =
  | { kind: "ACCOUNT"; reason: AccountReason }
  | { kind: "TRANSIENT" }
  | { kind: "PERMANENT" };

interface Rule {
  id: string;
  source: RuleSource;
  /** 표에 남기는 근거. 응답 원문 일부와 출처 설명이다. */
  note: string;
  when: (f: Normalized) => boolean;
  outcome: Outcome;
}

interface Normalized {
  stage: SmtpStage;
  message: boolean;
  code: number | undefined;
  enhanced: string | undefined;
  /** 소문자 응답 텍스트. */
  text: string;
  transportFault: TransportFault | undefined;
}

const DAILY_TEXT = /\bdaily\b[^\n]*\b(limit|quota)\b/;
const PEAK_RELAY_TEXT = /peak smtp relay limit/;
const RATE_LIMITED_TEXT = /\brate limited\b/;
// 수신자 쪽 수신 속도 제한. 계정 한도가 아니다.
const RECIPIENT_THROTTLE_TEXT =
  /(user you are trying to contact|receiving (e-?mail|mail) (too quickly|at a rate))/;
// 인증·구성 문제를 가리키는 텍스트(ADR-0007 배경: STARTTLS 필요, 앱 비밀번호, 웹 로그인).
const AUTH_CONFIG_TEXT =
  /(starttls|application-specific password|log in (through|with) your web browser|authentication required|invalid credentials for relay|mail relay denied|not authorized to send email directly)/;
// 550 5.7.1 중 메시지 자체에 대한 거부로 확인된 텍스트.
const MESSAGE_POLICY_TEXT =
  /(likely unsolicited|policy that prohibits|missing a valid message-id|from: header is missing)/;

/**
 * 매핑 표. 위에서 아래로 처음 맞는 규칙을 쓴다. 순서가 의미를 가진다.
 * 한도 초과는 단계와 무관하게 계정 상태 오류다(ADR-0007 결정 4).
 */
export const CLASSIFICATION_RULES: readonly Rule[] = [
  {
    id: "RECIPIENT_THROTTLE_450_4_2_1",
    source: "GOOGLE_DOC",
    note: '450 4.2.1 "The user you are trying to contact is receiving email too quickly." 수신자 쪽 제한이므로 계정 한도 규칙보다 먼저 판정한다.',
    when: (f) =>
      f.message &&
      f.code === 450 &&
      f.enhanced === "4.2.1" &&
      RECIPIENT_THROTTLE_TEXT.test(f.text),
    outcome: { kind: "TRANSIENT" },
  },
  {
    id: "DAILY_LIMIT_550_5_4_5",
    source: "GOOGLE_DOC",
    note: '550 5.4.5 "Daily user sending limit exceeded." / "Daily SMTP relay limit exceeded for user." 24시간 rolling이다(ADR-0003 배경).',
    when: (f) => f.code === 550 && f.enhanced === "5.4.5",
    outcome: { kind: "ACCOUNT", reason: "DAILY_LIMIT" },
  },
  {
    id: "DAILY_LIMIT_TEXT",
    source: "GOOGLE_DOC",
    note: '550 5.7.1 "Daily SMTP relay sending limit exceeded for this customer." 같은 코드가 다른 원인에도 쓰이므로 텍스트로 구분한다(ADR-0007 결정 4).',
    when: (f) => DAILY_TEXT.test(f.text),
    outcome: { kind: "ACCOUNT", reason: "DAILY_LIMIT" },
  },
  {
    id: "BURST_LIMIT_PEAK_RELAY",
    source: "GOOGLE_DOC",
    note: '450 4.2.1 "Peak SMTP relay limit exceeded for this customer." relay 순간 한도다.',
    when: (f) => PEAK_RELAY_TEXT.test(f.text),
    outcome: { kind: "ACCOUNT", reason: "BURST_LIMIT" },
  },
  {
    id: "BURST_LIMIT_450_4_2_1",
    source: "ADR_0007",
    note: "450 4.2.1은 relay 순간 한도 예시다(ADR-0007 결정 4). 수신자 쪽 제한 텍스트는 위 규칙이 먼저 걸러낸다. 텍스트가 없으면 이 규칙이 적용된다(추정: 안전한 쪽).",
    when: (f) => f.code === 450 && f.enhanced === "4.2.1",
    outcome: { kind: "ACCOUNT", reason: "BURST_LIMIT" },
  },
  {
    id: "BURST_LIMIT_421_4_7_0_OR_4_4_5",
    source: "ADR_0007",
    note: "421 4.7.0, 421 4.4.5는 순간 한도 예시다(ADR-0007 결정 4). 문서에서 421 4.4.5는 서버 과부하 재시도 항목이다.",
    when: (f) =>
      f.code === 421 && (f.enhanced === "4.7.0" || f.enhanced === "4.4.5"),
    outcome: { kind: "ACCOUNT", reason: "BURST_LIMIT" },
  },
  {
    id: "BURST_LIMIT_421_4_7_X",
    source: "ASSUMED",
    note: '421 4.7.26~4.7.40 "...has been rate limited because..." 계열은 문서에 rate limit으로 적혀 있으나 ADR의 예시 목록에는 없다. 순간 한도로 본다(추정).',
    when: (f) => f.code === 421 && (f.enhanced?.startsWith("4.7.") ?? false),
    outcome: { kind: "ACCOUNT", reason: "BURST_LIMIT" },
  },
  {
    id: "BURST_LIMIT_550_5_7_1_RATE_LIMITED",
    source: "GOOGLE_DOC",
    note: '550 5.7.1 "This email has been rate limited." 5xx이지만 속도 제한이다.',
    when: (f) =>
      f.code === 550 &&
      f.enhanced === "5.7.1" &&
      RATE_LIMITED_TEXT.test(f.text),
    outcome: { kind: "ACCOUNT", reason: "BURST_LIMIT" },
  },
  {
    id: "ACCOUNT_421_OTHER",
    source: "ASSUMED",
    note: "421은 RFC 5321에서 서버가 전송 채널을 닫는다는 뜻이다. 한도 코드가 아닌 421도 연결 수준 문제로 보고 계정 상태 오류로 둔다(추정).",
    when: (f) => f.code === 421,
    outcome: { kind: "ACCOUNT", reason: "GENERAL" },
  },
  {
    id: "ACCOUNT_STAGE_CONN_TLS_AUTH",
    source: "ADR_0007",
    note: "연결(CONN), TLS, 인증(AUTH) 단계 실패는 모두 계정 상태 오류다(ADR-0007 결정 1). 454 4.7.0, 535 포함.",
    when: (f) => !f.message,
    outcome: { kind: "ACCOUNT", reason: "GENERAL" },
  },
  {
    id: "ACCOUNT_AUTH_CODE",
    source: "GOOGLE_DOC",
    note: '인증·TLS 요구 코드는 단계와 무관하게 계정 상태 오류다. 530 5.7.0 "Authentication required." / "Must issue a STARTTLS command first.", 534 5.7.14·5.7.90 앱 비밀번호·웹 로그인, 535 5.7.x 자격 거부, 454 4.7.0 로그인 시도 과다. 538·432는 RFC 4954·3207 기준(추정).',
    when: (f) =>
      f.code !== undefined && [454, 530, 534, 535, 538, 432].includes(f.code),
    outcome: { kind: "ACCOUNT", reason: "GENERAL" },
  },
  {
    id: "ACCOUNT_AUTH_CONFIG_TEXT",
    source: "GOOGLE_DOC",
    note: '550 5.7.1 "Invalid credentials for relay", "IP ... not authorized to send email directly" 등은 relay 자격·구성 오류다. 텍스트 패턴으로 판정한다.',
    when: (f) => AUTH_CONFIG_TEXT.test(f.text),
    outcome: { kind: "ACCOUNT", reason: "GENERAL" },
  },
  {
    id: "PERMANENT_5_7_1_MESSAGE_POLICY",
    source: "GOOGLE_DOC",
    note: '550 5.7.1 "likely unsolicited", "policy that prohibits", Message-ID·From 누락은 메시지 자체의 거부다. 같은 코드의 계정 오류와 텍스트로 구분한다(ADR-0007 결정 4).',
    when: (f) =>
      f.code === 550 &&
      f.enhanced === "5.7.1" &&
      MESSAGE_POLICY_TEXT.test(f.text),
    outcome: { kind: "PERMANENT" },
  },
  {
    id: "ACCOUNT_5_7_1_UNRECOGNIZED",
    source: "ADR_0007",
    note: "550 5.7.1을 텍스트로 구분할 수 없으면 계정 상태 오류로 둔다(ADR-0007 결정 4, 안전한 쪽). 메시지 거부였다면 account_trips가 3회 뒤 FAILED로 만든다.",
    when: (f) => f.code === 550 && f.enhanced === "5.7.1",
    outcome: { kind: "ACCOUNT", reason: "GENERAL" },
  },
  {
    id: "TRANSIENT_DATA_TRANSPORT_FAULT",
    source: "ADR_0007",
    note: "DATA 단계의 타임아웃·연결 끊김은 TRANSIENT다. 서버가 수락했을 수 있어 중복 발송이 생길 수 있다(ADR-0007 결정 3, RQ-013).",
    when: (f) =>
      f.stage === "DATA" &&
      f.code === undefined &&
      f.transportFault !== undefined,
    outcome: { kind: "TRANSIENT" },
  },
  {
    id: "ACCOUNT_PRE_DATA_TRANSPORT_FAULT",
    source: "ADR_0007",
    note: "MAIL FROM·RCPT 단계의 타임아웃·연결 끊김은 계정 상태 오류다(ADR-0003 결정 7 유지분).",
    when: (f) =>
      f.message && f.code === undefined && f.transportFault !== undefined,
    outcome: { kind: "ACCOUNT", reason: "GENERAL" },
  },
  {
    id: "TRANSIENT_4XX",
    source: "ADR_0007",
    note: "메시지 단계의 4xx 기본 규칙(ADR-0007 결정 3). 예: 452 4.5.3, 452 4.2.2, 451 4.3.0.",
    when: (f) => f.code !== undefined && f.code >= 400 && f.code < 500,
    outcome: { kind: "TRANSIENT" },
  },
  {
    id: "PERMANENT_5XX",
    source: "ADR_0007",
    note: "메시지 단계의 5xx 기본 규칙(ADR-0007 결정 3). 예: 550 5.1.1, 552 5.3.4, 553 5.1.2, 554 5.6.0.",
    when: (f) => f.code !== undefined && f.code >= 500 && f.code < 600,
    outcome: { kind: "PERMANENT" },
  },
];

const UNKNOWN_RULE_ID = "TRANSIENT_UNKNOWN_FALLBACK";

function normalize(f: SmtpFailure): Normalized {
  return {
    stage: f.stage,
    message: isMessageStage(f.stage),
    code: f.responseCode,
    enhanced: f.enhancedStatus,
    text: (f.responseText ?? "").toLowerCase(),
    transportFault: f.transportFault,
  };
}

/**
 * SMTP 실패 한 건을 분류한다. 외부 상태를 읽지 않는 순수 함수다.
 * 규칙에 맞지 않는 경우(코드 없는 메시지 단계 오류, 2xx·3xx 등)는 TRANSIENT다.
 * 시도 횟수와 만료가 재시도를 제한하므로 안전한 쪽이다(추정).
 */
export function classifySmtpFailure(failure: SmtpFailure): Classification {
  const n = normalize(failure);
  for (const rule of CLASSIFICATION_RULES) {
    if (!rule.when(n)) continue;
    if (rule.outcome.kind === "ACCOUNT") {
      return { kind: "ACCOUNT", reason: rule.outcome.reason, rule: rule.id };
    }
    return { kind: rule.outcome.kind, rule: rule.id };
  }
  return { kind: "TRANSIENT", rule: UNKNOWN_RULE_ID };
}

/** 수신자 한 명에 대한 RCPT 결과. */
export interface RecipientResult {
  address: string;
  accepted: boolean;
  /** 거부된 경우의 응답. */
  responseCode?: number;
  enhancedStatus?: string;
  responseText?: string;
  transportFault?: TransportFault;
}

export interface RejectedRecipient {
  address: string;
  responseCode?: number;
  enhancedStatus?: string;
  responseText?: string;
}

export type RecipientOutcome =
  | { kind: "SENT"; rejectedRecipients: RejectedRecipient[] }
  | { kind: "ACCOUNT"; reason: AccountReason; rule: string }
  | { kind: "TRANSIENT"; rule: string }
  | { kind: "PERMANENT"; rule: string };

/** 같은 ACCOUNT 사유가 여럿이면 대기가 긴 쪽을 택한다. */
const REASON_RANK: Record<AccountReason, number> = {
  GENERAL: 0,
  BURST_LIMIT: 1,
  DAILY_LIMIT: 2,
};

export class RecipientResultError extends Error {
  readonly code = "NO_RECIPIENT_RESULTS";
  constructor() {
    super("recipient results are empty (code=NO_RECIPIENT_RESULTS)");
    this.name = "RecipientResultError";
  }
}

/**
 * 수신자별 결과로 작업 결과를 정한다(ADR-0007 결정 7, RQ-009·016).
 * - 한 명이라도 수락되면 SENT. 거부된 수신자는 rejectedRecipients에 남기고 재시도하지 않는다.
 * - 전원 거부이면 하나라도 4xx(TRANSIENT)면 TRANSIENT, 모두 5xx(PERMANENT)면 PERMANENT다.
 * - 거부 응답 중 계정 상태 오류(예: 550 5.4.5 한도)가 있으면 ACCOUNT가 우선한다.
 *   한도는 단계와 무관하게 계정 상태 오류이므로 PERMANENT로 확정하면 안 된다(ADR-0007 결정 4).
 *   이 우선순위는 ADR에 명시가 없어 코드에서 정했다(추정).
 */
export function resolveRecipientOutcome(
  results: readonly RecipientResult[],
): RecipientOutcome {
  if (results.length === 0) throw new RecipientResultError();

  const rejected = results.filter((r) => !r.accepted);
  if (rejected.length < results.length) {
    return {
      kind: "SENT",
      rejectedRecipients: rejected.map((r) => ({
        address: r.address,
        ...(r.responseCode !== undefined && { responseCode: r.responseCode }),
        ...(r.enhancedStatus !== undefined && {
          enhancedStatus: r.enhancedStatus,
        }),
        ...(r.responseText !== undefined && { responseText: r.responseText }),
      })),
    };
  }

  const classes = rejected.map((r) =>
    classifySmtpFailure({
      stage: "RCPT",
      ...(r.responseCode !== undefined && { responseCode: r.responseCode }),
      ...(r.enhancedStatus !== undefined && {
        enhancedStatus: r.enhancedStatus,
      }),
      ...(r.responseText !== undefined && { responseText: r.responseText }),
      ...(r.transportFault !== undefined && {
        transportFault: r.transportFault,
      }),
    }),
  );

  let account: Extract<Classification, { kind: "ACCOUNT" }> | undefined;
  for (const c of classes) {
    if (
      c.kind === "ACCOUNT" &&
      (!account || REASON_RANK[c.reason] > REASON_RANK[account.reason])
    ) {
      account = c;
    }
  }
  if (account) return account;

  const transient = classes.find((c) => c.kind === "TRANSIENT");
  if (transient) return { kind: "TRANSIENT", rule: transient.rule };
  return { kind: "PERMANENT", rule: classes[0]!.rule };
}
