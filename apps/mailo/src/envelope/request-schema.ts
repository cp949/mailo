/**
 * 요청 본문(JSON 객체) 스키마 검증. REST 본문과 파일 채널 payload가 같은 공통 스키마를 쓴다
 * (docs/api/openapi.yaml `SendRequest`, ADR-0004 결정 1, ADR-0008 결정 2).
 * 필드 단위 규칙(주소 형식, 제목 길이, 크기 합, CR·LF)은 `validation` 모듈이 맡는다. 여기서는 그 앞뒤의 계약 규칙만 본다.
 * - 정의되지 않은 필드는 `attachments`를 포함해 거부한다.
 * - `null` 값과 `to` 누락·빈 배열을 거부한다(`to`는 1명 이상).
 * - 평문 모드(`subject`·`text`·`html`)와 암호화 모드(`content`)를 섞을 수 없다.
 * - 파일 채널은 `version`(1)과 `idempotencyKey`를 추가로 요구한다. REST는 Key를 헤더로 받으므로 이 두 필드는 정의되지 않은 필드다.
 * - 오류는 위치(JSON Pointer)와 고정 코드만 담는다. 요청 값은 담지 않는다(RQ-027).
 *
 * 암호화 모드(`content`)는 여기서 수신자·발신자 규칙까지만 본다. 제목·본문은 복호화한 뒤에 검증한다(ADR-0008 결정 3).
 * 그래서 성공 결과의 `outer`는 암호화 모드에서 제목·본문이 자리표시자다. 그대로 쓰지 않는다.
 */
import type {
  ValidationErrorCode,
  ValidationErrorItem,
} from "../http/index.js";
import {
  validateIdempotencyKey,
  validateMailRequest,
  type MailRequestLimits,
  type ValidatedMailRequest,
  type ValidationCode,
} from "../validation/index.js";

export type SchemaChannel = "rest" | "file";

const COMMON_FIELDS = [
  "to",
  "cc",
  "bcc",
  "from",
  "replyTo",
  "subject",
  "text",
  "html",
  "content",
] as const;
const FILE_ONLY_FIELDS = ["version", "idempotencyKey"] as const;
const PLAIN_CONTENT_FIELDS = ["subject", "text", "html"] as const;
const JWE_COMPACT = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){4}$/;
/** 파일 채널 요청 형식 버전. 형식이 바뀌면 올린다. */
export const FILE_REQUEST_VERSION = 1;

export type SchemaFailureReason =
  | "VALIDATION_FAILED"
  | "ATTACHMENTS_NOT_SUPPORTED"
  | "IDEMPOTENCY_KEY_MISSING"
  | "IDEMPOTENCY_KEY_INVALID";

export type RequestSchemaParse =
  | {
      ok: true;
      /** 평문 모드는 검증을 끝낸 요청이다. 암호화 모드는 제목·본문이 자리표시자다. */
      outer: ValidatedMailRequest;
      /** 암호화 모드의 JWE compact 문자열. 평문 모드는 null이다. */
      content: string | null;
      /** 파일 채널의 `idempotencyKey`. REST는 null이다. */
      idempotencyKey: string | null;
    }
  | { ok: false; reason: SchemaFailureReason; errors: ValidationErrorItem[] };

const CODE_MAP: Record<ValidationCode, ValidationErrorCode> = {
  REQUIRED: "REQUIRED",
  INVALID_TYPE: "INVALID_FORMAT",
  HEADER_INJECTION: "CONTROL_CHARACTER",
  ADDRESS_FORMAT: "INVALID_FORMAT",
  ADDRESS_TOO_LONG: "TOO_LONG",
  SUBJECT_TOO_LONG: "TOO_LONG",
  RECIPIENTS_TOO_MANY: "TOO_MANY",
  NO_RECIPIENTS: "REQUIRED",
  CONTENT_TOO_LARGE: "TOO_LARGE",
  KEY_LENGTH: "TOO_LONG",
  KEY_FORMAT: "INVALID_FORMAT",
  ATTACHMENTS_NOT_SUPPORTED: "ATTACHMENTS_NOT_SUPPORTED",
};

/** validation 모듈의 필드 이름(`to[2]`)을 JSON Pointer(`/to/2`)로 바꾼다. 본문 전체는 빈 문자열이다. */
export function toPointer(field: string): string {
  const indexed = /^([A-Za-z]+)\[(\d+)\]$/.exec(field);
  if (indexed) return `/${indexed[1]}/${indexed[2]}`;
  if (field === "text|html") return "/text";
  if (field === "recipients") return "/to";
  if (field === "content" || field === "$") return "";
  return `/${field}`;
}

