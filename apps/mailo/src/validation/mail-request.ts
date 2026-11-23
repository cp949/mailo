/**
 * 발송 요청 입력 검증(RQ-030). REST와 파일 채널이 같은 함수를 쓴다.
 * 봉투 암호화 요청은 복호화한 뒤에 호출한다(ADR-0008 결정 3). 원시 크기 상한(2 MiB)은 이 함수의 범위가 아니다.
 *
 * 외부 라이브러리를 쓰지 않는 이유
 * - AGENTS.md와 RQ-029: 새 npm 의존성은 필요 이유가 있을 때만 추가한다. 검사 항목이 몇 개 안 되는 고정 규칙이다.
 * - 이메일 주소 검증 라이브러리는 RFC 5322 전체(따옴표 로컬 파트, 주석, 표시 이름, IP 리터럴)를 받아들인다.
 *   헤더 인젝션 표면이 넓어지므로 여기서는 더 좁은 형식만 허용한다.
 *
 * 허용하는 주소 형식(`local@domain`): 로컬 파트는 dot-atom(RFC 5322 atext와 `.`), 64자 이하.
 * 도메인은 ASCII 영숫자·하이픈 라벨 2개 이상, 라벨 63자 이하. 전체 254자 이하.
 * 표시 이름, 따옴표, 주석, IP 리터럴, 비ASCII(IDN·SMTPUTF8)는 거부한다. IDN은 호출처가 punycode로 보낸다.
 *
 * 오류는 코드와 필드명만 담는다. 입력 값(주소, 제목, 본문)은 오류·메시지에 넣지 않는다(RQ-027).
 * 필드명에 쓰는 인덱스(`to[2]`)는 서버가 만든 값이다.
 */

export interface MailRequestLimits {
  /** to+cc+bcc 합. */
  maxRecipients: number;
  /** 제목 길이(유니코드 코드 포인트 수). */
  maxSubjectChars: number;
  /** 주소 길이(문자 수). */
  maxAddressChars: number;
  /** 제목+text+html의 UTF-8 바이트 합. */
  maxContentBytes: number;
}

/** RQ-030 기본값(모두 추정, 설정으로 바꾼다). */
export const DEFAULT_MAIL_REQUEST_LIMITS: MailRequestLimits = {
  maxRecipients: 50,
  maxSubjectChars: 255,
  maxAddressChars: 254,
  maxContentBytes: 1024 * 1024,
};

export type ValidationCode =
  | "REQUIRED"
  | "INVALID_TYPE"
  | "HEADER_INJECTION"
  | "ADDRESS_FORMAT"
  | "ADDRESS_TOO_LONG"
  | "SUBJECT_TOO_LONG"
  | "RECIPIENTS_TOO_MANY"
  | "NO_RECIPIENTS"
  | "CONTENT_TOO_LARGE"
  | "KEY_LENGTH"
  | "KEY_FORMAT"
  | "ATTACHMENTS_NOT_SUPPORTED";

export interface ValidationIssue {
  code: ValidationCode;
  /** 예: `subject`, `to[2]`, `idempotencyKey`. */
  field: string;
}

export interface ValidateMailRequestOptions {
  /**
   * true이면 `from`을 생략할 수 있다. REST 계약이 `from` 생략을 허용한다(Mailo의 SMTP 발신 계정을 쓴다).
   * 기본값은 false다. 파일 채널 스키마는 2단계에서 정한다.
   */
  fromOptional?: boolean;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export interface ValidatedMailRequest {
  /** `fromOptional` 옵션을 켰을 때만 null이 될 수 있다. null이면 SMTP 발신 계정을 쓴다는 뜻이다. */
  from: string | null;
  replyTo: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string | null;
  html: string | null;
}

export class MailValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(
      `validation failed: ${issues.map((i) => `${i.code}@${i.field}`).join(", ")}`,
    );
    this.name = "MailValidationError";
  }
}

// CR, LF, NUL 외에 줄 구분자로 해석될 수 있는 VT, FF, NEL, LS, PS도 거부한다.
// 헤더를 줄 단위로 다시 해석하는 구현이 있을 수 있어서다.
// 제어 문자 검출이 목적이므로 no-control-regex를 끈다.
// eslint-disable-next-line no-control-regex
const LINE_BREAK_OR_NUL = /[\r\n\0\u000B\u000C\u0085\u2028\u2029]/;
// 주소에는 모든 제어 문자와 공백이 들어갈 수 없다.
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007F-\u009F]/;

