import { describe, expect, it, jest } from "@jest/globals";
import {
  UNREGISTERED_ACCOUNT,
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

/** 증가한 시리즈만. 미리 낸 0 시리즈는 뺀다. */
function incremented(
  metrics: ReturnType<typeof createMetrics>,
  name: string,
): ReturnType<typeof samplesOf> {
  return samplesOf(metrics, name).filter((s) => s.value > 0);
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

    expect(incremented(metrics, "mailo_claimed_jobs_total")).toEqual([
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

    expect(incremented(metrics, "mailo_claim_polls_total")).toEqual([]);
    expect(samplesOf(metrics, "mailo_metrics_dropped_samples_total")).toEqual([
      { labels: {}, value: 1 },
    ]);
  });

  it("카탈로그에 없는 라벨 이름이나 빠진 필수 라벨은 버린다", () => {
    const metrics = createMetrics({ callerIds: ["alpha"] });

    metrics.inc("mailo_claim_polls_total", { result: "claimed", extra: "x" });
    metrics.inc("mailo_claim_polls_total", {});

    expect(incremented(metrics, "mailo_claim_polls_total")).toEqual([]);
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

    expect(incremented(metrics, "mailo_lease_recovered_total")).toEqual([]);
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

    expect(metrics.counterSamples().filter((s) => s.value > 0)).toEqual([
      { name: "mailo_metrics_dropped_samples_total", labels: {}, value: 1 },
    ]);
    expect(
      samplesOf(metrics, "mailo_metrics_dropped_samples_total")[0]?.value,
    ).toBe(1);
  });

  describe("0으로 미리 내는 시리즈(Prometheus increase()가 첫 이벤트를 놓치지 않게 한다)", () => {
    const names = (m: ReturnType<typeof createMetrics>) =>
      new Set(m.counterSamples().map((s) => s.name));

    it("라벨 값이 닫힌 열거인 counter는 시작할 때 0으로 나온다(claim_polls 3개, lease_recovered)", () => {
      const metrics = createMetrics({ callerIds: [] });

      expect(
        samplesOf(metrics, "mailo_claim_polls_total")
          .map((s) => [s.labels["result"], s.value])
          .sort(),
      ).toEqual([
        ["claimed", 0],
        ["empty", 0],
        ["error", 0],
      ]);
      expect(samplesOf(metrics, "mailo_lease_recovered_total")).toEqual([
        { labels: { account_id: "default" }, value: 0 },
      ]);
    });

    it("레지스트리 호출처마다 attempts·finished·claimed·cursor_gap 시리즈를 0으로 낸다", () => {
      const metrics = createMetrics({ callerIds: ["alpha", "beta"] });

      const count = (name: string, caller: string) =>
        samplesOf(metrics, name).filter(
          (s) => s.labels["caller_id"] === caller && s.value === 0,
        ).length;
      for (const caller of ["alpha", "beta"]) {
        expect(count("mailo_attempts_total", caller)).toBe(5);
        expect(count("mailo_jobs_finished_total", caller)).toBe(4);
        expect(count("mailo_claimed_jobs_total", caller)).toBe(1);
        expect(count("mailo_event_cursor_gap_total", caller)).toBe(1);
      }
    });

    it("호출처가 없으면 caller_id 시리즈를 만들지 않고 unregistered도 미리 내지 않는다", () => {
      const metrics = createMetrics({ callerIds: [] });

      expect(samplesOf(metrics, "mailo_attempts_total")).toEqual([]);
      expect(samplesOf(metrics, "mailo_jobs_finished_total")).toEqual([]);
      const seeded = createMetrics({ callerIds: ["alpha"] });
      expect(
        seeded
          .counterSamples()
          .some((s) => s.labels["caller_id"] === UNREGISTERED_CALLER),
      ).toBe(false);
    });

    it("조합이 불가능하거나 알림이 쓰지 않는 시리즈(attempt_errors, file_channel_files)는 미리 내지 않는다", () => {
      const metrics = createMetrics({ callerIds: ["alpha"] });

      expect(names(metrics).has("mailo_attempt_errors_total")).toBe(false);
      expect(names(metrics).has("mailo_file_channel_files_total")).toBe(false);
    });

    it("미리 낸 시리즈에 inc하면 0에서 올라가고 시리즈가 늘지 않는다", () => {
      const metrics = createMetrics({ callerIds: ["alpha"] });
      const before = metrics.counterSamples().length;

      metrics.inc("mailo_lease_recovered_total");
      metrics.inc("mailo_jobs_finished_total", {
        caller_id: "alpha",
        status: "failed",
      });

      expect(metrics.counterSamples()).toHaveLength(before);
      expect(samplesOf(metrics, "mailo_lease_recovered_total")[0]?.value).toBe(
        1,
      );
      expect(
        samplesOf(metrics, "mailo_jobs_finished_total").find(
          (s) => s.labels["status"] === "failed",
        )?.value,
      ).toBe(1);
    });

    it("미리 내기는 시리즈 상한을 넘지 않고 dropped_samples를 올리지 않는다", () => {
      const ids = Array.from({ length: 5 }, (_, i) => `c${i}`);
      const onSeriesLimit = jest.fn<(name: string) => void>();
      const metrics = createMetrics({
        callerIds: ids,
        maxSeriesPerMetric: 3,
        onSeriesLimit,
      });

      expect(samplesOf(metrics, "mailo_claimed_jobs_total")).toHaveLength(3);
      expect(
        samplesOf(metrics, "mailo_metrics_dropped_samples_total")[0]?.value,
      ).toBe(0);
      expect(onSeriesLimit).not.toHaveBeenCalled();
    });

    it("호출처 400개에서도 지표당 시리즈가 상한(2000) 안이다(attempts는 호출처당 5개)", () => {
      const ids = Array.from({ length: 400 }, (_, i) => `c${i}`);
      const metrics = createMetrics({ callerIds: ids });

      expect(samplesOf(metrics, "mailo_attempts_total")).toHaveLength(2000);
      expect(
        samplesOf(metrics, "mailo_metrics_dropped_samples_total")[0]?.value,
      ).toBe(0);
    });
  });
});

