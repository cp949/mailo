import type { ValidationErrorItem } from "../http/index.js";
import type { OpenRequestFailure } from "../envelope/index.js";

/**
 * `openRequest` 실패를 REST 오류 항목(`errors`)으로 바꾼다. 위치와 고정 코드만 담는다(RQ-027).
 * 스키마·입력 검증 실패는 `issues`를 그대로 쓴다. 암호 관련 실패는 모두 `/content` 위치다.
 * REST는 서명을 쓰지 않으므로 서명·`iat` 사유는 나오지 않는다. 방어적으로 `INVALID_FORMAT`으로 둔다.
 */
export function presentOpenFailure(
  failure: OpenRequestFailure,
): ValidationErrorItem[] {
  if (failure.issues !== undefined && failure.issues.length > 0)
    return [...failure.issues];
  switch (failure.reason) {
    case "KID_UNKNOWN":
      return [{ pointer: "/content", code: "KID_UNKNOWN" }];
    case "DECRYPTION_FAILED":
      return [{ pointer: "/content", code: "DECRYPTION_FAILED" }];
    case "CALLER_MISMATCH":
      return [{ pointer: "/content", code: "CALLER_MISMATCH" }];
    default:
      return [{ pointer: failure.field ?? "", code: "INVALID_FORMAT" }];
  }
}
