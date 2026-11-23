/**
 * 파일 서명(flattened JWS, HS256) 검증(ADR-0008 결정 2·4).
 *
 * 형식(구현 중 확정, ADR-0008 "구현 중 확정" 절)
 * ```json
 * { "protected": "<b64url {alg,kid,caller,iat}>", "payload": "<b64url 요청 JSON>", "signature": "<b64url>" }
 * ```
 * - 최상위는 이 세 필드뿐이다. unprotected `header`와 `signatures`는 서명 범위 밖이므로 받지 않는다.
 * - protected header는 `alg`(HS256 고정), `kid`, `caller`, `iat`(초 단위 숫자) 네 개만 받는다. 다른 필드(`crit`, `b64`, `jwk` 등)는 거부한다.
 * - `caller`와 `iat`는 서명 범위인 protected header에 둔다. payload는 요청 JSON 그대로여야 하기 때문이다.
 * - 서명 키는 호출처가 가진 키 중 `kid`가 같은 것이다. 요청 호출처(폴더의 `caller_id`)의 키만 쓴다.
 *   다른 호출처 키로 서명한 파일은 `SIGNATURE_INVALID`다. 호출처 키 목록을 서로 노출하지 않는다.
 * - `caller`와 `iat`는 서명 검증에 성공한 뒤에만 믿는다.
 *
 * 서명 검증은 `jose`의 flattenedVerify에 맡긴다(RQ-029). 실패 원인은 알리지 않는다.
 */
import { flattenedVerify } from "jose";
import type { OpenRequestFailure } from "./reasons.js";

export const JWS_ALG = "HS256";

export interface JwsKey {
  kid: string;
  /** HS256 비밀키 32바이트. 값은 `reveal()`로만 꺼낸다. */
  secret: { reveal(): Uint8Array };
}

export interface IatPolicy {
  /** 서명 허용 기간(초). 이보다 오래된 `iat`는 거부한다. */
  maxAgeSeconds: number;
  /** 허용 오차(초). 이보다 미래인 `iat`는 거부한다. */
  skewSeconds: number;
}

export interface JwsContext {
  callerId: string;
  keys: readonly JwsKey[];
  iat: IatPolicy;
  nowMs: number;
}

export type JwsOpenResult =
  | { ok: true; payload: Uint8Array }
  | OpenRequestFailure;

const TOP_FIELDS = ["protected", "payload", "signature"] as const;
const HEADER_FIELDS = new Set(["alg", "kid", "caller", "iat"]);
const B64URL = /^[A-Za-z0-9_-]*$/;
const KID_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CALLER_TEXT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 최상위 JSON이 JWS 모양을 하고 있는지만 본다. 서명 없는 평문 요청과 구분하는 데 쓴다. */
export function looksLikeJws(value: unknown): boolean {
  return isRecord(value) && TOP_FIELDS.some((f) => Object.hasOwn(value, f));
}

function malformed(field: string): OpenRequestFailure {
  return { ok: false, reason: "MALFORMED", field };
}

/**
 * JWS 구조 파싱, 서명 검증, `caller`·`iat` 확인을 이 순서로 한다. payload 바이트를 돌려주며 JSON 해석은 호출자가 한다.
 */
export async function openJws(
  top: unknown,
  ctx: JwsContext,
): Promise<JwsOpenResult> {
  // 1. 구조 파싱
  if (!isRecord(top)) return malformed("");
  if (!looksLikeJws(top)) return { ok: false, reason: "SIGNATURE_REQUIRED" };
  for (const name of Object.keys(top)) {
    if (!(TOP_FIELDS as readonly string[]).includes(name)) return malformed("");
  }
  const { protected: protectedB64, payload, signature } = top;
  if (typeof protectedB64 !== "string" || !B64URL.test(protectedB64))
    return malformed("/protected");
  if (typeof payload !== "string" || payload === "" || !B64URL.test(payload))
    return malformed("/payload");
  if (typeof signature !== "string" || !B64URL.test(signature))
    return malformed("/signature");

  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(protectedB64, "base64url"),
      ),
    );
  } catch {
    return malformed("/protected");
  }
  if (!isRecord(header)) return malformed("/protected");

  // alg는 다른 필드보다 먼저 본다. none과 다른 알고리즘은 형식 오류가 아니라 서명 불일치다.
  if (header["alg"] !== JWS_ALG)
    return { ok: false, reason: "SIGNATURE_INVALID", field: "/protected/alg" };
  for (const name of Object.keys(header)) {
    if (!HEADER_FIELDS.has(name)) return malformed("/protected");
  }
  const { kid, caller, iat } = header;
  if (typeof kid !== "string" || !KID_TEXT.test(kid))
    return malformed("/protected/kid");
  if (typeof caller !== "string" || !CALLER_TEXT.test(caller))
    return malformed("/protected/caller");
  if (typeof iat !== "number" || !Number.isFinite(iat))
    return malformed("/protected/iat");

  // 2. 서명 검증. 이후의 caller·iat는 검증을 통과한 값이다.
  const key = ctx.keys.find((k) => k.kid === kid);
  if (key === undefined)
    return { ok: false, reason: "SIGNATURE_INVALID", field: "/protected/kid" };
  try {
    await flattenedVerify(
      { protected: protectedB64, payload, signature },
      key.secret.reveal(),
      { algorithms: [JWS_ALG] },
    );
  } catch {
    return { ok: false, reason: "SIGNATURE_INVALID", field: "/signature" };
  }

  if (caller !== ctx.callerId)
    return {
      ok: false,
      reason: "CALLER_MISMATCH",
      field: "/protected/caller",
    };
  const nowSeconds = ctx.nowMs / 1000;
  if (
    iat > nowSeconds + ctx.iat.skewSeconds ||
    nowSeconds - iat > ctx.iat.maxAgeSeconds
  )
    return {
      ok: false,
      reason: "IAT_OUT_OF_RANGE",
      field: "/protected/iat",
    };

  return { ok: true, payload: Buffer.from(payload, "base64url") };
}
