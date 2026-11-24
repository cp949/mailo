import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { hashApiKey } from "../../src/crypto/index.js";
import { rsaKey } from "../support/envelope.js";

/**
 * 컴파일한 진입점(`main.js`, `db/migrate-cli.js`)의 `X_REF` 기동 실패와 성공 경로(RQ-075·076·078, RQ-027, ADR-0016 결정 2·5).
 * 실제 프로세스를 띄워 종료 코드, `startup_failed` 로그, 기동 성공을 본다. 소스를 `node_modules/.cache` 아래로 컴파일하고
 * 그 컴파일 폴더의 `node_modules`에 가짜 어댑터 패키지를 둔다(실제 `node_modules`는 건드리지 않는다).
 * 성공 경로는 테스트 전용 schema에 마이그레이션을 적용하고 그 schema로 앱을 띄운다(실제 PostgreSQL).
 */

const APP_DIR = path.resolve(import.meta.dirname, "../..");
const CACHE = path.join(APP_DIR, "node_modules", ".cache");
const MIGRATIONS_LINK = path.join(CACHE, "migrations");

// 로그에 나오면 안 되는 문자열.
const CANARY_VALUE = "CANARY-PLAIN-VALUE-6e2f91";
const CANARY_REF = "CANARY-REF-SECRET-ID-b08c3d";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe("기동 진입점의 X_REF 실패 (RQ-078, RQ-027)", () => {
  let outDir: string;

  beforeAll(() => {
    mkdirSync(CACHE, { recursive: true });
    outDir = mkdtempSync(path.join(CACHE, "mailo-secret-startup-"));
    const tsc = path.join(APP_DIR, "node_modules", ".bin", "tsc");
    const built = spawnSync(
      tsc,
      ["-p", "tsconfig.build.json", "--outDir", outDir],
      { cwd: APP_DIR, encoding: "utf8" },
    );
    if (built.status !== 0)
      throw new Error(
        `컴파일 실패(종료 코드 ${built.status}): ${built.stdout}`,
      );
  }, 120_000);

  afterAll(() => {
    if (outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
  });

  function run(entry: string, env: Record<string, string>): RunResult {
    // 부모 프로세스의 MAILO_* 변수가 섞이지 않게 환경을 새로 만든다.
    const result = spawnSync(process.execPath, [path.join(outDir, entry)], {
      cwd: outDir,
      env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test", ...env },
      encoding: "utf8",
      timeout: 30_000,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  function startupFailed(result: RunResult): {
    message: string;
    error: string;
  } {
    const lines = result.stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const failed = lines.find((l) => l["event"] === "startup_failed");
    if (failed === undefined)
      throw new Error(`startup_failed 로그가 없다: ${result.stdout}`);
    return {
      message: String(failed["message"]),
      error: String(failed["error"]),
    };
  }

  function expectNoCanary(result: RunResult): void {
    const all = `${result.stdout}\n${result.stderr}`;
    for (const canary of [CANARY_VALUE, CANARY_REF])
      expect(all).not.toContain(canary);
  }

  it("main: 어댑터 로드 실패는 해석보다 먼저 보고되고 종료 코드 1과 startup_failed에 고정 문구만 남긴다", () => {
    const result = run("main.js", {
      MAILO_SECRET_ADAPTERS: "mailo-no-such-adapter-4f1a",
      MAILO_OPS_TOKEN: CANARY_VALUE,
      MAILO_OPS_TOKEN_REF: `aws-sm://${CANARY_REF}`,
    });
    // 어댑터 로드가 해석보다 먼저라 어댑터 오류가 먼저 보고된다.
    expect(result.status).toBe(1);
    const failed = startupFailed(result);
    expect(failed.error).toBe("SecretAdapterLoadError");
    expect(failed.message).toBe(
      "비밀값 어댑터 로드 실패: mailo-no-such-adapter-4f1a: not-found",
    );
    expectNoCanary(result);
  });

  it("main: 충돌은 conflict로 기동을 거부한다", () => {
    const result = run("main.js", {
      MAILO_OPS_TOKEN: CANARY_VALUE,
      MAILO_OPS_TOKEN_REF: `aws-sm://${CANARY_REF}`,
      MAILO_DB_PASSWORD_REF: `aws-sm://${CANARY_REF}`,
      MAILO_DB_PASSWORD_FILE: "/run/secrets/db",
    });
    expect(result.status).toBe(1);
    const failed = startupFailed(result);
    expect(failed.error).toBe("SecretResolutionError");
    expect(failed.message.split("\n")).toEqual([
      "비밀값 해석 실패: MAILO_DB_PASSWORD(file+ref): conflict",
      "비밀값 해석 실패: MAILO_OPS_TOKEN(env+ref): conflict",
    ]);
    expectNoCanary(result);
  });

  it("main: 오타가 난 MAILO_*_REF와 어댑터가 없는 scheme은 값 없이 거부한다", () => {
    const result = run("main.js", {
      MAILO_SMTP_PASWORD_REF: `aws-sm://${CANARY_REF}`,
      MAILO_OPS_TOKEN_REF: `aws-sm://${CANARY_REF}`,
    });
    expect(result.status).toBe(1);
    expect(startupFailed(result).message.split("\n")).toEqual([
      "비밀값 해석 실패: MAILO_OPS_TOKEN(ref): unknown-scheme",
      "비밀값 해석 실패: MAILO_SMTP_PASWORD_REF(ref): unknown-name",
    ]);
    expectNoCanary(result);
  });

  it("main: 해석 timeout 설정이 범위 밖이면 변수 이름과 범위만 알린다", () => {
    const result = run("main.js", { MAILO_SECRET_RESOLVE_TIMEOUT_MS: "99" });
    expect(result.status).toBe(1);
    const failed = startupFailed(result);
    expect(failed.error).toBe("SecretSettingsError");
    expect(failed.message).toBe(
      "MAILO_SECRET_RESOLVE_TIMEOUT_MS은 100 이상 60000 이하의 정수여야 한다",
    );
  });

  it("main: X_REF를 쓰지 않으면 해석 단계는 아무것도 하지 않고 기존 설정 오류 경로로 간다", () => {
    const result = run("main.js", {});
    expect(result.status).toBe(1);
    expect(startupFailed(result).error).toBe("ConfigError");
    expect(result.stdout).not.toContain("secrets_resolved");
  });

  it("마이그레이션 CLI: DB 비밀의 해석 실패는 종료 코드 1과 고정 문구만 내고 DB에 접속하지 않는다", () => {
    const result = run("db/migrate-cli.js", {
      MAILO_DATABASE_URL_REF: `aws-sm://${CANARY_REF}`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      "비밀값 해석 실패: MAILO_DATABASE_URL(ref): unknown-scheme",
    );
    expectNoCanary(result);
  });

  it("마이그레이션 CLI: DB 비밀이 아닌 *_REF는 해석하지 않고 무시한다", () => {
    const result = run("db/migrate-cli.js", {
      MAILO_OPS_TOKEN_REF: `aws-sm://${CANARY_REF}`,
    });
    // DB 설정이 없어 설정 오류로 끝난다. 해석 오류가 아니다.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MAILO_DATABASE_URL이 설정되지 않았다");
    expect(result.stderr).not.toContain("비밀값 해석 실패");
    expectNoCanary(result);
  });
});

describe("기동 진입점의 X_REF 성공 경로 (RQ-075·076, ADR-0016 결정 2)", () => {
  const testUrl =
    process.env["MAILO_TEST_DATABASE_URL"] ||
    "postgres://mailo:mailo-dev-password@localhost:5432/mailo";
  const schema = `startup_${process.pid}_${Date.now()}`;
  const jweKey = rsaKey("mailo-2026-11");
  const SMTP_PASSWORD = "CANARY-STARTUP-SMTP-PASSWORD-91d2";
  const OPS_TOKEN = "CANARY-STARTUP-OPS-TOKEN-".padEnd(48, "t");
  const DB_KEY = Buffer.from(
    Array.from({ length: 32 }, (_, i) => (i * 3 + 7) % 256),
  ).toString("base64");
  const FP_KEY = Buffer.from(
    Array.from({ length: 32 }, (_, i) => (i * 13 + 5) % 256),
  ).toString("base64");

  let outDir: string;
  let work: string;
  let schemaUrl: string;
  let linkedMigrations = false;
  let baseEnv: Record<string, string>;

  function adapterValues(extra: Record<string, string> = {}): string {
    const file = path.join(work, "values.json");
    writeFileSync(
      file,
      JSON.stringify({
        "fake://db": schemaUrl,
        "fake://smtp": SMTP_PASSWORD,
        "fake://db-key": DB_KEY,
        "fake://fp-key": FP_KEY,
        "fake://jwe": jweKey.privatePem,
        "fake://ops": OPS_TOKEN,
        ...extra,
      }),
    );
    return file;
  }

  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        server.close(() => resolve(port));
      });
    });
  }

  interface Started {
    port: number;
    stdout: () => string;
    stderr: () => string;
    stop(): Promise<string>;
  }

  /** `main.js`를 띄우고 `/health/live`가 200일 때까지 기다린다. */
  async function startMain(env: Record<string, string>): Promise<Started> {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(outDir, "main.js")], {
      cwd: outDir,
      env: {
        PATH: process.env["PATH"] ?? "",
        NODE_ENV: "test",
        MAILO_PORT: String(port),
        MAILO_WORKER_POLL_MS: "200",
        ...env,
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => void (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => void (err += c.toString("utf8")));
    const exited = new Promise<string>((resolve) =>
      child.once("exit", (code, signal) =>
        resolve(code === null ? `signal:${signal}` : `code:${code}`),
      ),
    );
    /**
     * SIGTERM으로 끝낸다. Nest 종료 훅은 정리를 마친 뒤 같은 신호로 프로세스를 끝내므로 정상 종료는
     * `code:0` 또는 `signal:SIGTERM`이다. 20초 안에 끝나지 않으면 강제 종료하고 `timeout`을 돌려준다.
     */
    const stop = async (): Promise<string> => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        exited,
        new Promise<string>((r) => {
          timer = setTimeout(() => r("timeout"), 20_000);
        }),
      ]);
      clearTimeout(timer);
      if (result === "timeout") child.kill("SIGKILL");
      return result;
    };
    const started = Date.now();
    for (;;) {
      if (child.exitCode !== null)
        throw new Error(`기동 실패(종료 코드 ${child.exitCode}): ${out}${err}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health/live`);
        if (res.status === 200) break;
      } catch {
        // 아직 listen 전이다.
      }
      if (Date.now() - started > 20_000) {
        await stop();
        throw new Error(`기동 시간 초과: ${out}${err}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { port, stdout: () => out, stderr: () => err, stop };
  }

  // 위 describe와 컴파일 폴더를 공유하지 않는다(describe 범위). 이 describe는 가짜 어댑터 패키지를 따로 둔다.
  beforeAll(async () => {
    mkdirSync(CACHE, { recursive: true });
    outDir = mkdtempSync(path.join(CACHE, "mailo-secret-startup-ok-"));
    const built = spawnSync(
      path.join(APP_DIR, "node_modules", ".bin", "tsc"),
      ["-p", "tsconfig.build.json", "--outDir", outDir],
      { cwd: APP_DIR, encoding: "utf8" },
    );
    if (built.status !== 0)
      throw new Error(
        `컴파일 실패(종료 코드 ${built.status}): ${built.stdout}`,
      );
    // 마이그레이션 CLI는 `<컴파일 폴더>/../../migrations`를 읽는다. 컴파일 폴더가 `dist`보다 한 단계 깊어 같은 위치에 링크를 둔다.
    if (!existsSync(MIGRATIONS_LINK)) {
      symlinkSync(path.join(APP_DIR, "migrations"), MIGRATIONS_LINK);
      linkedMigrations = true;
    }
    // 가짜 어댑터: 컴파일 폴더의 node_modules에 둔다. `dist/secrets/loader.js`의 import()가 위로 올라가며 찾는다.
    const pkg = path.join(outDir, "node_modules", "mailo-fake-adapter");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "mailo-fake-adapter",
        type: "module",
        main: "index.js",
      }),
    );
    writeFileSync(
      path.join(pkg, "index.js"),
      `import { readFileSync } from "node:fs";
export default {
  scheme: "fake",
  async resolve(ref) {
    const values = JSON.parse(readFileSync(process.env.FAKE_ADAPTER_VALUES_FILE, "utf8"));
    // 해석 뒤에도 남는 핸들(닫지 않은 타이머·소켓을 흉내 낸다). 진입점은 이 핸들과 무관하게 끝나야 한다.
    if (process.env.FAKE_ADAPTER_LEAVE_HANDLE) setInterval(() => {}, 60_000);
    if (!(ref in values)) throw Object.assign(new Error("not found"), { code: "not-found" });
    return values[ref];
  },
};
`,
    );
    work = mkdtempSync(path.join(tmpdir(), "mailo-secret-startup-work-"));

    // 이 파일 전용 schema. 앱과 마이그레이션 CLI는 접속 URL의 `options`로 search_path를 받는다.
    const admin = new pg.Client({ connectionString: testUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const url = new URL(testUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    schemaUrl = url.toString();

    const callersFile = path.join(work, "callers.json");
    writeFileSync(
      callersFile,
      JSON.stringify({
        callers: [
          {
            id: "alpha",
            apiKeyHashes: [
              hashApiKey("alpha-fake-api-key-0000000000000000000000001"),
            ],
            fileChannel: false,
            signature: { mode: "none" },
          },
        ],
      }),
    );
    const keysFile = path.join(work, "envelope-keys.json");
    writeFileSync(
      keysFile,
      JSON.stringify({
        keys: [
          { kid: "mailo-2026-11", privateKeyVar: "MAILO_JWE_KEY_CURRENT" },
        ],
      }),
    );
    baseEnv = {
      MAILO_CALLERS_FILE: callersFile,
      MAILO_SMTP_HOST: "smtp.example.invalid",
      MAILO_SMTP_USER: "fake-user@example.invalid",
      MAILO_SMTP_FROM: "no-reply@example.com",
      MAILO_ENVELOPE_KEYS_FILE: keysFile,
    };
  }, 120_000);

  afterAll(async () => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
    if (work) rmSync(work, { recursive: true, force: true });
    if (linkedMigrations) rmSync(MIGRATIONS_LINK, { force: true });
    const admin = new pg.Client({ connectionString: testUrl });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  function refEnv(): Record<string, string> {
    return {
      ...baseEnv,
      MAILO_SECRET_ADAPTERS: "mailo-fake-adapter",
      FAKE_ADAPTER_VALUES_FILE: adapterValues(),
      MAILO_DATABASE_URL_REF: "fake://db",
      MAILO_SMTP_PASSWORD_REF: "fake://smtp",
      MAILO_DB_ENCRYPTION_KEY_V1_REF: "fake://db-key",
      MAILO_FINGERPRINT_KEY_V1_REF: "fake://fp-key",
      MAILO_JWE_KEY_CURRENT_REF: "fake://jwe",
      MAILO_OPS_TOKEN_REF: "fake://ops",
    };
  }

  it("마이그레이션 CLI: MAILO_DATABASE_URL_REF로 받은 URL로 접속해 마이그레이션을 적용한다", async () => {
    const result = spawnSync(
      process.execPath,
      [path.join(outDir, "db", "migrate-cli.js")],
      {
        cwd: outDir,
        env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test", ...refEnv() },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect({ status: result.status, err: result.stderr }).toEqual({
      status: 0,
      err: "",
    });
    expect(result.stdout).toMatch(/^마이그레이션 적용 \d+건\n$/);
    for (const canary of [SMTP_PASSWORD, OPS_TOKEN, schemaUrl])
      expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
    const client = new pg.Client({ connectionString: schemaUrl });
    await client.connect();
    try {
      const { rows } = await client.query(
        "SELECT count(*)::int AS n FROM schema_migrations",
      );
      expect(rows[0].n).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  }, 90_000);

  it("마이그레이션 CLI: 어댑터가 핸들(타이머)을 남겨도 성공하면 종료 코드 0으로 끝나고 출력은 그대로다", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(outDir, "db", "migrate-cli.js")],
      {
        cwd: outDir,
        env: {
          PATH: process.env["PATH"] ?? "",
          NODE_ENV: "test",
          ...refEnv(),
          FAKE_ADAPTER_LEAVE_HANDLE: "1",
        },
        encoding: "utf8",
        // 핸들 때문에 끝나지 않으면 이 제한 시간에 죽고 status가 null이다(compose의 `migrate && exec main`이 멈추는 경우).
        timeout: 20_000,
      },
    );
    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({
      status: 0,
      signal: null,
      stdout: "마이그레이션 적용 0건\n",
      stderr: "",
    });
  }, 40_000);

  it("main: 모든 비밀을 X_REF로 받아 기동하고 해석값이 설정·DB·개인키·운영 토큰에 쓰인다", async () => {
    const app = await startMain(refEnv());
    try {
      // DB(REF URL), 운영 토큰(REF), 개인키 목록(REF 개인키)이 모두 쓰여야 이 호출이 통과한다.
      const ready = await fetch(`http://127.0.0.1:${app.port}/health/ready`);
      expect(ready.status).toBe(200);
      const ops = await fetch(`http://127.0.0.1:${app.port}/ops/accounts`, {
        headers: { Authorization: `Bearer ${OPS_TOKEN}` },
      });
      expect(ops.status).toBe(200);
      const lines = app
        .stdout()
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.filter((l) => l["event"] === "secrets_resolved")).toEqual([
        expect.objectContaining({ count: 6, schemes: "fake", level: "info" }),
      ]);
    } finally {
      expect(["code:0", "signal:SIGTERM"]).toContain(await app.stop());
    }
    const output = `${app.stdout()}${app.stderr()}`;
    for (const canary of [
      SMTP_PASSWORD,
      OPS_TOKEN,
      DB_KEY,
      FP_KEY,
      jweKey.privatePem,
      schemaUrl,
      "fake://",
    ])
      expect(output).not.toContain(canary);
  }, 60_000);

  it("main: X_REF 없이 평문 환경 변수만 쓰는 기존 구성이 기존대로 기동하고 해석 로그를 남기지 않는다", async () => {
    const app = await startMain({
      ...baseEnv,
      MAILO_DATABASE_URL: schemaUrl,
      MAILO_SMTP_PASSWORD: SMTP_PASSWORD,
      MAILO_DB_ENCRYPTION_KEY_V1: DB_KEY,
      MAILO_FINGERPRINT_KEY_V1: FP_KEY,
      MAILO_JWE_KEY_CURRENT: jweKey.privatePem,
      MAILO_OPS_TOKEN: OPS_TOKEN,
    });
    try {
      const ready = await fetch(`http://127.0.0.1:${app.port}/health/ready`);
      expect(ready.status).toBe(200);
    } finally {
      expect(["code:0", "signal:SIGTERM"]).toContain(await app.stop());
    }
    expect(app.stdout()).not.toContain("secrets_resolved");
  }, 60_000);
});
