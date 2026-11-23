import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { getFeedLagsForCallers } from "../../src/events/index.js";
import { getAuditStats } from "../../src/ops/index.js";
import { writeAudit } from "../../src/ops/audit.js";
import {
  BACKLOG_COUNT_LIMIT,
  cancelJob,
  claim,
  completeAttempt,
  getCallerQuotaUsage,
  getQueueDepth,
  recoverExpiredLeases,
  sweepExpired,
  type JobTransition,
} from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  completeDeps,
  createJob,
  migrate,
  pastDue,
} from "../support/queue-fixtures.js";

/**
 * `/metrics`가 쓰는 읽기 함수와 종결 전이 관찰자(RQ-049, ADR-0012 결정 4·5·8).
 * 실제 PostgreSQL을 쓴다. 읽기 함수는 쓰지 않고 시각은 DB `now()`로만 계산한다(ADR-0002 결정 10).
 */
describe("PostgreSQL 통합: 지표용 읽기 함수(RQ-049, ADR-0012 결정 4·5)", () => {
  let db: TestDatabase;
  const deps = completeDeps();

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query("DELETE FROM mail_ops_audit");
    await db.pool.query(
      `UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL,
         probe_job_id = NULL, consecutive_failures = 0, wait_seconds = 0, last_reason = NULL,
         last_trip_job_id = NULL, last_trip_token = NULL`,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  /** 같은 상태·시각의 작업 n건을 SQL 한 문장으로 넣는다(10001건 시험용). */
  async function bulkJobs(n: number, status: string, nextAt: string) {
    await db.pool.query(
      `INSERT INTO mail_jobs (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version,
                              status, next_attempt_at, expires_at, recipients)
       SELECT gen_random_uuid(), 'bulk', 'bulk-' || $1::text || '-' || g, '\\x00', 1, $1,
              ${nextAt}, now() + interval '1 day', '{}'::jsonb
         FROM generate_series(1, $2) g`,
      [status, n],
    );
  }

  describe("getQueueDepth: due·scheduled·sending 건수", () => {
    it("상태별로 센다: 점유 가능은 due, 미래 재시도는 scheduled, 점유 중은 sending이다", async () => {
      await createJob(db.pool); // PENDING, due
      const retry = await createJob(db.pool);
      await db.pool.query(
        "UPDATE mail_jobs SET status = 'RETRY_WAIT', next_attempt_at = now() - interval '5 seconds' WHERE id = $1",
        [retry],
      ); // due
      const later = await createJob(db.pool);
      await db.pool.query(
        "UPDATE mail_jobs SET status = 'RETRY_WAIT', next_attempt_at = now() + interval '1 hour' WHERE id = $1",
        [later],
      ); // scheduled
      const sending = await createJob(db.pool);
      await pastDue(db.pool, sending);
      await claim(db.pool, { leaseSeconds: 120, limit: 100, deps });
      // claim이 due 둘(PENDING 하나, RETRY_WAIT 하나)과 sending 후보까지 점유했으므로 다시 정리한다.
      await db.pool.query(
        `UPDATE mail_jobs SET status = 'PENDING', lease_token = NULL, lease_until = NULL, leased_at = NULL
          WHERE status = 'SENDING' AND id <> $1`,
        [sending],
      );

      const depth = await getQueueDepth(db.pool, ["default"]);

      expect(depth.scheduled).toEqual({ count: 1, truncated: false });
      expect(depth.sending).toBe(1);
      // due는 점유 중이 아닌 PENDING·RETRY_WAIT 가운데 next_attempt_at이 지난 것이다.
      expect(depth.due.count).toBe(2);
      expect(depth.due.truncated).toBe(false);
    });

    it("종결 상태 작업은 어느 건수에도 넣지 않는다", async () => {
      const id = await createJob(db.pool);
      await db.pool.query(
        "UPDATE mail_jobs SET status = 'SENT', finished_at = now() WHERE id = $1",
        [id],
      );

      const depth = await getQueueDepth(db.pool, ["default"]);

      expect(depth.due.count).toBe(0);
      expect(depth.scheduled.count).toBe(0);
      expect(depth.sending).toBe(0);
    });

    it("due와 scheduled는 10000에서 멈추고 truncated가 true다", async () => {
      await bulkJobs(
        BACKLOG_COUNT_LIMIT + 1,
        "PENDING",
        "now() - interval '1 minute'",
      );
      await bulkJobs(
        BACKLOG_COUNT_LIMIT + 1,
        "RETRY_WAIT",
        "now() + interval '1 hour'",
      );

      const depth = await getQueueDepth(db.pool, ["default"]);

      expect(depth.due).toEqual({
        count: BACKLOG_COUNT_LIMIT,
        truncated: true,
      });
      expect(depth.scheduled).toEqual({
        count: BACKLOG_COUNT_LIMIT,
        truncated: true,
      });
    });

    it("정확히 10000건이면 truncated가 false다", async () => {
      await bulkJobs(
        BACKLOG_COUNT_LIMIT,
        "RETRY_WAIT",
        "now() + interval '1 hour'",
      );

      const depth = await getQueueDepth(db.pool, ["default"]);

      expect(depth.scheduled).toEqual({
        count: BACKLOG_COUNT_LIMIT,
        truncated: false,
      });
    });

    it("읽기 전용 트랜잭션에서도 돈다(쓰기·잠금이 없다)", async () => {
      await createJob(db.pool);
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        const depth = await getQueueDepth(client, ["default"]);
        await client.query("COMMIT");
        expect(depth.due.count).toBe(1);
      } finally {
        client.release();
      }
    });
  });

  describe("getCallerQuotaUsage: 호출처 할당 사용량", () => {
    it("최근 24시간 시도와 점유 중 작업을 합치고 한도에서 멈춘다", async () => {
      for (let i = 0; i < 3; i++) {
        await createJob(db.pool, { callerId: "alpha" });
      }
      const [first] = await claim(db.pool, {
        leaseSeconds: 120,
        limit: 1,
        deps,
      });
      await completeAttempt(
        db.pool,
        { id: first!.id, leaseToken: first!.leaseToken },
        { classification: "SENT" },
        deps,
      );
      // 시도 1건 + 점유 중 1건 = 2.
      await claim(db.pool, { leaseSeconds: 120, limit: 1, deps });

      const usage = await getCallerQuotaUsage(
        db.pool,
        new Map([
          ["alpha", 10],
          ["beta", 5],
        ]),
      );

      expect(usage.get("alpha")).toBe(2);
      expect(usage.get("beta")).toBe(0);
      // 한도 1이면 사용량은 시도 쪽이 한도에서 멈춘 값에 점유 중 수를 더한다(planQuotas와 같은 문장).
      const capped = await getCallerQuotaUsage(
        db.pool,
        new Map([["alpha", 1]]),
      );
      expect(capped.get("alpha")).toBe(2);
    });

    it("호출처가 없으면 쿼리 없이 빈 맵이다", async () => {
      const spy = jest.spyOn(db.pool, "query");
      try {
        const usage = await getCallerQuotaUsage(db.pool, new Map());
        expect(usage.size).toBe(0);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("getFeedLagsForCallers: 호출처별 최신 이벤트 경과", () => {
    it("이벤트가 있는 호출처만 경과 초를 주고 없는 호출처는 뺀다", async () => {
      const id = await createJob(db.pool, { callerId: "alpha" });
      await pastDue(db.pool, id);
      const [job] = await claim(db.pool, { leaseSeconds: 120, limit: 1, deps });
      await completeAttempt(
        db.pool,
        { id: job!.id, leaseToken: job!.leaseToken },
        { classification: "SENT" },
        deps,
      );
      await db.pool.query(
        "UPDATE mail_events SET created_at = now() - interval '90 seconds'",
      );

      const ages = await getFeedLagsForCallers(db.pool, ["alpha", "beta"]);

      expect([...ages.keys()]).toEqual(["alpha"]);
      expect(ages.get("alpha")).toBeGreaterThanOrEqual(90);
      expect(ages.get("alpha")).toBeLessThan(100);
    });

    it("호출처 목록이 비면 쿼리 없이 빈 맵이다", async () => {
      const spy = jest.spyOn(db.pool, "query");
      try {
        expect((await getFeedLagsForCallers(db.pool, [])).size).toBe(0);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("getAuditStats: 감사 행 수와 가장 오래된 행", () => {
    it("행이 없으면 0, truncated false, 가장 오래된 경과 null이다", async () => {
      expect(await getAuditStats(db.pool)).toEqual({
        rows: 0,
        truncated: false,
        oldestAgeSeconds: null,
      });
    });

    it("행 수와 가장 오래된 행의 경과 초를 준다", async () => {
      await writeAudit(db.pool, {
        actor: "ops",
        action: "PAUSE",
        scope: { type: "all" },
      });
      await writeAudit(db.pool, {
        actor: "ops",
        action: "RESUME",
        scope: { type: "all" },
      });
      await db.pool.query(
        "UPDATE mail_ops_audit SET at = now() - interval '120 seconds' WHERE id = (SELECT min(id) FROM mail_ops_audit)",
      );

      const stats = await getAuditStats(db.pool);

      expect(stats.rows).toBe(2);
      expect(stats.truncated).toBe(false);
      expect(stats.oldestAgeSeconds).toBeGreaterThanOrEqual(120);
      expect(stats.oldestAgeSeconds).toBeLessThan(130);
    });

    it("100000을 넘으면 값을 100000으로 자르고 truncated가 true다", async () => {
      await db.pool.query(
        `INSERT INTO mail_ops_audit (actor, action, scope_type, scope_id)
         SELECT 'ops', 'PAUSE', 'all', '' FROM generate_series(1, 100001)`,
      );

      expect(await getAuditStats(db.pool)).toMatchObject({
        rows: 100_000,
        truncated: true,
      });
    });
  });

  describe("종결 전이 관찰자(커밋 뒤에만 호출한다)", () => {
    it("sweepExpired가 EXPIRED로 바꾼 작업의 호출처를 커밋 뒤에 알린다", async () => {
      const a = await createJob(db.pool, { callerId: "alpha" });
      const b = await createJob(db.pool, { callerId: "beta" });
      await db.pool.query(
        "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = ANY($1::uuid[])",
        [[a, b]],
      );
      const seen: JobTransition[][] = [];

      const swept = await sweepExpired(db.pool, 1000, (t) => seen.push([...t]));

      expect(swept).toBe(2);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.map((t) => [t.callerId, t.status]).sort()).toEqual([
        ["alpha", "EXPIRED"],
        ["beta", "EXPIRED"],
      ]);
    });

    it("이벤트 쓰기가 실패해 롤백되면 관찰자를 부르지 않는다", async () => {
      const id = await createJob(db.pool, { callerId: "alpha" });
      await db.pool.query(
        "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = $1",
        [id],
      );
      await db.pool.query(`
        CREATE OR REPLACE FUNCTION fail_event_insert() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'event insert blocked'; END $$`);
      await db.pool.query(
        "CREATE TRIGGER fail_event_insert BEFORE INSERT ON mail_events FOR EACH ROW EXECUTE FUNCTION fail_event_insert()",
      );
      const observer = jest.fn();
      try {
        await expect(sweepExpired(db.pool, 1000, observer)).rejects.toThrow(
          "event insert blocked",
        );
        expect(observer).not.toHaveBeenCalled();
      } finally {
        await db.pool.query("DROP TRIGGER fail_event_insert ON mail_events");
      }
    });

    it("전이한 작업이 없으면 관찰자를 부르지 않는다", async () => {
      const observer = jest.fn();

      expect(await sweepExpired(db.pool, 1000, observer)).toBe(0);
      expect(observer).not.toHaveBeenCalled();
    });

    it("관찰자가 던져도 sweepExpired 결과는 그대로다", async () => {
      const id = await createJob(db.pool, { callerId: "alpha" });
      await db.pool.query(
        "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = $1",
        [id],
      );

      const swept = await sweepExpired(db.pool, 1000, () => {
        throw new Error("관찰자 오류");
      });

      expect(swept).toBe(1);
    });

    it("recoverExpiredLeases가 회수 뒤 작업의 최종 상태를 호출처와 함께 알린다", async () => {
      const retry = await createJob(db.pool, { callerId: "alpha" });
      await claim(db.pool, { leaseSeconds: 120, limit: 1, deps });
      const last = await createJob(db.pool, { callerId: "beta" });
      await pastDue(db.pool, last);
      await claim(db.pool, { leaseSeconds: 120, limit: 1, deps });
      // 두 번째는 시도를 모두 쓴 상태로 만들어 FAILED로 끝나게 한다.
      await db.pool.query("UPDATE mail_jobs SET attempts = $2 WHERE id = $1", [
        last,
        deps.retry.maxAttempts - 1,
      ]);
      await db.pool.query(
        "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE status = 'SENDING'",
      );
      const seen: JobTransition[] = [];

      const recovered = await recoverExpiredLeases(db.pool, deps, 100, {
        onRecovered: (t) => seen.push(...t),
      });

      expect(recovered).toBe(2);
      expect(seen.map((t) => [t.callerId, t.status]).sort()).toEqual([
        ["alpha", "RETRY_WAIT"],
        ["beta", "FAILED"],
      ]);
      expect(retry).toBeTruthy();
    });

    it("claim이 점유 앞단에서 회수한 작업도 onLeaseRecovered로 알린다", async () => {
      await createJob(db.pool, { callerId: "alpha" });
      await claim(db.pool, { leaseSeconds: 120, limit: 1, deps });
      await db.pool.query(
        "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE status = 'SENDING'",
      );
      const seen: JobTransition[] = [];

      await claim(db.pool, {
        leaseSeconds: 120,
        limit: 1,
        deps,
        onLeaseRecovered: (t) => seen.push(...t),
      });

      expect(seen).toEqual([
        { callerId: "alpha", accountId: "default", status: "RETRY_WAIT" },
      ]);
    });

    it("취소 결과가 호출처 ID와 계정 ID를 담는다(관리 토큰 취소의 지표 라벨용)", async () => {
      const id = await createJob(db.pool, { callerId: "alpha" });

      const result = await cancelJob(
        db.pool,
        { callerId: "alpha", jobId: id },
        "CALLER",
      );

      expect(result).toEqual({
        kind: "canceled",
        jobId: id,
        callerId: "alpha",
        accountId: "default",
      });
    });
  });
});
