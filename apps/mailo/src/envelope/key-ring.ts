/**
 * Mailo JWE 개인키 키링(ADR-0008 결정 1·5). `kid`로 개인키를 찾는다.
 * 키 공급(시크릿 파일·환경 변수 읽기, 보존 기간 검증)은 config 모듈의 일이다. 여기서는 받은 키를 검증하고 조회만 한다.
 *
 * 키 교체는 새 `kid`를 추가하는 방식이다. 이전 키는 `retiredAt`(교체 시각)부터 Key 보존 기간 이상 남긴다.
 * 이 모듈은 `retiredAt`로 키를 거르지 않는다. 지우지 않는 것이 규칙이고, 삭제 검증은 설정 로딩이 한다.
 */
import type { KeyObject } from "node:crypto";

/** 키 암호화 키 크기. ADR-0008 결정 1이 RSA 3072비트로 고정한다. */
export const RSA_MODULUS_BITS = 3072;
export const KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface PrivateKeyEntry {
  kid: string;
  privateKey: KeyObject;
  /** 교체 시각. 현재 공개 중인 키는 null이다. */
  retiredAt: Date | null;
}

export type PrivateKeyProblem = "NOT_PRIVATE" | "NOT_RSA" | "BAD_MODULUS";

/** 개인키가 RSA 3072비트인지 확인한다. 문제가 없으면 undefined다. */
export function checkPrivateKey(key: KeyObject): PrivateKeyProblem | undefined {
  if (key.type !== "private") return "NOT_PRIVATE";
  if (key.asymmetricKeyType !== "rsa") return "NOT_RSA";
  if (key.asymmetricKeyDetails?.modulusLength !== RSA_MODULUS_BITS)
    return "BAD_MODULUS";
  return undefined;
}

export class PrivateKeyRingError extends Error {
  constructor(
    readonly code:
      | "EMPTY"
      | "INVALID_KID"
      | "DUPLICATE_KID"
      | "INVALID_KEY"
      | "NO_ACTIVE_KEY",
  ) {
    // kid와 키 내용을 메시지에 넣지 않는다.
    super(`invalid private key ring (code=${code})`);
    this.name = "PrivateKeyRingError";
  }
}

export interface PrivateKeyRing {
  /** 없는 `kid`이면 undefined. */
  find(kid: string): KeyObject | undefined;
}

/** 빈 키링. 개인키를 설정하지 않으면 모든 `kid`가 알 수 없는 값이다(JWE 미사용 배치). */
export const EMPTY_PRIVATE_KEY_RING: PrivateKeyRing = { find: () => undefined };

export function createPrivateKeyRing(
  entries: readonly PrivateKeyEntry[],
): PrivateKeyRing {
  if (entries.length === 0) throw new PrivateKeyRingError("EMPTY");
  const keys = new Map<string, KeyObject>();
  for (const entry of entries) {
    if (!KID_PATTERN.test(entry.kid))
      throw new PrivateKeyRingError("INVALID_KID");
    if (keys.has(entry.kid)) throw new PrivateKeyRingError("DUPLICATE_KID");
    if (checkPrivateKey(entry.privateKey) !== undefined)
      throw new PrivateKeyRingError("INVALID_KEY");
    keys.set(entry.kid, entry.privateKey);
  }
  if (!entries.some((e) => e.retiredAt === null))
    throw new PrivateKeyRingError("NO_ACTIVE_KEY");
  return { find: (kid) => keys.get(kid) };
}
