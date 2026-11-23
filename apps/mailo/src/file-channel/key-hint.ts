/**
 * 거부한 파일에서 `idempotencyKey`를 가능한 경우에만 꺼낸다(ADR-0006 결정 3 "파싱된 Key").
 * 호출처가 Key로 작업을 조회하고 404이면 이벤트 피드에서 같은 Key의 `INTAKE_REJECTED`를 찾으므로
 * (ADR-0006 결정 1), Key를 기록하지 못하면 거부를 Key로 찾을 수 없다.
 *
 * 규칙
 * - 서명이 `none`인 호출처: 파일 최상위의 `idempotencyKey`.
 * - 서명이 `required`인 호출처: 서명 검증이 끝난 뒤에 난 거부 사유일 때만 `payload` 안의 `idempotencyKey`.
 *   서명을 확인하지 못한 파일의 Key는 위조일 수 있어 기록하지 않는다.
 *   서명 검증 전에 나는 사유는 `MALFORMED`, `SIGNATURE_REQUIRED`, `SIGNATURE_INVALID`다(`envelope/jws.ts`의 순서).
 * - Key 형식(ADR-0005 결정 1)을 지키는 값만 쓴다. 지키지 않으면 null이다.
 * 값은 로그에 남기지 않는다. 거부 기록의 `idempotency_key` 컬럼에만 쓴다.
 */
import type { OpenRequestReason } from "../envelope/index.js";
import { validateIdempotencyKey } from "../validation/index.js";

const UNVERIFIED_REASONS: ReadonlySet<OpenRequestReason> = new Set([
  "MALFORMED",
  "SIGNATURE_REQUIRED",
  "SIGNATURE_INVALID",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

export function peekIdempotencyKey(
  bytes: Uint8Array,
  signatureMode: "required" | "none",
  reason: OpenRequestReason,
): string | null {
  let body = parseJson(bytes);
  if (signatureMode === "required") {
    if (UNVERIFIED_REASONS.has(reason) || !isRecord(body)) return null;
    const payload = body["payload"];
    if (typeof payload !== "string") return null;
    body = parseJson(Buffer.from(payload, "base64url"));
  }
  if (!isRecord(body)) return null;
  const checked = validateIdempotencyKey(body["idempotencyKey"]);
  return checked.ok ? checked.value : null;
}
