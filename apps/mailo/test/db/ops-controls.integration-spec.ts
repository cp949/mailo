import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrator.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { createLegacyJob } from "../support/queue-fixtures.js";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

async function violation(
  db: TestDatabase,
  sql: string,
  params: unknown[] = [],
): Promise<{ code?: string; constraint?: string } | null> {
  try {
    await db.pool.query(sql, params);
    return null;
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
}

/**
 * 마이그레이션 0008(RQ-042~044, ADR-0011 결정 2·6·10). 정지·감사 테이블을 만들고 기존 테이블은 건드리지 않는다.
 * 0001~0007이 적용된 schema 위에 추가해 실행기와 재실행을 확인한다. 실제 PostgreSQL을 쓴다.
 */
describe("PostgreSQL 통합: 마이그레이션 0008 운영 제어 (RQ-043·044, ADR-0011 결정 10)", () => {
  let db: TestDatabase;
  let dir: string;
  let existingJobId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), "mailo-0008-"));
    // 0007까지만 복사해 먼저 적용한다.
    for (const file of (await readdir(MIGRATIONS)).sort()) {
      if (file < "0008")
        await copyFile(path.join(MIGRATIONS, file), path.join(dir, file));
    }
  });

  afterAll(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("0001~0007 위에서 0008만 추가로 적용되고 기존 작업 행을 바꾸지 않는다", async () => {
    const first = await runMigrations(db.pool, dir);
    expect(first.at(-1)).toBe("0007_event_type_canceled.sql");
    existingJobId = await createLegacyJob(db.pool);
    const before = await db.pool.query("SELECT * FROM mail_jobs");

    await copyFile(
      path.join(MIGRATIONS, "0008_ops_controls.sql"),
      path.join(dir, "0008_ops_controls.sql"),
    );
    const second = await runMigrations(db.pool, dir);

    expect(second).toEqual(["0008_ops_controls.sql"]);
    expect((await db.pool.query("SELECT * FROM mail_jobs")).rows).toEqual(
      before.rows,
    );
  });

  it("재실행하면 아무것도 다시 적용하지 않는다", async () => {
    expect(await runMigrations(db.pool, dir)).toEqual([]);
  });

  it("실제 migrations 폴더 전체를 새 schema에 적용해도 같은 결과다", async () => {
    const other = await createTestDatabase();
    try {
      const applied = await runMigrations(other.pool, MIGRATIONS);
      expect(applied).toContain("0008_ops_controls.sql");
      const { rows } = await other.pool.query(
        `SELECT to_regclass('mail_send_controls') IS NOT NULL AS controls,
                to_regclass('mail_ops_audit') IS NOT NULL AS audit`,
      );
      expect(rows[0]).toEqual({ controls: true, audit: true });
    } finally {
      await other.close();
    }
  });

  describe("mail_send_controls", () => {
    it("all은 빈 scope_id, 그 밖은 비어 있지 않은 scope_id만 허용한다", async () => {
      expect(
        await violation(
          db,
          "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('all', 'x', 'oncall')",
        ),
      ).toMatchObject({
        code: "23514",
        constraint: "mail_send_controls_scope_id",
      });
      expect(
        await violation(
          db,
          "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('caller', '', 'oncall')",
        ),
      ).toMatchObject({
        code: "23514",
        constraint: "mail_send_controls_scope_id",
      });
      expect(
        await violation(
          db,
          "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('all', '', 'oncall')",
        ),
      ).toBeNull();
      await db.pool.query("DELETE FROM mail_send_controls");
    });

    it("모르는 범위와 빈·긴 paused_by를 거부하고 account 범위는 허용한다(단계 7 자리)", async () => {
      expect(
        await violation(
          db,
          "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('region', 'x', 'oncall')",
        ),
      ).toMatchObject({ code: "23514" });
      for (const by of ["", "a".repeat(33)])
        expect(
          await violation(
            db,
            "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('caller', 'alpha', $1)",
            [by],
          ),
        ).toMatchObject({ code: "23514" });
      expect(
        await violation(
          db,
          "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('account', 'default', 'oncall')",
        ),
      ).toBeNull();
      await db.pool.query("DELETE FROM mail_send_controls");
    });

    it("같은 범위는 한 행뿐이다(기본키)", async () => {
      await db.pool.query(
        "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('caller', 'alpha', 'oncall')",
      );
      expect(
        await violation(
          db,
          "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('caller', 'alpha', 'other')",
        ),
      ).toMatchObject({ code: "23505" });
      await db.pool.query("DELETE FROM mail_send_controls");
    });

    it("자유 텍스트 컬럼이 없다(컬럼은 범위·시각·이름뿐이다)", async () => {
      const { rows } = await db.pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'mail_send_controls'
          ORDER BY ordinal_position`,
      );
      expect(rows.map((r) => r.column_name)).toEqual([
        "scope_type",
        "scope_id",
        "paused_at",
        "paused_by",
      ]);
    });
  });

  describe("mail_ops_audit", () => {
    const insert = (sql: string, params: unknown[] = []) =>
      violation(db, `INSERT INTO mail_ops_audit ${sql}`, params);

    it("정지·재개는 범위만, 취소는 작업 ID만 가질 수 있다", async () => {
      const ok = [
        "(actor, action, scope_type, scope_id) VALUES ('oncall', 'PAUSE', 'all', '')",
        "(actor, action, scope_type, scope_id) VALUES ('oncall', 'RESUME', 'caller', 'alpha')",
        `(actor, action, job_id) VALUES ('oncall', 'CANCEL_JOB', '${existingJobId}')`,
      ];
      for (const sql of ok) expect(await insert(sql)).toBeNull();

      const bad = [
        // 정지에 작업 ID
        `(actor, action, scope_type, scope_id, job_id) VALUES ('oncall', 'PAUSE', 'all', '', '${existingJobId}')`,
        // 정지에 범위 없음
        "(actor, action) VALUES ('oncall', 'PAUSE')",
        // 취소에 범위
        `(actor, action, scope_type, scope_id, job_id) VALUES ('oncall', 'CANCEL_JOB', 'all', '', '${existingJobId}')`,
        // 취소에 작업 ID 없음
        "(actor, action) VALUES ('oncall', 'CANCEL_JOB')",
        // all에 비어 있지 않은 id, caller에 빈 id
        "(actor, action, scope_type, scope_id) VALUES ('oncall', 'PAUSE', 'all', 'x')",
        "(actor, action, scope_type, scope_id) VALUES ('oncall', 'PAUSE', 'caller', '')",
        // 모르는 동작
        "(actor, action, scope_type, scope_id) VALUES ('oncall', 'DROP', 'all', '')",
        // actor 빈 값·33자
        "(actor, action, scope_type, scope_id) VALUES ('', 'PAUSE', 'all', '')",
        `(actor, action, scope_type, scope_id) VALUES ('${"a".repeat(33)}', 'PAUSE', 'all', '')`,
      ];
      for (const sql of bad)
        expect(await insert(sql)).toMatchObject({ code: "23514" });
    });

    it("job_id에 외래 키가 없어 작업 행이 지워져도 기록이 남는다", async () => {
      await db.pool.query("DELETE FROM mail_jobs WHERE id = $1", [
        existingJobId,
      ]);

      const { rows } = await db.pool.query(
        "SELECT count(*)::int AS n FROM mail_ops_audit WHERE job_id = $1",
        [existingJobId],
      );
      expect(rows[0].n).toBe(1);
    });

    it("id는 증가하는 identity이고 at은 DB 시각이다. 자유 텍스트 컬럼이 없다", async () => {
      const { rows } = await db.pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'mail_ops_audit'
          ORDER BY ordinal_position`,
      );
      expect(rows.map((r) => r.column_name)).toEqual([
        "id",
        "at",
        "actor",
        "action",
        "scope_type",
        "scope_id",
        "job_id",
      ]);
      const ids = await db.pool.query(
        "SELECT id FROM mail_ops_audit ORDER BY id",
      );
      expect(ids.rows.length).toBeGreaterThan(1);
    });
  });
});
