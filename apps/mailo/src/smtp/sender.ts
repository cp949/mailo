/**
 * nodemailer 기반 SMTP 발송기(ADR-0007 결정 8·9, ADR-0002 결정 11, RQ-005·006·013·016).
 *
 * 이 파일이 하는 일
 * - 연결 옵션을 만든다. 587 STARTTLS 필수가 기본이고 465 implicit TLS는 설정으로 고른다.
 *   인증서 검증을 끄는 옵션, 평문 허용 옵션, TLS 1.2 미만 허용 옵션이 없다(RQ-005).
 * - 타임아웃을 명시한다. nodemailer 기본값(연결 2분, greeting 30초, 소켓 10분)에 의존하지 않는다.
 *   소켓 타임아웃은 "무응답 시간"이라 서버가 조금씩 응답하면 합이 늘어날 수 있으므로,
 *   발송 한 건에 AbortSignal 전체 마감(`totalMs`)을 따로 건다. lease는 이 마감보다 길어야 한다
 *   (`checkSmtpTimeouts`가 기동 시 검증한다).
 * - 고정 Message-ID를 쓴다(ADR-0007 결정 8).
 * - 결과를 분류까지 마쳐서 돌려준다. 오류 객체는 기존 어댑터(nodemailer-adapter.ts)가 읽고
 *   classify.ts가 분류한다. 이 파일은 분류 규칙을 갖지 않는다.
 *
 * 실측으로 확인한 nodemailer 10.6.1 동작(자세한 필드는 nodemailer-adapter.ts 머리말)
 * - 전송 계층 오류의 `command`는 항상 "CONN"이다. 어느 단계에서 끊겼는지는 오류만으로 알 수 없어
 *   StageTracker가 SMTP 명령·응답 로그를 보고 "응답을 기다리던 가장 오래된 명령"을 추적한다.
 *   DATA 단계의 타임아웃·끊김은 TRANSIENT(수락 여부 불명, RQ-013), 그 앞 단계는 계정 상태 오류이므로
 *   이 구분이 분류 결과를 바꾼다.
 * - 이 로그 훅은 단계 추적에만 쓰며 내용(주소·본문·자격 증명)을 보관하지 않는다.
 *
 * 응답 텍스트 처리(RQ-027, ADR-0003 미확정 "응답 텍스트의 수신자 주소")
 * - 분류는 원문으로 하고, 결과에 담는 텍스트는 이메일 주소 형태를 `[address]`로 가리고 500자로 자른다.
 *   서버가 수신자 주소를 응답에 되풀이하는 경우(예: "550 5.1.1 <user@x> ...")가 있기 때문이다.
 *   마스킹 방식은 ADR에 정해져 있지 않아 여기서 정했다(추정).
 * - `rejectedRecipients`의 주소는 RQ-016이 요구하는 값이라 그대로 둔다.
 */
import { createTransport } from "nodemailer";
import type { SMTPTransportOptions } from "nodemailer";
import {
  classifySmtpFailure,
  resolveRecipientOutcome,
  type AccountReason,
  type RecipientOutcome,
  type RejectedRecipient,
  type SmtpStage,
} from "./classify.js";
import {
  adaptNodemailerError,
  adaptNodemailerRejectedError,
  adaptNodemailerSendInfo,
} from "./nodemailer-adapter.js";
import { maskEmailLike } from "./email-pattern.js";
import { buildMessageId } from "./message-id.js";

export type TlsMode = "STARTTLS" | "IMPLICIT";

export interface SmtpTimeouts {
  /** TCP 연결 수립 대기. */
  connectionMs: number;
  /** 연결 뒤 서버 인사(220) 대기. */
  greetingMs: number;
  /** 소켓 무응답 대기. 응답이 올 때마다 새로 센다. */
  socketMs: number;
  /** DNS 조회 대기. */
  dnsMs: number;
  /** 발송 한 건의 전체 마감. 모든 단계를 합쳐도 이 시간을 넘기지 않는다. */
  totalMs: number;
}

