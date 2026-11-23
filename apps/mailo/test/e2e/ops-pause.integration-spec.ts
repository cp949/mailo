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
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp.js";
import { migrate } from "../support/queue-fixtures.js";
import {
  ALPHA_KEY,
  BETA_KEY,
  getJson,
  plainMail,
  postJob,
  startRestApp,
  type RestApp,
} from "../support/rest-app.js";

// 테스트용 가짜 토큰이다. 실제 시크릿이 아니다.
const ADMIN = "ops-admin-oncall-fake-token-000000000000001";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * end-to-end: `/ops` 정지 → 실제 Worker(`createApp({ worker })`) → 로컬 SMTP(RQ-043, ADR-0011 결정 2·3).
 * 정지 중에는 메일이 나가지 않고, 정지 중 등록은 받으며, 재개하면 쌓인 작업이 나간다.
 * 호출처 정지는 다른 호출처의 발송을 막지 않는다.
 */
describe("e2e: 발송 정지·재개 REST → Worker → SMTP (RQ-043)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let fake: FakeSmtp;
  let app: RestApp | undefined;

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
    app = await startRestApp({
      pool,
      env: {
        MAILO_SMTP_HOST: fake.host,
        MAILO_SMTP_PORT: String(fake.port),
        MAILO_SMTP_USER: "fake-user@example.invalid",
        MAILO_WORKER_POLL_MS: "50",
        MAILO_MAINTENANCE_INTERVAL_SECONDS: "1",
        MAILO_OPS_ADMIN_NAMES: "oncall",
        MAILO_OPS_ADMIN_TOKEN_ONCALL: ADMIN,
      },
      worker: { trustedCa: fake.ca },
    });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const ops = (method: string, route: string) =>
    fetch(`${app!.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${ADMIN}` },
    });

  async function submit(key: string, auth = ALPHA_KEY): Promise<string> {
    const res = await postJob(app!, { key, auth, body: plainMail() });
    expect(res.status).toBe(202);
    return ((await res.json()) as { jobId: string }).jobId;
  }

  async function statusOf(id: string, auth = ALPHA_KEY): Promise<string> {
    const res = await getJson(app!, `/jobs/${id}`, auth);
    return ((await res.json()) as { status: string }).status;
  }

  async function waitStatus(id: string, status: string, auth = ALPHA_KEY) {
    const started = Date.now();
    while ((await statusOf(id, auth)) !== status) {
      if (Date.now() - started > 10_000) throw new Error("waitFor 시간 초과");
      await sleep(25);
    }
  }

  it("전체 정지 중에는 발송하지 않고 등록은 받으며, 재개하면 쌓인 작업이 발송된다", async () => {
    expect((await ops("PUT", "/ops/pauses/all")).status).toBe(200);

    const id = await submit("paused-all");
    await sleep(400);

    expect(await statusOf(id)).toBe("PENDING");
    expect(fake.messages).toHaveLength(0);

    expect((await ops("DELETE", "/ops/pauses/all")).status).toBe(200);
    await waitStatus(id, "SENT");

    expect(fake.messages).toHaveLength(1);
  });

  it("호출처 정지는 그 호출처만 멈추고 재개하면 발송한다. 다른 호출처는 계속 발송한다", async () => {
    await ops("PUT", "/ops/pauses/callers/alpha");

    const alpha = await submit("paused-alpha", ALPHA_KEY);
    const beta = await submit("not-paused-beta", BETA_KEY);
    await waitStatus(beta, "SENT", BETA_KEY);
    await sleep(300);

    expect(await statusOf(alpha)).toBe("PENDING");
    expect(fake.messages).toHaveLength(1);

    await ops("DELETE", "/ops/pauses/callers/alpha");
    await waitStatus(alpha, "SENT");
    expect(fake.messages).toHaveLength(2);
  });
});
