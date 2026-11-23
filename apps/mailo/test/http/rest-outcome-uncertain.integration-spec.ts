/**
 * `outcomeUncertain` 표시(RQ-048, ADR-0011 결정 5)를 실제 PostgreSQL과 앱으로 검증한다.
 * 고정하는 것: `GET /jobs/*`와 `GET /ops/jobs/{jobId}`의 `outcomeUncertain`(모든 상태에서 불리언, 항상 존재),
 * `JOB_FAILED`·`JOB_EXPIRED` 이벤트의 같은 값과 `JOB_SENT`·`JOB_CANCELED`의 생략, 호출처 격리,
 * 시도 응답 텍스트·수신자·Key의 비노출(RQ-027). 운영자 재시도 API가 없다는 점(ADR-0011 결정 5)도 확인한다.
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
import { recordJobEvent } from "../../src/events/index.js";
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

// 테스트용 가짜 토큰이다. 실제 시크릿이 아니다.
const READ = "ops-read-fake-token-000000000000000000000001";
const ONCALL = "ops-admin-oncall-fake-token-000000000000001";

/** 응답 텍스트에 심는 canary. 어떤 응답에도 나오면 안 된다. */
const RESPONSE_CANARY = "CANARY-SMTP-RESPONSE-TEXT-3b7e";

interface Seed {
  key: string;
  status: "FAILED" | "EXPIRED" | "SENT" | "PENDING" | "RETRY_WAIT";
  attempts: Array<{
    classification: string;
    stage?: string;
    responseCode?: number;
  }>;
  event?: "JOB_FAILED" | "JOB_EXPIRED" | "JOB_SENT";
  auth?: string;
}

