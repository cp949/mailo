/**
 * 검증 오류 한 건의 공용 형태. REST 오류 응답의 `errors`와 파일 채널 거부 기록이 같은 값을 쓴다.
 * http가 아니라 validation이 소유한다. envelope가 http에 의존하지 않게 하기 위해서다(AGENTS.md 모듈 경계).
 * 위치(`pointer`·`parameter`)와 고정 `code`만 담고 요청 값은 담지 않는다(RQ-027).
 */
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
  | "CALLER_MISMATCH"
  /** 요청의 `from`이 호출처의 허용 발신 주소(`defaultFrom` + `allowedFrom`)에 없다. */
  | "FROM_NOT_ALLOWED"
  /** 정수지만 허용 범위 밖이다. 현재는 `ttlSeconds`의 하한·상한 위반에만 쓴다(RQ-039). */
  | "OUT_OF_RANGE";

export interface ValidationErrorItem {
  /** 본문 필드의 JSON Pointer(RFC 6901). 본문 전체는 빈 문자열이다. */
  pointer?: string;
  /** 헤더나 쿼리 파라미터 이름. */
  parameter?: string;
  code: ValidationErrorCode;
}
