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
import { createSmtpSender, SmtpAbortedError } from "../../src/smtp/index.js";
import type { MailSender } from "../../src/smtp/index.js";
import { toSenderConfig } from "../../src/worker/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp.js";
import { migrate, pastDue } from "../support/queue-fixtures.js";
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
 * end-to-end: 실제 HTTP -> PostgreSQL -> 설정으로 조립한 Worker -> 로컬 smtp-server(실제 nodemailer, STARTTLS).
 * 근거: RQ-001·005·007·009·010·011·013·016·025·027, ADR-0002 결정 5·12, ADR-0005·0006.
 * Worker는 `createApp({ worker })`가 만든 것이다. 테스트가 직접 조립하지 않는다.
 */

interface JobBody {
  jobId: string;
  status: string;
  attempts: number;
  failureReason: string | null;
  lastError: { smtpCode: number | null } | null;
}
interface EventsBody {
  events: Array<{
    type: string;
    jobId: string;
    idempotencyKey: string;
    failureReason?: string | null;
    recipients: { to: string[] };
  }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("e2e: POST /jobs -> PostgreSQL -> Worker -> SMTP -> 조회·이벤트", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let fake: FakeSmtp;
  let app: RestApp | undefined;

  const smtpEnv = () => ({
    MAILO_SMTP_HOST: fake.host,
    MAILO_SMTP_PORT: String(fake.port),
    MAILO_SMTP_USER: "fake-user@example.invalid",
    MAILO_WORKER_POLL_MS: "50",
    MAILO_MAINTENANCE_INTERVAL_SECONDS: "1",
  });

  async function startApp(
    sender?: MailSender,
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<RestApp> {
    app = await startRestApp({
      pool,
      env: { ...smtpEnv(), ...extraEnv },
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

  async function events(): Promise<EventsBody["events"]> {
    const res = await getJson(app!, "/events");
    expect(res.status).toBe(200);
    return ((await res.json()) as EventsBody).events;
  }

  async function submit(
    key: string,
    body: Record<string, unknown> = plainMail(),
  ) {
    const res = await postJob(app!, { key, body });
    return { res, json: (await res.json()) as JobBody };
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
    await pool.query("DELETE FROM mail_events");
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
  });

  it("등록한 메일이 SMTP로 나가 SENT가 되고, GET /jobs/{id}와 GET /events(JOB_SENT)에 반영된다", async () => {
    await startApp();

    const { res, json } = await submit(
      "e2e-ok",
      plainMail({
        to: ["kim@example.com"],
        subject: "주문 접수 안내",
        text: "주문이 접수되었습니다.",
        html: "<p>접수</p>",
      }),
    );
    expect(res.status).toBe(202);
    const sent = await waitStatus(json.jobId, "SENT");

    expect(sent.attempts).toBe(1);
    expect(fake.messages).toHaveLength(1);
    const mail = fake.messages[0]!;
    expect(mail.secure).toBe(true); // STARTTLS 필수(RQ-005)
    expect(mail.mailFrom).toBe("no-reply@example.com");
    expect(mail.rcptTo).toEqual(["kim@example.com"]);
    // 본문은 base64 부분으로 나간다. 디코딩해 확인한다.
    const base64Parts = mail.raw.match(/^[A-Za-z0-9+/=]{16,}$/gm) ?? [];
    const decoded = base64Parts.map((p) =>
      Buffer.from(p, "base64").toString("utf8"),
    );
    expect(decoded).toContain("주문이 접수되었습니다.");
    expect(decoded).toContain("<p>접수</p>");
    expect(fake.lastAuth.user).toBe("fake-user@example.invalid");

    const feed = await waitFor(async () => {
      const all = await events();
      return all.length > 0 ? all : undefined;
    });
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      type: "JOB_SENT",
      jobId: json.jobId,
      idempotencyKey: "e2e-ok",
      recipients: { to: ["kim@example.com"] },
    });
  });

  it("from을 생략한 요청은 기본 발신 주소(MAILO_SMTP_FROM 없으면 MAILO_SMTP_USER)로 나간다", async () => {
    // 테스트 기본값 MAILO_SMTP_FROM을 비워 MAILO_SMTP_USER가 기본 발신 주소가 되게 한다.
    await startApp(undefined, { MAILO_SMTP_FROM: "" });
    const { from: _omitted, ...withoutFrom } = plainMail();

    const { json } = await submit("e2e-default-from", withoutFrom);
    await waitStatus(json.jobId, "SENT");

    expect(fake.messages[0]!.mailFrom).toBe("fake-user@example.invalid");
  });

  it("같은 Idempotency-Key를 다시 보내면 200과 같은 작업이 오고 메일은 1통만 나간다 (RQ-011)", async () => {
    await startApp();

    const first = await submit("e2e-dup");
    const second = await submit("e2e-dup");
    await waitStatus(first.json.jobId, "SENT");
    const third = await submit("e2e-dup"); // SENT 뒤 재요청도 새 발송이 아니다
    await sleep(300);

    expect([first.res.status, second.res.status, third.res.status]).toEqual([
      202, 200, 200,
    ]);
    expect(second.json.jobId).toBe(first.json.jobId);
    expect(third.json.jobId).toBe(first.json.jobId);
    expect(fake.messages).toHaveLength(1);
    expect(fake.counts.datas).toBe(1);
    expect((await events()).filter((e) => e.type === "JOB_SENT")).toHaveLength(
      1,
    );
  });

  it("PENDING 작업이 있는 채 앱을 닫고 새 앱을 띄우면 작업이 남아 있고, 같은 Key 재요청은 중복 등록되지 않으며, 새 Worker가 이어서 한 통만 보낸다 (RQ-012·018)", async () => {
    // Worker 없이 기동한 앱: 등록만 하고 발송하지 않는다.
    app = await startRestApp({ pool, env: smtpEnv() });
    const first = await submit("e2e-restart");
    expect(first.res.status).toBe(202);
    expect(first.json.status).toBe("PENDING");
    await app.close();
    app = undefined;
    // 앱 인스턴스를 닫아도 작업은 DB에 남아 있고 발송은 일어나지 않았다.
    const kept = await pool.query(
      "SELECT status FROM mail_jobs WHERE id = $1",
      [first.json.jobId],
    );
    expect(kept.rows.map((r) => r.status)).toEqual(["PENDING"]);
    expect(fake.messages).toHaveLength(0);

    // 메모리 상태가 없는 새 앱(Worker 켜짐). 같은 Key로 다시 요청한다.
    await startApp();
    const again = await submit("e2e-restart");
    await waitStatus(first.json.jobId, "SENT");

    expect(again.res.status).toBe(200);
    expect(again.json.jobId).toBe(first.json.jobId);
    const count = await pool.query(
      "SELECT count(*)::int AS n FROM mail_jobs WHERE idempotency_key = $1",
      ["e2e-restart"],
    );
    expect(count.rows[0].n).toBe(1);
    expect(fake.messages).toHaveLength(1);
  });

  it("일시 오류(451)는 RETRY_WAIT가 되고 재시도 시각이 되면 다시 보내 SENT가 된다 (RQ-007·009)", async () => {
    await startApp();
    fake.behavior.data = (n) =>
      n === 0 ? { code: 451, text: "4.3.0 Temporary failure." } : undefined;

    const { json } = await submit("e2e-retry");
    const waiting = await waitStatus(json.jobId, "RETRY_WAIT");
    expect(waiting.attempts).toBe(1);
    expect(waiting.lastError).toMatchObject({ smtpCode: 451 });
    expect(await events()).toEqual([]); // 종결 전에는 이벤트가 없다

    await pastDue(pool, json.jobId);
    const sent = await waitStatus(json.jobId, "SENT");

    expect(sent.attempts).toBe(2);
    expect(fake.messages).toHaveLength(1);
    expect(fake.counts.datas).toBe(2);
    const feed = await waitFor(async () => {
      const all = await events();
      return all.length > 0 ? all : undefined;
    });
    expect(feed.map((e) => e.type)).toEqual(["JOB_SENT"]);
  });

  it("취소한 PENDING 작업은 Worker가 켜져도 발송하지 않고 CANCELED·JOB_CANCELED로 남는다 (RQ-040, ADR-0011 결정 4)", async () => {
    // Worker 없이 등록·취소한 뒤 Worker가 있는 앱을 띄운다. 취소가 점유보다 먼저인 경우다.
    app = await startRestApp({ pool, env: smtpEnv() });
    const { json } = await submit("e2e-cancel-pending");
    const canceled = await fetch(`${app.baseUrl}/jobs/${json.jobId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ALPHA_KEY}` },
    });
    expect(canceled.status).toBe(200);
    await app.close();
    app = undefined;

    await startApp();
    await sleep(500);

    const job = await getJob(json.jobId);
    expect(job).toMatchObject({ status: "CANCELED", attempts: 0 });
    expect(fake.messages).toHaveLength(0);
    expect(fake.counts.datas).toBe(0);
    expect((await events()).map((e) => e.type)).toEqual(["JOB_CANCELED"]);
  });

