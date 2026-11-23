import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { register } from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  createJob,
  jobInput,
  migrate,
  registerDeps,
  testCipher,
  testFingerprinter,
} from "../support/queue-fixtures.js";

describe("PostgreSQL 통합: 멱등 등록(RQ-004, RQ-012, ADR-0005)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  afterAll(async () => {
    await db.close();
  });

  it("같은 Key의 동시 요청 20건에서 신규 등록은 하나뿐이다", async () => {
    const input = jobInput({ idempotencyKey: "concurrent-key" });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => register(db.pool, registerDeps, input)),
    );

    const created = results.filter((r) => r.kind === "created");
    const duplicates = results.filter((r) => r.kind === "duplicate");
    expect(created).toHaveLength(1);
    expect(duplicates).toHaveLength(19);
    const createdId = created[0]!.kind === "created" ? created[0]!.jobId : "";
    for (const dup of duplicates) {
      expect(dup.kind === "duplicate" && dup.jobId).toBe(createdId);
    }
    const { rows } = await db.pool.query(
      "SELECT 1 FROM mail_jobs WHERE idempotency_key = 'concurrent-key'",
    );
    expect(rows).toHaveLength(1);
  });

  it("같은 Key에 다른 내용이면 지문 불일치로 거부하고 기존 작업을 바꾸지 않는다", async () => {
    const first = jobInput({
      idempotencyKey: "mismatch-key",
      canonicalRequest: "cc=a@example.invalid",
    });
    expect((await register(db.pool, registerDeps, first)).kind).toBe("created");

    const second = await register(db.pool, registerDeps, {
      ...first,
      canonicalRequest: "cc=b@example.invalid",
    });

    expect(second).toEqual({ kind: "fingerprint_mismatch" });
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM mail_jobs WHERE idempotency_key = 'mismatch-key'",
    );
    expect(rows[0].n).toBe(1);
  });

  it("denyNew는 새 Key를 등록하지 않고(denied), 이미 등록된 Key는 기존 판정(duplicate·지문 불일치)을 따른다(RQ-012, 발신 주소 정책)", async () => {
    const input = jobInput({ idempotencyKey: "deny-new-key" });

    const denied = await register(db.pool, registerDeps, {
      ...input,
      denyNew: true,
    });
    expect(denied).toEqual({ kind: "denied" });
    const none = await db.pool.query(
      "SELECT 1 FROM mail_jobs WHERE idempotency_key = 'deny-new-key'",
    );
    expect(none.rows).toHaveLength(0);

    const created = await register(db.pool, registerDeps, input);
    expect(created.kind).toBe("created");
    const duplicate = await register(db.pool, registerDeps, {
      ...input,
      denyNew: true,
    });
    const mismatch = await register(db.pool, registerDeps, {
      ...input,
      canonicalRequest: "cc=other@example.invalid",
      denyNew: true,
    });

    expect(duplicate.kind).toBe("duplicate");
    expect(mismatch).toEqual({ kind: "fingerprint_mismatch" });
  });

  it("지문 키를 교체한 뒤에도 저장된 키 버전으로 비교해 정상 재시도를 중복으로 본다", async () => {
    const input = jobInput({ idempotencyKey: "rotation-key" });
    await register(db.pool, registerDeps, input);
    const rotated = { ...registerDeps, fingerprinter: testFingerprinter(2) };

    const retry = await register(db.pool, rotated, input);
    const other = await register(
      db.pool,
      rotated,
      jobInput({ idempotencyKey: "rotation-key-2" }),
    );

    expect(retry.kind).toBe("duplicate");
    expect(other.kind).toBe("created");
    const { rows } = await db.pool.query(
      "SELECT idempotency_key, fingerprint_key_version AS v FROM mail_jobs WHERE idempotency_key LIKE 'rotation-key%' ORDER BY 1",
    );
    expect(rows.map((r) => r.v)).toEqual([1, 2]);
  });

  it("호출처가 다르면 같은 Key를 각각 신규로 등록한다", async () => {
    const a = await register(
      db.pool,
      registerDeps,
      jobInput({ callerId: "caller-a", idempotencyKey: "shared-key" }),
    );
    const b = await register(
      db.pool,
      registerDeps,
      jobInput({ callerId: "caller-b", idempotencyKey: "shared-key" }),
    );
    expect([a.kind, b.kind]).toEqual(["created", "created"]);
  });

  it("본문은 암호문으로 저장되고 jobId가 AAD라서 다른 행의 ID로는 복호화되지 않는다(RQ-023)", async () => {
    const canary = "CANARY-본문-평문";
    const id = await createJob(db.pool, { body: Buffer.from(canary) });
    const other = await createJob(db.pool);
    const { rows } = await db.pool.query(
      "SELECT body_ciphertext, body_nonce, body_key_version FROM mail_jobs WHERE id = $1",
      [id],
    );
    const row = rows[0];

    expect(Buffer.from(row.body_ciphertext).includes(Buffer.from(canary))).toBe(
      false,
    );
    expect(row.body_nonce).toHaveLength(12);
    const body = {
      ciphertext: row.body_ciphertext,
      nonce: row.body_nonce,
      keyVersion: row.body_key_version,
    };
    expect(Buffer.from(await testCipher.decrypt(id, body)).toString()).toBe(
      canary,
    );
    await expect(
      Promise.resolve().then(() => testCipher.decrypt(other, body)),
    ).rejects.toThrow();
  });
});
