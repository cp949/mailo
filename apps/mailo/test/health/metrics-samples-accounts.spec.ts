import { describe, expect, it } from "@jest/globals";
import { instanceSamples } from "../../src/health/metrics-samples.js";
import type { GlobalSnapshot } from "../../src/health/metrics-collector.js";
import type { WorkerStatus } from "../../src/worker/index.js";

const snapshot: GlobalSnapshot = {
  ok: {
    queue: true,
    breaker: true,
    controls: true,
    quota: true,
    feed: true,
    audit: true,
  },
};

function worker(inFlightByAccount: Record<string, number>): WorkerStatus {
  return {
    state: "running",
    inFlight: Object.values(inFlightByAccount).reduce((a, b) => a + b, 0),
    inFlightByAccount,
    lastPollAt: null,
    lastPollAgeSeconds: null,
    claimFailureStreak: 0,
    pollLoopCrashed: false,
  };
}

describe("계정별 진행 중 전송 지표 (RQ-062, ADR-0013 결정 5)", () => {
  const input = (w: WorkerStatus | undefined) => ({
    worker: w,
    accountIds: ["default", "marketing", "billing"],
    filePoller: undefined,
    snapshot,
    snapshotAgeSeconds: 0,
    nowMs: 0,
  });

  it("구성한 계정마다 시리즈를 내고 진행 중이 없는 계정은 0이다. 전체 값은 기존 지표가 낸다", () => {
    const samples = instanceSamples(
      input(worker({ default: 1, marketing: 2 })),
    );

    expect(
      samples
        .filter((s) => s.name === "mailo_worker_in_flight")
        .map((s) => [s.labels["account_id"], s.value]),
    ).toEqual([
      ["default", 1],
      ["marketing", 2],
      ["billing", 0],
    ]);
    expect(
      samples.find((s) => s.name === "mailo_worker_in_flight_jobs")?.value,
    ).toBe(3);
  });

  it("Worker가 꺼져 있으면 계정별 시리즈가 없다", () => {
    const samples = instanceSamples(input(undefined));

    expect(samples.some((s) => s.name === "mailo_worker_in_flight")).toBe(
      false,
    );
  });
});
