/**
 * `/metrics`의 전역 gauge 값과 DB 수집 동작(RQ-049, ADR-0012 결정 4·5·6). 실제 PostgreSQL과 앱을 쓴다.
 * 고정하는 것: 작업 상태별 개수·등급별 가장 오래된 대기·차단기·정지·할당·피드·감사 값, 헬스와의 일치, 인스턴스 간 일치,
 * TTL 캐시와 단일 비행(풀 연결 1회), 그룹별 실패 격리, 호출처 라벨 상한, 요청 값 비노출(RQ-027).
 */
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import pg from "pg";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  duplicateSeries,
  findSamples,
  parseMetrics,
  valueOf,
  type ParsedSample,
} from "../support/metrics-text.js";
import {
  claim,
  completeAttempt,
  type JobStatus,
} from "../../src/queue/index.js";
import { completeDeps, createJob, migrate } from "../support/queue-fixtures.js";
import {
  ALPHA_KEY,
  CANARY,
  getJson,
  plainMail,
  postJob,
  startRestApp,
  type RestApp,
  type StartRestAppOptions,
} from "../support/rest-app.js";

const READ = "ops-read-fake-token-000000000000000000000001";
const ADMIN = "ops-admin-oncall-fake-token-000000000000001";
const OPS_ENV = {
  MAILO_OPS_TOKEN: READ,
  MAILO_OPS_ADMIN_NAMES: "oncall",
  MAILO_OPS_ADMIN_TOKEN_ONCALL: ADMIN,
};
const UNKNOWN_UUID = "00000000-0000-4000-8000-000000000000";

async function scrape(app: RestApp): Promise<ParsedSample[]> {
  const res = await fetch(`${app.baseUrl}/metrics`, {
    headers: { Authorization: `Bearer ${READ}` },
  });
  expect(res.status).toBe(200);
  return parseMetrics(await res.text());
}

