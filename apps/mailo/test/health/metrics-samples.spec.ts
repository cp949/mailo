import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { processSamples } from "../../src/health/metrics-samples.js";

/** process_* 지표(RQ-052, ADR-0012 결정 3·4). 시작 시각이 스크레이프마다 흔들리면 "바뀌면 재시작" 규칙이 깨진다. */
describe("process_* 지표(RQ-052, ADR-0012 결정 4)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const value = (name: string) =>
    processSamples().find((s) => s.name === name)!.value;

  it("process_start_time_seconds는 호출할 때마다 같은 값이다(시계가 움직여도 재시작으로 보이지 않는다)", () => {
    const base = Date.now();
    let calls = 0;
    // 현재 시각이 호출마다 1ms씩 흐르는 시계. 매번 다시 계산하면 값이 달라진다.
    jest.spyOn(Date, "now").mockImplementation(() => base + calls++);

    const values = new Set(
      Array.from({ length: 20 }, () => value("process_start_time_seconds")),
    );

    expect(values.size).toBe(1);
  });

  it("시작 시각은 현재보다 과거이고 프로세스 가동 시간 안에 든다", () => {
    const start = value("process_start_time_seconds");
    const now = Date.now() / 1000;

    expect(start).toBeLessThanOrEqual(now);
    expect(now - start).toBeLessThan(3600);
  });

  it("process_resident_memory_bytes와 process_cpu_seconds_total은 호출마다 읽는다", () => {
    expect(value("process_resident_memory_bytes")).toBeGreaterThan(0);
    expect(value("process_cpu_seconds_total")).toBeGreaterThanOrEqual(0);
  });
});
