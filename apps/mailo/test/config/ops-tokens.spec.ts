import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { ConfigError, loadConfig } from "../../src/config/index.js";
import { testEnv } from "../support/rest-app.js";

// 테스트용 가짜 토큰이다. 실제 시크릿이 아니다.
const READ = "r".repeat(40);
const ONCALL = "o".repeat(40);
const DEPLOY = "d".repeat(40);

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return testEnv({ MAILO_CALLERS_FILE: "/etc/mailo/callers.json", ...extra });
}

function issuesOf(extra: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env(extra));
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error("설정 오류가 나야 한다");
}

/**
 * 관리 토큰 설정(RQ-042, ADR-0011 결정 1). 이름 목록 `MAILO_OPS_ADMIN_NAMES`와
 * 이름별 `MAILO_OPS_ADMIN_TOKEN_<이름 대문자>`(`_FILE` 우선)를 읽는다. 환경 변수만 쓰고 DB·레지스트리는 쓰지 않는다.
 */
describe("관리 토큰 설정 (RQ-042, ADR-0011 결정 1)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mailo-ops-tokens-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("이름 목록이 없으면 관리 기능이 꺼진다(읽기 토큰은 그대로)", () => {
    const config = loadConfig(env({ MAILO_OPS_TOKEN: READ }));

    expect(config.ops.admins).toEqual([]);
    expect(config.ops.token?.reveal()).toBe(READ);
  });

  it("이름마다 대문자 변수에서 토큰을 읽고 순서를 유지한다", () => {
    const config = loadConfig(
      env({
        MAILO_OPS_ADMIN_NAMES: "oncall, deploy2",
        MAILO_OPS_ADMIN_TOKEN_ONCALL: ONCALL,
        MAILO_OPS_ADMIN_TOKEN_DEPLOY2: DEPLOY,
      }),
    );

    expect(config.ops.admins.map((a) => a.name)).toEqual(["oncall", "deploy2"]);
    expect(config.ops.admins.map((a) => a.token.reveal())).toEqual([
      ONCALL,
      DEPLOY,
    ]);
    expect(config.ops.token).toBeNull();
  });

  it("_FILE이 변수보다 우선하고 파일 끝 개행은 제거한다", () => {
    const file = path.join(dir, "oncall-token");
    writeFileSync(file, `${ONCALL}\n`);

    const config = loadConfig(
      env({
        MAILO_OPS_ADMIN_NAMES: "oncall",
        MAILO_OPS_ADMIN_TOKEN_ONCALL: "x".repeat(40),
        MAILO_OPS_ADMIN_TOKEN_ONCALL_FILE: file,
      }),
    );

    expect(config.ops.admins[0]?.token.reveal()).toBe(ONCALL);
  });

  it.each([
    ["대문자", "OnCall"],
    ["숫자로 시작", "1oncall"],
    ["밑줄", "on_call"],
    ["33자", `a${"b".repeat(32)}`],
    ["빈 항목", "oncall,,deploy"],
  ])("이름 형식 위반(%s)은 기동을 거부하고 위치만 알린다", (_label, names) => {
    const message = issuesOf({
      MAILO_OPS_ADMIN_NAMES: names,
      MAILO_OPS_ADMIN_TOKEN_ONCALL: ONCALL,
      MAILO_OPS_ADMIN_TOKEN_DEPLOY: DEPLOY,
    });

    expect(message).toContain("MAILO_OPS_ADMIN_NAMES");
    expect(message).toMatch(/번째 이름/);
  });

  it("같은 이름이 두 번 있거나 9개 이상이면 거부한다", () => {
    expect(
      issuesOf({
        MAILO_OPS_ADMIN_NAMES: "oncall,oncall",
        MAILO_OPS_ADMIN_TOKEN_ONCALL: ONCALL,
      }),
    ).toContain("같은 이름");

    const names = Array.from({ length: 9 }, (_, i) => `a${i}`);
    const tokens = Object.fromEntries(
      names.map((n, i) => [
        `MAILO_OPS_ADMIN_TOKEN_${n.toUpperCase()}`,
        String(i).repeat(40),
      ]),
    );
    expect(
      issuesOf({ MAILO_OPS_ADMIN_NAMES: names.join(","), ...tokens }),
    ).toContain("8개까지");
  });

  it("이름 8개는 받는다", () => {
    const names = Array.from({ length: 8 }, (_, i) => `a${i}`);
    const tokens = Object.fromEntries(
      names.map((n, i) => [
        `MAILO_OPS_ADMIN_TOKEN_${n.toUpperCase()}`,
        String(i).repeat(40),
      ]),
    );

    expect(
      loadConfig(env({ MAILO_OPS_ADMIN_NAMES: names.join(","), ...tokens })).ops
        .admins,
    ).toHaveLength(8);
  });

  it("이름에 해당하는 토큰이 없으면 거부하고 변수 이름을 알린다", () => {
    const message = issuesOf({ MAILO_OPS_ADMIN_NAMES: "oncall" });

    expect(message).toContain("MAILO_OPS_ADMIN_TOKEN_ONCALL");
  });

  it("토큰이 32자 미만이거나 공백이 있으면 거부하고 값은 사유에 없다", () => {
    for (const bad of ["short", `${"t".repeat(20)} ${"t".repeat(20)}`]) {
      const message = issuesOf({
        MAILO_OPS_ADMIN_NAMES: "oncall",
        MAILO_OPS_ADMIN_TOKEN_ONCALL: bad,
      });
      expect(message).toContain("MAILO_OPS_ADMIN_TOKEN_ONCALL");
      expect(message).not.toContain(bad);
    }
  });

  it("관리 토큰끼리 또는 읽기 토큰과 같은 값이면 거부한다", () => {
    const sameAdmins = issuesOf({
      MAILO_OPS_ADMIN_NAMES: "oncall,deploy",
      MAILO_OPS_ADMIN_TOKEN_ONCALL: ONCALL,
      MAILO_OPS_ADMIN_TOKEN_DEPLOY: ONCALL,
    });
    const sameAsRead = issuesOf({
      MAILO_OPS_TOKEN: READ,
      MAILO_OPS_ADMIN_NAMES: "oncall",
      MAILO_OPS_ADMIN_TOKEN_ONCALL: READ,
    });

    expect(sameAdmins).toContain("같은 값");
    expect(sameAsRead).toContain("MAILO_OPS_ADMIN_TOKEN_ONCALL");
    expect(sameAsRead).not.toContain(READ);
  });

  it("이름 목록에 없는 이름의 토큰 변수는 무시한다", () => {
    const config = loadConfig(
      env({
        MAILO_OPS_ADMIN_NAMES: "oncall",
        MAILO_OPS_ADMIN_TOKEN_ONCALL: ONCALL,
        MAILO_OPS_ADMIN_TOKEN_OTHER: DEPLOY,
      }),
    );

    expect(config.ops.admins.map((a) => a.name)).toEqual(["oncall"]);
  });

  it("설정 객체를 찍거나 직렬화해도 토큰 값이 나오지 않는다", () => {
    const config = loadConfig(
      env({
        MAILO_OPS_TOKEN: READ,
        MAILO_OPS_ADMIN_NAMES: "oncall",
        MAILO_OPS_ADMIN_TOKEN_ONCALL: ONCALL,
      }),
    );

    for (const text of [inspect(config.ops), JSON.stringify(config.ops)]) {
      expect(text).not.toContain(READ);
      expect(text).not.toContain(ONCALL);
    }
  });
});
