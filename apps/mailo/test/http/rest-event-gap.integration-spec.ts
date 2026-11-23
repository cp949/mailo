/**
 * `GET /events`의 공백 신호(RQ-045, ADR-0011 결정 9)를 실제 PostgreSQL과 앱으로 검증한다.
 * 고정하는 것: 기본 200 + `Mailo-Cursor-Gap: true`, `onGap=error`의 410(`cursor-expired`), `after`가 없으면 판정하지 않음,
 * `type` 필터별 판정, 호출처 격리, 삭제가 없는 호출처의 응답 무변화, `event_cursor_gap` 로그와 시크릿 비노출(RQ-027).
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
  encodeCursor,
  recordJobEvent,
  type JobEventType,
} from "../../src/events/index.js";
import { deleteExpiredRecords } from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { createJob, migrate } from "../support/queue-fixtures.js";
import {
  ALPHA_KEY,
  BETA_KEY,
  CANARY,
  getJson,
  startRestApp,
  type RestApp,
} from "../support/rest-app.js";

type Json = Record<string, any>;

const RETENTION = 30 * 86_400;
const STATUS: Record<JobEventType, string> = {
  JOB_SENT: "SENT",
  JOB_FAILED: "FAILED",
  JOB_EXPIRED: "EXPIRED",
  JOB_CANCELED: "CANCELED",
};

describe("REST 통합: 이벤트 피드 공백 신호 (RQ-045, ADR-0011 결정 9)", () => {
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
    app.app.useLogger(app.logs.logger);
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query("DELETE FROM mail_event_purges");
    app.logs.lines.length = 0;
  });

  /** 종결 작업과 이벤트를 만든다. `ageDays`가 30을 넘으면 보존 삭제 대상이다. 이벤트의 cursor를 돌려준다. */
  async function place(
    callerId: string,
    type: JobEventType,
    ageDays: number,
  ): Promise<string> {
    const jobId = await createJob(db.pool, { callerId });
    await db.pool.query(
      `UPDATE mail_jobs SET status = $2, finished_at = now() - make_interval(days => $3)
        WHERE id = $1`,
      [jobId, STATUS[type], ageDays],
    );
    await recordJobEvent(db.pool, {
      type,
      callerId,
      jobId,
      idempotencyKey: `k-${jobId}`,
      attemptCount: 1,
      recipients: { to: [`${CANARY.recipient}@example.com`] },
    });
    const { rows } = await db.pool.query<{ id: string; txid: string }>(
      "SELECT id::text AS id, txid::text AS txid FROM mail_events WHERE job_id = $1",
      [jobId],
    );
    return encodeCursor({ txid: rows[0]!.txid, id: rows[0]!.id });
  }

  const purge = () => deleteExpiredRecords(db.pool, RETENTION);
  const GAP = "mailo-cursor-gap";

  function gapLogs(): Json[] {
    return app.logs.lines
      .flatMap((l) => l.split("\n"))
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Json)
      .filter((l) => l["event"] === "event_cursor_gap");
  }

  it("cursor 뒤에서 이벤트가 삭제됐으면 200과 Mailo-Cursor-Gap: true를 주고 본문 형식은 그대로다", async () => {
    const cursor = await place("alpha", "JOB_SENT", 29);
    await place("alpha", "JOB_SENT", 40);
    await purge();

    const res = await getJson(app, `/events?after=${cursor}`);

    expect(res.status).toBe(200);
    expect(res.headers.get(GAP)).toBe("true");
    const body = (await res.json()) as Json;
    expect(Object.keys(body).sort()).toEqual([
      "events",
      "hasMore",
      "nextCursor",
    ]);
  });

  it("cursor가 표지와 같거나 뒤이면 헤더가 없다", async () => {
    await place("alpha", "JOB_SENT", 29);
    const purged = await place("alpha", "JOB_SENT", 40);
    const after = await place("alpha", "JOB_SENT", 29);
    await purge();

    expect(
      (await getJson(app, `/events?after=${purged}`)).headers.get(GAP),
    ).toBe(null);
    expect(
      (await getJson(app, `/events?after=${after}`)).headers.get(GAP),
    ).toBe(null);
  });

  it("after가 없으면 판정하지 않는다(헤더·410 없음)", async () => {
    await place("alpha", "JOB_SENT", 40);
    await purge();

    const plain = await getJson(app, "/events");
    const strict = await getJson(app, "/events?onGap=error");

    expect(plain.status).toBe(200);
    expect(plain.headers.get(GAP)).toBe(null);
    expect(strict.status).toBe(200);
    expect(strict.headers.get(GAP)).toBe(null);
    expect(gapLogs()).toEqual([]);
  });

  it("onGap=error이면 공백일 때 410 cursor-expired다. 본문은 고정 문구이고 요청 값을 담지 않는다", async () => {
    const cursor = await place("alpha", "JOB_SENT", 29);
    await place("alpha", "JOB_SENT", 40);
    await purge();

    const res = await getJson(app, `/events?after=${cursor}&onGap=error`);

    expect(res.status).toBe(410);
    expect(res.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    const body = (await res.json()) as Json;
    expect(body["type"]).toBe("urn:mailo:problem:cursor-expired");
    expect(body["status"]).toBe(410);
    expect(JSON.stringify(body)).not.toContain(cursor);
    // 공백이 아니면 onGap=error여도 200이다.
    const after = await place("alpha", "JOB_SENT", 29);
    expect(
      (await getJson(app, `/events?after=${after}&onGap=error`)).status,
    ).toBe(200);
  });

  it("onGap은 error만 받는다. 다른 값이나 반복은 400이다", async () => {
    for (const query of ["onGap=header", "onGap=", "onGap=error&onGap=error"]) {
      const res = await getJson(app, `/events?${query}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Json;
      expect(body["errors"]).toEqual([
        { parameter: "onGap", code: "INVALID_FORMAT" },
      ]);
    }
  });

  it("type 필터로 읽는 호출처는 다른 종류의 삭제 때문에 공백으로 판정되지 않는다", async () => {
    const cursor = await place("alpha", "JOB_FAILED", 29);
    await place("alpha", "JOB_SENT", 40);
    await place("alpha", "JOB_CANCELED", 40);
    await purge();

    const failedOnly = await getJson(
      app,
      `/events?after=${cursor}&type=JOB_FAILED`,
    );
    const sentOnly = await getJson(
      app,
      `/events?after=${cursor}&type=JOB_SENT`,
    );
    const canceled = await getJson(
      app,
      `/events?after=${cursor}&type=JOB_CANCELED&onGap=error`,
    );
    const all = await getJson(app, `/events?after=${cursor}`);

    expect(failedOnly.headers.get(GAP)).toBe(null);
    expect(sentOnly.headers.get(GAP)).toBe("true");
    expect(canceled.status).toBe(410);
    expect(all.headers.get(GAP)).toBe("true");
  });

  it("다른 호출처의 삭제는 신호를 내지 않고 삭제가 없는 호출처의 응답은 바뀌지 않는다", async () => {
    const alphaCursor = await place("alpha", "JOB_SENT", 29);
    await place("beta", "JOB_SENT", 40);
    await purge();

    const alpha = await getJson(app, `/events?after=${alphaCursor}`, ALPHA_KEY);
    expect(alpha.status).toBe(200);
    expect(alpha.headers.get(GAP)).toBe(null);
    expect(await alpha.json()).toEqual({
      events: [],
      nextCursor: alphaCursor,
      hasMore: false,
    });
    const beta = await getJson(
      app,
      `/events?after=${encodeCursor({ txid: "0", id: "0" })}`,
      BETA_KEY,
    );
    expect(beta.headers.get(GAP)).toBe("true");
  });

  it("nextCursor로 이어 읽어 cursor가 표지를 넘으면 헤더가 사라진다", async () => {
    await place("alpha", "JOB_SENT", 40);
    await place("alpha", "JOB_SENT", 29);
    await purge();
    const start = encodeCursor({ txid: "0", id: "0" });

    const first = await getJson(app, `/events?after=${start}&limit=1`);
    const page = (await first.json()) as Json;
    expect(first.headers.get(GAP)).toBe("true");
    expect(page["events"]).toHaveLength(1);

    const second = await getJson(
      app,
      `/events?after=${page["nextCursor"]}&limit=1`,
    );
    expect(second.headers.get(GAP)).toBe(null);
  });

  it("공백으로 판정한 응답마다 event_cursor_gap(warn)을 callerId만 담아 남긴다. 헤더든 410이든 같다", async () => {
    const cursor = await place("alpha", "JOB_SENT", 29);
    await place("alpha", "JOB_SENT", 40);
    await purge();
    app.logs.lines.length = 0;

    await (await getJson(app, `/events?after=${cursor}`)).text();
    await (await getJson(app, `/events?after=${cursor}&onGap=error`)).text();
    await (await getJson(app, "/events")).text();

    const logs = gapLogs();
    expect(logs).toHaveLength(2);
    for (const entry of logs) {
      expect(entry["level"]).toBe("warn");
      expect(Object.keys(entry).sort()).toEqual([
        "callerId",
        "event",
        "instance",
        "level",
        "ts",
      ]);
      expect(entry["callerId"]).toBe("alpha");
    }
  });

  it("응답·로그에 cursor, 수신자, Key 같은 요청 값이 남지 않는다(RQ-027)", async () => {
    const cursor = await place("alpha", "JOB_SENT", 29);
    await place("alpha", "JOB_SENT", 40);
    await purge();
    app.logs.lines.length = 0;

    // 200 응답의 nextCursor는 이벤트가 없으면 받은 after를 돌려주므로(ADR-0006 결정 7) 검사 대상이 아니다.
    await (await getJson(app, `/events?after=${cursor}`)).text();
    const gone = await (
      await getJson(app, `/events?after=${cursor}&onGap=error`)
    ).text();

    expect([gone, ...app.logs.lines].join("\n")).not.toContain(cursor);
    expect(app.logs.lines.join("\n")).not.toContain(CANARY.recipient);
  });
});
