import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import {
  InvalidCursorError,
  getFeedLag,
  listEvents,
  recordIntakeRejection,
  recordJobEvent,
} from "../../src/events/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { createJob, migrate } from "../support/queue-fixtures.js";

describe("PostgreSQL 통합: 이벤트 피드(ADR-0006 결정 2·7, RQ-017)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_events");
    await db.pool.query("DELETE FROM mail_intake_rejections");
  });

  afterAll(async () => {
    await db.close();
  });

  const event = (jobId: string, callerId = "caller-a") => ({
    type: "JOB_FAILED" as const,
    callerId,
    jobId,
    idempotencyKey: `k-${jobId}`,
    failureReason: "PERMANENT",
    attemptCount: 1,
    recipients: { to: ["to@example.invalid"] },
  });

  it("미커밋 트랜잭션 때문에 커밋 순서가 뒤바뀐 이벤트를 건너뛰지 않는다", async () => {
    const jobA = await createJob(db.pool);
    const jobB = await createJob(db.pool);
    const slow = await db.pool.connect();
    const fast = await db.pool.connect();
    try {
      // slow가 먼저 xid를 받고 늦게 커밋한다. fast는 나중에 시작해 먼저 커밋한다.
      await slow.query("BEGIN");
      await recordJobEvent(slow, event(jobA));
      await fast.query("BEGIN");
      await recordJobEvent(fast, event(jobB));
      await fast.query("COMMIT");

      // id만 보는 cursor라면 B(커밋됨)를 읽은 뒤 A를 영구히 놓친다
      const naive = await db.pool.query("SELECT job_id FROM mail_events");
      expect(naive.rows.map((r) => r.job_id)).toEqual([jobB]);
      const hidden = await listEvents(db.pool, { callerId: "caller-a" });
      expect(hidden.events).toEqual([]);

      await slow.query("COMMIT");
    } finally {
      slow.release();
      fast.release();
    }

    const first = await listEvents(db.pool, { callerId: "caller-a", limit: 1 });
    const second = await listEvents(db.pool, {
      callerId: "caller-a",
      after: first.nextCursor,
      limit: 1,
    });
    const third = await listEvents(db.pool, {
      callerId: "caller-a",
      after: second.nextCursor,
    });
    expect(first.events.map((e) => e.jobId)).toEqual([jobA]);
    expect(second.events.map((e) => e.jobId)).toEqual([jobB]);
    expect(third.events).toEqual([]);
    expect(third.nextCursor).toBe(second.nextCursor);
    // A의 이벤트 id가 B보다 작아 id 기준 cursor였다면 건너뛰는 상황이었다
    expect(Number(first.events[0]!.id)).toBeLessThan(
      Number(second.events[0]!.id),
    );
  });

  it("호출처는 자기 이벤트만 읽고 type으로 거를 수 있다", async () => {
    const mine = await createJob(db.pool);
    const theirs = await createJob(db.pool, { callerId: "caller-b" });
    await recordJobEvent(db.pool, event(mine));
    await recordJobEvent(db.pool, {
      ...event(mine),
      type: "JOB_SENT",
      failureReason: null,
    });
    await recordJobEvent(db.pool, event(theirs, "caller-b"));

    const all = await listEvents(db.pool, { callerId: "caller-a" });
    const sentOnly = await listEvents(db.pool, {
      callerId: "caller-a",
      type: "JOB_SENT",
    });

    expect(all.events.map((e) => e.type)).toEqual(["JOB_FAILED", "JOB_SENT"]);
    expect(sentOnly.events.map((e) => e.type)).toEqual(["JOB_SENT"]);
    expect(all.events[0]).toMatchObject({
      jobId: mine,
      idempotencyKey: `k-${mine}`,
      failureReason: "PERMANENT",
      attemptCount: 1,
      recipients: { to: ["to@example.invalid"] },
    });
  });

  it("잘못된 cursor는 InvalidCursorError로 거부한다", async () => {
    await expect(
      listEvents(db.pool, { callerId: "caller-a", after: "not-a-cursor" }),
    ).rejects.toThrow(InvalidCursorError);
  });

  it("수집 거부는 (caller, 파일 이름, sha256)으로 멱등하게 기록하고 INTAKE_REJECTED 이벤트를 쓴다", async () => {
    const input = {
      callerId: "caller-a",
      fileName: "req-1.json",
      sizeBytes: 120,
      sha256: "a".repeat(64),
      idempotencyKey: "rejected-key",
      reasonCode: "FINGERPRINT_MISMATCH",
    };

    const first = await recordIntakeRejection(db.pool, input);
    const again = await recordIntakeRejection(db.pool, input);

    expect(first).not.toBeNull();
    expect(again).toBeNull();
    const page = await listEvents(db.pool, {
      callerId: "caller-a",
      type: "INTAKE_REJECTED",
    });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      type: "INTAKE_REJECTED",
      jobId: null,
      rejectionId: first,
      idempotencyKey: "rejected-key",
      failureReason: "FINGERPRINT_MISMATCH",
    });
  });

  describe("피드 지연(RQ-017: 현재 시각 − 최신 반환 이벤트 시각)", () => {
    /** created_at은 쓰는 트랜잭션의 now()라서 지연을 만들려면 직접 과거로 돌린다. */
    async function backdate(jobId: string, seconds: number) {
      await db.pool.query(
        `UPDATE mail_events SET created_at = now() - make_interval(secs => $2) WHERE job_id = $1`,
        [jobId, seconds],
      );
    }

    it("이벤트가 없으면 둘 다 null이다", async () => {
      expect(await getFeedLag(db.pool, "caller-a")).toEqual({
        latestEventAt: null,
        lagSeconds: null,
      });
    });

    it("가장 최근에 반환되는 이벤트의 시각으로 계산하고 다른 호출처 이벤트는 보지 않는다", async () => {
      const older = await createJob(db.pool);
      const newer = await createJob(db.pool);
      const other = await createJob(db.pool, { callerId: "caller-b" });
      await recordJobEvent(db.pool, event(older));
      await recordJobEvent(db.pool, event(newer));
      await recordJobEvent(db.pool, event(other, "caller-b"));
      await backdate(older, 300);
      await backdate(newer, 90);
      await backdate(other, 5);

      const lag = await getFeedLag(db.pool, "caller-a");

      expect(lag.lagSeconds).toBeGreaterThanOrEqual(90);
      expect(lag.lagSeconds).toBeLessThan(100);
      const feed = await listEvents(db.pool, { callerId: "caller-a" });
      expect(feed.events.map((e) => e.jobId)).toEqual([older, newer]);
      expect(lag.latestEventAt).toEqual(feed.events.at(-1)!.createdAt);
    });

    it("미커밋 트랜잭션 때문에 피드에 보이지 않는 이벤트는 지연 계산에서 제외한다", async () => {
      const visible = await createJob(db.pool);
      const stuck = await createJob(db.pool);
      const hiddenJob = await createJob(db.pool);
      await recordJobEvent(db.pool, event(visible));
      await backdate(visible, 600);
      const slow = await db.pool.connect();
      try {
        await slow.query("BEGIN");
        await recordJobEvent(slow, event(stuck));
        await recordJobEvent(db.pool, event(hiddenJob)); // 커밋됐지만 slow보다 나중 xid라 피드에 안 보인다

        const feed = await listEvents(db.pool, { callerId: "caller-a" });
        const lag = await getFeedLag(db.pool, "caller-a");

        expect(feed.events.map((e) => e.jobId)).toEqual([visible]);
        expect(lag.lagSeconds).toBeGreaterThanOrEqual(600);
        expect(lag.lagSeconds).toBeLessThan(610);
      } finally {
        await slow.query("ROLLBACK");
        slow.release();
      }
    });
  });
});