/** 모두 추정이다. lease 기본 120초(MAILO_LEASE_SECONDS)보다 짧게 잡았다. */
export const DEFAULT_SMTP_TIMEOUTS: SmtpTimeouts = {
  connectionMs: 10_000,
  greetingMs: 10_000,
  socketMs: 30_000,
  dnsMs: 10_000,
  totalMs: 90_000,
};

/** lease 만료와 결과 기록 사이에 두는 여유(추정). */
export const DEFAULT_LEASE_MARGIN_MS = 10_000;

export class SmtpConfigError extends Error {
  constructor(
    readonly code:
      | "INVALID_TIMEOUT"
      | "TIMEOUT_EXCEEDS_LEASE"
      | "INVALID_CONNECTION",
  ) {
    super(`invalid smtp config (code=${code})`);
    this.name = "SmtpConfigError";
  }
}

/**
 * 타임아웃이 lease 안에 들어가는지 기동 시 검증한다(ADR-0002 결정 11).
 * 발송 한 건의 상한은 `totalMs`이므로 `totalMs + margin <= lease`여야 한다. 그러지 않으면
 * 전송 중에 lease가 만료돼 다른 Worker가 같은 작업을 회수하고 중복 발송이 생긴다.
 * 단계별 타임아웃의 합도 ADR의 기준(연결·greeting·소켓의 합 + 여유 <= lease)을 같이 확인한다.
 */
export function checkSmtpTimeouts(
  timeouts: SmtpTimeouts,
  leaseSeconds: number,
  marginMs: number = DEFAULT_LEASE_MARGIN_MS,
): void {
  const values = [
    timeouts.connectionMs,
    timeouts.greetingMs,
    timeouts.socketMs,
    timeouts.dnsMs,
    timeouts.totalMs,
    leaseSeconds,
    marginMs,
  ];
  if (!values.every((v) => Number.isFinite(v) && v > 0))
    throw new SmtpConfigError("INVALID_TIMEOUT");
  const leaseMs = leaseSeconds * 1000;
  const phaseSum =
    timeouts.connectionMs + timeouts.greetingMs + timeouts.socketMs;
  if (timeouts.totalMs + marginMs > leaseMs || phaseSum + marginMs > leaseMs) {
    throw new SmtpConfigError("TIMEOUT_EXCEEDS_LEASE");
  }
}

export interface SmtpSenderConfig {
  host: string;
  port: number;
  /** 기본은 STARTTLS(587). IMPLICIT는 465 implicit TLS다. */
  tlsMode: TlsMode;
  auth?: { user: string; pass: string };
  timeouts: SmtpTimeouts;
  /**
   * 기본 신뢰 저장소 대신 신뢰할 CA(PEM). 사설 relay나 테스트 서버용이다.
   * 검증을 끄는 옵션이 아니다. 인증서 검증과 호스트명 검사는 항상 켜져 있다.
   */
  trustedCa?: string | Buffer | Array<string | Buffer>;
  /** EHLO에 보내는 이름. 생략하면 nodemailer 기본값이다. */
  clientName?: string;
  /** Message-ID 도메인으로 쓸 발신 계정 주소. 생략하면 메시지의 from을 쓴다(ADR-0007 결정 8). */
  accountAddress?: string;
}

export interface SmtpMessage {
  /** Message-ID를 유도하는 작업 ID. */
  jobId: string;
  from: string;
  replyTo?: string | null;
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  text: string | null;
  html: string | null;
}

/** 결과에 담는 단계별 정보. 텍스트는 마스킹·절단을 마친 값이다. */
export interface SmtpFailureDetail {
  stage: SmtpStage;
  responseCode?: number;
  enhancedStatus?: string;
  responseText?: string;
}

export type SmtpSendResult =
  | { kind: "SENT"; rejectedRecipients: RejectedRecipient[] }
  | {
      kind: "ACCOUNT";
      reason: AccountReason;
      rule: string;
      failure: SmtpFailureDetail;
    }
  | {
      kind: "TRANSIENT" | "PERMANENT";
      rule: string;
      failure: SmtpFailureDetail;
    };

export interface SendOptions {
  /** Worker 종료 대기 시간 초과 시 진행 중인 전송을 끊는다. 이때 `SmtpAbortedError`로 거부한다. */
  signal?: AbortSignal;
}

