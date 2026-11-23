/**
 * nodemailer 오류·결과를 분류 입력(SmtpFailure, RecipientResult)으로 바꾸는 어댑터.
 *
 * 필드 형태는 nodemailer 10.6.1과 로컬 smtp-server로 실측해 확인했다(test/smtp/nodemailer-errors.spec.ts가
 * 형태를 고정한다). 실측으로 확인한 사실:
 * - 서버 응답에 대한 오류: `code`는 EENVELOPE(MAIL FROM·RCPT TO·DATA 명령 응답), EMESSAGE(DATA 본문 응답),
 *   EAUTH(AUTH), ETLS(STARTTLS 응답 거부)다. `command`는 실제 명령("MAIL FROM", "RCPT TO", "DATA",
 *   "AUTH PLAIN", "STARTTLS"), `responseCode`는 숫자, `response`는 "550 5.4.5 ..." 원문이다.
 * - 전송 계층 오류(소켓 타임아웃 ETIMEDOUT, 연결 끊김 ECONNECTION, 소켓 오류 ESOCKET, 인증서 검증 실패)는
 *   진행 중인 단계와 무관하게 `command`가 항상 "CONN"이다. 연결 거부는 code가 ESOCKET이고 `originalCode`에
 *   ECONNREFUSED가 있다. 그래서 `command`만으로는 DATA 단계 타임아웃(TRANSIENT, ADR-0007 결정 3)과
 *   연결 단계 타임아웃(계정 상태 오류)을 구분할 수 없다. 호출자(sender.ts)가 마지막 SMTP 명령을 추적해
 *   `hint.inFlightStage`로 넘긴다.
 * - 수신자 전원 거부: 오류에 `rejected`(주소 배열)와 `rejectedErrors`(수신자별 오류, `recipient` 포함)가 있다.
 *   일부 수락이면 오류 없이 info에 `accepted`·`rejected`·`rejectedErrors`가 온다.
 * - 호출자가 준 AbortSignal로 중단하면 code가 EABORT다.
 *
 * 이 모듈은 입력 객체를 읽기만 하며 어떤 값도 던지는 오류나 반환값에 되돌려 넣지 않는다.
 */
import type {
  RecipientResult,
  SmtpFailure,
  SmtpStage,
  TransportFault,
} from "./classify.js";

type Loose = Record<string, unknown>;

function asRecord(value: unknown): Loose | undefined {
  return typeof value === "object" && value !== null
    ? (value as Loose)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const STAGE_BY_COMMAND: ReadonlyArray<readonly [RegExp, SmtpStage]> = [
  [/^CONN/i, "CONN"],
  [/^STARTTLS/i, "TLS"],
  [/^AUTH/i, "AUTH"],
  [/^MAIL\s*FROM/i, "MAIL_FROM"],
  [/^RCPT\s*TO/i, "RCPT"],
  [/^DATA/i, "DATA"],
];

const STAGE_BY_CODE: Readonly<Record<string, SmtpStage>> = {
  ECONNECTION: "CONN",
  ESOCKET: "CONN",
  EDNS: "CONN",
  EPROXY: "CONN",
  ETLS: "TLS",
  EAUTH: "AUTH",
  EENVELOPE: "RCPT",
  EMESSAGE: "DATA",
};

/**
 * 오류에서 SMTP 단계를 판별한다. command를 우선하고 code로 보완한다.
 * 판별하지 못하면 CONN으로 둔다. CONN은 계정 상태 오류라 시도 횟수를 소모하지 않는 안전한 쪽이지만,
 * DATA 단계 타임아웃을 놓치면 만료 시각까지 재시도가 이어진다(추정).
 */
export function detectStage(
  command: string | undefined,
  code: string | undefined,
): SmtpStage {
  if (command) {
    for (const [pattern, stage] of STAGE_BY_COMMAND) {
      if (pattern.test(command)) return stage;
    }
  }
  if (code && STAGE_BY_CODE[code]) return STAGE_BY_CODE[code];
  return "CONN";
}

// EABORT: 호출자가 건 전체 마감(AbortSignal)에 걸린 경우. 서버 응답 없이 끊긴 것이므로 타임아웃으로 본다.
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "EABORT"]);
const DISCONNECT_CODES = new Set([
  "ECONNRESET",
  "ECONNECTION",
  "ESOCKET",
  "EPIPE",
  "ECONNREFUSED",
]);

function detectFault(code: string | undefined): TransportFault | undefined {
  if (!code) return undefined;
  if (TIMEOUT_CODES.has(code)) return "TIMEOUT";
  if (DISCONNECT_CODES.has(code)) return "DISCONNECT";
  return undefined;
}

const LEADING_CODE = /^\s*(\d{3})(?=[ -]|$)/;
const ENHANCED_AFTER_CODE = /^\s*\d{3}[ -]([245]\.\d{1,3}\.\d{1,3})\b/m;

/** "550-5.4.5 ..."·"550 5.4.5 ..." 응답에서 enhanced status code를 뽑는다. 첫 줄 기준이다. */
export function parseEnhancedStatus(
  response: string | undefined,
): string | undefined {
  if (!response) return undefined;
  return ENHANCED_AFTER_CODE.exec(response)?.[1];
}

