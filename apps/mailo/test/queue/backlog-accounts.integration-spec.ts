import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import {
  BACKLOG_COUNT_LIMIT,
  getQueueBacklog,
  countOrphanAccountJobs,
  getQueueDepth,
} from "../../src/queue/index.js";
import { countingPool } from "../support/counting-pool.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { createJob, migrate, pastDue } from "../support/queue-fixtures.js";

/**
 * 계정별 건수 쿼리의 합산(RQ-031·037, ADR-0013 결정 3 아). 실제 PostgreSQL을 쓴다.
 * 계정마다 상수 계정 쿼리로 읽고 합친다. 계정이 하나면 이전과 같은 값·같은 문장 수다.
 */
describe("PostgreSQL 통합: 계정별 적체 건수의 합산 (RQ-031, ADR-0013 결정 3 아)", () => {
  let db: TestDatabase;

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

  async function due(accountId: string, ageSeconds = 1) {
    const id = await createJob(db.pool, { accountId });
    await db.pool.query(
      "UPDATE mail_jobs SET next_attempt_at = now() - make_interval(secs => $2) WHERE id = $1",
      [id, ageSeconds],
    );
    return id;
  }

  async function bulk(
    accountId: string,
    n: number,
    status: "PENDING" | "RETRY_WAIT",
    nextAttempt: string,
  ) {
    await db.pool.query(
      `INSERT INTO mail_jobs (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version,
                              expires_at, recipients, account_id, status, next_attempt_at)
       SELECT gen_random_uuid(), 'bulk', $1 || '-' || $3 || '-' || g, '\\x00', 1, now() + interval '1 day', '{}'::jsonb,
              $1, $3, ${nextAttempt}
         FROM generate_series(1, $2) g`,
      [accountId, n, status],
    );
  }

  it("dueCount는 구성한 계정의 값을 합치고 oldest는 가장 큰 값이다", async () => {
    await due("default", 10);
    await due("default", 10);
    await due("marketing", 100);
    // 구성하지 않은 계정은 점유되지 않으므로 세지 않는다.
    await due("retired", 1_000);

    const backlog = await getQueueBacklog(db.pool, ["default", "marketing"]);

    expect(backlog.dueCount).toBe(3);
    expect(backlog.truncated).toBe(false);
    expect(backlog.oldestDueAgeSeconds).toBeGreaterThanOrEqual(100);
    expect(backlog.oldestDueAgeSeconds).toBeLessThan(200);
    expect(backlog.byPriority.NORMAL.dueCount).toBe(3);
    expect(backlog.byPriority.URGENT.dueCount).toBe(0);
  });

  it("계정별 값을 합쳐도 계약의 상한(10000)을 넘지 않는다. 합이 상한을 넘으면 truncated가 true다(계정 둘 6000건씩)", async () => {
    await bulk("default", 6000, "PENDING", "now() - interval '1 minute'");
    await bulk("marketing", 6000, "PENDING", "now() - interval '1 minute'");

    const backlog = await getQueueBacklog(db.pool, ["default", "marketing"]);

    expect(backlog.dueCount).toBe(BACKLOG_COUNT_LIMIT);
    expect(backlog.truncated).toBe(true);
    expect(backlog.byPriority.NORMAL).toMatchObject({
      dueCount: BACKLOG_COUNT_LIMIT,
      truncated: true,
    });
    for (const p of ["LOW", "HIGH", "URGENT"] as const)
      expect(backlog.byPriority[p]).toMatchObject({
        dueCount: 0,
        truncated: false,
      });
  });

  it("한 계정이 상한을 넘은 경우도 상한으로 멈추고 truncated가 true다", async () => {
    await bulk(
      "default",
      BACKLOG_COUNT_LIMIT + 5,
      "PENDING",
      "now() - interval '1 minute'",
    );
    await bulk("marketing", 3, "PENDING", "now() - interval '1 minute'");

    const backlog = await getQueueBacklog(db.pool, ["default", "marketing"]);

    expect(backlog).toMatchObject({
      dueCount: BACKLOG_COUNT_LIMIT,
      truncated: true,
    });
  });

  it("합이 정확히 상한이면 truncated가 false다", async () => {
    await bulk("default", 6000, "PENDING", "now() - interval '1 minute'");
    await bulk("marketing", 4000, "PENDING", "now() - interval '1 minute'");

    const backlog = await getQueueBacklog(db.pool, ["default", "marketing"]);

    expect(backlog).toMatchObject({
      dueCount: BACKLOG_COUNT_LIMIT,
      truncated: false,
    });
  });

  it("어느 계정도 상한에 닿지 않으면 truncated는 false다", async () => {
    await bulk("default", 50, "PENDING", "now() - interval '1 minute'");
    await bulk("marketing", 50, "PENDING", "now() - interval '1 minute'");

    const backlog = await getQueueBacklog(db.pool, ["default", "marketing"]);

    expect(backlog).toMatchObject({ dueCount: 100, truncated: false });
  });

  it("계정이 하나면 문장 하나이고 계정이 N개면 N문장이다", async () => {
    await due("default");
    const one = countingPool(db.pool);
    await getQueueBacklog(one.pool, ["default"]);
    expect(one.count()).toBe(1);

    const three = countingPool(db.pool);
    await getQueueBacklog(three.pool, ["default", "marketing", "billing"]);
    expect(three.count()).toBe(3);
  });

  it("같은 계정 ID가 겹쳐도 한 번만 센다", async () => {
    await due("default");

    const backlog = await getQueueBacklog(db.pool, ["default", "default"]);

    expect(backlog.dueCount).toBe(1);
  });

  it("getQueueDepth도 due·scheduled 합이 상한(10000)을 넘지 않고 truncated가 true다", async () => {
    for (const account of ["default", "marketing"])
      await bulk(account, 6000, "RETRY_WAIT", "now() + interval '1 hour'");
    for (const account of ["default", "marketing"])
      await bulk(account, 6000, "PENDING", "now() - interval '1 minute'");

    const depth = await getQueueDepth(db.pool, ["default", "marketing"]);

    expect(depth.due).toEqual({ count: BACKLOG_COUNT_LIMIT, truncated: true });
    expect(depth.scheduled).toEqual({
      count: BACKLOG_COUNT_LIMIT,
      truncated: true,
    });
  });

  it("getQueueDepth의 문장 수는 계정이 하나면 2(예전과 같음), N개면 2N이다(sending은 scheduled와 한 문장)", async () => {
    await due("default");
    const one = countingPool(db.pool);
    await getQueueDepth(one.pool, ["default"]);
    expect(one.count()).toBe(2);

    const three = countingPool(db.pool);
    await getQueueDepth(three.pool, ["default", "marketing", "billing"]);
    expect(three.count()).toBe(6);
  });

  it("getQueueDepth의 scheduled는 계정별 합이고 sending은 계정을 가리지 않는 전체 점유 중 수다", async () => {
    const later = async (accountId: string) => {
      const id = await createJob(db.pool, { accountId });
      await db.pool.query(
        "UPDATE mail_jobs SET status = 'RETRY_WAIT', next_attempt_at = now() + interval '1 hour' WHERE id = $1",
        [id],
      );
    };
    await later("default");
    await later("marketing");
    await later("marketing");
    await later("retired");
    const sending = await due("marketing");
    await pastDue(db.pool, sending);
    await db.pool.query(
      `UPDATE mail_jobs SET status = 'SENDING', lease_token = gen_random_uuid(), leased_at = now(),
         lease_until = now() + interval '1 minute' WHERE id = $1`,
      [sending],
    );

    const depth = await getQueueDepth(db.pool, ["default", "marketing"]);

    expect(depth.scheduled).toEqual({ count: 3, truncated: false });
    expect(depth.sending).toBe(1);
    expect(depth.due.count).toBe(0);
  });

  describe("countOrphanAccountJobs: 구성 밖 계정의 비종결 작업 (ADR-0013 결정 2)", () => {
    it("대기 중이거나 점유 중인 구성 밖 계정만 계정별로 센다", async () => {
      await due("retired");
      await due("retired");
      await due("other");
      await due("default");
      const sending = await due("sunset");
      await db.pool.query(
        `UPDATE mail_jobs SET status = 'SENDING', lease_token = gen_random_uuid(), leased_at = now(),
           lease_until = now() + interval '1 minute' WHERE id = $1`,
        [sending],
      );
      const done = await due("retired");
      await db.pool.query(
        "UPDATE mail_jobs SET status = 'SENT', finished_at = now() WHERE id = $1",
        [done],
      );

      expect(await countOrphanAccountJobs(db.pool, ["default"])).toEqual([
        { accountId: "other", count: 1 },
        { accountId: "retired", count: 2 },
        { accountId: "sunset", count: 1 },
      ]);
      expect(
        await countOrphanAccountJobs(db.pool, [
          "default",
          "retired",
          "other",
          "sunset",
        ]),
      ).toEqual([]);
    });

    it("대기·점유 작업이 없으면 빈 배열이다", async () => {
      expect(await countOrphanAccountJobs(db.pool, ["default"])).toEqual([]);
    });

    it("대기·점유 중이면서 같은 계정에 걸친 작업은 합쳐 센다", async () => {
      await due("retired");
      const sending = await due("retired");
      await db.pool.query(
        `UPDATE mail_jobs SET status = 'SENDING', lease_token = gen_random_uuid(), leased_at = now(),
           lease_until = now() + interval '1 minute' WHERE id = $1`,
        [sending],
      );

      expect(await countOrphanAccountJobs(db.pool, ["default"])).toEqual([
        { accountId: "retired", count: 2 },
      ]);
    });
  });
});
