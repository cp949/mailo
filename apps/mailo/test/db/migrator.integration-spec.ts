import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { runMigrations } from "../../src/db/migrator.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";

describe("PostgreSQL 통합: 마이그레이션", () => {
  let db: TestDatabase;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), "mailo-migrations-"));
  });

  afterAll(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("서버 버전이 13 이상이다(ADR-0006)", async () => {
    const { rows } = await db.pool.query<{ v: number }>(
      "SELECT current_setting('server_version_num')::int AS v",
    );
    expect(rows[0]!.v).toBeGreaterThanOrEqual(130000);
  });

  it("파일명 순서로 적용하고 재실행하면 다시 적용하지 않는다", async () => {
    await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE a (id int);");
    await writeFile(path.join(dir, "0002_b.sql"), "CREATE TABLE b (id int);");

    expect(await runMigrations(db.pool, dir)).toEqual([
      "0001_a.sql",
      "0002_b.sql",
    ]);
    expect(await runMigrations(db.pool, dir)).toEqual([]);
  });

  it("실패한 마이그레이션은 롤백하고 이후 파일을 적용하지 않는다", async () => {
    await writeFile(
      path.join(dir, "0003_bad.sql"),
      "CREATE TABLE c (id int); SELECT 1/0;",
    );
    await writeFile(path.join(dir, "0004_d.sql"), "CREATE TABLE d (id int);");

    await expect(runMigrations(db.pool, dir)).rejects.toThrow();

    const { rows } = await db.pool.query<{ t: string | null }>(
      "SELECT to_regclass('c')::text AS t",
    );
    expect(rows[0]!.t).toBeNull();
    const applied = await db.pool.query("SELECT name FROM schema_migrations");
    expect(applied.rows.map((r) => r.name)).toEqual([
      "0001_a.sql",
      "0002_b.sql",
    ]);
  });
});

describe("PostgreSQL 통합: 마이그레이션의 비트랜잭션 실행과 lock_timeout (M7)", () => {
  let db: TestDatabase;
  let dir: string;

  beforeEach(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), "mailo-migrations-nt-"));
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const indexValid = async (name: string): Promise<boolean | undefined> =>
    (
      await db.pool.query<{ indisvalid: boolean }>(
        `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = $1 AND c.relnamespace = $2::regnamespace`,
        [name, db.schema],
      )
    ).rows[0]?.indisvalid;

  it("표식이 있는 문장 하나 파일은 BEGIN 없이 실행되어 CONCURRENTLY 인덱스를 만들고 기록된다", async () => {
    await writeFile(
      path.join(dir, "0001_t.sql"),
      "CREATE TABLE t (id int, v text);",
    );
    await writeFile(
      path.join(dir, "0002_idx.sql"),
      "-- mailo:no-transaction\n-- 동시 생성: 쓰기를 막지 않는다.\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_v_idx ON t (v) WHERE v <> 'a;b';\n",
    );

    expect(await runMigrations(db.pool, dir)).toEqual([
      "0001_t.sql",
      "0002_idx.sql",
    ]);

    expect(await indexValid("t_v_idx")).toBe(true);
    expect(await runMigrations(db.pool, dir)).toEqual([]);
  });

  it("표식이 없으면 CONCURRENTLY는 트랜잭션 안이라 실패하고 롤백한다(기본 동작 유지)", async () => {
    await writeFile(path.join(dir, "0001_t.sql"), "CREATE TABLE t (id int);");
    await writeFile(
      path.join(dir, "0002_idx.sql"),
      "CREATE INDEX CONCURRENTLY t_id_idx ON t (id);",
    );

    await expect(runMigrations(db.pool, dir)).rejects.toThrow(
      /transaction block/,
    );

    const applied = await db.pool.query("SELECT name FROM schema_migrations");
    expect(applied.rows.map((r) => r.name)).toEqual(["0001_t.sql"]);
  });

  it("표식 파일에 문장이 둘 이상이면 실행 전에 거부하고 앞 파일도 적용하지 않는다", async () => {
    await writeFile(path.join(dir, "0001_t.sql"), "CREATE TABLE t (id int);");
    await writeFile(
      path.join(dir, "0002_two.sql"),
      "-- mailo:no-transaction\nCREATE INDEX CONCURRENTLY a_idx ON t (id);\nCREATE INDEX CONCURRENTLY b_idx ON t (id);",
    );

    await expect(runMigrations(db.pool, dir)).rejects.toThrow(
      "0002_two.sql: -- mailo:no-transaction 파일은 문장이 정확히 하나여야 한다",
    );

    expect(
      (
        await db.pool.query<{ t: string | null }>(
          "SELECT to_regclass('t')::text AS t",
        )
      ).rows[0]!.t,
    ).toBeNull();
  });

  it("표식 파일이 실패하면 기록하지 않고, 원인을 고친 뒤 다시 실행하면 적용된다(멱등 재시도)", async () => {
    await writeFile(
      path.join(dir, "0001_idx.sql"),
      "-- mailo:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS late_idx ON late_table (id);",
    );

    await expect(runMigrations(db.pool, dir)).rejects.toThrow();
    const none = await db.pool.query("SELECT name FROM schema_migrations");
    expect(none.rows).toEqual([]);

    await db.pool.query("CREATE TABLE late_table (id int)");
    expect(await runMigrations(db.pool, dir)).toEqual(["0001_idx.sql"]);
    expect(await indexValid("late_idx")).toBe(true);
  });

  it("기본 트랜잭션 실행은 풀에 lock_timeout이 없으면 지정한 값으로 잠금 대기를 끊고 롤백한다", async () => {
    await db.pool.query("CREATE TABLE locked (id int)");
    await writeFile(
      path.join(dir, "0001_alter.sql"),
      "ALTER TABLE locked ADD COLUMN extra int;",
    );
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE locked IN ACCESS EXCLUSIVE MODE");

      const started = Date.now();
      await expect(
        runMigrations(db.pool, dir, { lockTimeoutMillis: 300 }),
      ).rejects.toMatchObject({ code: "55P03" });

      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    const applied = await db.pool.query("SELECT name FROM schema_migrations");
    expect(applied.rows).toEqual([]);
  });

  it("풀에 이미 lock_timeout이 걸려 있으면 그 값을 덮어쓰지 않는다", async () => {
    await db.pool.query("CREATE TABLE locked (id int)");
    await writeFile(
      path.join(dir, "0001_alter.sql"),
      "ALTER TABLE locked ADD COLUMN extra int;",
    );
    const url =
      process.env.MAILO_TEST_DATABASE_URL ||
      "postgres://mailo:mailo-dev-password@localhost:5432/mailo";
    const strict = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${db.schema} -c lock_timeout=300`,
    });
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE locked IN ACCESS EXCLUSIVE MODE");

      const started = Date.now();
      // 인자의 60초가 풀의 300ms를 덮어쓰면 이 호출은 60초를 기다린다.
      await expect(
        runMigrations(strict, dir, { lockTimeoutMillis: 60_000 }),
      ).rejects.toMatchObject({ code: "55P03" });

      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await strict.end();
    }
  });
});
