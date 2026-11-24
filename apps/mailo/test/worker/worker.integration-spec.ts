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
  getBreakerState,
  type RegisterInput,
} from "../../src/queue/index.js";
import {
  DEFAULT_SMTP_TIMEOUTS,
  SmtpAbortedError,
  checkSmtpTimeouts,
  createSmtpSender,
  type MailSender,
  type SmtpMessage,
  type SmtpSendResult,
  type SmtpSenderConfig,
} from "../../src/smtp/index.js";
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
import {
  createJob,
  migrate,
  pastDue,
  testCipher,
} from "../support/queue-fixtures.js";

/**
 * Worker 통합 테스트. 실제 PostgreSQL과 로컬 smtp-server(실제 nodemailer)를 쓴다.
 * 근거: ADR-0002 결정 4~12, ADR-0007 결정 5·7, RQ-009·010·013·016·025.
 */

const SENDER_ADDRESS = "mailo@example.com";
const DEFAULT_FROM = "default-from@example.com";
const PASSWORD_CANARY = "CANARY-SMTP-PASSWORD-7f3a";
const BODY_CANARY = "CANARY-BODY-5c1e";

describe("PostgreSQL + SMTP 통합: Worker", () => {
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
    await pool.query(
      `UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL,
         probe_job_id = NULL, consecutive_failures = 0, wait_seconds = 0, last_reason = NULL,
         last_trip_job_id = NULL, last_trip_token = NULL`,
    );
    fake.reset();
    logs.length = 0;
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
  });

  // --- 도우미 ---------------------------------------------------------------

  const timeouts = {
    connectionMs: 2_000,
    greetingMs: 2_000,
    socketMs: 2_000,
    dnsMs: 2_000,
    totalMs: 5_000,
  };

  function smtpConfig(over: Partial<SmtpSenderConfig> = {}): SmtpSenderConfig {
    return {
      host: fake.host,
      port: fake.port,
      tlsMode: "STARTTLS",
      auth: { user: SENDER_ADDRESS, pass: PASSWORD_CANARY },
      timeouts,
      trustedCa: fake.ca,
      ...over,
    };
  }

  function options(over: Partial<WorkerOptions> = {}): WorkerOptions {
    return {
      ...defaultWorkerOptions(120),
      retry: { ...defaultRetryPolicy(), jitterRatio: 0 },
      pollMs: 20,
      concurrency: 2,
      sweepIntervalMs: 100,
      cleanupIntervalMs: 100,
      drainTimeoutMs: 500,
      ...over,
    };
  }

  function startWorker(
    over: Partial<WorkerOptions> = {},
    sender?: MailSender,
  ): WorkerHandle {
    const worker = createWorker(
      {
        pool,
        sender: sender ?? createSmtpSender(smtpConfig()),
        bodyCipher: testCipher,
        defaultFrom: DEFAULT_FROM,
        random: () => 0.5,
        // 로그의 instance와 시도 기록의 instance가 같은 값이다.
        instance: "mailo-test-1",
        logger: createJsonLogger((line) => logs.push(line), {
          instance: "mailo-test-1",
        }),
      },
      options(over),
    );
    workers.push(worker);
    void worker.start();
    return worker;
  }

  async function mailJob(
    over: Partial<RegisterInput> & {
      subject?: string;
      text?: string;
      html?: string | null;
    } = {},
  ) {
    const { subject, text, html, ...rest } = over;
    return createJob(pool, {
      recipients: { to: ["to1@example.com"], cc: [], bcc: [] },
      envelope: { from: SENDER_ADDRESS },
      body: encodeBodyContent({
        subject: subject ?? "제목",
        text: text ?? "본문",
        html: html ?? null,
      }),
      ...rest,
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

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * 점유 루프가 지금부터 한 바퀴 이상 온전히 돌 때까지 기다린다("점유하지 않았다"를 고정 sleep 없이 단언하려는 용도).
   * `lastPollAt`은 바퀴가 시작되는 시각이다. 서로 다른 값이 세 번 관찰되면(처음 값은 이미 진행 중인 바퀴일 수 있다)
   * 이 호출 뒤에 시작한 바퀴가 끝까지 돌아 점유를 시도했다는 뜻이다.
   */
  async function afterFullPollRounds(worker: WorkerHandle): Promise<void> {
    const seen = new Set<number>();
    await waitFor(async () => {
      const at = worker.status().lastPollAt;
      if (at) seen.add(at.getTime());
      return seen.size >= 3;
    });
  }

  async function job(id: string) {
    const { rows } = await pool.query(
      `SELECT status, attempts, account_trips, failure_reason, lease_token IS NOT NULL AS leased,
              body_ciphertext IS NOT NULL AS has_body,
              EXTRACT(EPOCH FROM (next_attempt_at - now())) AS next_in_seconds
         FROM mail_jobs WHERE id = $1`,
      [id],
    );
    return rows[0] as
      | {
          status: string;
          attempts: number;
          account_trips: number;
          failure_reason: string | null;
          leased: boolean;
          has_body: boolean;
          next_in_seconds: string;
        }
      | undefined;
  }

  const waitStatus = (id: string, status: string, timeoutMs?: number) =>
    waitFor(async () => {
      const j = await job(id);
      return j?.status === status ? j : undefined;
    }, timeoutMs);

  async function attempts(id: string) {
    const { rows } = await pool.query(
      `SELECT classification, counted, stage, response_code, enhanced_code, response_text, rejected_recipients
         FROM mail_attempts WHERE job_id = $1 ORDER BY id`,
      [id],
    );
    return rows as Array<{
      classification: string;
      counted: boolean;
      stage: string | null;
      response_code: number | null;
      enhanced_code: string | null;
      response_text: string | null;
      rejected_recipients: unknown;
    }>;
  }

  /** 전송을 직접 통제하는 가짜 발송기. 호출 시각과 동시 실행 수를 센다. */
  function gatedSender(honorSignal = true) {
    const state = {
      calls: [] as SmtpMessage[],
      inFlight: 0,
      maxInFlight: 0,
      releases: [] as Array<(r: SmtpSendResult) => void>,
    };
    const sender: MailSender = {
      send(message, opts) {
        state.calls.push(message);
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        return new Promise<SmtpSendResult>((resolve, reject) => {
          const done = (r: SmtpSendResult) => {
            state.inFlight -= 1;
            resolve(r);
          };
          state.releases.push(done);
          if (honorSignal) {
            opts?.signal?.addEventListener("abort", () => {
              state.inFlight -= 1;
              reject(new SmtpAbortedError());
            });
          }
        });
      },
    };
    const sent: SmtpSendResult = { kind: "SENT", rejectedRecipients: [] };
    return {
      sender,
      state,
      releaseAll: () => state.releases.splice(0).forEach((r) => r(sent)),
    };
  }

  // --- 정상·재시도·실패 -------------------------------------------------------

  it("정상 발송은 SENT가 되고 시도 기록·종결 이벤트·고정 Message-ID가 남는다 (RQ-005, ADR-0007 결정 8)", async () => {
    const id = await mailJob({ subject: "한글 제목", text: "한글 본문" });
    startWorker();
    await waitStatus(id, "SENT");

    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]!.messageId).toBe(`<${id}@example.com>`);
    expect(fake.messages[0]!.rcptTo).toEqual(["to1@example.com"]);
    expect(await attempts(id)).toEqual([
      expect.objectContaining({
        classification: "SENT",
        counted: true,
        rejected_recipients: null,
      }),
    ]);
    const events = await pool.query(
      "SELECT type, attempt_count FROM mail_events WHERE job_id = $1",
      [id],
    );
    expect(events.rows).toEqual([{ type: "JOB_SENT", attempt_count: 1 }]);
    expect((await job(id))!.attempts).toBe(1);
  });

  it("시도 기록의 instance가 로그의 instance와 같아 로그와 DB 행을 jobId로 잇는다 (migrations/0003)", async () => {
    const id = await mailJob();
    startWorker();
    await waitStatus(id, "SENT");

    const { rows } = await pool.query(
      "SELECT instance FROM mail_attempts WHERE job_id = $1",
      [id],
    );
    expect(rows).toEqual([{ instance: "mailo-test-1" }]);
    const completed = logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.event === "job_completed" && l.jobId === id);
    expect(completed?.instance).toBe("mailo-test-1");
  });

  it("4xx 응답은 RETRY_WAIT가 되고 backoff(60초, 120초)로 다음 시각이 잡힌 뒤 재시도로 SENT가 된다 (RQ-008·009)", async () => {
    fake.behavior.data = () => ({
      code: 451,
      text: "4.3.0 Temporary local problem",
    });
    const id = await mailJob();
    startWorker();

    const first = await waitStatus(id, "RETRY_WAIT");
    expect(first.attempts).toBe(1);
    expect(Number(first.next_in_seconds)).toBeGreaterThan(55);
    expect(Number(first.next_in_seconds)).toBeLessThanOrEqual(60);

    await pastDue(pool, id);
    await waitFor(async () => (await job(id))!.attempts === 2);
    const second = await waitStatus(id, "RETRY_WAIT");
    expect(Number(second.next_in_seconds)).toBeGreaterThan(115);
    expect(Number(second.next_in_seconds)).toBeLessThanOrEqual(120);

    delete fake.behavior.data;
    await pastDue(pool, id);
    await waitStatus(id, "SENT");
    const rows = await attempts(id);
    expect(rows.map((r) => r.classification)).toEqual([
      "TRANSIENT",
      "TRANSIENT",
      "SENT",
    ]);
    expect(rows[0]).toMatchObject({
      stage: "DATA",
      response_code: 451,
      enhanced_code: "4.3.0",
      counted: true,
    });
  });

  it("5xx 메시지 오류는 재시도 없이 FAILED가 된다 (RQ-009)", async () => {
    fake.behavior.data = () => ({
      code: 550,
      text: "5.7.1 Message likely unsolicited mail.",
    });
    const id = await mailJob();
    startWorker();
    const done = await waitStatus(id, "FAILED");
    expect(done.failure_reason).toBe("PERMANENT");
    expect(done.attempts).toBe(1);
    await sleep(200);
    expect(fake.counts.datas).toBe(1);
    const events = await pool.query(
      "SELECT type, failure_detail FROM mail_events WHERE job_id = $1",
      [id],
    );
    expect(events.rows).toEqual([
      { type: "JOB_FAILED", failure_detail: "550 5.7.1" },
    ]);
  });

  it("일부 수신자 거부는 SENT이고 rejectedRecipients가 시도 기록과 JOB_SENT 이벤트에 남는다 (RQ-016, ADR-0007 결정 7)", async () => {
    fake.behavior.rcpt = (address) =>
      address.startsWith("bad")
        ? { code: 550, text: "5.1.1 no such user" }
        : undefined;
    const id = await mailJob({
      recipients: {
        to: ["bad@example.com", "good@example.com"],
        cc: [],
        bcc: [],
      },
    });
    startWorker();
    await waitStatus(id, "SENT");

    const [attempt] = await attempts(id);
    expect(attempt!.rejected_recipients).toEqual([
      {
        address: "bad@example.com",
        responseCode: 550,
        enhancedStatus: "5.1.1",
        responseText: "550 5.1.1 no such user",
      },
    ]);
    const event = await pool.query(
      "SELECT rejected_recipients FROM mail_events WHERE job_id = $1",
      [id],
    );
    expect(event.rows[0].rejected_recipients).toEqual(
      attempt!.rejected_recipients,
    );
    expect(fake.messages[0]!.rcptTo).toEqual(["good@example.com"]);
  });

  it("수신자 전원이 5xx로 거부되면 FAILED, 하나라도 4xx이면 RETRY_WAIT이다 (ADR-0007 결정 7)", async () => {
    fake.behavior.rcpt = () => ({ code: 550, text: "5.1.1 no such user" });
    const failed = await mailJob();
    startWorker();
    await waitStatus(failed, "FAILED");

    fake.behavior.rcpt = () => ({ code: 450, text: "4.2.2 mailbox full" });
    const retry = await mailJob();
    await waitStatus(retry, "RETRY_WAIT");
  });

  it("처리할 수 없는 작업(독성 작업)은 내부 오류로 3회째 시도에서 FAILED가 되고 SMTP에 닿지 않는다", async () => {
    const id = await mailJob({ body: Buffer.from(`not-json ${BODY_CANARY}`) });
    startWorker({
      retry: {
        ...defaultRetryPolicy(),
        mode: "fixed",
        baseSeconds: 0,
        jitterRatio: 0,
      },
    });
    const done = await waitStatus(id, "FAILED");
    expect(done.attempts).toBe(3);
    expect(done.failure_reason).toBe("PERMANENT");
    expect(
      (await attempts(id)).map((a) => [a.classification, a.stage]),
    ).toEqual([
      ["TRANSIENT", "WORKER"],
      ["TRANSIENT", "WORKER"],
      ["PERMANENT", "WORKER"],
    ]);
    expect(fake.counts.mailFroms).toBe(0);
  });

  it("envelope.from이 null이면 기본 발신 주소(defaultFrom)로 보낸다, 값이 있으면 그 값을 쓴다", async () => {
    const withDefault = await mailJob({ envelope: { from: null } });
    const explicit = await mailJob({ envelope: { from: SENDER_ADDRESS } });
    startWorker();
    await waitStatus(withDefault, "SENT");
    await waitStatus(explicit, "SENT");

    expect(fake.messages.map((m) => m.mailFrom).sort()).toEqual(
      [DEFAULT_FROM, SENDER_ADDRESS].sort(),
    );
  });

  it("half_open 대표 작업이 내부 오류로 끝나도 차단기는 closed로 돌아가지 않는다 (계정 상태를 확인하지 못했다)", async () => {
    await pool.query(
      `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() - interval '1 second',
         wait_seconds = 60, consecutive_failures = 3, last_reason = 'AUTH'`,
    );
    const poison = await mailJob({ body: Buffer.from("not-json") });
    const worker = startWorker();

    await waitStatus(poison, "RETRY_WAIT");

    const state = await getBreakerState(pool, { breakerKey: "default" });
    expect(state.state).toBe("half_open");
    expect(state.probeJobId).toBe(poison);
    expect((await attempts(poison))[0]).toMatchObject({
      classification: "TRANSIENT",
      stage: "WORKER",
    });
    // 대표 lease가 끝나기 전에는 다른 작업을 점유하지 않는다.
    const other = await mailJob();
    await afterFullPollRounds(worker);
    expect((await job(other))!.status).toBe("PENDING");
    expect(fake.counts.mailFroms).toBe(0);
  });

  it("본문이 이미 삭제된 작업은 바로 FAILED가 된다", async () => {
    const id = await mailJob();
    await pool.query(
      "UPDATE mail_jobs SET body_ciphertext = NULL, body_nonce = NULL, body_key_version = NULL WHERE id = $1",
      [id],
    );
    startWorker();
    const done = await waitStatus(id, "FAILED");
    expect(done.attempts).toBe(1);
  });

  // --- 차단기 -----------------------------------------------------------------

  it("일일 한도 응답(550 5.4.5)은 시도 횟수를 쓰지 않고 차단기를 open하며, 이후 새 작업을 점유하지 않는다 (ADR-0007 결정 2·4·5)", async () => {
    fake.behavior.mailFrom = () => ({
      code: 550,
      text: "5.4.5 Daily user sending limit exceeded.",
    });
    const first = await mailJob();
    const worker = startWorker();
    const retry = await waitStatus(first, "RETRY_WAIT");
    expect(retry.attempts).toBe(0);
    // 한도 사유는 작업의 account_trips에 넣지 않는다(ADR-0007 구현 중 확정 8).
    expect(retry.account_trips).toBe(0);
    expect((await attempts(first))[0]).toMatchObject({
      classification: "ACCOUNT",
      counted: false,
      stage: "MAIL_FROM",
      response_code: 550,
      enhanced_code: "5.4.5",
    });
    const state = await getBreakerState(pool, { breakerKey: "default" });
    expect(state.state).toBe("open");
    expect(state.lastReason).toBe("DAILY_LIMIT");
    expect(logs.some((l) => l.includes('"event":"breaker_not_closed"'))).toBe(
      true,
    );

    const second = await mailJob();
    await afterFullPollRounds(worker);
    expect((await job(second))!.status).toBe("PENDING");
    expect(fake.counts.mailFroms).toBe(1);
  });

  it("연속 인증 실패 3회로 차단기가 open되고 그 뒤에는 점유하지 않는다 (ADR-0007 결정 5)", async () => {
    fake.behavior.auth = () => ({
      code: 535,
      text: "5.7.8 Username and Password not accepted",
    });
    const ids = [await mailJob(), await mailJob(), await mailJob()];
    const worker = startWorker();
    await waitFor(
      async () =>
        (await getBreakerState(pool, { breakerKey: "default" })).state ===
        "open",
    );
    const state = await getBreakerState(pool, { breakerKey: "default" });
    expect(state.lastReason).toBe("AUTH");
    expect(fake.counts.auths).toBe(3);
    // 차단기를 열기 전의 실패 2건은 작업별 오류로 시도 횟수에 들고, 차단기를 연 3번째 실패는 들지 않는다
    // (ADR-0007 구현 중 확정 8). 어느 작업이 3번째인지는 점유 순서에 따른다.
    const jobs = await Promise.all(ids.map((id) => job(id)));
    for (const j of jobs) expect(j!.status).toBe("RETRY_WAIT");
    expect(jobs.map((j) => j!.attempts).sort()).toEqual([0, 1, 1]);

    const extra = await mailJob();
    await afterFullPollRounds(worker);
    expect((await job(extra))!.status).toBe("PENDING");
    expect(fake.counts.auths).toBe(3);
  });

  it("open 시간이 지나면 half_open 대표 한 건만 점유하고, 성공하면 closed로 돌아가 나머지를 처리한다 (ADR-0007 결정 5)", async () => {
    fake.behavior.mailFrom = () => ({
      code: 550,
      text: "5.4.5 Daily user sending limit exceeded.",
    });
    const tripped = await mailJob();
    startWorker();
    await waitStatus(tripped, "RETRY_WAIT");
    const waiting = [await mailJob(), await mailJob(), await mailJob()];

    // 계정이 복구됐다. open 시간만 앞당긴다.
    delete fake.behavior.mailFrom;
    fake.behavior.dataDelayMs = () => 300;
    await pool.query(
      "UPDATE mail_circuit_breaker SET open_until = now() - interval '1 second'",
    );

    const probe = await waitFor(async () => {
      const state = await getBreakerState(pool, { breakerKey: "default" });
      return state.state === "half_open" ? state : undefined;
    });
    expect(probe.probeJobId).not.toBe(tripped);
    // 대표 전송이 끝나기 전에는 다른 작업을 점유하지 않는다.
    const sending = await pool.query(
      "SELECT count(*)::int AS n FROM mail_jobs WHERE status = 'SENDING'",
    );
    expect(sending.rows[0].n).toBe(1);

    await waitFor(
      async () =>
        (await getBreakerState(pool, { breakerKey: "default" })).state ===
        "closed",
    );
    for (const id of waiting) await waitStatus(id, "SENT");
    await pastDue(pool, tripped);
    await waitStatus(tripped, "SENT");
  });

  // --- 종료·복구·중복 방지 ------------------------------------------------------

  it("프로세스가 죽어 lease가 만료되면 다른 Worker가 회수해 attempts에 LEASE_EXPIRED가 남고 재발송한다 (ADR-0002 결정 5, RQ-013)", async () => {
    const id = await mailJob();
    const stuck = gatedSender();
    const dead = startWorker({ drainTimeoutMs: 100 }, stuck.sender);
    await waitFor(async () => (await job(id))!.status === "SENDING");
    // 프로세스 종료를 흉내 낸다. 종료 대기 시간을 넘기면 결과를 기록하지 않고 떠난다.
    await dead.stop();
    expect((await job(id))!.status).toBe("SENDING");
    await pool.query(
      "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
      [id],
    );

    startWorker();
    const recovered = await waitStatus(id, "RETRY_WAIT");
    expect(recovered.attempts).toBe(1);
    await pastDue(pool, id);
    await waitStatus(id, "SENT");
    expect((await attempts(id)).map((a) => a.classification)).toEqual([
      "LEASE_EXPIRED",
      "SENT",
    ]);
    expect(fake.messages).toHaveLength(1);
  });

  it("회수된 뒤 늦게 끝난 이전 점유의 결과는 버려지고 기록되지 않는다 (ADR-0002 결정 6)", async () => {
    const id = await mailJob();
    // 신호를 무시하는 발송기: 멈춰 있던 프로세스가 나중에 깨어나는 상황이다.
    const slow = gatedSender(false);
    const frozen = startWorker({ drainTimeoutMs: 100 }, slow.sender);
    await waitFor(async () => (await job(id))!.status === "SENDING");
    await frozen.stop();
    await pool.query(
      "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
      [id],
    );

    startWorker();
    await waitStatus(id, "RETRY_WAIT");
    await pastDue(pool, id);
    await waitStatus(id, "SENT");
    const before = await attempts(id);

    slow.releaseAll();
    await waitFor(async () =>
      logs.some((l) => l.includes('"event":"lease_lost"')),
    );
    expect(await attempts(id)).toEqual(before);
    expect((await job(id))!.status).toBe("SENT");
  });

  it("Worker 두 개가 같은 큐를 처리해도 작업마다 정확히 한 번만 발송한다 (RQ-012, ADR-0002 결정 4)", async () => {
    fake.behavior.dataDelayMs = () => 20;
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) ids.push(await mailJob());
    startWorker({ concurrency: 3 });
    startWorker({ concurrency: 3 });
    for (const id of ids) await waitStatus(id, "SENT", 20_000);

    expect(fake.messages).toHaveLength(16);
    expect(new Set(fake.messages.map((m) => m.messageId)).size).toBe(16);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM mail_attempts")).rows[0]
        .n,
    ).toBe(16);
  });

  it("동시 전송 수는 concurrency를 넘지 않는다", async () => {
    const gate = gatedSender();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await mailJob());
    startWorker({ concurrency: 2 }, gate.sender);
    await waitFor(async () => gate.state.inFlight === 2);
    await sleep(200);
    expect(gate.state.maxInFlight).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM mail_jobs WHERE status = 'SENDING'",
        )
      ).rows[0].n,
    ).toBe(2);

    // 하나가 끝나면 다음 작업을 점유한다.
    gate.state.releases.shift()!({ kind: "SENT", rejectedRecipients: [] });
    await waitFor(async () => gate.state.calls.length === 3);
    expect(gate.state.maxInFlight).toBe(2);
    gate.releaseAll();
  });

  it("종료 신호를 받으면 진행 중 전송을 끝까지 기다리고 새 작업은 점유하지 않는다 (ADR-0002 결정 12, RQ-025)", async () => {
    const gate = gatedSender();
    const inFlight = await mailJob();
    const worker = startWorker({ drainTimeoutMs: 5_000 }, gate.sender);
    await waitFor(async () => gate.state.inFlight === 1);

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    // stop()이 부른 pause()와 같은 약속이다. 점유 루프가 끝난 뒤(진행 중이던 점유 호출이 끝난 뒤)에 등록해야 한다.
    // 점유 호출 도중에 등록하면 그 호출이 새 작업을 읽을 수 있다(pause 때 시작한 호출은 끝까지 간다).
    await worker.pause();
    const late = await mailJob();
    await sleep(300);
    expect(stopped).toBe(false);
    expect((await job(inFlight))!.status).toBe("SENDING");

    gate.releaseAll();
    await stopping;
    expect((await job(inFlight))!.status).toBe("SENT");
    // 종료 뒤에도 늦게 등록된 작업은 점유되지 않았다.
    expect((await job(late))!.status).toBe("PENDING");
    expect(gate.state.calls).toHaveLength(1);
    expect(
      logs.some(
        (l) =>
          l.includes('"event":"worker_stopped"') &&
          l.includes('"drained":true'),
      ),
    ).toBe(true);
  });

  it("pause 뒤에는 새 작업을 점유하지 않고 진행 중 전송은 계속해 끝낸다 (ADR-0002 결정 12, RQ-025)", async () => {
    const gate = gatedSender();
    const inFlight = await mailJob();
    const worker = startWorker({ drainTimeoutMs: 5_000 }, gate.sender);
    await waitFor(async () => gate.state.inFlight === 1);

    await worker.pause();
    const late = await mailJob();
    await sleep(300);
    expect((await job(late))!.status).toBe("PENDING");
    expect(gate.state.calls).toHaveLength(1);
    // pause는 진행 중 전송을 기다리지 않고 끊지도 않는다.
    expect((await job(inFlight))!.status).toBe("SENDING");

    gate.releaseAll();
    await waitStatus(inFlight, "SENT");
    await worker.stop();
    expect((await job(late))!.status).toBe("PENDING");
    expect(logs.some((l) => l.includes('"event":"worker_paused"'))).toBe(true);
  });

  it("pause 뒤 stop은 진행 중 전송이 끝난 뒤에 resolve한다", async () => {
    const gate = gatedSender();
    const inFlight = await mailJob();
    const worker = startWorker({ drainTimeoutMs: 5_000 }, gate.sender);
    await waitFor(async () => gate.state.inFlight === 1);

    await worker.pause();
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await sleep(300);
    expect(stopped).toBe(false);

    gate.releaseAll();
    await stopping;
    expect((await job(inFlight))!.status).toBe("SENT");
    expect(
      logs.some(
        (l) =>
          l.includes('"event":"worker_stopped"') &&
          l.includes('"drained":true'),
      ),
    ).toBe(true);
  });

  it("drain 상한은 pause 시점부터 센다: HTTP 닫기에 시간이 걸려도 stop은 남은 시간만 기다린다", async () => {
    const gate = gatedSender();
    const id = await mailJob();
    const worker = startWorker({ drainTimeoutMs: 300 }, gate.sender);
    await waitFor(async () => gate.state.inFlight === 1);

    await worker.pause();
    await sleep(500); // 종료 신호 뒤 HTTP 서버 닫기가 걸리는 시간을 흉내 낸다.
    const started = Date.now();
    await worker.stop();

    expect(Date.now() - started).toBeLessThan(250);
    expect(logs.some((l) => l.includes('"event":"drain_timeout"'))).toBe(true);
    // lease를 풀지 않는다. 다음 claim이 lease 만료로 회수한다.
    const { rows } = await pool.query(
      `SELECT status, lease_token IS NOT NULL AS leased, lease_until > now() AS lease_alive
         FROM mail_jobs WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      status: "SENDING",
      leased: true,
      lease_alive: true,
    });
  });

  it("종료 대기 시간이 지나면 포기하고 결과를 기록하지 않아 lease 복구가 이어받는다", async () => {
    const gate = gatedSender();
    const id = await mailJob();
    const worker = startWorker({ drainTimeoutMs: 200 }, gate.sender);
    await waitFor(async () => gate.state.inFlight === 1);

    const started = Date.now();
    await worker.stop();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect((await job(id))!.status).toBe("SENDING");
    expect(await attempts(id)).toEqual([]);
    expect(logs.some((l) => l.includes('"event":"drain_timeout"'))).toBe(true);
  });

  it("stop()을 두 번 불러도 안전하고 시작하지 않은 Worker도 종료된다", async () => {
    const never = createWorker(
      {
        pool,
        sender: gatedSender().sender,
        bodyCipher: testCipher,
        defaultFrom: DEFAULT_FROM,
      },
      options(),
    );
    await never.stop();
    const worker = startWorker();
    await Promise.all([worker.stop(), worker.stop()]);
    await expect(worker.start()).rejects.toThrow("already stopped");
  });

  // --- 주기 작업 ----------------------------------------------------------------

  it("차단기가 open이어도 주기 sweep이 만료된 작업을 EXPIRED로 바꾸고 이벤트를 쓴다 (ADR-0007 결정 6)", async () => {
    await pool.query(
      "UPDATE mail_circuit_breaker SET state = 'open', open_until = now() + interval '1 hour', wait_seconds = 3600, last_reason = 'DAILY_LIMIT'",
    );
    const id = await mailJob();
    await pool.query(
      "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = $1",
      [id],
    );
    startWorker();
    await waitStatus(id, "EXPIRED");
    expect(fake.counts.mailFroms).toBe(0);
    const events = await pool.query(
      "SELECT type FROM mail_events WHERE job_id = $1",
      [id],
    );
    expect(events.rows).toEqual([{ type: "JOB_EXPIRED" }]);
  });

  it("본문 삭제와 보존 기간 삭제가 주기적으로 실행된다 (ADR-0008 결정 7, RQ-026)", async () => {
    const bodyOld = await mailJob();
    const rowOld = await mailJob();
    const fresh = await mailJob();
    const finish = (id: string, age: string) =>
      pool.query(
        `UPDATE mail_jobs SET status = 'SENT', finished_at = now() - $2::interval WHERE id = $1`,
        [id, age],
      );
    await finish(bodyOld, "200 seconds");
    await finish(rowOld, "2000 seconds");
    await finish(fresh, "1 second");
    startWorker({ retention: { bodyGraceSeconds: 100, recordSeconds: 1_000 } });

    await waitFor(async () => (await job(rowOld)) === undefined);
    expect((await job(bodyOld))!.has_body).toBe(false);
    expect((await job(fresh))!.has_body).toBe(true);
  });

  // --- 시크릿 ---------------------------------------------------------------------

  it("로그·시도 기록·이벤트·작업 행 어디에도 본문, 제목, SMTP 비밀번호, 응답에 되풀이된 수신자 주소가 남지 않는다 (RQ-027)", async () => {
    const subject = `제목 ${BODY_CANARY}`;
    const text = `본문 ${BODY_CANARY}`;
    const html = `<p>${BODY_CANARY}</p>`;
    const recipient = "canary-rcpt@example.com";

    // 1) 성공
    const ok = await mailJob({ subject, text, html });
    // 2) 응답에 수신자 주소가 되풀이되는 영구 거부
    fake.behavior.rcpt = (address) =>
      address === recipient
        ? { code: 550, text: `5.1.1 <${address}> does not exist` }
        : undefined;
    const rejected = await mailJob({
      subject,
      text,
      html,
      recipients: { to: [recipient], cc: [], bcc: [] },
    });
    // 3) 처리할 수 없는 본문
    const poison = await mailJob({
      body: Buffer.from(`broken ${BODY_CANARY}`),
    });
    startWorker({
      retry: {
        ...defaultRetryPolicy(),
        mode: "fixed",
        baseSeconds: 0,
        jitterRatio: 0,
      },
    });
    await waitStatus(ok, "SENT");
    await waitStatus(rejected, "FAILED");
    await waitStatus(poison, "FAILED");

    // 4) 인증 실패(비밀번호 canary)
    delete fake.behavior.rcpt;
    fake.behavior.auth = () => ({
      code: 535,
      text: "5.7.8 Username and Password not accepted",
    });
    const authFail = await mailJob({ subject, text, html });
    await waitStatus(authFail, "RETRY_WAIT");

    const dump = JSON.stringify({
      logs,
      attempts: (await pool.query("SELECT * FROM mail_attempts")).rows,
      events: (await pool.query("SELECT * FROM mail_events")).rows,
      jobs: (
        await pool.query(
          "SELECT id, status, attempts, failure_reason, last_account_response, recipients, envelope FROM mail_jobs",
        )
      ).rows,
    });
    expect(dump).not.toContain(BODY_CANARY);
    expect(dump).not.toContain(PASSWORD_CANARY);

    // 응답 텍스트의 수신자 주소는 시도 기록과 로그에서 가려진다. (events.recipients는 설계상 평문이므로 제외한다.)
    const attemptsDump = JSON.stringify(
      (await pool.query("SELECT * FROM mail_attempts")).rows,
    );
    expect(attemptsDump).not.toContain(recipient);
    expect(logs.join("\n")).not.toContain(recipient);
    expect((await attempts(rejected))[0]!.response_text).toContain("[address]");

    // 종결한 작업은 본문 컬럼이 비어 있다(RQ-071). 종결 전 작업(재시도 대기)의 암호화 컬럼에도 평문이 없다.
    const done = await pool.query(
      "SELECT body_ciphertext FROM mail_jobs WHERE id = $1",
      [ok],
    );
    expect(done.rows[0].body_ciphertext).toBeNull();
    const raw = await pool.query(
      "SELECT body_ciphertext FROM mail_jobs WHERE id = $1",
      [authFail],
    );
    expect(
      (raw.rows[0].body_ciphertext as Buffer).includes(
        Buffer.from(BODY_CANARY),
      ),
    ).toBe(false);
  });

  it("기본 SMTP 타임아웃은 lease 안에 들어간다 (기동 시 검증)", () => {
    expect(() => checkSmtpTimeouts(DEFAULT_SMTP_TIMEOUTS, 120)).not.toThrow();
  });
});
