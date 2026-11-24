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
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import {
  DATABASE_SECRET_VARIABLES,
  loadDatabaseOnly,
  toPgSsl,
} from "../../src/config/index.js";
import { createPool } from "../../src/db/index.js";
import { createJsonLogger } from "../../src/logging/index.js";
import { APP_SECRET_RESOLVE_OPTIONS } from "../../src/secret-names.js";
import {
  SecretResolutionError,
  resolveSecrets,
} from "../../src/secrets/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { encryptContent, jwsSecret, rsaKey } from "../support/envelope.js";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp.js";
import { fileRequest, signedFile } from "../support/file-channel.js";
import { migrate } from "../support/queue-fixtures.js";
import {
  getJson,
  plainMail,
  postJob,
  startRestApp,
  type RestApp,
} from "../support/rest-app.js";
import {
  CANARY_MESSAGE,
  FakeAdapterError,
  fakeImporter,
  fakeSource,
} from "../support/secrets.js";

/**
 * 외부 시크릿 소스 통합(실제 PostgreSQL, 로컬 smtp-server). 근거: RQ-075~078, RQ-027, ADR-0016 결정 2·5·6.
 * 어댑터는 가짜다. `X_REF`로 받은 값이 실제로 DB 접속, SMTP 인증, JWE 복호화, JWS 검증, 운영 토큰에 쓰이는지 본다.
 */

