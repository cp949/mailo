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
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import {
  SmtpAbortedError,
  createSmtpSender,
  type MailSender,
} from "../../src/smtp/index.js";
import { toSenderConfig } from "../../src/worker/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp.js";
import { fileRequest } from "../support/file-channel.js";
import {
  parseMetrics,
  sumOf,
  valueOf,
  type ParsedSample,
} from "../support/metrics-text.js";
import { migrate } from "../support/queue-fixtures.js";
import {
  ALPHA_KEY,
  CANARY,
  getJson,
  plainMail,
  postJob,
  startRestApp,
  type RestApp,
} from "../support/rest-app.js";

/**
 * end-to-end: 실제 HTTP·파일 채널 -> PostgreSQL -> 설정으로 조립한 Worker -> 로컬 smtp-server.
 * 근거: RQ-073·074, ADR-0015 결정 5~10.
 * 고정하는 것: `fail` 요청은 결과 불명(DATA 뒤 연결 끊김, lease 만료 회수)에서 재발송 없이 `OUTCOME_UNKNOWN`으로 끝나고,
 * 조회·이벤트·`/metrics`가 이를 표현하며, `retry`(기본)와 응답 코드가 있는 실패는 기존 판정이다.
 * 실제 Gmail은 쓰지 않는다. DATA 타임아웃은 연결을 끊어 흉내 낸다.
 */

const READ = "ops-read-fake-token-000000000000000000000001";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface JobBody {
  jobId: string;
  status: string;
  attempts: number;
  failureReason: string | null;
  lastError: { category: string; smtpCode: number | null } | null;
  outcomeUncertain: boolean;
}
interface EventBody {
  type: string;
  jobId: string;
  failureReason?: string | null;
  outcomeUncertain?: boolean;
  recipients: { to: string[] };
}

