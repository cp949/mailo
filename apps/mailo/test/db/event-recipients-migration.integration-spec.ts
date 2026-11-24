/**
 * 마이그레이션 0017~0018(이벤트 수신자 비움 표지 컬럼과 부분 인덱스, RQ-072, ADR-0015 결정 3).
 * 0001~0016을 먼저 적용해 이벤트 행을 넣고 이어서 0017~0018을 적용한다. 실제 PostgreSQL을 쓴다.
 * 계획이 인덱스를 고르는지는 데이터가 작으면 통계에 좌우되므로 seqscan을 끈 계획으로만 "쓸 수 있는지"를 본다.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrator.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";

const SOURCE = fileURLToPath(new URL("../../migrations", import.meta.url));
const COLUMN_FILE = "0017_event_recipients_redacted_at.sql";
const INDEX_FILE = "0018_event_recipients_redact_idx.sql";
const NEW_FILES = [COLUMN_FILE, INDEX_FILE];
const INDEX_NAME = "mail_events_recipients_redact_idx";

/** 새 파일 둘을 뺀 마이그레이션 디렉터리 사본을 만든다. */
async function copyWithout(excluded: readonly string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mailo-0017-"));
  for (const name of await readdir(SOURCE)) {
    if (!excluded.includes(name))
      await copyFile(path.join(SOURCE, name), path.join(dir, name));
  }
  return dir;
}

async function indexInfo(db: TestDatabase, name: string) {
  return (
    await db.pool.query<{ def: string; valid: boolean }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1 AND c.relnamespace = $2::regnamespace`,
      [name, db.schema],
    )
  ).rows[0];
}

describe("PostgreSQL 통합: 0017~0018 이벤트 수신자 비움 표지와 부분 인덱스 (RQ-072, ADR-0015 결정 3)", () => {
  let db: TestDatabase;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await copyWithout(NEW_FILES);
    await runMigrations(db.pool, dir);
    await db.pool.query(
      `INSERT INTO mail_jobs
         (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version, recipients, expires_at, status, finished_at)
       SELECT gen_random_uuid(), 'caller-a', 'k' || g, '\\x00', 1, '{}', now() + interval '1 day', 'SENT', now()
         FROM generate_series(1, 3) g`,
    );
    await db.pool.query(
      `INSERT INTO mail_events (caller_id, type, job_id, idempotency_key, attempt_count, recipients, rejected_recipients)
       SELECT caller_id, 'JOB_SENT', id, idempotency_key, 1,
              '{"to":["canary-0017@example.invalid"]}', '[{"address":"canary-0017-r@example.invalid"}]'
         FROM mail_jobs`,
    );
    for (const name of NEW_FILES)
      await copyFile(path.join(SOURCE, name), path.join(dir, name));
  });

  afterAll(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("0001~0016 상태에는 표지 컬럼과 새 인덱스가 없다", async () => {
    const { rows } = await db.pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'mail_events' AND column_name = 'recipients_redacted_at'`,
      [db.schema],
    );
    expect(rows).toHaveLength(0);
    expect(await indexInfo(db, INDEX_NAME)).toBeUndefined();
  });

  it("0017·0018만 순서대로 적용되고 다시 실행하면 아무것도 적용하지 않는다", async () => {
    expect(await runMigrations(db.pool, dir)).toEqual(NEW_FILES);
    expect(await runMigrations(db.pool, dir)).toEqual([]);
  });

  it("표지 컬럼은 NULL 허용 timestamptz이고 기본값이 없어 표를 다시 쓰지 않는다", async () => {
    const { rows } = await db.pool.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'mail_events' AND column_name = 'recipients_redacted_at'`,
      [db.schema],
    );
    expect(rows).toEqual([
      {
        data_type: "timestamp with time zone",
        is_nullable: "YES",
        column_default: null,
      },
    ]);
  });

  it("기존 이벤트는 값을 그대로 두고 표지만 NULL이다", async () => {
    const { rows } = await db.pool.query(
      "SELECT recipients, rejected_recipients, recipients_redacted_at FROM mail_events",
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.recipients).toEqual({ to: ["canary-0017@example.invalid"] });
      expect(row.rejected_recipients).toEqual([
        { address: "canary-0017-r@example.invalid" },
      ]);
      expect(row.recipients_redacted_at).toBeNull();
    }
  });

  it("부분 인덱스가 유효하고 정의가 ADR 결정 3과 같다(비우지 않은 JOB_* 이벤트를 시각순으로)", async () => {
    const index = await indexInfo(db, INDEX_NAME);

    expect(index?.valid).toBe(true);
    expect(index?.def).toContain("(created_at, id)");
    expect(index?.def).toContain("recipients_redacted_at IS NULL");
    expect(index?.def).toContain("JOB_SENT");
    expect(index?.def).toContain("JOB_CANCELED");
    expect(index?.def).not.toContain("INTAKE_REJECTED");
  });

  it("두 파일의 실행 방식: 0017은 트랜잭션 안(표식 없음), 0018은 표식과 문장 하나와 IF NOT EXISTS", async () => {
    const column = await readFile(path.join(SOURCE, COLUMN_FILE), "utf8");
    const index = await readFile(path.join(SOURCE, INDEX_FILE), "utf8");
    const statements = (text: string) =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("--"))
        .join("\n")
        .match(/;/g);

    expect(column.split("\n")[0]).not.toBe("-- mailo:no-transaction");
    expect(statements(column)).toHaveLength(1);
    expect(index.split("\n")[0]).toBe("-- mailo:no-transaction");
    expect(statements(index)).toHaveLength(1);
    expect(index).toMatch(/INDEX CONCURRENTLY IF NOT EXISTS/);
  });

  it("파일을 직접 다시 실행해도 오류 없이 멱등이다(실패 뒤 재실행 경로)", async () => {
    for (const name of NEW_FILES) {
      const sql = await readFile(path.join(SOURCE, name), "utf8");
      await expect(db.pool.query(sql)).resolves.toBeDefined();
    }
    expect((await indexInfo(db, INDEX_NAME))?.valid).toBe(true);
  });

  it("비움 대상 조회가 부분 인덱스를 쓸 수 있다", async () => {
    await db.pool.query("ANALYZE mail_events");
    const client = await db.pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      await client.query("SET enable_bitmapscan = off");
      const { rows } = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT e.id FROM mail_events e
          WHERE e.type IN ('JOB_SENT', 'JOB_FAILED', 'JOB_EXPIRED', 'JOB_CANCELED')
            AND e.recipients_redacted_at IS NULL
            AND e.created_at <= now() - interval '7 days'
          ORDER BY e.created_at, e.id LIMIT 1000`,
      );
      expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain(INDEX_NAME);
    } finally {
      client.release();
    }
  });
});

