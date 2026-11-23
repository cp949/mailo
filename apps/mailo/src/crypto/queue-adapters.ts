/**
 * 큐 모듈(`queue/types.ts`)이 요구하는 BodyCipher·Fingerprinter 모양에 crypto 구현을 맞추는 어댑터.
 * crypto가 queue를 import하지 않도록 구조만 같게 선언한다(모듈 경계, AGENTS.md).
 *
 * 큐에 넘기는 본문 평문 바이트는 UTF-8 JSON `{"v":1, "subject": string, "text": string|null, "html": string|null}`이다.
 * `src/worker/body-content.ts`가 정한 형식과 같다. 암호화 때 이 JSON을 `BodyContent`로 읽어 AES-256-GCM으로
 * 봉인하고(ADR-0008 결정 6), 복호화 때 같은 모양의 JSON 바이트를 돌려준다. `v`는 생략해도 받는다.
 */
import {
  BodyCipherError,
  type BodyCipher,
  type BodyContent,
} from "./body-cipher.js";
import { fingerprintCanonical } from "./fingerprint.js";
import type { KeyRing } from "./key-ring.js";

const NONCE_BYTES = 12;

export interface QueueEncryptedBody {
  /** `암호문 || GCM 태그`. */
  ciphertext: Uint8Array;
  /** 96비트 난수. */
  nonce: Uint8Array;
  keyVersion: number;
}

export interface QueueBodyCipher {
  encrypt(jobId: string, plaintext: Uint8Array): QueueEncryptedBody;
  decrypt(jobId: string, body: QueueEncryptedBody): Uint8Array;
}

export interface QueueFingerprinter {
  fingerprint(
    canonicalRequest: string,
    keyVersion?: number,
  ): { digest: Uint8Array; keyVersion: number };
}

/** 본문 JSON 바이트의 모양을 확인한다. 오류에 값을 넣지 않는다. */
function parseBodyContent(plaintext: Uint8Array, jobId: string): BodyContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(plaintext).toString("utf8"));
  } catch {
    throw new BodyCipherError("MALFORMED_PLAINTEXT", jobId);
  }
  const rec = parsed as Record<string, unknown> | null;
  const nullableString = (v: unknown): v is string | null =>
    v === null || typeof v === "string";
  if (
    rec === null ||
    typeof rec !== "object" ||
    typeof rec["subject"] !== "string" ||
    !nullableString(rec["text"]) ||
    !nullableString(rec["html"])
  ) {
    throw new BodyCipherError("MALFORMED_PLAINTEXT", jobId);
  }
  return { subject: rec["subject"], text: rec["text"], html: rec["html"] };
}

export function createQueueBodyCipher(cipher: BodyCipher): QueueBodyCipher {
  return {
    encrypt(jobId, plaintext) {
      const sealed = cipher.encrypt(jobId, parseBodyContent(plaintext, jobId));
      return {
        nonce: sealed.sealed.subarray(0, NONCE_BYTES),
        ciphertext: sealed.sealed.subarray(NONCE_BYTES),
        keyVersion: sealed.keyVersion,
      };
    },
    decrypt(jobId, body) {
      const content = cipher.decrypt(jobId, {
        keyVersion: body.keyVersion,
        sealed: Buffer.concat([body.nonce, body.ciphertext]),
      });
      return Buffer.from(
        JSON.stringify({
          v: 1,
          subject: content.subject,
          text: content.text,
          html: content.html,
        }),
        "utf8",
      );
    },
  };
}

export function createQueueFingerprinter(keyRing: KeyRing): QueueFingerprinter {
  return {
    fingerprint: (canonicalRequest, keyVersion) =>
      fingerprintCanonical(keyRing, canonicalRequest, keyVersion),
  };
}
