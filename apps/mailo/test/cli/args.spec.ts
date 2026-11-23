import { describe, expect, it } from "@jest/globals";
import { isCallerId } from "../../src/callers/index.js";
import { parseCliArgs } from "../../src/cli/index.js";

// RQ-047, ADR-0011 결정 7: 운영 CLI의 인자 해석. 토큰은 인자로 받지 않고, 변경 명령은 --yes가 필요하다.

const JOB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function usageMessage(argv: string[]): string {
  const result = parseCliArgs(argv);
  if (result.kind !== "usage-error") throw new Error("사용법 오류여야 한다");
  return result.message;
}

describe("읽기 명령 (결정 7)", () => {
  it("status, queue stats, jobs show, audit list를 해석한다", () => {
    expect(parseCliArgs(["status"])).toEqual({
      kind: "command",
      command: { name: "status" },
    });
    expect(parseCliArgs(["queue", "stats"])).toEqual({
      kind: "command",
      command: { name: "queue-stats" },
    });
    expect(parseCliArgs(["jobs", "show", JOB.toUpperCase()])).toEqual({
      kind: "command",
      command: { name: "jobs-show", jobId: JOB },
    });
    expect(parseCliArgs(["audit", "list"])).toEqual({
      kind: "command",
      command: { name: "audit-list", limit: null, before: null },
    });
  });

  it("audit list의 --limit·--before를 검사한다(= 형식도 받는다)", () => {
    expect(
      parseCliArgs(["audit", "list", "--limit", "20", "--before=900"]),
    ).toEqual({
      kind: "command",
      command: { name: "audit-list", limit: 20, before: "900" },
    });
    for (const bad of [
      ["--limit", "0"],
      ["--limit", "201"],
      ["--limit", "abc"],
      ["--before", "0"],
      ["--before", "-1"],
      ["--before", "9223372036854775808"],
      ["--limit"],
    ])
      expect(parseCliArgs(["audit", "list", ...bad]).kind).toBe("usage-error");
  });

  it("jobs show의 작업 ID가 UUID가 아니면 사용법 오류다", () => {
    expect(parseCliArgs(["jobs", "show", "not-a-uuid"]).kind).toBe(
      "usage-error",
    );
    expect(parseCliArgs(["jobs", "show"]).kind).toBe("usage-error");
    expect(parseCliArgs(["jobs", "show", JOB, "extra"]).kind).toBe(
      "usage-error",
    );
  });
});

describe("변경 명령은 --yes가 있어야 한다 (결정 7)", () => {
  const cases: Array<[string, string[]]> = [
    ["pause --all", ["pause", "--all"]],
    ["pause --caller", ["pause", "--caller", "billing"]],
    ["resume --all", ["resume", "--all"]],
    ["resume --caller", ["resume", "--caller", "billing"]],
    ["jobs cancel", ["jobs", "cancel", JOB]],
  ];

  it.each(cases)("%s: --yes 없이는 사용법 오류다", (_name, argv) => {
    expect(usageMessage(argv)).toContain("--yes");
  });

  it("--yes가 있으면 명령으로 해석한다", () => {
    expect(parseCliArgs(["pause", "--all", "--yes"])).toEqual({
      kind: "command",
      command: { name: "pause", scope: { type: "all" } },
    });
    expect(parseCliArgs(["--yes", "resume", "--caller", "billing"])).toEqual({
      kind: "command",
      command: { name: "resume", scope: { type: "caller", id: "billing" } },
    });
    expect(parseCliArgs(["jobs", "cancel", JOB, "--yes"])).toEqual({
      kind: "command",
      command: { name: "jobs-cancel", jobId: JOB },
    });
  });

  it("pause·resume은 범위를 하나만 명시해야 한다(기본 전체 정지 없음)", () => {
    for (const argv of [
      ["pause", "--yes"],
      ["pause", "--all", "--caller", "billing", "--yes"],
      ["resume", "--yes"],
      ["pause", "--caller", "--yes"],
    ])
      expect(parseCliArgs(argv).kind).toBe("usage-error");
  });

  it("호출처 ID 형식은 서버의 레지스트리 ID 형식과 같다", () => {
    for (const id of [
      "billing",
      "A1",
      "a_b-c",
      "x".repeat(64),
      "x".repeat(65),
      "-a",
      "a b",
      "",
      "a/b",
      "한글",
    ]) {
      const parsed = parseCliArgs(["pause", "--caller", id, "--yes"]);
      expect(parsed.kind === "command").toBe(isCallerId(id));
    }
  });

  it("읽기 명령에 --yes를 붙여도 거부한다(의도하지 않은 인자)", () => {
    expect(parseCliArgs(["status", "--yes"]).kind).toBe("usage-error");
  });
});

describe("토큰과 알 수 없는 인자 (결정 7, RQ-027)", () => {
  it.each([
    ["--token", "x"],
    ["--token=x"],
    ["--token-file", "/x"],
    ["--password", "x"],
  ])("토큰 인자 %s는 받지 않고 이유를 알린다", (...args) => {
    const message = usageMessage(["status", ...args]);
    expect(message).toContain("MAILO_CLI_TOKEN_FILE");
  });

  it("알 수 없는 명령·옵션·여분의 인자는 사용법 오류다", () => {
    for (const argv of [
      [],
      ["unknown"],
      ["queue"],
      ["queue", "stats", "extra"],
      ["status", "--verbose"],
      ["audit"],
      ["audit", "list", "x"],
    ])
      expect(parseCliArgs(argv).kind).toBe("usage-error");
  });

  it("오류 메시지에 입력 값을 되풀이하지 않는다", () => {
    // 호출처 ID 형식에 맞지 않는 값이어야 pause --caller 항목이 오류가 된다.
    const secret = "canary.secret.3f9a";
    for (const argv of [
      ["--token", secret],
      [`--token=${secret}`],
      ["jobs", "show", secret],
      ["pause", "--caller", secret, "--yes"],
      [secret],
    ])
      expect(usageMessage(argv)).not.toContain(secret);
  });

  it("--help·-h는 도움말이다", () => {
    expect(parseCliArgs(["--help"]).kind).toBe("help");
    expect(parseCliArgs(["status", "-h"]).kind).toBe("help");
  });
});
