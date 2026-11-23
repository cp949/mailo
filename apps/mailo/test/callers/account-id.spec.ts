import { describe, expect, it } from "@jest/globals";
import {
  CallerRegistryError,
  parseCallerRegistry,
} from "../../src/callers/index.js";
import { hashApiKey } from "../../src/crypto/index.js";

// RQ-054, ADR-0013 결정 2: 호출처 레지스트리의 선택 필드 accountId.

function parse(extra: Record<string, unknown>, accountIds?: readonly string[]) {
  return parseCallerRegistry(
    {
      callers: [
        {
          id: "billing",
          apiKeyHashes: [
            hashApiKey("fake-key-billing-0000000000000000000000000"),
          ],
          signature: { mode: "none" },
          ...extra,
        },
      ],
    },
    {
      env: { NODE_ENV: "test" },
      ...(accountIds && { accountIds }),
    },
  );
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CallerRegistryError);
    return (error as CallerRegistryError).message;
  }
  throw new Error("레지스트리 오류가 나야 한다");
}

describe("호출처 accountId (RQ-054, ADR-0013 결정 2)", () => {
  it("생략하면 default 계정이다", () => {
    expect(parse({}, ["default", "marketing"]).callers[0]!.accountId).toBe(
      "default",
    );
  });

  it("구성한 계정 ID를 읽는다", () => {
    expect(
      parse({ accountId: "marketing" }, ["default", "marketing"]).callers[0]!
        .accountId,
    ).toBe("marketing");
  });

  it("계정 목록 없이 읽으면(단위 시험) 형식만 검사하고 존재는 검사하지 않는다", () => {
    expect(parse({ accountId: "anything" }).callers[0]!.accountId).toBe(
      "anything",
    );
  });

  it("구성에 없는 계정을 가리키면 기동을 거부하고 계정 목록을 오류에 싣지 않는다", () => {
    const message = messageOf(() =>
      parse({ accountId: "ghost" }, ["default", "marketing"]),
    );
    expect(message).toContain("callers[0].accountId");
    expect(message).not.toContain("marketing");
  });

  it("accountId를 생략했는데 default 계정이 구성에 없으면 거부한다", () => {
    expect(messageOf(() => parse({}, ["marketing"]))).toContain(
      "callers[0].accountId",
    );
    expect(
      parse({ accountId: "marketing" }, ["marketing"]).callers[0]!.accountId,
    ).toBe("marketing");
  });

  it.each([
    ["대문자", "Marketing"],
    ["예약어", "unregistered"],
    ["33자", "a".repeat(33)],
    ["문자열이 아님", 7],
    ["null", null],
    ["빈 문자열", ""],
  ])("형식이 올바르지 않은 값(%s)은 거부한다", (_name, value) => {
    expect(() => parse({ accountId: value }, ["default"])).toThrow(
      CallerRegistryError,
    );
    expect(() => parse({ accountId: value })).toThrow(CallerRegistryError);
  });
});
