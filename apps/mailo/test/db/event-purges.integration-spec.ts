import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrator.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { createLegacyJob } from "../support/queue-fixtures.js";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

/**
 * 마이그레이션 0009(RQ-045, ADR-0011 결정 9·10). 이벤트 삭제 표지 테이블만 만들고 기존 테이블은 건드리지 않는다.
 * 0001~0008이 적용된 schema 위에 추가해 실행기와 재실행을 확인한다. 실제 PostgreSQL을 쓴다.
 */
describe("PostgreSQL 통합: 마이그레이션 0009 이벤트 삭제 표지 (RQ-045, ADR-0011 결정 9·10)", () => {
  let db: TestDatabase;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), "mailo-0009-"));
    // 0008까지만 복사해 먼저 적용한다.
    for (const file of (await readdir(MIGRATIONS)).sort()) {
      if (file < "0009")
        await copyFile(path.join(MIGRATIONS, file), path.join(dir, file));
    }
  });

  afterAll(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("0001~0008 위에서 0009만 추가로 적용되고 기존 작업 행을 바꾸지 않는다", async () => {
    const first = await runMigrations(db.pool, dir);
    expect(first.at(-1)).toBe("0008_ops_controls.sql");
    await createLegacyJob(db.pool);
    const before = await db.pool.query("SELECT * FROM mail_jobs");

    await copyFile(
      path.join(MIGRATIONS, "0009_event_purges.sql"),
      path.join(dir, "0009_event_purges.sql"),
    );
    const second = await runMigrations(db.pool, dir);

    expect(second).toEqual(["0009_event_purges.sql"]);
    expect((await db.pool.query("SELECT * FROM mail_jobs")).rows).toEqual(
      before.rows,
    );
  });

  it("재실행하면 아무것도 다시 적용하지 않는다", async () => {
    expect(await runMigrations(db.pool, dir)).toEqual([]);
  });

  it("(caller_id, type)이 기본키이고 같은 키를 두 번 넣을 수 없다", async () => {
    await db.pool.query(
      "INSERT INTO mail_event_purges (caller_id, type, purged_txid, purged_id) VALUES ('a', 'JOB_SENT', '5'::xid8, 7)",
    );
    await expect(
      db.pool.query(
        "INSERT INTO mail_event_purges (caller_id, type, purged_txid, purged_id) VALUES ('a', 'JOB_SENT', '6'::xid8, 8)",
      ),
    ).rejects.toMatchObject({ code: "23505" });
    // 종류가 다르면 같은 호출처도 별도 행이다. type에는 CHECK가 없다(ADR-0011 결정 9).
    await db.pool.query(
      "INSERT INTO mail_event_purges (caller_id, type, purged_txid, purged_id) VALUES ('a', 'JOB_FUTURE_KIND', '6'::xid8, 8)",
    );
    const { rows } = await db.pool.query(
      "SELECT updated_at IS NOT NULL AS stamped FROM mail_event_purges WHERE type = 'JOB_SENT'",
    );
    expect(rows[0].stamped).toBe(true);
  });

  it("실제 migrations 폴더 전체를 새 schema에 적용하면 0008 바로 뒤에 0009가 적용된다", async () => {
    const other = await createTestDatabase();
    try {
      const applied = await runMigrations(other.pool, MIGRATIONS);
      // 이후 마이그레이션(0010~)이 이어지므로 "마지막"이 아니라 0008 바로 다음 순서를 고정한다.
      expect(applied[applied.indexOf("0008_ops_controls.sql") + 1]).toBe(
        "0009_event_purges.sql",
      );
      const { rows } = await other.pool.query(
        "SELECT to_regclass('mail_event_purges') IS NOT NULL AS exists",
      );
      expect(rows[0].exists).toBe(true);
    } finally {
      await other.close();
    }
  });
});
