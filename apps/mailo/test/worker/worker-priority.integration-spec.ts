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
import { defaultRetryPolicy, type Priority } from "../../src/queue/index.js";
import type {
  MailSender,
  SmtpMessage,
  SmtpSendResult,
} from "../../src/smtp/index.js";
import {
  createWorker,
  defaultWorkerOptions,
  encodeBodyContent,
  type WorkerHandle,
  type WorkerOptions,
} from "../../src/worker/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { createJob, migrate, testCipher } from "../support/queue-fixtures.js";

/**
 * Worker의 점유 경로 선택(RQ-035, ADR-0009). 실제 PostgreSQL과 메모리 발송기를 쓴다.
 * 경로 난수(`claimRandom`)를 주입해 claim 호출마다 어느 경로를 탔는지 발송 순서로 확인한다.
 * 동시 전송 1이라 claim은 슬롯이 빌 때만 불린다. 그래서 난수 한 개가 claim 한 번에 대응한다.
 */
describe("PostgreSQL 통합: Worker 점유 경로 선택 (RQ-035, ADR-0009)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  const workers: WorkerHandle[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    await migrate(pool);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM mail_jobs");
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
  });

  const sent: SmtpMessage[] = [];
  const instantSender: MailSender = {
    async send(message): Promise<SmtpSendResult> {
      sent.push(message);
      return { kind: "SENT", rejectedRecipients: [] };
    },
  };

  /** 정한 값들을 차례로 돌려주고 다 쓰면 `rest`를 돌려준다. */
  function sequence(values: number[], rest: number): () => number {
    const queue = [...values];
    return () => queue.shift() ?? rest;
  }

  function startWorker(
    over: Partial<WorkerOptions>,
    claimRandom: () => number,
    sender: MailSender = instantSender,
  ): WorkerHandle {
    const worker = createWorker(
      {
        pool,
        sender,
        bodyCipher: testCipher,
        defaultFrom: "default-from@example.com",
        random: () => 0.5,
        claimRandom,
      },
      {
        ...defaultWorkerOptions(120),
        retry: { ...defaultRetryPolicy(), jitterRatio: 0 },
        pollMs: 20,
        concurrency: 1,
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

  async function job(priority: Priority, waited: number): Promise<string> {
    const id = await createJob(pool, {
      priority,
      recipients: { to: ["to1@example.com"], cc: [], bcc: [] },
      envelope: { from: "mailo@example.com" },
      body: encodeBodyContent({ subject: "제목", text: "본문", html: null }),
    });
    await pool.query(
      "UPDATE mail_jobs SET next_attempt_at = now() - make_interval(secs => $2) WHERE id = $1",
      [id, waited],
    );
    return id;
  }

  async function waitFor<T>(
    fn: () => Promise<T | undefined | false | null> | T | undefined | false,
    timeoutMs = 10_000,
  ): Promise<T> {
    const started = Date.now();
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() - started > timeoutMs)
        throw new Error("waitFor 시간 초과");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function status(id: string): Promise<string> {
    const { rows } = await pool.query(
      "SELECT status FROM mail_jobs WHERE id = $1",
      [id],
    );
    return rows[0].status;
  }

  async function threeJobs() {
    return {
      low: await job("LOW", 600),
      normal: await job("NORMAL", 300),
      urgent: await job("URGENT", 0),
    };
  }

  beforeEach(() => {
    sent.length = 0;
  });

  it("주입한 난수가 비율보다 작으면 대기 순서 경로, 아니면 우선순위 경로로 점유한다", async () => {
    const { low, normal, urgent } = await threeJobs();
    // 0.5 → 우선순위, 0.05 → 대기 순서(비율 0.1), 그 뒤는 0.5 → 우선순위
    startWorker({ claimFifoRatio: 0.1 }, sequence([0.5, 0.05], 0.5));

    await waitFor(() => sent.length === 3);
    expect(sent.map((m) => m.jobId)).toEqual([urgent, low, normal]);
  });

  it("비율 0이면 난수가 0이어도 항상 우선순위 경로다", async () => {
    const { low, normal, urgent } = await threeJobs();
    startWorker({ claimFifoRatio: 0 }, () => 0);

    await waitFor(() => sent.length === 3);
    expect(sent.map((m) => m.jobId)).toEqual([urgent, normal, low]);
  });

  it("비율 1이면 항상 대기 순서 경로다", async () => {
    const { low, normal, urgent } = await threeJobs();
    startWorker({ claimFifoRatio: 1 }, () => 0.999);

    await waitFor(() => sent.length === 3);
    expect(sent.map((m) => m.jobId)).toEqual([low, normal, urgent]);
  });

  it("모든 슬롯이 사용 중이면 URGENT는 기다리고, 진행 중 전송을 끊지 않은 채 슬롯이 비면 다음 점유에서 고른다", async () => {
    const releases: Array<() => void> = [];
    const order: string[] = [];
    const gated: MailSender = {
      send(message) {
        order.push(message.jobId);
        return new Promise<SmtpSendResult>((resolve) =>
          releases.push(() =>
            resolve({ kind: "SENT", rejectedRecipients: [] }),
          ),
        );
      },
    };
    const first = await job("NORMAL", 10);
    const worker = startWorker({ claimFifoRatio: 0 }, () => 0.5, gated);
    await waitFor(() => releases.length === 1);

    const low = await job("LOW", 900);
    const urgent = await job("URGENT", 0);
    // 점유 루프가 몇 바퀴 더 돌아도 슬롯이 없으면 점유하지 않는다.
    const seen = new Set<number>();
    await waitFor(() => {
      const at = worker.status().lastPollAt;
      if (at) seen.add(at.getTime());
      return seen.size >= 3;
    });
    expect(await status(urgent)).toBe("PENDING");
    expect(await status(first)).toBe("SENDING");

    releases.shift()!();
    await waitFor(async () => (await status(first)) === "SENT");
    await waitFor(() => releases.length === 1);
    expect(order).toEqual([first, urgent]);
    releases.shift()!();
    await waitFor(() => releases.length === 1);
    expect(order).toEqual([first, urgent, low]);
    releases.shift()!();
  });
});
