import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { readdirSync } from "node:fs";
import type pg from "pg";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { encryptContent, rsaKey } from "../support/envelope.js";
import {
  MAILO_JWE_KID,
  createFileHarness,
  fileRequest,
  type FileHarness,
} from "../support/file-channel.js";
import { migrate } from "../support/queue-fixtures.js";

/**
 * 파일 채널의 수신 도메인 허용 목록(RQ-046, ADR-0011 결정 8, ADR-0004). REST와 같은 판정(`checkRequestPolicy`)을 쓰고
 * 어기면 `VALIDATION_FAILED` 수집 거부다. 새 거부 사유 코드는 없다. 실제 PostgreSQL과 임시 폴더를 쓴다.
 */

const CANARY = {
  recipient: "canary-recipient-a8e1",
  domain: "canary-domain-c0de.test",
  subject: "CANARY-FILE-SUBJECT-6a41",
};
const json = (value: unknown) => JSON.stringify(value);

describe("파일 채널: 수신 도메인 허용 목록 (RQ-046, ADR-0011 결정 8)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let h: FileHarness;

  const restricted = { alpha: { allowedRecipientDomains: ["example.com"] } };
  const jobs = async () =>
    (
      await pool.query<{ caller_id: string; idempotency_key: string }>(
        "SELECT caller_id, idempotency_key FROM mail_jobs ORDER BY idempotency_key",
      )
    ).rows;
  const rejections = async () =>
    (
      await pool.query<{ reason_code: string; idempotency_key: string | null }>(
        "SELECT reason_code, idempotency_key FROM mail_intake_rejections ORDER BY id",
      )
    ).rows;
  const files = (callerId: string) => readdirSync(h.inbox(callerId)).sort();

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    await migrate(pool);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM mail_events");
    await pool.query("DELETE FROM mail_intake_rejections");
    await pool.query("DELETE FROM mail_jobs");
    h = createFileHarness(pool, { callerFields: restricted });
  });

  afterEach(() => {
    h.cleanup();
  });

  it("허용 도메인의 수신자는 등록하고 원본을 지운다", async () => {
    h.drop(
      "alpha",
      "ok.json",
      json(fileRequest({ idempotencyKey: "ok", to: ["Kim@EXAMPLE.com"] })),
    );

    await h.makePoller().pollOnce();

    expect((await jobs()).map((j) => j.idempotency_key)).toEqual(["ok"]);
    expect(files("alpha")).toEqual([]);
  });

  it("수신자 하나라도 허용 밖이면 요청 전체를 VALIDATION_FAILED로 거부하고 원본을 지운다", async () => {
    h.drop(
      "alpha",
      "bad.json",
      json(
        fileRequest({
          idempotencyKey: "bad",
          to: ["ok@example.com"],
          bcc: [`${CANARY.recipient}@${CANARY.domain}`],
          subject: CANARY.subject,
        }),
      ),
    );

    await h.makePoller().pollOnce();

    expect(await jobs()).toEqual([]);
    expect(await rejections()).toEqual([
      { reason_code: "VALIDATION_FAILED", idempotency_key: "bad" },
    ]);
    expect(files("alpha")).toEqual([]);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM mail_events WHERE type = 'INTAKE_REJECTED'",
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("JWE로 암호화한 본문이어도 같은 판정이다(수신자는 평문 필드다, RQ-022)", async () => {
    const content = await encryptContent(rsaKey(MAILO_JWE_KID), {
      caller: "alpha",
      content: { subject: CANARY.subject, text: "본문" },
    });
    h.drop(
      "alpha",
      "jwe.json",
      json({
        version: 1,
        idempotencyKey: "jwe-denied",
        to: [`${CANARY.recipient}@${CANARY.domain}`],
        from: "no-reply@example.com",
        content,
      }),
    );

    await h.makePoller().pollOnce();

    expect(await jobs()).toEqual([]);
    expect((await rejections()).map((r) => r.reason_code)).toEqual([
      "VALIDATION_FAILED",
    ]);
  });

  it("제한이 없는 호출처는 어떤 도메인으로도 등록된다", async () => {
    h.drop(
      "beta",
      "any.json",
      json(fileRequest({ idempotencyKey: "any", to: ["a@other.test"] })),
    );

    await h.makePoller().pollOnce();

    expect(await jobs()).toEqual([
      { caller_id: "beta", idempotency_key: "any" },
    ]);
  });

  it("이미 등록된 Key의 재수집은 정책이 바뀐 뒤에도 duplicate이고 거부하지 않는다", async () => {
    const loose = createFileHarness(pool);
    try {
      loose.drop(
        "alpha",
        "first.json",
        json(fileRequest({ idempotencyKey: "same", to: ["a@other.test"] })),
      );
      await loose.makePoller().pollOnce();
      expect((await jobs()).map((j) => j.idempotency_key)).toEqual(["same"]);
    } finally {
      loose.cleanup();
    }

    h.drop(
      "alpha",
      "again.json",
      json(fileRequest({ idempotencyKey: "same", to: ["a@other.test"] })),
    );
    const summary = await h.makePoller().pollOnce();

    expect(summary.callers.reduce((n, c) => n + c.duplicates, 0)).toBe(1);
    expect(await rejections()).toEqual([]);
    expect(files("alpha")).toEqual([]);
  });

  it("거부 기록·로그·이벤트에 주소와 도메인이 남지 않는다(RQ-027)", async () => {
    h.drop(
      "alpha",
      "canary.json",
      json(
        fileRequest({
          idempotencyKey: "canary",
          to: [`${CANARY.recipient}@${CANARY.domain}`],
          subject: CANARY.subject,
        }),
      ),
    );

    await h.makePoller().pollOnce();

    const stored = JSON.stringify([
      (await pool.query("SELECT * FROM mail_intake_rejections")).rows,
      (await pool.query("SELECT * FROM mail_events")).rows,
    ]);
    for (const secret of [CANARY.recipient, CANARY.domain, CANARY.subject]) {
      expect(stored).not.toContain(secret);
      expect(h.logs.join("\n")).not.toContain(secret);
    }
  });
});
