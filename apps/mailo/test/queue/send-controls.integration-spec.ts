import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import type pg from "pg";
import {
  claim,
  clearPause,
  completeAttempt,
  getCallerPauseSummary,
  getSendControlsSummary,
  listPauses,
  recoverExpiredLeases,
  setPause,
  type QuotaBlock,
  type SendControls,
} from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  completeDeps,
  createJob,
  migrate,
  pastDue,
} from "../support/queue-fixtures.js";

/**
 * 발송 정지(RQ-043, ADR-0011 결정 2·3). 실제 PostgreSQL을 쓴다.
 * 정지는 `claim`의 일반 점유와 대표 작업(probe) 점유를 모두 막고, 호출처 정지는 다른 호출처에 영향이 없다.
 */
describe("PostgreSQL 통합: 발송 정지와 claim (RQ-043, ADR-0011 결정 2·3)", () => {
  let db: TestDatabase;
  const deps = completeDeps();
  const base = { leaseSeconds: 120, limit: 5, deps };

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query("DELETE FROM mail_send_controls");
    await db.pool.query(
      `UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL,
         probe_job_id = NULL, consecutive_failures = 0, wait_seconds = 0, last_reason = NULL,
         last_trip_job_id = NULL, last_trip_token = NULL`,
    );
  });

  const pauseAll = () => setPause(db.pool, { type: "all" }, "oncall");
  const pauseCaller = (id: string) =>
    setPause(db.pool, { type: "caller", id }, "oncall");

  async function status(id: string): Promise<string> {
    const { rows } = await db.pool.query(
      "SELECT status FROM mail_jobs WHERE id = $1",
      [id],
    );
    return rows[0].status;
  }

  async function breaker() {
    const { rows } = await db.pool.query(
      "SELECT state, probe_job_id FROM mail_circuit_breaker",
    );
    return rows[0];
  }

  describe("전체 정지(scope all)", () => {
    it("정지 중에는 일반 점유가 0건이고 작업·시도 횟수·재시도 시각이 변하지 않는다", async () => {
      const a = await createJob(db.pool, { callerId: "alpha" });
      const b = await createJob(db.pool, { callerId: "beta" });
      const before = await db.pool.query(
        "SELECT id, status, attempts, next_attempt_at FROM mail_jobs ORDER BY id",
      );

      await pauseAll();
      for (let i = 0; i < 3; i += 1)
        expect(await claim(db.pool, base)).toEqual([]);

      const after = await db.pool.query(
        "SELECT id, status, attempts, next_attempt_at FROM mail_jobs ORDER BY id",
      );
      expect(after.rows).toEqual(before.rows);
      expect(await status(a)).toBe("PENDING");
      expect(await status(b)).toBe("PENDING");
    });

    it("해제하면 같은 작업이 다음 점유에서 발송 대상이 된다", async () => {
      const id = await createJob(db.pool);
      await pauseAll();
      expect(await claim(db.pool, base)).toEqual([]);

      const cleared = await clearPause(db.pool, { type: "all" });
      const claimed = await claim(db.pool, base);

      expect(cleared.changed).toBe(true);
      expect(claimed.map((j) => j.id)).toEqual([id]);
    });

    it("차단기가 open이고 만료돼도 정지 중에는 대표 작업을 점유하지 않고 차단기도 바꾸지 않는다", async () => {
      const id = await createJob(db.pool);
      await db.pool.query(
        `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() - interval '1 second', last_reason = 'AUTH'`,
      );

      await pauseAll();
      expect(await claim(db.pool, base)).toEqual([]);

      expect(await status(id)).toBe("PENDING");
      expect((await breaker()).state).toBe("open");
      // 해제하면 대표 작업이 점유되고 차단기는 half_open이 된다. 정지는 차단기와 독립이다.
      await clearPause(db.pool, { type: "all" });
      const probe = await claim(db.pool, base);
      expect(probe).toHaveLength(1);
      expect(probe[0]!.isProbe).toBe(true);
      expect((await breaker()).state).toBe("half_open");
    });

    it("차단기가 half_open이고 probe_until이 지나도 정지 중에는 대표 작업을 점유하지 않는다", async () => {
      const id = await createJob(db.pool);
      // half_open은 대표 작업 ID가 필요하다(`mail_circuit_breaker_probe`). 이미 끝난 다른 작업을 가리키게 한다.
      const probeJob = await createJob(db.pool, { callerId: "other" });
      await db.pool.query(
        `UPDATE mail_jobs SET status = 'FAILED', finished_at = now() WHERE id = $1`,
        [probeJob],
      );
      await db.pool.query(
        `UPDATE mail_circuit_breaker SET state = 'half_open', probe_until = now() - interval '1 second',
           probe_job_id = $1, last_reason = 'AUTH'`,
        [probeJob],
      );

      await pauseAll();
      expect(await claim(db.pool, base)).toEqual([]);

      expect(await status(id)).toBe("PENDING");
      expect((await breaker()).state).toBe("half_open");
    });

    it("정지는 차단기와 독립이다. 해제해도 차단기 상태가 바뀌지 않는다", async () => {
      await db.pool.query(
        `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() + interval '1 hour', last_reason = 'AUTH'`,
      );
      await pauseAll();
      await clearPause(db.pool, { type: "all" });

      expect((await breaker()).state).toBe("open");
    });
  });

  describe("호출처 정지(scope caller)", () => {
    it("정지한 호출처만 점유에서 빠지고 다른 호출처는 그대로 점유한다", async () => {
      const alpha = await createJob(db.pool, { callerId: "alpha" });
      const beta = await createJob(db.pool, { callerId: "beta" });

      await pauseCaller("alpha");
      const claimed = await claim(db.pool, base);

      expect(claimed.map((j) => j.id)).toEqual([beta]);
      expect(await status(alpha)).toBe("PENDING");
    });

    it("해제하면 정지했던 호출처의 작업이 점유된다", async () => {
      const alpha = await createJob(db.pool, { callerId: "alpha" });
      await pauseCaller("alpha");
      expect(await claim(db.pool, base)).toEqual([]);

      await clearPause(db.pool, { type: "caller", id: "alpha" });

      expect((await claim(db.pool, base)).map((j) => j.id)).toEqual([alpha]);
    });

    it("호출처 정지는 대표 작업 점유에서도 그 호출처의 작업을 고르지 않는다", async () => {
      const alpha = await createJob(db.pool, { callerId: "alpha" });
      await pastDue(db.pool, alpha);
      // 대표 선택은 뒤에 등록된 작업이 더 늦은 순서다. alpha가 더 앞이어도 정지면 beta를 고른다.
      const beta = await createJob(db.pool, { callerId: "beta" });
      await db.pool.query(
        `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() - interval '1 second', last_reason = 'AUTH'`,
      );

      await pauseCaller("alpha");
      const probe = await claim(db.pool, base);

      expect(probe.map((j) => j.id)).toEqual([beta]);
      expect(probe[0]!.isProbe).toBe(true);
    });

    it("대표 작업 후보가 정지 호출처의 작업뿐이면 점유하지 않고 차단기도 바꾸지 않는다", async () => {
      const alpha = await createJob(db.pool, { callerId: "alpha" });
      await db.pool.query(
        `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() - interval '1 second', last_reason = 'AUTH'`,
      );

      await pauseCaller("alpha");

      expect(await claim(db.pool, base)).toEqual([]);
      expect(await status(alpha)).toBe("PENDING");
      expect((await breaker()).state).toBe("open");
    });

    it("all과 caller 정지가 함께 있어도 해제는 범위별로 따로 동작한다", async () => {
      const alpha = await createJob(db.pool, { callerId: "alpha" });
      await pauseAll();
      await pauseCaller("alpha");

      await clearPause(db.pool, { type: "all" });
      expect(await claim(db.pool, base)).toEqual([]);

      await clearPause(db.pool, { type: "caller", id: "alpha" });
      expect((await claim(db.pool, base)).map((j) => j.id)).toEqual([alpha]);
    });
  });

  describe("쿼터 계산과의 관계", () => {
    /** claim이 보낸 SQL을 모으는 풀 래퍼. 점유 트랜잭션의 쿼리 순서와 종류를 확인한다. */
    function recordingPool(): { pool: pg.Pool; sql: string[] } {
      const sql: string[] = [];
      const wrapClient = (client: pg.PoolClient): pg.PoolClient =>
        new Proxy(client, {
          get(target, prop, receiver) {
            if (prop === "query")
              return (text: unknown, ...rest: unknown[]) => {
                sql.push(
                  typeof text === "string"
                    ? text
                    : ((text as { text?: string }).text ?? ""),
                );
                return (target.query as (...a: unknown[]) => unknown)(
                  text,
                  ...rest,
                );
              };
            const value = Reflect.get(target, prop, receiver) as unknown;
            return typeof value === "function"
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          },
        });
      const pool = new Proxy(db.pool, {
        get(target, prop, receiver) {
          if (prop === "connect")
            return async () => wrapClient(await target.connect());
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as pg.Pool;
      return { pool, sql };
    }

    const usesAdvisoryLock = (sql: string[]) =>
      sql.some((s) => s.includes("pg_try_advisory_xact_lock"));

    it("정지한 호출처는 할당 계산 전에 빠진다(advisory lock·사용량 쿼리를 쓰지 않고 할당 초과로 알리지 않는다)", async () => {
      await createJob(db.pool, { callerId: "alpha" });
      await pauseCaller("alpha");
      const rec = recordingPool();
      const blocked: QuotaBlock[][] = [];

      const claimed = await claim(rec.pool, {
        ...base,
        callerQuotas: new Map([["alpha", 10]]),
        onQuotaBlocked: (b) => blocked.push([...b]),
      });

      expect(claimed).toEqual([]);
      expect(usesAdvisoryLock(rec.sql)).toBe(false);
      expect(rec.sql.some((s) => s.includes("FROM mail_attempts"))).toBe(false);
      // 할당 초과가 아니라 정지로 빠졌으므로 `caller_quota_exceeded` 대상이 아니다.
      expect(blocked.flat()).toEqual([]);
    });

    it("정지하지 않은 호출처는 같은 조건에서 할당을 계산한다(대조)", async () => {
      await createJob(db.pool, { callerId: "alpha" });
      const rec = recordingPool();

      const claimed = await claim(rec.pool, {
        ...base,
        callerQuotas: new Map([["alpha", 10]]),
      });

      expect(claimed).toHaveLength(1);
      expect(usesAdvisoryLock(rec.sql)).toBe(true);
    });

    it("할당이 있는 두 호출처 중 정지한 쪽만 계산에서 빠지고 남은 쪽은 할당을 지킨다", async () => {
      await createJob(db.pool, { callerId: "alpha" });
      await createJob(db.pool, { callerId: "beta" });
      await createJob(db.pool, { callerId: "beta" });
      await pauseCaller("alpha");
      const rec = recordingPool();

      const claimed = await claim(rec.pool, {
        ...base,
        callerQuotas: new Map([
          ["alpha", 10],
          ["beta", 1],
        ]),
      });

      // alpha는 정지로 빠지고 beta는 할당 1건까지만 점유한다.
      expect(claimed.map((j) => j.callerId)).toEqual(["beta"]);
      const lockSql = rec.sql.find((s) =>
        s.includes("pg_try_advisory_xact_lock"),
      );
      expect(lockSql).toBeDefined();
    });

    it("할당이 없는 정지 호출처도 제외한다(할당 맵이 비어 있어도 정지는 적용된다)", async () => {
      const alpha = await createJob(db.pool, { callerId: "alpha" });
      const beta = await createJob(db.pool, { callerId: "beta" });
      await pauseCaller("alpha");

      for (const callerQuotas of [undefined, new Map<string, number>()]) {
        const claimed = await claim(db.pool, {
          ...base,
          ...(callerQuotas && { callerQuotas }),
        });
        expect(claimed.map((j) => j.id)).toEqual([beta]);
        await db.pool.query(
          "UPDATE mail_jobs SET status = 'PENDING', lease_token = NULL, lease_until = NULL, leased_at = NULL WHERE id = $1",
          [beta],
        );
      }
      expect(await status(alpha)).toBe("PENDING");
    });
  });

  describe("잠금 순서와 시각(ADR-0002 결정 10, AGENTS.md 큐 SQL 규칙)", () => {
    it("정지 조회는 행을 잠그지 않는다(FOR UPDATE·FOR SHARE 없음). 차단기 조회 뒤에 읽는다", async () => {
      const seen: string[] = [];
      const recorder = new Proxy(db.pool, {
        get(target, prop, receiver) {
          if (prop === "connect")
            return async () => {
              const client = await target.connect();
              return new Proxy(client, {
                get(c, p, r) {
                  if (p === "query")
                    return (text: unknown, ...rest: unknown[]) => {
                      if (typeof text === "string") seen.push(text);
                      return (c.query as (...a: unknown[]) => unknown)(
                        text,
                        ...rest,
                      );
                    };
                  const v = Reflect.get(c, p, r) as unknown;
                  return typeof v === "function"
                    ? (v as (...a: unknown[]) => unknown).bind(c)
                    : v;
                },
              });
            };
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === "function"
            ? (v as (...a: unknown[]) => unknown).bind(target)
            : v;
        },
      }) as pg.Pool;
      await createJob(db.pool);

      await claim(recorder, base);

      const breakerIndex = seen.findIndex((s) =>
        s.includes("FROM mail_circuit_breaker WHERE breaker_key"),
      );
      const controlsIndex = seen.findIndex((s) =>
        s.includes("FROM mail_send_controls"),
      );
      const jobLockIndex = seen.findIndex((s) => s.includes("WITH picked AS"));
      expect(breakerIndex).toBeGreaterThanOrEqual(0);
      expect(controlsIndex).toBeGreaterThan(breakerIndex);
      expect(jobLockIndex).toBeGreaterThan(controlsIndex);
      expect(seen[controlsIndex]).not.toMatch(/FOR (UPDATE|SHARE|NO KEY)/i);
    });

    it("정지 시각은 DB now()다. 한 트랜잭션 안의 now()와 같고 앱 시계가 아니다", async () => {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        // 트랜잭션 시작 시각과 clock_timestamp()를 벌려 now()와 구별한다.
        await client.query("SELECT pg_sleep(1.1)");
        await setPause(client, { type: "all" }, "oncall");
        const { rows } = await client.query(
          `SELECT paused_at = now() AS is_now, paused_at < clock_timestamp() - interval '1 second' AS stale
             FROM mail_send_controls`,
        );
        await client.query("ROLLBACK");

        expect(rows[0]).toEqual({ is_now: true, stale: true });
      } finally {
        client.release();
      }
    });
  });

  describe("claim 중·진행 중 작업에 대한 영향(ADR-0011 결정 2)", () => {
    it("이미 SENDING인 작업은 정지해도 결과를 기록한다(전송은 끝까지 간다)", async () => {
      const id = await createJob(db.pool);
      const [job] = await claim(db.pool, base);
      expect(job!.id).toBe(id);

      await pauseAll();
      const result = await completeAttempt(
        db.pool,
        { id: job!.id, leaseToken: job!.leaseToken },
        { classification: "SENT" },
        deps,
      );

      expect(result.applied).toBe(true);
      expect(await status(id)).toBe("SENT");
    });

    it("정지 중 실패한 작업은 RETRY_WAIT으로 기록되고 해제 전에는 다시 점유되지 않는다", async () => {
      const id = await createJob(db.pool);
      const [job] = await claim(db.pool, base);
      await pauseAll();

      await completeAttempt(
        db.pool,
        { id: job!.id, leaseToken: job!.leaseToken },
        { classification: "TRANSIENT", stage: "RCPT", responseCode: 451 },
        deps,
      );
      await db.pool.query(
        "UPDATE mail_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
        [id],
      );

      expect(await status(id)).toBe("RETRY_WAIT");
      expect(await claim(db.pool, base)).toEqual([]);
      await clearPause(db.pool, { type: "all" });
      expect((await claim(db.pool, base)).map((j) => j.id)).toEqual([id]);
    });

    it("정지 중에도 lease 복구는 계속 돈다(만료된 SENDING은 RETRY_WAIT으로 돌아온다)", async () => {
      const id = await createJob(db.pool);
      await claim(db.pool, base);
      await db.pool.query(
        "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
        [id],
      );

      await pauseAll();
      // claim 안의 복구가 정지 판정보다 앞이다. 점유는 하지 않는다.
      expect(await claim(db.pool, base)).toEqual([]);

      expect(await status(id)).toBe("RETRY_WAIT");
      // 호출을 한 번 더 해도 상태는 그대로다(복구는 멱등).
      await recoverExpiredLeases(db.pool, deps);
      expect(await status(id)).toBe("RETRY_WAIT");
    });
  });

  describe("정지 상태 알림과 조회", () => {
    it("onSendControls가 점유마다 현재 정지 상태를 알린다(차단기가 open이어도 알린다)", async () => {
      await pauseCaller("alpha");
      await pauseCaller("beta");
      await db.pool.query(
        `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() + interval '1 hour', last_reason = 'AUTH'`,
      );
      const seen: SendControls[] = [];

      await claim(db.pool, {
        ...base,
        onSendControls: (c) => seen.push(c),
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]!.allPaused).toBe(false);
      expect([...seen[0]!.pausedCallerIds].sort()).toEqual(["alpha", "beta"]);
    });

    it("setPause는 멱등하다. 이미 정지면 changed false이고 처음 시각·이름을 유지한다", async () => {
      const first = await setPause(db.pool, { type: "all" }, "oncall");
      const second = await setPause(db.pool, { type: "all" }, "other");

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(second.pause.pausedBy).toBe("oncall");
      expect(second.pause.pausedAt).toEqual(first.pause.pausedAt);
    });

    it("clearPause는 정지가 없으면 changed false다", async () => {
      expect(await clearPause(db.pool, { type: "all" })).toEqual({
        changed: false,
      });
    });

    it("listPauses는 all·caller·account를 정지 시각 순서로 준다 (RQ-061, ADR-0013 결정 5)", async () => {
      await pauseCaller("beta");
      await pauseAll();
      await db.pool.query(
        "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('account', 'default', 'oncall')",
      );

      const pauses = await listPauses(db.pool);

      expect(pauses.map((p) => p.scope)).toEqual([
        { type: "caller", id: "beta" },
        { type: "all" },
        { type: "account", id: "default" },
      ]);
    });

    it("호출처 요약은 자기 범위만 보고 all이 caller보다 앞선다", async () => {
      expect(await getCallerPauseSummary(db.pool, "alpha")).toEqual({
        paused: false,
        scope: null,
      });
      await pauseCaller("beta");
      expect(await getCallerPauseSummary(db.pool, "alpha")).toEqual({
        paused: false,
        scope: null,
      });
      await pauseCaller("alpha");
      expect(await getCallerPauseSummary(db.pool, "alpha")).toEqual({
        paused: true,
        scope: "caller",
      });
      await pauseAll();
      expect(await getCallerPauseSummary(db.pool, "alpha")).toEqual({
        paused: true,
        scope: "all",
      });
    });

    it("운영자 요약은 전체 정지 여부와 정지 호출처 수만 준다", async () => {
      await pauseCaller("alpha");
      await pauseCaller("beta");

      expect(await getSendControlsSummary(db.pool)).toEqual({
        allPaused: false,
        pausedCallerCount: 2,
      });
    });
  });
});