const LOCAL_PART =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const ALL_DIGITS = /^[0-9]+$/;
const IDEMPOTENCY_KEY_CHARS = /^[A-Za-z0-9._:-]+$/;
const MAX_LOCAL_PART = 64;

/** 주소 한 개를 검사한다. 문제가 없으면 undefined. */
export function checkAddress(
  address: string,
  maxChars: number,
): ValidationCode | undefined {
  if (LINE_BREAK_OR_NUL.test(address)) return "HEADER_INJECTION";
  if (address.length > maxChars) return "ADDRESS_TOO_LONG";
  if (address.length === 0 || CONTROL_OR_SPACE.test(address))
    return "ADDRESS_FORMAT";

  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@")) return "ADDRESS_FORMAT";
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > MAX_LOCAL_PART || !LOCAL_PART.test(local))
    return "ADDRESS_FORMAT";

  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => DOMAIN_LABEL.test(l)))
    return "ADDRESS_FORMAT";
  // 마지막 라벨이 숫자뿐이면 IP 주소 형태(예: 1.2.3.4)다.
  if (ALL_DIGITS.test(labels[labels.length - 1]!)) return "ADDRESS_FORMAT";
  return undefined;
}

function countCodePoints(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

/** `Idempotency-Key`(RQ-011): 1~128자, `[A-Za-z0-9._:-]`. */
export function validateIdempotencyKey(
  value: unknown,
): ValidationResult<string> {
  const field = "idempotencyKey";
  if (value === undefined || value === null)
    return fail({ code: "REQUIRED", field });
  if (typeof value !== "string") return fail({ code: "INVALID_TYPE", field });
  if (value.length < 1 || value.length > 128)
    return fail({ code: "KEY_LENGTH", field });
  if (!IDEMPOTENCY_KEY_CHARS.test(value))
    return fail({ code: "KEY_FORMAT", field });
  return { ok: true, value };
}

function fail(...issues: ValidationIssue[]): {
  ok: false;
  issues: ValidationIssue[];
} {
  return { ok: false, issues };
}

/**
 * 복호화를 마친 발송 요청을 검증한다. 모든 문제를 모아 반환한다.
 * 정의되지 않은 필드는 무시한다. 단 `attachments`는 값과 무관하게 있으면 거부한다(1·2단계 미지원).
 * 수신자는 to+cc+bcc 합이 1명 이상이어야 한다(bcc만 있는 요청도 허용하는 것은 추정).
 */
export function validateMailRequest(
  input: unknown,
  limits: MailRequestLimits = DEFAULT_MAIL_REQUEST_LIMITS,
  options: ValidateMailRequestOptions = {},
): ValidationResult<ValidatedMailRequest> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail({ code: "INVALID_TYPE", field: "$" });
  }
  const body = input as Record<string, unknown>;
  const issues: ValidationIssue[] = [];

  if (Object.hasOwn(body, "attachments")) {
    issues.push({ code: "ATTACHMENTS_NOT_SUPPORTED", field: "attachments" });
  }

  const from = checkSingleAddress(
    body["from"],
    "from",
    options.fromOptional !== true,
    limits,
    issues,
  );
  const replyTo = checkSingleAddress(
    body["replyTo"],
    "replyTo",
    false,
    limits,
    issues,
  );
  const to = checkAddressList(body["to"], "to", limits, issues);
  const cc = checkAddressList(body["cc"], "cc", limits, issues);
  const bcc = checkAddressList(body["bcc"], "bcc", limits, issues);

  // 개수를 먼저 합산한다. 상한을 넘은 요청은 주소별 검사를 하지 않아 거대한 배열의 처리 비용을 막는다.
  const total = to.length + cc.length + bcc.length;
  const counted = to.counted + cc.counted + bcc.counted;
  if (counted > limits.maxRecipients) {
    issues.push({ code: "RECIPIENTS_TOO_MANY", field: "recipients" });
  } else if (total === 0 && !to.invalid && !cc.invalid && !bcc.invalid) {
    issues.push({ code: "NO_RECIPIENTS", field: "recipients" });
  }

  const subject = checkSubject(body["subject"], limits, issues);
  const text = checkOptionalContent(body["text"], "text", issues);
  const html = checkOptionalContent(body["html"], "html", issues);
  if (text.present === false && html.present === false) {
    issues.push({ code: "REQUIRED", field: "text|html" });
  }

  if (
    typeof subject === "string" &&
    text.value !== undefined &&
    html.value !== undefined
  ) {
    const bytes =
      Buffer.byteLength(subject, "utf8") +
      (text.value === null ? 0 : Buffer.byteLength(text.value, "utf8")) +
      (html.value === null ? 0 : Buffer.byteLength(html.value, "utf8"));
    if (bytes > limits.maxContentBytes)
      issues.push({ code: "CONTENT_TOO_LARGE", field: "content" });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      from: (from as string | undefined) ?? null,
      replyTo: (replyTo as string | undefined) ?? null,
      to: to.items,
      cc: cc.items,
      bcc: bcc.items,
      subject: subject as string,
      text: text.value ?? null,
      html: html.value ?? null,
    },
  };
}

