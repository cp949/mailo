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
import type { MailSender, SmtpSendResult } from "../../src/smtp/index.js";
import {
  createJsonLogger,
  createWorker,
  defaultWorkerOptions,
  encodeBodyContent,
  systemClock,
  type Clock,
  type WorkerHandle,
  type WorkerOptions,
} from "../../src/worker/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { createJob, migrate, testCipher } from "../support/queue-fixtures.js";

/**
 * Worker의 DB 장애 대응(H1·M1·H2). 실제 PostgreSQL을 쓰고, 장애는 풀을 감싸 주입한다.
 * 근거: ADR-0002 결정 6·12, RQ-013·025.
 */
describe("PostgreSQL 통합: Worker DB 장애 대응", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  const logs: string[] = [];
  const workers: WorkerHandle[] = [];

  const sent: SmtpSendResult = { kind: "SENT", rejectedRecipients: [] };
  const okSender: MailSender = { send: async () => sent };

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
    logs.length = 0;
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
  });

  function options(over: Partial<WorkerOptions> = {}): WorkerOptions {
    return {
      ...defaultWorkerOptions(120),
      retry: { ...defaultRetryPolicy(), jitterRatio: 0 },
      pollMs: 20,
      concurrency: 1,
      sweepIntervalMs: 60_000,
      cleanupIntervalMs: 60_000,
      drainTimeoutMs: 400,
      ...over,
    };
  }

  function make(
    target: pg.Pool,
    over: Partial<WorkerOptions> = {},
    extra: {
      clock?: Clock;
      random?: () => number;
      onFatal?: () => void;
    } = {},
  ): WorkerHandle {
    const worker = createWorker(
      {
        pool: target,
        sender: okSender,
        bodyCipher: testCipher,
        defaultFrom: "default-from@example.com",
        random: extra.random ?? (() => 0.5),
        logger: createJsonLogger((line) => logs.push(line)),
        ...(extra.clock && { clock: extra.clock }),
        ...(extra.onFatal && { onFatal: extra.onFatal }),
      },
      options(over),
    );
    workers.push(worker);
    return worker;
  }

  async function mailJob(): Promise<string> {
    return createJob(pool, {
      recipients: { to: ["to1@example.com"], cc: [], bcc: [] },
      envelope: { from: "mailo@example.com" },
      body: encodeBodyContent({ subject: "제목", text: "본문", html: null }),
    });
  }

  async function waitFor<T>(
    fn: () => Promise<T | undefined | false | null>,
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
    return rows[0].status as string;
  }

  /**
   * 결과 기록(`completeAttempt`)의 작업 행 잠금 쿼리만 `failures`번 실패시키는 풀.
   * 점유(`claim`)와 다른 쿼리는 그대로 지나간다.
   */
  function flakyCompletePool(state: { failures: number }): pg.Pool {
    const wrapClient = (client: pg.PoolClient): pg.PoolClient =>
      new Proxy(client, {
        get(target, prop) {
          if (prop === "query") {
            return (text: unknown, ...rest: unknown[]) => {
              if (
                typeof text === "string" &&
                text.includes("status = 'SENDING' AND lease_token = $2") &&
                state.failures > 0
              ) {
                state.failures -= 1;
                return Promise.reject(new Error("injected db failure"));
              }
              return (target.query as (...args: unknown[]) => Promise<unknown>)(
                text,
                ...rest,
              );
            };
          }
          const value = (target as unknown as Record<string | symbol, unknown>)[
            prop
          ];
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    return new Proxy(pool, {
      get(target, prop) {
        if (prop === "connect")
          return async () => wrapClient(await target.connect());
        const value = (target as unknown as Record<string | symbol, unknown>)[
          prop
        ];
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  // --- H1: 응답 없는 DB에서 종료 ---------------------------------------------

  it("DB가 응답하지 않아 점유 호출이 멈춰도 pause와 stop은 drain 상한 안에 끝난다 (H1, ADR-0002 결정 12)", async () => {
    const never = new Promise<never>(() => undefined);
    const hung = {
      connect: () => never,
      query: () => never,
    } as unknown as pg.Pool;
    const worker = make(hung, { drainTimeoutMs: 300 });
    await worker.start();
    await new Promise((r) => setTimeout(r, 50)); // 점유 호출이 멈춘 상태가 되게 한다.

    const started = Date.now();
    await worker.pause();
    const pausedIn = Date.now() - started;
    await worker.stop();
    const stoppedIn = Date.now() - started;

    expect(pausedIn).toBeGreaterThanOrEqual(250);
    expect(pausedIn).toBeLessThan(1_500);
    expect(stoppedIn).toBeLessThan(1_500);
    expect(logs.some((l) => l.includes('"event":"pause_timeout"'))).toBe(true);
    expect(logs.some((l) => l.includes('"event":"drain_timeout"'))).toBe(true);
    expect(worker.status().state).toBe("stopped");
  });

  // --- M1: 결과 기록 재시도 ---------------------------------------------------

  it("결과 기록이 여러 번 실패해도(3회 초과) lease 안에서 재시도해 SENT로 기록한다 (M1, RQ-013)", async () => {
    const id = await mailJob();
    const state = { failures: 6 };
    // 대기 시간만 줄인다. 재시도 횟수와 마감 판정은 실제 로직 그대로다.
    const fastClock: Clock = {
      now: () => systemClock.now(),
      sleep: (ms, signal) => systemClock.sleep(Math.min(ms, 10), signal),
    };
    const worker = make(flakyCompletePool(state), {}, { clock: fastClock });
    await worker.start();

    await waitFor(async () => (await status(id)) === "SENT");

    expect(state.failures).toBe(0);
    const failedLogs = logs.filter((l) =>
      l.includes('"event":"complete_failed"'),
    );
    expect(failedLogs).toHaveLength(6);
    expect(failedLogs.every((l) => l.includes('"retry":true'))).toBe(true);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM mail_attempts WHERE job_id = $1",
      [id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("기록이 계속 실패하면 lease 마감(lease - 10초, 단조 시계)에서 포기하고 lease 복구에 맡긴다 (M1)", async () => {
    const id = await mailJob();
    const state = { failures: Number.MAX_SAFE_INTEGER };
    // 가상 시계: sleep이 시간을 앞으로 보낸다. 실제 대기 없이 lease 마감에 닿는다.
    let virtualNow = 0;
    const delays: number[] = [];
    const virtualClock: Clock = {
      now: () => virtualNow,
      sleep: async (ms, signal) => {
        // 주기 작업(sweep 60초)은 실제 시계로 기다린다. 가상 시간을 앞으로 보내면 마감이 즉시 지난다.
        if (ms >= 10_000) return systemClock.sleep(ms, signal);
        await new Promise((r) => setImmediate(r));
        if (signal?.aborted) return;
        // 점유 루프의 폴링 대기(20ms)는 시간을 보내지 않는다. 결과 기록 재시도 대기만 마감을 향해 시간을 보낸다.
        if (ms < 100) return;
        virtualNow += ms;
        delays.push(ms);
      },
    };
    const worker = make(
      flakyCompletePool(state),
      { leaseSeconds: 20, drainTimeoutMs: 500 },
      { clock: virtualClock },
    );
    await worker.start();

    await waitFor(async () =>
      logs.some(
        (l) =>
          l.includes('"event":"complete_failed"') &&
          l.includes('"retry":false'),
      ),
    );

    const failed = logs.filter((l) => l.includes('"event":"complete_failed"'));
    expect(failed.length).toBeGreaterThan(3);
    // 마지막만 포기이고 앞은 모두 재시도다.
    expect(failed.slice(0, -1).every((l) => l.includes('"retry":true'))).toBe(
      true,
    );
    expect(failed.at(-1)).toContain('"retry":false');
    // 간격은 5초 상한을 넘지 않는다.
    expect(Math.max(...delays)).toBeLessThanOrEqual(6_000);
    // 포기한 작업은 SENDING에 남는다. lease 만료 뒤 복구가 다룬다.
    expect(await status(id)).toBe("SENDING");
  });

  // --- H2: 상태와 치명 오류 -----------------------------------------------------

  it("status()는 점유 루프가 한 바퀴 돌 때마다 lastPollAt을 갱신하고(큐가 비어 있어도) 상태 전이를 반영한다 (H2)", async () => {
    const worker = make(pool);
    expect(worker.status()).toMatchObject({
      state: "idle",
      lastPollAt: null,
      lastPollAgeSeconds: null,
      pollLoopCrashed: false,
    });

    await worker.start();
    await waitFor(async () => worker.status().lastPollAt !== null);
    const first = worker.status().lastPollAt!.getTime();
    await waitFor(async () => worker.status().lastPollAt!.getTime() > first);

    expect(worker.status()).toMatchObject({
      state: "running",
      inFlight: 0,
      claimFailureStreak: 0,
      pollLoopCrashed: false,
    });
    expect(worker.status().lastPollAgeSeconds).toBeLessThanOrEqual(1);
    await worker.pause();
    expect(worker.status().state).toBe("paused");
  });

  it("점유가 계속 실패하면 claimFailureStreak가 올라간다 (H2)", async () => {
    const broken = {
      connect: () => Promise.reject(new Error("db down")),
      query: () => Promise.reject(new Error("db down")),
    } as unknown as pg.Pool;
    const worker = make(broken, { pollMs: 20 });
    await worker.start();

    await waitFor(async () => worker.status().claimFailureStreak >= 2);

    expect(logs.some((l) => l.includes('"event":"claim_failed"'))).toBe(true);
    expect(worker.status().pollLoopCrashed).toBe(false);
  });

  it("점유 루프가 예상 못한 예외로 끝나면 onFatal을 한 번 부르고 status에 표시한다. 정상 stop은 그대로 끝난다 (H2)", async () => {
    let fatal = 0;
    const worker = make(
      pool,
      {},
      {
        random: () => {
          throw new Error("unexpected");
        },
        onFatal: () => {
          fatal += 1;
        },
      },
    );
    await worker.start();

    await waitFor(async () => fatal > 0);
    await worker.stop();

    expect(fatal).toBe(1);
    expect(worker.status().pollLoopCrashed).toBe(true);
    expect(logs.some((l) => l.includes('"event":"poll_loop_crashed"'))).toBe(
      true,
    );
  });
});
