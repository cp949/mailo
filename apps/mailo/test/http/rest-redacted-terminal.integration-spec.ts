/**
 * 종결 때 본문·수신자·봉투를 비운 행(RQ-071, ADR-0015 결정 2)을 REST 계층이 그대로 읽는지 실제 PostgreSQL과 앱으로 검증한다.
 * 고정하는 것: REST로 등록한 작업을 실제 종결 전이(`completeAttempt`, `cancelJob`)로 끝낸 뒤
 * `GET /jobs/{jobId}`, `GET /jobs?idempotencyKey=`, `GET /events`, `GET /ops/jobs/{jobId}`가 오류 없이 응답하고,
 * 같은 Key의 재전송이 중복 응답(200)이며, 이벤트에는 비우기 전 수신자가 있고 응답 어디에도 본문·제목이 없다.
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
import { claim, completeAttempt } from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { completeDeps, migrate } from "../support/queue-fixtures.js";
import {
  ALPHA_KEY,
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
const RECIPIENT = `${CANARY.recipient}@example.com`;

describe("REST 통합: 종결 때 비운 행의 읽기(RQ-071, ADR-0015 결정 2)", () => {
  let db: TestDatabase;
  let app: RestApp;
  const deps = completeDeps();

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    app = await startRestApp({
      pool: db.pool,
      env: { MAILO_OPS_TOKEN: READ },
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

  const body = () =>
    plainMail({
      to: [RECIPIENT],
      subject: CANARY.subject,
      text: CANARY.text,
      html: `<p>${CANARY.html}</p>`,
    });

  async function register(key: string): Promise<string> {
    const res = await postJob(app, { key, body: body() });
    expect(res.status).toBe(202);
    return ((await res.json()) as Json)["jobId"] as string;
  }

  it("SENT로 끝난 작업의 조회·이벤트·운영자 읽기가 오류 없이 응답하고 본문·제목을 내지 않는다", async () => {
    const jobId = await register("redacted-sent");
    const [job] = await claim(db.pool, { leaseSeconds: 120, limit: 1, deps });
    expect(job?.id).toBe(jobId);
    await completeAttempt(
      db.pool,
      { id: jobId, leaseToken: job!.leaseToken },
      { classification: "SENT" },
      deps,
    );

    const raw = await db.pool.query(
      "SELECT body_ciphertext, recipients, envelope FROM mail_jobs WHERE id = $1",
      [jobId],
    );
    expect(raw.rows[0].body_ciphertext).toBeNull();
    expect(raw.rows[0].recipients).toEqual({});
    expect(raw.rows[0].envelope).toEqual({});

    const texts: string[] = [];
    const byId = await getJson(app, `/jobs/${jobId}`);
    expect(byId.status).toBe(200);
    const byIdText = await byId.text();
    texts.push(byIdText);
    expect(JSON.parse(byIdText)).toMatchObject({ jobId, status: "SENT" });

    const byKey = await getJson(app, "/jobs?idempotencyKey=redacted-sent");
    expect(byKey.status).toBe(200);
    texts.push(await byKey.text());

    const feed = await getJson(app, "/events");
    expect(feed.status).toBe(200);
    const feedText = await feed.text();
    texts.push(feedText);
    const events = (JSON.parse(feedText) as Json)["events"] as Json[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "JOB_SENT", jobId });
    // 이벤트의 수신자는 비우기 전 값이다(비움은 RQ-072의 몫).
    expect(events[0]!["recipients"]["to"]).toEqual([RECIPIENT]);

    const ops = await getJson(app, `/ops/jobs/${jobId}`, READ);
    expect(ops.status).toBe(200);
    texts.push(await ops.text());

    for (const text of texts) {
      expect(text).not.toContain(CANARY.subject);
      expect(text).not.toContain(CANARY.text);
      expect(text).not.toContain(CANARY.html);
    }
  });

  it("같은 Key를 다시 보내면 비운 행도 중복 응답(200)이고 다른 내용이면 409다(RQ-034)", async () => {
    const jobId = await register("redacted-dup");
    const [job] = await claim(db.pool, { leaseSeconds: 120, limit: 1, deps });
    await completeAttempt(
      db.pool,
      { id: jobId, leaseToken: job!.leaseToken },
      { classification: "SENT" },
      deps,
    );

    const same = await postJob(app, { key: "redacted-dup", body: body() });
    expect(same.status).toBe(200);
    expect(((await same.json()) as Json)["jobId"]).toBe(jobId);

    const other = await postJob(app, {
      key: "redacted-dup",
      body: plainMail({ to: [RECIPIENT], subject: "다른 제목" }),
    });
    expect(other.status).toBe(409);
  });

  it("호출처가 취소한 작업의 조회와 이벤트가 오류 없이 응답한다", async () => {
    const jobId = await register("redacted-cancel");

    const canceled = await fetch(`${app.baseUrl}/jobs/${jobId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ALPHA_KEY}` },
    });
    expect(canceled.status).toBe(200);

    const raw = await db.pool.query(
      "SELECT recipients, envelope FROM mail_jobs WHERE id = $1",
      [jobId],
    );
    expect(raw.rows[0].recipients).toEqual({});
    expect(raw.rows[0].envelope).toEqual({});
    const byId = await getJson(app, `/jobs/${jobId}`);
    expect(byId.status).toBe(200);
    expect(await byId.json()).toMatchObject({ status: "CANCELED" });
    const feed = await getJson(app, "/events");
    const events = ((await feed.json()) as Json)["events"] as Json[];
    expect(events[0]).toMatchObject({ type: "JOB_CANCELED" });
    expect(events[0]!["recipients"]["to"]).toEqual([RECIPIENT]);
  });
});
