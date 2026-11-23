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
import { createJob, migrate } from "../support/queue-fixtures.js";
import {
  ACCOUNT_CANARY_VALUES,
  OPS_ADMIN,
  OPS_READ,
  startAccountsApp,
  type AccountsApp,
} from "../support/accounts-app.js";
import { ALPHA_KEY, BETA_KEY } from "../support/rest-app.js";

type Json = Record<string, any>;

/**
 * `/health/ready`의 계정 표면(RQ-063, ADR-0013 결정 5). 호출처 alpha는 계정 `default`, beta는 `marketing`을 쓴다.
 * 공개 응답은 모든 계정 중 가장 나쁜 상태이고 계정 수·ID가 없다. 호출처 키는 자기 계정의 상태를 본다.
 * 200/503은 정지·차단기·계정 상태로 바뀌지 않는다(RQ-031).
 */
describe("e2e: /health/ready 계정 표면 (RQ-063, ADR-0013 결정 5)", () => {
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

  async function ready(
    token: string | null,
  ): Promise<{ status: number; body: Json; text: string }> {
    const res = await fetch(`${app!.baseUrl}/health/ready`, {
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Json, text };
  }

  const openAccount = (id: string, reason = "AUTH") =>
    pool.query(
      `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() + interval '10 minutes',
         wait_seconds = 600, last_reason = $2 WHERE breaker_key = $1`,
      [id, reason],
    );
  const halfOpenAccount = async (id: string) => {
    const jobId = await createJob(pool, { callerId: "beta", accountId: id });
    await pool.query(
      `UPDATE mail_circuit_breaker SET state = 'half_open', probe_until = now() + interval '1 minute',
         probe_job_id = $2, last_reason = 'CONNECTION' WHERE breaker_key = $1`,
      [id, jobId],
    );
  };

  describe("공개 응답(인증 없음)", () => {
    it("모든 계정이 closed면 closed다", async () => {
      const { status, body } = await ready(null);

      expect(status).toBe(200);
      expect(body["circuitBreaker"]).toEqual({ state: "closed" });
    });

    it("어느 계정이든 open이면 open이고 계정 ID·수·사유·시각은 없다. 상태 코드는 200이다", async () => {
      await openAccount("marketing");

      const { status, body, text } = await ready(null);

      expect(status).toBe(200);
      expect(body["status"]).toBe("UP");
      expect(body["circuitBreaker"]).toEqual({ state: "open" });
      expect(Object.keys(body).sort()).toEqual([
        "checks",
        "circuitBreaker",
        "status",
      ]);
      expect(text).not.toContain("marketing");
    });

    it("가장 나쁜 상태 순서는 open, half_open, closed다", async () => {
      await halfOpenAccount("marketing");
      expect((await ready(null)).body["circuitBreaker"]).toEqual({
        state: "half_open",
      });

      await openAccount("default", "TLS");
      expect((await ready(null)).body["circuitBreaker"]).toEqual({
        state: "open",
      });
    });
  });

  describe("호출처 키", () => {
    it("자기 계정의 상태·openUntil·lastReason을 본다. 다른 계정이 open이어도 closed 계정의 호출처는 closed다", async () => {
      await openAccount("marketing", "RATE_LIMIT");

      const own = await ready(BETA_KEY);
      const other = await ready(ALPHA_KEY);

      expect(own.body["circuitBreaker"]).toMatchObject({
        state: "open",
        lastReason: "QUOTA_BURST",
      });
      expect(
        Date.parse(own.body["circuitBreaker"].openUntil as string),
      ).toBeGreaterThan(Date.now());
      expect(other.body["circuitBreaker"]).toEqual({
        state: "closed",
        openUntil: null,
        lastReason: null,
      });
      // 계정 ID는 어느 응답에도 없다.
      expect(own.text).not.toContain("marketing");
      expect(other.text).not.toContain("marketing");
      expect(own.status).toBe(200);
    });

    it("half_open 계정은 호출처에게 half_open이고 openUntil은 null이다", async () => {
      await halfOpenAccount("marketing");

      expect((await ready(BETA_KEY)).body["circuitBreaker"]).toEqual({
        state: "half_open",
        openUntil: null,
        lastReason: "CONNECTION_FAILED",
      });
    });
  });

  describe("운영자 토큰", () => {
    it("circuitBreaker는 가장 나쁜 계정의 상태이고 sendControls에 pausedAccountCount가 있다", async () => {
      await openAccount("marketing", "AUTH");
      await pool.query(
        `INSERT INTO mail_send_controls (scope_type, scope_id, paused_by)
         VALUES ('account', 'marketing', 'oncall'), ('account', 'retired', 'oncall'), ('caller', 'alpha', 'oncall')`,
      );

      for (const token of [OPS_READ, OPS_ADMIN]) {
        const { status, body } = await ready(token);
        expect(status).toBe(200);
        expect(body["circuitBreaker"]).toMatchObject({
          state: "open",
          lastReason: "AUTH_FAILED",
        });
        // 구성 밖 계정의 정지 행도 센다.
        expect(body["sendControls"]).toEqual({
          allPaused: false,
          pausedCallerCount: 1,
          pausedAccountCount: 2,
        });
        expect(JSON.stringify(body)).not.toContain("marketing");
      }
    });

    it("queue.dueCount는 계정별 값의 합이다", async () => {
      await createJob(pool, { callerId: "alpha", accountId: "default" });
      await createJob(pool, { callerId: "beta", accountId: "marketing" });
      await createJob(pool, { callerId: "beta", accountId: "marketing" });

      const { body } = await ready(OPS_READ);

      expect(body["queue"]).toMatchObject({
        dueCount: 3,
        dueCountTruncated: false,
      });
    });
  });

  describe("sendPaused: all > account > caller", () => {
    const scope = async (token: string) =>
      (await ready(token)).body["sendPaused"];

    it("호출처 계정이 정지일 때만 scope가 account다. 다른 계정의 호출처는 영향이 없다", async () => {
      await pool.query(
        `INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('account', 'marketing', 'oncall')`,
      );

      expect(await scope(BETA_KEY)).toEqual({ paused: true, scope: "account" });
      expect(await scope(ALPHA_KEY)).toEqual({ paused: false, scope: null });
    });

    it("우선순위는 all, account, caller다", async () => {
      await pool.query(
        `INSERT INTO mail_send_controls (scope_type, scope_id, paused_by)
         VALUES ('caller', 'beta', 'oncall')`,
      );
      expect(await scope(BETA_KEY)).toEqual({ paused: true, scope: "caller" });

      await pool.query(
        `INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('account', 'marketing', 'oncall')`,
      );
      expect(await scope(BETA_KEY)).toEqual({ paused: true, scope: "account" });

      await pool.query(
        `INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('all', '', 'oncall')`,
      );
      expect(await scope(BETA_KEY)).toEqual({ paused: true, scope: "all" });
    });
  });

  it("정지·차단기·계정 상태는 200/503을 바꾸지 않는다(DB가 되면 항상 200 UP)", async () => {
    await openAccount("marketing");
    await openAccount("default");
    await pool.query(
      `INSERT INTO mail_send_controls (scope_type, scope_id, paused_by)
       VALUES ('all', '', 'oncall'), ('account', 'marketing', 'oncall')`,
    );

    for (const token of [null, ALPHA_KEY, BETA_KEY, OPS_READ, OPS_ADMIN]) {
      const { status, body } = await ready(token);
      expect(status).toBe(200);
      expect(body["status"]).toBe("UP");
      expect(body["checks"]).toEqual({ database: "UP" });
    }
  });

  it("어느 응답에도 계정 host·user·from·비밀번호·비밀 변수 이름이 없다 (RQ-027)", async () => {
    await openAccount("marketing");

    for (const token of [null, ALPHA_KEY, BETA_KEY, OPS_READ, OPS_ADMIN]) {
      const { text } = await ready(token);
      for (const value of [...ACCOUNT_CANARY_VALUES, "MAILO_SMTP_SECRET"])
        expect(text).not.toContain(value);
    }
    for (const value of ACCOUNT_CANARY_VALUES)
      expect(app!.logs.lines.join("\n")).not.toContain(value);
  });
});
