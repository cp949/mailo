/**
 * 봉투 수집 파이프라인(`openRequest`)의 거부 사유(ADR-0008 결정 3, ADR-0006 결정 3).
 * 사유 코드와 위치(JSON Pointer)만 담는다. 요청에서 받은 값(제목, 본문, 주소, Key, 암호문)은 어디에도 넣지 않는다(RQ-027).
 */
import type { ValidationErrorItem } from "../http/index.js";

export const OPEN_REQUEST_REASONS = [
  /** JSON·JWS 구조 오류, 헤더 형식 오류, `iat` 누락. */
  "MALFORMED",
  /** 서명이 `required`인 호출처에 서명 없는 파일이 왔다. */
  "SIGNATURE_REQUIRED",
  /** `alg`가 HS256이 아니다(none 포함), 알 수 없는 `kid`, 서명 불일치. */
  "SIGNATURE_INVALID",
  /** JWS 또는 JWE의 `caller`가 요청 호출처와 다르다. */
  "CALLER_MISMATCH",
  /** JWS `iat`가 허용 기간보다 오래됐거나 허용 오차를 넘어 미래다. */
  "IAT_OUT_OF_RANGE",
  /** 스키마·입력 검증 실패(RQ-030). 복호화한 제목·본문의 검증 실패를 포함한다. */
  "VALIDATION_FAILED",
  /** `attachments` 필드가 있다(1·2단계 미지원). */
  "ATTACHMENTS_NOT_SUPPORTED",
  /** 파일 채널의 `idempotencyKey`가 없다. */
  "IDEMPOTENCY_KEY_MISSING",
  /** 파일 채널의 `idempotencyKey` 형식 위반. */
  "IDEMPOTENCY_KEY_INVALID",
  /** JWE `kid`에 맞는 개인키가 없다. */
  "KID_UNKNOWN",
  /** JWE 복호화 실패(alg·enc 불일치, 헤더·암호문 변조, 키 불일치, 형식 오류 포함). 원인을 더 구분하지 않는다. */
  "DECRYPTION_FAILED",
] as const;

export type OpenRequestReason = (typeof OPEN_REQUEST_REASONS)[number];

export interface OpenRequestFailure {
  ok: false;
  reason: OpenRequestReason;
  /** 실패한 위치(JSON Pointer). 값은 담지 않는다. 예: `/protected/iat`, `/content`, `/signature`. */
  field?: string;
  /** `VALIDATION_FAILED` 계열의 위치·코드 목록. REST 오류 응답의 `errors`가 그대로 쓴다. */
  issues?: readonly ValidationErrorItem[];
}

/** `docs/api/openapi.yaml`의 `RejectionReason`(수집 거부 기록 사유 코드)이다. */
export type RejectionReasonCode =
  | "MALFORMED"
  | "SIZE_EXCEEDED"
  | "SIGNATURE_INVALID"
  | "DECRYPTION_FAILED"
  | "IDEMPOTENCY_KEY_MISSING"
  | "IDEMPOTENCY_KEY_INVALID"
  | "FINGERPRINT_MISMATCH"
  | "VALIDATION_FAILED"
  | "ATTACHMENTS_NOT_SUPPORTED"
  | "CALLER_MISMATCH"
  | "IAT_OUT_OF_RANGE";

/**
 * 파일 채널이 `mail_intake_rejections.reason_code`에 쓸 값으로 바꾼다.
 * 계약의 사유 코드에는 `SIGNATURE_REQUIRED`와 `KID_UNKNOWN`이 없다. 각각 `SIGNATURE_INVALID`("서명 없음 또는 불일치")와
 * `DECRYPTION_FAILED`로 합친다. 파일 호출처는 알 수 없는 `kid`를 복호화 실패와 구분하지 못한다.
 */
export function toRejectionReason(
  reason: OpenRequestReason,
): RejectionReasonCode {
  switch (reason) {
    case "SIGNATURE_REQUIRED":
      return "SIGNATURE_INVALID";
    case "KID_UNKNOWN":
      return "DECRYPTION_FAILED";
    default:
      return reason;
  }
}
