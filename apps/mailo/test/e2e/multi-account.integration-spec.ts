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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp.js";
import { migrate } from "../support/queue-fixtures.js";
import {
  ALPHA_KEY,
  BETA_KEY,
  CANARY,
  getJson,
  plainMail,
  postJob,
  startRestApp,
  type RestApp,
} from "../support/rest-app.js";

/**
 * end-to-end: 호출처가 계정 하나를 쓰고 작업이 등록 때 계정을 고정한다(RQ-054·055·056, ADR-0013 결정 1·2·6).
 * 실제 HTTP -> PostgreSQL -> 설정으로 조립한 Worker -> 가짜 SMTP 서버 둘(실제 nodemailer, STARTTLS).
 * 계정 `default`(환경 변수)는 서버 A로, 계정 `marketing`(계정 파일)은 서버 B로 간다.
 * alpha는 `default`, beta는 `marketing`을 쓴다. 묶음 A는 한 점유 루프가 모든 계정의 작업을 처리한다.
 */

const DEFAULT_FROM = "no-reply@example.com";
const MARKETING_FROM = "marketing@marketing.example.net";
const MARKETING_USER = "marketing-login@example.invalid";
const DEFAULT_USER = "default-login@example.invalid";
const MARKETING_PASSWORD = "CANARY-MARKETING-PASSWORD-77aa";
const OPS_TOKEN = "ops-read-token-multi-account-0000000000000001";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("e2e: 다중 SMTP 계정 — 계정별 전송·고정·발신 주소 (RQ-054·055, ADR-0013 결정 1·2·6)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let fakeA: FakeSmtp;
  let fakeB: FakeSmtp;
  let dir: string;
  let app: RestApp | undefined;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    await migrate(pool);
    fakeA = await startFakeSmtp();
    fakeB = await startFakeSmtp();
    dir = mkdtempSync(path.join(tmpdir(), "mailo-multi-account-"));
  });

  afterAll(async () => {
    await fakeA.close();
    await fakeB.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM mail_jobs");
    fakeA.reset();
    fakeB.reset();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function accountsFile(accounts: unknown[] = [marketingAccount()]): string {
    const file = path.join(dir, `accounts-${Date.now()}-${Math.random()}.json`);
    writeFileSync(file, JSON.stringify({ accounts }));
    return file;
  }

  function marketingAccount(overrides: Record<string, unknown> = {}) {
    return {
      id: "marketing",
      host: fakeB.host,
      port: fakeB.port,
      auth: {
        user: MARKETING_USER,
        secretVar: "MAILO_SMTP_SECRET_MARKETING",
      },
      from: MARKETING_FROM,
      ...overrides,
    };
  }

  /** `default`는 서버 A(환경 변수), 파일 계정 `marketing`은 서버 B다. */
  async function startApp(
    options: {
      worker?: boolean;
      accounts?: unknown[] | null;
      callers?: Record<string, Record<string, unknown>>;
      env?: NodeJS.ProcessEnv;
    } = {},
  ): Promise<RestApp> {
    const useFile = options.accounts !== null;
    app = await startRestApp({
      pool,
      env: {
        MAILO_SMTP_HOST: fakeA.host,
        MAILO_SMTP_PORT: String(fakeA.port),
        MAILO_SMTP_USER: DEFAULT_USER,
        MAILO_SMTP_FROM: DEFAULT_FROM,
        MAILO_WORKER_POLL_MS: "50",
        MAILO_MAINTENANCE_INTERVAL_SECONDS: "1",
        MAILO_OPS_TOKEN: OPS_TOKEN,
        ...(useFile && {
          MAILO_SMTP_ACCOUNTS_FILE: accountsFile(options.accounts ?? undefined),
          MAILO_SMTP_SECRET_MARKETING: MARKETING_PASSWORD,
        }),
        ...options.env,
      },
      callerFields: options.callers ?? { beta: { accountId: "marketing" } },
      ...(options.worker === false ? {} : { worker: { trustedCa: fakeA.ca } }),
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

  async function submit(
    key: string,
    auth: string,
    body: Record<string, unknown> = plainMail(),
  ): Promise<{ status: number; json: { jobId: string } }> {
    const res = await postJob(app!, { key, auth, body });
    return {
      status: res.status,
      json: (await res.json()) as { jobId: string },
    };
  }

  const statusOf = async (jobId: string) =>
    (
      await pool.query<{ status: string; account_id: string }>(
        "SELECT status, account_id FROM mail_jobs WHERE id = $1",
        [jobId],
      )
    ).rows[0]!;

  const waitSent = (jobId: string) =>
    waitFor(async () => (await statusOf(jobId)).status === "SENT");

  it("호출처가 쓰는 계정의 SMTP 서버·자격증명·MAIL FROM으로 전송하고 다른 서버에는 가지 않는다", async () => {
    await startApp();

    const alpha = await submit("acct-alpha", ALPHA_KEY);
    const beta = await submit(
      "acct-beta",
      BETA_KEY,
      plainMail({ from: MARKETING_FROM }),
    );
    await waitSent(alpha.json.jobId);
    await waitSent(beta.json.jobId);

    expect(fakeA.messages).toHaveLength(1);
    expect(fakeB.messages).toHaveLength(1);
    // 서버 A: 환경 변수 default 계정
    expect(fakeA.messages[0]!.mailFrom).toBe(DEFAULT_FROM);
    // 서버 B: 파일 marketing 계정. 자격증명과 MAIL FROM, Message-ID 도메인이 모두 이 계정 것이다.
    expect(fakeB.messages[0]!.mailFrom).toBe(MARKETING_FROM);
    expect(fakeB.lastAuth).toEqual({
      user: MARKETING_USER,
      password: MARKETING_PASSWORD,
    });
    expect(fakeB.messages[0]!.messageId).toContain("@marketing.example.net");
    expect(fakeA.messages[0]!.messageId).toContain("@example.com");
    // 작업 행과 시도 기록이 계정을 가진다.
    expect((await statusOf(alpha.json.jobId)).account_id).toBe("default");
    expect((await statusOf(beta.json.jobId)).account_id).toBe("marketing");
    const attempts = await pool.query(
      "SELECT j.account_id AS job_account, a.account_id AS attempt_account FROM mail_attempts a JOIN mail_jobs j ON j.id = a.job_id ORDER BY a.id",
    );
    expect(
      attempts.rows.every((r) => r.job_account === r.attempt_account),
    ).toBe(true);
  });

  it("from을 생략하면 작업 계정의 from으로 나간다(계정마다 다른 기본 발신 주소)", async () => {
    await startApp();

    const alpha = await submit(
      "acct-omit-a",
      ALPHA_KEY,
      plainMail({ from: undefined }),
    );
    const beta = await submit(
      "acct-omit-b",
      BETA_KEY,
      plainMail({ from: undefined }),
    );
    await waitSent(alpha.json.jobId);
    await waitSent(beta.json.jobId);

    expect(fakeA.messages[0]!.mailFrom).toBe(DEFAULT_FROM);
    expect(fakeB.messages[0]!.mailFrom).toBe(MARKETING_FROM);
  });

  describe("발신 주소 허용 집합 {계정 from} ∪ allowedFrom (RQ-055, ADR-0013 결정 6)", () => {
    interface ValidationBody {
      type: string;
      errors?: Array<{ pointer: string; code: string }>;
    }

    it("호출처 계정의 from은 허용하고 다른 계정의 from은 거부한다", async () => {
      await startApp({ worker: false });

      const own = await submit(
        "from-own",
        BETA_KEY,
        plainMail({ from: MARKETING_FROM }),
      );
      const other = await postJob(app!, {
        key: "from-other",
        auth: BETA_KEY,
        body: plainMail({ from: DEFAULT_FROM }),
      });

      expect(own.status).toBe(202);
      expect(other.status).toBe(400);
      const body = (await other.json()) as ValidationBody;
      expect(body.errors).toEqual([
        { pointer: "/from", code: "FROM_NOT_ALLOWED" },
      ]);
      // 거부 응답에 어느 주소도 되풀이하지 않는다(RQ-027).
      expect(JSON.stringify(body)).not.toContain("example.com");
      expect(JSON.stringify(body)).not.toContain("marketing.example.net");
    });

    it("default 계정을 쓰는 호출처는 default 계정 from을 허용하고 marketing from은 거부한다", async () => {
      await startApp({ worker: false });

      const own = await submit(
        "from-alpha-own",
        ALPHA_KEY,
        plainMail({ from: DEFAULT_FROM }),
      );
      const other = await postJob(app!, {
        key: "from-alpha-other",
        auth: ALPHA_KEY,
        body: plainMail({ from: MARKETING_FROM }),
      });

      expect(own.status).toBe(202);
      expect(other.status).toBe(400);
    });

    it("allowedFrom은 호출처 계정의 from에 더해 허용된다", async () => {
      await startApp({
        worker: false,
        callers: {
          beta: {
            accountId: "marketing",
            allowedFrom: ["Alias@Marketing.Example.Net"],
          },
        },
      });

      const alias = await submit(
        "from-alias",
        BETA_KEY,
        plainMail({ from: "alias@marketing.example.net" }),
      );
      const base = await submit(
        "from-base",
        BETA_KEY,
        plainMail({ from: MARKETING_FROM }),
      );

      expect(alias.status).toBe(202);
      expect(base.status).toBe(202);
    });

    it("이미 등록된 Key의 재전송은 호출처의 계정을 바꾼 뒤에도 기존 작업(200)을 돌려준다", async () => {
      await startApp({ worker: false });
      const first = await submit(
        "from-replay",
        BETA_KEY,
        plainMail({ from: MARKETING_FROM }),
      );
      await app!.close();
      // beta가 default 계정으로 바뀌어 같은 요청의 from(marketing)이 더는 허용 집합에 없다.
      await startApp({
        worker: false,
        callers: { beta: { accountId: "default" } },
      });

      const again = await submit(
        "from-replay",
        BETA_KEY,
        plainMail({ from: MARKETING_FROM }),
      );

      expect(first.status).toBe(202);
      expect(again.status).toBe(200);
      expect(again.json.jobId).toBe(first.json.jobId);
      expect((await statusOf(first.json.jobId)).account_id).toBe("marketing");
    });
  });

  it("등록된 작업의 계정은 이후 레지스트리 변경과 무관하다: 호출처를 default로 옮겨도 이미 등록한 작업은 marketing 서버로 간다(결정 2)", async () => {
    await startApp({ worker: false });
    const job = await submit(
      "pin-1",
      BETA_KEY,
      plainMail({ from: MARKETING_FROM }),
    );
    expect((await statusOf(job.json.jobId)).account_id).toBe("marketing");
    await app!.close();

    // 재기동: 레지스트리에서 beta의 accountId를 뺀다(= default). Worker를 켠다.
    await startApp({ callers: { beta: {} } });
    await waitSent(job.json.jobId);

    expect(fakeB.messages).toHaveLength(1);
    expect(fakeB.messages[0]!.mailFrom).toBe(MARKETING_FROM);
    expect(fakeA.messages).toHaveLength(0);
    expect((await statusOf(job.json.jobId)).account_id).toBe("marketing");
    // 새 요청은 새 매핑(default)을 따른다.
    const next = await submit(
      "pin-2",
      BETA_KEY,
      plainMail({ from: DEFAULT_FROM }),
    );
    await waitSent(next.json.jobId);
    expect(fakeA.messages).toHaveLength(1);
    expect((await statusOf(next.json.jobId)).account_id).toBe("default");
  });

  it("구성에서 사라진 계정의 작업은 점유·전송되지 않고 default로 옮겨지지 않으며 만료 sweep이 EXPIRED로 만든다(결정 2)", async () => {
    await startApp({ worker: false });
    const job = await submit(
      "orphan-1",
      BETA_KEY,
      plainMail({ from: MARKETING_FROM }),
    );
    await app!.close();

    // 계정 파일과 beta의 계정 지정을 모두 뺀다. marketing 작업만 구성 밖에 남는다.
    await startApp({ accounts: null, callers: { beta: {} } });
    await sleep(400);
    expect(await statusOf(job.json.jobId)).toEqual({
      status: "PENDING",
      account_id: "marketing",
    });
    await pool.query(
      "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = $1",
      [job.json.jobId],
    );
    await waitFor(
      async () => (await statusOf(job.json.jobId)).status === "EXPIRED",
    );

    expect(fakeA.messages).toHaveLength(0);
    expect(fakeB.messages).toHaveLength(0);
    const events = await pool.query(
      "SELECT type FROM mail_events WHERE job_id = $1",
      [job.json.jobId],
    );
    expect(events.rows).toEqual([{ type: "JOB_EXPIRED" }]);
    // 기동 때 구성 밖 계정의 비종결 작업을 경고한다. 계정 ID와 건수만 담는다.
    const orphan = app!.logs.lines
      .filter((l) => l.includes("account_orphan_jobs"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(orphan).toHaveLength(1);
    expect(orphan[0]).toMatchObject({
      level: "warn",
      event: "account_orphan_jobs",
      accountId: "marketing",
      count: 1,
    });
  });

  it("기동 때 구성한 계정마다 차단기 행을 만든다(ADR-0013 결정 3 나)", async () => {
    await pool.query(
      "DELETE FROM mail_circuit_breaker WHERE breaker_key <> 'default'",
    );

    await startApp();

    const { rows } = await pool.query(
      "SELECT breaker_key, state FROM mail_circuit_breaker ORDER BY breaker_key",
    );
    expect(rows).toEqual([
      { breaker_key: "default", state: "closed" },
      { breaker_key: "marketing", state: "closed" },
    ]);
  });

  describe("레지스트리와 구성의 어긋남은 기동을 거부한다(RQ-054, ADR-0013 결정 2)", () => {
    it("호출처가 구성에 없는 계정을 가리키면 앱이 뜨지 않고 오류에 계정 이름 목록을 싣지 않는다", async () => {
      const failure = await startApp({
        worker: false,
        callers: { beta: { accountId: "ghost" } },
      }).then(
        () => undefined,
        (error: unknown) => error as Error,
      );

      expect(failure).toBeDefined();
      expect(failure!.message).toContain("accountId가 구성에 없는 SMTP 계정");
      expect(failure!.message).not.toContain("marketing");
    });

    it("default 계정이 없는데 accountId를 생략한 호출처가 있으면 앱이 뜨지 않는다", async () => {
      const failure = await startApp({
        worker: false,
        env: {
          MAILO_SMTP_HOST: "",
          MAILO_SMTP_PORT: "",
          MAILO_SMTP_USER: "",
          MAILO_SMTP_PASSWORD: "",
          MAILO_SMTP_FROM: "",
        },
        callers: { alpha: {}, beta: { accountId: "marketing" } },
      }).then(
        () => undefined,
        (error: unknown) => error as Error,
      );

      expect(failure?.message).toContain("default 계정이 없다");
    });
  });

  describe("호출처에는 계정이 보이지 않는다(결정 6)", () => {
    it("작업 조회·이벤트 응답에 계정 필드와 계정 값이 없다", async () => {
      await startApp();
      const beta = await submit(
        "hide-1",
        BETA_KEY,
        plainMail({ from: MARKETING_FROM }),
      );
      await waitSent(beta.json.jobId);

      const job = await getJson(app!, `/jobs/${beta.json.jobId}`, BETA_KEY);
      const events = await getJson(app!, "/events", BETA_KEY);
      const text = JSON.stringify([await job.json(), await events.json()]);

      expect(text).not.toMatch(/account/i);
      expect(text).not.toContain("marketing");
    });

    it("요청이 계정 필드를 보내면 모르는 필드로 거부한다(호출처는 계정을 고르지 못한다)", async () => {
      await startApp({ worker: false });

      const res = await postJob(app!, {
        key: "hide-2",
        auth: BETA_KEY,
        body: plainMail({ accountId: "default" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: Array<{ code: string }> };
      expect(body.errors?.map((e) => e.code)).toContain("UNKNOWN_FIELD");
    });
  });

  describe("시크릿 비노출(RQ-027·056, ADR-0013 결정 6)", () => {
    it("계정 비밀번호·사용자·호스트가 로그·헬스·지표·오류 응답 어디에도 없다", async () => {
      await startApp({
        env: { MAILO_SMTP_PASSWORD: CANARY.smtpPassword },
      });
      const sent = await submit(
        "secret-1",
        BETA_KEY,
        plainMail({ from: MARKETING_FROM }),
      );
      await waitSent(sent.json.jobId);
      await submit("secret-2", ALPHA_KEY);
      const surfaces: string[] = [];
      for (const [pathName, auth] of [
        ["/health/ready", null],
        ["/health/ready", BETA_KEY],
        ["/health/ready", OPS_TOKEN],
        ["/metrics", OPS_TOKEN],
      ] as const) {
        const res = await getJson(app!, pathName, auth);
        surfaces.push(await res.text());
      }
      // 오류 응답: 모르는 필드, 허용되지 않은 발신 주소
      surfaces.push(
        await (
          await postJob(app!, {
            key: "secret-3",
            auth: BETA_KEY,
            body: plainMail({ from: DEFAULT_FROM, weird: 1 }),
          })
        ).text(),
      );
      await sleep(150);

      const all = [...surfaces, ...app!.logs.lines].join("\n");
      for (const canary of [
        MARKETING_PASSWORD,
        CANARY.smtpPassword,
        MARKETING_USER,
        DEFAULT_USER,
        "marketing-login",
      ]) {
        expect(all).not.toContain(canary);
      }
      // 가짜 SMTP가 받은 값은 실제로 이 canary다(검색이 의미 있다는 확인).
      expect(fakeB.lastAuth.password).toBe(MARKETING_PASSWORD);
    });
  });
});
