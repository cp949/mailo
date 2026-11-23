import { randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { withTransaction } from "../db/index.js";
import { DEFAULT_PRIORITY, PRIORITY_RANK } from "./priority.js";
import type {
  JobStatus,
  RegisterDeps,
  RegisterInput,
  RegisterResult,
} from "./types.js";

// 충돌한 행이 조회 직전에 보존 삭제로 사라지는 경우를 위한 재시도 한도
const MAX_ATTEMPTS = 3;

interface ExistingRow {
  id: string;
  status: JobStatus;
  fingerprint: Buffer;
  fingerprint_key_version: number;
}

function sameDigest(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 발송 요청을 멱등하게 등록한다(ADR-0005 결정 4, ADR-0002 결정 3).
 *
 * 1. `INSERT ... ON CONFLICT (caller_id, idempotency_key) DO NOTHING`
 * 2. 충돌했으면 별도 문장으로 기존 행을 조회한다. READ COMMITTED에서는 충돌 상대가 커밋된 뒤의 행이 보인다.
 * 3. 저장된 `fingerprint_key_version`의 키로 지문을 다시 계산해 비교한다. 같으면 duplicate, 다르면 mismatch다.
 *
 * `denyNew`이면 1을 건너뛰고 기존 행이 있을 때만 2~3을 한다. 없으면 `denied`다.
 *
 * 본문 암호화는 INSERT 전에 한다. `jobId`가 AAD라서 먼저 만들어야 하기 때문이다(ADR-0008 결정 6).
 * 그래서 중복 요청도 암호화 비용을 한 번 쓴다.
 */
export async function register(
  pool: pg.Pool,
  deps: RegisterDeps,
  input: RegisterInput,
): Promise<RegisterResult> {
  const jobId = randomUUID();
  const body = await deps.cipher.encrypt(jobId, input.body);
  const current = deps.fingerprinter.fingerprint(input.canonicalRequest);

  for (let round = 0; round < MAX_ATTEMPTS; round += 1) {
    const result = await withTransaction(
      pool,
      async (client): Promise<RegisterResult | null> => {
        // `denyNew`이면 INSERT 없이 기존 행만 본다.
        if (!input.denyNew) {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO mail_jobs
               (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version,
                recipients, envelope, body_ciphertext, body_nonce, body_key_version, expires_at,
                priority, account_id)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10,
                     now() + make_interval(secs => $11::double precision), $12, $13)
             ON CONFLICT (caller_id, idempotency_key) DO NOTHING
             RETURNING id`,
            [
              jobId,
              input.callerId,
              input.idempotencyKey,
              Buffer.from(current.digest),
              current.keyVersion,
              JSON.stringify(input.recipients),
              JSON.stringify(input.envelope ?? {}),
              Buffer.from(body.ciphertext),
              Buffer.from(body.nonce),
              body.keyVersion,
              input.expiresInSeconds,
              PRIORITY_RANK[input.priority ?? DEFAULT_PRIORITY],
              input.accountId,
            ],
          );
          if (inserted.rowCount === 1) return { kind: "created", jobId };
        }

        // 충돌했다(또는 `denyNew`다). 별도 문장으로 기존 행을 조회한다.
        const existing = await client.query<ExistingRow>(
          `SELECT id, status, fingerprint, fingerprint_key_version
             FROM mail_jobs WHERE caller_id = $1 AND idempotency_key = $2`,
          [input.callerId, input.idempotencyKey],
        );
        const row = existing.rows[0];
        if (!row) return input.denyNew ? { kind: "denied" } : null;

        const stored = deps.fingerprinter.fingerprint(
          input.canonicalRequest,
          row.fingerprint_key_version,
        );
        if (sameDigest(stored.digest, row.fingerprint)) {
          return { kind: "duplicate", jobId: row.id, status: row.status };
        }
        return { kind: "fingerprint_mismatch" };
      },
    );
    if (result) return result;
  }
  throw new Error("등록 충돌 뒤 기존 작업을 찾지 못했다");
}
