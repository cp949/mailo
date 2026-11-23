/**
 * 호출처별 수신 도메인 허용 목록 `allowedRecipientDomains`(RQ-046, ADR-0011 결정 8)를 REST로 검증한다.
 * 고정하는 것: 정확 일치·대소문자 무시·하위 도메인 거부·빈 목록 없음=제한 없음, 어긴 수신자 위치 목록(`RECIPIENT_DOMAIN_NOT_ALLOWED`),
 * 요청 전체 거부(부분 등록 없음), 이미 등록된 Key의 재전송은 기존 작업, `replyTo`는 제한 없음, 응답·로그·DB에 주소 비노출(RQ-027).
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
  plainMail,
  postJob,
  startRestApp,
  type RestApp,
} from "../support/rest-app.js";

type Json = Record<string, any>;

// alpha만 수신 도메인을 제한한다. beta는 제한이 없다.
const ALLOWED = ["example.com", "xn--9n2bp8q.kr"];

describe("REST 통합: 수신 도메인 허용 목록 (RQ-046, ADR-0011 결정 8)", () => {
  let db: TestDatabase;
  let app: RestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    app = await startRestApp({
      pool: db.pool,
      callerFields: { alpha: { allowedRecipientDomains: ALLOWED } },
    });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    app.app.useLogger(app.logs.logger);
    await db.pool.query("DELETE FROM mail_jobs");
    app.logs.lines.length = 0;
  });

  async function jobCount(): Promise<number> {
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM mail_jobs",
    );
    return rows[0].n;
  }

  it("허용 도메인의 수신자는 대소문자와 무관하게 등록된다", async () => {
    const res = await postJob(app, {
      key: "domain-ok",
      body: plainMail({
        to: ["Kim@EXAMPLE.com"],
        cc: ["lee@xn--9n2bp8q.kr"],
      }),
    });
    expect(res.status).toBe(202);
  });

  it("허용 목록 밖의 도메인은 하위 도메인이어도 400이고 어긴 주소의 위치와 코드만 돌려준다", async () => {
    const res = await postJob(app, {
      key: "domain-denied",
      body: plainMail({
        to: ["ok@example.com", `${CANARY.recipient}@sub.example.com`],
        cc: [`${CANARY.recipient}@other.test`],
        bcc: ["ok@example.com", `${CANARY.recipient}@example.org`],
      }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    const problem = (await res.json()) as Json;
    expect(problem["type"]).toBe("urn:mailo:problem:validation-failed");
    expect(problem["errors"]).toEqual([
      { pointer: "/to/1", code: "RECIPIENT_DOMAIN_NOT_ALLOWED" },
      { pointer: "/cc/0", code: "RECIPIENT_DOMAIN_NOT_ALLOWED" },
      { pointer: "/bcc/1", code: "RECIPIENT_DOMAIN_NOT_ALLOWED" },
    ]);
  });

  it("수신자 하나만 어겨도 요청 전체를 거부하고 작업이 생기지 않는다(부분 등록 없음)", async () => {
    const res = await postJob(app, {
      key: "domain-partial",
      body: plainMail({ to: ["ok@example.com", "bad@other.test"] }),
    });

    expect(res.status).toBe(400);
    expect(await jobCount()).toBe(0);
  });

  it("제한이 없는 호출처는 어떤 도메인으로도 보낼 수 있다", async () => {
    const res = await postJob(app, {
      key: "beta-any",
      auth: BETA_KEY,
      body: plainMail({ to: ["anyone@other.test"] }),
    });
    expect(res.status).toBe(202);
  });

  it("replyTo는 수신자가 아니라 제한하지 않는다", async () => {
    const res = await postJob(app, {
      key: "domain-reply-to",
      body: plainMail({ replyTo: "boss@other.test" }),
    });
    expect(res.status).toBe(202);
  });

  it("발신 주소 위반과 수신 도메인 위반이 함께 있으면 항목을 모두 알린다", async () => {
    const res = await postJob(app, {
      key: "domain-both",
      body: plainMail({ from: "ceo@example.com", to: ["a@other.test"] }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as Json)["errors"]).toEqual([
      { pointer: "/from", code: "FROM_NOT_ALLOWED" },
      { pointer: "/to/0", code: "RECIPIENT_DOMAIN_NOT_ALLOWED" },
    ]);
  });

  it("이미 등록된 Key의 같은 내용 재전송은 정책이 바뀐 뒤에도 기존 작업(200)이고 다른 내용은 409다", async () => {
    // 제한이 없던 시절에 등록된 작업을 흉내 낸다: 제한 없는 앱으로 먼저 등록한 뒤 제한 있는 앱으로 재전송한다.
    const violating = plainMail({ to: ["a@other.test"] });
    const loose = await startRestApp({ pool: db.pool });
    try {
      expect(
        (await postJob(loose, { key: "replay-1", body: violating })).status,
      ).toBe(202);
    } finally {
      await loose.close();
    }
    app.app.useLogger(app.logs.logger);

    const same = await postJob(app, { key: "replay-1", body: violating });
    const changed = await postJob(app, {
      key: "replay-1",
      body: plainMail({ to: ["b@other.test"] }),
    });
    const fresh = await postJob(app, { key: "replay-2", body: violating });

    expect(same.status).toBe(200);
    // 같은 Key에 다른 내용은 정책보다 멱등 충돌(409)이 먼저다.
    expect(changed.status).toBe(409);
    expect(fresh.status).toBe(400);
    expect(await jobCount()).toBe(1);
  });

  it("응답·로그·DB에 어긴 주소와 도메인이 남지 않는다(RQ-027)", async () => {
    const res = await postJob(app, {
      key: "domain-canary",
      body: plainMail({
        to: [`${CANARY.recipient}@canary-domain-c0de.test`],
        subject: CANARY.subject,
        text: CANARY.text,
      }),
    });
    const text = await res.text();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(res.status).toBe(400);
    const haystack = [text, ...app.logs.lines].join("\n");
    for (const secret of [
      CANARY.recipient,
      "canary-domain-c0de",
      CANARY.subject,
      CANARY.text,
    ])
      expect(haystack).not.toContain(secret);
    expect(await jobCount()).toBe(0);
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM mail_events",
    );
    expect(rows[0].n).toBe(0);
  });

  it("호출처 키가 없거나 틀리면 정책 판정 전에 401이다", async () => {
    const res = await postJob(app, { key: "domain-401", auth: "wrong" });
    expect(res.status).toBe(401);
    expect(ALPHA_KEY).not.toBe("wrong");
  });
});