describe("REST 통합: outcomeUncertain 표시(RQ-048, ADR-0011 결정 5)", () => {
  let db: TestDatabase;
  let app: RestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    app = await startRestApp({
      pool: db.pool,
      env: {
        MAILO_OPS_TOKEN: READ,
        MAILO_OPS_ADMIN_NAMES: "oncall",
        MAILO_OPS_ADMIN_TOKEN_ONCALL: ONCALL,
      },
    });
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

  /** REST로 등록한 뒤 DB에서 상태·시도·이벤트를 만든다. 종결 전이를 직접 흉내 내는 시드다. */
  async function seed(input: Seed): Promise<string> {
    const res = await postJob(app, {
      key: input.key,
      body: plainMail({ to: [`${CANARY.recipient}@example.com`] }),
      auth: input.auth ?? ALPHA_KEY,
    });
    expect(res.status).toBe(202);
    const jobId = ((await res.json()) as Json)["jobId"] as string;
    for (const a of input.attempts) {
      await db.pool.query(
        `INSERT INTO mail_attempts
           (job_id, classification, counted, stage, response_code, response_text, started_at)
         VALUES ($1, $2, true, $3, $4, $5, now())`,
        [
          jobId,
          a.classification,
          a.stage ?? null,
          a.responseCode ?? null,
          `${RESPONSE_CANARY} ${CANARY.recipient}@example.com`,
        ],
      );
    }
    if (input.status === "RETRY_WAIT") {
      await db.pool.query(
        "UPDATE mail_jobs SET status = 'RETRY_WAIT' WHERE id = $1",
        [jobId],
      );
    } else if (input.status !== "PENDING") {
      await db.pool.query(
        `UPDATE mail_jobs SET status = $2, finished_at = now(), failure_reason = $3 WHERE id = $1`,
        [
          jobId,
          input.status,
          input.status === "FAILED"
            ? "ATTEMPTS_EXHAUSTED"
            : input.status === "EXPIRED"
              ? "EXPIRED"
              : null,
        ],
      );
    }
    if (input.event) {
      await recordJobEvent(db.pool, {
        type: input.event,
        callerId: input.auth === BETA_KEY ? "beta" : "alpha",
        jobId,
        idempotencyKey: input.key,
        failureReason:
          input.event === "JOB_SENT"
            ? null
            : input.event === "JOB_FAILED"
              ? "ATTEMPTS_EXHAUSTED"
              : "EXPIRED",
        attemptCount: input.attempts.length,
        recipients: { to: [`${CANARY.recipient}@example.com`] },
      });
    }
    return jobId;
  }

  async function getJob(jobId: string, auth = ALPHA_KEY): Promise<Json> {
    const res = await getJson(app, `/jobs/${jobId}`, auth);
    expect(res.status).toBe(200);
    return (await res.json()) as Json;
  }

  async function feed(auth = ALPHA_KEY): Promise<Json[]> {
    const res = await getJson(app, "/events", auth);
    expect(res.status).toBe(200);
    return ((await res.json()) as Json)["events"] as Json[];
  }

  function opsGet(path: string, token: string): Promise<Response> {
    return fetch(`${app.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("DATA 이후 연결이 끊긴 실패는 Job과 JOB_FAILED 이벤트가 모두 true다", async () => {
    const jobId = await seed({
      key: "uncertain-failed",
      status: "FAILED",
      attempts: [{ classification: "TRANSIENT", stage: "DATA" }],
      event: "JOB_FAILED",
    });

    const job = await getJob(jobId);
    const events = await feed();

    expect(job["status"]).toBe("FAILED");
    expect(job["outcomeUncertain"]).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "JOB_FAILED",
      jobId,
      outcomeUncertain: true,
    });
  });

  it("수신 거부처럼 SMTP 응답이 명확한 영구 실패는 false이고 필드는 항상 있다", async () => {
    const jobId = await seed({
      key: "certain-failed",
      status: "FAILED",
      attempts: [
        { classification: "PERMANENT", stage: "RCPT", responseCode: 550 },
      ],
      event: "JOB_FAILED",
    });

    const job = await getJob(jobId);
    const events = await feed();

    expect(job["outcomeUncertain"]).toBe(false);
    expect(events[0]?.["outcomeUncertain"]).toBe(false);
  });

  it("lease 만료를 겪고 만료된 작업은 JOB_EXPIRED 이벤트가 true다", async () => {
    const jobId = await seed({
      key: "uncertain-expired",
      status: "EXPIRED",
      attempts: [{ classification: "LEASE_EXPIRED" }],
      event: "JOB_EXPIRED",
    });

    expect((await getJob(jobId))["outcomeUncertain"]).toBe(true);
    const events = await feed();
    expect(events[0]).toMatchObject({
      type: "JOB_EXPIRED",
      outcomeUncertain: true,
    });
  });

  it("한 번도 시도하지 못하고 만료된 작업은 false다", async () => {
    const jobId = await seed({
      key: "never-tried-expired",
      status: "EXPIRED",
      attempts: [],
      event: "JOB_EXPIRED",
    });

    expect((await getJob(jobId))["outcomeUncertain"]).toBe(false);
    expect((await feed())[0]?.["outcomeUncertain"]).toBe(false);
  });

  it("SENT 작업은 Job에만 값이 있고 이벤트에는 필드가 없다(이전 시도가 불확실이면 true)", async () => {
    const jobId = await seed({
      key: "sent-after-uncertain",
      status: "SENT",
      attempts: [
        { classification: "TRANSIENT", stage: "DATA" },
        { classification: "SENT", stage: "DATA", responseCode: 250 },
      ],
      event: "JOB_SENT",
    });

    expect((await getJob(jobId))["outcomeUncertain"]).toBe(true);
    const events = await feed();
    expect(events[0]?.["type"]).toBe("JOB_SENT");
    expect(events[0]).not.toHaveProperty("outcomeUncertain");
  });

  it("비종결 작업도 Job.outcomeUncertain을 가진다(RETRY_WAIT true, PENDING false)", async () => {
    const waiting = await seed({
      key: "retry-wait-uncertain",
      status: "RETRY_WAIT",
      attempts: [{ classification: "TRANSIENT", stage: "DATA" }],
    });
    const pending = await seed({
      key: "pending-fresh",
      status: "PENDING",
      attempts: [],
    });

    expect((await getJob(waiting))["outcomeUncertain"]).toBe(true);
    expect((await getJob(pending))["outcomeUncertain"]).toBe(false);
  });

  it("취소된 작업은 Job은 false이고 JOB_CANCELED 이벤트에는 필드가 없다", async () => {
    const res = await postJob(app, { key: "to-cancel", body: plainMail() });
    const jobId = ((await res.json()) as Json)["jobId"] as string;
    const canceled = await fetch(`${app.baseUrl}/jobs/${jobId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ALPHA_KEY}` },
    });
    expect(canceled.status).toBe(200);
    expect((await canceled.json()) as Json).toMatchObject({
      status: "CANCELED",
      outcomeUncertain: false,
    });

    const events = await feed();
    expect(events).toHaveLength(1);
    expect(events[0]?.["type"]).toBe("JOB_CANCELED");
    expect(events[0]).not.toHaveProperty("outcomeUncertain");
  });

  it("등록 응답(202)·Key 조회·재전송(200)도 같은 필드를 가진다", async () => {
    const created = await postJob(app, { key: "register-shape" });
    expect(created.status).toBe(202);
    expect(((await created.json()) as Json)["outcomeUncertain"]).toBe(false);

    const byKey = await getJson(app, "/jobs?idempotencyKey=register-shape");
    expect(((await byKey.json()) as Json)["outcomeUncertain"]).toBe(false);

    const replay = await postJob(app, { key: "register-shape" });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as Json)["outcomeUncertain"]).toBe(false);
  });

  it("같은 페이지의 여러 이벤트가 작업별로 맞는 값을 받는다", async () => {
    const a = await seed({
      key: "page-a",
      status: "FAILED",
      attempts: [{ classification: "TRANSIENT", stage: "DATA" }],
      event: "JOB_FAILED",
    });
    const b = await seed({
      key: "page-b",
      status: "FAILED",
      attempts: [
        { classification: "PERMANENT", stage: "DATA", responseCode: 554 },
      ],
      event: "JOB_FAILED",
    });
    const c = await seed({
      key: "page-c",
      status: "EXPIRED",
      attempts: [{ classification: "LEASE_EXPIRED" }],
      event: "JOB_EXPIRED",
    });

    const byJob = new Map(
      (await feed()).map((e) => [e["jobId"] as string, e["outcomeUncertain"]]),
    );

    expect(byJob.get(a)).toBe(true);
    expect(byJob.get(b)).toBe(false);
    expect(byJob.get(c)).toBe(true);
  });

  it("호출처 격리: 다른 호출처는 작업을 조회하지 못하고 이벤트에도 나오지 않는다", async () => {
    const jobId = await seed({
      key: "isolated",
      status: "FAILED",
      attempts: [{ classification: "TRANSIENT", stage: "DATA" }],
      event: "JOB_FAILED",
    });

    const other = await getJson(app, `/jobs/${jobId}`, BETA_KEY);

    expect(other.status).toBe(404);
    expect(await feed(BETA_KEY)).toEqual([]);
  });

  it("운영자 읽기 GET /ops/jobs/{jobId}가 같은 값을 주고 Key·수신자·응답 텍스트는 없다", async () => {
    const jobId = await seed({
      key: "ops-view",
      status: "FAILED",
      attempts: [{ classification: "TRANSIENT", stage: "DATA" }],
      event: "JOB_FAILED",
    });

    for (const token of [READ, ONCALL]) {
      const res = await opsGet(`/ops/jobs/${jobId}`, token);
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as Json;
      expect(body).toMatchObject({
        jobId,
        callerId: "alpha",
        status: "FAILED",
        outcomeUncertain: true,
      });
      expect(body).not.toHaveProperty("idempotencyKey");
      expect(text).not.toContain(RESPONSE_CANARY);
      expect(text).not.toContain(CANARY.recipient);
    }
  });

  it("어떤 응답과 로그에도 SMTP 응답 텍스트·수신자 canary가 없다(RQ-027)", async () => {
    const jobId = await seed({
      key: "canary-check",
      status: "FAILED",
      attempts: [{ classification: "TRANSIENT", stage: "DATA" }],
      event: "JOB_FAILED",
    });

    const bodies = [
      await (await getJson(app, `/jobs/${jobId}`)).text(),
      await (await getJson(app, "/jobs?idempotencyKey=canary-check")).text(),
      await (await opsGet(`/ops/jobs/${jobId}`, READ)).text(),
    ];
    const feedText = await (await getJson(app, "/events")).text();

    for (const text of bodies) {
      expect(text).not.toContain(RESPONSE_CANARY);
      expect(text).not.toContain(CANARY.recipient);
    }
    // 이벤트의 recipients는 기존 계약이라 수신자가 있다. 응답 텍스트만 없어야 한다.
    expect(feedText).not.toContain(RESPONSE_CANARY);
    expect(app.logs.lines.join("\n")).not.toContain(RESPONSE_CANARY);
  });

  it("운영자 재시도 API는 없다(ADR-0011 결정 5): /ops의 재시도 경로는 404다", async () => {
    const jobId = await seed({
      key: "no-retry",
      status: "FAILED",
      attempts: [{ classification: "TRANSIENT", stage: "DATA" }],
      event: "JOB_FAILED",
    });

    for (const path of [
      `/ops/jobs/${jobId}/retry`,
      `/ops/jobs/${jobId}/resend`,
    ]) {
      const res = await fetch(`${app.baseUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ONCALL}` },
      });
      expect(res.status).toBe(404);
    }
    expect((await getJob(jobId))["status"]).toBe("FAILED");
  });
});
