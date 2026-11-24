import { describe, expect, it } from "@jest/globals";
import { createMetrics } from "../../src/metrics/index.js";
import type { AttemptOutcome } from "../../src/queue/index.js";
import {
  attemptResultLabel,
  countAttempt,
  countRecovered,
  countSwept,
} from "../../src/worker/metrics.js";

/** Worker가 올리는 counter 라벨 규칙(RQ-049, ADR-0012 결정 4). 라벨은 닫힌 값만 만든다. */
function metricsFor() {
  const metrics = createMetrics({ callerIds: ["alpha"] });
  const series = (name: string) =>
    metrics
      .counterSamples()
      // 미리 낸 0 시리즈(ADR-0012 구현 중 확정 15)는 뺀다. 이 시험은 증가한 시리즈만 본다.
      .filter((s) => s.name === name && s.value > 0)
      .map((s) => [s.labels, s.value] as const);
  return { metrics, series };
}

describe("Worker counter 라벨(RQ-049, ADR-0012 결정 4)", () => {
  it.each<[string, AttemptOutcome, string]>([
    ["SENT", { classification: "SENT" }, "sent"],
    ["TRANSIENT", { classification: "TRANSIENT" }, "transient"],
    ["PERMANENT", { classification: "PERMANENT" }, "permanent"],
    [
      "ACCOUNT",
      { classification: "ACCOUNT", reason: "AUTH", afterMailFrom: false },
      "account",
    ],
    [
      "내부 TRANSIENT",
      { classification: "TRANSIENT", internal: true },
      "internal",
    ],
    [
      "내부 PERMANENT",
      { classification: "PERMANENT", internal: true },
      "internal",
    ],
  ])("%s 결과의 result 라벨은 %s다", (_name, outcome, expected) => {
    expect(attemptResultLabel(outcome)).toBe(expected);
  });

  it("성공은 attempts와 종결만 올리고 attempt_errors는 올리지 않는다", () => {
    const { metrics, series } = metricsFor();

    countAttempt(
      metrics,
      { callerId: "alpha", accountId: "default" },
      { classification: "SENT" },
      "SENT",
    );

    expect(series("mailo_attempts_total")).toHaveLength(1);
    expect(series("mailo_jobs_finished_total")[0]![0]).toMatchObject({
      status: "sent",
    });
    expect(series("mailo_attempt_errors_total")).toEqual([]);
  });

  it("재시도 대기로 가는 실패는 종결을 올리지 않는다", () => {
    const { metrics, series } = metricsFor();

    countAttempt(
      metrics,
      { callerId: "alpha", accountId: "default" },
      { classification: "TRANSIENT", stage: "DATA" },
      "RETRY_WAIT",
    );

    expect(series("mailo_jobs_finished_total")).toEqual([]);
    expect(series("mailo_attempt_errors_total")[0]![0]).toMatchObject({
      result: "transient",
      stage: "data",
      reason: "none",
    });
  });

  it("계정 오류는 사유를 reason으로 센다(응답 코드·텍스트는 쓰지 않는다)", () => {
    const { metrics, series } = metricsFor();

    countAttempt(
      metrics,
      { callerId: "alpha", accountId: "default" },
      {
        classification: "ACCOUNT",
        reason: "RATE_LIMIT",
        afterMailFrom: false,
        stage: "MAIL_FROM",
        responseCode: 421,
        responseText: "4.7.0 CANARY-TEXT rate limited",
      },
      "RETRY_WAIT",
    );

    const [labels] = series("mailo_attempt_errors_total")[0]!;
    expect(labels).toEqual({
      account_id: "default",
      result: "account",
      stage: "mail_from",
      reason: "rate_limit",
    });
    expect(JSON.stringify(metrics.counterSamples())).not.toContain("CANARY");
  });

  it("모르는 stage는 unknown, 없는 stage도 unknown으로 센다", () => {
    const { metrics, series } = metricsFor();

    countAttempt(
      metrics,
      { callerId: "alpha", accountId: "default" },
      { classification: "PERMANENT", stage: "NEW_STAGE" },
      "FAILED",
    );
    countAttempt(
      metrics,
      { callerId: "alpha", accountId: "default" },
      { classification: "PERMANENT" },
      "FAILED",
    );

    expect(series("mailo_attempt_errors_total")).toEqual([
      [
        {
          account_id: "default",
          result: "permanent",
          stage: "unknown",
          reason: "none",
        },
        2,
      ],
    ]);
  });

  it("sweep은 종결 전이를 호출처별로 센다", () => {
    const { metrics, series } = metricsFor();

    countSwept(metrics, [
      { callerId: "alpha", accountId: "default", status: "EXPIRED" },
      { callerId: "alpha", accountId: "default", status: "EXPIRED" },
      { callerId: "gone", accountId: "default", status: "EXPIRED" },
    ]);

    expect(series("mailo_jobs_finished_total")).toEqual([
      [{ caller_id: "alpha", account_id: "default", status: "expired" }, 2],
      [
        { caller_id: "unregistered", account_id: "default", status: "expired" },
        1,
      ],
    ]);
  });

  describe("결과 불명 종결 counter(RQ-074, ADR-0015 결정 10)", () => {
    it("OUTCOME_UNKNOWN 종결은 failed 종결과 함께 outcome_unknown을 센다", () => {
      const { metrics, series } = metricsFor();

      countAttempt(
        metrics,
        { callerId: "alpha", accountId: "default" },
        { classification: "TRANSIENT", stage: "DATA" },
        "FAILED",
        true,
      );

      expect(series("mailo_jobs_outcome_unknown_total")).toEqual([
        [{ caller_id: "alpha", account_id: "default" }, 1],
      ]);
      expect(series("mailo_jobs_finished_total")).toEqual([
        [{ caller_id: "alpha", account_id: "default", status: "failed" }, 1],
      ]);
    });

    it("다른 사유의 failed 종결과 재시도 대기는 outcome_unknown을 올리지 않는다", () => {
      const { metrics, series } = metricsFor();
      const job = { callerId: "alpha", accountId: "default" };

      countAttempt(
        metrics,
        job,
        { classification: "PERMANENT", stage: "DATA", responseCode: 550 },
        "FAILED",
      );
      countAttempt(
        metrics,
        job,
        { classification: "TRANSIENT", stage: "DATA" },
        "RETRY_WAIT",
      );

      expect(series("mailo_jobs_outcome_unknown_total")).toEqual([]);
    });

    it("레지스트리에 없는 호출처는 unregistered로 센다", () => {
      const { metrics, series } = metricsFor();

      countAttempt(
        metrics,
        { callerId: "gone", accountId: "default" },
        { classification: "TRANSIENT", stage: "DATA" },
        "FAILED",
        true,
      );

      expect(series("mailo_jobs_outcome_unknown_total")).toEqual([
        [{ caller_id: "unregistered", account_id: "default" }, 1],
      ]);
    });

    it("lease 회수가 OUTCOME_UNKNOWN으로 종결한 전이도 센다", () => {
      const { metrics, series } = metricsFor();

      countRecovered(metrics, [
        {
          callerId: "alpha",
          accountId: "default",
          status: "FAILED",
          outcomeUnknown: true,
        },
        { callerId: "alpha", accountId: "default", status: "RETRY_WAIT" },
        { callerId: "alpha", accountId: "default", status: "FAILED" },
      ]);

      expect(series("mailo_lease_recovered_total")).toEqual([
        [{ account_id: "default" }, 3],
      ]);
      expect(series("mailo_jobs_finished_total")).toEqual([
        [{ caller_id: "alpha", account_id: "default", status: "failed" }, 2],
      ]);
      expect(series("mailo_jobs_outcome_unknown_total")).toEqual([
        [{ caller_id: "alpha", account_id: "default" }, 1],
      ]);
    });
  });

  it("lease 회수는 회수 수를 세고 종결로 끝난 것만 종결로 센다", () => {
    const { metrics, series } = metricsFor();

    countRecovered(metrics, [
      { callerId: "alpha", accountId: "default", status: "RETRY_WAIT" },
      { callerId: "alpha", accountId: "default", status: "FAILED" },
    ]);

    expect(series("mailo_lease_recovered_total")).toEqual([
      [{ account_id: "default" }, 2],
    ]);
    expect(series("mailo_jobs_finished_total")).toEqual([
      [{ caller_id: "alpha", account_id: "default", status: "failed" }, 1],
    ]);
  });

  describe("account_id 라벨은 작업의 계정이다 (RQ-062, ADR-0013 결정 5)", () => {
    function multi() {
      const metrics = createMetrics({
        callerIds: ["alpha", "beta"],
        accountIds: ["default", "marketing"],
      });
      const series = (name: string) =>
        metrics
          .counterSamples()
          .filter((s) => s.name === name && s.value > 0)
          .map((s) => [s.labels, s.value] as const);
      return { metrics, series };
    }

    it("시도·실패 분류·종결이 작업의 계정으로 센다", () => {
      const { metrics, series } = multi();

      countAttempt(
        metrics,
        { callerId: "beta", accountId: "marketing" },
        { classification: "SENT" },
        "SENT",
      );
      countAttempt(
        metrics,
        { callerId: "alpha", accountId: "default" },
        { classification: "PERMANENT", stage: "RCPT" },
        "FAILED",
      );

      expect(series("mailo_attempts_total")).toEqual(
        expect.arrayContaining([
          [{ caller_id: "beta", account_id: "marketing", result: "sent" }, 1],
          [
            { caller_id: "alpha", account_id: "default", result: "permanent" },
            1,
          ],
        ]),
      );
      expect(series("mailo_attempt_errors_total")).toEqual([
        [
          {
            account_id: "default",
            result: "permanent",
            stage: "rcpt",
            reason: "none",
          },
          1,
        ],
      ]);
      expect(series("mailo_jobs_finished_total")).toEqual(
        expect.arrayContaining([
          [{ caller_id: "beta", account_id: "marketing", status: "sent" }, 1],
        ]),
      );
    });

    it("구성 밖 계정의 sweep 종결과 lease 회수는 unregistered로 센다", () => {
      const { metrics, series } = multi();

      countSwept(metrics, [
        { callerId: "beta", accountId: "retired", status: "EXPIRED" },
      ]);
      countRecovered(metrics, [
        { callerId: "beta", accountId: "marketing", status: "RETRY_WAIT" },
        { callerId: "beta", accountId: "retired", status: "FAILED" },
      ]);

      expect(series("mailo_jobs_finished_total")).toEqual([
        [
          { caller_id: "beta", account_id: "unregistered", status: "expired" },
          1,
        ],
        [
          { caller_id: "beta", account_id: "unregistered", status: "failed" },
          1,
        ],
      ]);
      expect(series("mailo_lease_recovered_total")).toEqual([
        [{ account_id: "marketing" }, 1],
        [{ account_id: "unregistered" }, 1],
      ]);
    });
  });
});
