import { describe, expect, it } from "@jest/globals";
import {
  accountSlotCap,
  claimLimit,
  rotateFrom,
} from "../../src/worker/slots.js";

/** Worker의 슬롯 배분 순수 함수(RQ-055, ADR-0013 결정 3 바). */
describe("슬롯 배분: 계정별 상한 cap_a (RQ-055, ADR-0013 결정 3 바)", () => {
  it.each([
    // [전체 C, 계정 수 N, 기대 cap_a = max(1, C - (N - 1))]
    [4, 1, 4],
    [4, 2, 3],
    [4, 3, 2],
    [4, 4, 1],
    [10, 5, 6],
    [1, 1, 1],
  ])("C=%i, N=%i이면 기본 상한은 %i다", (total, count, expected) => {
    expect(accountSlotCap({ concurrency: null }, total, count)).toBe(expected);
  });

  it("계정의 concurrency가 있으면 그 값을 쓴다", () => {
    expect(accountSlotCap({ concurrency: 2 }, 8, 2)).toBe(2);
    expect(accountSlotCap({ concurrency: 8 }, 8, 3)).toBe(8);
  });

  it("N이 C보다 크면 기본식 값은 1로 내려가지 않고 1이다(기동 검사가 N > C를 먼저 거부한다)", () => {
    expect(accountSlotCap({ concurrency: null }, 2, 5)).toBe(1);
  });
});

describe("슬롯 배분: 점유 호출의 limit (ADR-0013 결정 3 바)", () => {
  it("limit은 min(cap - 진행 중, 남은 전체 슬롯)이다", () => {
    expect(claimLimit({ cap: 3, inFlight: 0, remaining: 4 })).toBe(3);
    expect(claimLimit({ cap: 3, inFlight: 2, remaining: 4 })).toBe(1);
    expect(claimLimit({ cap: 3, inFlight: 0, remaining: 2 })).toBe(2);
  });

  it("cap에 닿았거나 남은 슬롯이 없으면 0이다(호출하지 않는다)", () => {
    expect(claimLimit({ cap: 3, inFlight: 3, remaining: 4 })).toBe(0);
    expect(claimLimit({ cap: 3, inFlight: 5, remaining: 4 })).toBe(0);
    expect(claimLimit({ cap: 3, inFlight: 0, remaining: 0 })).toBe(0);
  });

  it("C=4, N=2 기본 상한 3: 한 계정이 3슬롯을 쥐어도 다른 계정은 1슬롯을 받는다", () => {
    const cap = accountSlotCap({ concurrency: null }, 4, 2);
    // A가 3개를 점유 중이고 전체 남은 슬롯은 1이다.
    expect(claimLimit({ cap, inFlight: 0, remaining: 1 })).toBe(1);
    expect(claimLimit({ cap, inFlight: 3, remaining: 1 })).toBe(0);
  });
});

describe("슬롯 배분: 라운드 순서 회전", () => {
  it("시작점부터 한 바퀴를 돈다", () => {
    expect(rotateFrom(["a", "b", "c"], 0)).toEqual(["a", "b", "c"]);
    expect(rotateFrom(["a", "b", "c"], 1)).toEqual(["b", "c", "a"]);
    expect(rotateFrom(["a", "b", "c"], 2)).toEqual(["c", "a", "b"]);
  });

  it("시작점이 길이를 넘으면 나머지로 돌린다", () => {
    expect(rotateFrom(["a", "b"], 5)).toEqual(["b", "a"]);
  });

  it("빈 목록과 한 계정은 그대로다", () => {
    expect(rotateFrom([], 3)).toEqual([]);
    expect(rotateFrom(["a"], 7)).toEqual(["a"]);
  });

  it("원본 배열을 바꾸지 않는다", () => {
    const ids = ["a", "b", "c"];
    rotateFrom(ids, 2);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});
