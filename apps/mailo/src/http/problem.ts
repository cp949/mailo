/**
 * RFC 9457 problem details(docs/api/openapi.yaml `Problem`).
 * 규칙: `title`은 type마다 고정 문구, `detail`은 고정 문구이고, `errors`는 위치(`pointer`·`parameter`)와 고정 `code`만 담는다.
 * 요청에서 받은 값(제목, text, html, 주소, Key, 암호문)은 어디에도 넣지 않는다(RQ-027, AGENTS.md).
 */

export type ProblemType =
  | "malformed-request"
  | "validation-failed"
  | "unauthorized"
  | "not-found"
  | "idempotency-conflict"
  | "payload-too-large"
  | "unsupported-media-type"
  | "service-unavailable";

export type ValidationErrorCode =
  | "REQUIRED"
  | "INVALID_FORMAT"
  | "TOO_LONG"
  | "TOO_MANY"
  | "TOO_LARGE"
  | "CONTROL_CHARACTER"
  | "UNKNOWN_FIELD"
  | "ATTACHMENTS_NOT_SUPPORTED"
  | "CONFLICTING_FIELDS"
  | "DECRYPTION_FAILED"
  | "KID_UNKNOWN"
  | "CALLER_MISMATCH";

export interface ValidationErrorItem {
  /** 본문 필드의 JSON Pointer(RFC 6901). 본문 전체는 빈 문자열이다. */
  pointer?: string;
  /** 헤더나 쿼리 파라미터 이름. */
  parameter?: string;
  code: ValidationErrorCode;
}

const CATALOG: Record<
  ProblemType,
  { status: number; title: string; detail: string }
> = {
  "malformed-request": {
    status: 400,
    title: "Malformed request",
    detail: "요청 본문이 올바른 JSON이 아니다.",
  },
  "validation-failed": {
    status: 400,
    title: "Validation failed",
    detail: "요청이 검증을 통과하지 못했다. errors를 확인한다.",
  },
  unauthorized: {
    status: 401,
    title: "Unauthorized",
    detail: "인증에 실패했다.",
  },
  "not-found": {
    status: 404,
    title: "Not found",
    detail: "대상을 찾을 수 없다.",
  },
  "idempotency-conflict": {
    status: 409,
    title: "Idempotency-Key conflict",
    detail: "같은 Idempotency-Key로 다른 내용의 요청이 이미 등록되어 있다.",
  },
  "payload-too-large": {
    status: 413,
    title: "Payload too large",
    detail: "요청 본문이 크기 상한을 넘었다.",
  },
  "unsupported-media-type": {
    status: 415,
    title: "Unsupported media type",
    detail: "Content-Type은 application/json이어야 한다.",
  },
  "service-unavailable": {
    status: 503,
    title: "Service unavailable",
    detail:
      "일시적으로 요청을 처리할 수 없다. 같은 Idempotency-Key로 다시 시도한다.",
  },
};

export class ProblemException extends Error {
  readonly status: number;

  constructor(
    readonly problemType: ProblemType,
    readonly options: {
      errors?: readonly ValidationErrorItem[];
      /** 응답 본문에 더할 고정 필드(예: 409의 `jobId`). 요청 값을 넣지 않는다. */
      extra?: Record<string, string>;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(`problem ${problemType}`);
    this.name = "ProblemException";
    this.status = CATALOG[problemType].status;
  }

  /** `instance`는 요청 ID(`urn:uuid:<id>`)다. 서버 로그의 같은 값과 대조한다. */
  toBody(requestId: string): Record<string, unknown> {
    const entry = CATALOG[this.problemType];
    return {
      type: `urn:mailo:problem:${this.problemType}`,
      title: entry.title,
      status: entry.status,
      detail: entry.detail,
      instance: `urn:uuid:${requestId}`,
      ...(this.options.errors !== undefined
        ? { errors: this.options.errors }
        : {}),
      ...this.options.extra,
    };
  }
}

export const problems = {
  malformedRequest: () => new ProblemException("malformed-request"),
  validationFailed: (errors: readonly ValidationErrorItem[]) =>
    new ProblemException("validation-failed", { errors }),
  // 자격 없음, 형식 오류, 틀린 키를 구분하지 않는다. 항상 같은 응답이다.
  unauthorized: () =>
    new ProblemException("unauthorized", {
      headers: { "WWW-Authenticate": "Bearer" },
    }),
  notFound: () => new ProblemException("not-found"),
  idempotencyConflict: (jobId: string | null) =>
    new ProblemException(
      "idempotency-conflict",
      jobId !== null ? { extra: { jobId } } : {},
    ),
  payloadTooLarge: () =>
    new ProblemException("payload-too-large", {
      headers: { Connection: "close" },
    }),
  unsupportedMediaType: () => new ProblemException("unsupported-media-type"),
  serviceUnavailable: () => new ProblemException("service-unavailable"),
};
