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
import { defaultRetryPolicy } from "../../src/queue/index.js";
import { createSmtpSender } from "../../src/smtp/index.js";
import {
  createJsonLogger,
  createWorker,
  defaultWorkerOptions,
  encodeBodyContent,
  type WorkerHandle,
  type WorkerOptions,
} from "../../src/worker/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp.js";
import { createJob, migrate, testCipher } from "../support/queue-fixtures.js";

/** Worker가 호출처별 발송 할당(RQ-032, ADR-0007 결정 10)을 지키는지 확인한다. 로컬 SMTP 서버를 쓴다. */
describe("PostgreSQL + SMTP 통합: Worker 호출처별 발송 할당(RQ-032)", () => {
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

  it("할당을 넘긴 호출처는 한도까지만 발송하고 나머지는 대기하며 다른 호출처는 모두 발송한다", async () => {
    for (let i = 0; i < 5; i += 1) await mailJob("caller-a");
    for (let i = 0; i < 4; i += 1) await mailJob("caller-b");

    startWorker({ callerQuotas: new Map([["caller-a", 2]]) });

    await waitFor(async () => (await statusCounts("caller-b")).SENT === 4);
    await waitFor(async () => (await statusCounts("caller-a")).SENT === 2);
    // 폴링을 몇 번 더 돌려도 한도를 넘어 발송하지 않는다.
    await new Promise((r) => setTimeout(r, 300));

    expect(await statusCounts("caller-a")).toEqual({ SENT: 2, PENDING: 3 });
    expect(fake.messages).toHaveLength(6);
    const { rows } = await pool.query(
      "SELECT max(attempts)::int AS m FROM mail_jobs WHERE caller_id = 'caller-a' AND status = 'PENDING'",
    );
    expect(rows[0].m).toBe(0);

    // 초과 상태는 바뀔 때만 한 번 로그에 남는다. 호출처 ID와 한도만 담는다.
    const exceeded = logs.filter((l) => l.includes("caller_quota_exceeded"));
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]).toContain("caller-a");
    expect(exceeded[0]).not.toContain("to1@example.com");
  });

  it("윈도우가 지나면 다시 발송하고 회복을 로그에 남긴다", async () => {
    for (let i = 0; i < 3; i += 1) await mailJob("caller-a");
    startWorker({ callerQuotas: new Map([["caller-a", 1]]) });
    await waitFor(async () => (await statusCounts("caller-a")).SENT === 1);
    await waitFor(async () =>
      logs.some((l) => l.includes("caller_quota_exceeded")),
    );

    await pool.query(
      "UPDATE mail_attempts SET finished_at = now() - interval '25 hours'",
    );

    await waitFor(async () => (await statusCounts("caller-a")).SENT === 2);
    expect(logs.some((l) => l.includes("caller_quota_recovered"))).toBe(true);
  });

  it("할당을 설정하지 않으면 모든 작업을 발송한다(무제한 기본값)", async () => {
    for (let i = 0; i < 6; i += 1) await mailJob("caller-a");
    startWorker({});
    await waitFor(async () => (await statusCounts("caller-a")).SENT === 6);
    expect(logs.some((l) => l.includes("caller_quota"))).toBe(false);
  });
});