describe("PostgreSQL 통합: 0018의 INVALID 인덱스 처리 (RQ-072, ADR-0009 구현 중 확정)", () => {
  let db: TestDatabase;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await copyWithout([INDEX_FILE]);
    await runMigrations(db.pool, dir);
    await copyFile(path.join(SOURCE, INDEX_FILE), path.join(dir, INDEX_FILE));
  });

  afterAll(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("CONCURRENTLY가 중단돼 같은 이름의 INVALID 인덱스가 남았으면 기록하지 않고 이름으로 실패하며, 지운 뒤 재실행하면 적용된다", async () => {
    // 중단된 CONCURRENTLY가 남기는 상태를 만든다: 같은 이름의 INVALID 인덱스.
    await db.pool.query(
      `CREATE INDEX ${INDEX_NAME} ON mail_events (created_at, id)
         WHERE type IN ('JOB_SENT', 'JOB_FAILED', 'JOB_EXPIRED', 'JOB_CANCELED') AND recipients_redacted_at IS NULL`,
    );
    await db.pool.query(
      "UPDATE pg_index SET indisvalid = false WHERE indexrelid = $1::regclass",
      [`"${db.schema}".${INDEX_NAME}`],
    );

    await expect(runMigrations(db.pool, dir)).rejects.toThrow(INDEX_NAME);

    const recorded = await db.pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      [INDEX_FILE],
    );
    expect(recorded.rows).toHaveLength(0);
    await db.pool.query(`DROP INDEX CONCURRENTLY ${INDEX_NAME}`);

    expect(await runMigrations(db.pool, dir)).toEqual([INDEX_FILE]);
    expect((await indexInfo(db, INDEX_NAME))?.valid).toBe(true);
  });
});
