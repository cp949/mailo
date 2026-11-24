import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// scripts/test-db.sh의 이름 규칙과 접속 URL 조립을 확인한다. DB에 접속하지 않는 하위 명령(url·name)과
// 접속 전에 거부되는 입력만 쓴다. 통합 테스트 database 분리 규칙은 docs/agents/verification.md의 "통합 테스트 동시 실행"이다.

const SCRIPT = fileURLToPath(
  new URL("../../../../scripts/test-db.sh", import.meta.url),
);
const BASE_URL = "postgres://mailo:canary-pw@127.0.0.1:5432/mailo";

function run(args: string[], url: string | null = BASE_URL) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MAILO_TEST_DATABASE_URL;
  if (url !== null) env.MAILO_TEST_DATABASE_URL = url;
  const result = spawnSync("bash", [SCRIPT, ...args], { env });
  return {
    status: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("통합 테스트 database 분리 스크립트(scripts/test-db.sh)", () => {
  it("url은 database 이름만 바꾸고 사용자·비밀번호·호스트·쿼리를 그대로 둔다", () => {
    const withQuery = run(
      ["url", "mailo_test_a1"],
      "postgres://u:pw@db.internal:6543/old?sslmode=require",
    );

    expect(withQuery.status).toBe(0);
    expect(withQuery.stdout.trim()).toBe(
      "postgres://u:pw@db.internal:6543/mailo_test_a1?sslmode=require",
    );
  });

  it("MAILO_TEST_DATABASE_URL이 없으면 compose 개발 값에서 이름만 바꾼다", () => {
    const result = run(["url", "mailo_test_a1"], null);

    expect(result.stdout.trim()).toBe(
      "postgres://mailo:mailo-dev-password@localhost:5432/mailo_test_a1",
    );
  });

  it("이름을 생략하면 접두사 mailo_test_와 소문자·숫자·밑줄로 만든 기본 이름을 쓴다", () => {
    const result = run(["name"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^mailo_test_[a-z0-9_]+$/);
    expect(result.stdout.trim().length).toBeLessThanOrEqual(63);
  });

  it.each([
    ["개발 DB 이름", "mailo"],
    ["접두사가 없는 이름", "other_db"],
    ["대문자", "mailo_test_Abc"],
    ["SQL 주입 문자", 'mailo_test_x";DROP DATABASE mailo;--'],
    ["63자 초과", `mailo_test_${"a".repeat(60)}`],
  ])("drop은 접속하기 전에 %s을 거부한다", (_label, name) => {
    // 서버가 없는 포트를 줘서 접속을 시도하면 다른 오류가 나게 한다. 거부 사유가 이름 검사여야 한다.
    const result = run(["drop", name], "postgres://u:pw@127.0.0.1:1/mailo");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("database 이름은 mailo_test_");
  });

  it("URL 형식이 맞지 않으면 거부한다", () => {
    const result = run(["url", "mailo_test_a1"], "not-a-url");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MAILO_TEST_DATABASE_URL 형식");
  });

  it("오류 출력에 비밀번호를 쓰지 않는다(RQ-027)", () => {
    const result = run(["drop", "mailo"]);

    expect(result.stderr).not.toContain("canary-pw");
    expect(result.stdout).not.toContain("canary-pw");
  });
});
