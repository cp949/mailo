/**
 * DB 본문 암호화(ADR-0008 결정 6, RQ-023). AES-256-GCM, AAD = job_id, nonce = 96비트 난수.
 *
 * 저장 형태: `sealed = nonce(12) || ciphertext || tag(16)` 한 덩어리와 `keyVersion` 정수.
 * 평문은 `{"v":1,"subject","text","html"}` JSON이다. 제목·text·html을 한 번에 암호화한다.
 *
 * nonce를 난수로 뽑으므로 한 키로 암호화할 수 있는 횟수에 NIST 권고 상한(2^32회)이 있다.
 * 이 서비스의 작업 수에서는 닿지 않지만 키 교체 주기를 정할 때 고려한다(추정).
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes as nodeRandomBytes,
} from "node:crypto";
import type { KeyRing } from "./key-ring.js";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;

export interface BodyContent {
  subject: string;
  text: string | null;
  html: string | null;
}

export interface SealedBody {
  keyVersion: number;
  sealed: Buffer;
}

export type BodyCipherErrorCode =
  | "INVALID_JOB_ID"
  | "UNKNOWN_KEY_VERSION"
  | "MALFORMED_SEALED"
  | "DECRYPT_FAILED"
  | "MALFORMED_PLAINTEXT";

/**
 * 원문(본문, 키, 원본 예외 메시지)을 담지 않는다. 식별자(jobId)와 사유 코드만 쓴다(AGENTS.md 시크릿과 로그).
 */
export class BodyCipherError extends Error {
  constructor(
    readonly code: BodyCipherErrorCode,
    readonly jobId?: string,
  ) {
    super(
      `body cipher failed (code=${code}${jobId !== undefined ? `, jobId=${jobId}` : ""})`,
    );
    this.name = "BodyCipherError";
  }
}

export interface BodyCipher {
  encrypt(jobId: string, content: BodyContent): SealedBody;
  decrypt(jobId: string, sealed: SealedBody): BodyContent;
}

export type RandomBytes = (size: number) => Buffer;

export function createBodyCipher(
  keyRing: KeyRing,
  randomBytes: RandomBytes = nodeRandomBytes,
): BodyCipher {
  return {
    encrypt(jobId, content) {
      assertJobId(jobId);
      const key = keyRing.getKey(keyRing.currentVersion);
      if (!key) throw new BodyCipherError("UNKNOWN_KEY_VERSION", jobId);

      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(Buffer.from(jobId, "utf8"));
      const plaintext = Buffer.from(
        JSON.stringify({
          v: FORMAT_VERSION,
          subject: content.subject,
          text: content.text,
          html: content.html,
        }),
        "utf8",
      );
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      return {
        keyVersion: keyRing.currentVersion,
        sealed: Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]),
      };
    },

    decrypt(jobId, body) {
      assertJobId(jobId);
      const key = keyRing.getKey(body.keyVersion);
      if (!key) throw new BodyCipherError("UNKNOWN_KEY_VERSION", jobId);
      if (body.sealed.length < NONCE_BYTES + TAG_BYTES)
        throw new BodyCipherError("MALFORMED_SEALED", jobId);

      const nonce = body.sealed.subarray(0, NONCE_BYTES);
      const tag = body.sealed.subarray(body.sealed.length - TAG_BYTES);
      const ciphertext = body.sealed.subarray(
        NONCE_BYTES,
        body.sealed.length - TAG_BYTES,
      );

      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(Buffer.from(jobId, "utf8"));
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
      } catch {
        // 원본 예외를 cause로 붙이지 않는다. 예외 메시지에 무엇이 들어가는지 통제할 수 없다.
        throw new BodyCipherError("DECRYPT_FAILED", jobId);
      }
      return parsePlaintext(plaintext, jobId);
    },
  };
}

function assertJobId(jobId: string): void {
  if (typeof jobId !== "string" || jobId.length === 0)
    throw new BodyCipherError("INVALID_JOB_ID");
}

function parsePlaintext(plaintext: Buffer, jobId: string): BodyContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new BodyCipherError("MALFORMED_PLAINTEXT", jobId);
  }
  const rec = parsed as Record<string, unknown> | null;
  const nullableString = (v: unknown): v is string | null =>
    v === null || typeof v === "string";
  if (
    rec === null ||
    typeof rec !== "object" ||
    rec["v"] !== FORMAT_VERSION ||
    typeof rec["subject"] !== "string" ||
    !nullableString(rec["text"]) ||
    !nullableString(rec["html"])
  ) {
    throw new BodyCipherError("MALFORMED_PLAINTEXT", jobId);
  }
  return { subject: rec["subject"], text: rec["text"], html: rec["html"] };
}
