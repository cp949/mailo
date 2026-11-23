/**
 * `/ops/*`의 경로·쿼리 파라미터 검증. 오류는 파라미터 이름과 고정 코드만 담는다(요청 값은 담지 않는다, RQ-027).
 */
import { isCallerId } from "../callers/index.js";
import { isAccountId } from "../config/index.js";
import type { ValidationErrorItem } from "../validation/index.js";

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationErrorItem[] };

export const DEFAULT_AUDIT_LIMIT = 50;
export const MAX_AUDIT_LIMIT = 200;
const INT64_MAX = 9_223_372_036_854_775_807n;

export function parseCallerId(raw: string): Parsed<string> {
  return isCallerId(raw)
    ? { ok: true, value: raw }
    : {
        ok: false,
        errors: [{ parameter: "callerId", code: "INVALID_FORMAT" }],
      };
}

/** 계정 ID 형식(`^[a-z0-9][a-z0-9_-]{0,31}$`, `unregistered` 제외)을 검사한다. 구성에 있는지는 보지 않는다(ADR-0013 결정 5). */
export function parseAccountId(raw: string): Parsed<string> {
  return isAccountId(raw)
    ? { ok: true, value: raw }
    : {
        ok: false,
        errors: [{ parameter: "accountId", code: "INVALID_FORMAT" }],
      };
}

/** `limit`(1~200, 기본 50)과 `before`(양의 정수 id)를 검사한다. 같은 이름을 반복하면 오류다. */
export function parseAuditQuery(
  query: Record<string, unknown>,
): Parsed<{ limit: number; before: string | null }> {
  const errors: ValidationErrorItem[] = [];

  let limit = DEFAULT_AUDIT_LIMIT;
  const rawLimit = query["limit"];
  if (rawLimit !== undefined) {
    if (
      typeof rawLimit !== "string" ||
      !/^\d{1,6}$/.test(rawLimit) ||
      Number(rawLimit) < 1 ||
      Number(rawLimit) > MAX_AUDIT_LIMIT
    )
      errors.push({ parameter: "limit", code: "INVALID_FORMAT" });
    else limit = Number(rawLimit);
  }

  let before: string | null = null;
  const rawBefore = query["before"];
  if (rawBefore !== undefined) {
    if (
      typeof rawBefore !== "string" ||
      !/^[1-9]\d{0,18}$/.test(rawBefore) ||
      BigInt(rawBefore) > INT64_MAX
    )
      errors.push({ parameter: "before", code: "INVALID_FORMAT" });
    else before = rawBefore;
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { limit, before } };
}
