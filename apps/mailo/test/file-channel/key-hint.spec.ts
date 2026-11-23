import { describe, expect, it } from "@jest/globals";
import { peekIdempotencyKey } from "../../src/file-channel/key-hint.js";
import { jwsSecret, signJws } from "../support/envelope.js";

// ADR-0006 결정 3 "파싱된 Key(가능한 경우)". 서명을 확인하지 못한 파일의 Key는 기록하지 않는다. RQ-002.

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const signed = (payload: unknown) =>
  bytes(signJws({ secret: jwsSecret(1), payload: JSON.stringify(payload) }));

describe("거부 기록용 Key 추출 (ADR-0006 결정 3)", () => {
  it("서명 none 호출처는 최상위 idempotencyKey를 쓴다", () => {
    expect(
      peekIdempotencyKey(
        bytes({ idempotencyKey: "k-1" }),
        "none",
        "VALIDATION_FAILED",
      ),
    ).toBe("k-1");
  });

  it("형식을 지키지 않는 Key와 문자열이 아닌 Key는 null이다", () => {
    for (const value of ["bad key", "", "x".repeat(129), 5, null, ["a"]]) {
      expect(
        peekIdempotencyKey(
          bytes({ idempotencyKey: value }),
          "none",
          "VALIDATION_FAILED",
        ),
      ).toBeNull();
    }
  });

  it("JSON이 아니거나 객체가 아니면 null이다", () => {
    expect(
      peekIdempotencyKey(Buffer.from("{broken"), "none", "MALFORMED"),
    ).toBeNull();
    expect(peekIdempotencyKey(bytes([1]), "none", "MALFORMED")).toBeNull();
    expect(
      peekIdempotencyKey(Buffer.from([0xff, 0xfe]), "none", "MALFORMED"),
    ).toBeNull();
  });

  it("서명 required 호출처는 서명 검증 뒤의 사유일 때만 payload 안의 Key를 쓴다", () => {
    const file = signed({ idempotencyKey: "k-2" });

    expect(peekIdempotencyKey(file, "required", "IAT_OUT_OF_RANGE")).toBe(
      "k-2",
    );
    expect(peekIdempotencyKey(file, "required", "VALIDATION_FAILED")).toBe(
      "k-2",
    );
    expect(peekIdempotencyKey(file, "required", "CALLER_MISMATCH")).toBe("k-2");
  });

  it("서명을 확인하지 못한 사유(MALFORMED, SIGNATURE_*)에서는 Key를 쓰지 않는다", () => {
    const file = signed({ idempotencyKey: "k-3" });

    for (const reason of [
      "MALFORMED",
      "SIGNATURE_REQUIRED",
      "SIGNATURE_INVALID",
    ] as const) {
      expect(peekIdempotencyKey(file, "required", reason)).toBeNull();
    }
  });

  it("서명 required 호출처의 payload가 JSON이 아니면 null이다", () => {
    const file = bytes(signJws({ secret: jwsSecret(1), payload: "not json" }));

    expect(
      peekIdempotencyKey(file, "required", "VALIDATION_FAILED"),
    ).toBeNull();
  });
});
