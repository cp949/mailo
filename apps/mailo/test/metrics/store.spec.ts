import { describe, expect, it, jest } from "@jest/globals";
import {
  UNREGISTERED_CALLER,
  createMetrics,
  noopMetrics,
} from "../../src/metrics/index.js";

function samplesOf(
  metrics: ReturnType<typeof createMetrics>,
  name: string,
): Array<{ labels: Record<string, string>; value: number }> {
  return metrics
    .counterSamples()
    .filter((s) => s.name === name)
    .map((s) => ({ labels: s.labels, value: s.value }));
}

describe("counter 저장소(RQ-049, ADR-0012 결정 6)", () => {
  it("같은 라벨 조합의 증가를 합친다", () => {
    const metrics = createMetrics({ callerIds: ["alpha"] });

    metrics.inc("mailo_claimed_jobs_total", { caller_id: "alpha" });
    metrics.inc("mailo_claimed_jobs_total", { caller_id: "alpha" }, 2);

    expect(samplesOf(metrics, "mailo_claimed_jobs_total")).toEqual([
      { labels: { caller_id: "alpha", account_id: "default" }, value: 3 },
    ]);
  });

  it("account_id를 생략하면 default다", () => {
    const metrics = createMetrics({ callerIds: ["alpha"] });

    metrics.inc("mailo_lease_recovered_total");

    expect(samplesOf(metrics, "mailo_lease_recovered_total")).toEqual([
      { labels: { account_id: "default" }, value: 1 },
    ]);
  });

  it("레지스트리에 없거나 형식이 틀린 caller_id는 unregistered 하나로 모은다", () => {
    const metrics = createMetrics({ callerIds: ["alpha"] });

    metrics.inc("mailo_claimed_jobs_total", { caller_id: "removed-caller" });
    metrics.inc("mailo_claimed_jobs_total", { caller_id: "fake-1" });
    metrics.inc("mailo_claimed_jobs_total", { caller_id: 'bad"id\n' });
    metrics.inc("mailo_claimed_jobs_total", { caller_id: "" });

    expect(samplesOf(metrics, "mailo_claimed_jobs_total")).toEqual([
      {
        labels: { caller_id: UNREGISTERED_CALLER, account_id: "default" },
        value: 4,
      },
    ]);
  });

  it("값이 닫힌 열거에 없으면 fallback으로 센다(stage는 unknown, reason은 other)", () => {
    const metrics = createMetrics({ callerIds: [] });

    metrics.inc("mailo_attempt_errors_total", {
      result: "transient",
      stage: "SOMETHING-NEW",
      reason: "weird",
    });

    expect(samplesOf(metrics, "mailo_attempt_errors_total")).toEqual([
      {
        labels: {
          account_id: "default",
          result: "transient",
          stage: "unknown",
          reason: "other",
        },
        value: 1,
      },
    ]);
  });

  it("fallback이 없는 열거 라벨에 모르는 값이 오면 버리고 dropped_samples를 올린다", () => {
    const metrics = createMetrics({ callerIds: [] });

    metrics.inc("mailo_claim_polls_total", { result: "weird" });

    expect(samplesOf(metrics, "mailo_claim_polls_total")).toEqual([]);
    expect(samplesOf(metrics, "mailo_metrics_dropped_samples_total")).toEqual([
      { labels: {}, value: 1 },
    ]);
  });

  it("카탈로그에 없는 라벨 이름이나 빠진 필수 라벨은 버린다", () => {
    const metrics = createMetrics({ callerIds: ["alpha"] });

    metrics.inc("mailo_claim_polls_total", { result: "claimed", extra: "x" });
    metrics.inc("mailo_claim_polls_total", {});

    expect(samplesOf(metrics, "mailo_claim_polls_total")).toEqual([]);
    expect(
      samplesOf(metrics, "mailo_metrics_dropped_samples_total")[0]?.value,
    ).toBe(2);
  });

  it("증가량이 양의 정수가 아니면 무시한다", () => {
    const metrics = createMetrics({ callerIds: [] });

    metrics.inc("mailo_lease_recovered_total", {}, 0);
    metrics.inc("mailo_lease_recovered_total", {}, -1);
    metrics.inc("mailo_lease_recovered_total", {}, Number.NaN);
    metrics.inc("mailo_lease_recovered_total", {}, 1.5);

    expect(samplesOf(metrics, "mailo_lease_recovered_total")).toEqual([]);
  });

  it("dropped_samples는 처음부터 0으로 나온다", () => {
    const metrics = createMetrics({ callerIds: [] });

    expect(samplesOf(metrics, "mailo_metrics_dropped_samples_total")).toEqual([
      { labels: {}, value: 0 },
    ]);
  });

  it("지표 하나의 시리즈가 상한에 닿으면 새 시리즈를 만들지 않고 dropped_samples를 올린다", () => {
    const onSeriesLimit = jest.fn<(name: string) => void>();
    const ids = Array.from({ length: 5 }, (_, i) => `c${i}`);
    const metrics = createMetrics({
      callerIds: ids,
      maxSeriesPerMetric: 3,
      onSeriesLimit,
    });

    for (const id of ids)
      metrics.inc("mailo_claimed_jobs_total", { caller_id: id });
    // 이미 있는 시리즈는 상한 뒤에도 늘어난다.
    metrics.inc("mailo_claimed_jobs_total", { caller_id: "c0" });

    const claimed = samplesOf(metrics, "mailo_claimed_jobs_total");
    expect(claimed).toHaveLength(3);
    expect(claimed.find((s) => s.labels["caller_id"] === "c0")?.value).toBe(2);
    expect(
      samplesOf(metrics, "mailo_metrics_dropped_samples_total")[0]?.value,
    ).toBe(2);
    // 지표 이름만 한 번 알린다.
    expect(onSeriesLimit).toHaveBeenCalledTimes(1);
    expect(onSeriesLimit).toHaveBeenCalledWith("mailo_claimed_jobs_total");
  });

  it("기본 시리즈 상한은 지표당 2000개다", () => {
    const ids = Array.from({ length: 2100 }, (_, i) => `c${i}`);
    const metrics = createMetrics({ callerIds: ids });

    for (const id of ids)
      metrics.inc("mailo_claimed_jobs_total", { caller_id: id });

    expect(samplesOf(metrics, "mailo_claimed_jobs_total")).toHaveLength(2000);
    expect(
      samplesOf(metrics, "mailo_metrics_dropped_samples_total")[0]?.value,
    ).toBe(100);
  });

  it("noopMetrics는 아무것도 기록하지 않고 던지지 않는다", () => {
    expect(() =>
      noopMetrics.inc("mailo_claimed_jobs_total", { caller_id: "alpha" }),
    ).not.toThrow();
  });

  it("gauge 이름에 inc를 부르면 버린다(타입 밖 호출 방어)", () => {
    const metrics = createMetrics({ callerIds: [] });

    (metrics.inc as (n: string, l?: Record<string, string>) => void)(
      "mailo_send_paused_all",
    );

    expect(metrics.counterSamples().map((s) => s.name)).toEqual([
      "mailo_metrics_dropped_samples_total",
    ]);
    expect(
      samplesOf(metrics, "mailo_metrics_dropped_samples_total")[0]?.value,
    ).toBe(1);
  });
});