export interface MailSender {
  send(message: SmtpMessage, options?: SendOptions): Promise<SmtpSendResult>;
}

/** 호출자의 `signal`로 중단했다. 서버 수락 여부가 불명이므로 결과를 기록하지 않는 것이 맞다. */
export class SmtpAbortedError extends Error {
  readonly code = "ABORTED_BY_CALLER";
  constructor() {
    super("smtp send aborted by caller (code=ABORTED_BY_CALLER)");
    this.name = "SmtpAbortedError";
  }
}

/**
 * SMTP 오류가 아니라 Mailo 쪽 입력·구성 문제로 전송하지 못했다(예: 잘못된 Message-ID 도메인,
 * nodemailer가 만든 EENVELOPE(API), ECONFIG). 원문 메시지는 담지 않고 코드만 담는다.
 */
export class SmtpInternalError extends Error {
  constructor(readonly code: string) {
    super(`smtp send failed locally (code=${code})`);
    this.name = "SmtpInternalError";
  }
}

// ---------------------------------------------------------------------------
// 단계 추적

const CLIENT_LINE_STAGES: ReadonlyArray<readonly [RegExp, SmtpStage]> = [
  [/^MAIL FROM:/i, "MAIL_FROM"],
  [/^RCPT TO:/i, "RCPT"],
  [/^DATA$/i, "DATA"],
  [/^STARTTLS$/i, "TLS"],
  [/^AUTH\b/i, "AUTH"],
  [/^(EHLO|HELO|LHLO|QUIT|RSET|NOOP)\b/i, "CONN"],
];

/**
 * 응답을 기다리는 SMTP 명령의 단계를 추적한다. nodemailer의 transactionLog(`tnx: client|server`)만
 * 읽고 내용은 보관하지 않는다. PIPELINING이면 MAIL FROM·RCPT TO·DATA가 한꺼번에 나가므로
 * "응답을 아직 받지 못한 가장 오래된 명령"을 현재 단계로 본다.
 */
export class StageTracker {
  // 첫 항목은 서버 인사(220) 대기다.
  private readonly pending: SmtpStage[] = ["CONN"];
  private last: SmtpStage = "CONN";

  /** nodemailer 외부 logger 형태. debug 외 수준은 버린다. */
  readonly logger = {
    trace: noop,
    debug: (data: unknown, message?: unknown) => this.onLog(data, message),
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };

  /** 응답을 기다리는 가장 오래된 명령의 단계. 없으면 마지막으로 응답받은 단계다. */
  stage(): SmtpStage {
    return this.pending[0] ?? this.last;
  }

  private onLog(data: unknown, message: unknown): void {
    if (
      typeof data !== "object" ||
      data === null ||
      typeof message !== "string"
    )
      return;
    const tnx = (data as { tnx?: unknown }).tnx;
    if (tnx === "client") {
      this.pending.push(stageOfClientLine(message));
    } else if (tnx === "server") {
      const head = this.pending.shift();
      if (head !== undefined) this.last = head;
      // DATA에 354를 받으면 본문을 보내고 최종 응답을 기다린다. 그 대기도 DATA 단계다.
      if (head === "DATA" && message.startsWith("354"))
        this.pending.unshift("DATA");
    }
  }
}

function noop(): void {
  /* 로그를 남기지 않는다 */
}

function stageOfClientLine(line: string): SmtpStage {
  for (const [pattern, stage] of CLIENT_LINE_STAGES) {
    if (pattern.test(line)) return stage;
  }
  // AUTH LOGIN의 base64 사용자·비밀번호 줄처럼 명령 이름이 없는 줄은 인증 교환의 일부다.
  return "AUTH";
}

// ---------------------------------------------------------------------------
// 응답 텍스트 정리

const MAX_RESPONSE_TEXT = 500;

/** 이메일 주소 형태를 가리고 500자로 자른다. 정규식은 앞 4 KiB에만 적용한다(`maskEmailLike`). */
export function sanitizeResponseText(
  text: string | undefined,
): string | undefined {
  if (text === undefined) return undefined;
  const masked = maskEmailLike(text, "[address]");
  return masked.length > MAX_RESPONSE_TEXT
    ? `${masked.slice(0, MAX_RESPONSE_TEXT)}...`
    : masked;
}

