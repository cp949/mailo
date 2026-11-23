import "reflect-metadata";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import type pg from "pg";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp.js";
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
 * 평문 SMTP 모드(`MAILO_SMTP_SECURITY=none`)의 종단 확인(RQ-005, RQ-027).
 * 환경: PostgreSQL 전용 schema, 로컬 smtp-server(STARTTLS를 광고하고 평문 AUTH를 받는다).
 * Worker는 `createApp({ worker: {} })`가 설정으로 만든 실제 nodemailer 발송기다. 신뢰 CA는 주지 않는다.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("e2e: 평문 SMTP 모드 발송 (RQ-005, RQ-027)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let fake: FakeSmtp;
  let app: RestApp | undefined;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    await migrate(pool);
    fake = await startFakeSmtp({ allowInsecureAuth: true });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    try {
      await fake.close();
    } finally {
      await db.close();
    }
  });

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

  it("서버가 STARTTLS를 광고해도 평문으로 인증·발송해 SENT가 되고, 기동 warn 로그 한 줄에 인증 정보·본문이 없다", async () => {
    app = await startRestApp({
      pool,
      env: {
        MAILO_SMTP_SECURITY: "none",
        MAILO_SMTP_HOST: fake.host,
        MAILO_SMTP_PORT: String(fake.port),
        MAILO_WORKER_POLL_MS: "50",
      },
      worker: {},
    });
    const recipient = `${CANARY.recipient}@example.com`;
    const res = await postJob(app, {
      key: "plaintext-1",
      body: plainMail({
        to: [recipient],
        subject: CANARY.subject,
        text: CANARY.text,
      }),
    });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };

    await waitFor(async () => {
      const job = (await (await getJson(app!, `/jobs/${jobId}`)).json()) as {
        status: string;
      };
      return job.status === "SENT";
    });

    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]!.secure).toBe(false);
    // testEnv의 SMTP 비밀번호(canary)가 평문 세션으로 서버에 전달됐다.
    expect(fake.lastAuth.password).toBe(CANARY.smtpPassword);

    await sleep(100);
    const logs = app.logs.lines.join("\n");
    const warnings = app.logs.lines.filter((line) =>
      line.includes('"event":"smtp_plaintext_enabled"'),
    );
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0]!)).toMatchObject({
      level: "warn",
      auth: true,
    });
    for (const canary of [
      CANARY.subject,
      CANARY.text,
      CANARY.recipient,
      CANARY.smtpPassword,
      ALPHA_KEY,
    ]) {
      expect([canary, logs.includes(canary)]).toEqual([canary, false]);
    }
  });
});
