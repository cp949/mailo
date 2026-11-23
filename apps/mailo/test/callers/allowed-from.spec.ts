import { describe, expect, it } from "@jest/globals";
import {
  CallerRegistryError,
  parseCallerRegistry,
} from "../../src/callers/index.js";
import { hashApiKey } from "../../src/crypto/index.js";
import { isSenderAllowed } from "../../src/validation/index.js";

// RQ-028·030, ADR-0008 구현 중 확정 12: 호출처별 발신 주소 허용 범위(allowedFrom).

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

describe("호출처 allowedFrom 설정 (RQ-028)", () => {
  it("생략하면 빈 목록이다", () => {
    expect(parse({}).callers[0]!.allowedFrom).toEqual([]);
  });

  it("주소 목록을 입력 표기 그대로 읽는다", () => {
    expect(
      parse({ allowedFrom: ["Billing@Example.com", "noreply@example.com"] })
        .callers[0]!.allowedFrom,
    ).toEqual(["Billing@Example.com", "noreply@example.com"]);
  });

  it.each([
    ["배열이 아님", "a@example.com"],
    ["문자열이 아닌 원소", [1]],
    ["주소 형식이 아님", ["not-an-address"]],
    ["표시 이름 포함", ["Billing <a@example.com>"]],
    ["줄바꿈 포함", ["a@example.com\n"]],
    ["21개 초과", Array.from({ length: 21 }, (_, i) => `a${i}@example.com`)],
  ])("올바르지 않은 값(%s)은 기동을 거부한다", (_name, value) => {
    expect(() => parse({ allowedFrom: value })).toThrow(CallerRegistryError);
  });
});

describe("isSenderAllowed", () => {
  const DEFAULT = "No-Reply@Example.com";

  it("from을 생략(null)하면 항상 허용한다", () => {
    expect(isSenderAllowed(null, DEFAULT, [])).toBe(true);
  });

  it("기본 발신 주소는 대소문자를 무시하고 허용한다", () => {
    expect(isSenderAllowed("no-reply@example.COM", DEFAULT, [])).toBe(true);
  });

  it("allowedFrom의 주소는 대소문자를 무시하고 허용한다", () => {
    expect(
      isSenderAllowed("billing@example.com", DEFAULT, ["Billing@Example.com"]),
    ).toBe(true);
  });

  it("그 밖의 주소(같은 도메인, 부분 일치 포함)는 거부한다", () => {
    expect(
      isSenderAllowed("ceo@example.com", DEFAULT, ["billing@example.com"]),
    ).toBe(false);
    expect(isSenderAllowed("xno-reply@example.com", DEFAULT, [])).toBe(false);
  });
});
