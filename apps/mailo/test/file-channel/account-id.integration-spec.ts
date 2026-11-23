import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  createFileHarness,
  fileRequest,
  type FileHarness,
} from "../support/file-channel.js";
import { migrate } from "../support/queue-fixtures.js";

/**
 * 파일 채널의 계정 고정과 발신 주소 허용 집합(RQ-054·055, ADR-0013 결정 2·6). REST와 같은 판정이다.
 * alpha는 계정 marketing(계정 파일), beta는 default(환경 변수)를 쓴다. 실제 PostgreSQL과 임시 폴더를 쓴다.
 */
const DEFAULT_FROM = "no-reply@example.com";
const MARKETING_FROM = "marketing@marketing.example.net";
const json = (value: unknown) => JSON.stringify(value);

describe("파일 채널: 호출처 계정 (RQ-054·055, ADR-0013 결정 2·6)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let h: FileHarness;
  let dir: string;

  const jobs = async () =>
    (
      await pool.query<{
        caller_id: string;
        account_id: string;
        idempotency_key: string;
      }>(
        "SELECT caller_id, account_id, idempotency_key FROM mail_jobs ORDER BY idempotency_key",
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
    dir = mkdtempSync(path.join(tmpdir(), "mailo-file-accounts-"));
  });

  afterAll(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM mail_events");
    await pool.query("DELETE FROM mail_intake_rejections");
    await pool.query("DELETE FROM mail_jobs");
    const accountsFile = path.join(dir, "accounts.json");
    writeFileSync(
      accountsFile,
      json({
        accounts: [
          {
            id: "marketing",
            host: "mk.smtp.example.invalid",
            auth: {
              user: "mk-login@example.invalid",
              secretVar: "MAILO_SMTP_SECRET_MARKETING",
            },
            from: MARKETING_FROM,
          },
        ],
      }),
    );
    h = createFileHarness(pool, {
      env: {
        MAILO_SMTP_ACCOUNTS_FILE: accountsFile,
        MAILO_SMTP_SECRET_MARKETING: "fake-marketing-password-0000",
      },
      callerFields: { alpha: { accountId: "marketing", allowedFrom: [] } },
    });
  });

  afterEach(() => {
    h.cleanup();
  });

  it("호출처 계정의 from은 등록되고 작업이 그 계정으로 고정된다", async () => {
    h.drop(
      "alpha",
      "a.json",
      json(fileRequest({ idempotencyKey: "a-1", from: MARKETING_FROM })),
    );
    h.drop(
      "beta",
      "b.json",
      json(fileRequest({ idempotencyKey: "b-1", from: DEFAULT_FROM })),
    );

    await h.makePoller().pollOnce();

    expect(await jobs()).toEqual([
      { caller_id: "alpha", account_id: "marketing", idempotency_key: "a-1" },
      { caller_id: "beta", account_id: "default", idempotency_key: "b-1" },
    ]);
    expect(files("alpha")).toEqual([]);
    expect(files("beta")).toEqual([]);
  });

  it("from을 생략한 파일도 등록된다(Worker가 작업 계정의 from으로 채운다)", async () => {
    h.drop(
      "alpha",
      "a.json",
      json(fileRequest({ idempotencyKey: "a-omit", from: undefined })),
    );

    await h.makePoller().pollOnce();

    expect(await jobs()).toEqual([
      {
        caller_id: "alpha",
        account_id: "marketing",
        idempotency_key: "a-omit",
      },
    ]);
    const { rows } = await pool.query("SELECT envelope FROM mail_jobs");
    expect(rows[0].envelope).toEqual({ from: null, replyTo: null });
  });

  it("다른 계정의 from은 VALIDATION_FAILED로 거부하고 어느 주소도 기록에 남기지 않는다", async () => {
    h.drop(
      "alpha",
      "a.json",
      json(fileRequest({ idempotencyKey: "a-bad", from: DEFAULT_FROM })),
    );
    h.drop(
      "beta",
      "b.json",
      json(fileRequest({ idempotencyKey: "b-bad", from: MARKETING_FROM })),
    );

    await h.makePoller().pollOnce();

    expect(await jobs()).toEqual([]);
    expect(await rejections()).toEqual([
      { reason_code: "VALIDATION_FAILED", idempotency_key: "a-bad" },
      { reason_code: "VALIDATION_FAILED", idempotency_key: "b-bad" },
    ]);
    const dump = JSON.stringify(
      (await pool.query("SELECT * FROM mail_intake_rejections")).rows,
    );
    expect(dump).not.toContain("example.com");
    expect(dump).not.toContain("marketing.example.net");
  });
});
