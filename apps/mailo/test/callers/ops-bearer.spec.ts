import { describe, expect, it } from "@jest/globals";
import type { HttpRequest } from "../../src/http/index.js";
import {
  checkBearer,
  createOpsTokenMatcher,
  type CallerRegistry,
} from "../../src/callers/index.js";
import { Secret } from "../../src/config/index.js";

// 테스트용 가짜 값이다. 실제 시크릿이 아니다.
const READ = "r".repeat(40);
const ONCALL = "o".repeat(40);
const CALLER_KEY = "caller-fake-key-0000000000000000000000001";

const registry: CallerRegistry = {
  callers: [],
  authenticate: (key) => (key === CALLER_KEY ? "alpha" : undefined),
};

const matcher = createOpsTokenMatcher({
  token: new Secret(READ),
  admins: [{ name: "oncall", token: new Secret(ONCALL) }],
});

function reqWith(authorization?: string): HttpRequest {
  return { headers: { authorization } } as unknown as HttpRequest;
}

/** Bearer 판정(RQ-042, ADR-0011 결정 1). 읽기·관리 토큰, 호출처 키, 모르는 값을 구분한다. */
describe("Bearer 판정의 운영 토큰 권한 (RQ-042, ADR-0011 결정 1)", () => {
  it("읽기 토큰은 role read, 관리 토큰은 role admin과 이름이다", () => {
    expect(checkBearer(reqWith(`Bearer ${READ}`), registry, matcher)).toEqual({
      kind: "operator",
      role: "read",
    });
    expect(checkBearer(reqWith(`Bearer ${ONCALL}`), registry, matcher)).toEqual(
      { kind: "operator", role: "admin", name: "oncall" },
    );
  });

  it("호출처 키는 caller, 모르는 값은 invalid, 헤더가 없으면 absent다", () => {
    expect(
      checkBearer(reqWith(`Bearer ${CALLER_KEY}`), registry, matcher),
    ).toEqual({ kind: "caller", callerId: "alpha" });
    expect(checkBearer(reqWith("Bearer nope"), registry, matcher)).toEqual({
      kind: "invalid",
    });
    expect(checkBearer(reqWith(), registry, matcher)).toEqual({
      kind: "absent",
    });
  });

  it("판정기를 넘기지 않으면(업무 endpoint) 운영 토큰도 invalid다", () => {
    expect(checkBearer(reqWith(`Bearer ${READ}`), registry)).toEqual({
      kind: "invalid",
    });
    expect(checkBearer(reqWith(`Bearer ${ONCALL}`), registry)).toEqual({
      kind: "invalid",
    });
  });

  it("토큰이 없는 설정은 어떤 값도 운영자로 보지 않는다", () => {
    const none = createOpsTokenMatcher({ token: null, admins: [] });

    expect(none.match(READ)).toBeUndefined();
    expect(none.match("")).toBeUndefined();
  });
});
