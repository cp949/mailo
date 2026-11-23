import {
  DEFAULT_ACCOUNT_ID,
  UNREGISTERED_ACCOUNT,
  UNREGISTERED_CALLER,
  assertCatalog,
  findMetric,
  METRICS,
  type CounterName,
  type MetricDef,
} from "./catalog.js";
import type { Sample } from "./serialize.js";

/** 호출처 ID 형식(`callers/registry.ts`의 `isCallerId`와 같은 규칙. leaf라 import하지 않고 따로 둔다). */
const CALLER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 지표 하나의 시리즈 수 상한(ADR-0012 결정 6, 추정). */
export const DEFAULT_MAX_SERIES_PER_METRIC = 2000;

/** counter 증가 인터페이스. Worker·파일 폴러·REST 계층이 받는다. 어떤 입력에도 던지지 않는다. */
export interface AppMetrics {
  /**
   * counter를 올린다. 라벨은 검증해 쓴다(ADR-0012 결정 6).
   * - `caller_id`: 형식이 맞고 레지스트리에 있어야 한다. 아니면 `unregistered`다.
   * - `account_id`: 생략하면 `default`다. 구성한 계정이 아니면 `unregistered`다(ADR-0013 결정 5).
   * - 닫힌 열거: 집합 밖의 값은 카탈로그의 fallback으로 센다. fallback이 없으면 버린다.
   * 버리거나 시리즈 상한에 막힌 증가는 `mailo_metrics_dropped_samples_total`에 센다.
   */
  inc(
    name: CounterName,
    labels?: Readonly<Record<string, string>>,
    by?: number,
  ): void;
}

/** counter 저장소. 메모리에만 있고 재시작하면 0에서 다시 시작한다. */
export interface MetricsRegistry extends AppMetrics {
  /** 지금까지 쌓인 counter 시리즈. `mailo_metrics_dropped_samples_total`은 처음부터 0으로 나온다. */
  counterSamples(): Sample[];
}

export interface CreateMetricsOptions {
  /** 기동 때 읽은 레지스트리의 호출처 ID. 이 밖의 `caller_id`는 `unregistered`다. */
  callerIds: Iterable<string>;
  /** 구성한 계정 ID. 이 밖의 `account_id`는 `unregistered`다. 생략하면 `default`뿐이다. */
  accountIds?: Iterable<string>;
  /**
   * 호출처 ID → 그 호출처의 계정 ID(레지스트리의 `accountId`). 있으면 0 시리즈 시드를 호출처 x 계정의 곱집합이 아니라 이 쌍으로 만든다.
   * 곱집합이면 호출처 50개와 계정 20개에서 `mailo_attempts_total`이 5000시리즈가 되어 상한에 닿는다(ADR-0013 결정 5). 생략하면 곱집합이다.
   */
  callerAccounts?: ReadonlyMap<string, string>;
  /** 지표 하나의 시리즈 상한. 생략하면 2000이다. */
  maxSeriesPerMetric?: number;
  /** 어떤 지표가 시리즈 상한에 처음 닿았을 때 한 번 부른다. 지표 이름만 넘긴다. */
  onSeriesLimit?: (metricName: string) => void;
}

/** 아무것도 하지 않는 구현. 주입하지 않은 앱(테스트 기본값)이 쓴다. */
export const noopMetrics: AppMetrics = { inc: () => undefined };

const DROPPED = "mailo_metrics_dropped_samples_total";

interface Series {
  labels: Record<string, string>;
  value: number;
}

