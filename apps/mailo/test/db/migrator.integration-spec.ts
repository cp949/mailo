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
import {
  MIGRATION_ADVISORY_LOCK_KEY,
  MigrationLockTimeoutError,
  runMigrations,
  type MigrationProgress,
} from "../../src/db/migrator.js";
import {
  createTestDatabase,
  DEFAULT_URL,
  type TestDatabase,
} from "../support/database.js";

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

  it("CONCURRENTLY 실패로 INVALID 인덱스가 남으면 IF NOT EXISTS 재실행도 기록하지 않고 인덱스 이름으로 실패하며, 지운 뒤 재실행하면 적용된다(ADR-0009)", async () => {
    await writeFile(
      path.join(dir, "0001_t.sql"),
      "CREATE TABLE dup (v int); INSERT INTO dup VALUES (1), (1);",
    );
    await writeFile(
      path.join(dir, "0002_idx.sql"),
      "-- mailo:no-transaction\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS dup_v_idx ON dup (v);",
    );

    // 첫 실행: 중복 값으로 CONCURRENTLY가 실패해 INVALID 인덱스가 남는다(기존 동작).
    await expect(runMigrations(db.pool, dir)).rejects.toThrow();
    expect(await indexValid("dup_v_idx")).toBe(false);

    // 원인을 고쳐도 IF NOT EXISTS가 INVALID 인덱스를 건너뛴다. 기록하지 않고 실패해야 한다.
    await db.pool.query("DELETE FROM dup");
    await expect(runMigrations(db.pool, dir)).rejects.toThrow(
      /0002_idx\.sql: .*INVALID.*dup_v_idx/,
    );
    const applied = await db.pool.query(
      "SELECT name FROM schema_migrations ORDER BY name",
    );
    expect(applied.rows.map((r) => r.name)).toEqual(["0001_t.sql"]);

    await db.pool.query("DROP INDEX CONCURRENTLY dup_v_idx");
    expect(await runMigrations(db.pool, dir)).toEqual(["0002_idx.sql"]);
    expect(await indexValid("dup_v_idx")).toBe(true);
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

/**
 * 같은 database에서 `migrate-cli`가 겹치는 경우를 실제 PostgreSQL로 고정한다(RQ-025, ADR-0002 구현 중 확정 13).
 * 이 describe의 테스트는 database 전체의 advisory lock, `pg_stat_activity`, 스냅샷 대기에 의존한다.
 * schema 격리로 막을 수 없으므로 전용 database(`scripts/test-db.sh create`)에서만 실행한다.
 * 같은 database를 쓰는 다른 jest나 `pg_dump`가 있으면 `CREATE INDEX CONCURRENTLY`가 그 트랜잭션도 기다려 느려질 수 있다(`docs/agents/verification.md`).
 */
describe("PostgreSQL 통합: 마이그레이션 실행기의 잠금 대기(RQ-025, ADR-0002 구현 중 확정 13)", () => {
  let db: TestDatabase;
  let dir: string;

  beforeEach(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), "mailo-migrations-lock-"));
    await db.pool.query("CREATE TABLE t (id int)");
    await writeFile(
      path.join(dir, "0001_idx.sql"),
      "-- mailo:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_id_idx ON t (id);\n",
    );
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** 거부도 값으로 바꿔 둔다. 실행 중 먼저 거부된 Promise가 처리되지 않은 거부로 남지 않게 한다. */
  const settle = (run: Promise<string[]>) =>
    run.then(
      (applied) => ({ applied }),
      (error: unknown) => ({
        error: (error as { name?: string }).name,
        code: (error as { code?: string }).code,
      }),
    );

  const indexValid = async (name: string): Promise<boolean | undefined> =>
    (
      await db.pool.query<{ indisvalid: boolean }>(
        `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = $1 AND c.relnamespace = $2::regnamespace`,
        [name, db.schema],
      )
    ).rows[0]?.indisvalid;

  it("CIC를 실행 중인 보유자 뒤에서 대기자가 기다려도 교착(40P01)하지 않고 둘 다 성공한다", async () => {
    // 다른 트랜잭션 H가 t에 쓰기 잠금을 쥐어 보유자 A의 CIC가 H를 기다리게 한다.
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("INSERT INTO t VALUES (1)");

      const a = settle(runMigrations(db.pool, dir));
      await waitFor(
        async () =>
          (
            await db.pool.query(
              `SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database()
                  AND pid <> pg_backend_pid()
                  AND query LIKE '%CREATE INDEX CONCURRENTLY%'
                  AND wait_event_type = 'Lock'`,
            )
          ).rowCount! > 0,
        "보유자의 CIC가 H를 기다리는 상태",
      );

      const b = settle(runMigrations(db.pool, dir));
      // B가 deadlock_timeout을 넘겨 기다린 뒤에 H를 풀어야 A가 B를 기다리는 순간 B가 먼저 대기자가 된다.
      // 이 순서에서 블로킹 대기는 A(CIC)를 희생시킨다.
      const { rows } = await db.pool.query<{ ms: number }>(
        "SELECT setting::int AS ms FROM pg_settings WHERE name = 'deadlock_timeout'",
      );
      await sleep(rows[0]!.ms * 1.5);
      await holder.query("COMMIT");

      expect(await Promise.all([a, b])).toEqual([
        { applied: ["0001_idx.sql"] },
        { applied: [] },
      ]);
      expect(await indexValid("t_id_idx")).toBe(true);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });

  /** 다른 연결(다른 `migrate-cli`)이 실행기의 advisory lock을 쥔 상태를 만든다. */
  const holdLock = async () => {
    const client = new pg.Client({
      connectionString: process.env.MAILO_TEST_DATABASE_URL || DEFAULT_URL,
    });
    // pg_terminate_backend로 끊어도 테스트가 처리되지 않은 error 이벤트로 죽지 않게 한다.
    client.on("error", () => undefined);
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1)", [
      MIGRATION_ADVISORY_LOCK_KEY,
    ]);
    return client;
  };

  it("대기 상한을 넘으면 MigrationLockTimeoutError로 끝나고 아무것도 적용하지 않으며, 보유자가 풀리면 같은 호출이 성공한다", async () => {
    const holder = await holdLock();
    try {
      const progress: MigrationProgress[] = [];
      const started = performance.now();
      const error: unknown = await runMigrations(db.pool, dir, {
        advisoryLockPollMillis: 50,
        advisoryLockWaitMillis: 600,
        onProgress: (p) => progress.push(p),
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      const elapsed = performance.now() - started;

      expect(error).toBeInstanceOf(MigrationLockTimeoutError);
      const timeout = error as MigrationLockTimeoutError;
      expect(timeout.name).toBe("MigrationLockTimeoutError");
      expect(timeout.code).toBe("MAILO_MIGRATION_LOCK_TIMEOUT");
      // 메시지는 고정 문구와 경과 시간뿐이다(RQ-027).
      expect(timeout.message).toBe(
        `마이그레이션 잠금 대기 상한을 넘었다(대기 ${timeout.waitedMillis}ms)`,
      );
      expect(timeout.waitedMillis).toBeGreaterThanOrEqual(600);
      expect(elapsed).toBeGreaterThanOrEqual(600);
      expect(elapsed).toBeLessThan(5000);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every((p) => p.type === "lock_wait")).toBe(true);
      // 잠금을 얻지 못했으므로 이력 테이블도 만들지 않고 파일도 적용하지 않는다.
      expect(
        (
          await db.pool.query<{ t: string | null }>(
            "SELECT to_regclass('schema_migrations')::text AS t",
          )
        ).rows[0]!.t,
      ).toBeNull();
      expect(await indexValid("t_id_idx")).toBeUndefined();

      // 보유자가 풀기 전에 시작한 호출은 기다리다가 풀린 뒤 얻어 적용한다.
      const waiting: MigrationProgress[] = [];
      const run = settle(
        runMigrations(db.pool, dir, {
          advisoryLockPollMillis: 50,
          onProgress: (p) => waiting.push(p),
        }),
      );
      await waitFor(() => waiting.length > 0, "대기자가 잠금을 기다리는 상태");
      await holder.query("SELECT pg_advisory_unlock($1)", [
        MIGRATION_ADVISORY_LOCK_KEY,
      ]);

      expect(await run).toEqual({ applied: ["0001_idx.sql"] });
      expect(waiting.at(-1)).toMatchObject({ type: "lock_acquired" });
      expect(await indexValid("t_id_idx")).toBe(true);
    } finally {
      await holder.end().catch(() => undefined);
    }
  });

  it("보유자 세션이 비정상 종료하면 폴링하던 대기자가 잠금을 얻어 적용한다", async () => {
    const holder = await holdLock();
    try {
      const pid = (
        await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
      const progress: MigrationProgress[] = [];
      const run = settle(
        runMigrations(db.pool, dir, {
          advisoryLockPollMillis: 50,
          onProgress: (p) => progress.push(p),
        }),
      );
      await waitFor(() => progress.length > 0, "대기자가 잠금을 기다리는 상태");
      await db.pool.query("SELECT pg_terminate_backend($1)", [pid]);

      expect(await run).toEqual({ applied: ["0001_idx.sql"] });
      expect(progress.at(-1)).toMatchObject({ type: "lock_acquired" });
    } finally {
      await holder.end().catch(() => undefined);
    }
  });
});

/** 조건이 참이 될 때까지 폴링한다(상한 10초). 실패 메시지에 기다린 상태를 담는다. */
async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`10초 안에 ${what}가 되지 않았다`);
}
