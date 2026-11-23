import "reflect-metadata";
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
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp.js";
import { createJob, migrate } from "../support/queue-fixtures.js";
import {
  ACCOUNT_CANARY_VALUES,
  OPS_READ,
  marketingAccount,
  startAccountsApp,
  type AccountsApp,
} from "../support/accounts-app.js";
import {
  findSamples,
  parseMetrics,
  valueOf,
  type ParsedSample,
} from "../support/metrics-text.js";
import {
  ALPHA_KEY,
  BETA_KEY,
  plainMail,
  postJob,
} from "../support/rest-app.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `/metrics`의 계정 라벨과 계정 지표(RQ-062, ADR-0013 결정 5). 실제 PostgreSQL·앱·가짜 SMTP 서버 둘을 쓴다.
 * 계정 `default`(환경 변수)는 호출처 alpha, 파일 계정 `marketing`은 호출처 beta가 쓴다.
 */
describe("e2e: /metrics 계정 라벨·계정 지표 (RQ-062, ADR-0013 결정 5)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let app: AccountsApp | undefined;
  let fakeA: FakeSmtp;
  let fakeB: FakeSmtp;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    await migrate(pool);
    fakeA = await startFakeSmtp();
    fakeB = await startFakeSmtp();
  });

  afterAll(async () => {
    await fakeA.close();
    await fakeB.close();
    await db.close();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM mail_events");
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
    fakeA.reset();
    fakeB.reset();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function scrape(): Promise<{ text: string; samples: ParsedSample[] }> {
    const res = await fetch(`${app!.baseUrl}/metrics`, {
      headers: { Authorization: `Bearer ${OPS_READ}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    return { text, samples: parseMetrics(text) };
  }

  const start = (
    options: Parameters<typeof startAccountsApp>[0] extends infer O
      ? Partial<O>
      : never = {},
  ) =>
    startAccountsApp({
      pool,
      ...options,
    });

  function startWithWorker() {
    return startAccountsApp({
      pool,
      accounts: [marketingAccount({ host: fakeB.host, port: fakeB.port })],
      env: {
        MAILO_SMTP_HOST: fakeA.host,
        MAILO_SMTP_PORT: String(fakeA.port),
        MAILO_WORKER_POLL_MS: "50",
        MAILO_MAINTENANCE_INTERVAL_SECONDS: "1",
      },
      worker: { trustedCa: fakeA.ca },
    });
  }

  async function submit(key: string, auth: string): Promise<string> {
    const res = await postJob(app!, {
      key,
      auth,
      body: plainMail({ from: undefined }),
    });
    expect(res.status).toBe(202);
    return ((await res.json()) as { jobId: string }).jobId;
  }

  async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10_000) {
    const started = Date.now();
    while (!(await fn())) {
      if (Date.now() - started > timeoutMs)
        throw new Error("waitFor 시간 초과");
      await sleep(25);
    }
  }

  it("큐 건수가 계정별로 나뉜다(due·scheduled·sending, 등급별 가장 오래된 대기, 잘림)", async () => {
    app = await start();
    await submit("q-b1", BETA_KEY);
    await submit("q-b2", BETA_KEY);
    await submit("q-a1", ALPHA_KEY);
    await pool.query(
      "UPDATE mail_jobs SET next_attempt_at = now() - interval '120 seconds' WHERE account_id = 'marketing'",
    );
    const future = await createJob(pool, {
      callerId: "beta",
      accountId: "marketing",
    });
    await pool.query(
      "UPDATE mail_jobs SET status = 'RETRY_WAIT', next_attempt_at = now() + interval '1 hour' WHERE id = $1",
      [future],
    );

    const { samples } = await scrape();

    expect(
      valueOf(samples, "mailo_queue_jobs", {
        account_id: "marketing",
        state: "due",
      }),
    ).toBe(2);
    expect(
      valueOf(samples, "mailo_queue_jobs", {
        account_id: "marketing",
        state: "scheduled",
      }),
    ).toBe(1);
    expect(
      valueOf(samples, "mailo_queue_jobs", {
        account_id: "default",
        state: "due",
      }),
    ).toBe(1);
    expect(
      valueOf(samples, "mailo_queue_jobs", {
        account_id: "default",
        state: "scheduled",
      }),
    ).toBe(0);
    expect(
      valueOf(samples, "mailo_queue_oldest_due_age_seconds", {
        account_id: "marketing",
        priority: "normal",
      })!,
    ).toBeGreaterThanOrEqual(120);
    expect(
      valueOf(samples, "mailo_queue_jobs_truncated", {
        account_id: "marketing",
        state: "due",
      }),
    ).toBe(0);
  });

  it("차단기 상태와 사유가 계정별이다. 한 계정이 open이어도 다른 계정은 closed다", async () => {
    app = await start();
    await pool.query(
      `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() + interval '10 minutes',
         wait_seconds = 600, last_reason = 'AUTH' WHERE breaker_key = 'marketing'`,
    );

    const { samples } = await scrape();

    const state = (account: string, s: string) =>
      valueOf(samples, "mailo_breaker_state", {
        account_id: account,
        state: s,
      });
    expect(state("marketing", "open")).toBe(1);
    expect(state("marketing", "closed")).toBe(0);
    expect(state("default", "closed")).toBe(1);
    expect(state("default", "open")).toBe(0);
    expect(
      findSamples(samples, "mailo_breaker_reason_info").map((s) => s.labels),
    ).toEqual([{ account_id: "marketing", reason: "AUTH_FAILED" }]);
  });

  it("계정 정지 게이지가 구성한 계정마다 나오고 정지 수는 구성 밖 계정도 센다", async () => {
    app = await start();
    await pool.query(
      `INSERT INTO mail_send_controls (scope_type, scope_id, paused_by)
       VALUES ('account', 'marketing', 'oncall'), ('account', 'retired', 'oncall')`,
    );

    const { samples } = await scrape();

    expect(
      valueOf(samples, "mailo_account_paused", { account_id: "marketing" }),
    ).toBe(1);
    expect(
      valueOf(samples, "mailo_account_paused", { account_id: "default" }),
    ).toBe(0);
    expect(findSamples(samples, "mailo_account_paused")).toHaveLength(2);
    expect(valueOf(samples, "mailo_send_paused_accounts")).toBe(2);
    // 구성 밖 계정 ID를 라벨 값으로 만들지 않는다.
    expect(JSON.stringify(samples)).not.toContain("retired");
  });

  it("계정 할당 게이지는 한도를 설정한 계정만 낸다. 사용량은 최근 시도와 점유 중 수다", async () => {
    app = await start();
    const jobId = await createJob(pool, {
      callerId: "beta",
      accountId: "marketing",
    });
    await pool.query(
      `INSERT INTO mail_attempts (job_id, caller_id, account_id, classification, counted, stage, started_at, finished_at)
       VALUES ($1, 'beta', 'marketing', 'TRANSIENT', true, 'DATA', now() - interval '1 hour', now() - interval '1 hour')`,
      [jobId],
    );

    const { samples } = await scrape();

    expect(
      valueOf(samples, "mailo_account_quota_limit", {
        account_id: "marketing",
      }),
    ).toBe(5);
    expect(
      valueOf(samples, "mailo_account_quota_used", { account_id: "marketing" }),
    ).toBe(1);
    expect(findSamples(samples, "mailo_account_quota_limit")).toHaveLength(1);
    expect(findSamples(samples, "mailo_account_quota_used")).toHaveLength(1);
  });

  it("시작할 때 counter 시드는 (호출처, 그 호출처의 계정) 쌍이다", async () => {
    app = await start();

    const { samples } = await scrape();

    const pairs = (name: string) =>
      [
        ...new Set(
          findSamples(samples, name).map(
            (s) => `${s.labels["caller_id"]}/${s.labels["account_id"]}`,
          ),
        ),
      ].sort();
    expect(pairs("mailo_attempts_total")).toEqual([
      "alpha/default",
      "beta/marketing",
    ]);
    expect(pairs("mailo_claimed_jobs_total")).toEqual([
      "alpha/default",
      "beta/marketing",
    ]);
    expect(
      findSamples(samples, "mailo_lease_recovered_total").map(
        (s) => s.labels["account_id"],
      ),
    ).toEqual(["default", "marketing"]);
  });

  it("실제 발송: 시도·점유·종결 counter가 작업의 계정으로 센다. Worker가 계정별 진행 중 시리즈를 낸다", async () => {
    app = await startWithWorker();
    const alpha = await submit("w-alpha", ALPHA_KEY);
    const beta = await submit("w-beta", BETA_KEY);
    await waitFor(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM mail_jobs WHERE status = 'SENT'",
          )
        ).rows[0].n === 2,
    );
    expect([alpha, beta]).toHaveLength(2);
    expect(fakeA.messages).toHaveLength(1);
    expect(fakeB.messages).toHaveLength(1);

    const { samples } = await scrape();

    const attempts = (caller: string, account: string) =>
      valueOf(samples, "mailo_attempts_total", {
        caller_id: caller,
        account_id: account,
        result: "sent",
      });
    expect(attempts("alpha", "default")).toBe(1);
    expect(attempts("beta", "marketing")).toBe(1);
    expect(attempts("alpha", "marketing")).toBeUndefined();
    expect(
      valueOf(samples, "mailo_claimed_jobs_total", {
        caller_id: "beta",
        account_id: "marketing",
      }),
    ).toBe(1);
    expect(
      valueOf(samples, "mailo_jobs_finished_total", {
        caller_id: "beta",
        account_id: "marketing",
        status: "sent",
      }),
    ).toBe(1);
    expect(
      findSamples(samples, "mailo_worker_in_flight").map((s) => [
        s.labels["account_id"],
        s.value,
      ]),
    ).toEqual([
      ["default", 0],
      ["marketing", 0],
    ]);
  });

  it("구성에서 빠진 계정의 작업이 만료 sweep으로 종결되면 account_id가 unregistered다. 라벨 값은 닫힌 집합이다", async () => {
    app = await startWithWorker();
    const orphan = await createJob(pool, {
      callerId: "beta",
      accountId: "retired",
    });
    await pool.query(
      "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = $1",
      [orphan],
    );
    await waitFor(
      async () =>
        (
          await pool.query("SELECT status FROM mail_jobs WHERE id = $1", [
            orphan,
          ])
        ).rows[0].status === "EXPIRED",
    );

    const { samples, text } = await scrape();

    expect(
      valueOf(samples, "mailo_jobs_finished_total", {
        caller_id: "beta",
        account_id: "unregistered",
        status: "expired",
      }),
    ).toBe(1);
    const values = new Set(
      samples.flatMap((s) =>
        s.labels["account_id"] === undefined ? [] : [s.labels["account_id"]],
      ),
    );
    expect([...values].sort()).toEqual([
      "default",
      "marketing",
      "unregistered",
    ]);
    expect(text).not.toContain("retired");
  });

  it("응답에 계정 host·user·from·비밀번호·비밀 변수 이름이 없다 (RQ-027)", async () => {
    app = await startWithWorker();
    await submit("c-beta", BETA_KEY);
    await waitFor(async () => fakeB.messages.length === 1);

    const { text } = await scrape();

    for (const value of [...ACCOUNT_CANARY_VALUES, "MAILO_SMTP_SECRET"]) {
      expect(text).not.toContain(value);
      expect(app!.logs.lines.join("\n")).not.toContain(value);
    }
  });
});