// ---------------------------------------------------------------------------
// 발송기

/** Mailo 쪽 문제라 SMTP 오류로 분류하면 안 되는 nodemailer 오류 코드. */
const LOCAL_FAULT_CODES = new Set([
  "ECONFIG",
  "ESTREAM",
  "EFILEACCESS",
  "EURLACCESS",
  "EMAXRECIPIENTS",
  "EOTP",
]);

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function isLocalFault(error: unknown): boolean {
  const rec = recordOf(error);
  const code = typeof rec["code"] === "string" ? rec["code"] : undefined;
  if (code !== undefined && LOCAL_FAULT_CODES.has(code)) return true;
  // 서버와 통신하기 전에 nodemailer가 만든 입력 오류(수신자 없음, 잘못된 발신자). 인증 정보 누락(EAUTH)은 제외한다.
  return rec["command"] === "API" && code === "EENVELOPE";
}

function buildTransportOptions(
  config: SmtpSenderConfig,
  tracker: StageTracker,
): SMTPTransportOptions {
  const t = config.timeouts;
  return {
    host: config.host,
    port: config.port,
    // 587: secure:false + requireTLS:true는 STARTTLS를 강제하고 지원하지 않는 서버에서 평문으로 내려가지 않는다.
    // 465: secure:true는 연결 즉시 TLS다.
    secure: config.tlsMode === "IMPLICIT",
    requireTLS: config.tlsMode === "STARTTLS",
    // 이 객체에 rejectUnauthorized를 넣지 않는다. 기본값(검증 켜짐)을 유지한다.
    tls: {
      minVersion: "TLSv1.2",
      ...(config.trustedCa !== undefined && { ca: config.trustedCa }),
    },
    connectionTimeout: t.connectionMs,
    greetingTimeout: t.greetingMs,
    socketTimeout: t.socketMs,
    dnsTimeout: t.dnsMs,
    ...(config.auth !== undefined && {
      auth: { user: config.auth.user, pass: config.auth.pass },
    }),
    ...(config.clientName !== undefined && { name: config.clientName }),
    logger: tracker.logger,
    transactionLog: true,
    // 첨부와 원격 리소스 읽기를 막는다. 1·2단계는 첨부를 받지 않는다(RQ-030).
    disableFileAccess: true,
    disableUrlAccess: true,
  } as SMTPTransportOptions;
}

function toDetail(failure: {
  stage: SmtpStage;
  responseCode?: number;
  enhancedStatus?: string;
  responseText?: string;
}): SmtpFailureDetail {
  const text = sanitizeResponseText(failure.responseText);
  return {
    stage: failure.stage,
    ...(failure.responseCode !== undefined && {
      responseCode: failure.responseCode,
    }),
    ...(failure.enhancedStatus !== undefined && {
      enhancedStatus: failure.enhancedStatus,
    }),
    ...(text !== undefined && { responseText: text }),
  };
}

/** 수신자 결과로 정한 작업 결과를 발송 결과로 바꾼다. 수신자 단계 응답은 RCPT 단계다. */
function fromRecipientOutcome(
  outcome: Exclude<RecipientOutcome, { kind: "SENT" }>,
): SmtpSendResult {
  // 판정에 쓴 수신자의 응답을 failure로 남긴다. 첫 거부 수신자의 응답과 다를 수 있다.
  const failure = toDetail({ stage: "RCPT", ...outcome.basis });
  if (outcome.kind === "ACCOUNT") {
    return {
      kind: "ACCOUNT",
      reason: outcome.reason,
      rule: outcome.rule,
      failure,
    };
  }
  return { kind: outcome.kind, rule: outcome.rule, failure };
}