export function createMetrics(options: CreateMetricsOptions): MetricsRegistry {
  assertCatalog(METRICS);
  const callerIds = new Set(options.callerIds);
  const callerAccounts = options.callerAccounts;
  const accountIds = new Set(options.accountIds ?? [DEFAULT_ACCOUNT_ID]);
  const maxSeries = options.maxSeriesPerMetric ?? DEFAULT_MAX_SERIES_PER_METRIC;
  const stores = new Map<string, Map<string, Series>>();
  const limited = new Set<string>();
  let dropped = 0;

  /** 정의에 맞게 라벨을 검증·정규화한다. 버려야 하면 undefined다. */
  function normalize(
    def: MetricDef,
    input: Readonly<Record<string, string>>,
  ): Record<string, string> | undefined {
    for (const given of Object.keys(input))
      if (!Object.hasOwn(def.labels, given)) return undefined;
    const labels: Record<string, string> = {};
    for (const [name, spec] of Object.entries(def.labels)) {
      const value = input[name];
      if (spec.kind === "account") {
        // 구성 밖 계정(남은 작업이 만료 sweep으로 종결되는 경우 등)은 `unregistered` 하나로 센다. 라벨 값은 닫힌 집합이다.
        const account = value ?? DEFAULT_ACCOUNT_ID;
        labels[name] = accountIds.has(account) ? account : UNREGISTERED_ACCOUNT;
      } else if (value === undefined) {
        return undefined;
      } else if (spec.kind === "caller") {
        labels[name] =
          CALLER_ID.test(value) && callerIds.has(value)
            ? value
            : UNREGISTERED_CALLER;
      } else if (spec.values.includes(value)) {
        labels[name] = value;
      } else if (spec.fallback !== undefined) {
        labels[name] = spec.fallback;
      } else {
        return undefined;
      }
    }
    return labels;
  }

  function inc(
    name: CounterName,
    labels: Readonly<Record<string, string>> = {},
    by = 1,
  ): void {
    try {
      if (!Number.isInteger(by) || by <= 0) return;
      const def = findMetric(name);
      if (def === undefined || def.type !== "counter") {
        dropped += 1;
        return;
      }
      const normalized = normalize(def, labels);
      if (normalized === undefined) {
        dropped += 1;
        return;
      }
      const key = JSON.stringify(Object.values(normalized));
      let store = stores.get(name);
      if (store === undefined) {
        store = new Map();
        stores.set(name, store);
      }
      const existing = store.get(key);
      if (existing !== undefined) {
        existing.value += by;
        return;
      }
      if (store.size >= maxSeries) {
        dropped += by;
        if (!limited.has(name)) {
          limited.add(name);
          options.onSeriesLimit?.(name);
        }
        return;
      }
      store.set(key, { labels: normalized, value: by });
    } catch {
      // 지표 기록이 발송 경로를 깨면 안 된다.
      dropped += 1;
    }
  }

  function counterSamples(): Sample[] {
    const samples: Sample[] = [];
    for (const [name, store] of stores)
      for (const series of store.values())
        samples.push({ name, labels: series.labels, value: series.value });
    samples.push({ name: DROPPED, labels: {}, value: dropped });
    return samples;
  }

  /**
   * `seed` 지표를 라벨 조합마다 0으로 만든다. 상한에 닿으면 멈추고 `dropped_samples`는 올리지 않는다.
   * 호출처와 계정 라벨이 함께 있는 지표는 `callerAccounts`가 있으면 (호출처, 그 호출처의 계정) 쌍만 만든다.
   */
  function seedZeroSeries(): void {
    for (const def of METRICS) {
      if (def.seed !== true) continue;
      const pairByCaller =
        callerAccounts !== undefined &&
        Object.values(def.labels).some((s) => s.kind === "caller") &&
        Object.values(def.labels).some((s) => s.kind === "account");
      let combos: Array<Record<string, string>> = [{}];
      for (const [name, spec] of Object.entries(def.labels)) {
        if (spec.kind === "account" && pairByCaller) {
          // 앞선 `caller` 라벨 값으로 계정을 정한다. 선언 순서가 호출처 먼저여야 한다.
          combos = combos.flatMap((combo) => {
            const callerLabel = Object.entries(def.labels).find(
              ([, s]) => s.kind === "caller",
            )![0];
            const account = callerAccounts.get(combo[callerLabel]!);
            return account !== undefined && accountIds.has(account)
              ? [{ ...combo, [name]: account }]
              : [];
          });
          continue;
        }
        const values =
          spec.kind === "caller"
            ? [...callerIds].filter((id) => CALLER_ID.test(id))
            : spec.kind === "account"
              ? [...accountIds]
              : [...spec.values];
        combos = combos.flatMap((combo) =>
          values.map((value) => ({ ...combo, [name]: value })),
        );
      }
      const store = new Map<string, Series>();
      for (const labels of combos) {
        if (store.size >= maxSeries) break;
        store.set(JSON.stringify(Object.values(labels)), { labels, value: 0 });
      }
      stores.set(def.name, store);
    }
  }
  seedZeroSeries();

  return { inc, counterSamples };
}
