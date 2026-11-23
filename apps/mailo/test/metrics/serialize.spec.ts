import { describe, expect, it } from "@jest/globals";
import { formatValue, renderMetrics } from "../../src/metrics/index.js";

/** Prometheus 텍스트 형식 0.0.4 직렬화(RQ-049, ADR-0012 결정 2·7). */
describe("Prometheus 텍스트 직렬화(RQ-049, ADR-0012 결정 7)", () => {
  it("HELP와 TYPE 줄 뒤에 시리즈가 오고 끝이 개행이다", () => {
    const text = renderMetrics([
      { name: "mailo_send_paused_all", labels: {}, value: 1 },
    ]);

    expect(text).toBe(
      [
        "# HELP mailo_send_paused_all 전역. 전체 발송 정지 여부(0 또는 1).",
        "# TYPE mailo_send_paused_all gauge",
        "mailo_send_paused_all 1",
        "",
      ].join("\n"),
    );
  });

  it("counter는 TYPE이 counter다", () => {
    const text = renderMetrics([
      {
        name: "mailo_claim_polls_total",
        labels: { result: "claimed" },
        value: 3,
      },
    ]);

    expect(text).toContain("# TYPE mailo_claim_polls_total counter\n");
    expect(text).toContain('mailo_claim_polls_total{result="claimed"} 3\n');
  });

  it("같은 지표의 시리즈를 한 묶음으로 모으고 지표 순서는 카탈로그 순서다", () => {
    const text = renderMetrics([
      { name: "mailo_send_paused_callers", labels: {}, value: 2 },
      {
        name: "mailo_claim_polls_total",
        labels: { result: "empty" },
        value: 1,
      },
      { name: "mailo_send_paused_all", labels: {}, value: 0 },
      {
        name: "mailo_claim_polls_total",
        labels: { result: "claimed" },
        value: 5,
      },
    ]);
    const lines = text.trimEnd().split("\n");

    // 각 지표의 HELP·TYPE는 한 번이고 시리즈가 바로 이어진다.
    expect(lines.filter((l) => l.startsWith("# HELP")).length).toBe(3);
    const claimed = lines.findIndex((l) => l.includes('result="claimed"'));
    const empty = lines.findIndex((l) => l.includes('result="empty"'));
    expect(Math.abs(claimed - empty)).toBe(1);
    const order = lines
      .filter((l) => l.startsWith("# TYPE"))
      .map((l) => l.split(" ")[2]);
    expect(order).toEqual([
      "mailo_send_paused_all",
      "mailo_send_paused_callers",
      "mailo_claim_polls_total",
    ]);
  });

  it("시리즈가 없는 지표는 HELP·TYPE도 내지 않는다", () => {
    expect(renderMetrics([])).toBe("");
  });

  it("라벨 값의 역슬래시, 큰따옴표, 줄바꿈을 이스케이프한다", () => {
    const text = renderMetrics([
      {
        name: "mailo_caller_paused",
        labels: { caller_id: 'a\\b"c\nd' },
        value: 0,
      },
    ]);

    expect(text).toContain(
      'mailo_caller_paused{caller_id="a\\\\b\\"c\\nd"} 0\n',
    );
    // 이스케이프한 뒤에는 시리즈 한 줄이 줄바꿈 없이 한 줄이다.
    expect(
      text.split("\n").filter((l) => l.startsWith("mailo_caller_paused{")),
    ).toHaveLength(1);
  });

  it("라벨은 카탈로그 선언 순서로 쓴다", () => {
    const text = renderMetrics([
      {
        name: "mailo_attempts_total",
        labels: { result: "sent", account_id: "default", caller_id: "alpha" },
        value: 1,
      },
    ]);

    expect(text).toContain(
      'mailo_attempts_total{caller_id="alpha",account_id="default",result="sent"} 1\n',
    );
  });

  it("값 표기: 정수와 소수는 그대로, NaN·±Inf는 Prometheus 표기다", () => {
    expect(formatValue(0)).toBe("0");
    expect(formatValue(-0)).toBe("0");
    expect(formatValue(12)).toBe("12");
    expect(formatValue(1.5)).toBe("1.5");
    expect(formatValue(Number.NaN)).toBe("NaN");
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe("+Inf");
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe("-Inf");
    // 지수 표기도 Prometheus 값 파서가 받는다.
    expect(formatValue(1e21)).toBe("1e+21");
  });

  it("NaN·Inf 값이 있어도 한 줄로 나가고 파서가 읽는 표기다", () => {
    const text = renderMetrics([
      { name: "mailo_send_paused_all", labels: {}, value: Number.NaN },
      { name: "mailo_send_paused_callers", labels: {}, value: Infinity },
    ]);

    expect(text).toContain("mailo_send_paused_all NaN\n");
    expect(text).toContain("mailo_send_paused_callers +Inf\n");
  });

  it("같은 이름과 라벨의 시리즈가 둘이면 던진다", () => {
    expect(() =>
      renderMetrics([
        { name: "mailo_send_paused_all", labels: {}, value: 1 },
        { name: "mailo_send_paused_all", labels: {}, value: 0 },
      ]),
    ).toThrow(/중복/);
  });

  it("라벨 순서만 다른 같은 시리즈도 중복이다", () => {
    expect(() =>
      renderMetrics([
        {
          name: "mailo_claimed_jobs_total",
          labels: { caller_id: "a", account_id: "default" },
          value: 1,
        },
        {
          name: "mailo_claimed_jobs_total",
          labels: { account_id: "default", caller_id: "a" },
          value: 1,
        },
      ]),
    ).toThrow(/중복/);
  });

  it("카탈로그에 없는 지표나 라벨 이름이 어긋난 시리즈는 던진다", () => {
    expect(() =>
      renderMetrics([{ name: "mailo_unknown", labels: {}, value: 1 }]),
    ).toThrow(/mailo_unknown/);
    expect(() =>
      renderMetrics([
        {
          name: "mailo_caller_paused",
          labels: { caller_id: "a", extra: "x" },
          value: 1,
        },
      ]),
    ).toThrow(/라벨/);
    expect(() =>
      renderMetrics([{ name: "mailo_caller_paused", labels: {}, value: 1 }]),
    ).toThrow(/라벨/);
  });
});