describe("e2e: onUncertainOutcome fail의 결과 불명 종결 (RQ-073·074, ADR-0015 결정 5~10)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let fake: FakeSmtp;
  let app: RestApp | undefined;
  let root: string;

  async function startApp(
    sender?: MailSender,
    withFiles = false,
  ): Promise<RestApp> {
    app = await startRestApp({
      pool,
      env: {
        MAILO_SMTP_HOST: fake.host,
        MAILO_SMTP_PORT: String(fake.port),
        MAILO_SMTP_USER: "fake-user@example.invalid",
        MAILO_WORKER_POLL_MS: "50",
        MAILO_MAINTENANCE_INTERVAL_SECONDS: "1",
        MAILO_OPS_TOKEN: READ,
        ...(withFiles && {
          MAILO_FILE_CHANNEL_ROOT: root,
          MAILO_FILE_POLL_INTERVAL_MS: "50",
        }),
      },
      ...(withFiles && { fileChannelCallers: ["alpha"] }),
      worker: { trustedCa: fake.ca, ...(sender && { sender }) },
    });
    return app;
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
      await sleep(25);
    }
  }

  async function getJob(jobId: string): Promise<JobBody> {
    const res = await getJson(app!, `/jobs/${jobId}`);
    expect(res.status).toBe(200);
    return (await res.json()) as JobBody;
  }

  const waitStatus = (jobId: string, status: string) =>
    waitFor(async () => {
      const job = await getJob(jobId);
      return job.status === status ? job : undefined;
    });

  async function events(): Promise<EventBody[]> {
    const res = await getJson(app!, "/events");
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: EventBody[] }).events;
  }

  async function scrape(): Promise<ParsedSample[]> {
    const res = await fetch(`${app!.baseUrl}/metrics`, {
      headers: { Authorization: `Bearer ${READ}` },
    });
    expect(res.status).toBe(200);
    return parseMetrics(await res.text());
  }

  /** counter는 커밋 뒤에 오르므로 값이 생길 때까지 기다린다. */
  async function waitMetric(
    name: string,
    labels: Record<string, string>,
  ): Promise<ParsedSample[]> {
    return waitFor(async () => {
      const samples = await scrape();
      return sumOf(samples, name, labels) >= 1 ? samples : undefined;
    });
  }

  async function submit(key: string, body: Record<string, unknown>) {
    const res = await postJob(app!, { key, body });
    expect(res.status).toBe(202);
    return (await res.json()) as JobBody;
  }

  async function jobRow(jobId: string) {
    return (
      await pool.query(
        `SELECT status, attempts, failure_reason, on_uncertain, recipients, envelope, body_ciphertext
           FROM mail_jobs WHERE id = $1`,
        [jobId],
      )
    ).rows[0];
  }

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
    root = mkdtempSync(path.join(tmpdir(), "mailo-uncertain-e2e-"));
    await pool.query("DELETE FROM mail_events");
    await pool.query("DELETE FROM mail_intake_rejections");
    await pool.query("DELETE FROM mail_jobs");
    await pool.query(
      `UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL,
         probe_job_id = NULL, consecutive_failures = 0, wait_seconds = 0, last_reason = NULL,
         last_trip_job_id = NULL, last_trip_token = NULL`,
    );
    fake.reset();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("fail 요청은 DATA 뒤 응답 없이 연결이 끊기면 재발송 없이 FAILED·OUTCOME_UNKNOWN이고 조회·이벤트·지표에 나타난다", async () => {
    await startApp();
    fake.behavior.dropAfterData = () => true;
    const recipient = `${CANARY.recipient}@example.com`;

    const created = await submit(
      "e2e-fail-data",
      plainMail({
        to: [recipient],
        subject: CANARY.subject,
        text: CANARY.text,
        onUncertainOutcome: "fail",
      }),
    );
    const job = await waitStatus(created.jobId, "FAILED");

    expect(job).toMatchObject({
      attempts: 1,
      failureReason: "OUTCOME_UNKNOWN",
      outcomeUncertain: true,
      lastError: { category: "TRANSIENT", smtpCode: null },
    });
    // 재시도 시각이 지났을 시간 동안 기다려도 SMTP는 DATA를 한 번만 받았다(재발송 없음).
    await sleep(400);
    expect(fake.counts.datas).toBe(1);
    expect((await getJob(created.jobId)).attempts).toBe(1);

    const feed = await waitFor(async () => {
      const all = await events();
      return all.length > 0 ? all : undefined;
    });
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      type: "JOB_FAILED",
      jobId: created.jobId,
      failureReason: "OUTCOME_UNKNOWN",
      outcomeUncertain: true,
      recipients: { to: [recipient] },
    });
    const row = await jobRow(created.jobId);
    expect(row).toMatchObject({
      on_uncertain: "fail",
      recipients: {},
      envelope: {},
      body_ciphertext: null,
    });

    const samples = await waitMetric("mailo_jobs_outcome_unknown_total", {
      caller_id: "alpha",
    });
    const id = { caller_id: "alpha", account_id: "default" };
    expect(valueOf(samples, "mailo_jobs_outcome_unknown_total", id)).toBe(1);
    expect(
      valueOf(samples, "mailo_jobs_finished_total", {
        ...id,
        status: "failed",
      }),
    ).toBe(1);
    // 수신자·제목·본문이 지표에 없다(RQ-027).
    const text = JSON.stringify(samples);
    for (const canary of [CANARY.recipient, CANARY.subject, CANARY.text])
      expect(text).not.toContain(canary);
    const logs = app!.logs.lines.join("\n");
    for (const canary of [CANARY.recipient, CANARY.subject, CANARY.text])
      expect(logs).not.toContain(canary);
  });

  it("같은 조건에서 retry(생략)는 RETRY_WAIT이고 지표를 올리지 않는다(회귀)", async () => {
    await startApp();
    fake.behavior.dropAfterData = () => true;

    const omitted = await submit("e2e-retry-omit", plainMail());
    const explicit = await submit(
      "e2e-retry-explicit",
      plainMail({ onUncertainOutcome: "retry" }),
    );

    for (const created of [omitted, explicit]) {
      const waiting = await waitStatus(created.jobId, "RETRY_WAIT");
      expect(waiting).toMatchObject({
        failureReason: null,
        outcomeUncertain: true,
      });
    }
    const samples = await scrape();
    expect(sumOf(samples, "mailo_jobs_outcome_unknown_total", {})).toBe(0);
  });

  it("fail이어도 SMTP 응답 코드가 있는 실패(550)는 PERMANENT_ERROR이고 outcomeUncertain이 false이며 지표를 올리지 않는다", async () => {
    await startApp();
    fake.behavior.data = () => ({
      code: 550,
      text: "5.7.1 Message likely unsolicited mail.",
    });

    const created = await submit(
      "e2e-fail-550",
      plainMail({ onUncertainOutcome: "fail" }),
    );
    const job = await waitStatus(created.jobId, "FAILED");

    expect(job).toMatchObject({
      failureReason: "PERMANENT_ERROR",
      outcomeUncertain: false,
    });
    await waitMetric("mailo_jobs_finished_total", {
      caller_id: "alpha",
      status: "failed",
    });
    expect(sumOf(await scrape(), "mailo_jobs_outcome_unknown_total", {})).toBe(
      0,
    );
  });

  it("fail이어도 DATA 이전 단계의 일시 오류(RCPT 450)는 재시도한다", async () => {
    await startApp();
    fake.behavior.rcpt = () => ({ code: 450, text: "4.2.2 mailbox busy" });

    const created = await submit(
      "e2e-fail-rcpt",
      plainMail({ onUncertainOutcome: "fail" }),
    );

    const waiting = await waitStatus(created.jobId, "RETRY_WAIT");
    expect(waiting).toMatchObject({
      failureReason: null,
      outcomeUncertain: false,
    });
  });

  it("fail 요청의 전송 중 프로세스가 죽어 lease가 만료되면 새 Worker가 재발송 없이 OUTCOME_UNKNOWN으로 종결하고 지표를 올린다", async () => {
    // 실제 발송기로 서버가 수락한 뒤 `SmtpAbortedError`로 끝내면 Worker가 결과를 기록하지 않는다(프로세스 사망을 흉내 낸다).
    let real: MailSender | undefined;
    const dying: MailSender = {
      async send(message, options) {
        real ??= createSmtpSender(toSenderConfig(app!.config, fake.ca));
        await real.send(message, options);
        throw new SmtpAbortedError();
      },
    };
    await startApp(dying);
    const created = await submit(
      "e2e-fail-crash",
      plainMail({ onUncertainOutcome: "fail" }),
    );
    await waitFor(async () => fake.messages.length === 1);
    await waitFor(
      async () => (await jobRow(created.jobId)).status === "SENDING",
    );
    await sleep(200);
    await app!.close();
    await pool.query(
      "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
      [created.jobId],
    );

    await startApp(); // 재기동한 Worker가 lease를 회수한다
    const job = await waitStatus(created.jobId, "FAILED");

    expect(job).toMatchObject({
      attempts: 1,
      failureReason: "OUTCOME_UNKNOWN",
      outcomeUncertain: true,
    });
    // 같은 메일을 다시 보내지 않았다. retry였다면 여기서 2통이 된다(mail-flow의 at-least-once 테스트).
    await sleep(400);
    expect(fake.messages).toHaveLength(1);
    const attempts = await pool.query(
      "SELECT classification FROM mail_attempts WHERE job_id = $1 ORDER BY id",
      [created.jobId],
    );
    expect(attempts.rows.map((r) => r.classification)).toEqual([
      "LEASE_EXPIRED",
    ]);
    const samples = await waitMetric("mailo_jobs_outcome_unknown_total", {
      caller_id: "alpha",
    });
    const id = { caller_id: "alpha", account_id: "default" };
    expect(valueOf(samples, "mailo_jobs_outcome_unknown_total", id)).toBe(1);
    expect(
      valueOf(samples, "mailo_lease_recovered_total", {
        account_id: "default",
      }),
    ).toBe(1);
  });

  it("파일 채널 요청도 fail이면 DATA 뒤 연결 끊김에서 OUTCOME_UNKNOWN으로 종결한다", async () => {
    mkdirSync(path.join(root, "inbox", "alpha"), { recursive: true });
    await startApp(undefined, true);
    fake.behavior.dropAfterData = () => true;
    const dir = path.join(root, "inbox", "alpha");
    const drop = (name: string, content: unknown) => {
      writeFileSync(path.join(dir, `.${name}.tmp`), JSON.stringify(content));
      renameSync(path.join(dir, `.${name}.tmp`), path.join(dir, name));
    };

    drop(
      "fail.json",
      fileRequest({
        idempotencyKey: "e2e-file-fail",
        onUncertainOutcome: "fail",
      }),
    );
    drop("retry.json", fileRequest({ idempotencyKey: "e2e-file-retry" }));

    const byKey = async (key: string) =>
      (
        await pool.query(
          "SELECT id, status, failure_reason, on_uncertain FROM mail_jobs WHERE idempotency_key = $1",
          [key],
        )
      ).rows[0];
    await waitFor(
      async () => (await byKey("e2e-file-fail"))?.status === "FAILED",
    );
    await waitFor(
      async () => (await byKey("e2e-file-retry"))?.status === "RETRY_WAIT",
    );
    expect(await byKey("e2e-file-fail")).toMatchObject({
      failure_reason: "OUTCOME_UNKNOWN",
      on_uncertain: "fail",
    });
    expect(await byKey("e2e-file-retry")).toMatchObject({
      failure_reason: null,
      on_uncertain: "retry",
    });
    const view = await getJson(
      app!,
      `/jobs?idempotencyKey=e2e-file-fail`,
      ALPHA_KEY,
    );
    expect(await view.json()).toMatchObject({
      status: "FAILED",
      failureReason: "OUTCOME_UNKNOWN",
      outcomeUncertain: true,
    });
  });
});
