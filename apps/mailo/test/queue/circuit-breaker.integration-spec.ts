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

describe("PostgreSQL 통합: 전역 차단기(ADR-0007 결정 4·5, RQ-009)", () => {
  let db: TestDatabase;
  const deps = completeDeps();
  const claimOpts = { leaseSeconds: 120, limit: 1, deps };

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query(
      `UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL,
         probe_job_id = NULL, consecutive_failures = 0, wait_seconds = 0, last_reason = NULL,
         last_trip_job_id = NULL, last_trip_token = NULL`,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  const breaker = () => getBreakerState(db.pool, deps.breaker);

  async function claimOne(): Promise<ClaimedJob | undefined> {
    return (await claim(db.pool, claimOpts))[0];
  }

  async function failAccount(
    job: ClaimedJob,
    reason: AccountErrorReason,
    extra: { afterMailFrom?: boolean; response?: [number, string] } = {},
  ) {
    return completeAttempt(
      db.pool,
      { id: job.id, leaseToken: job.leaseToken },
      {
        classification: "ACCOUNT",
        reason,
        afterMailFrom: extra.afterMailFrom ?? false,
        responseCode: extra.response?.[0],
        enhancedCode: extra.response?.[1],
      },
      deps,
    );
  }

  /** open 대기가 끝난 상태를 만든다. */
  async function elapseOpenWait(): Promise<void> {
    await db.pool.query(
      "UPDATE mail_circuit_breaker SET open_until = now() - interval '1 second' WHERE state = 'open'",
    );
  }

  it("연속 계정 상태 오류 3회에서 open이 되고 그동안 작업을 점유하지 않는다", async () => {
    for (let i = 0; i < 3; i += 1) await createJob(db.pool);

    for (let i = 1; i <= 3; i += 1) {
      const job = await claimOne();
      await failAccount(job!, "CONNECTION");
      expect((await breaker()).state).toBe(i < 3 ? "closed" : "open");
    }
    await createJob(db.pool);

    const state = await breaker();
    expect(state.consecutiveFailures).toBe(3);
    expect(state.waitSeconds).toBe(60);
    expect(await claim(db.pool, claimOpts)).toEqual([]);
    const { rows } = await db.pool.query(
      "SELECT attempts FROM mail_jobs WHERE attempts > 0",
    );
    expect(rows).toEqual([]);
  });

  it("성공이나 메시지 오류가 끝나면 닫힌 상태의 연속 실패 수가 0이 된다", async () => {
    await createJob(db.pool);
    await createJob(db.pool);
    await failAccount((await claimOne())!, "CONNECTION");
    expect((await breaker()).consecutiveFailures).toBe(1);

    const job = (await claimOne())!;
    await completeAttempt(
      db.pool,
      { id: job.id, leaseToken: job.leaseToken },
      { classification: "PERMANENT", responseCode: 550, enhancedCode: "5.1.1" },
      deps,
    );

    expect((await breaker()).consecutiveFailures).toBe(0);
    expect((await breaker()).state).toBe("closed");
  });

  it("일일 한도는 즉시 open이고 대기 1시간이 대표 작업이 실패해도 늘지 않는다", async () => {
    await createJob(db.pool);
    await failAccount((await claimOne())!, "DAILY_LIMIT");
    const opened = await breaker();
    expect(opened.state).toBe("open");
    expect(opened.waitSeconds).toBe(3600);

    for (let round = 0; round < 2; round += 1) {
      await elapseOpenWait();
      await db.pool.query(
        "UPDATE mail_jobs SET next_attempt_at = now() - interval '1 second'",
      );
      const probe = (await claimOne())!;
      expect(probe.isProbe).toBe(true);
      await failAccount(probe, "DAILY_LIMIT");
    }

    const state = await breaker();
    expect(state.state).toBe("open");
    expect(state.waitSeconds).toBe(3600);
  });

  it("순간 한도는 5분에서 시작해 대표 작업이 실패할 때마다 2배가 되고 30분에서 멈춘다", async () => {
    await createJob(db.pool);
    await failAccount((await claimOne())!, "RATE_LIMIT");
    const waits = [(await breaker()).waitSeconds];

    for (let round = 0; round < 4; round += 1) {
      await elapseOpenWait();
      await db.pool.query(
        "UPDATE mail_jobs SET next_attempt_at = now() - interval '1 second'",
      );
      await failAccount((await claimOne())!, "RATE_LIMIT");
      waits.push((await breaker()).waitSeconds);
    }

    expect(waits).toEqual([300, 600, 1200, 1800, 1800]);
  });

  it("open_until이 지나면 대표 1건만 점유하고 동시 claim 경쟁에서 진 인스턴스는 점유를 되돌린다", async () => {
    const tripping = await createJob(db.pool);
    const others = [
      await createJob(db.pool),
      await createJob(db.pool),
      await createJob(db.pool),
      await createJob(db.pool),
    ];
    await failAccount((await claimOne())!, "RATE_LIMIT");
    expect((await breaker()).state).toBe("open");
    expect(await claim(db.pool, claimOpts)).toEqual([]);
    await elapseOpenWait();

    const batches = await Promise.all(
      Array.from({ length: 6 }, () =>
        claim(db.pool, { ...claimOpts, limit: 5 }),
      ),
    );

    const probes = batches.flat();
    expect(probes).toHaveLength(1);
    // 직전에 차단기를 연 작업은 뒤로 미루고 다른 작업을 대표로 고른다
    expect(others).toContain(probes[0]!.id);
    expect(probes[0]!.id).not.toBe(tripping);
    expect(probes[0]!.isProbe).toBe(true);
    const state = await breaker();
    expect(state.state).toBe("half_open");
    expect(state.probeJobId).toBe(probes[0]!.id);
    // probe_until은 작업 lease와 같은 값이다
    expect(state.probeUntil!.getTime()).toBe(probes[0]!.leaseUntil.getTime());
    // 경쟁에서 진 트랜잭션의 점유는 롤백돼 SENDING은 대표 하나뿐이다
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM mail_jobs WHERE status = 'SENDING'",
    );
    expect(rows[0].n).toBe(1);
  });

  it("대표 작업을 점유한 인스턴스가 죽으면 probe_until 뒤에 다른 인스턴스가 half_open을 이어받는다", async () => {
    const tripping = await createJob(db.pool);
    const dead = await createJob(db.pool);
    await failAccount((await claimOne())!, "RATE_LIMIT");
    await elapseOpenWait();
    const deadProbe = (await claimOne())!;
    expect(deadProbe.id).toBe(dead);
    const successor = await createJob(db.pool);
    await db.pool.query(
      "UPDATE mail_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
      [tripping],
    );
    // 아직 probe_until 전이면 인계하지 않는다
    expect(await claim(db.pool, claimOpts)).toEqual([]);

    await db.pool.query(
      "UPDATE mail_circuit_breaker SET probe_until = now() - interval '1 second'",
    );
    await db.pool.query(
      "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
      [dead],
    );
    const next = (await claimOne())!;

    expect(next.id).toBe(successor);
    expect(next.isProbe).toBe(true);
    expect((await breaker()).probeJobId).toBe(successor);
    // 죽은 인스턴스의 늦은 결과는 lease_token이 없어 거부된다
    const late = await completeAttempt(
      db.pool,
      { id: dead, leaseToken: deadProbe.leaseToken },
      { classification: "SENT" },
      deps,
    );
    expect(late.applied).toBe(false);
    expect((await breaker()).state).toBe("half_open");
  });

  it("대표 작업이 메시지 오류로 끝나도 계정은 정상이라 closed로 돌아간다", async () => {
    await createJob(db.pool);
    await createJob(db.pool);
    await failAccount((await claimOne())!, "RATE_LIMIT");
    await elapseOpenWait();
    const probe = (await claimOne())!;

    await completeAttempt(
      db.pool,
      { id: probe.id, leaseToken: probe.leaseToken },
      { classification: "TRANSIENT", responseCode: 451 },
      deps,
    );

    const state = await breaker();
    expect(state.state).toBe("closed");
    expect(state.consecutiveFailures).toBe(0);
    expect(state.openUntil).toBeNull();
    expect(state.probeJobId).toBeNull();
  });

  it.each(["TRANSIENT", "PERMANENT"] as const)(
    "대표 작업이 내부 오류(%s, internal)로 끝나면 차단기를 건드리지 않는다: half_open과 대표 작업이 그대로다",
    async (classification) => {
      await createJob(db.pool);
      await createJob(db.pool);
      await failAccount((await claimOne())!, "RATE_LIMIT");
      await elapseOpenWait();
      const probe = (await claimOne())!;
      const before = await breaker();

      const result = await completeAttempt(
        db.pool,
        { id: probe.id, leaseToken: probe.leaseToken },
        { classification, internal: true, stage: "WORKER" },
        deps,
      );

      expect(result.applied).toBe(true);
      const after = await breaker();
      expect(after.state).toBe("half_open");
      expect(after.probeJobId).toBe(probe.id);
      expect(after.consecutiveFailures).toBe(before.consecutiveFailures);
    },
  );

  it("같은 작업이 차단기를 3회 연 뒤에도 같은 응답을 받으면 FAILED가 되고 시도 횟수에는 넣지 않는다", async () => {
    const id = await createJob(db.pool);
    const response: [number, string] = [550, "5.7.1"];

    for (let trip = 1; trip <= 3; trip += 1) {
      const job = (await claimOne())!;
      const result = await failAccount(job, "RATE_LIMIT", {
        afterMailFrom: true,
        response,
      });
      expect(result).toMatchObject({ applied: true, status: "RETRY_WAIT" });
      const { rows } = await db.pool.query(
        "SELECT account_trips FROM mail_jobs WHERE id = $1",
        [id],
      );
      expect(rows[0].account_trips).toBe(trip);
      await elapseOpenWait();
      await pastDue(db.pool, id);
    }
    const last = await failAccount((await claimOne())!, "RATE_LIMIT", {
      afterMailFrom: true,
      response,
    });

    expect(last).toMatchObject({ applied: true, status: "FAILED" });
    const job = await db.pool.query(
      "SELECT status, attempts, failure_reason FROM mail_jobs WHERE id = $1",
      [id],
    );
    expect(job.rows[0]).toEqual({
      status: "FAILED",
      attempts: 0,
      failure_reason: "ACCOUNT_REPEATED",
    });
    const attempts = await db.pool.query(
      "SELECT count(*)::int AS n FROM mail_attempts WHERE job_id = $1 AND classification = 'ACCOUNT' AND NOT counted",
      [id],
    );
    expect(attempts.rows[0].n).toBe(4);
    const events = await db.pool.query(
      "SELECT type, failure_reason FROM mail_events WHERE job_id = $1",
      [id],
    );
    expect(events.rows).toEqual([
      { type: "JOB_FAILED", failure_reason: "ACCOUNT_REPEATED" },
    ]);
  });

  it("다른 응답이 오면 account_trips 예외를 적용하지 않고 계속 대기한다", async () => {
    const id = await createJob(db.pool);
    for (let i = 0; i < 4; i += 1) {
      const job = (await claimOne())!;
      const result = await failAccount(job, "RATE_LIMIT", {
        afterMailFrom: true,
        response: [550, `5.7.${i}`],
      });
      expect(result).toMatchObject({ applied: true, status: "RETRY_WAIT" });
      await elapseOpenWait();
      await pastDue(db.pool, id);
    }
  });

  it("재개 시각이 만료 시각보다 뒤이면 즉시 EXPIRED가 된다(ADR-0003 결정 6)", async () => {
    const id = await createJob(db.pool, { expiresInSeconds: 30 });

    const result = await failAccount((await claimOne())!, "DAILY_LIMIT");

    expect(result).toMatchObject({ applied: true, status: "EXPIRED" });
    const { rows } = await db.pool.query(
      "SELECT type FROM mail_events WHERE job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ type: "JOB_EXPIRED" }]);
  });
});
