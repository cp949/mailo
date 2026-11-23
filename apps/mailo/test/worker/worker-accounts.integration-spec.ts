import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import type pg from "pg";
import {
  defaultRetryPolicy,
  ensureBreakerRows,
} from "../../src/queue/index.js";
import { createSmtpSender } from "../../src/smtp/index.js";
import {
  createWorker,
  defaultWorkerOptions,
  encodeBodyContent,
  type WorkerAccount,
  type WorkerHandle,
  type WorkerOptions,
} from "../../src/worker/index.js";
import { createJsonLogger } from "../../src/logging/index.js";
import { countingPool } from "../support/counting-pool.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp.js";
import { createJob, migrate, testCipher } from "../support/queue-fixtures.js";

/**
 * Worker의 계정 단위 점유·슬롯 배분·계정 할당·정지(RQ-054·055, ADR-0013 결정 3). 실제 PostgreSQL과 가짜 SMTP 둘을 쓴다.
 * 계정 `default`는 `fakeDefault`, 계정 `marketing`은 `fakeMarketing`으로 나간다.
 */
describe("PostgreSQL + SMTP 통합: Worker 계정 단위 점유 (RQ-054·055, ADR-0013 결정 3)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let fakeDefault: FakeSmtp;
  let fakeMarketing: FakeSmtp;
  const logs: string[] = [];
  const workers: WorkerHandle[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    await migrate(pool);
    fakeDefault = await startFakeSmtp();
    fakeMarketing = await startFakeSmtp();
  });

  afterAll(async () => {
    await fakeDefault.close();
    await fakeMarketing.close();
    await db.close();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM mail_jobs");
    await pool.query("DELETE FROM mail_send_controls");
    await pool.query(
      "DELETE FROM mail_circuit_breaker WHERE breaker_key <> 'default'",
    );
    await pool.query(
      `UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL,
         probe_job_id = NULL, consecutive_failures = 0, wait_seconds = 0, last_reason = NULL,
         last_trip_job_id = NULL, last_trip_token = NULL`,
    );
    await ensureBreakerRows(pool, ["default", "marketing"]);
    fakeDefault.reset();
    fakeMarketing.reset();
    for (const fake of [fakeDefault, fakeMarketing]) {
      delete fake.behavior.dataDelayMs;
      delete fake.behavior.auth;
    }
    logs.length = 0;
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
  });

  function sender(fake: FakeSmtp) {
    return createSmtpSender({
      host: fake.host,
      port: fake.port,
      tlsMode: "STARTTLS",
      auth: { user: "mailo@example.com", pass: "fake-password" },
      timeouts: {
        connectionMs: 2_000,
        greetingMs: 2_000,
        socketMs: 2_000,
        dnsMs: 2_000,
        totalMs: 5_000,
      },
      trustedCa: fake.ca,
    });
  }

  function accounts(
    over: {
      marketing?: Partial<WorkerAccount>;
      default?: Partial<WorkerAccount>;
    } = {},
  ): Map<string, WorkerAccount> {
    return new Map([
      [
        "default",
        {
          sender: sender(fakeDefault),
          from: "default-from@example.com",
          ...over.default,
        },
      ],
      [
        "marketing",
        {
          sender: sender(fakeMarketing),
          from: "marketing-from@example.com",
          ...over.marketing,
        },
      ],
    ]);
  }

  function startWorker(
    over: Partial<WorkerOptions> = {},
    map: Map<string, WorkerAccount> = accounts(),
    usePool: pg.Pool = pool,
  ): WorkerHandle {
    const worker = createWorker(
      {
        pool: usePool,
        accounts: map,
        bodyCipher: testCipher,
        random: () => 0.5,
        claimRandom: () => 0.5,
        logger: createJsonLogger((line) => logs.push(line)),
      },
      {
        ...defaultWorkerOptions(120),
        retry: { ...defaultRetryPolicy(), jitterRatio: 0 },
        pollMs: 20,
        concurrency: 4,
        sweepIntervalMs: 100,
        cleanupIntervalMs: 100,
        drainTimeoutMs: 500,
        ...over,
      },
    );
    workers.push(worker);
    void worker.start();
    return worker;
  }

  const mailJob = (accountId: string, callerId = "caller-a") =>
    createJob(pool, {
      callerId,
      accountId,
      recipients: { to: ["to1@example.com"], cc: [], bcc: [] },
      // from을 생략한 요청은 작업 계정의 기본 발신 주소로 채워진다(ADR-0013 결정 6).
      envelope: { from: null },
      body: encodeBodyContent({ subject: "제목", text: "본문", html: null }),
    });

  async function counts(accountId: string) {
    const { rows } = await pool.query(
      "SELECT status, count(*)::int AS n FROM mail_jobs WHERE account_id = $1 GROUP BY status",
      [accountId],
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<
      string,
      number
    >;
  }

  async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10_000) {
    const started = Date.now();
    while (!(await fn())) {
      if (Date.now() - started > timeoutMs)
        throw new Error("waitFor 시간 초과");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  describe("계정별 발송", () => {
    it("작업은 자기 계정의 SMTP 서버와 발신 주소로 나간다", async () => {
      for (let i = 0; i < 2; i += 1) await mailJob("default");
      for (let i = 0; i < 3; i += 1) await mailJob("marketing");

      startWorker();

      await waitFor(
        async () =>
          (await counts("default")).SENT === 2 &&
          (await counts("marketing")).SENT === 3,
      );
      expect(fakeDefault.messages).toHaveLength(2);
      expect(fakeMarketing.messages).toHaveLength(3);
      expect(
        fakeDefault.messages.every((m) => m.mailFrom.includes("default-from")),
      ).toBe(true);
      expect(
        fakeMarketing.messages.every((m) =>
          m.mailFrom.includes("marketing-from"),
        ),
      ).toBe(true);
    });
  });

  describe("슬롯 배분 (ADR-0013 결정 3 바)", () => {
    it("한 계정의 SMTP가 응답하지 않아도 다른 계정은 계속 발송하고 그 계정은 cap_a(=3)개까지만 슬롯을 쥔다", async () => {
      // marketing 서버는 본문을 받은 뒤 오래 응답하지 않는다(소켓 타임아웃 2초 전까지 점유 유지).
      fakeMarketing.behavior.dataDelayMs = () => 1_500;
      for (let i = 0; i < 8; i += 1) await mailJob("marketing");
      for (let i = 0; i < 3; i += 1) await mailJob("default");

      startWorker({ concurrency: 4 });

      let maxSending = 0;
      await waitFor(async () => {
        const c = await counts("marketing");
        maxSending = Math.max(maxSending, c.SENDING ?? 0);
        return (await counts("default")).SENT === 3;
      });
      // 슬롯을 모두 쥐었다면 default 작업은 marketing 전송이 끝나는 1.5초 뒤에야 나갔다.
      expect(maxSending).toBe(3);
    });

    it("계정에 concurrency를 주면 그 값이 상한이다(1이면 한 건씩)", async () => {
      fakeMarketing.behavior.dataDelayMs = () => 300;
      for (let i = 0; i < 4; i += 1) await mailJob("marketing");

      startWorker(
        { concurrency: 4 },
        accounts({ marketing: { concurrency: 1 } }),
      );

      let maxSending = 0;
      await waitFor(async () => {
        const c = await counts("marketing");
        maxSending = Math.max(maxSending, c.SENDING ?? 0);
        return c.SENT === 4;
      });
      expect(maxSending).toBe(1);
    });

    it("한 계정에만 작업이 있으면 cap_a까지 쓴다(다른 계정이 비어도 cap_a를 넘지 않는다)", async () => {
      fakeMarketing.behavior.dataDelayMs = () => 400;
      for (let i = 0; i < 8; i += 1) await mailJob("marketing");

      startWorker({ concurrency: 4 });

      let maxSending = 0;
      await waitFor(async () => {
        const c = await counts("marketing");
        maxSending = Math.max(maxSending, c.SENDING ?? 0);
        return c.SENT === 8;
      });
      expect(maxSending).toBe(3);
    });

    it("계정의 concurrency가 전체 동시성보다 크면 Worker를 만들 수 없다(기동 거부)", () => {
      expect(() =>
        createWorker(
          {
            pool,
            accounts: accounts({ marketing: { concurrency: 5 } }),
            bodyCipher: testCipher,
          },
          { ...defaultWorkerOptions(120), concurrency: 4 },
        ),
      ).toThrow("accountConcurrency");
    });

    it("계정 수가 전체 동시성보다 많으면 Worker를 만들 수 없다(기동 거부)", () => {
      expect(() =>
        createWorker(
          {
            pool,
            accounts: accounts(),
            bodyCipher: testCipher,
          },
          { ...defaultWorkerOptions(120), concurrency: 1 },
        ),
      ).toThrow("worker option");
    });
  });

  describe("계정 격리: 차단기 (RQ-054)", () => {
    it("한 계정의 인증 오류로 그 계정의 차단기만 열리고 다른 계정은 계속 발송한다", async () => {
      fakeMarketing.behavior.auth = () => ({
        code: 535,
        text: "5.7.8 Username and Password not accepted",
      });
      for (let i = 0; i < 4; i += 1) await mailJob("marketing");
      for (let i = 0; i < 4; i += 1) await mailJob("default");

      startWorker();

      await waitFor(async () => (await counts("default")).SENT === 4);
      await waitFor(async () => {
        const { rows } = await pool.query(
          "SELECT state FROM mail_circuit_breaker WHERE breaker_key = 'marketing'",
        );
        return rows[0].state === "open";
      });
      const { rows } = await pool.query(
        "SELECT breaker_key, state FROM mail_circuit_breaker ORDER BY breaker_key",
      );
      expect(rows).toEqual([
        { breaker_key: "default", state: "closed" },
        { breaker_key: "marketing", state: "open" },
      ]);
      // 열린 계정의 작업은 시도 횟수에 넣지 않는다(계정 단위 장애).
      expect(fakeMarketing.messages).toHaveLength(0);
      expect(fakeDefault.messages).toHaveLength(4);
    });
  });

  describe("계정 24시간 할당 (RQ-055)", () => {
    it("sendQuota24h를 넘긴 계정은 한도까지만 발송하고 다른 계정은 영향이 없다. 상태가 바뀔 때만 한 번 로그를 남긴다", async () => {
      for (let i = 0; i < 5; i += 1) await mailJob("marketing");
      for (let i = 0; i < 3; i += 1) await mailJob("default");

      startWorker({}, accounts({ marketing: { sendQuota24h: 2 } }));

      await waitFor(
        async () =>
          (await counts("marketing")).SENT === 2 &&
          (await counts("default")).SENT === 3,
      );
      await waitFor(async () =>
        logs.some((l) => l.includes("account_quota_exceeded")),
      );
      await new Promise((r) => setTimeout(r, 300));

      expect(await counts("marketing")).toEqual({ SENT: 2, PENDING: 3 });
      expect(fakeMarketing.messages).toHaveLength(2);
      const exceeded = logs.filter((l) => l.includes("account_quota_exceeded"));
      expect(exceeded).toHaveLength(1);
      expect(exceeded[0]).toContain("marketing");
      expect(exceeded[0]).not.toContain("to1@example.com");
    });

    it("윈도우가 지나면 다시 발송하고 회복을 로그에 남긴다", async () => {
      for (let i = 0; i < 3; i += 1) await mailJob("marketing");
      startWorker({}, accounts({ marketing: { sendQuota24h: 1 } }));
      await waitFor(async () => (await counts("marketing")).SENT === 1);
      await waitFor(async () =>
        logs.some((l) => l.includes("account_quota_exceeded")),
      );

      await pool.query(
        "UPDATE mail_attempts SET finished_at = now() - interval '25 hours'",
      );

      await waitFor(async () => (await counts("marketing")).SENT === 2);
      expect(logs.some((l) => l.includes("account_quota_recovered"))).toBe(
        true,
      );
    });

    it("계정 할당이 있는데 시도 기록 보존이 24시간보다 짧으면 Worker를 만들 수 없다", () => {
      const options = defaultWorkerOptions(120);
      expect(() =>
        createWorker(
          {
            pool,
            accounts: accounts({ marketing: { sendQuota24h: 5 } }),
            bodyCipher: testCipher,
          },
          {
            ...options,
            retention: {
              ...options.retention,
              bodyGraceSeconds: 3600,
              recordSeconds: 7200,
            },
          },
        ),
      ).toThrow("worker option");
    });
  });

  describe("계정 정지 (RQ-043·054)", () => {
    it("정지한 계정만 멈추고 정지·재개를 상태가 바뀔 때 한 번씩 로그에 남긴다", async () => {
      await pool.query(
        "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('account', 'marketing', 'ops')",
      );
      for (let i = 0; i < 2; i += 1) await mailJob("marketing");
      for (let i = 0; i < 2; i += 1) await mailJob("default");

      startWorker();

      await waitFor(async () => (await counts("default")).SENT === 2);
      await new Promise((r) => setTimeout(r, 200));
      expect(await counts("marketing")).toEqual({ PENDING: 2 });

      await pool.query("DELETE FROM mail_send_controls");

      await waitFor(async () => (await counts("marketing")).SENT === 2);
      const paused = logs.filter((l) => l.includes('"event":"send_paused"'));
      const resumed = logs.filter((l) => l.includes('"event":"send_resumed"'));
      expect(paused).toHaveLength(1);
      expect(paused[0]).toContain('"scope":"account"');
      expect(paused[0]).toContain('"accountId":"marketing"');
      expect(resumed).toHaveLength(1);
      // 정지는 차단기와 독립이다.
      const { rows } = await pool.query(
        "SELECT state FROM mail_circuit_breaker WHERE breaker_key = 'marketing'",
      );
      expect(rows[0].state).toBe("closed");
    });
  });

  describe("한 계정의 claim 오류 (ADR-0013 결정 3 바)", () => {
    /** 특정 계정의 차단기 행을 읽는 쿼리만 실패시키는 풀. 다른 쿼리는 그대로 통과한다. */
    function failingFor(accountId: string): {
      pool: pg.Pool;
      hits: () => number;
    } {
      let hits = 0;
      const wrap = (client: pg.PoolClient): pg.PoolClient =>
        new Proxy(client, {
          get(target, prop, receiver) {
            if (prop === "query")
              return (...args: unknown[]) => {
                const text = typeof args[0] === "string" ? args[0] : "";
                const params = (args[1] ?? []) as unknown[];
                if (
                  text.includes(
                    "FROM mail_circuit_breaker WHERE breaker_key",
                  ) &&
                  params[0] === accountId
                ) {
                  hits += 1;
                  return Promise.reject(new Error("breaker read failed"));
                }
                return (target.query as (...a: unknown[]) => unknown)(...args);
              };
            const value = Reflect.get(target, prop, receiver) as unknown;
            return typeof value === "function"
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          },
        });
      const proxy = new Proxy(pool, {
        get(target, prop, receiver) {
          if (prop === "connect")
            return async () => wrap(await target.connect());
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      return { pool: proxy, hits: () => hits };
    }

    it("한 계정의 claim이 계속 실패해도 다른 계정은 발송하고 실패한 계정은 지수 백오프한다", async () => {
      for (let i = 0; i < 3; i += 1) await mailJob("marketing");
      for (let i = 0; i < 3; i += 1) await mailJob("default");
      const failing = failingFor("marketing");

      const worker = startWorker({}, accounts(), failing.pool);

      await waitFor(async () => (await counts("default")).SENT === 3);
      await new Promise((r) => setTimeout(r, 1_200));

      // 실패한 계정은 백오프로 호출 수가 줄어든다. pollMs=20이면 1.3초에 60번 넘게 돌지만 실패 호출은 몇 번뿐이다.
      expect(failing.hits()).toBeGreaterThanOrEqual(2);
      expect(failing.hits()).toBeLessThan(15);
      expect(worker.status().claimFailureStreak).toBeGreaterThanOrEqual(2);
      expect(await counts("marketing")).toEqual({ PENDING: 3 });
      const failed = logs.filter((l) => l.includes('"event":"claim_failed"'));
      expect(failed.length).toBeGreaterThanOrEqual(2);
      expect(failed.every((l) => l.includes('"accountId":"marketing"'))).toBe(
        true,
      );
    });
  });

  describe("poll 라운드의 문장 수 (ADR-0013 결정 3 가·바)", () => {
    it("lease 복구는 라운드마다 한 번이고 계정마다 반복하지 않는다", async () => {
      const counted = countingPool(pool);
      // 정리 루프를 충분히 늦춰 점유 라운드의 문장만 센다.
      startWorker(
        { sweepIntervalMs: 3_600_000, cleanupIntervalMs: 3_600_000 },
        accounts(),
        counted.pool,
      );
      await new Promise((r) => setTimeout(r, 400));

      const statements = counted.statements();
      const breakerReads = statements.filter((s) =>
        s.includes("FROM mail_circuit_breaker"),
      ).length;
      const recoveries = statements.filter((s) =>
        s.includes("lease_until < now()"),
      ).length;
      expect(breakerReads).toBeGreaterThanOrEqual(6);
      // 계정이 둘이므로 차단기 읽기는 라운드당 2번이다. 복구를 계정마다 했다면 복구 수가 차단기 읽기 수와 같다.
      // 정리 루프의 복구 1번과 진행 중이던 라운드의 복구 1번을 더해도 라운드당 한 번이면 차단기 읽기의 절반 + 2 이하다.
      expect(recoveries).toBeLessThanOrEqual(breakerReads / 2 + 2);
      expect(recoveries).toBeGreaterThanOrEqual(2);
    });
  });
});
