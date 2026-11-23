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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import { FileChannelStartError } from "../../src/file-channel/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { fileRequest } from "../support/file-channel.js";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp.js";
import { migrate } from "../support/queue-fixtures.js";
import {
  getJson,
  plainMail,
  postJob,
  startRestApp,
  type RestApp,
} from "../support/rest-app.js";

/**
 * end-to-end: 파일 -> 폴러 -> PostgreSQL -> Worker -> 로컬 smtp-server -> GET /jobs·GET /events.
 * 파일 채널 호출처는 REST 자격으로 Key를 조회하고 이벤트를 읽는다(ADR-0006 결정 1·5). 근거: RQ-002·028, ADR-0004.
 * 앱은 `createApp`이 폴러와 Worker를 함께 켠다. NFS는 검증하지 않았다.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("e2e: 파일 -> 폴러 -> Worker -> SMTP -> 조회·이벤트 (RQ-002)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let fake: FakeSmtp;
  let app: RestApp | undefined;
  let root: string;

  const env = (extra: NodeJS.ProcessEnv = {}) => ({
    MAILO_SMTP_HOST: fake.host,
    MAILO_SMTP_PORT: String(fake.port),
    MAILO_SMTP_USER: "fake-user@example.invalid",
    MAILO_WORKER_POLL_MS: "50",
    MAILO_MAINTENANCE_INTERVAL_SECONDS: "1",
    MAILO_FILE_CHANNEL_ROOT: root,
    MAILO_FILE_POLL_INTERVAL_MS: "50",
    ...extra,
  });

  const startApp = (extra: NodeJS.ProcessEnv = {}) =>
    startRestApp({
      pool,
      env: env(extra),
      fileChannelCallers: ["alpha"],
      worker: { trustedCa: fake.ca },
    });

  /** 호출처가 하는 일: 임시 이름으로 쓴 뒤 같은 폴더에서 rename한다. */
  function drop(name: string, content: string): void {
    const dir = path.join(root, "inbox", "alpha");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `.${name}.tmp`), content);
    renameSync(path.join(dir, `.${name}.tmp`), path.join(dir, name));
  }
  const inboxFiles = () => readdirSync(path.join(root, "inbox", "alpha"));

  async function waitFor<T>(
    fn: () => Promise<T | undefined | false | null>,
    timeoutMs = 10_000,
  ): Promise<T> {
    const started = Date.now();
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() - started > timeoutMs)
        throw new Error("waitFor 시간 초과");
      await sleep(25);
    }
  }

  const feed = async (query = "") => {
    const res = await getJson(app!, `/events${query}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: Array<Record<string, unknown>> })
      .events;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    await migrate(pool);
    fake = await startFakeSmtp();
  });

  afterAll(async () => {
    await fake.close();
    await db.close();
  });

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "mailo-file-e2e-"));
    await pool.query("DELETE FROM mail_events");
    await pool.query("DELETE FROM mail_intake_rejections");
    await pool.query("DELETE FROM mail_jobs");
    fake.reset();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("파일로 넣은 메일이 SMTP로 나가고, 호출처는 REST 자격으로 Key 조회와 JOB_SENT 이벤트를 읽는다", async () => {
    mkdirSync(path.join(root, "inbox", "alpha"), { recursive: true });
    app = await startApp();

    drop(
      "order-1.json",
      JSON.stringify(
        fileRequest({
          idempotencyKey: "file-e2e-1",
          to: ["kim@example.com"],
          subject: "파일 채널 안내",
          text: "파일로 접수된 메일입니다.",
        }),
      ),
    );

    const job = await waitFor(async () => {
      const res = await getJson(app!, "/jobs?idempotencyKey=file-e2e-1");
      if (res.status !== 200) return undefined;
      const body = (await res.json()) as { status: string; jobId: string };
      return body.status === "SENT" ? body : undefined;
    });
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]!.rcptTo).toEqual(["kim@example.com"]);
    const decoded = (
      fake.messages[0]!.raw.match(/^[A-Za-z0-9+/=]{16,}$/gm) ?? []
    ).map((p) => Buffer.from(p, "base64").toString("utf8"));
    expect(decoded).toContain("파일로 접수된 메일입니다.");

    const events = await waitFor(async () => {
      const all = await feed("?type=JOB_SENT");
      return all.length > 0 ? all : undefined;
    });
    expect(events[0]).toMatchObject({
      type: "JOB_SENT",
      jobId: job.jobId,
      idempotencyKey: "file-e2e-1",
    });
    expect(inboxFiles()).toEqual([]); // 등록 뒤 원본이 사라진다
  });

  it("거부된 파일은 Key 조회가 404이고 이벤트 피드에서 INTAKE_REJECTED로 찾는다", async () => {
    mkdirSync(path.join(root, "inbox", "alpha"), { recursive: true });
    app = await startApp();

    drop(
      "bad.json",
      JSON.stringify(
        fileRequest({ idempotencyKey: "file-e2e-bad", to: ["not-an-address"] }),
      ),
    );

    const rejected = await waitFor(async () => {
      const all = await feed("?type=INTAKE_REJECTED");
      return all.length > 0 ? all : undefined;
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      type: "INTAKE_REJECTED",
      idempotencyKey: "file-e2e-bad",
      fileName: "bad.json",
      reasonCode: "VALIDATION_FAILED",
    });
    expect(
      (await getJson(app, "/jobs?idempotencyKey=file-e2e-bad")).status,
    ).toBe(404);
    expect(fake.messages).toHaveLength(0);
    expect(inboxFiles()).toEqual([]);
  });

  it("같은 호출처가 REST와 파일로 같은 Key·같은 내용을 보내면 같은 작업이고 메일은 1통이다 (RQ-028)", async () => {
    mkdirSync(path.join(root, "inbox", "alpha"), { recursive: true });
    app = await startApp();
    const mail = plainMail({ to: ["kim@example.com"] });
    const rest = await postJob(app, { key: "both-1", body: mail });
    expect(rest.status).toBe(202);
    const { jobId } = (await rest.json()) as { jobId: string };

    drop(
      "same.json",
      JSON.stringify({ version: 1, idempotencyKey: "both-1", ...mail }),
    );
    await waitFor(async () => (inboxFiles().length === 0 ? true : undefined));

    await waitFor(async () => {
      const res = await getJson(app!, `/jobs/${jobId}`);
      return ((await res.json()) as { status: string }).status === "SENT"
        ? true
        : undefined;
    });
    await sleep(200);
    const count = await pool.query("SELECT count(*)::int AS n FROM mail_jobs");
    expect(count.rows[0].n).toBe(1);
    expect(fake.messages).toHaveLength(1);
    expect((await feed("?type=INTAKE_REJECTED")).length).toBe(0);
  });

  it("앱을 닫으면 폴러가 멈춘다(닫은 뒤에 넣은 파일은 수집되지 않는다)", async () => {
    mkdirSync(path.join(root, "inbox", "alpha"), { recursive: true });
    app = await startApp();
    await app.close();
    app = undefined;

    drop(
      "after.json",
      JSON.stringify(fileRequest({ idempotencyKey: "after" })),
    );
    await sleep(300);

    expect(inboxFiles()).toEqual(["after.json"]);
    const count = await pool.query("SELECT count(*)::int AS n FROM mail_jobs");
    expect(count.rows[0].n).toBe(0);
  });

  it("root가 없으면 앱이 기동하지 않는다(코드가 폴더를 만들지 않는다)", async () => {
    const missing = path.join(root, "not-created");

    await expect(
      startApp({ MAILO_FILE_CHANNEL_ROOT: missing }),
    ).rejects.toBeInstanceOf(FileChannelStartError);

    expect(existsSync(missing)).toBe(false);
  });

  it("root를 설정하지 않으면 파일 채널은 꺼져 있고 파일을 읽지 않는다", async () => {
    mkdirSync(path.join(root, "inbox", "alpha"), { recursive: true });
    drop("off.json", JSON.stringify(fileRequest({ idempotencyKey: "off" })));
    app = await startRestApp({
      pool,
      env: env({ MAILO_FILE_CHANNEL_ROOT: "" }),
      fileChannelCallers: ["alpha"],
    });
    await sleep(300);

    expect(inboxFiles()).toEqual(["off.json"]);
    expect(app.logs.lines.join("")).toContain("file_channel_disabled");
  });
});
