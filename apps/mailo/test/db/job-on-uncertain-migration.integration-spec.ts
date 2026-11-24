import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrator.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";

/**
 * 마이그레이션 0019(작업 행의 on_uncertain, RQ-073, ADR-0015 결정 9).
 * 0001~0016을 먼저 적용해 구버전이 쓰는 형태의 행을 넣고, 이어서 0019만 적용한다.
 * 실제 PostgreSQL을 쓴다. 표를 다시 쓰지 않는지는 `pg_class.relfilenode` 불변으로 본다.
 * 0017·0018은 다른 묶음(이벤트·시도 수신자 비움)의 번호라 이 테스트가 적용하지 않는다.
 */
const SOURCE = fileURLToPath(new URL("../../migrations", import.meta.url));
const MIGRATION = "0019_job_on_uncertain.sql";
const LEGACY_ID = "00000000-0000-4000-8000-000000000001";

describe("PostgreSQL 통합: 0019 on_uncertain 컬럼 (RQ-073, ADR-0015 결정 9)", () => {
  let db: TestDatabase;
  let dir: string;
  let filenodeBefore = "";

  async function filenode(): Promise<string> {
    const { rows } = await db.pool.query<{ f: string }>(
      `SELECT relfilenode::text AS f FROM pg_class
        WHERE relname = 'mail_jobs'
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)`,
      [db.schema],
    );
    return rows[0]!.f;
  }

  // 0019 전 구버전 코드가 쓰는 형태의 INSERT다(on_uncertain을 열거하지 않는다).
  async function insertLegacyJob(id: string, key: string): Promise<void> {
    await db.pool.query(
      `INSERT INTO mail_jobs
         (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version, recipients, expires_at)
       VALUES ($1, 'caller-a', $2, '\\x00', 1, '{"to":["x@example.invalid"]}', now() + interval '1 day')`,
      [id, key],
    );
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), "mailo-0019-"));
    for (const name of await readdir(SOURCE)) {
      if (/^00(0[1-9]|1[0-6])_/.test(name))
        await copyFile(path.join(SOURCE, name), path.join(dir, name));
    }
    await runMigrations(db.pool, dir);
    await insertLegacyJob(LEGACY_ID, "legacy-1");
    filenodeBefore = await filenode();
    await copyFile(path.join(SOURCE, MIGRATION), path.join(dir, MIGRATION));
  });

  afterAll(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("0019만 적용되고 다시 실행하면 아무것도 적용하지 않는다", async () => {
    expect(await runMigrations(db.pool, dir)).toEqual([MIGRATION]);
    expect(await runMigrations(db.pool, dir)).toEqual([]);
  });

  it("기존 행은 백필 없이 retry로 보이고 표를 다시 쓰지 않는다(relfilenode 불변)", async () => {
    const { rows } = await db.pool.query(
      "SELECT on_uncertain FROM mail_jobs WHERE id = $1",
      [LEGACY_ID],
    );
    expect(rows).toEqual([{ on_uncertain: "retry" }]);
    expect(await filenode()).toBe(filenodeBefore);
  });

  it("컬럼은 text NOT NULL DEFAULT 'retry'다", async () => {
    const { rows } = await db.pool.query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'mail_jobs' AND column_name = 'on_uncertain'`,
      [db.schema],
    );
    expect(rows).toEqual([
      { data_type: "text", is_nullable: "NO", column_default: "'retry'::text" },
    ]);
  });

  it("CHECK는 NOT VALID로 추가된다(기존 행을 훑지 않는다)", async () => {
    const { rows } = await db.pool.query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname = 'mail_jobs_on_uncertain_values'
          AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)`,
      [db.schema],
    );
    expect(rows).toEqual([
      { conname: "mail_jobs_on_uncertain_values", convalidated: false },
    ]);
  });

  it("컬럼 없이 쓰는 구버전의 INSERT는 retry가 된다(롤링 배포 호환)", async () => {
    await insertLegacyJob("00000000-0000-4000-8000-000000000002", "legacy-2");
    const { rows } = await db.pool.query(
      "SELECT on_uncertain FROM mail_jobs WHERE id = '00000000-0000-4000-8000-000000000002'",
    );
    expect(rows).toEqual([{ on_uncertain: "retry" }]);
  });

  it("retry·fail은 받고 그 밖의 값(대소문자 다름, 빈 문자열, NULL)은 새 행에서 거부한다", async () => {
    const insert = (value: string | null) =>
      db.pool.query(
        `INSERT INTO mail_jobs
           (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version, recipients, expires_at, on_uncertain)
         VALUES (gen_random_uuid(), 'caller-a', gen_random_uuid()::text, '\\x00', 1, '{}', now() + interval '1 day', $1)`,
        [value],
      );
    await insert("retry");
    await insert("fail");
    for (const bad of ["FAIL", "Retry", "", "ignore"])
      await expect(insert(bad)).rejects.toMatchObject({
        code: "23514",
        constraint: "mail_jobs_on_uncertain_values",
      });
    await expect(insert(null)).rejects.toMatchObject({ code: "23502" });
  });

  it("실제 migrations 폴더 전체를 새 schema에 적용하면 0017·0018(수신자 비움) 다음에 0019가 이 순서로 적용된다", async () => {
    const other = await createTestDatabase();
    try {
      const applied = await runMigrations(other.pool, SOURCE);
      const names = applied.filter((n) => /^001[789]_/.test(n));
      expect(names).toEqual([
        expect.stringMatching(/^0017_/),
        expect.stringMatching(/^0018_/),
        MIGRATION,
      ]);
      expect(applied.indexOf(names[2]!)).toBe(applied.indexOf(names[1]!) + 1);
      // 두 묶음의 컬럼이 함께 있다.
      const { rows } = await other.pool.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = $1
            AND ((table_name = 'mail_jobs' AND column_name = 'on_uncertain')
              OR (table_name = 'mail_events' AND column_name = 'recipients_redacted_at'))
          ORDER BY table_name`,
        [other.schema],
      );
      expect(rows).toEqual([
        { table_name: "mail_events", column_name: "recipients_redacted_at" },
        { table_name: "mail_jobs", column_name: "on_uncertain" },
      ]);
      expect(await runMigrations(other.pool, SOURCE)).toEqual([]);
    } finally {
      await other.close();
    }
  });
});
