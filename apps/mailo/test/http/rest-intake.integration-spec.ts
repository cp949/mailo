import "reflect-metadata";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import {
  recordIntakeRejection,
  recordJobEvent,
} from "../../src/events/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { migrate } from "../support/queue-fixtures.js";
import {
  ALPHA_KEY,
  ALPHA_KEY_NEXT,
  BETA_KEY,
  CANARY,
  getJson,
  plainMail,
  postJob,
  startRestApp,
  type RestApp,
} from "../support/rest-app.js";

describe("REST 통합: 등록·조회·이벤트·헬스 (RQ-001, 011, 015, 017, 027, 028, 031)", () => {
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
    await db.pool.query("DELETE FROM mail_intake_rejections");
    await db.pool.query(
      "UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL, probe_job_id = NULL, last_reason = NULL, wait_seconds = 0, consecutive_failures = 0",
    );
  });

  async function jobCount(): Promise<number> {
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM mail_jobs",
    );
    return rows[0].n;
  }

  describe("POST /jobs", () => {
    it("신규 요청은 202와 PENDING 작업을 반환하고 Location을 준다(RQ-001)", async () => {
      const res = await postJob(app, { key: "outbox-8841" });

      expect(res.status).toBe(202);
      const job = (await res.json()) as Record<string, unknown>;
      expect(res.headers.get("location")).toBe(`/jobs/${job["jobId"]}`);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(job).toMatchObject({
        idempotencyKey: "outbox-8841",
        status: "PENDING",
        attempts: 0,
        sentAt: null,
        failedAt: null,
        failureReason: null,
        lastError: null,
        rejectedRecipients: [],
      });
      expect(Object.keys(job).sort()).toEqual(
        [
          "attempts",
          "createdAt",
          "expiresAt",
          "failedAt",
          "failureReason",
          "idempotencyKey",
          "jobId",
          "lastError",
          "rejectedRecipients",
          "sentAt",
          "status",
        ].sort(),
      );
    });

    it("본문은 DB에 평문으로 남지 않고 수신자와 봉투만 평문이다(RQ-023)", async () => {
      const mail = plainMail({
        subject: CANARY.subject,
        text: CANARY.text,
        html: `<p>${CANARY.html}</p>`,
      });
      const res = await postJob(app, { key: "outbox-enc", body: mail });
      expect(res.status).toBe(202);

      const { rows } = await db.pool.query(
        "SELECT body_ciphertext, recipients, envelope FROM mail_jobs WHERE idempotency_key = 'outbox-enc'",
      );
      const dump = Buffer.from(rows[0].body_ciphertext).toString("latin1");
      for (const canary of [CANARY.subject, CANARY.text, CANARY.html])
        expect(dump).not.toContain(canary);
      expect(rows[0].recipients).toEqual({
        to: ["kim@example.com"],
        cc: [],
        bcc: [],
      });
      expect(rows[0].envelope).toEqual({
        from: "no-reply@example.com",
        replyTo: null,
      });
    });

    it("같은 Key와 같은 내용이면 200과 같은 작업을 반환하고 작업은 하나뿐이다(RQ-011)", async () => {
      const first = await postJob(app, { key: "same-key" });
      const second = await postJob(app, { key: "same-key" });

      expect(first.status).toBe(202);
      expect(second.status).toBe(200);
      const a = (await first.json()) as { jobId: string };
      const b = (await second.json()) as { jobId: string };
      expect(b.jobId).toBe(a.jobId);
      expect(second.headers.get("location")).toBe(`/jobs/${a.jobId}`);
      expect(await jobCount()).toBe(1);
    });

    it("두 번째 API 키(교체용)로도 같은 호출처로 인증돼 같은 작업을 반환한다(RQ-028)", async () => {
      const first = await postJob(app, { key: "rotate-key", auth: ALPHA_KEY });
      const second = await postJob(app, {
        key: "rotate-key",
        auth: ALPHA_KEY_NEXT,
      });

      expect(first.status).toBe(202);
      expect(second.status).toBe(200);
    });

    it("수신자 순서만 다른 재시도는 같은 내용으로 본다", async () => {
      await postJob(app, {
        key: "order-key",
        body: plainMail({ to: ["a@example.com", "b@example.com"] }),
      });
      const retry = await postJob(app, {
        key: "order-key",
        body: plainMail({ to: ["b@example.com", "a@example.com"] }),
      });

      expect(retry.status).toBe(200);
    });

    it("같은 Key에 다른 내용이면 409 problem+json이고 먼저 등록된 jobId를 알리며 두 번째 메일은 등록하지 않는다", async () => {
      const first = (await (
        await postJob(app, { key: "conflict-key" })
      ).json()) as { jobId: string };

      const res = await postJob(app, {
        key: "conflict-key",
        body: plainMail({ cc: ["lee@example.com"] }),
      });

      expect(res.status).toBe(409);
      expect(res.headers.get("content-type")).toContain(
        "application/problem+json",
      );
      const problem = (await res.json()) as Record<string, unknown>;
      expect(problem).toMatchObject({
        type: "urn:mailo:problem:idempotency-conflict",
        title: "Idempotency-Key conflict",
        status: 409,
        jobId: first.jobId,
      });
      expect(problem["instance"]).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
      expect(await jobCount()).toBe(1);
    });

    it("다른 호출처가 같은 Key를 써도 서로 영향이 없다(Key 유일성은 호출처 범위)", async () => {
      const a = await postJob(app, { key: "shared-key", auth: ALPHA_KEY });
      const b = await postJob(app, {
        key: "shared-key",
        auth: BETA_KEY,
        body: plainMail({ subject: "다른 내용" }),
      });

      expect(a.status).toBe(202);
      expect(b.status).toBe(202);
      expect(await jobCount()).toBe(2);
    });

    it("Idempotency-Key가 없으면 400 validation-failed이고 등록하지 않는다", async () => {
      const res = await postJob(app, { key: null });

      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain(
        "application/problem+json",
      );
      const problem = (await res.json()) as { type: string; errors: unknown[] };
      expect(problem.type).toBe("urn:mailo:problem:validation-failed");
      expect(problem.errors).toEqual([
        { parameter: "Idempotency-Key", code: "REQUIRED" },
      ]);
      expect(await jobCount()).toBe(0);
    });

    it("Key 형식·길이 위반은 400이다(1~128자, [A-Za-z0-9._:-])", async () => {
      const badFormat = await postJob(app, { key: "space in/key" });
      const tooLong = await postJob(app, { key: "k".repeat(129) });

      expect(
        ((await badFormat.json()) as { errors: unknown[] }).errors,
      ).toEqual([{ parameter: "Idempotency-Key", code: "INVALID_FORMAT" }]);
      expect(((await tooLong.json()) as { errors: unknown[] }).errors).toEqual([
        { parameter: "Idempotency-Key", code: "TOO_LONG" },
      ]);
    });

    it("헤더 오류와 본문 오류를 한 응답에 함께 담는다", async () => {
      const res = await postJob(app, { key: null, body: { to: [] } });

      const { errors } = (await res.json()) as { errors: unknown[] };
      expect(errors).toEqual(
        expect.arrayContaining([
          { parameter: "Idempotency-Key", code: "REQUIRED" },
          { pointer: "/to", code: "REQUIRED" },
          { pointer: "/subject", code: "REQUIRED" },
        ]),
      );
    });

    it("인증 실패는 401이고 WWW-Authenticate: Bearer를 준다(헤더 없음, 틀린 키, 형식 오류 모두 같은 응답)", async () => {
      const responses = await Promise.all([
        postJob(app, { auth: null }),
        postJob(app, { auth: "wrong-key" }),
        postJob(app, { headers: { Authorization: "Basic abc" }, auth: null }),
        postJob(app, { headers: { Authorization: "Bearer" }, auth: null }),
      ]);

      const bodies = [];
      for (const res of responses) {
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe("Bearer");
        expect(res.headers.get("content-type")).toContain(
          "application/problem+json",
        );
        const { instance: _instance, ...rest } = (await res.json()) as Record<
          string,
          unknown
        >;
        bodies.push(rest);
      }
      for (const body of bodies) expect(body).toEqual(bodies[0]);
      expect(bodies[0]).toMatchObject({
        type: "urn:mailo:problem:unauthorized",
        status: 401,
      });
      expect(await jobCount()).toBe(0);
    });

    it("인증이 요청 검증보다 먼저다. 키 없는 호출은 본문이 잘못돼도 401이다", async () => {
      const res = await postJob(app, {
        auth: null,
        key: null,
        body: "{not json",
      });

      expect(res.status).toBe(401);
    });

    it("원시 요청이 2 MiB를 넘으면 413이고 등록하지 않는다(RQ-030)", async () => {
      const big = JSON.stringify(
        plainMail({ text: "x".repeat(2 * 1024 * 1024) }),
      );

      const res = await postJob(app, { key: "big-1", body: big });

      expect(res.status).toBe(413);
      expect(res.headers.get("content-type")).toContain(
        "application/problem+json",
      );
      expect(((await res.json()) as { type: string }).type).toBe(
        "urn:mailo:problem:payload-too-large",
      );
      expect(await jobCount()).toBe(0);
    });

    it("길이를 모르는 chunked 본문도 읽다가 상한을 넘으면 413이다", async () => {
      const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
      // 3 MiB를 세 번에 나눠 보낸다. 무한 스트림은 서버가 읽기를 멈춘 뒤 클라이언트 메모리를 키운다.
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent < 3) controller.enqueue(chunk);
          else controller.close();
          sent += 1;
        },
      });

      const res = await fetch(`${app.baseUrl}/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "big-2",
          Authorization: `Bearer ${ALPHA_KEY}`,
        },
        body: stream,
        // Node fetch가 스트림 요청 본문에 요구하는 옵션이다.
        duplex: "half",
      } as RequestInit);

      expect(res.status).toBe(413);
      expect(await jobCount()).toBe(0);
    });

    it("복호화 뒤 제목+text+html이 1 MiB를 넘으면 413이 아니라 400 TOO_LARGE다", async () => {
      const res = await postJob(app, {
        key: "big-3",
        body: plainMail({ text: "x".repeat(1024 * 1024 + 1) }),
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { errors: unknown[] }).errors).toEqual([
        { pointer: "", code: "TOO_LARGE" },
      ]);
    });

    it("Content-Type이 application/json이 아니면 415다(없는 경우 포함)", async () => {
      const text = await postJob(app, {
        headers: { "Content-Type": "text/plain" },
      });
      const form = await postJob(app, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const missing = await fetch(`${app.baseUrl}/jobs`, {
        method: "POST",
        headers: {
          "Idempotency-Key": "ct-1",
          Authorization: `Bearer ${ALPHA_KEY}`,
        },
      });

      for (const res of [text, form, missing]) {
        expect(res.status).toBe(415);
        expect(res.headers.get("content-type")).toContain(
          "application/problem+json",
        );
        expect(((await res.json()) as { type: string }).type).toBe(
          "urn:mailo:problem:unsupported-media-type",
        );
      }
      expect(await jobCount()).toBe(0);
    });

    it.each([
      "application/json; charset=utf8",
      "application/json; charset=UTF8",
      'application/json; charset="UTF-8"',
    ])("Content-Type이 %s이면 utf-8과 같게 받아들인다", async (contentType) => {
      const res = await postJob(app, {
        key: `ct-utf8-${contentType.length}`,
        headers: { "Content-Type": contentType },
        body: plainMail(),
      });

      expect(res.status).toBe(202);
    });

    it("charset이 utf-8 계열이 아니면 415다", async () => {
      const res = await postJob(app, {
        headers: { "Content-Type": "application/json; charset=latin1" },
      });

      expect(res.status).toBe(415);
    });

    it("JSON 구문 오류는 400 malformed-request다", async () => {
      const res = await postJob(app, { body: '{"to": [' });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { type: string }).type).toBe(
        "urn:mailo:problem:malformed-request",
      );
    });

    it("from을 생략하면 등록되고 봉투의 from은 null이다(Worker가 SMTP 발신 계정으로 채운다)", async () => {
      const mail = plainMail();
      delete mail["from"];

      const res = await postJob(app, { key: "no-from", body: mail });

      expect(res.status).toBe(202);
      const { rows } = await db.pool.query(
        "SELECT envelope FROM mail_jobs WHERE idempotency_key = 'no-from'",
      );
      expect(rows[0].envelope).toEqual({ from: null, replyTo: null });
    });

    it("검증 오류는 위치와 고정 코드만 담는다(제목 CR·LF, 잘못된 주소, 첨부, 알 수 없는 필드는 이름 없이 본문 위치, null 값)", async () => {
      const res = await postJob(app, {
        body: {
          to: ["not-an-address"],
          subject: "줄\r\n바꿈",
          text: "t",
          attachments: [],
          unknownThing: 1,
          html: null,
        },
      });

      expect(res.status).toBe(400);
      const { errors } = (await res.json()) as { errors: unknown[] };
      expect(errors).toEqual(
        expect.arrayContaining([
          { pointer: "/to/0", code: "INVALID_FORMAT" },
          { pointer: "/subject", code: "CONTROL_CHARACTER" },
          { pointer: "/attachments", code: "ATTACHMENTS_NOT_SUPPORTED" },
          { pointer: "", code: "UNKNOWN_FIELD" },
          { pointer: "/html", code: "INVALID_FORMAT" },
        ]),
      );
    });

    it("평문 필드와 content를 섞으면 CONFLICTING_FIELDS이고, 형식이 틀린 content는 INVALID_FORMAT이다", async () => {
      const jwe = "aaa.bbb.ccc.ddd.eee";
      const mixed = await postJob(app, { body: plainMail({ content: jwe }) });
      const malformed = await postJob(app, {
        body: { to: ["kim@example.com"], content: "not-a-jwe" },
      });

      expect(((await mixed.json()) as { errors: unknown[] }).errors).toEqual([
        { pointer: "/content", code: "CONFLICTING_FIELDS" },
      ]);
      expect(
        ((await malformed.json()) as { errors: unknown[] }).errors,
      ).toEqual([{ pointer: "/content", code: "INVALID_FORMAT" }]);
      expect(await jobCount()).toBe(0);
    });

    it("개인키를 설정하지 않은 배치에서 복호화할 수 없는 content는 400이다(RQ-022, ADR-0008)", async () => {
      const jwe = "aaa.bbb.ccc.ddd.eee"; // 헤더가 JSON이 아니다
      const res = await postJob(app, {
        body: { to: ["kim@example.com"], content: jwe },
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { errors: unknown[] }).errors).toEqual([
        { pointer: "/content", code: "DECRYPTION_FAILED" },
      ]);
      expect(await jobCount()).toBe(0);
    });

    it("수신자가 50명을 넘으면 400 TOO_MANY다", async () => {
      const to = Array.from({ length: 51 }, (_, i) => `u${i}@example.com`);

      const res = await postJob(app, { body: plainMail({ to }) });

      expect(((await res.json()) as { errors: unknown[] }).errors).toEqual([
        { pointer: "/to", code: "TOO_MANY" },
      ]);
    });
  });

  describe("GET /jobs/{jobId}, GET /jobs?idempotencyKey=", () => {
    it("작업 ID와 Key로 같은 작업을 조회한다(RQ-015)", async () => {
      const created = (await (
        await postJob(app, { key: "lookup-key" })
      ).json()) as { jobId: string };

      const byId = await getJson(app, `/jobs/${created.jobId}`);
      const byKey = await getJson(app, "/jobs?idempotencyKey=lookup-key");

      expect(byId.status).toBe(200);
      expect(byKey.status).toBe(200);
      const a = (await byId.json()) as Record<string, unknown>;
      expect(a["status"]).toBe("PENDING");
      expect(await byKey.json()).toEqual(a);
    });

    it("다른 호출처의 작업은 ID로도 Key로도 404이고 없는 작업과 같은 응답이다", async () => {
      const created = (await (
        await postJob(app, { key: "private-key", auth: ALPHA_KEY })
      ).json()) as {
        jobId: string;
      };

      const byId = await getJson(app, `/jobs/${created.jobId}`, BETA_KEY);
      const byKey = await getJson(
        app,
        "/jobs?idempotencyKey=private-key",
        BETA_KEY,
      );
      const missing = await getJson(
        app,
        "/jobs/3f0e9a52-6b1d-4c8e-9f27-1a5d7c4b8e90",
        BETA_KEY,
      );

      for (const res of [byId, byKey, missing]) {
        expect(res.status).toBe(404);
        expect(res.headers.get("content-type")).toContain(
          "application/problem+json",
        );
      }
      const strip = async (res: Response) => {
        const { instance: _instance, ...rest } = (await res.json()) as Record<
          string,
          unknown
        >;
        return rest;
      };
      const missingBody = await strip(missing);
      expect(await strip(byId)).toEqual(missingBody);
      expect(await strip(byKey)).toEqual(missingBody);
    });

    it("SENT·FAILED 작업은 시각, 실패 원인(계약 이름), 마지막 오류, 거부 수신자를 반환한다", async () => {
      const sent = (await (
        await postJob(app, { key: "state-sent" })
      ).json()) as { jobId: string };
      const failed = (await (
        await postJob(app, { key: "state-failed" })
      ).json()) as { jobId: string };
      await db.pool.query(
        "UPDATE mail_jobs SET status = 'SENT', attempts = 2, finished_at = now() WHERE id = $1",
        [sent.jobId],
      );
      await db.pool.query(
        `INSERT INTO mail_attempts (job_id, classification, counted, response_code, enhanced_code, response_text, started_at)
         VALUES ($1, 'TRANSIENT', true, 421, '4.7.0', $2, now())`,
        [sent.jobId, `응답 텍스트 ${CANARY.recipient}`],
      );
      await db.pool.query(
        `INSERT INTO mail_attempts (job_id, classification, counted, rejected_recipients, started_at)
         VALUES ($1, 'SENT', true, $2::jsonb, now())`,
        [
          sent.jobId,
          JSON.stringify([
            {
              address: "park@example.com",
              responseCode: 550,
              enhancedStatus: "5.1.1",
              responseText: "x",
            },
          ]),
        ],
      );
      await db.pool.query(
        "UPDATE mail_jobs SET status = 'FAILED', attempts = 8, failure_reason = 'ATTEMPTS_EXHAUSTED', finished_at = now() WHERE id = $1",
        [failed.jobId],
      );

      const sentBody = (await (
        await getJson(app, `/jobs/${sent.jobId}`)
      ).json()) as Record<string, unknown>;
      const failedBody = (await (
        await getJson(app, `/jobs/${failed.jobId}`)
      ).json()) as Record<string, unknown>;

      expect(sentBody).toMatchObject({
        status: "SENT",
        attempts: 2,
        failedAt: null,
        failureReason: null,
        lastError: {
          category: "TRANSIENT",
          smtpCode: 421,
          enhancedCode: "4.7.0",
        },
        rejectedRecipients: [
          { address: "park@example.com", smtpCode: 550, enhancedCode: "5.1.1" },
        ],
      });
      expect(sentBody["sentAt"]).toEqual(expect.stringMatching(/Z$/));
      expect(JSON.stringify(sentBody)).not.toContain(CANARY.recipient);
      expect(failedBody).toMatchObject({
        status: "FAILED",
        sentAt: null,
        failureReason: "MAX_ATTEMPTS_EXCEEDED",
        lastError: null,
      });
      expect(failedBody["failedAt"]).toEqual(expect.stringMatching(/Z$/));
    });

    it("경로 디코딩에 실패하는 jobId(%)는 malformed-request가 아니라 validation-failed 400이다", async () => {
      const res = await getJson(app, "/jobs/%");

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        type: string;
        errors?: unknown[];
      };
      expect(body.type).toBe("urn:mailo:problem:validation-failed");
      expect(body.errors).toEqual([
        { parameter: "jobId", code: "INVALID_FORMAT" },
      ]);
    });

    it.each([
      ["id가 bigint 범위 밖", { txid: "1", id: "9223372036854775808" }],
      ["txid가 xid8 범위 밖", { txid: "18446744073709551616", id: "1" }],
    ])(
      "범위를 벗어난 cursor(%s)는 503이 아니라 400 INVALID_FORMAT이다",
      async (_name, cursor) => {
        const after = Buffer.from(`${cursor.txid}:${cursor.id}`).toString(
          "base64url",
        );

        const res = await getJson(app, `/events?after=${after}`);

        expect(res.status).toBe(400);
        expect(((await res.json()) as { errors: unknown[] }).errors).toEqual([
          { parameter: "after", code: "INVALID_FORMAT" },
        ]);
      },
    );

    it("jobId 형식과 Key 파라미터가 잘못되면 400이다", async () => {
      const badId = await getJson(app, "/jobs/not-a-uuid");
      const noKey = await getJson(app, "/jobs");
      const badKey = await getJson(
        app,
        "/jobs?idempotencyKey=" + encodeURIComponent("a b"),
      );

      expect(((await badId.json()) as { errors: unknown[] }).errors).toEqual([
        { parameter: "jobId", code: "INVALID_FORMAT" },
      ]);
      expect(((await noKey.json()) as { errors: unknown[] }).errors).toEqual([
        { parameter: "idempotencyKey", code: "REQUIRED" },
      ]);
      expect(((await badKey.json()) as { errors: unknown[] }).errors).toEqual([
        { parameter: "idempotencyKey", code: "INVALID_FORMAT" },
      ]);
    });

    it("인증 없이는 조회할 수 없다(401)", async () => {
      expect((await getJson(app, "/jobs?idempotencyKey=x", null)).status).toBe(
        401,
      );
      expect((await getJson(app, "/events", null)).status).toBe(401);
    });

    it("정의되지 않은 경로는 404 problem+json이다", async () => {
      const res = await getJson(app, "/nope");

      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain(
        "application/problem+json",
      );
    });
  });

  describe("GET /events", () => {
    async function seedJobEvents(
      callerId: string,
      count: number,
      type: "JOB_SENT" | "JOB_FAILED" = "JOB_SENT",
    ) {
      for (let i = 0; i < count; i += 1) {
        const key = `${callerId}-${type}-${i}-${Math.random().toString(36).slice(2, 8)}`;
        const { rows } = await db.pool.query<{ id: string }>(
          `INSERT INTO mail_jobs (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version, status, attempts,
                                  recipients, expires_at, finished_at)
           VALUES (gen_random_uuid(), $1, $2, '\\x00', 1, $3, 1, $4::jsonb, now() + interval '1 day', now())
           RETURNING id`,
          [
            callerId,
            key,
            type === "JOB_SENT" ? "SENT" : "FAILED",
            JSON.stringify({ to: ["kim@example.com"], cc: [], bcc: [] }),
          ],
        );
        const jobId = rows[0]!.id;
        if (type === "JOB_FAILED") {
          await db.pool.query(
            `INSERT INTO mail_attempts (job_id, classification, counted, response_code, enhanced_code, started_at)
             VALUES ($1, 'PERMANENT', true, 550, '5.1.1', now())`,
            [jobId],
          );
        }
        await recordJobEvent(db.pool, {
          type,
          callerId,
          jobId,
          idempotencyKey: key,
          failureReason: type === "JOB_FAILED" ? "PERMANENT" : null,
          failureDetail: type === "JOB_FAILED" ? "550 5.1.1" : null,
          attemptCount: 1,
          recipients: { to: ["kim@example.com"], cc: [], bcc: [] },
          rejectedRecipients:
            type === "JOB_SENT"
              ? [{ address: "park@example.com", responseCode: 550 }]
              : null,
        });
      }
    }

    it("cursor로 페이지를 이어 읽고 hasMore가 마지막에 false가 된다(ADR-0006 결정 2·7)", async () => {
      await seedJobEvents("alpha", 5);

      const first = (await (await getJson(app, "/events?limit=2")).json()) as {
        events: Array<{ eventId: string }>;
        nextCursor: string;
        hasMore: boolean;
      };
      const second = (await (
        await getJson(app, `/events?limit=2&after=${first.nextCursor}`)
      ).json()) as typeof first;
      const third = (await (
        await getJson(app, `/events?limit=2&after=${second.nextCursor}`)
      ).json()) as typeof first;
      const empty = (await (
        await getJson(app, `/events?limit=2&after=${third.nextCursor}`)
      ).json()) as typeof first;

      expect([
        first.events.length,
        second.events.length,
        third.events.length,
      ]).toEqual([2, 2, 1]);
      expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([
        true,
        true,
        false,
      ]);
      const ids = [...first.events, ...second.events, ...third.events].map(
        (e) => e.eventId,
      );
      expect(new Set(ids).size).toBe(5);
      expect(empty).toEqual({
        events: [],
        nextCursor: third.nextCursor,
        hasMore: false,
      });
    });

    it("페이지가 정확히 가득 차고 뒤에 이벤트가 없으면 hasMore는 false다", async () => {
      await seedJobEvents("alpha", 2);

      const page = (await (await getJson(app, "/events?limit=2")).json()) as {
        events: unknown[];
        hasMore: boolean;
      };

      expect(page.events).toHaveLength(2);
      expect(page.hasMore).toBe(false);
    });

    it("after 없이 이벤트가 없으면 nextCursor는 null이다", async () => {
      const page = await (await getJson(app, "/events")).json();

      expect(page).toEqual({ events: [], nextCursor: null, hasMore: false });
    });

    it("자기 호출처의 이벤트만 반환한다. 다른 호출처 이벤트는 보이지 않는다(RQ-017)", async () => {
      await seedJobEvents("alpha", 2);
      await seedJobEvents("beta", 3);

      const alpha = (await (
        await getJson(app, "/events", ALPHA_KEY)
      ).json()) as { events: unknown[] };
      const beta = (await (await getJson(app, "/events", BETA_KEY)).json()) as {
        events: unknown[];
      };

      expect(alpha.events).toHaveLength(2);
      expect(beta.events).toHaveLength(3);
    });

    it("type 필터는 반복해서 여러 종류를 받고, 이벤트 모양이 계약과 같다", async () => {
      await seedJobEvents("alpha", 1, "JOB_SENT");
      await seedJobEvents("alpha", 1, "JOB_FAILED");
      await recordIntakeRejection(db.pool, {
        callerId: "alpha",
        fileName: "7c9e6679.json",
        sizeBytes: 412,
        sha256:
          "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        idempotencyKey: null,
        reasonCode: "MALFORMED",
      });

      const all = (await (await getJson(app, "/events")).json()) as {
        events: Array<Record<string, unknown>>;
      };
      const failedOnly = (await (
        await getJson(app, "/events?type=JOB_FAILED")
      ).json()) as typeof all;
      const two = (await (
        await getJson(app, "/events?type=JOB_SENT&type=INTAKE_REJECTED")
      ).json()) as typeof all;

      expect(all.events.map((e) => e["type"]).sort()).toEqual([
        "INTAKE_REJECTED",
        "JOB_FAILED",
        "JOB_SENT",
      ]);
      expect(failedOnly.events.map((e) => e["type"])).toEqual(["JOB_FAILED"]);
      expect(two.events.map((e) => e["type"]).sort()).toEqual([
        "INTAKE_REJECTED",
        "JOB_SENT",
      ]);

      const byType = Object.fromEntries(all.events.map((e) => [e["type"], e]));
      expect(byType["JOB_SENT"]).toMatchObject({
        attempts: 1,
        recipients: { to: ["kim@example.com"], cc: [], bcc: [] },
        rejectedRecipients: [
          { address: "park@example.com", smtpCode: 550, enhancedCode: null },
        ],
      });
      expect(byType["JOB_FAILED"]).toMatchObject({
        failureReason: "PERMANENT_ERROR",
        lastError: {
          category: "PERMANENT",
          smtpCode: 550,
          enhancedCode: "5.1.1",
        },
      });
      expect(byType["INTAKE_REJECTED"]).toMatchObject({
        idempotencyKey: null,
        fileName: "7c9e6679.json",
        fileSize: 412,
        sha256:
          "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        reasonCode: "MALFORMED",
      });
      expect(typeof byType["JOB_SENT"]!["eventId"]).toBe("string");
    });

    it("limit·type·after가 잘못되면 400이고 위치만 알린다", async () => {
      const cases: Array<[string, unknown]> = [
        ["/events?limit=0", { parameter: "limit", code: "INVALID_FORMAT" }],
        ["/events?limit=501", { parameter: "limit", code: "INVALID_FORMAT" }],
        ["/events?limit=abc", { parameter: "limit", code: "INVALID_FORMAT" }],
        ["/events?type=NOPE", { parameter: "type", code: "INVALID_FORMAT" }],
        [
          "/events?type=JOB_SENT&type=JOB_SENT",
          { parameter: "type", code: "INVALID_FORMAT" },
        ],
        [
          "/events?after=%25%25%25",
          { parameter: "after", code: "INVALID_FORMAT" },
        ],
        [
          `/events?after=${"a".repeat(257)}`,
          { parameter: "after", code: "TOO_LONG" },
        ],
        ["/events?after=", { parameter: "after", code: "INVALID_FORMAT" }],
      ];
      for (const [url, expected] of cases) {
        const res = await getJson(app, url);
        expect([url, res.status]).toEqual([url, 400]);
        expect(((await res.json()) as { errors: unknown[] }).errors).toEqual([
          expected,
        ]);
      }
    });
  });

  describe("헬스", () => {
    it("/health/live는 인증 없이 200이고 필드는 status 하나다", async () => {
      const res = await getJson(app, "/health/live", null);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "UP" });
    });

    it("/health/ready 인증 없음: 차단기 상태만 공개하고 openUntil·lastReason은 생략한다", async () => {
      await db.pool.query(
        "UPDATE mail_circuit_breaker SET state = 'open', open_until = now() + interval '10 minutes', last_reason = 'DAILY_LIMIT'",
      );

      const open = await getJson(app, "/health/ready", null);

      expect(open.status).toBe(200);
      expect(await open.json()).toEqual({
        status: "UP",
        checks: { database: "UP" },
        circuitBreaker: { state: "open" },
      });
    });

    it("/health/ready 유효한 Bearer: open이면 openUntil과 lastReason(계약 이름)을 더한다", async () => {
      await db.pool.query(
        "UPDATE mail_circuit_breaker SET state = 'open', open_until = now() + interval '10 minutes', last_reason = 'DAILY_LIMIT'",
      );

      const res = await getJson(app, "/health/ready", ALPHA_KEY);

      const body = (await res.json()) as {
        circuitBreaker: Record<string, unknown>;
      };
      expect(res.status).toBe(200);
      expect(body.circuitBreaker["state"]).toBe("open");
      expect(body.circuitBreaker["lastReason"]).toBe("QUOTA_DAILY");
      expect(body.circuitBreaker["openUntil"]).toEqual(
        expect.stringMatching(/Z$/),
      );
    });

    it("/health/ready closed 상태는 인증돼도 openUntil·lastReason이 null이다", async () => {
      const res = await getJson(app, "/health/ready", ALPHA_KEY);

      expect(await res.json()).toEqual({
        status: "UP",
        checks: { database: "UP" },
        circuitBreaker: { state: "closed", openUntil: null, lastReason: null },
        eventFeed: { latestEventAt: null, lagSeconds: null },
      });
    });

    it("/health/ready 유효한 Bearer: 호출처 자신의 이벤트 피드 지연을 반환한다(RQ-017)", async () => {
      const at = (callerId: string, fileName: string) =>
        recordIntakeRejection(db.pool, {
          callerId,
          fileName,
          sizeBytes: 10,
          sha256: "a".repeat(64),
          idempotencyKey: null,
          reasonCode: "MALFORMED",
        });
      await at("alpha", "old.json");
      await at("alpha", "new.json");
      await at("beta", "beta.json");
      await db.pool.query(
        `UPDATE mail_events SET created_at = now() - interval '120 seconds' WHERE caller_id = 'alpha'`,
      );
      await db.pool.query(
        `UPDATE mail_events SET created_at = now() - interval '5 seconds' WHERE caller_id = 'beta'`,
      );

      const res = await getJson(app, "/health/ready", ALPHA_KEY);
      const body = (await res.json()) as {
        eventFeed: { latestEventAt: string; lagSeconds: number };
      };

      expect(res.status).toBe(200);
      expect(body.eventFeed.latestEventAt).toEqual(expect.stringMatching(/Z$/));
      expect(body.eventFeed.lagSeconds).toBeGreaterThanOrEqual(120);
      expect(body.eventFeed.lagSeconds).toBeLessThan(130);
    });

    it("/health/ready 틀린 Authorization은 공개 응답으로 낮추지 않고 401이다", async () => {
      const res = await getJson(app, "/health/ready", "wrong-key");

      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    });

    it("half_open이어도 200이고 openUntil은 null이다", async () => {
      await db.pool.query(
        `UPDATE mail_circuit_breaker SET state = 'half_open', probe_until = now() + interval '1 minute',
                probe_job_id = gen_random_uuid(), last_reason = 'AUTH'`,
      );

      const res = await getJson(app, "/health/ready", ALPHA_KEY);

      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { circuitBreaker: unknown }).circuitBreaker,
      ).toEqual({
        state: "half_open",
        openUntil: null,
        lastReason: "AUTH_FAILED",
      });
    });
  });

  describe("DB 장애(RQ-001, RQ-031)", () => {
    it("DB에 연결할 수 없으면 POST /jobs는 503 problem+json, ready는 503 DOWN/unknown이다", async () => {
      const pg = await import("pg");
      const deadPool = new pg.default.Pool({
        connectionString: "postgres://nobody:nopass@127.0.0.1:1/none",
        connectionTimeoutMillis: 500,
      });
      const broken = await startRestApp({ pool: deadPool });
      try {
        const post = await postJob(broken, { key: "db-down" });
        const ready = await getJson(broken, "/health/ready", null);
        const live = await getJson(broken, "/health/live", null);

        expect(post.status).toBe(503);
        expect(post.headers.get("content-type")).toContain(
          "application/problem+json",
        );
        expect(((await post.json()) as { type: string }).type).toBe(
          "urn:mailo:problem:service-unavailable",
        );
        expect(ready.status).toBe(503);
        expect(await ready.json()).toEqual({
          status: "DOWN",
          checks: { database: "DOWN" },
          circuitBreaker: { state: "unknown" },
        });
        expect(live.status).toBe(200);
      } finally {
        await broken.close();
        await deadPool.end();
        // Nest 로거는 프로세스 전역이다. 두 번째 앱이 덮어쓴 로거를 첫 앱 것으로 되돌린다.
        app.app.useLogger(app.logs.logger);
      }
    });
  });

  describe("오류·로그에 요청 값이 남지 않는다(RQ-027)", () => {
    it("canary를 제목·본문·수신자·Key·필드 이름에 넣은 요청의 응답과 로그에서 canary가 검색되지 않는다", async () => {
      app.logs.lines.length = 0;
      const responses: string[] = [];
      const collect = async (res: Response) =>
        void responses.push(await res.text());

      // 400: 검증 실패(수신자 주소, 제목 CR·LF, 알 수 없는 필드 이름, 본문에 canary)
      await collect(
        await postJob(app, {
          key: `bad key ${CANARY.key}`,
          body: {
            to: [`${CANARY.recipient}-not-an-address`],
            subject: `${CANARY.subject}\r\n`,
            text: CANARY.text,
            html: CANARY.html,
            [CANARY.field]: CANARY.text,
          },
        }),
      );
      // 400: JSON 구문 오류, 본문 조각이 오류에 들어가지 않아야 한다
      await collect(
        await postJob(app, {
          key: "syntax",
          body: `{"subject": "${CANARY.subject}", `,
        }),
      );
      // 409: 지문 불일치
      await collect(
        await postJob(app, {
          key: "canary-409",
          body: plainMail({ subject: CANARY.subject }),
        }),
      );
      await collect(
        await postJob(app, {
          key: "canary-409",
          body: plainMail({ subject: CANARY.subject, text: CANARY.text }),
        }),
      );
      // 401: 틀린 키(canary 키)
      await collect(await postJob(app, { auth: CANARY.key }));
      // 404, 조회 Key
      await collect(await getJson(app, `/jobs?idempotencyKey=${CANARY.key}`));
      // 413
      await collect(
        await postJob(app, {
          key: "canary-413",
          body: JSON.stringify({ text: CANARY.text.repeat(200_000) }),
        }),
      );
      // 이벤트 cursor 오류
      await collect(await getJson(app, `/events?after=${CANARY.key}`));
      // 415
      await collect(
        await postJob(app, {
          key: "canary-415",
          headers: { "Content-Type": "text/plain" },
          body: CANARY.text,
        }),
      );

      const haystack = [...responses, ...app.logs.lines].join("\n");
      for (const [name, canary] of Object.entries(CANARY)) {
        expect([name, haystack.includes(canary)]).toEqual([name, false]);
      }
      // 요청 로그는 남는다. 요청 ID로 응답의 instance와 대조할 수 있다.
      const instances = responses
        .map((r) => (JSON.parse(r) as { instance?: string }).instance)
        .filter((v): v is string => v !== undefined);
      expect(instances.length).toBeGreaterThan(5);
      // 응답 완료 뒤 'finish' 이벤트에서 로그를 쓰므로 한 틱 기다린다.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const missing = instances.filter(
        (instance) =>
          !app.logs.lines.some((l) =>
            l.includes(`requestId=${instance.replace("urn:uuid:", "")}`),
          ),
      );
      expect(missing).toEqual([]);
    });

    it("기동 설정의 SMTP 비밀번호 canary가 로그와 설정 직렬화에 나오지 않는다", async () => {
      expect(JSON.stringify(app.config)).not.toContain(CANARY.smtpPassword);
      expect(String(app.config.smtp.auth?.password)).not.toContain(
        CANARY.smtpPassword,
      );
      expect(app.logs.lines.join("\n")).not.toContain(CANARY.smtpPassword);
    });
  });
});