/** validation 모듈의 이슈를 계약 오류 항목으로 바꾼다. */
export function toErrorItem(issue: {
  field: string;
  code: ValidationCode;
}): ValidationErrorItem {
  return { pointer: toPointer(issue.field), code: CODE_MAP[issue.code] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRequestSchema(
  body: unknown,
  limits: MailRequestLimits,
  channel: SchemaChannel,
): RequestSchemaParse {
  if (!isRecord(body))
    return {
      ok: false,
      reason: "VALIDATION_FAILED",
      errors: [{ pointer: "", code: "INVALID_FORMAT" }],
    };

  const known = new Set<string>(
    channel === "file"
      ? [...COMMON_FIELDS, ...FILE_ONLY_FIELDS]
      : COMMON_FIELDS,
  );
  const errors: ValidationErrorItem[] = [];
  const reported = new Set<string>();
  const report = (pointer: string, code: ValidationErrorCode): void => {
    errors.push({ pointer, code });
    reported.add(pointer);
  };

  let keyReason: "IDEMPOTENCY_KEY_MISSING" | "IDEMPOTENCY_KEY_INVALID" | null =
    null;
  let idempotencyKey: string | null = null;
  if (channel === "file") {
    const version = body["version"];
    if (version === undefined) report("/version", "REQUIRED");
    else if (version !== FILE_REQUEST_VERSION)
      report("/version", "INVALID_FORMAT");

    const raw = body["idempotencyKey"];
    const checked = validateIdempotencyKey(raw);
    if (checked.ok) {
      idempotencyKey = checked.value;
    } else if (raw === undefined || raw === null) {
      keyReason = "IDEMPOTENCY_KEY_MISSING";
      report("/idempotencyKey", "REQUIRED");
    } else {
      keyReason = "IDEMPOTENCY_KEY_INVALID";
      report(
        "/idempotencyKey",
        checked.issues[0]?.code === "KEY_LENGTH"
          ? "TOO_LONG"
          : "INVALID_FORMAT",
      );
    }
  }

  for (const [name, value] of Object.entries(body)) {
    if (name === "attachments") continue; // validation 모듈이 ATTACHMENTS_NOT_SUPPORTED로 보고한다.
    if (!known.has(name)) {
      // 필드 이름도 요청에서 온 값이라 되돌려 주지 않는다(docs/api/README.md "요청에서 받은 값 전반"). 본문 전체를 위치로 쓴다.
      report("", "UNKNOWN_FIELD");
    } else if (value === null && name !== "idempotencyKey") {
      report(`/${name}`, "INVALID_FORMAT");
    }
  }

  const content = body["content"];
  const hasContent = content !== undefined;
  const plainPresent = PLAIN_CONTENT_FIELDS.some((f) => body[f] !== undefined);
  let jwe: string | null = null;
  if (hasContent && plainPresent) {
    report("/content", "CONFLICTING_FIELDS");
  } else if (hasContent && typeof content === "string") {
    if (JWE_COMPACT.test(content)) jwe = content;
    else report("/content", "INVALID_FORMAT");
  } else if (hasContent && content !== null) {
    report("/content", "INVALID_FORMAT");
  }

  const to = body["to"];
  if (to === undefined || (Array.isArray(to) && to.length === 0))
    report("/to", "REQUIRED");

  // 암호화 모드는 제목·본문이 없으므로 이 둘을 채운 사본으로 수신자·발신자 규칙만 검사한다.
  const subjectless = hasContent && !plainPresent;
  const candidate: Record<string, unknown> = { ...body };
  delete candidate["content"];
  delete candidate["version"];
  delete candidate["idempotencyKey"];
  for (const [name, value] of Object.entries(candidate))
    if (value === null) delete candidate[name];
  if (subjectless) {
    candidate["subject"] = "x";
    candidate["text"] = "x";
  }

  const checked = validateMailRequest(candidate, limits, {
    fromOptional: true,
  });
  let attachments = false;
  if (!checked.ok) {
    for (const issue of checked.issues) {
      if (issue.code === "ATTACHMENTS_NOT_SUPPORTED") attachments = true;
      const pointer = toPointer(issue.field);
      // 같은 위치에 이미 오류가 있으면 겹쳐 보고하지 않는다.
      if (reported.has(pointer)) continue;
      errors.push({ pointer, code: CODE_MAP[issue.code] });
    }
  }

  if (errors.length > 0 || !checked.ok) {
    // 사유 우선순위: Key 오류 > 첨부 > 그 밖의 검증 실패. 파일 채널 호출처가 사유 하나로 원인을 가린다.
    const reason: SchemaFailureReason =
      keyReason ??
      (attachments ? "ATTACHMENTS_NOT_SUPPORTED" : "VALIDATION_FAILED");
    return { ok: false, reason, errors };
  }
  return { ok: true, outer: checked.value, content: jwe, idempotencyKey };
}
