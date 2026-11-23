import { METRICS, findMetric, type MetricDef } from "./catalog.js";

/** 시리즈 하나. 라벨 값은 저장소·수집기가 검증한 뒤 넘긴다. */
export interface Sample {
  name: string;
  labels: Readonly<Record<string, string>>;
  value: number;
}

/** 직렬화할 수 없는 입력(카탈로그에 없는 지표, 라벨 불일치, 중복 시리즈). 코드 결함이라 던진다. */
export class MetricsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricsFormatError";
  }
}

/**
 * Prometheus 텍스트 형식 0.0.4의 값 표기. NaN·±Inf는 `NaN`·`+Inf`·`-Inf`다.
 * 음의 0은 `0`으로 낸다. 지수 표기(`1e+21`)는 Prometheus 값 파서가 받는다.
 */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value === 0 ? 0 : value);
}

/** 라벨 값 이스케이프: `\`, `"`, 줄바꿈. 검증을 통과한 값에는 이 문자가 없으므로 이중 방어다(ADR-0012 결정 6). */
function escapeLabelValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n");
}

/** HELP 문장 이스케이프: `\`와 줄바꿈. */
function escapeHelp(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

function checkLabels(
  def: MetricDef,
  labels: Readonly<Record<string, string>>,
): void {
  const expected = Object.keys(def.labels);
  const actual = Object.keys(labels);
  if (
    expected.length !== actual.length ||
    !expected.every((name) => Object.hasOwn(labels, name))
  )
    throw new MetricsFormatError(
      `지표 ${def.name}의 라벨 이름이 카탈로그와 다르다(기대 ${expected.join(",")}, 실제 ${actual.join(",")})`,
    );
}

/**
 * 시리즈를 Prometheus 텍스트로 쓴다(ADR-0012 결정 2·7).
 * - 지표는 카탈로그 순서로 묶고 지표마다 HELP·TYPE 줄을 한 번 쓴다. 시리즈가 없는 지표는 쓰지 않는다.
 * - 라벨은 카탈로그에 선언된 순서로 쓴다. 같은 이름·라벨의 시리즈가 둘이면 던진다.
 * - 끝은 개행이다. 시리즈가 하나도 없으면 빈 문자열이다.
 */
export function renderMetrics(samples: readonly Sample[]): string {
  const grouped = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const sample of samples) {
    const def = findMetric(sample.name);
    if (def === undefined)
      throw new MetricsFormatError(`카탈로그에 없는 지표다: ${sample.name}`);
    checkLabels(def, sample.labels);
    const rendered = Object.keys(def.labels).map(
      (name) => `${name}="${escapeLabelValue(sample.labels[name]!)}"`,
    );
    const series = `${def.name}${rendered.length > 0 ? `{${rendered.join(",")}}` : ""}`;
    if (seen.has(series))
      throw new MetricsFormatError(`중복 시리즈다: ${series}`);
    seen.add(series);
    const lines = grouped.get(def.name) ?? [];
    lines.push(`${series} ${formatValue(sample.value)}`);
    grouped.set(def.name, lines);
  }

  const out: string[] = [];
  for (const def of METRICS) {
    const lines = grouped.get(def.name);
    if (lines === undefined) continue;
    out.push(`# HELP ${def.name} ${escapeHelp(def.help)}`);
    out.push(`# TYPE ${def.name} ${def.type}`);
    out.push(...lines);
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}