function parseResponseCode(rec: Loose): number | undefined {
  const direct = rec["responseCode"];
  if (
    typeof direct === "number" &&
    Number.isInteger(direct) &&
    direct >= 100 &&
    direct <= 599
  ) {
    return direct;
  }
  const match = LEADING_CODE.exec(str(rec["response"]) ?? "");
  return match ? Number(match[1]) : undefined;
}

/** 서버 응답이 아니라 전송 계층에서 난 오류. nodemailer가 `command`를 "CONN"으로 채우는 부류다. */
const TRANSPORT_LEVEL_CODES = new Set([
  "ETIMEDOUT",
  "ECONNECTION",
  "ESOCKET",
  "ETLS",
  "EABORT",
]);

export interface AdaptHint {
  /**
   * 오류 시점에 응답을 기다리던 가장 오래된 SMTP 명령의 단계. nodemailer 오류의 `command`가
   * 전송 계층 오류에서 "CONN"으로 고정되므로 호출자가 별도로 추적해 넘긴다.
   */
  inFlightStage?: SmtpStage;
}

/**
 * nodemailer가 던진 오류를 SmtpFailure로 바꾼다. 알 수 없는 입력은 CONN 단계 실패로 본다.
 * 전송 계층 오류에서 `hint.inFlightStage`가 있으면 그 단계를 쓴다.
 */
export function adaptNodemailerError(
  error: unknown,
  hint: AdaptHint = {},
): SmtpFailure {
  const rec = asRecord(error) ?? {};
  const code = str(rec["code"]);
  const command = str(rec["command"]);
  const response = str(rec["response"]);
  const responseCode = parseResponseCode(rec);
  const enhancedStatus = parseEnhancedStatus(response);
  // EABORT는 command가 없을 수 있어 command 검사를 CONN 또는 없음으로 완화한다.
  const transportLevel =
    code !== undefined &&
    TRANSPORT_LEVEL_CODES.has(code) &&
    (command === undefined || /^CONN/i.test(command));

  let stage = detectStage(command, code);
  if (transportLevel) {
    if (hint.inFlightStage !== undefined) stage = hint.inFlightStage;
    else if (code === "ETLS") stage = "TLS";
  }
  // 서버 응답이 있으면 응답 코드로 분류하므로 전송 결함 표시는 응답이 없을 때만 의미가 있다.
  const transportFault =
    responseCode === undefined ? detectFault(code) : undefined;
  return {
    stage,
    ...(responseCode !== undefined && { responseCode }),
    ...(enhancedStatus !== undefined && { enhancedStatus }),
    ...(response !== undefined && { responseText: response }),
    ...(transportFault !== undefined && { transportFault }),
  };
}

function addressOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return str(asRecord(value)?.["address"]);
}

/**
 * 발송 결과(info)를 수신자별 결과로 바꾼다.
 * rejectedErrors에서 수신자별 응답을 찾지 못한 거부 수신자는 응답 코드 없이 거부로 표시한다.
 * 이 경우 분류는 TRANSIENT 폴백이 된다.
 */
export function adaptNodemailerSendInfo(info: unknown): RecipientResult[] {
  const rec = asRecord(info) ?? {};
  const accepted = Array.isArray(rec["accepted"]) ? rec["accepted"] : [];
  const rejected = Array.isArray(rec["rejected"]) ? rec["rejected"] : [];
  const rejectedErrors = Array.isArray(rec["rejectedErrors"])
    ? rec["rejectedErrors"]
    : [];

  const errorByAddress = new Map<string, Loose>();
  for (const entry of rejectedErrors) {
    const e = asRecord(entry);
    const address = addressOf(e?.["recipient"]);
    if (e && address !== undefined) errorByAddress.set(address, e);
  }

  const results: RecipientResult[] = [];
  for (const item of accepted) {
    const address = addressOf(item);
    if (address !== undefined) results.push({ address, accepted: true });
  }
  for (const item of rejected) {
    const address = addressOf(item);
    if (address === undefined) continue;
    const failure = errorByAddress.get(address);
    const adapted = failure ? adaptNodemailerError(failure) : undefined;
    results.push({
      address,
      accepted: false,
      ...(adapted?.responseCode !== undefined && {
        responseCode: adapted.responseCode,
      }),
      ...(adapted?.enhancedStatus !== undefined && {
        enhancedStatus: adapted.enhancedStatus,
      }),
      ...(adapted?.responseText !== undefined && {
        responseText: adapted.responseText,
      }),
      ...(adapted?.transportFault !== undefined && {
        transportFault: adapted.transportFault,
      }),
    });
  }
  return results;
}

/**
 * "전원 거부" 오류(`rejectedErrors`가 있는 EENVELOPE)를 수신자별 결과로 바꾼다.
 * 해당 형태가 아니면 undefined이고, 호출자는 `adaptNodemailerError`로 단일 오류처럼 다룬다.
 * 수신자별 응답이 4xx와 5xx로 섞여 있으면 `resolveRecipientOutcome`이 TRANSIENT를 택한다(ADR-0007 결정 7).
 */
export function adaptNodemailerRejectedError(
  error: unknown,
): RecipientResult[] | undefined {
  const rec = asRecord(error);
  const errors = rec?.["rejectedErrors"];
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const rejected = errors
    .map((e) => addressOf(asRecord(e)?.["recipient"]))
    .filter((a): a is string => a !== undefined);
  if (rejected.length === 0) return undefined;
  return adaptNodemailerSendInfo({
    accepted: [],
    rejected,
    rejectedErrors: errors,
  });
}
