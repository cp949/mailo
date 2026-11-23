import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { runMigrations } from "../../src/db/migrator.js";
import {
  defaultBreakerConfig,
  defaultRetryPolicy,
  register,
  type BodyCipher,
  type CompleteDeps,
  type Fingerprinter,
  type RegisterDeps,
  type RegisterInput,
} from "../../src/queue/index.js";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);

export async function migrate(pool: pg.Pool): Promise<void> {
  await runMigrations(pool, MIGRATIONS_DIR);
}

// 테스트용 가짜 키. 실제 시크릿이 아니다.
const FAKE_BODY_KEY = Buffer.alloc(32, 7);

/** AAD가 jobId인 AES-256-GCM. 큐 테스트가 `BodyCipher` 자리에 주입하는 테스트용 구현이다. */
export const testCipher: BodyCipher = {
  encrypt(jobId, plaintext) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", FAKE_BODY_KEY, nonce);
    cipher.setAAD(Buffer.from(jobId));
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      ciphertext: Buffer.concat([enc, cipher.getAuthTag()]),
      nonce,
      keyVersion: 1,
    };
  },
  decrypt(jobId, body) {
    const data = Buffer.from(body.ciphertext);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      FAKE_BODY_KEY,
      Buffer.from(body.nonce),
    );
    decipher.setAAD(Buffer.from(jobId));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([
      decipher.update(data.subarray(0, data.length - 16)),
      decipher.final(),
    ]);
  },
};

/** 버전별 HMAC 키를 가진 테스트용 지문기. 현재 버전은 `current`다. */
export function testFingerprinter(current = 1): Fingerprinter {
  return {
    fingerprint(canonicalRequest, keyVersion) {
      const version = keyVersion ?? current;
      const key = Buffer.alloc(32, 100 + version);
      return {
        digest: createHmac("sha256", key).update(canonicalRequest).digest(),
        keyVersion: version,
      };
    },
  };
}

export const registerDeps: RegisterDeps = {
  cipher: testCipher,
  fingerprinter: testFingerprinter(),
};

/** 지터 없는 결정적 재시도 정책과 기본 차단기 설정 */
export function completeDeps(
  overrides: Partial<CompleteDeps["retry"]> = {},
): CompleteDeps {
  return {
    retry: { ...defaultRetryPolicy(), jitterRatio: 0, ...overrides },
    breaker: defaultBreakerConfig(),
  };
}

let sequence = 0;

export function jobInput(
  overrides: Partial<RegisterInput> = {},
): RegisterInput {
  sequence += 1;
  const key = overrides.idempotencyKey ?? `key-${process.pid}-${sequence}`;
  return {
    callerId: "caller-a",
    idempotencyKey: key,
    recipients: { to: ["to@example.invalid"] },
    envelope: { from: "from@example.invalid" },
    body: Buffer.from("제목과 본문"),
    canonicalRequest: `canonical:${key}`,
    expiresInSeconds: 86_400,
    ...overrides,
  };
}

/** 작업을 등록하고 ID를 반환한다. */
export async function createJob(
  pool: pg.Pool,
  overrides: Partial<RegisterInput> = {},
): Promise<string> {
  const result = await register(pool, registerDeps, jobInput(overrides));
  if (result.kind !== "created") throw new Error("신규 등록이 아니다");
  return result.jobId;
}

/** 시간 경과를 흉내 내기 위해 작업 시각을 과거로 당긴다. */
export async function pastDue(pool: pg.Pool, jobId: string): Promise<void> {
  await pool.query(
    "UPDATE mail_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
    [jobId],
  );
}