  it("RETRY_WAIT 작업을 취소하면 재시도 시각이 돼도 다시 보내지 않는다 (RQ-040)", async () => {
    await startApp();
    fake.behavior.data = () => ({
      code: 451,
      text: "4.3.0 Temporary failure.",
    });

    const { json } = await submit("e2e-cancel-retry");
    await waitStatus(json.jobId, "RETRY_WAIT");
    const datasBefore = fake.counts.datas;
    const canceled = await fetch(
      `${app!.baseUrl}/jobs/cancel?idempotencyKey=e2e-cancel-retry`,
      { method: "POST", headers: { Authorization: `Bearer ${ALPHA_KEY}` } },
    );
    expect(canceled.status).toBe(200);
    await pastDue(pool, json.jobId);
    await sleep(500);

    expect(await jobRow(json.jobId)).toEqual({
      status: "CANCELED",
      attempts: 1,
    });
    expect(fake.counts.datas).toBe(datasBefore);
    expect((await events()).map((e) => e.type)).toEqual(["JOB_CANCELED"]);
  });

  it("영구 오류(550)는 재시도 없이 FAILED가 되고 JOB_FAILED 이벤트가 남는다 (RQ-009·016)", async () => {
    await startApp();
    fake.behavior.data = () => ({
      code: 550,
      text: "5.7.1 Message likely unsolicited mail.",
    });

    const { json } = await submit("e2e-permanent");
    const failed = await waitStatus(json.jobId, "FAILED");

    expect(failed.failureReason).toBe("PERMANENT_ERROR");
    expect(failed.lastError).toMatchObject({ smtpCode: 550 });
    await sleep(200);
    expect(fake.counts.datas).toBe(1);
    const feed = await waitFor(async () => {
      const all = await events();
      return all.length > 0 ? all : undefined;
    });
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      type: "JOB_FAILED",
      jobId: json.jobId,
      failureReason: "PERMANENT_ERROR",
    });
  });

  it("SMTP가 수락한 직후 결과를 기록하지 못하고 프로세스가 죽으면, 재기동 뒤 같은 메일이 한 번 더 나간다 (at-least-once, RQ-013)", async () => {
    // 프로세스 사망을 흉내 낸다. 실제 발송기로 서버가 수락한 뒤 `SmtpAbortedError`로 끝내면
    // Worker가 결과를 기록하지 않는다. drain 시간 초과로 전송을 끊었을 때와 같은 경로다.
    // 작업은 SENDING과 lease를 가진 채 남는다. 실제 SIGTERM·kill 검증은 Docker 확인에서 한다.
    let real: MailSender | undefined;
    const dyingSender: MailSender = {
      async send(message, options) {
        // 앱이 읽은 설정과 같은 값으로 발송기를 만든다. 첫 전송 시점에는 app이 설정돼 있다.
        real ??= createSmtpSender(toSenderConfig(app!.config, fake.ca));
        await real.send(message, options);
        throw new SmtpAbortedError();
      },
    };
    await startApp(dyingSender);
    const { json } = await submit("e2e-crash");
    await waitFor(async () => fake.messages.length === 1);
    await waitFor(async () => (await jobRow(json.jobId)).status === "SENDING");
    await sleep(200);
    expect(await jobRow(json.jobId)).toMatchObject({
      status: "SENDING",
      attempts: 0,
    });
    await app!.close(); // 첫 프로세스 종료

    // lease 시간이 지났다고 본다(DB 시각 기준이라 lease_until만 당긴다).
    await pool.query(
      "UPDATE mail_jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
      [json.jobId],
    );
    await startApp(); // 재기동: 새 Worker가 lease를 회수한다
    await waitStatus(json.jobId, "RETRY_WAIT");
    await pastDue(pool, json.jobId);
    await waitStatus(json.jobId, "SENT");

    // 서버는 같은 작업의 메일을 두 번 받았다. Message-ID가 같아 수신 측이 중복을 걸러낼 수 있다(ADR-0007 결정 8).
    expect(fake.messages).toHaveLength(2);
    expect(fake.messages[1]!.messageId).toBe(fake.messages[0]!.messageId);
    expect(fake.messages[0]!.messageId).toContain(json.jobId);
    const { rows } = await pool.query(
      "SELECT classification FROM mail_attempts WHERE job_id = $1 ORDER BY id",
      [json.jobId],
    );
    expect(rows.map((r) => r.classification)).toEqual([
      "LEASE_EXPIRED",
      "SENT",
    ]);
    expect((await events()).filter((e) => e.type === "JOB_SENT")).toHaveLength(
      1,
    );
  });

  it("본문·제목·수신자·SMTP 비밀번호·API 키가 어떤 경로의 로그와 시도 기록에도 남지 않는다 (RQ-027)", async () => {
    await startApp();
    const recipient = `${CANARY.recipient}@example.com`;
    const mail = plainMail({
      to: [recipient],
      subject: CANARY.subject,
      text: CANARY.text,
      html: `<p>${CANARY.html}</p>`,
    });
    // 성공, 응답에 수신자 주소가 되풀이되는 일시 오류, 영구 오류를 모두 지난다.
    fake.behavior.rcpt = (address, n) =>
      n === 1
        ? { code: 450, text: `4.2.2 <${address}> mailbox full` }
        : undefined;
    const ok = await submit("e2e-secret-ok", mail);
    await waitStatus(ok.json.jobId, "SENT");
    const transient = await submit("e2e-secret-transient", mail);
    await waitStatus(transient.json.jobId, "RETRY_WAIT");
    fake.behavior.rcpt = (address) => ({
      code: 550,
      text: `5.1.1 <${address}> does not exist`,
    });
    await pastDue(pool, transient.json.jobId);
    await waitStatus(transient.json.jobId, "FAILED");
    await sleep(100);

    const attempts = JSON.stringify(
      (await pool.query("SELECT * FROM mail_attempts")).rows,
    );
    const logs = app!.logs.lines.join("\n");
    for (const canary of [
      CANARY.subject,
      CANARY.text,
      CANARY.html,
      CANARY.recipient,
      CANARY.smtpPassword,
      ALPHA_KEY,
    ]) {
      expect([canary, logs.includes(canary)]).toEqual([canary, false]);
      expect([canary, attempts.includes(canary)]).toEqual([canary, false]);
    }
    // 마스킹된 흔적이 있어 검색이 의미 있다.
    expect(attempts).toContain("[address]");
    expect(logs).toContain('"event":"job_completed"');
  });

  async function jobRow(jobId: string) {
    const { rows } = await pool.query(
      "SELECT status, attempts FROM mail_jobs WHERE id = $1",
      [jobId],
    );
    return rows[0] as { status: string; attempts: number };
  }
});
