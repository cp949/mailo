import { describe, expect, it } from "@jest/globals";
import {
  CallerRegistryError,
  parseCallerRegistry,
} from "../../src/callers/index.js";
import { hashApiKey } from "../../src/crypto/index.js";

const KEY = "fake-key-quota-1-00000000000000000000000000";

function parse(extra: Record<string, unknown>) {
  return parseCallerRegistry({
    callers: [
      {
        id: "billing",
        apiKeyHashes: [hashApiKey(KEY)],
        signature: { mode: "none" },
        ...extra,
      },
    ],
  });
}

describe("호출처 레지스트리: 24시간 발송 할당 sendQuota24h (RQ-032)", () => {
  it("생략하거나 null이면 무제한이다(기본값)", () => {
    expect(parse({}).callers[0]!.sendQuota24h).toBeNull();
    expect(parse({ sendQuota24h: null }).callers[0]!.sendQuota24h).toBeNull();
  });

  it("양의 정수를 그대로 읽는다", () => {
    expect(parse({ sendQuota24h: 500 }).callers[0]!.sendQuota24h).toBe(500);
  });

  it.each([0, -1, 1.5, "10", true, 10_000_001])(
    "허용하지 않는 값 %p는 거부한다",
    (value) => {
      expect(() => parse({ sendQuota24h: value })).toThrow(CallerRegistryError);
    },
  );
});
