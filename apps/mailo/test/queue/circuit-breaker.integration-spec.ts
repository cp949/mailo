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
    // 차단기를 열기 전의 실패 2건은 작업별 오류로 시도 횟수에 들고, 차단기를 연 3번째 실패는 들지 않는다
    // (ADR-0007 구현 중 확정 8).
    const { rows } = await db.pool.query(
      "SELECT attempts FROM mail_jobs ORDER BY attempts",
    );
    expect(rows.map((r) => r.attempts)).toEqual([0, 0, 1, 1]);
  });

  it("서로 다른 작업 8건의 계정 오류 결과가 동시에 들어와도 연속 실패는 임계값 3에서 멈추고 open 전이는 한 번이다(RQ-009, 여러 인스턴스 공유)", async () => {
    for (let i = 0; i < 8; i += 1) await createJob(db.pool);
    const jobs = await claim(db.pool, { ...claimOpts, limit: 8 });
    expect(jobs).toHaveLength(8);

    // 서로 다른 연결(풀)에서 동시에 완료한다. 인스턴스 여러 개가 같은 DB를 공유하는 상황이다.
    const results = await Promise.all(
      jobs.map((job) => failAccount(job, "CONNECTION")),
    );

    const state = await breaker();
    expect(state.state).toBe("open");
    expect(state.consecutiveFailures).toBe(3);
    expect(state.waitSeconds).toBe(60);
    expect(results.every((r) => r.applied)).toBe(true);
    // 연속 실패가 3에서 멈추고 열기 전의 실패 2건만 시도 횟수에 든다. 차단기를 연 건과 open 중 늦게 도착한 건은 들지 않는다
    // (open 전이가 두 번이었다면 연속 실패 수와 시도 횟수 합이 달라진다).
    const attempts = await db.pool.query<{ total: number }>(
      "SELECT COALESCE(sum(attempts), 0)::int AS total FROM mail_jobs",
    );
    expect(attempts.rows[0]!.total).toBe(2);
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

  it("같은 작업이 차단기를 3회 연 뒤에도 같은 응답을 받으면 FAILED가 된다(한도 외 사유, 차단기를 연 시도는 횟수에 넣지 않는다)", async () => {
    const id = await createJob(db.pool);
    const response: [number, string] = [550, "5.7.1"];

    // 연속 실패 1·2회는 차단기를 열지 못하므로 작업별 오류로 시도 횟수에 든다(ADR-0007 구현 중 확정 8).
    for (let closed = 1; closed <= 2; closed += 1) {
      const job = (await claimOne())!;
      const result = await failAccount(job, "OTHER", {
        afterMailFrom: true,
        response,
      });
      expect(result).toMatchObject({ applied: true, status: "RETRY_WAIT" });
      await pastDue(db.pool, id);
    }
    // 3번째가 차단기를 연다(account_trips 1). 이후 대표 작업 실패마다 차단기를 다시 연다.
    for (let trip = 1; trip <= 3; trip += 1) {
      const job = (await claimOne())!;
      const result = await failAccount(job, "OTHER", {
        afterMailFrom: true,
        response,
      });
      expect(result).toMatchObject({ applied: true, status: "RETRY_WAIT" });
      const { rows } = await db.pool.query(
        "SELECT account_trips, attempts FROM mail_jobs WHERE id = $1",
        [id],
      );
      expect(rows[0]).toEqual({ account_trips: trip, attempts: 2 });
      await elapseOpenWait();
      await pastDue(db.pool, id);
    }
    const last = await failAccount((await claimOne())!, "OTHER", {
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
      attempts: 2,
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

  /** 차단기를 3회 연 작업이 같은 응답(550 5.7.1)을 또 받을 상태를 만든다. 작업은 점유된 SENDING이다. */
  async function repeatedState(): Promise<ClaimedJob> {
    await createJob(db.pool);
    const job = (await claimOne())!;
    await db.pool.query(
      "UPDATE mail_jobs SET account_trips = 3, last_account_response = '550 5.7.1', attempts = 1 WHERE id = $1",
      [job.id],
    );
    return job;
  }

  it("반복 판정이 대표 작업의 실패에서 나면 차단기를 다시 열지 않고 closed로 닫는다(대기는 2배가 되지 않는다)", async () => {
    const job = await repeatedState();
    await db.pool.query(
      `UPDATE mail_circuit_breaker SET state = 'half_open', probe_job_id = $1,
         probe_until = now() + interval '1 minute', wait_seconds = 60, last_reason = 'OTHER',
         consecutive_failures = 3`,
      [job.id],
    );

    const result = await failAccount(job, "OTHER", {
      afterMailFrom: true,
      response: [550, "5.7.1"],
    });

    expect(result).toMatchObject({ applied: true, status: "FAILED" });
    const state = await breaker();
    expect(state.state).toBe("closed");
    expect(state.waitSeconds).toBe(0);
    expect(state.probeJobId).toBeNull();
    expect(state.openUntil).toBeNull();
    const { rows } = await db.pool.query(
      "SELECT status, attempts, failure_reason FROM mail_jobs WHERE id = $1",
      [job.id],
    );
    // 차단기가 half_open일 때의 시도는 횟수에 넣지 않는다(ADR-0007 결정 2).
    expect(rows[0]).toEqual({
      status: "FAILED",
      attempts: 1,
      failure_reason: "ACCOUNT_REPEATED",
    });
  });

  it("차단기가 closed일 때 반복 판정이 나면 차단기 연속 실패 수를 늘리지 않고 시도 횟수에 넣어 FAILED로 끝난다", async () => {
    const job = await repeatedState();
    await db.pool.query(
      "UPDATE mail_circuit_breaker SET consecutive_failures = 1",
    );

    const result = await failAccount(job, "OTHER", {
      afterMailFrom: true,
      response: [550, "5.7.1"],
    });

    expect(result).toMatchObject({ applied: true, status: "FAILED" });
    const state = await breaker();
    expect(state.state).toBe("closed");
    expect(state.consecutiveFailures).toBe(1);
    const { rows } = await db.pool.query(
      "SELECT status, attempts, failure_reason FROM mail_jobs WHERE id = $1",
      [job.id],
    );
    expect(rows[0]).toEqual({
      status: "FAILED",
      attempts: 2,
      failure_reason: "ACCOUNT_REPEATED",
    });
    const attempt = await db.pool.query(
      "SELECT counted FROM mail_attempts WHERE job_id = $1",
      [job.id],
    );
    expect(attempt.rows).toEqual([{ counted: true }]);
  });

  it("차단기가 open일 때 늦게 도착한 반복 판정 결과도 차단기를 건드리지 않고 FAILED가 된다", async () => {
    const job = await repeatedState();
    await db.pool.query(
      `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() + interval '10 minutes',
         wait_seconds = 60, last_reason = 'AUTH'`,
    );

    const result = await failAccount(job, "OTHER", {
      afterMailFrom: true,
      response: [550, "5.7.1"],
    });

    expect(result).toMatchObject({ applied: true, status: "FAILED" });
    const state = await breaker();
    expect(state.state).toBe("open");
    expect(state.waitSeconds).toBe(60);
  });

  it("다른 응답이 오면 account_trips 예외를 적용하지 않고 계속 대기한다", async () => {
    const id = await createJob(db.pool);
    for (let i = 0; i < 6; i += 1) {
      const job = (await claimOne())!;
      const result = await failAccount(job, "OTHER", {
        afterMailFrom: true,
        response: [550, `5.7.${i}`],
      });
      expect(result).toMatchObject({ applied: true, status: "RETRY_WAIT" });
      await elapseOpenWait();
      await pastDue(db.pool, id);
    }
  });

  it.each(["DAILY_LIMIT", "RATE_LIMIT"] as const)(
    "한도 사유(%s)는 account_trips가 3회를 넘어도 FAILED가 되지 않고 RETRY_WAIT를 유지한다 (ADR-0007 구현 중 확정 8, RQ-009)",
    async (reason) => {
      const id = await createJob(db.pool);
      const response: [number, string] = [550, "5.4.5"];

      for (let round = 1; round <= 6; round += 1) {
        const result = await failAccount((await claimOne())!, reason, {
          afterMailFrom: true,
          response,
        });
        expect(result).toMatchObject({ applied: true, status: "RETRY_WAIT" });
        await elapseOpenWait();
        await pastDue(db.pool, id);
      }

      const { rows } = await db.pool.query(
        "SELECT status, attempts, account_trips, failure_reason FROM mail_jobs WHERE id = $1",
        [id],
      );
      expect(rows[0]).toEqual({
        status: "RETRY_WAIT",
        attempts: 0,
        account_trips: 0,
        failure_reason: null,
      });
      const events = await db.pool.query(
        "SELECT type FROM mail_events WHERE job_id = $1",
        [id],
      );
      expect(events.rows).toEqual([]);
    },
  );

  it("한도 사유 작업은 만료 시각까지 RETRY_WAIT이고 만료 시각을 넘기면 EXPIRED가 된다", async () => {
    const id = await createJob(db.pool, { expiresInSeconds: 7_200 });
    const first = await failAccount((await claimOne())!, "DAILY_LIMIT", {
      afterMailFrom: true,
      response: [550, "5.4.5"],
    });
    expect(first).toMatchObject({ applied: true, status: "RETRY_WAIT" });

    // 재시도 시각(1시간 뒤)이 남은 만료 시각을 넘도록 만료를 당긴다.
    await elapseOpenWait();
    await db.pool.query(
      "UPDATE mail_jobs SET next_attempt_at = now() - interval '1 second', expires_at = now() + interval '30 minutes' WHERE id = $1",
      [id],
    );
    const second = await failAccount((await claimOne())!, "DAILY_LIMIT", {
      afterMailFrom: true,
      response: [550, "5.4.5"],
    });

    expect(second).toMatchObject({ applied: true, status: "EXPIRED" });
  });

  it("차단기 closed에서 OTHER 거부는 attempts가 증가하고 최대 시도에서 FAILED (ADR-0007 구현 중 확정 8, RQ-009)", async () => {
    const id = await createJob(db.pool);
    const response: [number, string] = [550, "5.7.1"];

    for (let attempt = 1; attempt < deps.retry.maxAttempts; attempt += 1) {
      // 다른 작업의 성공이 연속 실패 수를 0으로 되돌린 상황을 흉내 낸다. 차단기는 계속 closed다.
      await db.pool.query(
        "UPDATE mail_circuit_breaker SET consecutive_failures = 0",
      );
      const result = await failAccount((await claimOne())!, "OTHER", {
        afterMailFrom: true,
        response,
      });
      expect(result).toMatchObject({ applied: true, status: "RETRY_WAIT" });
      expect((await breaker()).state).toBe("closed");
      const { rows } = await db.pool.query(
        `SELECT attempts, account_trips,
                round(EXTRACT(EPOCH FROM (next_attempt_at - now()))) AS wait
           FROM mail_jobs WHERE id = $1`,
        [id],
      );
      expect(rows[0].attempts).toBe(attempt);
      expect(rows[0].account_trips).toBe(0);
      // 일반 backoff(기준 60초, 2배, 상한 3600초, 지터 0)다. 차단기 초기 대기(60초 고정)가 아니다.
      const expected = Math.min(3600, 60 * 2 ** (attempt - 1));
      expect(Math.abs(Number(rows[0].wait) - expected)).toBeLessThanOrEqual(2);
      await pastDue(db.pool, id);
    }
    await db.pool.query(
      "UPDATE mail_circuit_breaker SET consecutive_failures = 0",
    );
    const last = await failAccount((await claimOne())!, "OTHER", {
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
      attempts: deps.retry.maxAttempts,
      failure_reason: "ATTEMPTS_EXHAUSTED",
    });
    const counted = await db.pool.query(
      "SELECT count(*)::int AS n FROM mail_attempts WHERE job_id = $1 AND classification = 'ACCOUNT' AND counted",
      [id],
    );
    expect(counted.rows[0].n).toBe(deps.retry.maxAttempts);
    const events = await db.pool.query(
      "SELECT type, failure_reason, attempt_count FROM mail_events WHERE job_id = $1",
      [id],
    );
    expect(events.rows).toEqual([
      {
        type: "JOB_FAILED",
        failure_reason: "ATTEMPTS_EXHAUSTED",
        attempt_count: deps.retry.maxAttempts,
      },
    ]);
  });

  it("차단기 open에서 OTHER 거부는 attempts가 증가하지 않음 (ADR-0007 결정 2)", async () => {
    const late = await createJob(db.pool);
    const tripping = await createJob(db.pool);
    // 두 작업을 모두 점유한 뒤 한쪽이 차단기를 연다. 다른 쪽의 결과는 open 중에 도착한다.
    const claimed = await claim(db.pool, { ...claimOpts, limit: 2 });
    const lateJob = claimed.find((j) => j.id === late)!;
    await failAccount(
      claimed.find((j) => j.id === tripping)!,
      "RATE_LIMIT",
    );
    expect((await breaker()).state).toBe("open");

    const result = await failAccount(lateJob, "OTHER", { afterMailFrom: true });

    expect(result).toMatchObject({ applied: true, status: "RETRY_WAIT" });
    const { rows } = await db.pool.query(
      "SELECT attempts FROM mail_jobs WHERE id = $1",
      [late],
    );
    expect(rows[0].attempts).toBe(0);
    const counted = await db.pool.query(
      "SELECT counted FROM mail_attempts WHERE job_id = $1",
      [late],
    );
    expect(counted.rows).toEqual([{ counted: false }]);
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
