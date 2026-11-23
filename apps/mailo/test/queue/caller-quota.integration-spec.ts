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
  sweepExpired,
  type ClaimedJob,
  type QuotaBlock,
} from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  completeDeps,
  createJob,
  migrate,
  pastDue,
} from "../support/queue-fixtures.js";

/**
 * 호출처별 24시간 rolling 발송 할당(RQ-032, ADR-0007 결정 10). 실제 PostgreSQL을 쓴다.
 * 사용량 = 최근 24시간의 "할당에 드는 시도"(counted, 내부 오류 제외) + 현재 SENDING 작업 수다.
 */
describe("PostgreSQL 통합: 호출처별 발송 할당(RQ-032)", () => {
  let db: TestDatabase;
  const deps = completeDeps();
  const base = { leaseSeconds: 120, limit: 1, deps };

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

  const quotas = (entries: Record<string, number>) =>
    new Map(Object.entries(entries));

  const claimWith = (
    q: Record<string, number>,
    over: Partial<Parameters<typeof claim>[1]> = {},
  ) => claim(db.pool, { ...base, callerQuotas: quotas(q), ...over });

  /** 작업을 점유해 SENT로 끝낸다. 시도 기록 한 건이 남는다. */
  async function sendOne(q: Record<string, number>, callerId?: string) {
    const [job] = await claimWith(q);
    if (!job) throw new Error("점유할 작업이 없다");
    if (callerId) expect(job.callerId).toBe(callerId);
    await completeAttempt(
      db.pool,
      { id: job.id, leaseToken: job.leaseToken },
      { classification: "SENT" },
      deps,
    );
    return job;
  }

  async function jobRow(id: string) {
    const { rows } = await db.pool.query(
      `SELECT status, attempts, next_attempt_at, lease_token FROM mail_jobs WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function attemptCount(callerId: string): Promise<number> {
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM mail_attempts WHERE caller_id = $1",
      [callerId],
    );
    return rows[0].n;
  }

  /** 시도 기록을 과거로 당겨 24시간 윈도우가 지난 것처럼 만든다(DB 시계 기준). */
  async function ageAttempts(callerId: string, hours: number, n?: number) {
    await db.pool.query(
      `UPDATE mail_attempts SET finished_at = now() - make_interval(hours => $2)
        WHERE id IN (SELECT id FROM mail_attempts WHERE caller_id = $1 ORDER BY id LIMIT $3)`,
      [callerId, hours, n ?? 1_000_000],
    );
  }

  it("할당 안에서는 정상 점유하고 한 번의 호출이 남은 건수까지만 점유한다", async () => {
    for (let i = 0; i < 5; i += 1) await createJob(db.pool);

    const first = await claimWith({ "caller-a": 3 }, { limit: 2 });
    expect(first).toHaveLength(2);
    // 남은 할당은 1건이다. 요청은 5건이어도 1건만 점유한다.
    const second = await claimWith({ "caller-a": 3 }, { limit: 5 });
    expect(second).toHaveLength(1);
    expect(await claimWith({ "caller-a": 3 }, { limit: 5 })).toEqual([]);
  });

  it("점유 중인 작업도 사용량에 든다", async () => {
    for (let i = 0; i < 3; i += 1) await createJob(db.pool);
    expect(await claimWith({ "caller-a": 2 })).toHaveLength(1);
    expect(await claimWith({ "caller-a": 2 })).toHaveLength(1);
    // 둘 다 SENDING이고 시도 기록은 아직 없다.
    expect(await claimWith({ "caller-a": 2 })).toEqual([]);
  });

  it("할당을 넘으면 점유에서 빠지고 시도 횟수·상태·재시도 시각이 변하지 않는다", async () => {
    await createJob(db.pool, { callerId: "caller-a" });
    await createJob(db.pool, { callerId: "caller-a" });
    const waiting = await createJob(db.pool, { callerId: "caller-a" });
    await sendOne({ "caller-a": 2 });
    await sendOne({ "caller-a": 2 });
    const before = await jobRow(waiting);

    const blocked: QuotaBlock[][] = [];
    for (let i = 0; i < 3; i += 1) {
      expect(
        await claimWith(
          { "caller-a": 2 },
          { onQuotaBlocked: (b) => blocked.push([...b]) },
        ),
      ).toEqual([]);
    }

    expect(await jobRow(waiting)).toEqual(before);
    expect(before.status).toBe("PENDING");
    expect(before.attempts).toBe(0);
    expect(await attemptCount("caller-a")).toBe(2);
    expect(blocked.at(-1)).toEqual([{ callerId: "caller-a", limit: 2 }]);
  });

  it("롤링 윈도우가 지나면 다시 점유한다", async () => {
    for (let i = 0; i < 4; i += 1) await createJob(db.pool);
    await sendOne({ "caller-a": 2 });
    await sendOne({ "caller-a": 2 });
    expect(await claimWith({ "caller-a": 2 })).toEqual([]);

    // 23시간 전 시도는 아직 윈도우 안이다.
    await ageAttempts("caller-a", 23);
    expect(await claimWith({ "caller-a": 2 })).toEqual([]);

    // 시도 하나만 24시간을 넘기면 한 건만 열린다(rolling).
    await ageAttempts("caller-a", 25, 1);
    expect(await claimWith({ "caller-a": 2 }, { limit: 5 })).toHaveLength(1);
    expect(await claimWith({ "caller-a": 2 }, { limit: 5 })).toEqual([]);

    // 나머지도 지나면 새 윈도우가 열린다. 방금 점유한 SENDING 1건이 사용량에 들어 있다.
    await ageAttempts("caller-a", 25);
    expect(await claimWith({ "caller-a": 2 }, { limit: 5 })).toHaveLength(1);
  });

  it("한 호출처의 초과가 다른 호출처 점유를 막지 않는다(공정성)", async () => {
    // caller-a의 대기열이 caller-b·caller-c보다 앞선다(오래된 next_attempt_at).
    const aIds: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const id = await createJob(db.pool, { callerId: "caller-a" });
      await pastDue(db.pool, id);
      aIds.push(id);
    }
    const b = await createJob(db.pool, { callerId: "caller-b" });
    const c = await createJob(db.pool, { callerId: "caller-c" });
    const q = { "caller-a": 1, "caller-c": 5 };
    await sendOne(q, "caller-a");

    // caller-a는 초과, caller-b는 할당 없음(무제한), caller-c는 할당 안.
    const claimed = await claimWith(q, { limit: 10 });
    expect(claimed.map((j) => j.id).sort()).toEqual([b, c].sort());
    expect(claimed.every((j) => j.callerId !== "caller-a")).toBe(true);
    for (const id of aIds.slice(1)) {
      expect((await jobRow(id)).status).toBe("PENDING");
    }
  });

  it("할당이 서로 다른 호출처는 각자 한도까지 점유한다", async () => {
    for (let i = 0; i < 4; i += 1) {
      await createJob(db.pool, { callerId: "caller-a" });
      await createJob(db.pool, { callerId: "caller-b" });
    }
    const claimed = await claimWith(
      { "caller-a": 1, "caller-b": 3 },
      { limit: 20 },
    );
    const count = (id: string) =>
      claimed.filter((j) => j.callerId === id).length;
    expect(count("caller-a")).toBe(1);
    expect(count("caller-b")).toBe(3);
  });

  it("동시 점유에서도 할당을 넘기지 않는다(초과 허용 0건)", async () => {
    const limit = 5;
    for (let i = 0; i < 60; i += 1) await createJob(db.pool);
    for (let i = 0; i < 20; i += 1)
      await createJob(db.pool, { callerId: "caller-b" });

    // 인스턴스 12개가 같은 순간 점유한다. 호출처별 advisory lock을 못 잡은 호출은 그 호출처를 이번에만 건너뛴다.
    const rounds: ClaimedJob[] = [];
    for (let round = 0; round < 3; round += 1) {
      const batches = await Promise.all(
        Array.from({ length: 12 }, () =>
          claimWith({ "caller-a": limit }, { limit: 3 }),
        ),
      );
      rounds.push(...batches.flat());
      const a = rounds.filter((j) => j.callerId === "caller-a");
      expect(a.length).toBeLessThanOrEqual(limit);
    }

    // 호출이 끝난 뒤에는 정확히 한도까지 점유돼 있다. 락 경합으로 건너뛴 만큼이 남아도 순차 점유로 채워진다.
    for (let i = 0; i < 10; i += 1)
      rounds.push(...(await claimWith({ "caller-a": limit })));
    const a = rounds.filter((j) => j.callerId === "caller-a");
    expect(new Set(a.map((j) => j.id)).size).toBe(a.length);
    expect(a).toHaveLength(limit);
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM mail_jobs WHERE caller_id = 'caller-a' AND status = 'SENDING'",
    );
    expect(rows[0].n).toBe(limit);
  });

  it("할당이 없거나 호출처가 목록에 없으면 제한 없이 점유한다(무제한 기본값)", async () => {
    for (let i = 0; i < 30; i += 1) await createJob(db.pool);
    expect(await claim(db.pool, { ...base, limit: 10 })).toHaveLength(10);
    // 다른 호출처에만 할당이 있다.
    expect(await claimWith({ "caller-z": 1 }, { limit: 10 })).toHaveLength(10);
    // 빈 목록도 같다.
    expect(await claimWith({}, { limit: 10 })).toHaveLength(10);
    // 시도가 아무리 많아도 할당 없는 호출처는 막히지 않는다.
    for (let i = 0; i < 5; i += 1)
      await createJob(db.pool, { callerId: "caller-d" });
    const all = await claimWith({ "caller-z": 1 }, { limit: 50 });
    expect(all.filter((j) => j.callerId === "caller-d")).toHaveLength(5);
  });

  it("계정 상태 오류와 내부 오류는 사용량에 들지 않고 TRANSIENT는 든다", async () => {
    const q = { "caller-a": 2 };
    for (let i = 0; i < 4; i += 1) await createJob(db.pool);

    // ACCOUNT(counted=false): 사용량 0
    const [account] = await claimWith(q);
    await completeAttempt(
      db.pool,
      { id: account!.id, leaseToken: account!.leaseToken },
      {
        classification: "ACCOUNT",
        reason: "OTHER",
        afterMailFrom: false,
      },
      deps,
    );
    // 내부 오류(stage WORKER): 사용량 0
    await db.pool.query(
      "UPDATE mail_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
      [account!.id],
    );
    const internal = await claimWith(q, { limit: 4 });
    expect(internal.length).toBe(2); // 사용량 0이므로 한도 2건까지 점유한다.
    for (const job of internal) {
      await completeAttempt(
        db.pool,
        { id: job.id, leaseToken: job.leaseToken },
        {
          classification: "TRANSIENT",
          internal: true,
          stage: "WORKER",
        },
        deps,
      );
    }
    const { rows: counted } = await db.pool.query(
      "SELECT count(*)::int AS n FROM mail_attempts WHERE caller_id = 'caller-a' AND counted",
    );
    expect(counted[0].n).toBe(2);
    // 두 시도 모두 사용량에 들지 않으므로 한도가 그대로 남아 있다.
    await db.pool.query(
      "UPDATE mail_jobs SET next_attempt_at = now() - interval '1 second' WHERE status = 'RETRY_WAIT'",
    );
    expect(await claimWith(q, { limit: 4 })).toHaveLength(2);
  });

  it("SMTP 메시지 단계의 TRANSIENT 시도는 사용량에 든다", async () => {
    const q = { "caller-a": 1 };
    const id = await createJob(db.pool);
    await createJob(db.pool);
    const [job] = await claimWith(q);
    await completeAttempt(
      db.pool,
      { id: job!.id, leaseToken: job!.leaseToken },
      { classification: "TRANSIENT", stage: "DATA", responseCode: 451 },
      deps,
    );
    expect((await jobRow(id)).status).toBe("RETRY_WAIT");
    expect(await claimWith(q, { limit: 5 })).toEqual([]);
  });

  it("차단기 half_open 대표 작업도 할당을 넘긴 호출처의 작업은 고르지 않는다", async () => {
    const a = await createJob(db.pool, { callerId: "caller-a" });
    await pastDue(db.pool, a);
    await createJob(db.pool, { callerId: "caller-a" });
    await sendOne({ "caller-a": 1 });
    const b = await createJob(db.pool, { callerId: "caller-b" });
    await db.pool.query(
      `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() - interval '1 second',
         wait_seconds = 60`,
    );

    const probe = await claimWith({ "caller-a": 1 });
    expect(probe).toHaveLength(1);
    expect(probe[0]!.id).toBe(b);
    expect(probe[0]!.isProbe).toBe(true);
  });

  it("할당 초과로 대기 중인 작업이 expires_at에 이르면 sweep이 EXPIRED로 만든다", async () => {
    const q = { "caller-a": 1 };
    await createJob(db.pool, { callerId: "caller-a" });
    const waiting = await createJob(db.pool, { callerId: "caller-a" });
    await sendOne(q);
    expect(await claimWith(q)).toEqual([]);

    await db.pool.query(
      "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = $1",
      [waiting],
    );
    expect(await sweepExpired(db.pool)).toBe(1);

    const row = await jobRow(waiting);
    expect(row.status).toBe("EXPIRED");
    expect(row.attempts).toBe(0);
    const { rows } = await db.pool.query(
      "SELECT type FROM mail_events WHERE job_id = $1",
      [waiting],
    );
    expect(rows).toEqual([{ type: "JOB_EXPIRED" }]);
  });
});
