/**
 * 호출처 작업 취소 REST(RQ-040, ADR-0011 결정 4)를 실제 PostgreSQL과 앱으로 검증한다.
 * 고정하는 것: 두 endpoint(`POST /jobs/{jobId}/cancel`, `POST /jobs/cancel?idempotencyKey=`)의 상태 코드와 응답,
 * 호출처 격리(404), Key 계약(RQ-034), 이벤트 피드(`JOB_CANCELED`·`canceledBy`), 시크릿 비노출(RQ-027).
 */
import "reflect-metadata";
import {
  afterAll,
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

type Json = Record<string, unknown>;

describe("REST 통합: 작업 취소(RQ-040, ADR-0011 결정 4)", () => {
  let db: TestDatabase;
  let app: RestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    app = await startRestApp({ pool: db.pool });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query(
      "UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL, probe_job_id = NULL",
    );
  });

  function cancel(
    pathAndQuery: string,
    auth: string | null = ALPHA_KEY,
    init: RequestInit = {},
  ): Promise<Response> {
    return fetch(`${app.baseUrl}${pathAndQuery}`, {
      method: "POST",
      headers: auth === null ? {} : { Authorization: `Bearer ${auth}` },
      ...init,
    });
  }

  async function register(
    key: string,
    body: Json = plainMail(),
    auth: string = ALPHA_KEY,
  ): Promise<string> {
    const res = await postJob(app, { key, body, auth });
    expect(res.status).toBe(202);
    return ((await res.json()) as Json)["jobId"] as string;
  }

  async function dbRow(jobId: string) {
    const { rows } = await db.pool.query(
      `SELECT status, body_ciphertext, failure_reason FROM mail_jobs WHERE id = $1`,
      [jobId],
    );
    return rows[0];
  }

  describe("POST /jobs/{jobId}/cancel", () => {
    it("PENDING 작업을 취소하면 200과 CANCELED Job을 돌려주고 본문을 지운다", async () => {
      const jobId = await register("cancel-1");

      const res = await cancel(`/jobs/${jobId}/cancel`);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const job = (await res.json()) as Json;
      expect(job).toMatchObject({
        jobId,
        idempotencyKey: "cancel-1",
        status: "CANCELED",
        sentAt: null,
        failedAt: null,
        failureReason: null,
        canceledBy: "CALLER",
        rejectedRecipients: [],
      });
      expect(typeof job["canceledAt"]).toBe("string");
      expect(Number.isNaN(Date.parse(job["canceledAt"] as string))).toBe(false);
      const row = await dbRow(jobId);
      expect(row.status).toBe("CANCELED");
      expect(row.body_ciphertext).toBeNull();
    });

    it("이미 CANCELED이면 200과 같은 응답이고 이벤트를 새로 쓰지 않는다(멱등)", async () => {
      const jobId = await register("cancel-idem");
      const first = (await (
        await cancel(`/jobs/${jobId}/cancel`)
      ).json()) as Json;

      const second = await cancel(`/jobs/${jobId}/cancel`);

      expect(second.status).toBe(200);
      expect((await second.json()) as Json).toEqual(first);
      const { rows } = await db.pool.query(
        "SELECT count(*)::int AS n FROM mail_events WHERE job_id = $1",
        [jobId],
      );
      expect(rows[0].n).toBe(1);
    });

    it("SENDING 작업은 409 job-not-cancelable이고 jobStatus만 알린다", async () => {
      const jobId = await register("cancel-sending");
      await db.pool.query(
        `UPDATE mail_jobs SET status = 'SENDING', lease_token = gen_random_uuid(),
                lease_until = now() + interval '2 minutes', leased_at = now() WHERE id = $1`,
        [jobId],
      );

      const res = await cancel(`/jobs/${jobId}/cancel`);

      expect(res.status).toBe(409);
      expect(res.headers.get("content-type")).toContain(
        "application/problem+json",
      );
      const problem = (await res.json()) as Json;
      expect(problem).toMatchObject({
        type: "urn:mailo:problem:job-not-cancelable",
        status: 409,
        jobStatus: "SENDING",
      });
      expect((await dbRow(jobId)).status).toBe("SENDING");
    });

    it.each(["SENT", "FAILED", "EXPIRED"] as const)(
      "%s 작업은 409 job-not-cancelable이다",
      async (status) => {
        const jobId = await register(`cancel-${status}`);
        await db.pool.query(
          `UPDATE mail_jobs SET status = $2, finished_at = now() WHERE id = $1`,
          [jobId, status],
        );

        const res = await cancel(`/jobs/${jobId}/cancel`);

        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({
          type: "urn:mailo:problem:job-not-cancelable",
          jobStatus: status,
        });
      },
    );

    it("다른 호출처의 작업은 없는 작업과 같은 404이고 작업은 그대로다(존재 노출 금지)", async () => {
      const jobId = await register("cancel-iso");

      const byBeta = await cancel(`/jobs/${jobId}/cancel`, BETA_KEY);
      const missing = await cancel(
        "/jobs/00000000-0000-4000-8000-000000000000/cancel",
        BETA_KEY,
      );

      expect(byBeta.status).toBe(404);
      expect(missing.status).toBe(404);
      const a = (await byBeta.json()) as Json;
      const b = (await missing.json()) as Json;
      // instance(요청 ID)만 다르다.
      expect({ ...a, instance: null }).toEqual({ ...b, instance: null });
      expect((await dbRow(jobId)).status).toBe("PENDING");
    });

    it("jobId 형식이 틀리면 400 validation-failed다. 퍼센트 디코딩 오류도 같다", async () => {
      for (const p of ["/jobs/not-a-uuid/cancel", "/jobs/%/cancel"]) {
        const res = await cancel(p);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          type: "urn:mailo:problem:validation-failed",
          errors: [{ parameter: "jobId", code: "INVALID_FORMAT" }],
        });
      }
    });

    it("인증 없음과 틀린 키는 401이다", async () => {
      const jobId = await register("cancel-auth");
      for (const auth of [null, "wrong-key-0000000000000000000000000000"]) {
        expect((await cancel(`/jobs/${jobId}/cancel`, auth)).status).toBe(401);
      }
      expect((await dbRow(jobId)).status).toBe("PENDING");
    });
  });

  describe("POST /jobs/cancel?idempotencyKey=", () => {
    it("Key로 취소하고 같은 Key를 다시 보내도 200이다", async () => {
      const jobId = await register("cancel-by-key");

      const res = await cancel("/jobs/cancel?idempotencyKey=cancel-by-key");
      const again = await cancel("/jobs/cancel?idempotencyKey=cancel-by-key");

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        jobId,
        status: "CANCELED",
        canceledBy: "CALLER",
      });
      expect(again.status).toBe(200);
    });

    it("Key가 없거나 형식이 틀리면 400이다", async () => {
      const missing = await cancel("/jobs/cancel");
      const invalid = await cancel("/jobs/cancel?idempotencyKey=bad%20key");

      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({
        errors: [{ parameter: "idempotencyKey", code: "REQUIRED" }],
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        errors: [{ parameter: "idempotencyKey", code: "INVALID_FORMAT" }],
      });
    });

    it("등록되지 않은 Key와 다른 호출처의 Key는 같은 404다", async () => {
      await register("cancel-key-iso");

      const other = await cancel(
        "/jobs/cancel?idempotencyKey=cancel-key-iso",
        BETA_KEY,
      );
      const none = await cancel(
        "/jobs/cancel?idempotencyKey=never-registered",
        BETA_KEY,
      );

      expect(other.status).toBe(404);
      expect(none.status).toBe(404);
      expect(await other.json()).toMatchObject({
        type: "urn:mailo:problem:not-found",
      });
    });

    it("본문을 보내도 읽지 않고 처리한다", async () => {
      await register("cancel-body");

      const res = await cancel(
        "/jobs/cancel?idempotencyKey=cancel-body",
        ALPHA_KEY,
        {
          headers: {
            Authorization: `Bearer ${ALPHA_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ignored: true }),
        },
      );

      expect(res.status).toBe(200);
    });
  });

  describe("Key 계약(RQ-034, ADR-0011 결정 4)", () => {
    it("취소된 작업의 Key로 같은 내용을 다시 보내면 200과 CANCELED 작업이 온다. 다른 내용은 409다", async () => {
      const jobId = await register("cancel-key-contract");
      await cancel(`/jobs/${jobId}/cancel`);

      const same = await postJob(app, { key: "cancel-key-contract" });
      const diff = await postJob(app, {
        key: "cancel-key-contract",
        body: plainMail({ subject: "다른 제목" }),
      });

      expect(same.status).toBe(200);
      expect(await same.json()).toMatchObject({ jobId, status: "CANCELED" });
      expect(diff.status).toBe(409);
      // 새 작업이 생기지 않았다.
      const { rows } = await db.pool.query(
        "SELECT count(*)::int AS n FROM mail_jobs",
      );
      expect(rows[0].n).toBe(1);
    });

    it("조회 API가 CANCELED를 보여 주고 sentAt·failedAt·failureReason은 null이다", async () => {
      const jobId = await register("cancel-lookup");
      await cancel(`/jobs/${jobId}/cancel`);

      const byId = (await (
        await getJson(app, `/jobs/${jobId}`)
      ).json()) as Json;
      const byKey = (await (
        await getJson(app, "/jobs?idempotencyKey=cancel-lookup")
      ).json()) as Json;

      expect(byId).toEqual(byKey);
      expect(byId).toMatchObject({
        status: "CANCELED",
        canceledBy: "CALLER",
        sentAt: null,
        failedAt: null,
        failureReason: null,
      });
    });

    it("취소하지 않은 작업의 Job은 canceledAt·canceledBy가 null이다", async () => {
      const jobId = await register("not-canceled");

      const job = (await (await getJson(app, `/jobs/${jobId}`)).json()) as Json;

      expect(job).toMatchObject({
        status: "PENDING",
        canceledAt: null,
        canceledBy: null,
      });
    });
  });

  describe("이벤트 피드(RQ-017, ADR-0011 결정 4)", () => {
    it("취소하면 호출처 피드에 JOB_CANCELED가 한 건 생기고 canceledBy를 담는다", async () => {
      const jobId = await register(
        "cancel-event",
        plainMail({ to: ["kim@example.com"], cc: ["lee@example.com"] }),
      );
      await cancel(`/jobs/${jobId}/cancel`);
      await cancel(`/jobs/${jobId}/cancel`);

      const res = await getJson(app, "/events?type=JOB_CANCELED");

      expect(res.status).toBe(200);
      const page = (await res.json()) as { events: Json[] };
      expect(page.events).toHaveLength(1);
      const event = page.events[0]!;
      expect(event).toMatchObject({
        type: "JOB_CANCELED",
        jobId,
        idempotencyKey: "cancel-event",
        attempts: 0,
        canceledBy: "CALLER",
        recipients: {
          to: ["kim@example.com"],
          cc: ["lee@example.com"],
          bcc: [],
        },
      });
      // 취소는 실패가 아니므로 실패 필드를 내지 않는다.
      expect(event).not.toHaveProperty("failureReason");
      expect(event).not.toHaveProperty("lastError");
      expect(event).not.toHaveProperty("rejectedRecipients");
      expect(Object.keys(event).sort()).toEqual(
        [
          "attempts",
          "canceledBy",
          "eventId",
          "idempotencyKey",
          "jobId",
          "occurredAt",
          "recipients",
          "recipientsRedacted",
          "type",
        ].sort(),
      );
    });

    it("type 필터는 JOB_CANCELED만 거르고 다른 종류와 함께 지정할 수 있다", async () => {
      const jobId = await register("cancel-filter");
      await cancel(`/jobs/${jobId}/cancel`);
      const other = await register("sent-filter");
      await db.pool.query(
        `UPDATE mail_jobs SET status = 'SENT', finished_at = now() WHERE id = $1`,
        [other],
      );
      await db.pool.query(
        `INSERT INTO mail_events (caller_id, type, job_id, idempotency_key, attempt_count, recipients)
         VALUES ('alpha', 'JOB_SENT', $1, 'sent-filter', 1, '{"to":["kim@example.com"]}')`,
        [other],
      );

      const only = (await (
        await getJson(app, "/events?type=JOB_CANCELED")
      ).json()) as { events: Json[] };
      const both = (await (
        await getJson(app, "/events?type=JOB_CANCELED&type=JOB_SENT")
      ).json()) as { events: Json[] };
      const all = (await (await getJson(app, "/events")).json()) as {
        events: Json[];
      };

      expect(only.events.map((e) => e["type"])).toEqual(["JOB_CANCELED"]);
      expect(both.events.map((e) => e["type"]).sort()).toEqual([
        "JOB_CANCELED",
        "JOB_SENT",
      ]);
      expect(all.events).toHaveLength(2);
    });

    it("다른 호출처의 피드에는 나타나지 않는다", async () => {
      const jobId = await register("cancel-feed-iso");
      await cancel(`/jobs/${jobId}/cancel`);

      const beta = (await (await getJson(app, "/events", BETA_KEY)).json()) as {
        events: Json[];
      };

      expect(beta.events).toEqual([]);
    });

    it("모르는 type은 여전히 400이다", async () => {
      const res = await getJson(app, "/events?type=JOB_PAUSED");

      expect(res.status).toBe(400);
    });
  });

  describe("시크릿 비노출(RQ-027)", () => {
    it("취소 응답·이벤트·로그에 본문, 제목, 수신자, Key가 없다", async () => {
      const key = `cancel-${CANARY.key}`;
      const jobId = await register(
        key,
        plainMail({
          to: [`${CANARY.recipient}@example.com`],
          subject: CANARY.subject,
          text: CANARY.text,
          html: `<p>${CANARY.html}</p>`,
        }),
      );
      app.logs.lines.length = 0;

      const byId = await cancel(`/jobs/${jobId}/cancel`);
      const byKey = await cancel(`/jobs/cancel?idempotencyKey=${key}`);
      const notFound = await cancel(
        `/jobs/cancel?idempotencyKey=missing-${CANARY.key}`,
        BETA_KEY,
      );
      const bodies = [
        await byId.text(),
        await byKey.text(),
        await notFound.text(),
      ].join("\n");

      // 취소 응답(Job)은 수신자와 본문을 담지 않는다. Key는 호출처 자신의 값이라 응답에 있다.
      for (const canary of [
        CANARY.subject,
        CANARY.text,
        CANARY.html,
        CANARY.recipient,
      ])
        expect(bodies).not.toContain(canary);
      expect(bodies).not.toContain(`missing-${CANARY.key}`);

      // 로그에는 값이 들어가지 않는다. Key도 요청 값이라 남기지 않는다.
      const logs = app.logs.lines.join("\n");
      for (const canary of [
        CANARY.subject,
        CANARY.text,
        CANARY.html,
        CANARY.recipient,
        CANARY.key,
        CANARY.smtpPassword,
      ])
        expect(logs).not.toContain(canary);

      // DB의 이벤트에 본문이 없다.
      const { rows } = await db.pool.query(
        "SELECT * FROM mail_events WHERE job_id = $1",
        [jobId],
      );
      const dump = JSON.stringify(rows);
      for (const canary of [CANARY.subject, CANARY.text, CANARY.html])
        expect(dump).not.toContain(canary);
    });

    it("취소 로그 job_canceled는 jobId·callerId·canceledBy만 담고 멱등 재요청에는 남기지 않는다", async () => {
      const jobId = await register("cancel-log");
      app.logs.lines.length = 0;

      await cancel(`/jobs/${jobId}/cancel`);
      await cancel(`/jobs/${jobId}/cancel`);

      const entries = app.logs.lines
        .flatMap((l) => l.split("\n"))
        .filter((l) => l.includes('"job_canceled"'))
        .map((l) => JSON.parse(l) as Json);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        level: "info",
        event: "job_canceled",
        jobId,
        callerId: "alpha",
        canceledBy: "CALLER",
      });
      expect(Object.keys(entries[0]!).sort()).toEqual(
        [
          "callerId",
          "canceledBy",
          "event",
          "instance",
          "jobId",
          "level",
          "ts",
        ].sort(),
      );
    });
  });
});
