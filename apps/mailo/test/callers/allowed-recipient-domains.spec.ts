import { describe, expect, it } from "@jest/globals";
import {
  CallerRegistryError,
  parseCallerRegistry,
} from "../../src/callers/index.js";
import { hashApiKey } from "../../src/crypto/index.js";

// RQ-046, ADR-0011 결정 8: 호출처별 수신 도메인 허용 목록(allowedRecipientDomains)의 기동 검사.

function parse(extra: Record<string, unknown>) {
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
    { env: { NODE_ENV: "test" } },
  );
}

function issuesOf(extra: Record<string, unknown>): string {
  try {
    parse(extra);
  } catch (error) {
    if (error instanceof CallerRegistryError) return error.message;
    throw error;
  }
  throw new Error("기동이 거부돼야 한다");
}

describe("호출처 allowedRecipientDomains 설정 (RQ-046, ADR-0011 결정 8)", () => {
  it("생략하면 제한이 없다(null)", () => {
    expect(parse({}).callers[0]!.allowedRecipientDomains).toBeNull();
  });

  it("소문자 ASCII 도메인(A-label 포함) 목록을 그대로 읽는다", () => {
    expect(
      parse({
        allowedRecipientDomains: [
          "example.com",
          "mail.example.com",
          "xn--9n2bp8q.kr",
        ],
      }).callers[0]!.allowedRecipientDomains,
    ).toEqual(["example.com", "mail.example.com", "xn--9n2bp8q.kr"]);
  });

  it("1개와 50개는 허용한다", () => {
    expect(parse({ allowedRecipientDomains: ["example.com"] })).toBeDefined();
    const fifty = Array.from({ length: 50 }, (_, i) => `d${i}.example.com`);
    expect(
      parse({ allowedRecipientDomains: fifty }).callers[0]!
        .allowedRecipientDomains,
    ).toHaveLength(50);
  });

  it.each([
    ["빈 배열", []],
    ["51개", Array.from({ length: 51 }, (_, i) => `d${i}.example.com`)],
    ["null", null],
    ["배열이 아님", "example.com"],
    ["문자열이 아닌 원소", [1]],
    ["대문자 포함", ["Example.com"]],
    ["U-label", ["예시.kr"]],
    ["끝 점", ["example.com."]],
    ["와일드카드", ["*.example.com"]],
    ["선행 점", [".example.com"]],
    ["목록 안의 중복", ["example.com", "example.com"]],
    ["라벨이 하나", ["localhost"]],
    ["숫자뿐인 마지막 라벨", ["1.2.3.4"]],
    ["공백 포함", ["exa mple.com"]],
    ["주소 형태", ["a@example.com"]],
  ])("올바르지 않은 값(%s)은 기동을 거부한다", (_name, value) => {
    expect(() => parse({ allowedRecipientDomains: value })).toThrow(
      CallerRegistryError,
    );
  });

  it("오류 메시지에는 항목 위치와 고정 사유만 담고 값은 담지 않는다(RQ-027)", () => {
    const message = issuesOf({
      allowedRecipientDomains: ["ok.example.com", "CanaryUpper-c0de.test"],
    });
    expect(message).toContain("callers[0].allowedRecipientDomains[1]");
    expect(message).not.toContain("Canary");
    expect(message).not.toContain("ok.example.com");
    for (const bad of [
      "*.canary-c0de.test",
      "예시-canary.kr",
      "canary-c0de.test.",
    ]) {
      expect(issuesOf({ allowedRecipientDomains: [bad] })).not.toMatch(
        /canary/i,
      );
    }
    expect(
      issuesOf({
        allowedRecipientDomains: ["canary-c0de.test", "canary-c0de.test"],
      }),
    ).not.toMatch(/canary/i);
  });

  it("항목마다 사유를 구분해 알린다", () => {
    const reasons = (value: string) =>
      issuesOf({ allowedRecipientDomains: [value] });
    expect(reasons("Example.com")).toContain("대문자");
    expect(reasons("예시.kr")).toContain("ASCII");
    expect(reasons("example.com.")).toContain("끝 점");
    expect(reasons("*.example.com")).toContain("와일드카드");
    expect(reasons(".example.com")).toContain("선행 점");
    expect(
      issuesOf({ allowedRecipientDomains: ["a.example.com", "a.example.com"] }),
    ).toContain("중복");
  });
});
