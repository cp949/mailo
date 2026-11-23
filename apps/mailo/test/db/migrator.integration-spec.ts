import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
