import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
// 동시에 기동한 인스턴스가 같은 마이그레이션을 겹쳐 적용하지 않게 하는 advisory lock 키
const ADVISORY_LOCK_KEY = 7_364_221_001;

/**
 * migrations 디렉터리의 `NNNN_이름.sql`을 파일명 순서로 적용한다.
 * 파일마다 트랜잭션 하나이며 실패하면 그 파일만 롤백하고 중단한다.
 * 적용 기록은 `schema_migrations`에 남기며, 이미 적용한 파일은 건너뛴다.
 * 적용한 파일의 내용 변경은 감지하지 않는다. 적용된 파일을 고치지 말고 새 파일을 추가한다.
 * @returns 이번 실행에서 적용한 파일명
 */
export async function runMigrations(
  pool: pg.Pool,
  dir: string,
): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  for (const name of names) {
    if (!MIGRATION_FILE.test(name)) {
      throw new Error(`마이그레이션 파일명이 규칙에 맞지 않는다: ${name}`);
    }
  }

  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (
        await client.query<{ name: string }>(
          "SELECT name FROM schema_migrations",
        )
      ).rows.map((r) => r.name),
    );
    for (const name of names) {
      if (done.has(name)) continue;
      const sql = await readFile(path.join(dir, name), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          name,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(name);
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
  return applied;
}
