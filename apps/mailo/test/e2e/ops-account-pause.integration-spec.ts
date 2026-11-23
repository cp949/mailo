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
  ACCOUNT_CANARY_VALUES,
  OPS_ADMIN,
  OPS_READ,
  marketingAccount,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AuditRow {
  actor: string;
  action: string;
  scope_type: string;
  scope_id: string;
}

describe("계정 정지·해제 REST (RQ-061, ADR-0013 결정 5, ADR-0011 결정 2·6)", () => {
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
    await pool.query("DELETE FROM mail_ops_audit");
    app = await startAccountsApp({ pool });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const put = (id: string, token: string | null = OPS_ADMIN) =>
    opsFetch(app!, "PUT", `/ops/pauses/accounts/${id}`, token);
  const del = (id: string, token: string | null = OPS_ADMIN) =>
    opsFetch(app!, "DELETE", `/ops/pauses/accounts/${id}`, token);

  const auditRows = async () =>
    (
      await pool.query<AuditRow>(
        "SELECT actor, action, scope_type, scope_id FROM mail_ops_audit ORDER BY id",
      )
    ).rows;
  const controlRows = async () =>
    (
      await pool.query(
        "SELECT scope_type, scope_id, paused_by FROM mail_send_controls ORDER BY scope_type, scope_id",
      )
    ).rows;

  it("정지는 changed와 시각·이름을 돌려주고 같은 요청을 반복해도 감사는 한 건이다 (멱등)", async () => {
    const first = await put("marketing");
    const firstBody = (await first.json()) as Record<string, unknown>;
    const second = await put("marketing");
    const secondBody = (await second.json()) as Record<string, unknown>;

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(firstBody).toMatchObject({
      scope: { type: "account", id: "marketing" },
      paused: true,
      changed: true,
      pausedBy: "oncall",
      inConfig: true,
    });
    expect(typeof firstBody["pausedAt"]).toBe("string");
    expect(Object.keys(firstBody)).not.toContain("inRegistry");
    expect(secondBody).toMatchObject({ paused: true, changed: false });
    expect(secondBody["pausedAt"]).toBe(firstBody["pausedAt"]);
    expect(await controlRows()).toEqual([
      { scope_type: "account", scope_id: "marketing", paused_by: "oncall" },
    ]);
    expect(await auditRows()).toEqual([
      {
        actor: "oncall",
        action: "PAUSE",
        scope_type: "account",
        scope_id: "marketing",
      },
    ]);
  });

  it("해제는 행을 지우고 반복하면 changed false이며 감사는 바뀐 한 번만 남는다", async () => {
    await put("marketing");

    const first = await del("marketing");
    const second = await del("marketing");

    expect(await first.json()).toEqual({
      scope: { type: "account", id: "marketing" },
      paused: false,
      changed: true,
      inConfig: true,
    });
    expect(await second.json()).toMatchObject({
      paused: false,
      changed: false,
    });
    expect(await controlRows()).toEqual([]);
    expect((await auditRows()).map((r) => r.action)).toEqual([
      "PAUSE",
      "RESUME",
    ]);
  });

  it("구성에 없는 계정 ID도 받는다. inConfig는 false이고 정지 목록과 감사에 남는다 (정지 행 정리용)", async () => {
    const paused = await put("retired");
    const listed = await opsFetch(app!, "GET", "/ops/pauses", OPS_READ);

    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({
      paused: true,
      inConfig: false,
    });
    expect(((await listed.json()) as { pauses: unknown[] }).pauses).toEqual([
      expect.objectContaining({ scope: { type: "account", id: "retired" } }),
    ]);

    expect(await (await del("retired")).json()).toMatchObject({
      paused: false,
      changed: true,
      inConfig: false,
    });
    expect(await controlRows()).toEqual([]);
  });

  it("GET /ops/audit가 계정 범위 항목을 내고 호출처 정지와 구별한다", async () => {
    await put("marketing");
    await opsFetch(app!, "PUT", "/ops/pauses/callers/alpha", OPS_ADMIN);

    const res = await opsFetch(app!, "GET", "/ops/audit", OPS_READ);
    const { entries } = (await res.json()) as {
      entries: Array<{ scope: { type: string; id?: string } }>;
    };

    expect(entries.map((e) => e.scope)).toEqual([
      { type: "caller", id: "alpha" },
      { type: "account", id: "marketing" },
    ]);
    // 감사 목록에도 계정 host·user·from·비밀번호가 없다(RQ-027).
    const text = JSON.stringify(entries);
    for (const value of [...ACCOUNT_CANARY_VALUES, "MAILO_SMTP_SECRET"])
      expect(text).not.toContain(value);
  });

  it("읽기 토큰은 403, 토큰 없음·호출처 키는 401이고 상태·감사가 바뀌지 않는다 (ADR-0011 결정 7)", async () => {
    expect((await put("marketing", OPS_READ)).status).toBe(403);
    expect((await del("marketing", OPS_READ)).status).toBe(403);
    expect((await put("marketing", null)).status).toBe(401);
    expect((await del("marketing", null)).status).toBe(401);
    expect((await put("marketing", ALPHA_KEY)).status).toBe(401);
    expect((await put("marketing", "wrong-token")).status).toBe(401);

    expect(await controlRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it("계정 ID 형식이 틀리면 400(accountId, INVALID_FORMAT)이고 아무것도 쓰지 않는다", async () => {
    for (const id of [
      "Marketing",
      "unregistered",
      "a.b",
      "-a",
      "x".repeat(33),
      "a%40b",
    ]) {
      const res = await put(id);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { errors: unknown[] }).errors).toEqual([
        { parameter: "accountId", code: "INVALID_FORMAT" },
      ]);
      expect((await del(id)).status).toBe(400);
    }
    expect(await controlRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it("경로 디코딩에 실패하는 값은 인증 앞에서 거절한다. 자격 없는 호출은 401이고 400으로 라우트를 드러내지 않는다 (ADR-0011 결정 7)", async () => {
    const res = await opsFetch(app!, "PUT", "/ops/pauses/accounts/%", null);
    expect(res.status).toBe(401);
    const auth = await opsFetch(
      app!,
      "PUT",
      "/ops/pauses/accounts/%",
      OPS_ADMIN,
    );
    expect(auth.status).toBe(400);
  });

  it("응답과 로그에 계정 host·user·from·비밀번호가 없다 (RQ-027)", async () => {
    const texts = [
      await (await put("marketing")).text(),
      await (await del("marketing")).text(),
    ];
    for (const value of ACCOUNT_CANARY_VALUES) {
      for (const text of texts) expect(text).not.toContain(value);
      expect(app!.logs.lines.join("\n")).not.toContain(value);
    }
    const logged = app!.logs.lines.filter((l) => l.includes("ops_pause_"));
    expect(logged.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({
        event: "ops_pause_set",
        scope: "account",
        accountId: "marketing",
        actor: "oncall",
      }),
      expect.objectContaining({
        event: "ops_pause_cleared",
        scope: "account",
        accountId: "marketing",
      }),
    ]);
  });

  describe("실제 Worker: 정지한 계정만 멈춘다", () => {
    let fakeA: FakeSmtp;
    let fakeB: FakeSmtp;

    beforeAll(async () => {
      fakeA = await startFakeSmtp();
      fakeB = await startFakeSmtp();
    });
    afterAll(async () => {
      await fakeA.close();
      await fakeB.close();
    });

    it("marketing 계정을 정지하면 beta의 작업은 PENDING으로 남고 default의 alpha는 발송된다. 해제하면 발송한다", async () => {
      await app!.close();
      fakeA.reset();
      fakeB.reset();
      app = await startAccountsApp({
        pool,
        accounts: [marketingAccount({ host: fakeB.host, port: fakeB.port })],
        env: {
          MAILO_SMTP_HOST: fakeA.host,
          MAILO_SMTP_PORT: String(fakeA.port),
          MAILO_WORKER_POLL_MS: "50",
          MAILO_MAINTENANCE_INTERVAL_SECONDS: "1",
        },
        worker: { trustedCa: fakeA.ca },
      });
      expect((await put("marketing")).status).toBe(200);

      const submit = async (key: string, auth: string) => {
        const res = await postJob(app!, {
          key,
          auth,
          body: plainMail({ from: undefined }),
        });
        expect(res.status).toBe(202);
        return ((await res.json()) as { jobId: string }).jobId;
      };
      const statusOf = async (id: string, auth: string) =>
        (
          (await (await getJson(app!, `/jobs/${id}`, auth)).json()) as {
            status: string;
          }
        ).status;
      const waitStatus = async (id: string, auth: string, status: string) => {
        const started = Date.now();
        while ((await statusOf(id, auth)) !== status) {
          if (Date.now() - started > 10_000) throw new Error("시간 초과");
          await sleep(25);
        }
      };

      const beta = await submit("pause-beta", BETA_KEY);
      const alpha = await submit("pause-alpha", ALPHA_KEY);
      await waitStatus(alpha, ALPHA_KEY, "SENT");
      await sleep(300);
      expect(await statusOf(beta, BETA_KEY)).toBe("PENDING");
      expect(fakeB.messages).toHaveLength(0);

      expect((await del("marketing")).status).toBe(200);
      await waitStatus(beta, BETA_KEY, "SENT");
      expect(fakeB.messages).toHaveLength(1);
    });
  });
});
