/** `/metrics` 응답 텍스트를 시험에서 읽는 도구. Prometheus 0.0.4 텍스트 형식의 시리즈 줄만 해석한다. */
export interface ParsedSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

// 라벨 값은 `\\`, `\"`, `\n` 이스케이프만 쓴다.
const SERIES = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? (\S+)$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

function unescape(value: string): string {
  return value.replace(/\\(.)/g, (_m, c: string) => (c === "n" ? "\n" : c));
}

function parseValue(text: string): number {
  if (text === "NaN") return Number.NaN;
  if (text === "+Inf") return Number.POSITIVE_INFINITY;
  if (text === "-Inf") return Number.NEGATIVE_INFINITY;
  return Number(text);
}

export function parseMetrics(text: string): ParsedSample[] {
  const samples: ParsedSample[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const match = SERIES.exec(line);
    if (match === null) throw new Error(`시리즈 줄 형식이 아니다: ${line}`);
    const labels: Record<string, string> = {};
    for (const m of (match[3] ?? "").matchAll(LABEL))
      labels[m[1]!] = unescape(m[2]!);
    samples.push({
      name: match[1]!,
      labels,
      value: parseValue(match[4]!),
    });
  }
  return samples;
}

/** 이름과 라벨(부분 일치)로 시리즈를 찾는다. */
export function findSamples(
  samples: readonly ParsedSample[],
  name: string,
  labels: Record<string, string> = {},
): ParsedSample[] {
  return samples.filter(
    (s) =>
      s.name === name &&
      Object.entries(labels).every(([k, v]) => s.labels[k] === v),
  );
}

/** 시리즈 하나의 값. 없으면 undefined이고 둘 이상이면 던진다. */
export function valueOf(
  samples: readonly ParsedSample[],
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  const found = findSamples(samples, name, labels);
  if (found.length > 1)
    throw new Error(
      `시리즈가 ${found.length}개다: ${name} ${JSON.stringify(labels)}`,
    );
  return found[0]?.value;
}

/** 같은 이름·라벨의 시리즈가 둘 이상인 키 목록(중복 검사). */
export function duplicateSeries(samples: readonly ParsedSample[]): string[] {
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const s of samples) {
    const key = `${s.name}${JSON.stringify(Object.entries(s.labels).sort())}`;
    if (seen.has(key)) dup.push(key);
    seen.add(key);
  }
  return dup;
}
