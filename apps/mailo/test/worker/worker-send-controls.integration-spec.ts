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
  clearPause,
  defaultRetryPolicy,
  setPause,
} from "../../src/queue/index.js";
import { createSmtpSender } from "../../src/smtp/index.js";
import {
  createWorker,
  defaultWorkerOptions,
  encodeBodyContent,
  type WorkerHandle,
  type WorkerOptions,
} from "../../src/worker/index.js";
import { createJsonLogger } from "../../src/logging/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp.js";
import { createJob, migrate, testCipher } from "../support/queue-fixtures.js";

/**
 * Worker가 발송 정지(RQ-043, ADR-0011 결정 2)를 지키고 상태가 바뀔 때만 로그를 남기는지 확인한다.
 * 실제 PostgreSQL과 로컬 SMTP 서버를 쓴다. 정지 상태는 DB 행이므로 Worker 옵션과 무관하게 즉시 반영된다.
 */
describe("PostgreSQL + SMTP 통합: Worker 발송 정지(RQ-043)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let fake: FakeSmtp;
  const logs: string[] = [];
  const workers: WorkerHandle[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    await migrate(pool);
    fake = await startFakeSmtp();
  });

  afterAll(async () => {
    await fake.close();
    await db.close();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM mail_jobs");
    await pool.query("DELETE FROM mail_send_controls");
    fake.reset();
    logs.length = 0;
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
  });

  function startWorker(over: Partial<WorkerOptions>): WorkerHandle {
    const timeouts = {
      connectionMs: 2_000,
      greetingMs: 2_000,
      socketMs: 2_000,
      dnsMs: 2_000,
      totalMs: 5_000,
    };
    const worker = createWorker(
      {
        pool,
        sender: createSmtpSender({
          host: fake.host,
          port: fake.port,
          tlsMode: "STARTTLS",
          auth: { user: "mailo@example.com", pass: "fake-password" },
          timeouts,
          trustedCa: fake.ca,
        }),
        bodyCipher: testCipher,
        defaultFrom: "default-from@example.com",
        random: () => 0.5,
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

  const mailJob = (callerId: string) =>
    createJob(pool, {
      callerId,
      recipients: { to: ["to1@example.com"], cc: [], bcc: [] },
      envelope: { from: "mailo@example.com" },
      body: encodeBodyContent({ subject: "제목", text: "본문", html: null }),
    });

  async function statusCounts(callerId: string) {
    const { rows } = await pool.query(
      "SELECT status, count(*)::int AS n FROM mail_jobs WHERE caller_id = $1 GROUP BY status",
      [callerId],
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

  const events = (name: string) =>
    logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l["event"] === name);

  it("전체 정지 중에는 발송하지 않고 send_paused를 한 번만 남기며, 해제하면 발송하고 send_resumed를 한 번 남긴다", async () => {
    await setPause(pool, { type: "all" }, "oncall");
    for (let i = 0; i < 3; i += 1) await mailJob("caller-a");

    startWorker({});
    await waitFor(async () => events("send_paused").length === 1);
    // 폴링(20ms)을 여러 번 돌려도 발송하지 않고 로그를 반복하지 않는다.
    await new Promise((r) => setTimeout(r, 300));

    expect(fake.messages).toHaveLength(0);
    expect(await statusCounts("caller-a")).toEqual({ PENDING: 3 });
    expect(events("send_paused")).toHaveLength(1);
    expect(events("send_paused")[0]).toMatchObject({
      level: "warn",
      scope: "all",
    });
    expect(events("send_resumed")).toHaveLength(0);

    await clearPause(pool, { type: "all" });
    await waitFor(async () => (await statusCounts("caller-a")).SENT === 3);

    expect(events("send_resumed")).toHaveLength(1);
    expect(events("send_resumed")[0]).toMatchObject({
      level: "info",
      scope: "all",
    });
  });

  it("호출처 정지는 그 호출처만 멈추고 호출처 ID를 로그에 남긴다. 다른 호출처는 계속 발송한다", async () => {
    await setPause(pool, { type: "caller", id: "caller-a" }, "oncall");
    for (let i = 0; i < 2; i += 1) await mailJob("caller-a");
    for (let i = 0; i < 2; i += 1) await mailJob("caller-b");

    startWorker({});
    await waitFor(async () => (await statusCounts("caller-b")).SENT === 2);
    await new Promise((r) => setTimeout(r, 200));

    expect(await statusCounts("caller-a")).toEqual({ PENDING: 2 });
    expect(events("send_paused")).toHaveLength(1);
    expect(events("send_paused")[0]).toMatchObject({
      scope: "caller",
      callerId: "caller-a",
    });

    await clearPause(pool, { type: "caller", id: "caller-a" });
    await waitFor(async () => (await statusCounts("caller-a")).SENT === 2);
    expect(events("send_resumed")).toHaveLength(1);
    expect(events("send_resumed")[0]).toMatchObject({
      scope: "caller",
      callerId: "caller-a",
    });
  });
});
