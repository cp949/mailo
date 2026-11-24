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
    accountId: "default",
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

/**
 * `account_id` 컬럼이 없는 옛 스키마(0001~0009)에 작업 행을 넣는다. 구버전 인스턴스가 쓰던 INSERT와 같은 형태다.
 * 마이그레이션 일부만 적용한 schema에서 "기존 행을 바꾸지 않는다"를 확인하는 테스트가 쓴다. 현재 `register`는 `account_id`를 쓰므로 이 schema에서 못 쓴다.
 */
export async function createLegacyJob(pool: pg.Pool): Promise<string> {
  const input = jobInput();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO mail_jobs
       (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version, recipients, expires_at)
     VALUES (gen_random_uuid(), $1, $2, '\\x00', 1, '{"to":["x@example.invalid"]}', now() + interval '1 day')
     RETURNING id`,
    [input.callerId, input.idempotencyKey],
  );
  return rows[0]!.id;
}

/** 시간 경과를 흉내 내기 위해 작업 시각을 과거로 당긴다. */
export async function pastDue(pool: pg.Pool, jobId: string): Promise<void> {
  await pool.query(
    "UPDATE mail_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
    [jobId],
  );
}

/**
 * 종결 UPDATE가 본문·수신자·봉투를 비우기 전 버전이 종결한 행을 흉내 낸다(RQ-071, ADR-0015 결정 2).
 * 종결 상태와 `finished_at`만 쓰고 본문·수신자·봉투는 그대로 둔다. `deleteExpiredBodies`가 안전망으로 여전히 동작하는지 시험할 때 쓴다.
 */
export async function terminateLikeLegacyVersion(
  pool: pg.Pool,
  jobId: string,
  status: "SENT" | "FAILED" | "EXPIRED" = "SENT",
): Promise<void> {
  await pool.query(
    `UPDATE mail_jobs SET status = $2, finished_at = now(),
            lease_token = NULL, lease_until = NULL, leased_at = NULL
      WHERE id = $1`,
    [jobId, status],
  );
}
