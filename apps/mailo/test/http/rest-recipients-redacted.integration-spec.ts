/**
 * 유예 뒤 수신자를 비운 이벤트(RQ-072, ADR-0015 결정 3)를 REST 계층이 읽는 방식을 실제 PostgreSQL과 앱으로 검증한다.
 * 고정하는 것:
 * - 비운 `JOB_*` 이벤트는 같은 `eventId`·순서·`nextCursor`로 나오고 `recipientsRedacted: true`와 빈 수신자 목록을 낸다.
 * - 비우기 전 이벤트는 `recipientsRedacted: false`와 수신자를 낸다.
 * - 비우기 전에 받은 cursor로 이어 읽어도 이벤트가 빠지거나 겹치지 않고 `Mailo-Cursor-Gap` 헤더가 없다.
 * - `GET /jobs`의 `rejectedRecipients`는 비운 뒤 빈 목록이고 `Job`에 새 필드가 없다.
 * - 비운 뒤 응답·앱 로그 어디에도 수신자 주소가 없다(RQ-027).
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
import {
  claim,
  completeAttempt,
  redactEventRecipients,
} from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { completeDeps, migrate } from "../support/queue-fixtures.js";
import {
  CANARY,
  getJson,
  plainMail,
  postJob,
  startRestApp,
  type RestApp,
} from "../support/rest-app.js";

type Json = Record<string, any>;

const GRACE = 604_800;
const RECIPIENT = `${CANARY.recipient}@example.com`;
const REJECTED = `${CANARY.recipient}-rejected@example.com`;

describe("REST 통합: 수신자를 비운 이벤트의 읽기(RQ-072, ADR-0015 결정 3)", () => {
  let db: TestDatabase;
  let app: RestApp;
  const deps = completeDeps();

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
    await db.pool.query("DELETE FROM mail_event_purges");
    app.logs.lines.length = 0;
  });

  /** REST로 등록하고 실제 전이로 SENT까지 보낸다. 거부 수신자 한 명을 기록한다. */
  async function sendOne(key: string): Promise<string> {
    const res = await postJob(app, {
      key,
      body: plainMail({ to: [RECIPIENT], subject: CANARY.subject }),
    });
    expect(res.status).toBe(202);
    const jobId = ((await res.json()) as Json)["jobId"] as string;
    const [job] = await claim(db.pool, { leaseSeconds: 120, limit: 1, deps });
    expect(job?.id).toBe(jobId);
    await completeAttempt(
      db.pool,
      { id: jobId, leaseToken: job!.leaseToken },
      {
        classification: "SENT",
        rejectedRecipients: [{ address: REJECTED, smtpCode: 452 }],
      },
      deps,
    );
    return jobId;
  }

  const ageEvent = (jobId: string, seconds: number) =>
    db.pool.query(
      "UPDATE mail_events SET created_at = now() - make_interval(secs => $2) WHERE job_id = $1",
      [jobId, seconds],
    );

  it("비운 이벤트는 같은 eventId·순서·nextCursor로 recipientsRedacted: true와 빈 수신자를 낸다", async () => {
    const old = await sendOne("redact-old");
    const fresh = await sendOne("redact-fresh");
    const beforeRes = await getJson(app, "/events");
    const before = (await beforeRes.json()) as Json;
    expect(before["events"].map((e: Json) => e["recipientsRedacted"])).toEqual([
      false,
      false,
    ]);
    expect(before["events"][0]["recipients"]["to"]).toEqual([RECIPIENT]);
    await ageEvent(old, GRACE + 10);

    expect(await redactEventRecipients(db.pool, GRACE)).toBe(1);

    const afterRes = await getJson(app, "/events");
    expect(afterRes.status).toBe(200);
    expect(afterRes.headers.get("mailo-cursor-gap")).toBeNull();
    const after = (await afterRes.json()) as Json;
    expect(after["events"].map((e: Json) => e["eventId"])).toEqual(
      before["events"].map((e: Json) => e["eventId"]),
    );
    expect(after["nextCursor"]).toBe(before["nextCursor"]);
    const [redacted, kept] = after["events"] as Json[];
    expect(redacted).toMatchObject({
      type: "JOB_SENT",
      jobId: old,
      recipientsRedacted: true,
      recipients: { to: [], cc: [], bcc: [] },
      rejectedRecipients: [],
    });
    expect(kept).toMatchObject({
      jobId: fresh,
      recipientsRedacted: false,
      recipients: { to: [RECIPIENT] },
    });
    expect(kept!["rejectedRecipients"]).toEqual([
      { address: REJECTED, smtpCode: 452, enhancedCode: null },
    ]);
  });

  it("비우기 전에 받은 cursor로 이어 읽어도 이벤트가 빠지거나 겹치지 않고 공백 헤더가 없다", async () => {
    const first = await sendOne("cursor-1");
    const second = await sendOne("cursor-2");
    const page = (await (await getJson(app, "/events?limit=1")).json()) as Json;
    expect(page["events"]).toHaveLength(1);
    await ageEvent(first, GRACE + 10);
    await ageEvent(second, GRACE + 10);
    await redactEventRecipients(db.pool, GRACE);

    const res = await getJson(app, `/events?after=${page["nextCursor"]}`);

    expect(res.headers.get("mailo-cursor-gap")).toBeNull();
    const rest = (await res.json()) as Json;
    expect(rest["events"]).toHaveLength(1);
    expect(rest["events"][0]).toMatchObject({
      jobId: second,
      recipientsRedacted: true,
    });
  });

  it("GET /jobs의 rejectedRecipients는 비운 뒤 빈 목록이고 Job에 새 필드가 없다", async () => {
    const id = await sendOne("job-view");
    const beforeJob = (await (
      await getJson(app, `/jobs/${id}`)
    ).json()) as Json;
    expect(beforeJob["rejectedRecipients"]).toHaveLength(1);
    await ageEvent(id, GRACE + 10);

    await redactEventRecipients(db.pool, GRACE);

    const afterJob = (await (await getJson(app, `/jobs/${id}`)).json()) as Json;
    expect(afterJob["rejectedRecipients"]).toEqual([]);
    expect(Object.keys(afterJob).sort()).toEqual(Object.keys(beforeJob).sort());
    expect(afterJob).not.toHaveProperty("recipientsRedacted");
  });

  it("비운 뒤 응답과 앱 로그 어디에도 수신자·거부 수신자 주소가 없다(RQ-027)", async () => {
    const id = await sendOne("canary");
    await ageEvent(id, GRACE + 10);
    app.logs.lines.length = 0;

    await redactEventRecipients(db.pool, GRACE);

    const texts = [
      await (await getJson(app, "/events")).text(),
      await (await getJson(app, `/jobs/${id}`)).text(),
      await (await getJson(app, "/jobs?idempotencyKey=canary")).text(),
      app.logs.lines.join("\n"),
    ];
    for (const text of texts) {
      expect(text).not.toContain(RECIPIENT);
      expect(text).not.toContain(REJECTED);
    }
  });
});
