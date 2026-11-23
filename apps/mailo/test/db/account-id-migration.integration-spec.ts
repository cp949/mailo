import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrator.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";

/**
 * 마이그레이션 0010·0011(작업·시도 행의 account_id, RQ-054, ADR-0013 결정 4).
 * 0001~0009를 먼저 적용해 행을 넣고, 이어서 0010·0011을 적용해 기존 행이 `default`로 보이는지 확인한다.
 * 실제 PostgreSQL을 쓴다. 표를 다시 쓰지 않는지는 `pg_class.relfilenode` 불변으로 본다.
 */
const SOURCE = fileURLToPath(new URL("../../migrations", import.meta.url));

describe("PostgreSQL 통합: 0010·0011 account_id 컬럼 (RQ-054, ADR-0013 결정 4)", () => {
  let db: TestDatabase;
  let dir: string;
  const filenodes: Record<string, string> = {};

  async function filenode(table: string): Promise<string> {
    const { rows } = await db.pool.query<{ f: string }>(
      `SELECT relfilenode::text AS f FROM pg_class
        WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)`,
      [table, db.schema],
    );
    return rows[0]!.f;
  }

  async function insertLegacyJob(id: string, key: string): Promise<void> {
    // 0010 전 스키마(account_id 없음)에 구버전 코드가 쓰는 형태의 INSERT다.
    await db.pool.query(
      `INSERT INTO mail_jobs
         (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version, recipients, expires_at)
       VALUES ($1, 'caller-a', $2, '\\x00', 1, '{"to":["x@example.invalid"]}', now() + interval '1 day')`,
      [id, key],
    );
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), "mailo-0010-"));
    for (const name of await readdir(SOURCE)) {
      if (/^000[1-9]_/.test(name))
        await copyFile(path.join(SOURCE, name), path.join(dir, name));
    }
    await runMigrations(db.pool, dir);
    await insertLegacyJob("00000000-0000-4000-8000-000000000001", "legacy-1");
    await db.pool.query(
      `INSERT INTO mail_attempts (job_id, classification, counted, started_at, caller_id)
       VALUES ('00000000-0000-4000-8000-000000000001', 'SENT', true, now(), 'caller-a')`,
    );
    filenodes["mail_jobs"] = await filenode("mail_jobs");
    filenodes["mail_attempts"] = await filenode("mail_attempts");
    await copyFile(
      path.join(SOURCE, "0010_job_account_id.sql"),
      path.join(dir, "0010_job_account_id.sql"),
    );
    await copyFile(
      path.join(SOURCE, "0011_attempt_account_id.sql"),
      path.join(dir, "0011_attempt_account_id.sql"),
    );
  });

  afterAll(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("0010·0011을 적용하면 두 파일만 적용되고 다시 실행하면 아무것도 적용하지 않는다", async () => {
    expect(await runMigrations(db.pool, dir)).toEqual([
      "0010_job_account_id.sql",
      "0011_attempt_account_id.sql",
    ]);
    expect(await runMigrations(db.pool, dir)).toEqual([]);
  });

  it("기존 행은 백필 없이 default로 보이고 표를 다시 쓰지 않는다(relfilenode 불변)", async () => {
    const job = await db.pool.query(
      "SELECT account_id FROM mail_jobs WHERE id = '00000000-0000-4000-8000-000000000001'",
    );
    expect(job.rows).toEqual([{ account_id: "default" }]);
    const attempt = await db.pool.query("SELECT account_id FROM mail_attempts");
    expect(attempt.rows).toEqual([{ account_id: "default" }]);
    expect(await filenode("mail_jobs")).toBe(filenodes["mail_jobs"]);
    expect(await filenode("mail_attempts")).toBe(filenodes["mail_attempts"]);
  });

  it("컬럼은 text NOT NULL DEFAULT 'default'이다", async () => {
    const { rows } = await db.pool.query(
      `SELECT table_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1 AND column_name = 'account_id'
        ORDER BY table_name`,
      [db.schema],
    );
    expect(rows).toEqual([
      {
        table_name: "mail_attempts",
        data_type: "text",
        is_nullable: "NO",
        column_default: "'default'::text",
      },
      {
        table_name: "mail_jobs",
        data_type: "text",
        is_nullable: "NO",
        column_default: "'default'::text",
      },
    ]);
  });

  it("형식 CHECK는 NOT VALID로 추가된다(기존 행을 훑지 않는다)", async () => {
    const { rows } = await db.pool.query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('mail_jobs_account_id_format', 'mail_attempts_account_id_format')
          AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
        ORDER BY conname`,
      [db.schema],
    );
    expect(rows).toEqual([
      { conname: "mail_attempts_account_id_format", convalidated: false },
      { conname: "mail_jobs_account_id_format", convalidated: false },
    ]);
  });

  it("컬럼 없이 쓰는 구버전의 INSERT는 default 계정이 된다(롤링 배포 호환)", async () => {
    await insertLegacyJob("00000000-0000-4000-8000-000000000002", "legacy-2");
    const { rows } = await db.pool.query(
      "SELECT account_id FROM mail_jobs WHERE id = '00000000-0000-4000-8000-000000000002'",
    );
    expect(rows).toEqual([{ account_id: "default" }]);
  });

  it.each(["Marketing", "unregistered ", "a@b", "", "-lead", "a".repeat(33)])(
    "형식이 틀린 account_id(%j)는 새 행에서 23514로 거부한다",
    async (value) => {
      await expect(
        db.pool.query(
          `INSERT INTO mail_jobs
           (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version, recipients, expires_at, account_id)
         VALUES (gen_random_uuid(), 'caller-a', gen_random_uuid()::text, '\\x00', 1, '{}', now() + interval '1 day', $1)`,
          [value],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "mail_jobs_account_id_format",
      });
    },
  );

  it("시도 행도 같은 규칙으로 거부하고 올바른 ID는 받는다", async () => {
    await expect(
      db.pool.query(
        `INSERT INTO mail_attempts (job_id, classification, counted, started_at, account_id)
         VALUES ('00000000-0000-4000-8000-000000000001', 'SENT', true, now(), 'Bad Id')`,
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "mail_attempts_account_id_format",
    });
    await db.pool.query(
      `INSERT INTO mail_attempts (job_id, classification, counted, started_at, account_id)
       VALUES ('00000000-0000-4000-8000-000000000001', 'SENT', true, now(), 'marketing')`,
    );
  });
});
