import { describe, expect, it } from "@jest/globals";
import {
  InvalidCursorError,
  decodeCursor,
  encodeCursor,
} from "../../src/events/cursor.js";

describe("이벤트 cursor(ADR-0006 결정 7)", () => {
  it("(txid, id)를 base64url로 왕복한다", () => {
    const raw = encodeCursor({ txid: "18446744073709551615", id: "42" });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(raw)).toEqual({
      txid: "18446744073709551615",
      id: "42",
    });
  });

  it.each(["", "not base64!", "YWJj", encodeCursor({ txid: "007", id: "1" })])(
    "형식이 맞지 않는 입력 %j는 거부한다",
    (raw) => {
      expect(() => decodeCursor(raw)).toThrow(InvalidCursorError);
    },
  );

  it.each([
    ["id가 bigint 최대값 + 1", { txid: "1", id: "9223372036854775808" }],
    ["txid가 xid8 최대값 + 1", { txid: "18446744073709551616", id: "1" }],
  ])("범위를 벗어난 cursor(%s)는 거부한다", (_name, cursor) => {
    expect(() => decodeCursor(encodeCursor(cursor))).toThrow(
      InvalidCursorError,
    );
  });

  it("범위 경계값(id 2^63-1, txid 2^64-1)은 허용한다", () => {
    const cursor = { txid: "18446744073709551615", id: "9223372036854775807" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("오류 메시지에 입력 원문을 넣지 않는다", () => {
    try {
      decodeCursor("canary-secret!");
    } catch (error) {
      expect(String(error)).not.toContain("canary-secret");
    }
  });
});
