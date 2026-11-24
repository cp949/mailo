import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * 컴파일한 진입점(`main.js`, `db/migrate-cli.js`)의 `X_REF` 기동 실패 경로(RQ-078, RQ-027, ADR-0016 결정 5).
 * 실제 프로세스를 띄워 종료 코드와 `startup_failed` 로그를 본다. 값 해석이 성공하는 경로는 `secret-sources.integration-spec.ts`가
 * `createApp`으로 확인한다(어댑터 패키지를 설치하지 않으므로 이 파일은 실패 경로만 다룬다). DB에는 접속하지 않는다.
 * 소스를 `node_modules/.cache` 아래로 컴파일한다. `node_modules`를 위로 찾을 수 있는 위치다.
 */

const APP_DIR = path.resolve(import.meta.dirname, "../..");
const CACHE = path.join(APP_DIR, "node_modules", ".cache");

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
