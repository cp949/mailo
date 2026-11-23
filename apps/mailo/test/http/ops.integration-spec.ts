/**
 * 운영 REST `/ops/*`(RQ-042~044, ADR-0011 결정 1·2·3·4·6·7)를 실제 PostgreSQL과 앱으로 검증한다.
 * 고정하는 것: 읽기·관리 토큰의 권한(401·403), 정지·재개의 멱등과 감사 기록, 관리 취소, 감사 목록,
 * 정지·감사의 트랜잭션 원자성, 호출처 키 `/health/ready`의 `sendPaused`, 시크릿 비노출(RQ-027).
 */
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
import { createTestDatabase, type TestDatabase } from "../support/database.js";
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

type Json = Record<string, any>;

// 테스트용 가짜 토큰이다. 실제 시크릿이 아니다. 로그·응답·감사 행에 나오면 안 된다.
const READ = "ops-read-fake-token-000000000000000000000001";
const ONCALL = "ops-admin-oncall-fake-token-000000000000001";
const DEPLOY = "ops-admin-deploy-fake-token-000000000000002";
const UNKNOWN_UUID = "00000000-0000-4000-8000-000000000000";

describe("REST 통합: 운영 REST /ops (RQ-042~044, ADR-0011)", () => {
  let db: TestDatabase;
  let app: RestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    app = await startRestApp({
      pool: db.pool,
      env: {
        MAILO_OPS_TOKEN: READ,
        MAILO_OPS_ADMIN_NAMES: "oncall,deploy",
        MAILO_OPS_ADMIN_TOKEN_ONCALL: ONCALL,
        MAILO_OPS_ADMIN_TOKEN_DEPLOY: DEPLOY,
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query("DELETE FROM mail_send_controls");
    await db.pool.query("DELETE FROM mail_ops_audit");
    await db.pool.query(
      "UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL, probe_job_id = NULL",
    );
  });

  function call(
    method: string,
    pathAndQuery: string,
    auth: string | null,
    target: RestApp = app,
  ): Promise<Response> {
    return fetch(`${target.baseUrl}${pathAndQuery}`, {
      method,
      headers: auth === null ? {} : { Authorization: `Bearer ${auth}` },
    });
  }

  async function json(res: Response): Promise<Json> {
    return (await res.json()) as Json;
  }

  async function audit(): Promise<Json[]> {
    const { rows } = await db.pool.query(
      "SELECT id::text, actor, action, scope_type, scope_id, job_id FROM mail_ops_audit ORDER BY id",
    );
    return rows;
  }

  async function pauseRows(): Promise<Json[]> {
    const { rows } = await db.pool.query(
      "SELECT scope_type, scope_id, paused_by FROM mail_send_controls ORDER BY scope_type, scope_id",
    );
    return rows;
  }

  async function register(key: string, auth = ALPHA_KEY): Promise<string> {
    const res = await postJob(app, { key, auth });
    expect(res.status).toBe(202);
    return (await json(res))["jobId"];
  }

  describe("권한: 읽기 토큰과 관리 토큰 (결정 1·7)", () => {
    const readRoutes: Array<[string, string]> = [
      ["GET", "/ops/pauses"],
      ["GET", "/ops/audit"],
      ["GET", `/ops/jobs/${UNKNOWN_UUID}`],
    ];
    const adminRoutes: Array<[string, string]> = [
      ["PUT", "/ops/pauses/all"],
      ["DELETE", "/ops/pauses/all"],
      ["PUT", "/ops/pauses/callers/alpha"],
      ["DELETE", "/ops/pauses/callers/alpha"],
      ["POST", `/ops/jobs/${UNKNOWN_UUID}/cancel`],
    ];

    it.each(readRoutes)(
      "%s %s: 자격 없음·호출처 키·모르는 값은 401, 읽기·관리 토큰은 통과한다",
      async (method, route) => {
        for (const auth of [null, ALPHA_KEY, BETA_KEY, "unknown-token"]) {
          const res = await call(method, route, auth);
          expect(res.status).toBe(401);
          expect(res.headers.get("content-type")).toContain(
            "application/problem+json",
          );
          expect(res.headers.get("www-authenticate")).toBe("Bearer");
          expect((await json(res))["type"]).toBe(
            "urn:mailo:problem:unauthorized",
          );
        }
        for (const auth of [READ, ONCALL, DEPLOY])
          expect([200, 404]).toContain(
            (await call(method, route, auth)).status,
          );
      },
    );

    it.each(adminRoutes)(
      "%s %s: 읽기 토큰은 403 forbidden이고 상태·감사가 바뀌지 않는다. 자격 없음·호출처 키는 401이다",
      async (method, route) => {
        const jobId = await register("auth-matrix-job");
        const target = route.replace(UNKNOWN_UUID, jobId);

        const forbidden = await call(method, target, READ);
        expect(forbidden.status).toBe(403);
        expect(forbidden.headers.get("content-type")).toContain(
          "application/problem+json",
        );
        const problem = await json(forbidden);
        expect(problem["type"]).toBe("urn:mailo:problem:forbidden");
        expect(problem["status"]).toBe(403);

        for (const auth of [null, ALPHA_KEY, "unknown-token"])
          expect((await call(method, target, auth)).status).toBe(401);

        expect(await pauseRows()).toEqual([]);
        expect(await audit()).toEqual([]);
        const { rows } = await db.pool.query(
          "SELECT status FROM mail_jobs WHERE id = $1",
          [jobId],
        );
        expect(rows[0].status).toBe("PENDING");
      },
    );

    it("관리 토큰이 설정되지 않은 앱은 관리 endpoint가 읽기 토큰에 403, 그 밖에 401이다. 읽기 endpoint는 동작한다", async () => {
      const readOnly = await startRestApp({
        pool: db.pool,
        env: { MAILO_OPS_TOKEN: READ },
      });
      try {
        expect(
          (await call("PUT", "/ops/pauses/all", READ, readOnly)).status,
        ).toBe(403);
        expect(
          (await call("PUT", "/ops/pauses/all", ONCALL, readOnly)).status,
        ).toBe(401);
        expect((await call("GET", "/ops/pauses", READ, readOnly)).status).toBe(
          200,
        );
        expect(await pauseRows()).toEqual([]);
      } finally {
        await readOnly.close();
      }
    });

    it("운영 토큰이 전혀 없는 앱은 /ops 전체가 401이다", async () => {
      const none = await startRestApp({ pool: db.pool });
      try {
        for (const [method, route] of [...readRoutes, ...adminRoutes])
          expect((await call(method, route, READ, none)).status).toBe(401);
      } finally {
        await none.close();
      }
    });

    it("읽기·관리 토큰은 업무 endpoint에서 401이다", async () => {
      for (const auth of [READ, ONCALL]) {
        expect((await postJob(app, { auth, key: "ops-biz" })).status).toBe(401);
        expect((await getJson(app, "/events", auth)).status).toBe(401);
        expect((await getJson(app, `/jobs/${UNKNOWN_UUID}`, auth)).status).toBe(
          401,
        );
      }
    });

    it("운영 토큰이 호출처 API 키와 같으면 기동을 거부하고 값을 오류에 쓰지 않는다", async () => {
      for (const env of [
        { MAILO_OPS_TOKEN: ALPHA_KEY },
        {
          MAILO_OPS_ADMIN_NAMES: "oncall",
          MAILO_OPS_ADMIN_TOKEN_ONCALL: BETA_KEY,
        },
      ]) {
        const error = await startRestApp({ pool: db.pool, env }).then(
          async (started) => {
            await started.close();
            return null;
          },
          (e: unknown) => e as Error,
        );
        expect(error).not.toBeNull();
        expect(error!.message).toContain("호출처 API 키");
        expect(error!.message).not.toContain(ALPHA_KEY);
        expect(error!.message).not.toContain(BETA_KEY);
      }
    });
  });

  describe("전체 정지·재개 (결정 2·6·7)", () => {
    it("PUT은 정지하고 DB now()의 시각·토큰 이름을 돌려주며 감사에 PAUSE 한 건을 쓴다", async () => {
      const res = await call("PUT", "/ops/pauses/all", ONCALL);

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await json(res);
      expect(body).toMatchObject({
        scope: { type: "all" },
        paused: true,
        changed: true,
        pausedBy: "oncall",
      });
      expect(Number.isNaN(Date.parse(body["pausedAt"]))).toBe(false);
      expect(body["inRegistry"]).toBeUndefined();
      expect(await pauseRows()).toEqual([
        { scope_type: "all", scope_id: "", paused_by: "oncall" },
      ]);
      expect(await audit()).toEqual([
        expect.objectContaining({
          actor: "oncall",
          action: "PAUSE",
          scope_type: "all",
          scope_id: "",
          job_id: null,
        }),
      ]);
    });

    it("이미 정지면 changed false와 처음 시각·이름이고 감사를 새로 쓰지 않는다(멱등)", async () => {
      const first = await json(await call("PUT", "/ops/pauses/all", ONCALL));

      const second = await json(await call("PUT", "/ops/pauses/all", DEPLOY));

      expect(second).toMatchObject({
        paused: true,
        changed: false,
        pausedBy: "oncall",
      });
      expect(second["pausedAt"]).toBe(first["pausedAt"]);
      expect(await audit()).toHaveLength(1);
    });

    it("DELETE는 재개하고 RESUME을 기록한다. 정지가 없으면 changed false이고 기록하지 않는다", async () => {
      await call("PUT", "/ops/pauses/all", ONCALL);

      const resumed = await call("DELETE", "/ops/pauses/all", DEPLOY);
      const again = await call("DELETE", "/ops/pauses/all", DEPLOY);

      expect(await json(resumed)).toEqual({
        scope: { type: "all" },
        paused: false,
        changed: true,
      });
      expect(await json(again)).toEqual({
        scope: { type: "all" },
        paused: false,
        changed: false,
      });
      expect((await audit()).map((a) => [a.actor, a.action])).toEqual([
        ["oncall", "PAUSE"],
        ["deploy", "RESUME"],
      ]);
      expect(await pauseRows()).toEqual([]);
    });
  });

  describe("호출처 정지·재개 (결정 3)", () => {
    it("레지스트리에 있는 호출처는 inRegistry true, 없는 호출처도 정지하되 inRegistry false다", async () => {
      const known = await json(
        await call("PUT", "/ops/pauses/callers/alpha", ONCALL),
      );
      const ghost = await json(
        await call("PUT", "/ops/pauses/callers/ghost", ONCALL),
      );

      expect(known).toMatchObject({
        scope: { type: "caller", id: "alpha" },
        paused: true,
        changed: true,
        inRegistry: true,
      });
      expect(ghost).toMatchObject({
        scope: { type: "caller", id: "ghost" },
        inRegistry: false,
      });
      expect((await pauseRows()).map((r) => r.scope_id)).toEqual([
        "alpha",
        "ghost",
      ]);
      expect(
        (await audit()).map((a) => [a.action, a.scope_type, a.scope_id]),
      ).toEqual([
        ["PAUSE", "caller", "alpha"],
        ["PAUSE", "caller", "ghost"],
      ]);
    });

    it("DELETE는 그 호출처만 재개하고 inRegistry를 준다. 다른 호출처 정지는 남는다", async () => {
      await call("PUT", "/ops/pauses/callers/alpha", ONCALL);
      await call("PUT", "/ops/pauses/callers/beta", ONCALL);

      const res = await json(
        await call("DELETE", "/ops/pauses/callers/alpha", ONCALL),
      );

      expect(res).toEqual({
        scope: { type: "caller", id: "alpha" },
        paused: false,
        changed: true,
        inRegistry: true,
      });
      expect((await pauseRows()).map((r) => r.scope_id)).toEqual(["beta"]);
    });

    it.each(["-bad", "has.dot", "a".repeat(65), "한글", "sp%20ace"])(
      "형식이 틀린 callerId(%s)는 400 validation-failed이고 상태·감사가 바뀌지 않는다",
      async (callerId) => {
        for (const method of ["PUT", "DELETE"]) {
          const res = await call(
            method,
            `/ops/pauses/callers/${encodeURI(callerId)}`,
            ONCALL,
          );
          expect(res.status).toBe(400);
          const problem = await json(res);
          expect(problem["type"]).toBe("urn:mailo:problem:validation-failed");
          expect(problem["errors"]).toEqual([
            { parameter: "callerId", code: "INVALID_FORMAT" },
          ]);
        }
        expect(await pauseRows()).toEqual([]);
        expect(await audit()).toEqual([]);
      },
    );

    it("경로의 잘못된 퍼센트 인코딩도 400 validation-failed다", async () => {
      for (const route of [
        "/ops/pauses/callers/%",
        `/ops/jobs/%/cancel`,
        "/ops/jobs/%",
      ]) {
        const res = await call(
          route.endsWith("cancel")
            ? "POST"
            : route.includes("pauses")
              ? "PUT"
              : "GET",
          route,
          ONCALL,
        );
        expect(res.status).toBe(400);
        expect((await json(res))["type"]).toBe(
          "urn:mailo:problem:validation-failed",
        );
      }
    });
  });

  describe("정지 목록 (결정 2·7)", () => {
    it("GET /ops/pauses는 읽기·관리 토큰에 all과 caller 정지를 정지 순서로 준다", async () => {
      await call("PUT", "/ops/pauses/callers/beta", ONCALL);
      await call("PUT", "/ops/pauses/all", DEPLOY);

      for (const auth of [READ, ONCALL]) {
        const body = await json(await call("GET", "/ops/pauses", auth));
        expect(body["pauses"]).toEqual([
          {
            scope: { type: "caller", id: "beta" },
            pausedAt: expect.any(String),
            pausedBy: "oncall",
          },
          {
            scope: { type: "all" },
            pausedAt: expect.any(String),
            pausedBy: "deploy",
          },
        ]);
      }
    });

    it("정지가 없으면 빈 목록이다", async () => {
      expect(await json(await call("GET", "/ops/pauses", READ))).toEqual({
        pauses: [],
      });
    });
  });

  describe("헬스의 정지 요약 (결정 2)", () => {
    const ready = async (auth: string | null) =>
      json(await call("GET", "/health/ready", auth));

    it("호출처 키 응답에는 그 호출처에 해당하는 sendPaused만 있고 호출처 ID·이름·시각은 없다", async () => {
      expect((await ready(ALPHA_KEY))["sendPaused"]).toEqual({
        paused: false,
        scope: null,
      });

      await call("PUT", "/ops/pauses/callers/alpha", ONCALL);
      expect((await ready(ALPHA_KEY))["sendPaused"]).toEqual({
        paused: true,
        scope: "caller",
      });
      expect((await ready(BETA_KEY))["sendPaused"]).toEqual({
        paused: false,
        scope: null,
      });

      await call("PUT", "/ops/pauses/all", ONCALL);
      expect((await ready(ALPHA_KEY))["sendPaused"]).toEqual({
        paused: true,
        scope: "all",
      });
      expect((await ready(BETA_KEY))["sendPaused"]).toEqual({
        paused: true,
        scope: "all",
      });
      const text = JSON.stringify(await ready(ALPHA_KEY));
      expect(text).not.toContain("oncall");
      expect(text).not.toContain("sendControls");
    });

    it("운영자 응답에는 sendControls(전체 정지 여부·정지 호출처 수)만 있고 호출처 ID는 없다. sendPaused는 없다", async () => {
      await call("PUT", "/ops/pauses/callers/alpha", ONCALL);
      await call("PUT", "/ops/pauses/callers/ghost-caller", ONCALL);

      for (const auth of [READ, ONCALL]) {
        const body = await ready(auth);
        expect(body["sendControls"]).toEqual({
          allPaused: false,
          pausedCallerCount: 2,
        });
        expect(body["sendPaused"]).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain("ghost-caller");
      }
    });

    it("인증 없는 응답은 바뀌지 않는다. 정지 중에도 200이고 status는 UP이다", async () => {
      await call("PUT", "/ops/pauses/all", ONCALL);

      const res = await call("GET", "/health/ready", null);
      const body = await json(res);

      expect(res.status).toBe(200);
      expect(body["status"]).toBe("UP");
      expect(body["sendPaused"]).toBeUndefined();
      expect(body["sendControls"]).toBeUndefined();
    });
  });

  describe("정지 중 등록 (결정 2·3)", () => {
    it("전체·호출처 정지 중에도 등록은 202로 받고 PENDING으로 쌓인다", async () => {
      await call("PUT", "/ops/pauses/all", ONCALL);
      await call("PUT", "/ops/pauses/callers/alpha", ONCALL);

      const id = await register("paused-register");

      const job = await json(await getJson(app, `/jobs/${id}`));
      expect(job["status"]).toBe("PENDING");
    });
  });

  describe("관리 작업 취소 (결정 4·6·7)", () => {
    it("관리 토큰은 어느 호출처의 작업이든 취소하고 OPERATOR로 기록하며 감사에 CANCEL_JOB을 쓴다", async () => {
      const alphaJob = await register("ops-cancel-a", ALPHA_KEY);
      const betaJob = await register("ops-cancel-b", BETA_KEY);

      for (const id of [alphaJob, betaJob]) {
        const res = await call("POST", `/ops/jobs/${id}/cancel`, ONCALL);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await json(res);
        expect(body).toMatchObject({
          jobId: id,
          status: "CANCELED",
          canceledBy: "OPERATOR",
          sentAt: null,
          failedAt: null,
          failureReason: null,
        });
        // 운영자 읽기에는 호출처의 Key를 주지 않고 호출처 ID를 준다.
        expect(body["idempotencyKey"]).toBeUndefined();
        expect(["alpha", "beta"]).toContain(body["callerId"]);
      }
      expect((await audit()).map((a) => [a.actor, a.action, a.job_id])).toEqual(
        [
          ["oncall", "CANCEL_JOB", alphaJob],
          ["oncall", "CANCEL_JOB", betaJob],
        ],
      );
      const { rows } = await db.pool.query(
        "SELECT status, failure_reason, body_ciphertext FROM mail_jobs ORDER BY created_at",
      );
      expect(rows).toEqual([
        {
          status: "CANCELED",
          failure_reason: "CANCELED_BY_OPERATOR",
          body_ciphertext: null,
        },
        {
          status: "CANCELED",
          failure_reason: "CANCELED_BY_OPERATOR",
          body_ciphertext: null,
        },
      ]);
    });

    it("호출처 피드에는 JOB_CANCELED(canceledBy OPERATOR)가 한 건 생기고 운영자 이름은 없다", async () => {
      const id = await register("ops-cancel-feed");

      await call("POST", `/ops/jobs/${id}/cancel`, ONCALL);
      const feed = await json(await getJson(app, "/events?type=JOB_CANCELED"));

      expect(feed["events"]).toHaveLength(1);
      expect(feed["events"][0]).toMatchObject({
        type: "JOB_CANCELED",
        jobId: id,
        canceledBy: "OPERATOR",
      });
      expect(JSON.stringify(feed)).not.toContain("oncall");
    });

    it("이미 CANCELED이면 200이고 이벤트·감사를 새로 쓰지 않는다(멱등)", async () => {
      const id = await register("ops-cancel-idem");
      const first = await json(
        await call("POST", `/ops/jobs/${id}/cancel`, ONCALL),
      );

      const second = await call("POST", `/ops/jobs/${id}/cancel`, DEPLOY);

      expect(second.status).toBe(200);
      expect(await json(second)).toEqual(first);
      expect(await audit()).toHaveLength(1);
      const { rows } = await db.pool.query(
        "SELECT count(*)::int AS n FROM mail_events WHERE job_id = $1",
        [id],
      );
      expect(rows[0].n).toBe(1);
    });

    it("SENDING·종결 작업은 409 job-not-cancelable이고 jobStatus만 알리며 감사하지 않는다", async () => {
      const sending = await register("ops-sending");
      await db.pool.query(
        `UPDATE mail_jobs SET status = 'SENDING', lease_token = gen_random_uuid(),
                lease_until = now() + interval '2 minutes', leased_at = now() WHERE id = $1`,
        [sending],
      );
      const sent = await register("ops-sent");
      await db.pool.query(
        "UPDATE mail_jobs SET status = 'SENT', finished_at = now() WHERE id = $1",
        [sent],
      );

      for (const [id, status] of [
        [sending, "SENDING"],
        [sent, "SENT"],
      ] as const) {
        const res = await call("POST", `/ops/jobs/${id}/cancel`, ONCALL);
        expect(res.status).toBe(409);
        const problem = await json(res);
        expect(problem).toMatchObject({
          type: "urn:mailo:problem:job-not-cancelable",
          jobStatus: status,
        });
      }
      expect(await audit()).toEqual([]);
    });

    it("없는 작업은 404, 형식이 틀린 jobId는 400이고 감사하지 않는다", async () => {
      expect(
        (await call("POST", `/ops/jobs/${UNKNOWN_UUID}/cancel`, ONCALL)).status,
      ).toBe(404);
      const bad = await call("POST", "/ops/jobs/not-a-uuid/cancel", ONCALL);
      expect(bad.status).toBe(400);
      expect((await json(bad))["errors"]).toEqual([
        { parameter: "jobId", code: "INVALID_FORMAT" },
      ]);
      expect(await audit()).toEqual([]);
    });
  });

  describe("작업 조회 GET /ops/jobs/{jobId} (결정 7)", () => {
    it("모든 호출처의 작업을 읽기·관리 토큰에 주고 Key·수신자·본문은 없으며 callerId가 있다", async () => {
      const res = await postJob(app, {
        key: `read-${CANARY.key}`,
        auth: BETA_KEY,
        body: plainMail({
          to: [`${CANARY.recipient}@example.com`],
          subject: CANARY.subject,
          text: CANARY.text,
          html: `<p>${CANARY.html}</p>`,
        }),
      });
      const id = (await json(res))["jobId"];

      for (const auth of [READ, ONCALL]) {
        const read = await call("GET", `/ops/jobs/${id}`, auth);
        expect(read.status).toBe(200);
        const body = await json(read);
        expect(body).toMatchObject({
          jobId: id,
          callerId: "beta",
          status: "PENDING",
        });
        expect(body["idempotencyKey"]).toBeUndefined();
        const text = JSON.stringify(body);
        for (const canary of [
          CANARY.key,
          CANARY.recipient,
          CANARY.subject,
          CANARY.text,
          CANARY.html,
        ])
          expect(text).not.toContain(canary);
      }
    });

    it("거부된 수신자 주소가 있는 SENT 작업도 수신자 주소를 주지 않는다(rejectedRecipients 필드 없음)", async () => {
      const id = await register("ops-sent-rejected");
      const rejected = `${CANARY.recipient}-rejected@example.com`;
      await db.pool.query(
        "UPDATE mail_jobs SET status = 'SENT', finished_at = now() WHERE id = $1",
        [id],
      );
      await db.pool.query(
        `INSERT INTO mail_attempts (job_id, classification, counted, stage, started_at, rejected_recipients)
         VALUES ($1, 'SENT', true, 'RCPT', now(), $2::jsonb)`,
        [
          id,
          JSON.stringify([
            { address: rejected, smtpCode: 550, enhancedCode: "5.1.1" },
          ]),
        ],
      );

      for (const auth of [READ, ONCALL]) {
        const res = await call("GET", `/ops/jobs/${id}`, auth);
        expect(res.status).toBe(200);
        const text = await res.text();
        const body = JSON.parse(text) as Json;
        expect(body["status"]).toBe("SENT");
        expect(body["rejectedRecipients"]).toBeUndefined();
        expect(text).not.toContain(rejected);
        expect(text).not.toContain(CANARY.recipient);
      }
      // 같은 작업을 호출처 응답(`GET /jobs/{jobId}`)은 자기 작업의 거부 수신자와 함께 계속 준다(기존 계약).
      const own = await json(await getJson(app, `/jobs/${id}`));
      expect(own["rejectedRecipients"]).toEqual([
        { address: rejected, smtpCode: 550, enhancedCode: "5.1.1" },
      ]);
    });

    it("정지 목록·감사·헬스·취소 응답에도 수신자 주소가 없다", async () => {
      const recipient = `${CANARY.recipient}@example.com`;
      const res = await postJob(app, {
        key: "ops-no-recipient",
        body: plainMail({ to: [recipient], cc: [`cc-${recipient}`] }),
      });
      const id = (await json(res))["jobId"];
      const texts: string[] = [];
      for (const [method, route, auth] of [
        ["PUT", "/ops/pauses/callers/alpha", ONCALL],
        ["GET", "/ops/pauses", READ],
        ["POST", `/ops/jobs/${id}/cancel`, ONCALL],
        ["GET", `/ops/jobs/${id}`, READ],
        ["GET", "/ops/audit", READ],
        ["GET", "/health/ready", READ],
        ["GET", "/health/ready", ONCALL],
      ] as const)
        texts.push(await (await call(method, route, auth)).text());

      for (const text of texts) expect(text).not.toContain(CANARY.recipient);
    });

    it("없는 작업은 404, 형식이 틀리면 400이다", async () => {
      expect(
        (await call("GET", `/ops/jobs/${UNKNOWN_UUID}`, READ)).status,
      ).toBe(404);
      expect((await call("GET", "/ops/jobs/nope", READ)).status).toBe(400);
    });
  });

  describe("감사 목록 GET /ops/audit (결정 6·7)", () => {
    async function seedAudit(n: number): Promise<void> {
      for (let i = 0; i < n; i += 1)
        await call(i % 2 === 0 ? "PUT" : "DELETE", "/ops/pauses/all", ONCALL);
    }

    it("최근 순서로 id(문자열)·시각·이름·동작·범위를 주고 작업 ID는 취소에만 있다", async () => {
      await call("PUT", "/ops/pauses/callers/alpha", ONCALL);
      const id = await register("audit-cancel");
      await call("POST", `/ops/jobs/${id}/cancel`, DEPLOY);

      const body = await json(await call("GET", "/ops/audit", READ));

      expect(body["nextBefore"]).toBeNull();
      expect(body["entries"]).toEqual([
        {
          id: expect.stringMatching(/^\d+$/),
          at: expect.any(String),
          actor: "deploy",
          action: "CANCEL_JOB",
          jobId: id,
        },
        {
          id: expect.stringMatching(/^\d+$/),
          at: expect.any(String),
          actor: "oncall",
          action: "PAUSE",
          scope: { type: "caller", id: "alpha" },
        },
      ]);
      expect(Number(body["entries"][0].id)).toBeGreaterThan(
        Number(body["entries"][1].id),
      );
    });

    it("limit·before로 쪽을 나눈다. 마지막 쪽의 nextBefore는 null이다", async () => {
      await seedAudit(5);

      const first = await json(await call("GET", "/ops/audit?limit=2", READ));
      expect(first["entries"]).toHaveLength(2);
      expect(first["nextBefore"]).toBe(first["entries"][1].id);

      const second = await json(
        await call(
          "GET",
          `/ops/audit?limit=2&before=${first["nextBefore"]}`,
          READ,
        ),
      );
      const third = await json(
        await call(
          "GET",
          `/ops/audit?limit=2&before=${second["nextBefore"]}`,
          READ,
        ),
      );

      const ids = [
        ...first["entries"],
        ...second["entries"],
        ...third["entries"],
      ].map((e) => e.id);
      expect(new Set(ids).size).toBe(5);
      expect(ids).toEqual([...ids].sort((a, b) => Number(b) - Number(a)));
      expect(third["entries"]).toHaveLength(1);
      expect(third["nextBefore"]).toBeNull();
    });

    it("정확히 limit건이 남았으면 nextBefore는 null이다", async () => {
      await seedAudit(2);

      const body = await json(await call("GET", "/ops/audit?limit=2", READ));

      expect(body["entries"]).toHaveLength(2);
      expect(body["nextBefore"]).toBeNull();
    });

    it("기본 limit은 50이고 200까지 받는다", async () => {
      await seedAudit(3);
      expect(
        (await json(await call("GET", "/ops/audit?limit=200", READ)))[
          "entries"
        ],
      ).toHaveLength(3);
    });

    it.each([
      "limit=0",
      "limit=201",
      "limit=abc",
      "limit=1.5",
      "limit=-1",
      "limit=1&limit=2",
      "before=0",
      "before=abc",
      "before=-5",
      "before=9223372036854775808",
      "before=1&before=2",
    ])(
      "검증 실패(%s)는 400 validation-failed이고 값은 응답에 없다",
      async (query) => {
        const res = await call("GET", `/ops/audit?${query}`, READ);

        expect(res.status).toBe(400);
        const problem = await json(res);
        expect(problem["type"]).toBe("urn:mailo:problem:validation-failed");
        expect(problem["errors"]).toEqual([
          { parameter: query.split("=")[0], code: "INVALID_FORMAT" },
        ]);
      },
    );
  });

  describe("트랜잭션 원자성 (결정 6)", () => {
    const failing = (table: string) => `
      CREATE FUNCTION fail_${table}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END $$;
      CREATE TRIGGER fail_${table}_trg BEFORE INSERT OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION fail_${table}();`;
    const dropFailing = (table: string) =>
      db.pool.query(
        `DROP TRIGGER IF EXISTS fail_${table}_trg ON ${table}; DROP FUNCTION IF EXISTS fail_${table}();`,
      );

    afterEach(async () => {
      await dropFailing("mail_ops_audit");
      await dropFailing("mail_send_controls");
      await dropFailing("mail_events");
    });

    it("감사 기록이 실패하면 정지도 롤백된다(503, 정지 행 없음)", async () => {
      await db.pool.query(failing("mail_ops_audit"));

      const res = await call("PUT", "/ops/pauses/all", ONCALL);

      expect(res.status).toBe(503);
      expect(await pauseRows()).toEqual([]);
    });

    it("감사 기록이 실패하면 재개도 롤백된다(정지 행이 남는다)", async () => {
      await call("PUT", "/ops/pauses/all", ONCALL);
      await db.pool.query(failing("mail_ops_audit"));

      const res = await call("DELETE", "/ops/pauses/all", ONCALL);

      expect(res.status).toBe(503);
      expect(await pauseRows()).toHaveLength(1);
    });

    it("정지 변경이 실패하면 감사도 남지 않는다", async () => {
      await db.pool.query(failing("mail_send_controls"));

      const res = await call("PUT", "/ops/pauses/callers/alpha", ONCALL);

      expect(res.status).toBe(503);
      expect(await audit()).toEqual([]);
    });

    it("감사 기록이 실패하면 작업 취소도 롤백된다(작업·본문·이벤트가 그대로다)", async () => {
      const id = await register("atomic-cancel");
      await db.pool.query(failing("mail_ops_audit"));

      const res = await call("POST", `/ops/jobs/${id}/cancel`, ONCALL);

      expect(res.status).toBe(503);
      const { rows } = await db.pool.query(
        "SELECT status, body_ciphertext IS NOT NULL AS has_body FROM mail_jobs WHERE id = $1",
        [id],
      );
      expect(rows[0]).toEqual({ status: "PENDING", has_body: true });
      const events = await db.pool.query(
        "SELECT count(*)::int AS n FROM mail_events WHERE job_id = $1",
        [id],
      );
      expect(events.rows[0].n).toBe(0);
    });

    it("취소 이벤트 쓰기가 실패하면 감사도 남지 않는다", async () => {
      const id = await register("atomic-cancel-event");
      await db.pool.query(failing("mail_events"));

      const res = await call("POST", `/ops/jobs/${id}/cancel`, ONCALL);

      expect(res.status).toBe(503);
      expect(await audit()).toEqual([]);
    });
  });

  describe("로그와 시크릿 비노출 (RQ-027, 결정 6)", () => {
    function logged(event: string): Json[] {
      return app.logs.lines
        .flatMap((l) => l.split("\n"))
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Json)
        .filter((l) => l["event"] === event);
    }

    beforeEach(() => {
      // 앞선 테스트가 띄운 다른 앱이 Nest 전역 로거를 가져갔으므로 이 앱의 로거로 되돌린다.
      app.app.useLogger(app.logs.logger);
    });

    it("관리 작업마다 ops_pause_set·ops_pause_cleared·ops_job_canceled(info)를 actor와 범위·작업 ID만 담아 남기고 멱등 재요청은 남기지 않는다", async () => {
      app.logs.lines.length = 0;
      const id = await register("log-cancel");

      await call("PUT", "/ops/pauses/all", ONCALL);
      await call("PUT", "/ops/pauses/all", ONCALL);
      await call("PUT", "/ops/pauses/callers/alpha", DEPLOY);
      await call("DELETE", "/ops/pauses/callers/alpha", DEPLOY);
      await call("DELETE", "/ops/pauses/all", ONCALL);
      await call("POST", `/ops/jobs/${id}/cancel`, ONCALL);
      await call("POST", `/ops/jobs/${id}/cancel`, ONCALL);

      const keys = (e: Json) =>
        Object.keys(e)
          .filter((k) => !["ts", "instance", "level", "event"].includes(k))
          .sort();
      const set = logged("ops_pause_set");
      const cleared = logged("ops_pause_cleared");
      const canceled = logged("ops_job_canceled");
      expect(set).toHaveLength(2);
      expect(set[0]).toMatchObject({
        level: "info",
        actor: "oncall",
        scope: "all",
      });
      expect(keys(set[0]!)).toEqual(["actor", "scope"]);
      expect(set[1]).toMatchObject({
        actor: "deploy",
        scope: "caller",
        callerId: "alpha",
      });
      expect(keys(set[1]!)).toEqual(["actor", "callerId", "scope"]);
      expect(cleared).toHaveLength(2);
      expect(canceled).toHaveLength(1);
      expect(canceled[0]).toMatchObject({
        level: "info",
        actor: "oncall",
        jobId: id,
      });
      expect(keys(canceled[0]!)).toEqual(["actor", "jobId"]);
    });

    it("토큰 값과 본문·제목·수신자·Key canary가 로그·응답·감사 행·이벤트에 없다", async () => {
      app.logs.lines.length = 0;
      const res = await postJob(app, {
        key: `canary-${CANARY.key}`,
        body: plainMail({
          to: [`${CANARY.recipient}@example.com`],
          subject: CANARY.subject,
          text: CANARY.text,
          html: `<p>${CANARY.html}</p>`,
        }),
      });
      const id = (await json(res))["jobId"];
      const responses: string[] = [];
      const record = async (p: Promise<Response>) => {
        responses.push(await (await p).text());
      };

      await record(call("PUT", "/ops/pauses/all", ONCALL));
      await record(call("PUT", "/ops/pauses/callers/alpha", ONCALL));
      await record(call("GET", "/ops/pauses", READ));
      await record(call("GET", `/ops/jobs/${id}`, READ));
      await record(call("POST", `/ops/jobs/${id}/cancel`, ONCALL));
      await record(call("GET", "/ops/audit", READ));
      await record(call("GET", "/health/ready", READ));
      // 거부 경로(401·403)도 토큰을 되풀이하지 않는다.
      await record(call("PUT", "/ops/pauses/all", READ));
      await record(call("PUT", "/ops/pauses/all", "wrong-" + ONCALL));

      const auditText = JSON.stringify(
        (await db.pool.query("SELECT * FROM mail_ops_audit")).rows,
      );
      // 이벤트 행에는 기존 계약상 수신자·Key가 있다. 토큰·제목·본문만 확인한다.
      const eventsText = JSON.stringify(
        (await db.pool.query("SELECT * FROM mail_events")).rows,
      );
      const everything = [
        app.logs.lines.join("\n"),
        responses.join("\n"),
        auditText,
        eventsText,
      ].join("\n");
      for (const secret of [READ, ONCALL, DEPLOY, "wrong-" + ONCALL])
        expect(everything).not.toContain(secret);
      for (const canary of [CANARY.subject, CANARY.text, CANARY.html])
        expect(everything).not.toContain(canary);
      // 수신자·Key는 기존 계약상 이벤트 행에는 있다. 로그·응답·감사에는 없어야 한다.
      for (const canary of [CANARY.recipient, CANARY.key])
        for (const text of [
          app.logs.lines.join("\n"),
          responses.join("\n"),
          auditText,
        ])
          expect(text).not.toContain(canary);
    });
  });
});
