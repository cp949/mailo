/**
 * JWE(compact) 복호화(ADR-0008 결정 1). 암호 형식을 직접 만들지 않고 `jose`에 맡긴다(RQ-029).
 * - 키 암호화 `alg`는 `RSA-OAEP-256`, 콘텐츠 암호화 `enc`는 `A256GCM`만 받는다. 다른 값은 복호화를 시도하지 않는다.
 * - `kid`로 개인키를 고른다. 없으면 `KID_UNKNOWN`이다.
 * - `caller`는 복호화에 성공한 뒤 확인한다. protected header는 AAD로 인증되므로, 성공한 뒤의 값만 믿을 수 있다.
 *   헤더를 바꾸면 `caller` 검사에 이르기 전에 `DECRYPTION_FAILED`다.
 * - 실패 사유는 세 가지로만 알린다. jose의 오류 메시지·원인은 버린다(오류에 값이 섞이지 않게 한다, RQ-027).
 */
import { compactDecrypt, decodeProtectedHeader } from "jose";
import type { PrivateKeyRing } from "./key-ring.js";

export const JWE_KEY_ALG = "RSA-OAEP-256";
export const JWE_CONTENT_ENC = "A256GCM";

export type JweFailureReason =
  | "KID_UNKNOWN"
  | "DECRYPTION_FAILED"
  | "CALLER_MISMATCH";

export type JweDecryptResult =
  | { ok: true; plaintext: Uint8Array }
  | { ok: false; reason: JweFailureReason };

export interface JweDecryptor {
  /** `expectedCaller`는 요청의 `caller_id`다. protected header의 `caller`와 같아야 한다. */
  decrypt(compact: string, expectedCaller: string): Promise<JweDecryptResult>;
}

export function createJweDecryptor(keyRing: PrivateKeyRing): JweDecryptor {
  return {
    async decrypt(compact, expectedCaller) {
      let header;
      try {
        header = decodeProtectedHeader(compact);
      } catch {
        return { ok: false, reason: "DECRYPTION_FAILED" };
      }
      if (header.alg !== JWE_KEY_ALG || header.enc !== JWE_CONTENT_ENC)
        return { ok: false, reason: "DECRYPTION_FAILED" };
      // 압축(zip)과 crit 확장은 쓰지 않는다. 압축 폭탄과 알 수 없는 확장을 막는다.
      if ("zip" in header || "crit" in header)
        return { ok: false, reason: "DECRYPTION_FAILED" };

      const key =
        typeof header.kid === "string" ? keyRing.find(header.kid) : undefined;
      if (key === undefined) return { ok: false, reason: "KID_UNKNOWN" };

      try {
        const result = await compactDecrypt(compact, key, {
          keyManagementAlgorithms: [JWE_KEY_ALG],
          contentEncryptionAlgorithms: [JWE_CONTENT_ENC],
        });
        if (result.protectedHeader.caller !== expectedCaller)
          return { ok: false, reason: "CALLER_MISMATCH" };
        return { ok: true, plaintext: result.plaintext };
      } catch {
        return { ok: false, reason: "DECRYPTION_FAILED" };
      }
    },
  };
}
