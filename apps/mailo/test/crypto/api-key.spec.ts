import { describe, expect, it } from "@jest/globals";
import {
  hashApiKey,
  verifyApiKey,
  verifyApiKeyAgainstAny,
} from "../../src/crypto/api-key.js";

const KEY = "mk_test_" + "a1".repeat(32);

describe("API 키 해시와 비교 (RQ-028)", () => {
  it("SHA-256 hex 64자를 만들고 평문을 포함하지 않는다", () => {
    const h = hashApiKey(KEY);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(KEY);
  });

  it("알려진 SHA-256 값과 일치한다", () => {
    expect(hashApiKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("맞는 키만 통과한다", () => {
    const h = hashApiKey(KEY);
    expect(verifyApiKey(KEY, h)).toBe(true);
    expect(verifyApiKey(KEY + "x", h)).toBe(false);
    expect(verifyApiKey("", h)).toBe(false);
  });

  it("저장 해시 형식이 잘못되면 항상 false다", () => {
    expect(verifyApiKey(KEY, "not-hex")).toBe(false);
    expect(verifyApiKey(KEY, "")).toBe(false);
    expect(verifyApiKey(KEY, "0".repeat(64))).toBe(false);
  });

  it("호출처당 키 2개 중 어느 쪽이든 통과한다", () => {
    const hashes = [hashApiKey("old-key"), hashApiKey("new-key")];
    expect(verifyApiKeyAgainstAny("old-key", hashes)).toBe(true);
    expect(verifyApiKeyAgainstAny("new-key", hashes)).toBe(true);
    expect(verifyApiKeyAgainstAny("third", hashes)).toBe(false);
    expect(verifyApiKeyAgainstAny("old-key", [])).toBe(false);
  });
});
