/**
 * API 키 해시와 상수 시간 비교(RQ-028). 키는 256비트 난수이므로 느린 해시(bcrypt 등) 없이
 * SHA-256 한 번이면 충분하다. 사람이 고른 비밀번호처럼 사전 대입이 가능한 입력이 아니기 때문이다.
 * 레지스트리에는 해시(hex)만 저장한다. 평문은 로그와 오류에 넣지 않는다.
 */
import { createHash, timingSafeEqual } from "node:crypto";

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** SHA-256 hex(소문자 64자). */
export function hashApiKey(plain: string): string {
  return createHash("sha256").update(plain, "utf8").digest("hex");
}

/**
 * 제시한 키가 저장된 해시와 같은지 상수 시간으로 비교한다.
 * 제시 값을 먼저 해시해 길이를 32바이트로 맞추므로 입력 길이에 따라 비교 시간이 달라지지 않는다.
 * 저장 값 형식이 잘못돼도 같은 경로로 비교하고 false를 돌려준다.
 */
export function verifyApiKey(
  presented: string,
  storedHashHex: string,
): boolean {
  const presentedHash = createHash("sha256").update(presented, "utf8").digest();
  const wellFormed = HEX_SHA256.test(storedHashHex);
  const stored = wellFormed
    ? Buffer.from(storedHashHex, "hex")
    : Buffer.alloc(presentedHash.length);
  return timingSafeEqual(presentedHash, stored) && wellFormed;
}

/** 호출처당 키 2개 동시 허용(RQ-028). 앞에서 맞아도 끝까지 비교해 어느 키가 맞는지 시간으로 드러내지 않는다. */
export function verifyApiKeyAgainstAny(
  presented: string,
  storedHashes: readonly string[],
): boolean {
  let matched = false;
  for (const hash of storedHashes) {
    if (verifyApiKey(presented, hash)) matched = true;
  }
  return matched;
}
