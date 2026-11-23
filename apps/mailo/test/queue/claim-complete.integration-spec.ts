import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { claim, completeAttempt } from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  completeDeps,
  createJob,
  migrate,
  pastDue,
} from "../support/queue-fixtures.js";

describe("PostgreSQL 통합: 점유와 종료 전이(ADR-0002, RQ-014)", () => {
  let db: TestDatabase;
  const deps = completeDeps({ maxAttempts: 2 });
  const claimOpts = { leaseSeconds: 120, limit: 1, deps };

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
  });

  afterAll(async () => {
    await db.close();
  });

  async function jobRow(id: string) {
    const { rows } = await db.pool.query(
      `SELECT status, attempts, lease_token, finished_at, failure_reason, next_attempt_at, now() AS now
         FROM mail_jobs WHERE id = $1`,
      [id],
    );
    return rows[0];
  }
  async function count(table: string, id: string): Promise<number> {
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE job_id = $1`,
      [id],
    );
    return rows[0].n;
  }

  it("동시 claim 12건이 작업 60건을 중복 없이 나눠 가진다(SKIP LOCKED)", async () => {
    for (let i = 0; i < 60; i += 1) await createJob(db.pool);

    const batches = await Promise.all(
      Array.from({ length: 12 }, () =>
        claim(db.pool, { ...claimOpts, limit: 5 }),
      ),
    );

    const claimed = batches.flat();
    expect(new Set(claimed.map((j) => j.id)).size).toBe(claimed.length);
    expect(claimed).toHaveLength(60);
    expect(new Set(claimed.map((j) => j.leaseToken)).size).toBe(60);
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM mail_jobs WHERE status = 'SENDING'",
    );
    expect(rows[0].n).toBe(60);
  });

  it("만료 시각이 지난 PENDING 작업은 점유하지 않는다", async () => {
    const id = await createJob(db.pool);
    await db.pool.query(
      "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = $1",
      [id],
    );
    expect(await claim(db.pool, claimOpts)).toEqual([]);
  });

  it("lease_token이 다르면 전이를 거부하고 시도와 이벤트도 쓰지 않는다", async () => {
    const id = await createJob(db.pool);
    const [job] = await claim(db.pool, claimOpts);
    expect(job!.id).toBe(id);

    const result = await completeAttempt(
      db.pool,
      { id, leaseToken: "00000000-0000-4000-8000-000000000000" },
      { classification: "SENT" },
      deps,
    );

    expect(result).toEqual({ applied: false, reason: "LEASE_LOST" });
    expect((await jobRow(id)).status).toBe("SENDING");
    expect(await count("mail_attempts", id)).toBe(0);
    expect(await count("mail_events", id)).toBe(0);
  });

  it("lease가 만료돼 다시 점유된 작업에 이전 점유의 늦은 결과는 거부된다", async () => {
    const id = await createJob(db.pool);
    const [first] = await claim(db.pool, claimOpts);
    await db.pool.query(
      "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
      [id],
    );
    // 복구 단계가 LEASE_EXPIRED 시도를 기록하고 RETRY_WAIT으로 보낸다
    expect(await claim(db.pool, claimOpts)).toEqual([]);
    expect((await jobRow(id)).status).toBe("RETRY_WAIT");
    expect((await jobRow(id)).attempts).toBe(1);
    await pastDue(db.pool, id);
    const [second] = await claim(db.pool, claimOpts);
    expect(second!.leaseToken).not.toBe(first!.leaseToken);

    const late = await completeAttempt(
      db.pool,
      { id, leaseToken: first!.leaseToken },
      { classification: "SENT" },
      deps,
    );
    const fresh = await completeAttempt(
      db.pool,
      { id, leaseToken: second!.leaseToken },
      { classification: "SENT" },
      deps,
    );

    expect(late.applied).toBe(false);
    expect(fresh.applied).toBe(true);
    const { rows } = await db.pool.query(
      "SELECT classification FROM mail_attempts WHERE job_id = $1 ORDER BY id",
      [id],
    );
    expect(rows.map((r) => r.classification)).toEqual([
      "LEASE_EXPIRED",
      "SENT",
    ]);
  });

  it("SENT 전이는 시도 이력과 JOB_SENT 이벤트를 쓰고 일부 거부 수신자를 담는다(ADR-0007 결정 7)", async () => {
    const id = await createJob(db.pool);
    const [job] = await claim(db.pool, claimOpts);

    const result = await completeAttempt(
      db.pool,
      { id, leaseToken: job!.leaseToken },
      {
        classification: "SENT",
        rejectedRecipients: [{ address: "x@example.invalid", code: 452 }],
      },
      deps,
    );

    expect(result).toMatchObject({ applied: true, status: "SENT" });
    const row = await jobRow(id);
    expect(row.status).toBe("SENT");
    expect(row.lease_token).toBeNull();
    expect(row.finished_at).not.toBeNull();
    const { rows } = await db.pool.query(
      "SELECT type, attempt_count, rejected_recipients FROM mail_events WHERE job_id = $1",
      [id],
    );
    expect(rows).toEqual([
      {
        type: "JOB_SENT",
        attempt_count: 1,
        rejected_recipients: [{ address: "x@example.invalid", code: 452 }],
      },
    ]);
  });

  it("영구 오류는 재시도 없이 FAILED가 된다", async () => {
    const id = await createJob(db.pool);
    const [job] = await claim(db.pool, claimOpts);

    const result = await completeAttempt(
      db.pool,
      { id, leaseToken: job!.leaseToken },
      {
        classification: "PERMANENT",
        responseCode: 550,
        enhancedCode: "5.1.1",
        stage: "RCPT",
      },
      deps,
    );

    expect(result).toMatchObject({ applied: true, status: "FAILED" });
    expect((await jobRow(id)).failure_reason).toBe("PERMANENT");
    const { rows } = await db.pool.query(
      "SELECT type, failure_reason, failure_detail FROM mail_events WHERE job_id = $1",
      [id],
    );
    expect(rows).toEqual([
      {
        type: "JOB_FAILED",
        failure_reason: "PERMANENT",
        failure_detail: "550 5.1.1",
      },
    ]);
  });

  it("일시 오류는 최대 시도 횟수 전까지 RETRY_WAIT이고 소진하면 FAILED가 된다", async () => {
    const id = await createJob(db.pool);
    const [first] = await claim(db.pool, claimOpts);
    const retry = await completeAttempt(
      db.pool,
      { id, leaseToken: first!.leaseToken },
      { classification: "TRANSIENT" },
      deps,
    );
    expect(retry).toMatchObject({ applied: true, status: "RETRY_WAIT" });
    const waiting = await jobRow(id);
    const delayMs = waiting.next_attempt_at.getTime() - waiting.now.getTime();
    expect(delayMs).toBeGreaterThan(55_000);
    expect(delayMs).toBeLessThan(65_000);

    await pastDue(db.pool, id);
    const [second] = await claim(db.pool, claimOpts);
    const last = await completeAttempt(
      db.pool,
      { id, leaseToken: second!.leaseToken },
      { classification: "TRANSIENT" },
      deps,
    );

    expect(last).toMatchObject({ applied: true, status: "FAILED" });
    const row = await jobRow(id);
    expect(row.attempts).toBe(2);
    expect(row.failure_reason).toBe("ATTEMPTS_EXHAUSTED");
  });

  it("다음 시도가 만료 시각보다 뒤이면 대기하지 않고 EXPIRED가 된다(ADR-0003 결정 6)", async () => {
    const id = await createJob(db.pool, { expiresInSeconds: 30 });
    const [job] = await claim(db.pool, claimOpts);

    const result = await completeAttempt(
      db.pool,
      { id, leaseToken: job!.leaseToken },
      { classification: "TRANSIENT" },
      deps,
    );

    expect(result).toMatchObject({ applied: true, status: "EXPIRED" });
    const { rows } = await db.pool.query(
      "SELECT type FROM mail_events WHERE job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ type: "JOB_EXPIRED" }]);
  });
});