// 테스트용 가짜 값이다. 실제 시크릿이 아니다.
const SMTP_PASSWORD = "CANARY-REF-SMTP-PASSWORD-5c31";
const OPS_TOKEN = "CANARY-REF-OPS-TOKEN-".padEnd(48, "o");
const JWS_KEY = jwsSecret(0x2b);
const KEY_V1 = Buffer.from(
  Array.from({ length: 32 }, (_, i) => (i * 5 + 17) % 256),
).toString("base64");
const FINGERPRINT_V1 = Buffer.from(
  Array.from({ length: 32 }, (_, i) => (i * 11 + 29) % 256),
).toString("base64");
const jweKey = rsaKey("mailo-2026-11");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("DB 접속 비밀의 X_REF (RQ-076, 마이그레이션 CLI 범위)", () => {
  const testUrl = new URL(
    process.env.MAILO_TEST_DATABASE_URL ||
      "postgres://mailo:mailo-dev-password@localhost:5432/mailo",
  );
  const realPassword = decodeURIComponent(testUrl.password);

  const rawEnv = (ref: string): NodeJS.ProcessEnv => ({
    MAILO_SECRET_ADAPTERS: "fake-adapter",
    NODE_ENV: "test",
    MAILO_DB_HOST: testUrl.hostname,
    MAILO_DB_PORT: testUrl.port || "5432",
    MAILO_DB_USER: decodeURIComponent(testUrl.username),
    MAILO_DB_NAME: testUrl.pathname.slice(1),
    MAILO_DB_PASSWORD_REF: ref,
  });

  /** 마이그레이션 CLI(`db/migrate-cli.ts`)와 같은 순서: 범위 `database`로 해석 -> `loadDatabaseOnly` -> 풀. */
  async function connectWith(
    env: NodeJS.ProcessEnv,
    values: Record<string, string>,
  ): Promise<pg.Pool> {
    const resolved = await resolveSecrets(env, {
      names: DATABASE_SECRET_VARIABLES.map((name) => ({ name })),
      importModule: fakeImporter({
        "fake-adapter": { default: fakeSource({ values }) },
      }),
    });
    const database = loadDatabaseOnly(resolved);
    const ssl = toPgSsl(database.ssl);
    return createPool(database.url.reveal(), {
      lockTimeoutMillis: 10_000,
      ...(ssl !== undefined && { ssl }),
    });
  }

  it("MAILO_DB_PASSWORD_REF로 받은 비밀번호로 실제 PostgreSQL에 접속한다", async () => {
    const pool = await connectWith(rawEnv("fake://db"), {
      "fake://db": realPassword,
    });
    try {
      const { rows } = await pool.query("SELECT current_user AS u");
      expect(rows[0].u).toBe(decodeURIComponent(testUrl.username));
    } finally {
      await pool.end();
    }
  });

  it("MAILO_DATABASE_URL_REF로 받은 접속 URL로 접속한다", async () => {
    const pool = await connectWith(
      {
        MAILO_SECRET_ADAPTERS: "fake-adapter",
        NODE_ENV: "test",
        MAILO_DATABASE_URL_REF: "fake://url",
      },
      { "fake://url": testUrl.toString() },
    );
    try {
      const { rows } = await pool.query("SELECT 1 AS one");
      expect(rows[0].one).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("해석한 값이 쓰인다: 어댑터가 틀린 비밀번호를 주면 접속이 인증 실패로 끝나고 값은 오류에 없다", async () => {
    const wrong = "CANARY-WRONG-DB-PASSWORD-77aa";
    const pool = await connectWith(rawEnv("fake://db"), {
      "fake://db": wrong,
    });
    try {
      const error = await pool.query("SELECT 1").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe("28P01");
    } finally {
      await pool.end();
    }
  });
});

describe("전체 앱: X_REF로 받은 비밀이 실제로 쓰인다 (RQ-076·078, RQ-027)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let fake: FakeSmtp;
  let app: RestApp | undefined;
  let dir: string;
  let root: string;
  /** `resolveSecrets`가 남긴 로그 줄(main.ts가 기동 로거를 넘기는 것과 같다). */
  let resolveLogs: string[];

  const REFS = {
    smtp: "fake://prod/mailo/smtp-CANARY-REF-ID-1",
    keyV1: "fake://prod/mailo/db-key-CANARY-REF-ID-2",
    fingerprint: "fake://prod/mailo/fingerprint-CANARY-REF-ID-3",
    jws: "fake://prod/mailo/jws-alpha-CANARY-REF-ID-4",
    jwe: "fake://prod/mailo/jwe-CANARY-REF-ID-5",
    ops: "fake://prod/mailo/ops-CANARY-REF-ID-6",
  };
  const VALUES: Record<string, string> = {
    [REFS.smtp]: SMTP_PASSWORD,
    [REFS.keyV1]: KEY_V1,
    [REFS.fingerprint]: FINGERPRINT_V1,
    [REFS.jws]: JWS_KEY.toString("base64"),
    [REFS.jwe]: jweKey.privatePem,
    [REFS.ops]: OPS_TOKEN,
  };

  /** 앱 기동 전 단계를 main.ts와 같은 순서로 수행한다: 해석 -> (loadConfig·createApp은 startRestApp이 한다). */
  async function startWithRefs(
    extra: NodeJS.ProcessEnv = {},
  ): Promise<RestApp> {
    const keysFile = path.join(dir, "envelope-keys.json");
    writeFileSync(
      keysFile,
      JSON.stringify({
        keys: [
          { kid: "mailo-2026-11", privateKeyVar: "MAILO_JWE_KEY_CURRENT" },
        ],
      }),
    );
    const source = fakeSource({ values: VALUES });
    const raw: NodeJS.ProcessEnv = {
      MAILO_SECRET_ADAPTERS: "fake-adapter",
      NODE_ENV: "test",
      MAILO_SMTP_HOST: fake.host,
      MAILO_SMTP_PORT: String(fake.port),
      MAILO_SMTP_USER: "fake-user@example.invalid",
      MAILO_SMTP_FROM: "no-reply@example.com",
      MAILO_WORKER_POLL_MS: "50",
      MAILO_MAINTENANCE_INTERVAL_SECONDS: "1",
      MAILO_FILE_CHANNEL_ROOT: root,
      MAILO_FILE_POLL_INTERVAL_MS: "50",
      MAILO_ENVELOPE_KEYS_FILE: keysFile,
      MAILO_SMTP_PASSWORD_REF: REFS.smtp,
      MAILO_DB_ENCRYPTION_KEY_V1_REF: REFS.keyV1,
      MAILO_FINGERPRINT_KEY_V1_REF: REFS.fingerprint,
      MAILO_JWS_SECRET_ALPHA_REF: REFS.jws,
      MAILO_JWE_KEY_CURRENT_REF: REFS.jwe,
      MAILO_OPS_TOKEN_REF: REFS.ops,
      ...extra,
    };
    resolveLogs = [];
    const resolved = await resolveSecrets(raw, {
      ...APP_SECRET_RESOLVE_OPTIONS,
      importModule: fakeImporter({ "fake-adapter": { default: source } }),
      logger: createJsonLogger((line) => void resolveLogs.push(line), {
        instance: "test-instance",
      }),
    });
    // testEnv의 기본 비밀(`MAILO_SMTP_PASSWORD` 등)은 `resolved`의 해석값이 덮어쓴다.
    return startRestApp({
      pool,
      env: resolved,
      fileChannelCallers: ["alpha"],
      callerFields: {
        alpha: {
          signature: {
            mode: "required",
            keys: [{ kid: "alpha-1", secretVar: "MAILO_JWS_SECRET_ALPHA" }],
          },
        },
      },
      worker: { trustedCa: fake.ca },
    });
  }

  async function waitForSent(key: string): Promise<{ status: string }> {
    const started = Date.now();
    for (;;) {
      const res = await getJson(app!, `/jobs?idempotencyKey=${key}`);
      if (res.status === 200) {
        const body = (await res.json()) as { status: string };
        if (body.status === "SENT") return body;
      }
      if (Date.now() - started > 10_000) throw new Error("SENT 대기 시간 초과");
      await sleep(25);
    }
  }

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
    dir = mkdtempSync(path.join(tmpdir(), "mailo-secret-it-"));
    root = mkdtempSync(path.join(tmpdir(), "mailo-secret-file-"));
    // 코드는 폴더를 만들지 않는다(ADR-0004 결정 8).
    mkdirSync(path.join(root, "inbox", "alpha"), { recursive: true });
    await pool.query("DELETE FROM mail_events");
    await pool.query("DELETE FROM mail_jobs");
    fake.reset();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("REST: REF 개인키로 JWE를 풀고 REF SMTP 비밀번호로 인증해 발송한다", async () => {
    app = await startWithRefs();

    const content = await encryptContent(jweKey, {
      content: { subject: "REF-SUBJECT", text: "REF-BODY-TEXT" },
    });
    const res = await postJob(app, {
      key: "ref-jwe-1",
      body: {
        to: ["kim@example.com"],
        from: "no-reply@example.com",
        content,
      },
    });
    expect(res.status).toBe(202);
    await waitForSent("ref-jwe-1");

    expect(fake.lastAuth.password).toBe(SMTP_PASSWORD);
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]?.raw).toContain("REF-BODY-TEXT");
  });

  it("파일 채널: REF JWS 비밀로 서명한 파일을 수집해 발송한다", async () => {
    app = await startWithRefs();
    const inbox = path.join(root, "inbox", "alpha");
    writeFileSync(
      path.join(inbox, ".order-1.json.tmp"),
      signedFile(fileRequest({ idempotencyKey: "ref-jws-1" }), {
        caller: "alpha",
        kid: "alpha-1",
        secret: JWS_KEY,
      }),
    );
    renameSync(
      path.join(inbox, ".order-1.json.tmp"),
      path.join(inbox, "order-1.json"),
    );

    await waitForSent("ref-jws-1");
    expect(fake.messages).toHaveLength(1);
  });

  it("다른 비밀로 서명한 파일은 서명 검증에서 거부된다(해석한 비밀이 실제 검증 키다)", async () => {
    app = await startWithRefs();
    const inbox = path.join(root, "inbox", "alpha");
    writeFileSync(
      path.join(inbox, ".bad.json.tmp"),
      signedFile(fileRequest({ idempotencyKey: "ref-jws-bad" }), {
        caller: "alpha",
        kid: "alpha-1",
        secret: jwsSecret(0x2c),
      }),
    );
    renameSync(path.join(inbox, ".bad.json.tmp"), path.join(inbox, "bad.json"));

    const started = Date.now();
    for (;;) {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM mail_intake_rejections",
      );
      if (rows[0].n >= 1) break;
      if (Date.now() - started > 10_000) throw new Error("거부 기록 대기 초과");
      await sleep(25);
    }
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM mail_jobs",
    );
    expect(rows[0].n).toBe(0);
  });

  it("REF 운영 토큰으로 읽기 endpoint가 열리고 틀린 토큰은 거부된다", async () => {
    app = await startWithRefs();
    const ok = await fetch(`${app.baseUrl}/ops/accounts`, {
      headers: { Authorization: `Bearer ${OPS_TOKEN}` },
    });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${app.baseUrl}/ops/accounts`, {
      headers: { Authorization: `Bearer ${"x".repeat(48)}` },
    });
    expect(bad.status).toBe(401);
  });

  it("로그·표준 출력·오류에 값과 참조 문자열(canary)이 없다(RQ-027)", async () => {
    app = await startWithRefs();
    const content = await encryptContent(jweKey, {
      content: { subject: "REF-SUBJECT", text: "REF-BODY-TEXT" },
    });
    await postJob(app, {
      key: "ref-canary-1",
      body: { to: ["kim@example.com"], from: "no-reply@example.com", content },
    });
    await waitForSent("ref-canary-1");
    await fetch(`${app.baseUrl}/ops/accounts`, {
      headers: { Authorization: `Bearer ${OPS_TOKEN}` },
    });
    await postJob(app, { auth: "wrong-key", body: plainMail() });

    // 해석 로그는 한 줄이고 건수와 scheme만 싣는다.
    expect(resolveLogs.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({
        event: "secrets_resolved",
        level: "info",
        count: 6,
        schemes: "fake",
      }),
    ]);
    expect(Object.keys(JSON.parse(resolveLogs[0] as string)).sort()).toEqual([
      "count",
      "event",
      "instance",
      "level",
      "schemes",
      "ts",
    ]);
    expect(app.logs.lines.length).toBeGreaterThan(0);
    const output = [...resolveLogs, ...app.logs.lines].join("\n");
    const forbidden = [
      SMTP_PASSWORD,
      OPS_TOKEN,
      KEY_V1,
      FINGERPRINT_V1,
      JWS_KEY.toString("base64"),
      jweKey.privatePem,
      ...Object.values(REFS),
      "CANARY-REF-ID",
    ];
    for (const secret of forbidden) expect(output).not.toContain(secret);
  });

  it("process.env는 바뀌지 않는다(해석값은 환경 복사본에만 있다)", async () => {
    const before = JSON.stringify(process.env);
    app = await startWithRefs();
    expect(JSON.stringify(process.env)).toBe(before);
    for (const name of [
      "MAILO_SMTP_PASSWORD",
      "MAILO_OPS_TOKEN",
      "MAILO_JWE_KEY_CURRENT",
    ])
      expect(process.env[name]).toBeUndefined();
  });

  it("해석 실패(어댑터 오류)는 값 없이 기동을 거부하고 canary가 오류에 없다", async () => {
    const source = fakeSource({
      resolve: async () => {
        throw new FakeAdapterError("access-denied");
      },
    });
    const error = await resolveSecrets(
      {
        MAILO_SECRET_ADAPTERS: "fake-adapter",
        MAILO_SMTP_PASSWORD_REF: REFS.smtp,
        MAILO_OPS_TOKEN_REF: REFS.ops,
      },
      {
        ...APP_SECRET_RESOLVE_OPTIONS,
        importModule: fakeImporter({ "fake-adapter": { default: source } }),
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretResolutionError);
    const text = `${(error as Error).message}\n${(error as Error).stack}`;
    expect(text).toContain(
      "MAILO_SMTP_PASSWORD(ref:fake): adapter-error:access-denied",
    );
    for (const canary of [CANARY_MESSAGE, "CANARY-REF-ID", SMTP_PASSWORD])
      expect(text).not.toContain(canary);
  });
});