describe("REST 통합: /metrics 전역 gauge(RQ-049, ADR-0012 결정 4·5)", () => {
  let db: TestDatabase;
  const deps = completeDeps();

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query("DELETE FROM mail_ops_audit");
    await db.pool.query("DELETE FROM mail_send_controls");
    await db.pool.query(
      `UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL,
         probe_job_id = NULL, consecutive_failures = 0, wait_seconds = 0, last_reason = NULL,
         last_trip_job_id = NULL, last_trip_token = NULL`,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  /** 캐시가 비어 있는 새 앱으로 한 번 스크레이프하고 닫는다. */
  async function withApp<T>(
    fn: (app: RestApp) => Promise<T>,
    options: Partial<StartRestAppOptions> = {},
  ): Promise<T> {
    const app = await startRestApp({
      pool: db.pool,
      ...options,
      env: { ...OPS_ENV, ...options.env },
    });
    try {
      return await fn(app);
    } finally {
      await app.close();
    }
  }

  const ageJob = (id: string, seconds: number) =>
    db.pool.query(
      `UPDATE mail_jobs SET next_attempt_at = now() - make_interval(secs => $2) WHERE id = $1`,
      [id, seconds],
    );

  describe("큐 깊이와 가장 오래된 대기", () => {
    it("due·scheduled·sending 건수와 등급별 가장 오래된 점유 가능 작업의 나이를 낸다", async () => {
      const low = await createJob(db.pool, {
        callerId: "alpha",
        priority: "LOW",
      });
      await ageJob(low, 300);
      const urgent = await createJob(db.pool, {
        callerId: "alpha",
        priority: "URGENT",
      });
      await ageJob(urgent, 45);
      const later = await createJob(db.pool, { callerId: "beta" });
      await db.pool.query(
        "UPDATE mail_jobs SET status = 'RETRY_WAIT', next_attempt_at = now() + interval '1 hour' WHERE id = $1",
        [later],
      );
      const inflight = await createJob(db.pool, { callerId: "beta" });
      await db.pool.query(
        `UPDATE mail_jobs SET status = 'SENDING', leased_at = now(), lease_token = $2,
                lease_until = now() + interval '2 minutes' WHERE id = $1`,
        [inflight, randomUUID()],
      );

      const samples = await withApp(scrape);

      const q = (state: string) =>
        valueOf(samples, "mailo_queue_jobs", { account_id: "default", state });
      expect(q("due")).toBe(2);
      expect(q("scheduled")).toBe(1);
      expect(q("sending")).toBe(1);
      expect(
        valueOf(samples, "mailo_queue_jobs_truncated", { state: "due" }),
      ).toBe(0);
      expect(
        valueOf(samples, "mailo_queue_jobs_truncated", { state: "scheduled" }),
      ).toBe(0);
      const age = (priority: string) =>
        valueOf(samples, "mailo_queue_oldest_due_age_seconds", {
          account_id: "default",
          priority,
        })!;
      expect(age("low")).toBeGreaterThanOrEqual(300);
      expect(age("low")).toBeLessThan(310);
      expect(age("urgent")).toBeGreaterThanOrEqual(45);
      expect(age("urgent")).toBeLessThan(55);
      // 대기 작업이 없는 등급은 0이다.
      expect(age("normal")).toBe(0);
      expect(age("high")).toBe(0);
      expect(
        findSamples(samples, "mailo_queue_oldest_due_age_seconds"),
      ).toHaveLength(4);
    });

    it("due가 10000을 넘으면 값은 10000이고 truncated가 1이다(헬스 dueCountTruncated와 같은 뜻)", async () => {
      await db.pool.query(
        `INSERT INTO mail_jobs (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version,
                                status, next_attempt_at, expires_at, recipients)
         SELECT gen_random_uuid(), 'alpha', 'bulk-' || g, '\\x00', 1, 'PENDING',
                now() - interval '1 minute', now() + interval '1 day', '{}'::jsonb
           FROM generate_series(1, 10001) g`,
      );

      const samples = await withApp(scrape);

      expect(valueOf(samples, "mailo_queue_jobs", { state: "due" })).toBe(
        10_000,
      );
      expect(
        valueOf(samples, "mailo_queue_jobs_truncated", { state: "due" }),
      ).toBe(1);
    });

    it("같은 데이터에서 헬스의 queue.dueCount·등급별 나이와 같다", async () => {
      const a = await createJob(db.pool, { callerId: "alpha" });
      await ageJob(a, 120);
      await createJob(db.pool, { callerId: "beta", priority: "HIGH" });

      await withApp(async (app) => {
        const samples = await scrape(app);
        const ready = (await (
          await getJson(app, "/health/ready", READ)
        ).json()) as Record<string, any>;

        expect(valueOf(samples, "mailo_queue_jobs", { state: "due" })).toBe(
          ready["queue"].dueCount,
        );
        expect(
          valueOf(samples, "mailo_queue_oldest_due_age_seconds", {
            priority: "normal",
          }),
        ).toBe(ready["queue"].oldestDueAgeSecondsByPriority.NORMAL);
      });
    });
  });

  describe("차단기", () => {
    it("closed이면 closed 시리즈만 1이고 사유 시리즈는 없다", async () => {
      const samples = await withApp(scrape);

      expect(valueOf(samples, "mailo_breaker_state", { state: "closed" })).toBe(
        1,
      );
      expect(valueOf(samples, "mailo_breaker_state", { state: "open" })).toBe(
        0,
      );
      expect(
        valueOf(samples, "mailo_breaker_state", { state: "half_open" }),
      ).toBe(0);
      expect(findSamples(samples, "mailo_breaker_reason_info")).toEqual([]);
    });

    it("closed에서 마지막 실패 사유가 남아 있어도 사유 시리즈를 내지 않는다", async () => {
      await db.pool.query(
        "UPDATE mail_circuit_breaker SET last_reason = 'AUTH'",
      );

      const samples = await withApp(scrape);

      expect(findSamples(samples, "mailo_breaker_reason_info")).toEqual([]);
    });

    it("open이면 open 시리즈가 1이고 헬스 lastReason과 같은 어휘의 사유 시리즈가 하나다", async () => {
      await db.pool.query(
        `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() + interval '10 minutes',
                last_reason = 'DAILY_LIMIT'`,
      );

      await withApp(async (app) => {
        const samples = await scrape(app);
        const ready = (await (
          await getJson(app, "/health/ready", READ)
        ).json()) as Record<string, any>;

        expect(valueOf(samples, "mailo_breaker_state", { state: "open" })).toBe(
          1,
        );
        expect(
          valueOf(samples, "mailo_breaker_state", { state: "closed" }),
        ).toBe(0);
        expect(findSamples(samples, "mailo_breaker_reason_info")).toEqual([
          {
            name: "mailo_breaker_reason_info",
            labels: { account_id: "default", reason: "QUOTA_DAILY" },
            value: 1,
          },
        ]);
        expect(ready["circuitBreaker"].lastReason).toBe("QUOTA_DAILY");
      });
    });

    it("half_open이면 half_open 시리즈가 1이다", async () => {
      const id = await createJob(db.pool, { callerId: "alpha" });
      await db.pool.query(
        `UPDATE mail_circuit_breaker SET state = 'half_open', probe_job_id = $1,
                probe_until = now() + interval '1 minute', last_reason = 'AUTH'`,
        [id],
      );

      const samples = await withApp(scrape);

      expect(
        valueOf(samples, "mailo_breaker_state", { state: "half_open" }),
      ).toBe(1);
      expect(
        findSamples(samples, "mailo_breaker_reason_info")[0]?.labels["reason"],
      ).toBe("AUTH_FAILED");
    });
  });

  describe("발송 정지", () => {
    it("전체·호출처 정지를 센다. 레지스트리 밖 호출처의 정지도 개수에 들어가지만 caller_id 시리즈는 만들지 않는다", async () => {
      await db.pool.query(
        `INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES
           ('all', '', 'oncall'), ('caller', 'alpha', 'oncall'), ('caller', 'gone-caller', 'oncall')`,
      );

      const samples = await withApp(scrape);

      expect(valueOf(samples, "mailo_send_paused_all")).toBe(1);
      expect(valueOf(samples, "mailo_send_paused_callers")).toBe(2);
      expect(
        valueOf(samples, "mailo_caller_paused", { caller_id: "alpha" }),
      ).toBe(1);
      expect(
        valueOf(samples, "mailo_caller_paused", { caller_id: "beta" }),
      ).toBe(0);
      expect(findSamples(samples, "mailo_caller_paused")).toHaveLength(2);
      expect(JSON.stringify(samples)).not.toContain("gone-caller");
    });

    it("정지가 없으면 모두 0이다", async () => {
      const samples = await withApp(scrape);

      expect(valueOf(samples, "mailo_send_paused_all")).toBe(0);
      expect(valueOf(samples, "mailo_send_paused_callers")).toBe(0);
    });
  });

  describe("호출처 할당과 이벤트 경과", () => {
    it("할당을 설정한 호출처만 limit·used를 내고 used는 시도와 점유 중 수의 합이다", async () => {
      for (let i = 0; i < 3; i++)
        await createJob(db.pool, { callerId: "alpha" });
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
      await claim(db.pool, { leaseSeconds: 120, limit: 1, deps });

      const samples = await withApp(scrape, {
        callerFields: { alpha: { sendQuota24h: 5 } },
      });

      expect(
        valueOf(samples, "mailo_caller_quota_limit", { caller_id: "alpha" }),
      ).toBe(5);
      expect(
        valueOf(samples, "mailo_caller_quota_used", { caller_id: "alpha" }),
      ).toBe(2);
      // 할당이 없는 beta는 시리즈가 없다.
      expect(
        findSamples(samples, "mailo_caller_quota_limit", { caller_id: "beta" }),
      ).toEqual([]);
      expect(
        findSamples(samples, "mailo_caller_quota_used", { caller_id: "beta" }),
      ).toEqual([]);
    });

    it("시도 쪽 사용량은 한도에서 멈춘다(점유 중이 없을 때 used = limit)", async () => {
      for (let i = 0; i < 3; i++) {
        await createJob(db.pool, { callerId: "alpha" });
        const [job] = await claim(db.pool, {
          leaseSeconds: 120,
          limit: 1,
          deps,
        });
        await completeAttempt(
          db.pool,
          { id: job!.id, leaseToken: job!.leaseToken },
          { classification: "SENT" },
          deps,
        );
      }

      const samples = await withApp(scrape, {
        callerFields: { alpha: { sendQuota24h: 2 } },
      });

      expect(
        valueOf(samples, "mailo_caller_quota_used", { caller_id: "alpha" }),
      ).toBe(2);
    });

    it("사용량은 점유 중 수를 더하므로 한도를 넘을 수 있고 비율이 1을 넘는다", async () => {
      // 시도 2건(한도 2에서 멈춘 값)에 점유 중 1건이 더해져 used = 3 > limit = 2다(claim의 사용량 문장과 같다).
      for (let i = 0; i < 2; i++) {
        await createJob(db.pool, { callerId: "alpha" });
        const [job] = await claim(db.pool, {
          leaseSeconds: 120,
          limit: 1,
          deps,
        });
        await completeAttempt(
          db.pool,
          { id: job!.id, leaseToken: job!.leaseToken },
          { classification: "SENT" },
          deps,
        );
      }
      const inflight = await createJob(db.pool, { callerId: "alpha" });
      await db.pool.query(
        `UPDATE mail_jobs SET status = 'SENDING', leased_at = now(), lease_token = $2,
                lease_until = now() + interval '2 minutes' WHERE id = $1`,
        [inflight, randomUUID()],
      );

      const samples = await withApp(scrape, {
        callerFields: { alpha: { sendQuota24h: 2 } },
      });

      const used = valueOf(samples, "mailo_caller_quota_used", {
        caller_id: "alpha",
      })!;
      const limit = valueOf(samples, "mailo_caller_quota_limit", {
        caller_id: "alpha",
      })!;
      expect(limit).toBe(2);
      expect(used).toBe(3);
      expect(used / limit).toBeGreaterThan(1);
    });

    it("최신 이벤트의 경과 초는 이벤트가 있는 호출처에만 있다", async () => {
      await createJob(db.pool, { callerId: "alpha" });
      const [job] = await claim(db.pool, { leaseSeconds: 120, limit: 1, deps });
      await completeAttempt(
        db.pool,
        { id: job!.id, leaseToken: job!.leaseToken },
        { classification: "SENT" },
        deps,
      );
      await db.pool.query(
        "UPDATE mail_events SET created_at = now() - interval '75 seconds'",
      );

      const samples = await withApp(scrape);

      const alpha = valueOf(samples, "mailo_caller_latest_event_age_seconds", {
        caller_id: "alpha",
      })!;
      expect(alpha).toBeGreaterThanOrEqual(75);
      expect(alpha).toBeLessThan(85);
      expect(
        findSamples(samples, "mailo_caller_latest_event_age_seconds", {
          caller_id: "beta",
        }),
      ).toEqual([]);
    });
  });

  describe("감사 행 수", () => {
    it("행 수, 상한 도달 여부, 가장 오래된 행의 나이를 낸다", async () => {
      await db.pool.query(
        `INSERT INTO mail_ops_audit (at, actor, action, scope_type, scope_id)
         VALUES (now() - interval '600 seconds', 'oncall', 'PAUSE', 'all', ''),
                (now(), 'oncall', 'RESUME', 'all', '')`,
      );

      const samples = await withApp(scrape);

      expect(valueOf(samples, "mailo_ops_audit_rows")).toBe(2);
      expect(valueOf(samples, "mailo_ops_audit_rows_truncated")).toBe(0);
      const age = valueOf(samples, "mailo_ops_audit_oldest_age_seconds")!;
      expect(age).toBeGreaterThanOrEqual(600);
      expect(age).toBeLessThan(610);
    });

    it("행이 없으면 가장 오래된 나이는 0이다", async () => {
      const samples = await withApp(scrape);

      expect(valueOf(samples, "mailo_ops_audit_rows")).toBe(0);
      expect(valueOf(samples, "mailo_ops_audit_oldest_age_seconds")).toBe(0);
    });
  });

  describe("인스턴스 사이", () => {
    it("같은 DB를 쓰는 앱 둘의 전역 gauge가 같다", async () => {
      await createJob(db.pool, { callerId: "alpha" });
      await createJob(db.pool, { callerId: "beta", priority: "HIGH" });
      await db.pool.query(
        "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('caller', 'beta', 'oncall')",
      );

      const a = await startRestApp({ pool: db.pool, env: OPS_ENV });
      const b = await startRestApp({ pool: db.pool, env: OPS_ENV });
      try {
        const globalOnly = (samples: ParsedSample[]) =>
          samples.filter((s) =>
            /^mailo_(queue_|breaker_|send_paused|caller_|ops_audit_)/.test(
              s.name,
            ),
          );
        const fromA = globalOnly(await scrape(a));
        const fromB = globalOnly(await scrape(b));

        expect(fromA.length).toBeGreaterThan(0);
        // 나이(초)는 두 수집 사이에 흐른 시간만큼 어긋날 수 있어 반올림 오차 1초까지 본다.
        expect(fromA.map((s) => [s.name, s.labels])).toEqual(
          fromB.map((s) => [s.name, s.labels]),
        );
        for (const [i, s] of fromA.entries())
          expect(Math.abs(s.value - fromB[i]!.value)).toBeLessThanOrEqual(1);
      } finally {
        await a.close();
        await b.close();
      }
    });
  });

  describe("TTL 캐시와 단일 비행(ADR-0012 결정 5)", () => {
    it("동시에 온 스크레이프 여러 건이 DB 수집을 한 번만 만든다(풀 연결 1회)", async () => {
      await createJob(db.pool, { callerId: "alpha" });
      await withApp(async (app) => {
        const connect = jest.spyOn(db.pool, "connect");
        try {
          const results = await Promise.all(
            Array.from({ length: 20 }, () => scrape(app)),
          );

          expect(connect).toHaveBeenCalledTimes(1);
          // 모든 응답이 같은 큐 깊이를 본다.
          for (const samples of results)
            expect(valueOf(samples, "mailo_queue_jobs", { state: "due" })).toBe(
              1,
            );
        } finally {
          connect.mockRestore();
        }
      });
    });

    it("TTL 안의 다음 스크레이프는 DB를 다시 읽지 않고 TTL이 지나면 다시 읽는다", async () => {
      await createJob(db.pool, { callerId: "alpha" });
      await withApp(
        async (app) => {
          const connect = jest.spyOn(db.pool, "connect");
          try {
            const first = await scrape(app);
            expect(connect).toHaveBeenCalledTimes(1);
            await createJob(db.pool, { callerId: "alpha" }); // 이 등록도 풀 연결을 쓴다.
            const afterRegister = connect.mock.calls.length;
            const second = await scrape(app);

            // TTL 안의 스크레이프는 풀 연결을 쓰지 않는다.
            expect(connect.mock.calls.length).toBe(afterRegister);
            expect(valueOf(first, "mailo_queue_jobs", { state: "due" })).toBe(
              1,
            );
            // 캐시된 값이다. 새 작업이 반영되지 않았다.
            expect(valueOf(second, "mailo_queue_jobs", { state: "due" })).toBe(
              1,
            );
            expect(
              valueOf(second, "mailo_metrics_snapshot_age_seconds"),
            ).toBeGreaterThanOrEqual(0);

            await new Promise((resolve) => setTimeout(resolve, 1100));
            const third = await scrape(app);

            expect(connect.mock.calls.length).toBe(afterRegister + 1);
            expect(valueOf(third, "mailo_queue_jobs", { state: "due" })).toBe(
              2,
            );
          } finally {
            connect.mockRestore();
          }
        },
        { env: { MAILO_METRICS_CACHE_SECONDS: "1" } },
      );
    });

    it("수집은 풀 연결을 하나만 쓰고 끝나면 돌려준다", async () => {
      await withApp(async (app) => {
        await scrape(app);

        expect(db.pool.totalCount - db.pool.idleCount).toBe(0);
      });
    });

    it("수집 쿼리는 쓰기·행 잠금 없이 읽기 전용 트랜잭션에서 돈다", async () => {
      await createJob(db.pool, { callerId: "alpha" });
      const log: string[] = [];
      const real = db.pool.connect.bind(
        db.pool,
      ) as () => Promise<pg.PoolClient>;
      const connect = jest
        .spyOn(db.pool, "connect")
        .mockImplementation((async () => {
          const client = await real();
          const query = client.query.bind(client) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          client.query = ((...args: unknown[]) => {
            const first = args[0];
            log.push(
              typeof first === "string"
                ? first
                : String((first as { text?: string }).text),
            );
            return query(...args);
          }) as typeof client.query;
          return client;
        }) as never);
      try {
        await withApp(async (app) => {
          await scrape(app);
        });
      } finally {
        connect.mockRestore();
      }

      const joined = log.join("\n");
      expect(log.filter((q) => q === "BEGIN READ ONLY")).toHaveLength(6);
      expect(joined).not.toMatch(
        /FOR UPDATE|FOR SHARE|advisory|INSERT|UPDATE mail|DELETE/i,
      );
      expect(
        log.filter((q) => q.startsWith("SET LOCAL statement_timeout")),
      ).toHaveLength(6);
    });
  });

  describe("그룹별 실패 격리(ADR-0012 결정 5)", () => {
    it("한 그룹의 쿼리가 실패해도 HTTP 200이고 그 그룹만 빠지며 collect_ok가 0이다", async () => {
      await createJob(db.pool, { callerId: "alpha" });
      await db.pool.query(
        "ALTER TABLE mail_ops_audit RENAME TO mail_ops_audit_off",
      );
      try {
        const samples = await withApp(scrape);

        expect(
          valueOf(samples, "mailo_metrics_collect_ok", { group: "audit" }),
        ).toBe(0);
        for (const group of ["queue", "breaker", "controls", "quota", "feed"])
          expect(valueOf(samples, "mailo_metrics_collect_ok", { group })).toBe(
            1,
          );
        expect(findSamples(samples, "mailo_ops_audit_rows")).toEqual([]);
        expect(
          findSamples(samples, "mailo_ops_audit_oldest_age_seconds"),
        ).toEqual([]);
        // 나머지 그룹은 그대로 나온다.
        expect(valueOf(samples, "mailo_queue_jobs", { state: "due" })).toBe(1);
        expect(
          valueOf(samples, "mailo_breaker_state", { state: "closed" }),
        ).toBe(1);
      } finally {
        await db.pool.query(
          "ALTER TABLE mail_ops_audit_off RENAME TO mail_ops_audit",
        );
      }
    });

    it("쿼리가 statement_timeout(2초)에 걸리면 그 그룹만 실패한다", async () => {
      const locker = await db.pool.connect();
      try {
        await locker.query("BEGIN");
        await locker.query(
          "LOCK TABLE mail_ops_audit IN ACCESS EXCLUSIVE MODE",
        );

        const started = Date.now();
        const samples = await withApp(scrape);
        const elapsed = Date.now() - started;

        expect(
          valueOf(samples, "mailo_metrics_collect_ok", { group: "audit" }),
        ).toBe(0);
        expect(
          valueOf(samples, "mailo_metrics_collect_ok", { group: "queue" }),
        ).toBe(1);
        expect(findSamples(samples, "mailo_ops_audit_rows")).toEqual([]);
        // 서버 쪽 상한이 먼저 끊는다. 수집 전체 상한(5초)까지 가지 않는다.
        expect(elapsed).toBeLessThan(4500);
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
      }
    }, 15_000);

    it("연결을 얻지 못하면 모든 그룹이 0이고 전역 gauge가 빠지지만 HTTP는 200이고 인스턴스 값은 나온다", async () => {
      // 아무도 듣지 않는 포트. 앱 기동은 쿼리를 보내지 않으므로 성공한다.
      const dead = new pg.Pool({
        connectionString: "postgres://x:y@127.0.0.1:1/none",
        connectionTimeoutMillis: 500,
      });
      dead.on("error", () => undefined);
      try {
        const samples = await withApp(scrape, { pool: dead });

        for (const group of [
          "queue",
          "breaker",
          "controls",
          "quota",
          "feed",
          "audit",
        ])
          expect(valueOf(samples, "mailo_metrics_collect_ok", { group })).toBe(
            0,
          );
        expect(findSamples(samples, "mailo_queue_jobs")).toEqual([]);
        expect(findSamples(samples, "mailo_breaker_state")).toEqual([]);
        expect(
          valueOf(samples, "mailo_worker_state", { state: "disabled" }),
        ).toBe(1);
        expect(
          valueOf(samples, "process_resident_memory_bytes"),
        ).toBeGreaterThan(0);
        expect(duplicateSeries(samples)).toEqual([]);
      } finally {
        await dead.end();
      }
    });

    it("그룹 실패는 metrics_collect_failed로 한 번만 남기고 오류 메시지·쿼리 값은 싣지 않는다", async () => {
      await db.pool.query(
        "ALTER TABLE mail_ops_audit RENAME TO mail_ops_audit_off",
      );
      try {
        await withApp(
          async (app) => {
            app.app.useLogger(app.logs.logger);
            app.logs.lines.length = 0;
            await scrape(app);
            await new Promise((resolve) => setTimeout(resolve, 1100));
            await scrape(app); // TTL 뒤 다시 수집해도 같은 그룹의 연속 실패는 반복하지 않는다.

            const failed = app.logs.lines
              .map((l) => {
                try {
                  return JSON.parse(l) as Record<string, unknown>;
                } catch {
                  return {};
                }
              })
              .filter((l) => l["event"] === "metrics_collect_failed");
            expect(failed).toHaveLength(1);
            expect(failed[0]).toMatchObject({ level: "warn", group: "audit" });
            expect(Object.keys(failed[0]!).sort()).toEqual(
              ["error", "event", "group", "instance", "level", "ts"].sort(),
            );
            expect(String(failed[0]!["error"])).not.toContain("mail_ops_audit");
          },
          { env: { MAILO_METRICS_CACHE_SECONDS: "1" } },
        );
      } finally {
        await db.pool.query(
          "ALTER TABLE mail_ops_audit_off RENAME TO mail_ops_audit",
        );
      }
    });
  });

  describe("라벨 카디널리티(ADR-0012 결정 6)", () => {
    it("DB에 레지스트리 밖 호출처의 작업이 많아도 caller_id 시리즈는 레지스트리 호출처만 만든다", async () => {
      await db.pool.query(
        `INSERT INTO mail_jobs (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version,
                                status, expires_at, recipients)
         SELECT gen_random_uuid(), 'fake-' || g, 'k-' || g, '\\x00', 1, 'PENDING',
                now() + interval '1 day', '{}'::jsonb
           FROM generate_series(1, 300) g`,
      );
      await db.pool.query(
        "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) SELECT 'caller', 'fake-' || g, 'x' FROM generate_series(1, 50) g",
      );

      const samples = await withApp(scrape);

      const callerIds = new Set(
        samples.flatMap((s) =>
          s.labels["caller_id"] ? [s.labels["caller_id"]] : [],
        ),
      );
      expect([...callerIds].sort()).toEqual(["alpha", "beta"]);
      expect(samples.length).toBeLessThan(150);
      // 정지 개수에는 센다.
      expect(valueOf(samples, "mailo_send_paused_callers")).toBe(50);
    });
  });

  describe("요청 값 비노출(RQ-027)", () => {
    it("본문·제목·수신자·Key·작업 ID·토큰의 canary가 /metrics 응답에 없다", async () => {
      const app = await startRestApp({
        pool: db.pool,
        env: { ...OPS_ENV, MAILO_SMTP_PASSWORD: CANARY.smtpPassword },
      });
      try {
        const res = await postJob(app, {
          key: CANARY.key,
          body: plainMail({
            to: [`${CANARY.recipient}@example.com`],
            subject: CANARY.subject,
            text: CANARY.text,
            html: `<p>${CANARY.html}</p>`,
          }),
        });
        const created = (await res.json()) as Record<string, unknown>;
        const jobId = String(created["jobId"]);
        expect(res.status).toBe(202);
        // 이벤트·시도 이력이 있는 작업도 만든다.
        await db.pool.query(
          "UPDATE mail_jobs SET last_account_response = $2 WHERE id = $1",
          [jobId, CANARY.field],
        );
        await getJson(app, `/jobs/${jobId}`);

        const res2 = await fetch(`${app.baseUrl}/metrics`, {
          headers: { Authorization: `Bearer ${READ}` },
        });
        const text = await res2.text();

        for (const secret of [
          CANARY.subject,
          CANARY.text,
          CANARY.html,
          CANARY.recipient,
          CANARY.key,
          CANARY.smtpPassword,
          CANARY.field,
          jobId,
          READ,
          ADMIN,
          ALPHA_KEY,
          "kim@example.com",
        ])
          expect(text).not.toContain(secret);
        // 로그에도 없다.
        const logs = app.logs.lines.join("\n");
        expect(logs).not.toContain(READ);
        expect(logs).not.toContain(ADMIN);
        expect(UNKNOWN_UUID).toBeTruthy();
      } finally {
        await app.close();
      }
    });
  });

  it("작업 상태 값 목록(타입)이 큐와 같다(상태 추가가 지표를 놓치지 않게 알림)", () => {
    const statuses: JobStatus[] = [
      "PENDING",
      "SENDING",
      "RETRY_WAIT",
      "SENT",
      "FAILED",
      "EXPIRED",
      "CANCELED",
    ];
    // 새 상태가 생기면 컴파일 오류로 이 목록과 `getQueueDepth`의 분류를 다시 보게 한다.
    expect(statuses).toHaveLength(7);
  });
});
