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
  recoverExpiredLeases,
  type ClaimOptions,
  type ClaimOrder,
  type Priority,
} from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  completeDeps,
  createJob,
  migrate,
  pastDue,
} from "../support/queue-fixtures.js";

/**
 * 점유 경로와 우선순위(실제 PostgreSQL). 근거: RQ-035·036, ADR-0009.
 * 경로 선택(난수)은 Worker가 한다. 여기서는 `claim`에 경로를 직접 넘겨 SQL 정렬만 고정한다.
 * 순위 숫자(LOW 10, NORMAL 20, HIGH 30, URGENT 40)를 리터럴로 쓴 곳은 대응표가 바뀌면 실패하게 하려는 의도다.
 */
describe("PostgreSQL 통합: 점유 경로와 우선순위 (RQ-035·036, ADR-0009)", () => {
  let db: TestDatabase;
  const deps = completeDeps();

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_attempts");
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

  /** 등급과 대기 시간(초)을 정해 작업을 만든다. `waited`가 음수면 미래 재시도다. */
  async function job(
    priority: Priority,
    waited: number,
    callerId = "caller-a",
  ): Promise<string> {
    const id = await createJob(db.pool, { priority, callerId });
    await db.pool.query(
      "UPDATE mail_jobs SET next_attempt_at = now() - make_interval(secs => $2) WHERE id = $1",
      [id, waited],
    );
    return id;
  }

  async function claimIds(
    order: ClaimOrder,
    over: Partial<ClaimOptions> = {},
  ): Promise<string[]> {
    const jobs = await claim(db.pool, {
      leaseSeconds: 120,
      limit: 1,
      deps,
      order,
      ...over,
    });
    return jobs.map((j) => j.id);
  }

  /** limit 1 점유를 n번 반복한 순서. */
  async function claimSequence(order: ClaimOrder, n: number) {
    const seq: string[] = [];
    for (let i = 0; i < n; i += 1) seq.push(...(await claimIds(order)));
    return seq;
  }

  async function rankOf(id: string): Promise<number> {
    const { rows } = await db.pool.query(
      "SELECT priority FROM mail_jobs WHERE id = $1",
      [id],
    );
    return rows[0].priority;
  }

  describe("우선순위 경로", () => {
    it("300초 이상 밀린 NORMAL 10,000건 뒤에 등록한 URGENT를 다음 점유에서 먼저 고른다(적체 길이와 무관)", async () => {
      // 1만 건은 등록 함수 대신 한 문장으로 넣는다. priority는 DEFAULT(NORMAL 20)로 들어간다.
      await db.pool.query(
        `INSERT INTO mail_jobs (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version,
                                recipients, expires_at, next_attempt_at)
         SELECT gen_random_uuid(), 'caller-a', 'bulk-' || g, '\\x00'::bytea, 1,
                '{"to":["to@example.invalid"]}'::jsonb, now() + interval '1 day',
                now() - make_interval(secs => 300 + g)
           FROM generate_series(1, 10000) AS g`,
      );
      const urgent = await createJob(db.pool, { priority: "URGENT" });

      expect(await claimIds("priority")).toEqual([urgent]);
      expect(await rankOf(urgent)).toBe(40);
      const { rows } = await db.pool.query(
        "SELECT count(*)::int AS n FROM mail_jobs WHERE status = 'PENDING' AND priority = 20",
      );
      expect(rows[0].n).toBe(10_000);
    });

    it("네 등급이 섞이면 URGENT → HIGH → NORMAL → LOW 순서이고 같은 등급은 오래 기다린 순서다", async () => {
      const low = await job("LOW", 900);
      const normalOld = await job("NORMAL", 800);
      const normalNew = await job("NORMAL", 100);
      const high = await job("HIGH", 50);
      const urgentOld = await job("URGENT", 20);
      const urgentNew = await job("URGENT", 10);

      expect(await claimSequence("priority", 7)).toEqual([
        urgentOld,
        urgentNew,
        high,
        normalOld,
        normalNew,
        low,
      ]);
    });

    it("같은 등급·같은 next_attempt_at이면 id 오름차순이다", async () => {
      const a = await job("HIGH", 30);
      const b = await job("HIGH", 30);
      await db.pool.query(
        "UPDATE mail_jobs SET next_attempt_at = now() - interval '30 seconds' WHERE id = ANY($1::uuid[])",
        [[a, b]],
      );
      const expected = [a, b].sort();

      expect(await claimSequence("priority", 2)).toEqual(expected);
    });

    it("경로를 생략하면 우선순위 경로다", async () => {
      await job("LOW", 600);
      const urgent = await job("URGENT", 1);
      const jobs = await claim(db.pool, { leaseSeconds: 120, limit: 1, deps });
      expect(jobs.map((j) => j.id)).toEqual([urgent]);
    });

    it("한 번에 여러 건을 점유하면 높은 등급부터 limit건이다", async () => {
      await job("LOW", 600);
      const normal = await job("NORMAL", 300);
      const high = await job("HIGH", 5);
      const urgent = await job("URGENT", 1);

      const ids = await claimIds("priority", { limit: 3 });
      expect(ids.sort()).toEqual([normal, high, urgent].sort());
    });

    it("미래 재시도·만료·할당 초과의 높은 등급 작업은 점유하지 않고 다른 처리 가능한 후보를 고른다(RQ-036)", async () => {
      await job("URGENT", -600); // 재시도 대기 중
      const expired = await job("HIGH", 10);
      await db.pool.query(
        "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = $1",
        [expired],
      );
      // caller-b는 할당 1건이고 이미 점유 중인 작업이 있어 초과다.
      const busy = await job("NORMAL", 30, "caller-b");
      await db.pool.query(
        `UPDATE mail_jobs SET status = 'SENDING', lease_token = gen_random_uuid(),
                leased_at = now(), lease_until = now() + interval '1 minute' WHERE id = $1`,
        [busy],
      );
      await job("URGENT", 20, "caller-b");
      const low = await job("LOW", 1);

      const ids = await claimIds("priority", {
        limit: 4,
        callerQuotas: new Map([["caller-b", 1]]),
      });
      expect(ids).toEqual([low]);
    });
  });

  describe("대기 순서 경로", () => {
    it("등급과 무관하게 next_attempt_at, id 순서로 고른다", async () => {
      const urgentOld = await job("URGENT", 900);
      const low = await job("LOW", 800);
      const normal = await job("NORMAL", 500);
      const high = await job("HIGH", 100);
      const urgentNew = await job("URGENT", 10);

      expect(await claimSequence("fifo", 6)).toEqual([
        urgentOld,
        low,
        normal,
        high,
        urgentNew,
      ]);
    });

    it("URGENT가 계속 들어오는 동안에도 가장 오래 기다린 LOW를 대기 순서 경로에서 점유한다", async () => {
      const low = await job("LOW", 3600);
      const claimed: string[] = [];
      // 우선순위 경로 두 번 뒤 대기 순서 경로 한 번(Worker의 난수 선택을 고정한 순서).
      for (const order of ["priority", "priority", "fifo"] as const) {
        await job("URGENT", 0);
        claimed.push(...(await claimIds(order)));
      }

      expect(claimed).toHaveLength(3);
      expect(claimed.slice(0, 2)).not.toContain(low);
      expect(claimed[2]).toBe(low);
    });
  });

  describe("호출처 할당 순번 (RQ-032·035)", () => {
    it("할당 잔여 1건에 NORMAL·URGENT 후보가 함께 있으면 우선순위 경로는 URGENT를 점유한다", async () => {
      await job("NORMAL", 600);
      const urgent = await job("URGENT", 1);
      const quotas = new Map([["caller-a", 1]]);

      expect(
        await claimIds("priority", { limit: 4, callerQuotas: quotas }),
      ).toEqual([urgent]);
    });

    it("같은 조건에서 대기 순서 경로는 가장 오래 기다린 NORMAL을 점유한다", async () => {
      const normal = await job("NORMAL", 600);
      await job("URGENT", 1);
      const quotas = new Map([["caller-a", 1]]);

      expect(
        await claimIds("fifo", { limit: 4, callerQuotas: quotas }),
      ).toEqual([normal]);
    });

    it("할당은 모든 등급의 합산이다. URGENT도 할당을 넘겨 점유하지 않는다(RQ-036)", async () => {
      const first = await job("URGENT", 10);
      await job("URGENT", 5);
      const quotas = new Map([["caller-a", 1]]);

      expect(
        await claimIds("priority", { limit: 4, callerQuotas: quotas }),
      ).toEqual([first]);
      expect(
        await claimIds("priority", { limit: 4, callerQuotas: quotas }),
      ).toEqual([]);
    });
  });

  describe("차단기 (ADR-0007 결정 5, RQ-036)", () => {
    async function openBreaker(lastTripJobId: string | null, due: boolean) {
      await db.pool.query(
        `UPDATE mail_circuit_breaker SET state = 'open', wait_seconds = 60, last_reason = 'AUTH',
           open_until = now() + make_interval(secs => $2), last_trip_job_id = $1`,
        [lastTripJobId, due ? -1 : 600],
      );
    }

    it("차단기 open에서는 URGENT도 점유하지 않는다", async () => {
      await job("URGENT", 10);
      await openBreaker(null, false);

      expect(await claimIds("priority", { limit: 4 })).toEqual([]);
      expect(await claimIds("fifo", { limit: 4 })).toEqual([]);
    });

    it("half_open 대표는 직전 차단 작업을 뒤로 미루고, 그 밖의 후보 중 우선순위 경로의 첫 작업 1건이다", async () => {
      const tripped = await job("URGENT", 1000);
      await job("NORMAL", 900);
      const high = await job("HIGH", 10);
      await job("LOW", 5);
      await openBreaker(tripped, true);

      const jobs = await claim(db.pool, {
        leaseSeconds: 120,
        limit: 4,
        deps,
        order: "priority",
      });
      expect(jobs.map((j) => [j.id, j.isProbe])).toEqual([[high, true]]);
    });

    it("half_open 대표를 대기 순서 경로로 고르면 직전 차단 작업 다음으로 가장 오래 기다린 작업이다", async () => {
      const tripped = await job("URGENT", 1000);
      const normal = await job("NORMAL", 900);
      await job("HIGH", 10);
      await openBreaker(tripped, true);

      const jobs = await claim(db.pool, {
        leaseSeconds: 120,
        limit: 4,
        deps,
        order: "fifo",
      });
      expect(jobs.map((j) => [j.id, j.isProbe])).toEqual([[normal, true]]);
    });

    it("직전 차단 작업만 남았으면 그 작업을 대표로 쓴다", async () => {
      const tripped = await job("LOW", 10);
      await openBreaker(tripped, true);

      expect(await claimIds("priority", { limit: 4 })).toEqual([tripped]);
    });
  });

  describe("동시 점유·재시도·lease 복구에서 등급 보존 (RQ-035·036)", () => {
    it("동시 claim 두 개가 겹치지 않고 함께 상위 등급 작업을 가져간다(SKIP LOCKED)", async () => {
      const urgent: string[] = [];
      for (let i = 0; i < 4; i += 1) urgent.push(await job("URGENT", 10 - i));
      for (let i = 0; i < 4; i += 1) await job("NORMAL", 600 + i);

      const [a, b] = await Promise.all([
        claimIds("priority", { limit: 2 }),
        claimIds("priority", { limit: 2 }),
      ]);
      const all = [...a!, ...b!];
      expect(new Set(all).size).toBe(4);
      expect(all.sort()).toEqual([...urgent].sort());
    });

    it("재시도 대기 뒤에도 등록한 등급을 유지하고 다시 우선순위대로 점유된다", async () => {
      const urgent = await job("URGENT", 1);
      await job("NORMAL", 600);
      const [claimed] = await claim(db.pool, {
        leaseSeconds: 120,
        limit: 1,
        deps,
        order: "priority",
      });
      expect(claimed!.id).toBe(urgent);
      const done = await completeAttempt(
        db.pool,
        { id: claimed!.id, leaseToken: claimed!.leaseToken },
        { classification: "TRANSIENT", responseCode: 451 },
        deps,
      );
      expect(done).toMatchObject({ applied: true, status: "RETRY_WAIT" });
      expect(await rankOf(urgent)).toBe(40);

      await pastDue(db.pool, urgent);
      expect(await claimIds("priority")).toEqual([urgent]);
    });

    it("lease 만료 회수 뒤에도 등급을 유지한다", async () => {
      const high = await job("HIGH", 1);
      expect(await claimIds("priority")).toEqual([high]);
      await db.pool.query(
        "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
        [high],
      );
      await recoverExpiredLeases(db.pool, deps);

      const { rows } = await db.pool.query(
        "SELECT status, priority FROM mail_jobs WHERE id = $1",
        [high],
      );
      expect(rows[0]).toEqual({ status: "RETRY_WAIT", priority: 30 });
    });
  });

  describe("스키마 (RQ-038, migrations/0004·0005)", () => {
    it("priority 기본값은 20이고 정의되지 않은 순위는 CHECK가 거부한다", async () => {
      const id = await createJob(db.pool);
      expect(await rankOf(id)).toBe(20);
      await expect(
        db.pool.query("UPDATE mail_jobs SET priority = 25 WHERE id = $1", [id]),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("우선순위 점유 인덱스가 계정 단위 유효한 부분 인덱스로 있다(0005의 인덱스는 0012·0015가 계정 단위로 대체했다, ADR-0013 결정 4)", async () => {
      const { rows } = await db.pool.query(
        `SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'mail_jobs_account_priority_claim_idx'
            AND c.relnamespace = current_schema()::regnamespace`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].valid).toBe(true);
      expect(rows[0].def).toContain(
        "(account_id, priority DESC, next_attempt_at, id)",
      );
      expect(rows[0].def).toContain("WHERE (status = ANY");
    });
  });
});