/** 검증하고 실패하면 MailValidationError를 던진다. */
export function assertValidMailRequest(
  input: unknown,
  limits?: MailRequestLimits,
  options?: ValidateMailRequestOptions,
): ValidatedMailRequest {
  const result = validateMailRequest(input, limits, options);
  if (!result.ok) throw new MailValidationError(result.issues);
  return result.value;
}

function checkSingleAddress(
  value: unknown,
  field: string,
  required: boolean,
  limits: MailRequestLimits,
  issues: ValidationIssue[],
): string | undefined {
  if (value === undefined || value === null) {
    if (required) issues.push({ code: "REQUIRED", field });
    return undefined;
  }
  if (typeof value !== "string") {
    issues.push({ code: "INVALID_TYPE", field });
    return undefined;
  }
  const problem = checkAddress(value, limits.maxAddressChars);
  if (problem) {
    issues.push({ code: problem, field });
    return undefined;
  }
  return value;
}

interface AddressListResult {
  items: string[];
  /** 검증된 개수. */
  length: number;
  /** 배열 원소 수(검증 여부와 무관). 상한 판정에 쓴다. */
  counted: number;
  /** 형식 오류(타입 포함)가 있었는지. 수신자 없음 오류와 겹쳐 보고하지 않기 위해 쓴다. */
  invalid: boolean;
}

function checkAddressList(
  value: unknown,
  field: string,
  limits: MailRequestLimits,
  issues: ValidationIssue[],
): AddressListResult {
  const result: AddressListResult = {
    items: [],
    length: 0,
    counted: 0,
    invalid: false,
  };
  if (value === undefined || value === null) return result;
  if (!Array.isArray(value)) {
    issues.push({ code: "INVALID_TYPE", field });
    result.invalid = true;
    return result;
  }
  result.counted = value.length;
  if (value.length > limits.maxRecipients) return result;

  value.forEach((item, index) => {
    const itemField = `${field}[${index}]`;
    if (typeof item !== "string") {
      issues.push({ code: "INVALID_TYPE", field: itemField });
      result.invalid = true;
      return;
    }
    const problem = checkAddress(item, limits.maxAddressChars);
    if (problem) {
      issues.push({ code: problem, field: itemField });
      result.invalid = true;
      return;
    }
    result.items.push(item);
  });
  result.length = result.items.length;
  return result;
}

function checkSubject(
  value: unknown,
  limits: MailRequestLimits,
  issues: ValidationIssue[],
): string | undefined {
  const field = "subject";
  if (value === undefined || value === null) {
    issues.push({ code: "REQUIRED", field });
    return undefined;
  }
  if (typeof value !== "string") {
    issues.push({ code: "INVALID_TYPE", field });
    return undefined;
  }
  if (LINE_BREAK_OR_NUL.test(value)) {
    issues.push({ code: "HEADER_INJECTION", field });
    return undefined;
  }
  if (value.length === 0) {
    issues.push({ code: "REQUIRED", field });
    return undefined;
  }
  // UTF-16 길이는 코드 포인트 수의 2배를 넘지 못하므로, 그 이하이면 세지 않고 통과시킨다.
  if (
    value.length > limits.maxSubjectChars &&
    countCodePoints(value) > limits.maxSubjectChars
  ) {
    issues.push({ code: "SUBJECT_TOO_LONG", field });
    return undefined;
  }
  return value;
}

/** text·html. 없음은 value null, 타입 오류는 value undefined로 구분한다. */
function checkOptionalContent(
  value: unknown,
  field: string,
  issues: ValidationIssue[],
): { value: string | null | undefined; present: boolean } {
  if (value === undefined || value === null)
    return { value: null, present: false };
  if (typeof value !== "string") {
    issues.push({ code: "INVALID_TYPE", field });
    return { value: undefined, present: true };
  }
  return { value, present: value.length > 0 };
}
