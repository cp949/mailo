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
  countOrphanAccountJobs,
  ensureBreakerRows,
  getBreakerState,
  register,
  sweepExpired,
  type ClaimedJob,
} from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  completeDeps,
  createJob,
  jobInput,
  migrate,
  pastDue,
  registerDeps,
} from "../support/queue-fixtures.js";

/**
 * 작업의 SMTP 계정 고정과 계정 단위 차단기 키(RQ-054, ADR-0013 결정 2·3 나).
 * 실제 PostgreSQL을 쓴다. 묶음 A는 한 번의 `claim`이 구성한 계정의 작업을 모두 다루고,
 * 차단기 행은 완료 경로에서 작업 행의 계정으로 정한다.
 */
describe("PostgreSQL 통합: 작업의 account_id와 계정 차단기 (RQ-054, ADR-0013 결정 2·3)", () => {
  let db: TestDatabase;
  const deps = completeDeps();
  const claimOpts = { leaseSeconds: 120, limit: 10, deps };

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query(
      "DELETE FROM mail_circuit_breaker WHERE breaker_key <> 'default'",
    );
    await db.pool.query(
      `UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL,
         probe_job_id = NULL, consecutive_failures = 0, wait_seconds = 0, last_reason = NULL,
         last_trip_job_id = NULL, last_trip_token = NULL`,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  const accountOf = async (jobId: string) =>
    (
      await db.pool.query<{ account_id: string }>(
        "SELECT account_id FROM mail_jobs WHERE id = $1",
        [jobId],
      )
    ).rows[0]!.account_id;

  describe("등록 때 계정 고정", () => {
    it("register는 입력의 accountId를 mail_jobs.account_id에 쓴다", async () => {
      const marketing = await createJob(db.pool, { accountId: "marketing" });
      const plain = await createJob(db.pool, { accountId: "default" });

      expect(await accountOf(marketing)).toBe("marketing");
      expect(await accountOf(plain)).toBe("default");
    });

    it("같은 Key를 다른 계정으로 다시 등록해도 기존 작업의 계정은 바뀌지 않고 중복으로 돌려준다(지문은 계정을 포함하지 않는다)", async () => {
      const first = jobInput({ accountId: "marketing" });
      const created = await register(db.pool, registerDeps, first);
      const again = await register(db.pool, registerDeps, {
        ...first,
        accountId: "default",
      });

      expect(created.kind).toBe("created");
      expect(again).toMatchObject({ kind: "duplicate" });
      expect(await accountOf((created as { jobId: string }).jobId)).toBe(
        "marketing",
      );
    });

    it("denyNew 요청은 아무것도 쓰지 않고 기존 작업의 계정도 건드리지 않는다", async () => {
      const first = jobInput({ accountId: "marketing" });
      const created = await register(db.pool, registerDeps, first);
      const denied = await register(db.pool, registerDeps, {
        ...first,
        accountId: "default",
        denyNew: true,
      });

      expect(denied.kind).toBe("duplicate");
      expect(await accountOf((created as { jobId: string }).jobId)).toBe(
        "marketing",
      );
    });

    it("형식이 틀린 accountId는 DB가 23514로 거부한다(앱 검증을 우회해도 막는 마지막 방어)", async () => {
      await expect(
        register(db.pool, registerDeps, jobInput({ accountId: "Bad Id" })),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("점유", () => {
    it("claim은 작업의 accountId를 ClaimedJob에 싣는다", async () => {
      await ensureBreakerRows(db.pool, ["marketing"]);
      await createJob(db.pool, { accountId: "marketing" });

      const [job] = await claim(db.pool, {
        ...claimOpts,
        accountId: "marketing",
      });

      expect(job).toMatchObject({ accountId: "marketing" });
    });

    it("구성한 계정이 아닌 계정의 작업은 점유하지 않고 상태를 바꾸지 않는다(구성에서 사라진 계정, 결정 2)", async () => {
      const orphan = await createJob(db.pool, { accountId: "retired" });
      const live = await createJob(db.pool, { accountId: "default" });

      const claimed = await claim(db.pool, {
        ...claimOpts,
        accountId: "default",
      });

      expect(claimed.map((j) => j.id)).toEqual([live]);
      const { rows } = await db.pool.query(
        "SELECT status, attempts FROM mail_jobs WHERE id = $1",
        [orphan],
      );
      expect(rows).toEqual([{ status: "PENDING", attempts: 0 }]);
    });

    it("구성에서 사라진 계정의 작업은 만료 sweep이 EXPIRED로 만들고 다른 계정으로 옮기지 않는다(결정 2)", async () => {
      const orphan = await createJob(db.pool, { accountId: "retired" });
      await db.pool.query(
        "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = $1",
        [orphan],
      );

      expect(await sweepExpired(db.pool, 100)).toBe(1);

      const { rows } = await db.pool.query(
        "SELECT status, account_id, failure_reason FROM mail_jobs WHERE id = $1",
        [orphan],
      );
      expect(rows).toEqual([
        { status: "EXPIRED", account_id: "retired", failure_reason: "EXPIRED" },
      ]);
      const events = await db.pool.query(
        "SELECT type FROM mail_events WHERE job_id = $1",
        [orphan],
      );
      expect(events.rows).toEqual([{ type: "JOB_EXPIRED" }]);
    });

    it("countOrphanAccountJobs는 구성 밖 계정의 비종결 작업만 계정별로 센다(종결·구성 안 계정은 센다고 하지 않는다)", async () => {
      await createJob(db.pool, { accountId: "retired" });
      await createJob(db.pool, { accountId: "retired" });
      await createJob(db.pool, { accountId: "other" });
      await createJob(db.pool, { accountId: "default" });
      const done = await createJob(db.pool, { accountId: "retired" });
      await db.pool.query(
        "UPDATE mail_jobs SET status = 'EXPIRED', finished_at = now() WHERE id = $1",
        [done],
      );

      expect(await countOrphanAccountJobs(db.pool, ["default"])).toEqual([
        { accountId: "other", count: 1 },
        { accountId: "retired", count: 2 },
      ]);
      expect(
        await countOrphanAccountJobs(db.pool, ["default", "retired", "other"]),
      ).toEqual([]);
    });

    it("accountId를 생략하면 default 계정의 작업만 점유한다(계정으로 거르지 않던 묶음 A의 동작은 계정별 claim으로 바뀌었다, ADR-0013 결정 3 가)", async () => {
      await createJob(db.pool, { accountId: "marketing" });
      await createJob(db.pool, { accountId: "default" });

      expect(await claim(db.pool, claimOpts)).toHaveLength(1);
    });

    it("half_open 대표 작업은 차단기 계정의 작업만 고른다(다른 계정의 작업이 default 차단기를 닫지 못한다)", async () => {
      await createJob(db.pool, { accountId: "marketing" });
      const mine = await createJob(db.pool, { accountId: "default" });
      await db.pool.query(
        `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() - interval '1 second',
           wait_seconds = 60, last_reason = 'CONNECTION' WHERE breaker_key = 'default'`,
      );

      const claimed = await claim(db.pool, {
        ...claimOpts,
        accountId: "default",
      });

      expect(claimed.map((j) => j.id)).toEqual([mine]);
      expect(claimed[0]!.isProbe).toBe(true);
    });
  });

  describe("완료 경로의 차단기 키", () => {
    async function failConnection(job: ClaimedJob) {
      return completeAttempt(
        db.pool,
        { id: job.id, leaseToken: job.leaseToken },
        {
          classification: "ACCOUNT",
          reason: "CONNECTION",
          afterMailFrom: false,
        },
        deps,
      );
    }

    it("ensureBreakerRows는 없는 계정의 행만 만들고 있는 행은 건드리지 않으며 다시 불러도 같다", async () => {
      await db.pool.query(
        "UPDATE mail_circuit_breaker SET consecutive_failures = 2 WHERE breaker_key = 'default'",
      );

      await ensureBreakerRows(db.pool, ["default", "marketing"]);
      await ensureBreakerRows(db.pool, ["default", "marketing"]);

      const { rows } = await db.pool.query(
        "SELECT breaker_key, state, consecutive_failures FROM mail_circuit_breaker ORDER BY breaker_key",
      );
      expect(rows).toEqual([
        { breaker_key: "default", state: "closed", consecutive_failures: 2 },
        { breaker_key: "marketing", state: "closed", consecutive_failures: 0 },
      ]);
    });

    it("계정 상태 오류는 작업의 계정 차단기만 갱신하고 default 차단기는 그대로다", async () => {
      await ensureBreakerRows(db.pool, ["default", "marketing"]);
      for (let i = 0; i < 3; i += 1)
        await createJob(db.pool, { accountId: "marketing" });

      for (let i = 0; i < 3; i += 1) {
        const [job] = await claim(db.pool, {
          ...claimOpts,
          limit: 1,
          accountId: "marketing",
        });
        await failConnection(job!);
      }

      const marketing = await getBreakerState(db.pool, {
        breakerKey: "marketing",
      });
      const fallback = await getBreakerState(db.pool, {
        breakerKey: "default",
      });
      expect(marketing).toMatchObject({
        state: "open",
        consecutiveFailures: 3,
      });
      expect(fallback).toMatchObject({
        state: "closed",
        consecutiveFailures: 0,
      });
    });

    it("내부 오류(internal)는 작업의 계정 차단기도 건드리지 않는다", async () => {
      await ensureBreakerRows(db.pool, ["marketing"]);
      await db.pool.query(
        "UPDATE mail_circuit_breaker SET consecutive_failures = 1 WHERE breaker_key = 'marketing'",
      );
      await createJob(db.pool, { accountId: "marketing" });
      const [job] = await claim(db.pool, {
        ...claimOpts,
        accountId: "marketing",
      });

      await completeAttempt(
        db.pool,
        { id: job!.id, leaseToken: job!.leaseToken },
        { classification: "TRANSIENT", internal: true, stage: "WORKER" },
        deps,
      );

      expect(
        (await getBreakerState(db.pool, { breakerKey: "marketing" }))
          .consecutiveFailures,
      ).toBe(1);
    });

    it("SENT는 작업의 계정 차단기의 연속 실패를 0으로 만든다", async () => {
      await ensureBreakerRows(db.pool, ["marketing"]);
      await db.pool.query(
        "UPDATE mail_circuit_breaker SET consecutive_failures = 2 WHERE breaker_key IN ('marketing', 'default')",
      );
      await createJob(db.pool, { accountId: "marketing" });
      const [job] = await claim(db.pool, {
        ...claimOpts,
        accountId: "marketing",
      });

      await completeAttempt(
        db.pool,
        { id: job!.id, leaseToken: job!.leaseToken },
        { classification: "SENT", rejectedRecipients: null },
        deps,
      );

      const rows = await db.pool.query(
        "SELECT breaker_key, consecutive_failures FROM mail_circuit_breaker ORDER BY breaker_key",
      );
      expect(rows.rows).toEqual([
        { breaker_key: "default", consecutive_failures: 2 },
        { breaker_key: "marketing", consecutive_failures: 0 },
      ]);
    });

    it("시도 기록은 작업 행의 account_id를 복사해 쓴다", async () => {
      await ensureBreakerRows(db.pool, ["marketing"]);
      await createJob(db.pool, { accountId: "marketing" });
      const [job] = await claim(db.pool, {
        ...claimOpts,
        accountId: "marketing",
      });
      await completeAttempt(
        db.pool,
        { id: job!.id, leaseToken: job!.leaseToken },
        { classification: "SENT", rejectedRecipients: null },
        deps,
      );

      const { rows } = await db.pool.query(
        "SELECT account_id, caller_id FROM mail_attempts WHERE job_id = $1",
        [job!.id],
      );
      expect(rows).toEqual([
        { account_id: "marketing", caller_id: "caller-a" },
      ]);
    });

    it("lease 만료로 회수한 시도 기록도 작업의 account_id를 싣는다", async () => {
      await ensureBreakerRows(db.pool, ["marketing"]);
      await createJob(db.pool, { accountId: "marketing" });
      const [job] = await claim(db.pool, {
        ...claimOpts,
        accountId: "marketing",
      });
      await db.pool.query(
        "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
        [job!.id],
      );
      await pastDue(db.pool, job!.id);

      await claim(db.pool, { ...claimOpts, accountId: "default" });

      const { rows } = await db.pool.query(
        "SELECT account_id, classification FROM mail_attempts WHERE job_id = $1",
        [job!.id],
      );
      expect(rows).toEqual([
        { account_id: "marketing", classification: "LEASE_EXPIRED" },
      ]);
    });
  });
});
