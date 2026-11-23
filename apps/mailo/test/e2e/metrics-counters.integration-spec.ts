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
  duplicateSeries,
  parseMetrics,
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
 * end-to-end: 실제 Worker·파일 폴러·REST가 올린 인스턴스 counter를 `/metrics`로 읽는다(RQ-049, ADR-0012 결정 4·7).
 * 근거: 시도·종결·claim·lease 회수·취소·파일 채널·cursor 공백 counter, 시크릿 비노출(RQ-027).
 * Worker는 `createApp({ worker })`가 만든 것이다. SMTP는 로컬 smtp-server다.
 */

const READ = "ops-read-fake-token-000000000000000000000001";
const ADMIN = "ops-admin-oncall-fake-token-000000000000001";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("e2e: /metrics 인스턴스 counter (RQ-049, ADR-0012 결정 4·7)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let fake: FakeSmtp;
  let app: RestApp | undefined;
  let root: string;

  const env = (extra: NodeJS.ProcessEnv = {}) => ({
    MAILO_SMTP_HOST: fake.host,
    MAILO_SMTP_PORT: String(fake.port),
    MAILO_SMTP_USER: "fake-user@example.invalid",
    MAILO_WORKER_POLL_MS: "50",
    MAILO_MAINTENANCE_INTERVAL_SECONDS: "1",
    MAILO_OPS_TOKEN: READ,
    MAILO_OPS_ADMIN_NAMES: "oncall",
    MAILO_OPS_ADMIN_TOKEN_ONCALL: ADMIN,
    ...extra,
  });

  async function startApp(
    sender?: MailSender,
    extra: NodeJS.ProcessEnv = {},
    withFiles = false,
  ): Promise<RestApp> {
    app = await startRestApp({
      pool,
      env: env({
        ...(withFiles && {
          MAILO_FILE_CHANNEL_ROOT: root,
          MAILO_FILE_POLL_INTERVAL_MS: "50",
        }),
        ...extra,
      }),
      ...(withFiles && { fileChannelCallers: ["alpha"] }),
      worker: { trustedCa: fake.ca, ...(sender && { sender }) },
    });
    return app;
  }

  async function scrape(): Promise<ParsedSample[]> {
    const res = await fetch(`${app!.baseUrl}/metrics`, {
      headers: { Authorization: `Bearer ${READ}` },
    });
    expect(res.status).toBe(200);
    return parseMetrics(await res.text());
  }

  /** 지표 값이 조건을 만족할 때까지 기다린다. counter는 커밋 뒤에 오른다. */
  async function waitMetric(
    name: string,
    labels: Record<string, string>,
    atLeast = 1,
    timeoutMs = 10_000,
  ): Promise<ParsedSample[]> {
    const started = Date.now();
    for (;;) {
      const samples = await scrape();
      if ((valueOf(samples, name, labels) ?? 0) >= atLeast) return samples;
      if (Date.now() - started > timeoutMs)
        throw new Error(
          `지표가 오르지 않았다: ${name} ${JSON.stringify(labels)}`,
        );
      await sleep(25);
    }
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

  async function submit(key: string, body = plainMail()) {
    const res = await postJob(app!, { key, body });
    return (await res.json()) as { jobId: string };
  }

  const status = async (jobId: string) =>
    (await pool.query("SELECT status FROM mail_jobs WHERE id = $1", [jobId]))
      .rows[0]?.status as string | undefined;
  const waitStatus = (jobId: string, want: string) =>
    waitFor(async () => ((await status(jobId)) === want ? true : undefined));

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
    root = mkdtempSync(path.join(tmpdir(), "mailo-metrics-e2e-"));
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

  it("발송 성공: attempts(sent)·finished(sent)·claimed가 오르고 claim_polls는 claimed와 empty가 모두 있다", async () => {
    await startApp();

    const { jobId } = await submit("m-ok");
    await waitStatus(jobId, "SENT");
    const samples = await waitMetric("mailo_jobs_finished_total", {
      caller_id: "alpha",
      status: "sent",
    });

    const id = { caller_id: "alpha", account_id: "default" };
    expect(
      valueOf(samples, "mailo_attempts_total", { ...id, result: "sent" }),
    ).toBe(1);
    expect(
      valueOf(samples, "mailo_jobs_finished_total", { ...id, status: "sent" }),
    ).toBe(1);
    expect(valueOf(samples, "mailo_claimed_jobs_total", id)).toBe(1);
    expect(
      valueOf(samples, "mailo_claim_polls_total", { result: "claimed" }),
    ).toBe(1);
    await waitMetric("mailo_claim_polls_total", { result: "empty" });
    // 실패 분류는 없다.
    expect(
      samples.filter((s) => s.name === "mailo_attempt_errors_total"),
    ).toEqual([]);
    expect(valueOf(samples, "mailo_metrics_dropped_samples_total")).toBe(0);
    expect(valueOf(samples, "mailo_worker_state", { state: "running" })).toBe(
      1,
    );
    expect(duplicateSeries(samples)).toEqual([]);
  });

  it("일시 오류(451): attempts(transient)와 attempt_errors(data·none)가 오르고 종결은 오르지 않는다", async () => {
    await startApp();
    fake.behavior.data = () => ({
      code: 451,
      text: "4.3.0 Temporary failure.",
    });

    const { jobId } = await submit("m-transient");
    await waitStatus(jobId, "RETRY_WAIT");
    const samples = await waitMetric("mailo_attempt_errors_total", {
      result: "transient",
    });

    expect(
      valueOf(samples, "mailo_attempts_total", {
        caller_id: "alpha",
        result: "transient",
      }),
    ).toBe(1);
    expect(
      valueOf(samples, "mailo_attempt_errors_total", {
        account_id: "default",
        result: "transient",
        stage: "data",
        reason: "none",
      }),
    ).toBe(1);
    expect(
      samples.filter((s) => s.name === "mailo_jobs_finished_total"),
    ).toEqual([]);
  });

  it("영구 오류(550): attempts(permanent)와 finished(failed)가 오른다", async () => {
    await startApp();
    fake.behavior.data = () => ({ code: 550, text: "5.1.1 User unknown." });

    const { jobId } = await submit("m-permanent");
    await waitStatus(jobId, "FAILED");
    const samples = await waitMetric("mailo_jobs_finished_total", {
      status: "failed",
    });

    expect(
      valueOf(samples, "mailo_attempts_total", { result: "permanent" }),
    ).toBe(1);
    expect(
      valueOf(samples, "mailo_jobs_finished_total", {
        caller_id: "alpha",
        status: "failed",
      }),
    ).toBe(1);
    expect(
      valueOf(samples, "mailo_attempt_errors_total", {
        result: "permanent",
        stage: "data",
        reason: "none",
      }),
    ).toBe(1);
  });

  it("계정 상태 오류(일일 한도): attempts(account)와 attempt_errors의 reason이 daily_limit이다", async () => {
    await startApp();
    fake.behavior.mailFrom = () => ({
      code: 550,
      text: "5.4.5 Daily user sending limit exceeded.",
    });

    const { jobId } = await submit("m-account");
    await waitStatus(jobId, "RETRY_WAIT");
    const samples = await waitMetric("mailo_attempt_errors_total", {
      result: "account",
    });

    expect(
      valueOf(samples, "mailo_attempts_total", { result: "account" }),
    ).toBe(1);
    expect(
      valueOf(samples, "mailo_attempt_errors_total", {
        result: "account",
        stage: "mail_from",
        reason: "daily_limit",
      }),
    ).toBe(1);
    // 차단기 상태는 전역 gauge로 나온다.
    expect(valueOf(samples, "mailo_breaker_state", { state: "open" })).toBe(1);
    expect(
      samples.find((s) => s.name === "mailo_breaker_reason_info")?.labels[
        "reason"
      ],
    ).toBe("QUOTA_DAILY");
  });

  it("Mailo 내부 오류: attempts와 attempt_errors가 internal·worker로 오른다", async () => {
    const throwing: MailSender = {
      send: () => Promise.reject(new Error(`내부 오류 ${CANARY.text}`)),
    };
    await startApp(throwing);

    const { jobId } = await submit("m-internal");
    await waitStatus(jobId, "RETRY_WAIT");
    const samples = await waitMetric("mailo_attempt_errors_total", {
      result: "internal",
    });

    expect(
      valueOf(samples, "mailo_attempts_total", { result: "internal" }),
    ).toBe(1);
    expect(
      valueOf(samples, "mailo_attempt_errors_total", {
        result: "internal",
        stage: "worker",
        reason: "none",
      }),
    ).toBe(1);
    expect(JSON.stringify(samples)).not.toContain(CANARY.text);
  });

  it("lease 회수: 결과를 기록하지 못한 작업을 새 Worker가 회수하면 lease_recovered가 오른다", async () => {
    let real: MailSender | undefined;
    const dying: MailSender = {
      async send(message, options) {
        real ??= createSmtpSender(toSenderConfig(app!.config, fake.ca));
        await real.send(message, options);
        throw new SmtpAbortedError();
      },
    };
    await startApp(dying);
    const { jobId } = await submit("m-lease");
    await waitFor(async () => fake.messages.length === 1);
    await waitFor(async () => (await status(jobId)) === "SENDING");
    await sleep(200);
    await app!.close();
    await pool.query(
      "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
      [jobId],
    );

    await startApp();
    await waitStatus(jobId, "RETRY_WAIT");
    const samples = await waitMetric("mailo_lease_recovered_total", {
      account_id: "default",
    });

    expect(
      valueOf(samples, "mailo_lease_recovered_total", {
        account_id: "default",
      }),
    ).toBe(1);
    // RETRY_WAIT로 돌아간 회수는 종결이 아니다.
    expect(
      samples.filter((s) => s.name === "mailo_jobs_finished_total"),
    ).toEqual([]);
  });

  it("만료 sweep: 만료된 대기 작업이 EXPIRED가 되면 finished(expired)가 오른다", async () => {
    app = await startRestApp({ pool, env: env() });
    const { jobId } = await submit("m-expire");
    await app.close();
    await pool.query(
      "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = $1",
      [jobId],
    );

    await startApp();
    await waitStatus(jobId, "EXPIRED");
    const samples = await waitMetric("mailo_jobs_finished_total", {
      status: "expired",
    });

    expect(
      valueOf(samples, "mailo_jobs_finished_total", {
        caller_id: "alpha",
        status: "expired",
      }),
    ).toBe(1);
  });

  it("취소: 호출처 취소와 관리 토큰 취소가 finished(canceled)를 올리고 멱등 반복은 올리지 않는다", async () => {
    // Worker 없이 띄워 취소가 점유보다 먼저가 되게 한다.
    app = await startRestApp({ pool, env: env() });
    const first = await submit("m-cancel-1");
    const second = await submit("m-cancel-2");

    const byCaller = () =>
      fetch(`${app!.baseUrl}/jobs/${first.jobId}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ALPHA_KEY}` },
      });
    const byAdmin = () =>
      fetch(`${app!.baseUrl}/ops/jobs/${second.jobId}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN}` },
      });
    expect((await byCaller()).status).toBe(200);
    expect((await byCaller()).status).toBe(200); // 멱등 반복
    expect((await byAdmin()).status).toBe(200);
    expect((await byAdmin()).status).toBe(200); // 멱등 반복

    const samples = await scrape();
    expect(
      valueOf(samples, "mailo_jobs_finished_total", {
        caller_id: "alpha",
        status: "canceled",
      }),
    ).toBe(2);
  });

  it("이벤트 피드 cursor 공백: 공백을 감지한 요청마다 event_cursor_gap_total이 오른다", async () => {
    app = await startRestApp({ pool, env: env() });
    // 보존 삭제로 cursor 뒤의 이벤트가 사라진 상태를 만든다(rest-event-gap과 같은 방식).
    const { recordJobEvent, encodeCursor } =
      await import("../../src/events/index.js");
    const { deleteExpiredRecords } = await import("../../src/queue/index.js");
    const place = async (key: string, ageDays: number): Promise<string> => {
      const { jobId } = await submit(key);
      await pool.query(
        `UPDATE mail_jobs SET status = 'SENT', finished_at = now() - make_interval(days => $2)
          WHERE id = $1`,
        [jobId, ageDays],
      );
      await recordJobEvent(pool, {
        type: "JOB_SENT",
        callerId: "alpha",
        jobId,
        idempotencyKey: key,
        attemptCount: 1,
        recipients: { to: ["kim@example.com"] },
      });
      const { rows } = await pool.query<{ id: string; txid: string }>(
        "SELECT id::text AS id, txid::text AS txid FROM mail_events WHERE job_id = $1",
        [jobId],
      );
      return encodeCursor({ txid: rows[0]!.txid, id: rows[0]!.id });
    };
    const cursor = await place("m-gap-kept", 29);
    await place("m-gap-deleted", 40);
    await deleteExpiredRecords(pool, 30 * 86_400);

    const res = await getJson(app, `/events?after=${cursor}`);
    await res.text();
    expect(res.headers.get("mailo-cursor-gap")).toBe("true");

    const samples = await scrape();
    expect(
      valueOf(samples, "mailo_event_cursor_gap_total", { caller_id: "alpha" }),
    ).toBe(1);
  });

  it("파일 채널: 등록·중복·거부 파일 수가 result별로 오르고 파일 이름은 라벨에 없다", async () => {
    mkdirSync(path.join(root, "inbox", "alpha"), { recursive: true });
    await startApp(undefined, {}, true);
    const drop = (name: string, content: string) => {
      const dir = path.join(root, "inbox", "alpha");
      writeFileSync(path.join(dir, `.${name}.tmp`), content);
      renameSync(path.join(dir, `.${name}.tmp`), path.join(dir, name));
    };
    const request = JSON.stringify(
      fileRequest({
        idempotencyKey: "m-file-1",
        to: ["kim@example.com"],
        subject: "파일 채널 안내",
        text: "본문",
      }),
    );

    drop(`${CANARY.field}-a.json`, request);
    await waitMetric("mailo_file_channel_files_total", {
      caller_id: "alpha",
      result: "registered",
    });
    drop(`${CANARY.field}-b.json`, request); // 같은 Key, 같은 내용 -> 중복
    await waitMetric("mailo_file_channel_files_total", {
      caller_id: "alpha",
      result: "duplicate",
    });
    drop(`${CANARY.field}-c.json`, "이건 JSON이 아니다");
    const samples = await waitMetric("mailo_file_channel_files_total", {
      caller_id: "alpha",
      result: "rejected",
    });

    for (const result of ["registered", "duplicate", "rejected"])
      expect(
        valueOf(samples, "mailo_file_channel_files_total", {
          caller_id: "alpha",
          result,
        }),
      ).toBe(1);
    expect(valueOf(samples, "mailo_file_poller_enabled")).toBe(1);
    expect(valueOf(samples, "mailo_file_poller_running")).toBe(1);
    expect(valueOf(samples, "mailo_file_poller_callers")).toBe(1);
    expect(JSON.stringify(samples)).not.toContain(CANARY.field);
  });

  it("호출처 시크릿·본문 canary가 어떤 지표에도 나오지 않는다(RQ-027)", async () => {
    await startApp();
    fake.behavior.rcpt = (address) => ({
      code: 550,
      text: `5.1.1 <${address}> ${CANARY.text} unknown`,
    });

    const { jobId } = await submit(
      CANARY.key,
      plainMail({
        to: [`${CANARY.recipient}@example.com`],
        subject: CANARY.subject,
        text: CANARY.text,
      }),
    );
    await waitStatus(jobId, "FAILED");
    const samples = await waitMetric("mailo_jobs_finished_total", {
      status: "failed",
    });
    const text = JSON.stringify(samples);

    for (const secret of [
      CANARY.subject,
      CANARY.text,
      CANARY.recipient,
      CANARY.key,
      CANARY.smtpPassword,
      jobId,
      READ,
      ADMIN,
      ALPHA_KEY,
    ])
      expect(text).not.toContain(secret);
    expect(
      samples
        .filter((s) => s.name === "mailo_attempt_errors_total")
        .map((s) => s.labels["stage"]),
    ).toEqual(["rcpt"]);
  });
});