export function createSmtpSender(config: SmtpSenderConfig): MailSender {
  validateConnection(config);
  return {
    async send(message, options = {}) {
      if (options.signal?.aborted) throw new SmtpAbortedError();

      let messageId: string;
      try {
        messageId = buildMessageId(
          message.jobId,
          config.accountAddress ?? message.from,
        );
      } catch (error) {
        throw new SmtpInternalError(
          recordOf(error)["code"] === undefined
            ? "MESSAGE_ID"
            : String(recordOf(error)["code"]),
        );
      }

      const tracker = new StageTracker();
      const transporter = createTransport(
        buildTransportOptions(config, tracker),
      );
      const deadline = AbortSignal.timeout(config.timeouts.totalMs);
      const signal = options.signal
        ? AbortSignal.any([deadline, options.signal])
        : deadline;

      try {
        const info: unknown = await transporter.sendMail({
          from: message.from,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          to: [...message.to],
          cc: [...message.cc],
          bcc: [...message.bcc],
          subject: message.subject,
          ...(message.text !== null ? { text: message.text } : {}),
          ...(message.html !== null ? { html: message.html } : {}),
          messageId,
          signal,
        });
        return resolveSent(info);
      } catch (error) {
        if (options.signal?.aborted) throw new SmtpAbortedError();
        if (isLocalFault(error)) {
          const code = recordOf(error)["code"];
          throw new SmtpInternalError(
            typeof code === "string" ? code : "UNKNOWN",
          );
        }
        return resolveFailure(error, tracker);
      } finally {
        transporter.close();
      }
    },
  };
}

function validateConnection(config: SmtpSenderConfig): void {
  const portOk =
    Number.isInteger(config.port) && config.port > 0 && config.port < 65536;
  if (config.host.trim() === "" || !portOk)
    throw new SmtpConfigError("INVALID_CONNECTION");
  const t = config.timeouts;
  const ok = [
    t.connectionMs,
    t.greetingMs,
    t.socketMs,
    t.dnsMs,
    t.totalMs,
  ].every((v) => Number.isFinite(v) && v > 0);
  if (!ok) throw new SmtpConfigError("INVALID_TIMEOUT");
}

/** 서버가 메일을 수락했다. 일부 수신자가 거부됐으면 `rejectedRecipients`에 담는다(ADR-0007 결정 7). */
function resolveSent(info: unknown): SmtpSendResult {
  const results = adaptNodemailerSendInfo(info);
  // 수락 응답인데 수신자 정보가 비어 있으면 거부 기록이 없는 것이므로 그대로 SENT다.
  if (results.length === 0) return { kind: "SENT", rejectedRecipients: [] };
  const outcome = resolveRecipientOutcome(results);
  if (outcome.kind !== "SENT") {
    // sendMail이 성공했는데 수락 수신자가 없는 상태는 nodemailer 계약상 일어나지 않는다.
    // 일어나면 수락으로 보지 않고 일시 오류로 다뤄 재시도한다(추정: 안전한 쪽).
    return {
      kind: "TRANSIENT",
      rule: "SENT_WITHOUT_ACCEPTED_RECIPIENT",
      failure: { stage: "DATA" },
    };
  }
  return {
    kind: "SENT",
    rejectedRecipients: outcome.rejectedRecipients.map((r) => {
      const text = sanitizeResponseText(r.responseText);
      return {
        address: r.address,
        ...(r.responseCode !== undefined && { responseCode: r.responseCode }),
        ...(r.enhancedStatus !== undefined && {
          enhancedStatus: r.enhancedStatus,
        }),
        ...(text !== undefined && { responseText: text }),
      };
    }),
  };
}

function resolveFailure(error: unknown, tracker: StageTracker): SmtpSendResult {
  // 전원 거부는 수신자별 응답으로 판정한다(ADR-0007 결정 7).
  const recipients = adaptNodemailerRejectedError(error);
  if (recipients) {
    const outcome = resolveRecipientOutcome(recipients);
    if (outcome.kind !== "SENT") return fromRecipientOutcome(outcome);
  }

  const failure = adaptNodemailerError(error, {
    inFlightStage: tracker.stage(),
  });
  const classification = classifySmtpFailure(failure);
  const detail = toDetail(failure);
  if (classification.kind === "ACCOUNT") {
    return {
      kind: "ACCOUNT",
      reason: classification.reason,
      rule: classification.rule,
      failure: detail,
    };
  }
  return {
    kind: classification.kind,
    rule: classification.rule,
    failure: detail,
  };
}
