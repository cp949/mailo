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
import { migrate } from "../support/queue-fixtures.js";
import {
  ACCOUNT_CANARY_VALUES,
  OPS_ADMIN,
  OPS_READ,
  opsFetch,
  startAccountsApp,
  type AccountsApp,
} from "../support/accounts-app.js";
import {
  ALPHA_KEY,
  BETA_KEY,
  getJson,
  plainMail,
  postJob,
} from "../support/rest-app.js";

interface AccountsBody {
  accounts: Array<{
    accountId: string;
    breaker: {
      state: string;
      openUntil: string | null;
      lastReason: string | null;
    };
    paused: boolean;
    sendQuota24h: { limit: number; used: number } | null;
    queue: {
      dueCount: number;
      dueCountTruncated: boolean;
      oldestDueAgeSeconds: number | null;
    };
  }>;
}

describe("GET /ops/accounts: 계정별 운영 상태 (RQ-060, ADR-0013 결정 5)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let app: AccountsApp | undefined;

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
    await pool.query("DELETE FROM mail_send_controls");
    await pool.query(
      "DELETE FROM mail_circuit_breaker WHERE breaker_key <> 'default'",
    );
    await pool.query(
      `UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL,
         probe_job_id = NULL, consecutive_failures = 0, wait_seconds = 0, last_reason = NULL,
         last_trip_job_id = NULL, last_trip_token = NULL`,
    );
    app = await startAccountsApp({ pool });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const read = async (token: string | null = OPS_READ) =>
    opsFetch(app!, "GET", "/ops/accounts", token);

  async function accounts(): Promise<AccountsBody["accounts"]> {
    const res = await read();
    expect(res.status).toBe(200);
    return ((await res.json()) as AccountsBody).accounts;
  }

  it("구성한 계정을 구성 순서(default, 파일 순서)로 내고 응답을 캐시하지 않는다", async () => {
    const res = await read();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as AccountsBody;
    expect(body.accounts.map((a) => a.accountId)).toEqual([
      "default",
      "marketing",
    ]);
    expect(body.accounts[0]).toEqual({
      accountId: "default",
      breaker: { state: "closed", openUntil: null, lastReason: null },
      paused: false,
      sendQuota24h: null,
      queue: {
        dueCount: 0,
        dueCountTruncated: false,
        oldestDueAgeSeconds: null,
      },
    });
    expect(body.accounts[1]).toEqual({
      accountId: "marketing",
      breaker: { state: "closed", openUntil: null, lastReason: null },
      paused: false,
      sendQuota24h: { limit: 5, used: 0 },
      queue: {
        dueCount: 0,
        dueCountTruncated: false,
        oldestDueAgeSeconds: null,
      },
    });
  });

  it("관리 토큰도 읽을 수 있고 호출처 키와 토큰 없음은 401이다", async () => {
    expect((await read(OPS_ADMIN)).status).toBe(200);
    expect((await read(null)).status).toBe(401);
    expect((await read(ALPHA_KEY)).status).toBe(401);
    expect((await read("wrong-token")).status).toBe(401);
  });

  it("대기 건수와 가장 오래된 나이는 작업의 계정에 센다", async () => {
    // beta는 marketing 계정, alpha는 default 계정이다.
    for (const key of ["b-1", "b-2"])
      expect(
        (
          await postJob(app!, {
            key,
            auth: BETA_KEY,
            body: plainMail({ from: undefined }),
          })
        ).status,
      ).toBe(202);
    expect(
      (
        await postJob(app!, {
          key: "a-1",
          auth: ALPHA_KEY,
          body: plainMail({ from: undefined }),
        })
      ).status,
    ).toBe(202);
    await pool.query(
      "UPDATE mail_jobs SET next_attempt_at = now() - interval '90 seconds'",
    );

    const [def, marketing] = await accounts();

    expect(def!.queue.dueCount).toBe(1);
    expect(marketing!.queue.dueCount).toBe(2);
    expect(marketing!.queue.oldestDueAgeSeconds).toBeGreaterThanOrEqual(90);
  });

  it("차단기 상태와 정지 여부를 계정별로 낸다. 차단기는 계정마다 독립이다", async () => {
    await pool.query(
      `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() + interval '10 minutes',
         wait_seconds = 600, last_reason = 'AUTH' WHERE breaker_key = 'marketing'`,
    );
    await pool.query(
      `INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('account', 'default', 'oncall')`,
    );

    const [def, marketing] = await accounts();

    expect(def).toMatchObject({
      breaker: { state: "closed", openUntil: null, lastReason: null },
      paused: true,
    });
    expect(marketing!.breaker.state).toBe("open");
    expect(marketing!.breaker.lastReason).toBe("AUTH_FAILED");
    expect(Date.parse(marketing!.breaker.openUntil!)).toBeGreaterThan(
      Date.now(),
    );
    expect(marketing!.paused).toBe(false);
  });

  it("24시간 사용량은 계정의 최근 시도와 점유 중 작업을 센다. 한도를 설정하지 않은 계정은 null이다", async () => {
    const jobId = await registerJob("marketing");
    await pool.query(
      `INSERT INTO mail_attempts (job_id, caller_id, account_id, classification, counted, stage, started_at, finished_at)
       VALUES ($1, 'beta', 'marketing', 'TRANSIENT', true, 'DATA', now() - interval '1 hour', now() - interval '1 hour')`,
      [jobId],
    );
    await pool.query(
      `UPDATE mail_jobs SET status = 'SENDING', lease_token = gen_random_uuid(), lease_until = now() + interval '1 minute', leased_at = now() WHERE id = $1`,
      [jobId],
    );

    const [def, marketing] = await accounts();

    expect(marketing!.sendQuota24h).toEqual({ limit: 5, used: 2 });
    expect(def!.sendQuota24h).toBeNull();
  });

  it("구성에서 빠진 계정은 목록에 없다. 그 계정의 정지 행도 계정 목록에 새지 않는다", async () => {
    await pool.query(
      `INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('account', 'retired', 'oncall')`,
    );

    expect((await accounts()).map((a) => a.accountId)).toEqual([
      "default",
      "marketing",
    ]);
  });

  it("계정 비밀번호·host·user·from·secretVar 이름을 응답과 로그에 내지 않는다 (RQ-027)", async () => {
    const res = await read();
    const text = await res.text();

    for (const value of [...ACCOUNT_CANARY_VALUES, "MAILO_SMTP_SECRET"])
      expect(text).not.toContain(value);
    for (const value of ACCOUNT_CANARY_VALUES)
      expect(app!.logs.lines.join("\n")).not.toContain(value);
  });

  it("OpsJob에 accountId가 있고 호출처의 Job에는 없다 (ADR-0013 결정 5·6)", async () => {
    const jobId = await registerJob("marketing");

    const ops = await opsFetch(app!, "GET", `/ops/jobs/${jobId}`);
    expect(ops.status).toBe(200);
    expect(await ops.json()).toMatchObject({ jobId, accountId: "marketing" });

    const own = await getJson(app!, `/jobs/${jobId}`, BETA_KEY);
    expect(Object.keys((await own.json()) as object)).not.toContain(
      "accountId",
    );
  });

  async function registerJob(
    account: "marketing" | "default",
  ): Promise<string> {
    const res = await postJob(app!, {
      key: `k-${Math.random()}`,
      auth: account === "marketing" ? BETA_KEY : ALPHA_KEY,
      body: plainMail({ from: undefined }),
    });
    expect(res.status).toBe(202);
    return ((await res.json()) as { jobId: string }).jobId;
  }
});
