import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrator.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";

/**
 * 마이그레이션 0012~0016(계정 단위 점유 인덱스와 레거시 인덱스 삭제, RQ-054·055, ADR-0013 결정 3·4).
 * 0001~0011을 먼저 적용해 행을 넣고 이어서 0012~0016을 적용한다. 실제 PostgreSQL을 쓴다.
 * 계획이 새 인덱스를 고르는지는 데이터가 작으면 통계에 좌우되므로 seqscan을 끈 계획으로만 "쓸 수 있는지"를 본다.
 */
const SOURCE = fileURLToPath(new URL("../../migrations", import.meta.url));
const NEW_FILES = [
  "0012_account_priority_claim_idx.sql",
  "0013_account_claim_idx.sql",
  "0014_attempt_account_quota_idx.sql",
  "0015_drop_legacy_priority_claim_idx.sql",
  "0016_drop_legacy_claim_idx.sql",
];

describe("PostgreSQL 통합: 0012~0016 계정 단위 인덱스 (RQ-054, ADR-0013 결정 4)", () => {
  let db: TestDatabase;
  let dir: string;

  const indexDef = async (name: string) =>
    (
      await db.pool.query<{ def: string; valid: boolean }>(
        `SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = $1 AND c.relnamespace = $2::regnamespace`,
        [name, db.schema],
      )
    ).rows[0];

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), "mailo-0012-"));
    for (const name of await readdir(SOURCE)) {
      if (!NEW_FILES.includes(name))
        await copyFile(path.join(SOURCE, name), path.join(dir, name));
    }
    // 0001~0011 상태에서 계정 둘의 대기 작업과 시도 기록을 넣는다.
    await runMigrations(db.pool, dir);
    await db.pool.query(
      `INSERT INTO mail_jobs
         (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version, recipients, expires_at, account_id)
       SELECT gen_random_uuid(), 'caller-a', 'k' || g, '\\x00', 1, '{}', now() + interval '1 day',
              CASE WHEN g % 2 = 0 THEN 'default' ELSE 'marketing' END
         FROM generate_series(1, 4000) g`,
    );
    for (const name of NEW_FILES)
      await copyFile(path.join(SOURCE, name), path.join(dir, name));
  });

  afterAll(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("0001~0011 상태에는 레거시 점유 인덱스 둘이 있고 새 인덱스는 없다", async () => {
    expect(await indexDef("mail_jobs_claim_idx")).toBeDefined();
    expect(await indexDef("mail_jobs_priority_claim_idx")).toBeDefined();
    expect(await indexDef("mail_jobs_account_claim_idx")).toBeUndefined();
  });

  it("0012~0016만 순서대로 적용되고 다시 실행하면 아무것도 적용하지 않는다", async () => {
    expect(await runMigrations(db.pool, dir)).toEqual(NEW_FILES);
    expect(await runMigrations(db.pool, dir)).toEqual([]);
  });

  it("새 부분 인덱스 셋이 유효하고 정의가 ADR 결정 4와 같다", async () => {
    const priority = await indexDef("mail_jobs_account_priority_claim_idx");
    const fifo = await indexDef("mail_jobs_account_claim_idx");
    const quota = await indexDef("mail_attempts_account_quota_idx");

    expect(priority?.valid).toBe(true);
    expect(priority?.def).toContain(
      "(account_id, priority DESC, next_attempt_at, id)",
    );
    expect(priority?.def).toContain("WHERE (status = ANY");
    expect(fifo?.valid).toBe(true);
    expect(fifo?.def).toContain("(account_id, next_attempt_at, id)");
    expect(fifo?.def).toContain("WHERE (status = ANY");
    expect(quota?.valid).toBe(true);
    expect(quota?.def).toContain("(account_id, finished_at)");
    expect(quota?.def).toContain("WHERE (counted AND");
  });

  it("레거시 점유 인덱스 둘이 지워졌고 같은 schema의 다른 인덱스는 남는다", async () => {
    expect(await indexDef("mail_jobs_claim_idx")).toBeUndefined();
    expect(await indexDef("mail_jobs_priority_claim_idx")).toBeUndefined();
    expect(await indexDef("mail_jobs_expiry_idx")).toBeDefined();
    expect(await indexDef("mail_jobs_lease_idx")).toBeDefined();
    expect(await indexDef("mail_attempts_quota_idx")).toBeDefined();
  });

  it("파일 다섯 개는 모두 첫 줄 표식과 문장 하나다(CONCURRENTLY는 트랜잭션 밖)", async () => {
    for (const name of NEW_FILES) {
      const text = await readFile(path.join(SOURCE, name), "utf8");
      expect(text.split("\n")[0]).toBe("-- mailo:no-transaction");
      const sql = text
        .split("\n")
        .filter((line) => !line.startsWith("--"))
        .join("\n");
      expect(sql.match(/;/g)).toHaveLength(1);
      expect(sql).toMatch(/INDEX CONCURRENTLY IF (NOT )?EXISTS/);
    }
  });

  it("파일을 직접 다시 실행해도 오류 없이 멱등이다(실패 뒤 재실행 경로)", async () => {
    for (const name of NEW_FILES) {
      const sql = await readFile(path.join(SOURCE, name), "utf8");
      await expect(db.pool.query(sql)).resolves.toBeDefined();
    }
    expect(
      (await indexDef("mail_jobs_account_priority_claim_idx"))?.valid,
    ).toBe(true);
    expect(await indexDef("mail_jobs_claim_idx")).toBeUndefined();
  });

  it("기존 작업 행은 그대로이고 계정 조건 점유 쿼리가 새 우선순위·대기 순서 인덱스를 쓸 수 있다", async () => {
    await db.pool.query("ANALYZE mail_jobs");
    const client = await db.pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      await client.query("SET enable_bitmapscan = off");
      const plan = async (order: string) =>
        (
          await client.query<{ "QUERY PLAN": string }>(
            `EXPLAIN SELECT id FROM mail_jobs
              WHERE status IN ('PENDING','RETRY_WAIT') AND next_attempt_at <= now()
                AND expires_at > now() AND account_id = 'marketing'
              ORDER BY ${order} LIMIT 4 FOR UPDATE SKIP LOCKED`,
          )
        ).rows
          .map((r) => r["QUERY PLAN"])
          .join("\n");

      expect(await plan("priority DESC, next_attempt_at, id")).toContain(
        "mail_jobs_account_priority_claim_idx",
      );
      expect(await plan("next_attempt_at, id")).toContain(
        "mail_jobs_account_claim_idx",
      );
    } finally {
      client.release();
    }
    const { rows } = await db.pool.query(
      "SELECT account_id, count(*)::int AS n FROM mail_jobs GROUP BY account_id ORDER BY 1",
    );
    expect(rows).toEqual([
      { account_id: "default", n: 2000 },
      { account_id: "marketing", n: 2000 },
    ]);
  });

  it("계정 24시간 할당 쿼리 조건이 시도 인덱스를 쓸 수 있다", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      const { rows } = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT 1 FROM mail_attempts a
          WHERE a.account_id = 'marketing' AND a.counted AND a.stage IS DISTINCT FROM 'WORKER'
            AND a.finished_at > now() - interval '24 hours' LIMIT 10`,
      );
      expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain(
        "mail_attempts_account_quota_idx",
      );
    } finally {
      client.release();
    }
  });
});
