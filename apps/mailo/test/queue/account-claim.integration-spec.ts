import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import {
  claim,
  completeAttempt,
  ensureBreakerRows,
  getBreakerState,
  type AccountErrorReason,
  type ClaimedJob,
} from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  completeDeps,
  createJob,
  migrate,
  pastDue,
} from "../support/queue-fixtures.js";

/**
 * 계정 단위 점유와 계정별 차단기(RQ-054·055, ADR-0013 결정 3). 실제 PostgreSQL을 쓴다.
 * `claim`은 계정 하나만 다루고 차단기 행·모드·대표 작업·정지·24시간 할당이 계정마다 독립이다.
 * 시간 경과는 `open_until` 같은 DB 시각 열을 과거로 당겨 흉내 낸다.
 */
describe("PostgreSQL 통합: 계정 단위 claim (RQ-054·055, ADR-0013 결정 3)", () => {
  let db: TestDatabase;
  const deps = completeDeps();
  const base = { leaseSeconds: 120, limit: 10, deps };

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query("DELETE FROM mail_send_controls");
    await db.pool.query(
      "DELETE FROM mail_circuit_breaker WHERE breaker_key <> 'default'",
    );
    await db.pool.query(
      `UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL,
         probe_job_id = NULL, consecutive_failures = 0, wait_seconds = 0, last_reason = NULL,
         last_trip_job_id = NULL, last_trip_token = NULL`,
    );
    await ensureBreakerRows(db.pool, ["default", "marketing", "billing"]);
  });

  afterAll(async () => {
    await db.close();
  });

  const claimFor = (accountId: string, extra: Record<string, unknown> = {}) =>
    claim(db.pool, { ...base, accountId, ...extra });

  const breakerOf = (key: string) =>
    getBreakerState(db.pool, { breakerKey: key });

  async function fail(
    job: ClaimedJob,
    reason: AccountErrorReason = "CONNECTION",
  ) {
    return completeAttempt(
      db.pool,
      { id: job.id, leaseToken: job.leaseToken },
      { classification: "ACCOUNT", reason, afterMailFrom: false },
      deps,
    );
  }

  async function sent(job: ClaimedJob) {
    return completeAttempt(
      db.pool,
      { id: job.id, leaseToken: job.leaseToken },
      { classification: "SENT", rejectedRecipients: null },
      deps,
    );
  }

  /** 계정 차단기를 연속 실패 3회로 연다(임계값 기본 3). */
  async function trip(accountId: string) {
    for (let i = 0; i < 3; i += 1) {
      await createJob(db.pool, { accountId });
      const [job] = await claimFor(accountId, { limit: 1 });
      await fail(job!);
    }
    expect((await breakerOf(accountId)).state).toBe("open");
  }

  async function openDue(accountId: string) {
    await db.pool.query(
      "UPDATE mail_circuit_breaker SET open_until = now() - interval '1 second' WHERE breaker_key = $1",
      [accountId],
    );
    await db.pool.query(
      "UPDATE mail_jobs SET next_attempt_at = now() - interval '1 second' WHERE status = 'RETRY_WAIT'",
    );
  }

  describe("계정별 점유", () => {
    it("claim은 지정한 계정의 작업만 점유한다", async () => {
      const own = await createJob(db.pool, { accountId: "marketing" });
      await createJob(db.pool, { accountId: "default" });
      await createJob(db.pool, { accountId: "billing" });

      const claimed = await claimFor("marketing");

      expect(claimed.map((j) => j.id)).toEqual([own]);
      expect(claimed[0]).toMatchObject({ accountId: "marketing" });
    });

    it("accountId를 생략하면 deps.breaker.breakerKey(default) 계정만 점유한다", async () => {
      await createJob(db.pool, { accountId: "marketing" });
      const mine = await createJob(db.pool, { accountId: "default" });

      const claimed = await claim(db.pool, base);

      expect(claimed.map((j) => j.id)).toEqual([mine]);
    });

    it("구성 밖 계정의 작업은 어떤 계정의 claim으로도 점유되지 않는다", async () => {
      await createJob(db.pool, { accountId: "retired" });

      expect(await claimFor("default")).toEqual([]);
      expect(await claimFor("marketing")).toEqual([]);
      const { rows } = await db.pool.query(
        "SELECT status FROM mail_jobs WHERE account_id = 'retired'",
      );
      expect(rows).toEqual([{ status: "PENDING" }]);
    });

    it("대기 순서 경로(fifo)도 계정 조건을 지킨다", async () => {
      await createJob(db.pool, { accountId: "default" });
      const mine = await createJob(db.pool, { accountId: "marketing" });

      const claimed = await claimFor("marketing", { order: "fifo" });

      expect(claimed.map((j) => j.id)).toEqual([mine]);
    });

    it("차단기 행이 없는 계정의 claim은 예외를 던진다(fail-closed)", async () => {
      await createJob(db.pool, { accountId: "ghost" });

      await expect(claimFor("ghost")).rejects.toThrow("차단기 행이 없다");
    });
  });

  describe("계정 격리: 차단기 (RQ-054, ADR-0013 결정 3 나)", () => {
    it("계정 A의 차단기 open은 계정 B의 점유를 막지 않는다", async () => {
      await trip("marketing");
      await createJob(db.pool, { accountId: "marketing" });
      const other = await createJob(db.pool, { accountId: "default" });

      expect(await claimFor("marketing")).toEqual([]);
      expect((await claimFor("default")).map((j) => j.id)).toEqual([other]);
    });

    it("반대로 default 차단기 open도 다른 계정의 점유를 막지 않는다", async () => {
      await trip("default");
      await createJob(db.pool, { accountId: "default" });
      const other = await createJob(db.pool, { accountId: "marketing" });

      expect(await claimFor("default")).toEqual([]);
      expect((await claimFor("marketing")).map((j) => j.id)).toEqual([other]);
    });

    it("A의 대표 작업(half_open)은 A의 작업만 고른다(B의 더 오래된 작업을 고르지 않는다)", async () => {
      await createJob(db.pool, { accountId: "billing" });
      await trip("marketing");
      await openDue("marketing");
      const mine = await createJob(db.pool, { accountId: "marketing" });
      await pastDue(db.pool, mine);

      const claimed = await claimFor("marketing");

      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        accountId: "marketing",
        isProbe: true,
      });
    });

    it("비default 계정의 open → half_open → closed 전이가 이루어지고 다른 계정의 차단기는 그대로다", async () => {
      await trip("marketing");
      const retry = await createJob(db.pool, { accountId: "marketing" });
      await openDue("marketing");

      const [probe] = await claimFor("marketing");
      expect(probe!.isProbe).toBe(true);
      expect(await breakerOf("marketing")).toMatchObject({
        state: "half_open",
        probeJobId: probe!.id,
      });
      // 대표 작업이 진행 중이면 같은 계정의 다른 점유는 없다.
      expect(await claimFor("marketing")).toEqual([]);

      await sent(probe!);

      expect(await breakerOf("marketing")).toMatchObject({
        state: "closed",
        consecutiveFailures: 0,
      });
      expect(await breakerOf("default")).toMatchObject({ state: "closed" });
      // 닫힌 뒤에는 남은 작업을 일반 점유로 가져간다.
      await pastDue(db.pool, retry);
      expect((await claimFor("marketing")).length).toBeGreaterThan(0);
    });

    it("비default 계정 대표 작업이 실패하면 open으로 돌아가고 대기가 2배가 된다", async () => {
      await trip("marketing");
      const first = (await breakerOf("marketing")).waitSeconds;
      await createJob(db.pool, { accountId: "marketing" });
      await openDue("marketing");
      const [probe] = await claimFor("marketing");

      await fail(probe!);

      const after = await breakerOf("marketing");
      expect(after.state).toBe("open");
      expect(after.waitSeconds).toBe(Math.min(first * 2, 600));
      expect(await breakerOf("default")).toMatchObject({ state: "closed" });
    });

    it("내부 오류로 끝난 대표 작업은 그 계정을 닫지 않는다(internal: true)", async () => {
      await trip("marketing");
      await createJob(db.pool, { accountId: "marketing" });
      await openDue("marketing");
      const [probe] = await claimFor("marketing");

      await completeAttempt(
        db.pool,
        { id: probe!.id, leaseToken: probe!.leaseToken },
        { classification: "TRANSIENT", internal: true, stage: "WORKER" },
        deps,
      );

      expect(await breakerOf("marketing")).toMatchObject({
        state: "half_open",
      });
    });

    it("open 대기 시간이 남은 계정의 claim은 점유 쿼리 없이 빈 배열이다", async () => {
      await trip("marketing");
      await createJob(db.pool, { accountId: "marketing" });

      expect(await claimFor("marketing")).toEqual([]);
    });
  });

  describe("계정 상태 오류의 재시도 시각 (RQ-054, ADR-0013 결정 3)", () => {
    it("차단기가 열린 계정 오류의 재시도는 open_until이며 미래다", async () => {
      await createJob(db.pool, { accountId: "marketing" });
      await createJob(db.pool, { accountId: "marketing" });
      await createJob(db.pool, { accountId: "marketing" });
      const jobs = await claimFor("marketing", { limit: 3 });

      let last;
      for (const job of jobs) last = await fail(job);

      const breaker = await breakerOf("marketing");
      expect(breaker.state).toBe("open");
      expect(last).toMatchObject({ applied: true, status: "RETRY_WAIT" });
      const { rows } = await db.pool.query<{ future: boolean }>(
        "SELECT next_attempt_at > now() AS future FROM mail_jobs WHERE id = $1",
        [jobs[2]!.id],
      );
      expect(rows[0]!.future).toBe(true);
    });

    it("open_until이 이미 지난 open 상태에서 늦게 도착한 계정 오류도 재시도 시각을 과거로 쓰지 않는다", async () => {
      await createJob(db.pool, { accountId: "marketing" });
      const [job] = await claimFor("marketing", { limit: 1 });
      // 이 작업을 점유한 뒤 다른 경로로 차단기가 열렸고 대기 시간이 이미 지났다.
      await db.pool.query(
        `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() - interval '30 seconds',
           wait_seconds = 30, last_reason = 'CONNECTION' WHERE breaker_key = 'marketing'`,
      );

      const result = await fail(job!);

      expect(result).toMatchObject({ applied: true, status: "RETRY_WAIT" });
      const { rows } = await db.pool.query<{ future: boolean }>(
        "SELECT next_attempt_at > now() AS future FROM mail_jobs WHERE id = $1",
        [job!.id],
      );
      expect(rows[0]!.future).toBe(true);
      // 재시도 시각이 미래라 같은 작업을 곧바로 다시 점유하지 못한다.
      expect(await claimFor("marketing")).toEqual([]);
    });

    it("default 계정도 같은 규칙이다(open_until이 지난 open에서의 늦은 실패)", async () => {
      await createJob(db.pool, { accountId: "default" });
      const [job] = await claimFor("default", { limit: 1 });
      await db.pool.query(
        `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() - interval '30 seconds',
           wait_seconds = 30, last_reason = 'CONNECTION' WHERE breaker_key = 'default'`,
      );

      await fail(job!);

      const { rows } = await db.pool.query<{ future: boolean }>(
        "SELECT next_attempt_at > now() AS future FROM mail_jobs WHERE id = $1",
        [job!.id],
      );
      expect(rows[0]!.future).toBe(true);
    });
  });

  describe("계정 정지 (RQ-043·054, ADR-0013 결정 3 다)", () => {
    const pauseAccount = (id: string) =>
      db.pool.query(
        "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('account', $1, 'ops')",
        [id],
      );

    it("정지한 계정만 점유가 멈추고 다른 계정은 계속 점유한다", async () => {
      await createJob(db.pool, { accountId: "marketing" });
      const other = await createJob(db.pool, { accountId: "default" });
      await pauseAccount("marketing");

      expect(await claimFor("marketing")).toEqual([]);
      expect((await claimFor("default")).map((j) => j.id)).toEqual([other]);
    });

    it("정지한 계정은 대표 작업도 점유하지 않고 정지를 풀어도 차단기 상태는 바뀌지 않는다", async () => {
      await trip("marketing");
      await createJob(db.pool, { accountId: "marketing" });
      await openDue("marketing");
      await pauseAccount("marketing");

      expect(await claimFor("marketing")).toEqual([]);
      expect(await breakerOf("marketing")).toMatchObject({ state: "open" });

      await db.pool.query("DELETE FROM mail_send_controls");
      const [probe] = await claimFor("marketing");
      expect(probe!.isProbe).toBe(true);
    });

    it("전체 정지는 모든 계정을 멈추고 계정 정지는 정지 신호로 전달된다", async () => {
      await createJob(db.pool, { accountId: "marketing" });
      await createJob(db.pool, { accountId: "default" });
      await pauseAccount("billing");
      const seen: Array<readonly string[]> = [];

      const opts = {
        onSendControls: (c: { pausedAccountIds: readonly string[] }) =>
          seen.push(c.pausedAccountIds),
      };
      expect(await claimFor("default", opts)).toHaveLength(1);
      await db.pool.query(
        "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('all', '', 'ops')",
      );
      expect(await claimFor("marketing", opts)).toEqual([]);

      expect(seen[0]).toEqual(["billing"]);
    });
  });

  describe("계정 24시간 할당 (RQ-055, ADR-0013 결정 3 라)", () => {
    /** 계정에 시도 기록을 직접 넣는다(`mail_attempts`의 `account_id` 복사본 포함). */
    async function attempts(
      accountId: string,
      n: number,
      extra: { stage?: string; ageHours?: number; counted?: boolean } = {},
    ) {
      const jobId = await createJob(db.pool, { accountId });
      await db.pool.query(
        `UPDATE mail_jobs SET status = 'SENT', finished_at = now() WHERE id = $1`,
        [jobId],
      );
      await db.pool.query(
        `INSERT INTO mail_attempts (job_id, classification, counted, stage, started_at, finished_at, caller_id, account_id)
         SELECT $1, 'SENT', $2, $3, now(), now() - make_interval(hours => $4), 'caller-a', $5
           FROM generate_series(1, $6)`,
        [
          jobId,
          extra.counted ?? true,
          extra.stage ?? null,
          extra.ageHours ?? 0,
          accountId,
          n,
        ],
      );
    }

    it("사용량(최근 24시간 시도 + SENDING)만큼 점유 건수를 줄인다", async () => {
      for (let i = 0; i < 6; i += 1)
        await createJob(db.pool, { accountId: "marketing" });
      await attempts("marketing", 3);

      const claimed = await claimFor("marketing", {
        accountQuota: 5,
        limit: 10,
      });

      expect(claimed).toHaveLength(2);
      // 점유한 작업은 SENDING이라 사용량에 들어간다. 이어서 점유하면 남은 것이 없다.
      expect(await claimFor("marketing", { accountQuota: 5 })).toEqual([]);
    });

    it("한도에 닿으면 점유하지 않고 알린다. 대표 작업도 점유하지 않는다", async () => {
      await createJob(db.pool, { accountId: "marketing" });
      await attempts("marketing", 2);
      const reports: Array<{ limit: number } | null> = [];

      expect(
        await claimFor("marketing", {
          accountQuota: 2,
          onAccountQuota: (b: { limit: number } | null) => reports.push(b),
        }),
      ).toEqual([]);
      expect(reports).toEqual([{ limit: 2 }]);

      await trip("billing");
      await attempts("billing", 4);
      await createJob(db.pool, { accountId: "billing" });
      await openDue("billing");
      expect(await claimFor("billing", { accountQuota: 4 })).toEqual([]);
    });

    it("한도 안이면 알림에 null을 준다", async () => {
      await createJob(db.pool, { accountId: "marketing" });
      const reports: Array<{ limit: number } | null> = [];

      await claimFor("marketing", {
        accountQuota: 5,
        onAccountQuota: (b: { limit: number } | null) => reports.push(b),
      });

      expect(reports).toEqual([null]);
    });

    it("한도에 걸린 계정이 다른 계정의 점유를 막지 않는다", async () => {
      await createJob(db.pool, { accountId: "marketing" });
      const other = await createJob(db.pool, { accountId: "default" });
      await attempts("marketing", 3);

      expect(await claimFor("marketing", { accountQuota: 3 })).toEqual([]);
      expect((await claimFor("default")).map((j) => j.id)).toEqual([other]);
    });

    it("내부 오류(stage WORKER)·counted=false·24시간 지난 시도는 사용량에 들지 않는다", async () => {
      for (let i = 0; i < 4; i += 1)
        await createJob(db.pool, { accountId: "marketing" });
      await attempts("marketing", 5, { stage: "WORKER" });
      await attempts("marketing", 5, { counted: false });
      await attempts("marketing", 5, { ageHours: 25 });
      // 다른 계정의 시도는 세지 않는다.
      await attempts("default", 5);

      const claimed = await claimFor("marketing", { accountQuota: 3 });

      expect(claimed).toHaveLength(3);
    });

    it("호출처 할당과 겹치면 더 작은 쪽으로 줄인다(min)", async () => {
      for (let i = 0; i < 6; i += 1)
        await createJob(db.pool, { accountId: "marketing" });

      const claimed = await claimFor("marketing", {
        accountQuota: 5,
        callerQuotas: new Map([["caller-a", 2]]),
      });

      expect(claimed).toHaveLength(2);
    });

    it("계정 한도가 더 작으면 호출처 할당이 넉넉해도 계정 한도까지만 점유한다", async () => {
      for (let i = 0; i < 6; i += 1)
        await createJob(db.pool, { accountId: "marketing" });

      const claimed = await claimFor("marketing", {
        accountQuota: 1,
        callerQuotas: new Map([["caller-a", 50]]),
      });

      expect(claimed).toHaveLength(1);
    });

    it("한도가 없으면 사용량을 보지 않는다(accountQuota 생략)", async () => {
      for (let i = 0; i < 3; i += 1)
        await createJob(db.pool, { accountId: "marketing" });
      await attempts("marketing", 100);

      expect(await claimFor("marketing")).toHaveLength(3);
    });

    it("인스턴스 12개가 동시에 점유해도 계정 한도를 넘지 않는다(초과 0건)", async () => {
      const limit = 5;
      for (let i = 0; i < 60; i += 1)
        await createJob(db.pool, { accountId: "marketing" });
      for (let i = 0; i < 20; i += 1)
        await createJob(db.pool, { accountId: "default" });

      const claimed: ClaimedJob[] = [];
      for (let round = 0; round < 3; round += 1) {
        const batches = await Promise.all(
          Array.from({ length: 12 }, () =>
            claimFor("marketing", { accountQuota: limit, limit: 3 }),
          ),
        );
        claimed.push(...batches.flat());
        expect(claimed.length).toBeLessThanOrEqual(limit);
      }
      for (let i = 0; i < 10; i += 1)
        claimed.push(...(await claimFor("marketing", { accountQuota: limit })));

      expect(new Set(claimed.map((j) => j.id)).size).toBe(claimed.length);
      expect(claimed).toHaveLength(limit);
      const { rows } = await db.pool.query(
        "SELECT count(*)::int AS n FROM mail_jobs WHERE account_id = 'marketing' AND status = 'SENDING'",
      );
      expect(rows[0].n).toBe(limit);
    });
  });
});
