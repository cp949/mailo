import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { listEvents, recordIntakeRejection } from "../../src/events/index.js";
import {
  claim,
  completeAttempt,
  deleteExpiredBodies,
  deleteExpiredRecords,
  register,
  sweepExpired,
} from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  completeDeps,
  createJob,
  jobInput,
  migrate,
  registerDeps,
} from "../support/queue-fixtures.js";

const DAY = 86_400;

describe("PostgreSQL 통합: 만료 sweep과 보존 삭제(ADR-0002 결정 7, ADR-0005 결정 7, RQ-026)", () => {
  let db: TestDatabase;
  const deps = completeDeps();

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query(
      "DROP TRIGGER IF EXISTS fail_event_insert ON mail_events",
    );
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query("DELETE FROM mail_intake_rejections");
    await db.pool.query(
      "UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, consecutive_failures = 0",
    );
  });

  afterAll(async () => {
    await db.close();
  });

  const expire = (id: string) =>
    db.pool.query(
      "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = $1",
      [id],
    );

  async function status(id: string): Promise<string> {
    const { rows } = await db.pool.query(
      "SELECT status FROM mail_jobs WHERE id = $1",
      [id],
    );
    return rows[0].status;
  }

  /** 작업을 점유하고 SENT로 종결한다. */
  async function sendOne(id: string): Promise<void> {
    const [job] = await claim(db.pool, { leaseSeconds: 120, limit: 1, deps });
    if (job?.id !== id) throw new Error("의도한 작업이 점유되지 않았다");
    await completeAttempt(
      db.pool,
      { id, leaseToken: job.leaseToken },
      { classification: "SENT" },
      deps,
    );
  }

  const ago = (
    id: string,
    column: "finished_at" | "created_at",
    seconds: number,
  ) =>
    db.pool.query(
      `UPDATE mail_jobs SET ${column} = now() - make_interval(secs => $2::double precision) WHERE id = $1`,
      [id, seconds],
    );

  it("sweep은 만료된 PENDING·RETRY_WAIT를 EXPIRED로 바꾸고 이벤트를 쓰며 차단기가 open이어도 동작한다", async () => {
    const pending = await createJob(db.pool);
    const retryWait = await createJob(db.pool);
    await db.pool.query(
      "UPDATE mail_jobs SET status = 'RETRY_WAIT' WHERE id = $1",
      [retryWait],
    );
    const fresh = await createJob(db.pool);
    await expire(pending);
    await expire(retryWait);
    await db.pool.query(
      "UPDATE mail_circuit_breaker SET state = 'open', open_until = now() + interval '1 hour'",
    );

    const swept = await sweepExpired(db.pool);

    expect(swept).toBe(2);
    expect(await status(pending)).toBe("EXPIRED");
    expect(await status(retryWait)).toBe("EXPIRED");
    expect(await status(fresh)).toBe("PENDING");
    const page = await listEvents(db.pool, { callerId: "caller-a" });
    expect(page.events.map((e) => e.type)).toEqual([
      "JOB_EXPIRED",
      "JOB_EXPIRED",
    ]);
    expect(new Set(page.events.map((e) => e.jobId))).toEqual(
      new Set([pending, retryWait]),
    );
  });

  it("점유 중인 SENDING 작업은 만료 시각이 지나도 sweep이 건드리지 않는다", async () => {
    const id = await createJob(db.pool);
    await claim(db.pool, { leaseSeconds: 120, limit: 1, deps });
    await expire(id);

    expect(await sweepExpired(db.pool)).toBe(0);
    expect(await status(id)).toBe("SENDING");
  });

  it("EXPIRED 전이와 이벤트는 같은 트랜잭션이라 이벤트 쓰기가 실패하면 전이도 롤백된다", async () => {
    const id = await createJob(db.pool);
    await expire(id);
    await db.pool.query(`
      CREATE OR REPLACE FUNCTION fail_event_insert() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'event insert blocked'; END $$`);
    await db.pool.query(
      "CREATE TRIGGER fail_event_insert BEFORE INSERT ON mail_events FOR EACH ROW EXECUTE FUNCTION fail_event_insert()",
    );

    await expect(sweepExpired(db.pool)).rejects.toThrow("event insert blocked");

    expect(await status(id)).toBe("PENDING");
    await db.pool.query("DROP TRIGGER fail_event_insert ON mail_events");
    expect(await sweepExpired(db.pool)).toBe(1);
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM mail_events WHERE job_id = $1",
      [id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("본문 삭제는 종결 후 유예가 지난 작업만 본문 컬럼을 비우고 행과 Key는 남긴다(RQ-023)", async () => {
    const old = await createJob(db.pool);
    await sendOne(old);
    const recent = await createJob(db.pool);
    await sendOne(recent);
    const active = await createJob(db.pool);
    await ago(old, "finished_at", 2 * DAY);
    await ago(active, "created_at", 5 * DAY);

    const cleared = await deleteExpiredBodies(db.pool, DAY);

    expect(cleared).toBe(1);
    const { rows } = await db.pool.query(
      `SELECT id, idempotency_key, fingerprint, body_ciphertext IS NULL AS gone, body_deleted_at IS NOT NULL AS stamped
         FROM mail_jobs WHERE id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], id)`,
      [[old, recent, active]],
    );
    expect(rows.map((r) => r.gone)).toEqual([true, false, false]);
    expect(rows[0].stamped).toBe(true);
    expect(rows[0].idempotency_key).toBeTruthy();
    expect(rows[0].fingerprint).toBeTruthy();
    // 본문이 지워진 뒤에도 같은 Key의 재등록은 중복으로 판정된다(ADR-0005 결정 7)
    const sameKey = jobInput({ idempotencyKey: rows[0].idempotency_key });
    expect((await register(db.pool, registerDeps, sameKey)).kind).toBe(
      "duplicate",
    );
  });

  it("보존 삭제는 작업 행과 시도·이벤트를, 거부 기록과 그 이벤트를 함께 지운다", async () => {
    const expired = await createJob(db.pool);
    await sendOne(expired);
    const retained = await createJob(db.pool);
    await sendOne(retained);
    const unfinished = await createJob(db.pool);
    const expiredKey = (
      await db.pool.query(
        "SELECT idempotency_key FROM mail_jobs WHERE id = $1",
        [expired],
      )
    ).rows[0].idempotency_key as string;
    await ago(expired, "finished_at", 31 * DAY);
    await ago(retained, "finished_at", 29 * DAY);
    await ago(unfinished, "created_at", 90 * DAY);
    await recordIntakeRejection(db.pool, {
      callerId: "caller-a",
      fileName: "old.json",
      sizeBytes: 1,
      sha256: "b".repeat(64),
      reasonCode: "FORMAT",
    });
    await recordIntakeRejection(db.pool, {
      callerId: "caller-a",
      fileName: "new.json",
      sizeBytes: 1,
      sha256: "c".repeat(64),
      reasonCode: "FORMAT",
    });
    await db.pool.query(
      "UPDATE mail_intake_rejections SET created_at = now() - interval '31 days' WHERE file_name = 'old.json'",
    );

    const result = await deleteExpiredRecords(db.pool, 30 * DAY);

    expect(result).toEqual({ jobs: 1, rejections: 1 });
    const count = async (sql: string, args: unknown[] = []) =>
      (await db.pool.query(sql, args)).rows[0].n as number;
    expect(
      await count("SELECT count(*)::int AS n FROM mail_jobs WHERE id = $1", [
        expired,
      ]),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM mail_attempts WHERE job_id = $1",
        [expired],
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM mail_events WHERE job_id = $1",
        [expired],
      ),
    ).toBe(0);
    // 보존 기간 안의 작업, 종결되지 않은 작업은 남는다
    expect(
      await count(
        "SELECT count(*)::int AS n FROM mail_jobs WHERE id = ANY($1::uuid[])",
        [[retained, unfinished]],
      ),
    ).toBe(2);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM mail_attempts WHERE job_id = $1",
        [retained],
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM mail_events WHERE job_id = $1",
        [retained],
      ),
    ).toBe(1);
    expect(
      await count("SELECT count(*)::int AS n FROM mail_intake_rejections"),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM mail_events WHERE type = 'INTAKE_REJECTED'",
      ),
    ).toBe(1);
    // 삭제된 Key는 새 요청으로 등록된다
    const again = await register(
      db.pool,
      registerDeps,
      jobInput({ idempotencyKey: expiredKey }),
    );
    expect(again.kind).toBe("created");
  });
});
