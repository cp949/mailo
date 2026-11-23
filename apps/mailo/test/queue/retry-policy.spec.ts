import { describe, expect, it } from "@jest/globals";
import {
  breakerInitialWait,
  breakerWaitCap,
  defaultBreakerConfig,
  defaultRetryPolicy,
  retryDelaySeconds,
} from "../../src/queue/retry-policy.js";

describe("재시도 대기 시간(RQ-008, ADR-0003 결정 5)", () => {
  const policy = { ...defaultRetryPolicy(), jitterRatio: 0 };

  it("exponential은 기준 1분에서 2배씩 늘고 상한 1시간에서 멈춘다", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
      retryDelaySeconds(policy, n),
    );
    expect(delays).toEqual([60, 120, 240, 480, 960, 1920, 3600, 3600]);
  });

  it("jitter는 ±20% 안에서 균등하게 더한다", () => {
    const low = retryDelaySeconds(
      { ...policy, jitterRatio: 0.2, random: () => 0 },
      1,
    );
    const high = retryDelaySeconds(
      { ...policy, jitterRatio: 0.2, random: () => 0.999999 },
      1,
    );
    expect(low).toBeCloseTo(48);
    expect(high).toBeCloseTo(72, 1);
  });

  it("상한(1시간) 이후에도 상한 값이 유지된다", () => {
    expect(retryDelaySeconds(policy, 20)).toBe(3600);
  });

  it("jitter는 상한을 적용한 뒤에 더하므로 최대 72분까지 가능하다(ADR-0003 결정 5)", () => {
    const high = retryDelaySeconds(
      { ...policy, jitterRatio: 0.2, random: () => 0.999999 },
      10,
    );
    expect(high / 60).toBeGreaterThan(71.9);
    expect(high / 60).toBeLessThanOrEqual(72);
  });

  it("기본 정책 7회 대기의 합은 약 123분이다(1·2·4·8·16·32·60분)", () => {
    const total = [1, 2, 3, 4, 5, 6, 7]
      .map((n) => retryDelaySeconds(policy, n))
      .reduce((a, b) => a + b, 0);
    expect(total / 60).toBe(123);
  });

  it("fixed는 시도 횟수와 무관하게 기준 간격이다", () => {
    const fixed = { ...policy, mode: "fixed" as const, baseSeconds: 90 };
    expect([1, 5, 8].map((n) => retryDelaySeconds(fixed, n))).toEqual([
      90, 90, 90,
    ]);
  });
});

describe("차단기 대기 시간 규칙(ADR-0007 결정 5)", () => {
  const config = defaultBreakerConfig();

  it("초기값은 일일 한도 1시간, 순간 한도 5분, 그 밖 1분이다", () => {
    expect(breakerInitialWait(config, "DAILY_LIMIT")).toBe(3600);
    expect(breakerInitialWait(config, "RATE_LIMIT")).toBe(300);
    expect(breakerInitialWait(config, "AUTH")).toBe(60);
  });

  it("상한은 max(30분, 사유의 초기값)이다", () => {
    expect(breakerWaitCap(config, "DAILY_LIMIT")).toBe(3600);
    expect(breakerWaitCap(config, "RATE_LIMIT")).toBe(1800);
    expect(breakerWaitCap(config, "CONNECTION")).toBe(1800);
  });
});