describe("account_id 라벨은 닫힌 집합이다 (RQ-062, ADR-0013 결정 5)", () => {
  const accountValues = (
    m: ReturnType<typeof createMetrics>,
    name: string,
  ): string[] =>
    [...new Set(samplesOf(m, name).map((s) => s.labels["account_id"]!))].sort();

  it("구성한 계정 ID만 라벨 값으로 쓰고 그 밖의 값은 unregistered 하나로 모은다", () => {
    const metrics = createMetrics({
      callerIds: ["alpha"],
      accountIds: ["default", "marketing"],
    });

    metrics.inc("mailo_claimed_jobs_total", {
      caller_id: "alpha",
      account_id: "marketing",
    });
    for (const id of ["retired", "Bad Id", 'x"y', "", "a".repeat(99)])
      metrics.inc("mailo_claimed_jobs_total", {
        caller_id: "alpha",
        account_id: id,
      });

    expect(incremented(metrics, "mailo_claimed_jobs_total")).toEqual([
      {
        labels: { caller_id: "alpha", account_id: "marketing" },
        value: 1,
      },
      {
        labels: { caller_id: "alpha", account_id: UNREGISTERED_ACCOUNT },
        value: 5,
      },
    ]);
  });

  it("account_id를 생략하면 default이고 default가 구성에 없으면 unregistered다", () => {
    const withDefault = createMetrics({
      callerIds: [],
      accountIds: ["default", "marketing"],
    });
    const withoutDefault = createMetrics({
      callerIds: [],
      accountIds: ["marketing"],
    });

    withDefault.inc("mailo_lease_recovered_total");
    withoutDefault.inc("mailo_lease_recovered_total");

    expect(incremented(withDefault, "mailo_lease_recovered_total")).toEqual([
      { labels: { account_id: "default" }, value: 1 },
    ]);
    expect(incremented(withoutDefault, "mailo_lease_recovered_total")).toEqual([
      { labels: { account_id: UNREGISTERED_ACCOUNT }, value: 1 },
    ]);
  });

  it("라벨 값 집합은 구성한 계정과 unregistered를 넘지 않는다. 서로 다른 값 수천 개를 넣어도 시리즈가 늘지 않는다", () => {
    const accountIds = ["default", "a", "b"];
    const metrics = createMetrics({ callerIds: ["alpha"], accountIds });

    for (let i = 0; i < 3000; i += 1) {
      metrics.inc("mailo_lease_recovered_total", { account_id: `x${i}` });
      metrics.inc("mailo_attempt_errors_total", {
        account_id: `x${i}`,
        result: "transient",
        stage: "data",
        reason: "none",
      });
    }

    expect(accountValues(metrics, "mailo_lease_recovered_total")).toEqual(
      [...accountIds, UNREGISTERED_ACCOUNT].sort(),
    );
    expect(accountValues(metrics, "mailo_attempt_errors_total")).toEqual([
      UNREGISTERED_ACCOUNT,
    ]);
  });

  describe("시드는 (호출처, 그 호출처의 계정) 쌍으로 만든다", () => {
    it("callerAccounts가 있으면 호출처당 자기 계정 시리즈만 0으로 낸다", () => {
      const metrics = createMetrics({
        callerIds: ["alpha", "beta"],
        accountIds: ["default", "marketing"],
        callerAccounts: new Map([
          ["alpha", "default"],
          ["beta", "marketing"],
        ]),
      });

      const pairs = (name: string) =>
        samplesOf(metrics, name)
          .map((s) => `${s.labels["caller_id"]}/${s.labels["account_id"]}`)
          .sort();
      expect([...new Set(pairs("mailo_attempts_total"))]).toEqual([
        "alpha/default",
        "beta/marketing",
      ]);
      expect(pairs("mailo_claimed_jobs_total")).toEqual([
        "alpha/default",
        "beta/marketing",
      ]);
      // 호출처당 attempts 5, finished 4 시리즈다.
      expect(samplesOf(metrics, "mailo_attempts_total")).toHaveLength(10);
      expect(samplesOf(metrics, "mailo_jobs_finished_total")).toHaveLength(8);
      // 계정만 가진 counter는 구성한 모든 계정을 낸다.
      expect(accountValues(metrics, "mailo_lease_recovered_total")).toEqual([
        "default",
        "marketing",
      ]);
    });

    it("호출처 50개 x 계정 20개에서도 시드가 시리즈 상한(2000) 안에서 잘리지 않는다", () => {
      const callerIds = Array.from({ length: 50 }, (_, i) => `caller${i}`);
      const accountIds = [
        "default",
        ...Array.from({ length: 19 }, (_, i) => `acct${i}`),
      ];
      const callerAccounts = new Map(
        callerIds.map((id, i) => [id, accountIds[i % accountIds.length]!]),
      );
      const onSeriesLimit = jest.fn<(name: string) => void>();

      const metrics = createMetrics({
        callerIds,
        accountIds,
        callerAccounts,
        onSeriesLimit,
      });

      expect(samplesOf(metrics, "mailo_attempts_total")).toHaveLength(50 * 5);
      expect(samplesOf(metrics, "mailo_jobs_finished_total")).toHaveLength(
        50 * 4,
      );
      expect(samplesOf(metrics, "mailo_claimed_jobs_total")).toHaveLength(50);
      expect(samplesOf(metrics, "mailo_lease_recovered_total")).toHaveLength(
        20,
      );
      expect(onSeriesLimit).not.toHaveBeenCalled();
      // 곱집합이었다면 attempts가 50 x 20 x 5 = 5000으로 상한에서 잘렸다.
      const crossProduct = createMetrics({ callerIds, accountIds });
      expect(samplesOf(crossProduct, "mailo_attempts_total")).toHaveLength(
        2000,
      );
    });
  });
});
