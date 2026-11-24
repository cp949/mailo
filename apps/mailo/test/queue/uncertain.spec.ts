/**
 * 불명 판정 함수(RQ-048·074, ADR-0015 결정 5)의 단위 검증. DB 없이 `AttemptOutcome` 모양만 본다.
 * 읽기 SQL(`UNCERTAIN_ATTEMPT_SQL`)과 같은 조건이라는 확인은 `uncertain-outcome.integration-spec.ts`가 한다.
 */
import { describe, expect, it } from "@jest/globals";
import {
  isUncertainOutcome,
  type AttemptOutcome,
} from "../../src/queue/index.js";

const DATA_NO_RESPONSE: AttemptOutcome = {
  classification: "TRANSIENT",
  stage: "DATA",
};

describe("isUncertainOutcome: 불명 판정 단일 정의(RQ-048·074, ADR-0015 결정 5)", () => {
  it.each<[string, Parameters<typeof isUncertainOutcome>[0], boolean]>([
    ["LEASE_EXPIRED", { classification: "LEASE_EXPIRED" }, true],
    ["DATA 단계 응답 없는 TRANSIENT", DATA_NO_RESPONSE, true],
    [
      "DATA 단계라도 응답 코드가 있는 TRANSIENT",
      { classification: "TRANSIENT", stage: "DATA", responseCode: 451 },
      false,
    ],
    [
      "DATA 이전 단계의 응답 없는 TRANSIENT",
      { classification: "TRANSIENT", stage: "CONN" },
      false,
    ],
    [
      "단계 정보가 없는 TRANSIENT",
      { classification: "TRANSIENT" } as AttemptOutcome,
      false,
    ],
    [
      "DATA 단계 PERMANENT",
      { classification: "PERMANENT", stage: "DATA", responseCode: 550 },
      false,
    ],
    [
      "내부 오류 TRANSIENT",
      { classification: "TRANSIENT", internal: true, stage: "WORKER" },
      false,
    ],
    [
      "계정 상태 오류",
      {
        classification: "ACCOUNT",
        reason: "OTHER",
        afterMailFrom: false,
        stage: "DATA",
      },
      false,
    ],
    ["SENT", { classification: "SENT", stage: "DATA" }, false],
  ])("%s는 %s", (_name, outcome, expected) => {
    expect(isUncertainOutcome(outcome)).toBe(expected);
  });
});
