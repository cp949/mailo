import { Inject, Injectable, Logger } from "@nestjs/common";
import type pg from "pg";
import { CALLER_REGISTRY, type CallerRegistry } from "../callers/index.js";
import { APP_CONFIG, type AppConfig } from "../config/index.js";
import { PG_POOL } from "../db/index.js";
import { getFeedLagsForCallers } from "../events/index.js";
import { describeError } from "../logging/index.js";
import { getAuditStats, type AuditStats } from "../ops/index.js";
import {
  getBreakerState,
  getCallerQuotaUsage,
  getQueueDepth,
  readSendControls,
  type BreakerSnapshot,
  type QueueDepth,
  type SendControls,
} from "../queue/index.js";
import {
  STATEMENT_TIMEOUT_MS,
  runReadOnly,
  withBoundedConnection,
} from "./bounded-client.js";

const logger = new Logger("metrics");

/** DB를 읽는 수집 그룹. 한 그룹이 실패해도 나머지는 응답에 남는다(ADR-0012 결정 5). */
export const METRICS_GROUPS = [
  "queue",
  "breaker",
  "controls",
  "quota",
  "feed",
  "audit",
] as const;
export type MetricsGroup = (typeof METRICS_GROUPS)[number];

/** 수집 전체 시간 상한(ms). Prometheus 기본 `scrape_timeout`(10초)보다 짧다(ADR-0012 결정 5, 추정). */
export const COLLECT_TOTAL_TIMEOUT_MS = 5000;

/** 한 번의 DB 수집 결과. 실패한 그룹의 값은 없다. */
export interface GlobalSnapshot {
  ok: Record<MetricsGroup, boolean>;
  queue?: QueueDepth;
  breaker?: BreakerSnapshot;
  controls?: SendControls;
  /** 호출처 ID → 사용량. 할당을 설정한 호출처만 있다. */
  quota?: Map<string, number>;
  /** 호출처 ID → 최신 이벤트 경과 초. 이벤트가 없는 호출처는 없다. */
  feed?: Map<string, number>;
  audit?: AuditStats;
}

export interface CachedSnapshot {
  snapshot: GlobalSnapshot;
  /** 수집이 끝난 뒤 경과 초(단조 시계). */
  ageSeconds: number;
}

interface CacheEntry {
  snapshot: GlobalSnapshot;
  takenAt: number;
}

/**
 * 전역 gauge의 DB 수집기(RQ-049, ADR-0012 결정 5).
 * - TTL 캐시: `MAILO_METRICS_CACHE_SECONDS` 안에는 마지막 수집 결과를 다시 쓴다. 실패한 그룹도 TTL 동안 재사용해 재시도 폭주를 막는다.
 * - 단일 비행: 수집 중 들어온 요청은 같은 결과를 기다린다. 인스턴스당 DB 조회는 TTL마다 최대 1회이고 풀 연결은 최대 1개다.
 * - 그룹은 풀 연결 하나로 순차 실행한다. 그룹마다 `BEGIN READ ONLY`와 `SET LOCAL statement_timeout = 2000`을 건다.
 *   쓰기, 행 잠금, advisory lock이 없어 점유·완료 경로의 잠금 순서(작업 행 → 차단기 행)에 끼지 않는다.
 * - 전체 상한은 5초다. 넘으면 새 그룹을 시작하지 않고 연결을 풀에서 버린다. 연결을 얻지 못하면 모든 그룹이 실패다.
 * - 그룹 실패는 `metrics_collect_failed`(warn)로 한 번만 남긴다. 같은 그룹이 연속 실패하는 동안 반복하지 않는다.
 * 호출자는 반환값을 읽기만 한다. 시각은 DB `now()`로만 계산한다(ADR-0002 결정 10).
 */
@Injectable()
export class MetricsCollector {
  private cache: CacheEntry | undefined;
  private inflight: Promise<CacheEntry> | undefined;
  private readonly failing = new Set<MetricsGroup>();

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CALLER_REGISTRY) private readonly registry: CallerRegistry,
  ) {}

  /** 캐시가 신선하면 그것을, 아니면 수집한 결과를 돌려준다. 던지지 않는다. */
  async snapshot(): Promise<CachedSnapshot> {
    const ttlMs = this.config.metrics.cacheSeconds * 1000;
    const cached = this.cache;
    if (cached !== undefined && performance.now() - cached.takenAt < ttlMs)
      return this.view(cached);
    this.inflight ??= this.collect()
      .then((entry) => {
        this.cache = entry;
        return entry;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.view(await this.inflight);
  }

  private view(entry: CacheEntry): CachedSnapshot {
    return {
      snapshot: entry.snapshot,
      ageSeconds: Math.max(0, (performance.now() - entry.takenAt) / 1000),
    };
  }

  private async collect(): Promise<CacheEntry> {
    const snapshot: GlobalSnapshot = {
      ok: {
        queue: false,
        breaker: false,
        controls: false,
        quota: false,
        feed: false,
        audit: false,
      },
    };
    const errors = new Map<MetricsGroup, unknown>();
    const deadline = performance.now() + COLLECT_TOTAL_TIMEOUT_MS;
    const quotas = new Map(
      this.registry.callers.flatMap((c) =>
        c.sendQuota24h === null ? [] : ([[c.id, c.sendQuota24h]] as const),
      ),
    );
    const callerIds = this.registry.callers.map((c) => c.id);
    const breakerKey = this.config.worker.breaker.breakerKey;

    const groups: Array<[MetricsGroup, (db: pg.PoolClient) => Promise<void>]> =
      [
        [
          "queue",
          async (db) => {
            snapshot.queue = await getQueueDepth(
              db,
              this.config.smtpAccounts.map((a) => a.id),
            );
          },
        ],
        [
          "breaker",
          async (db) => {
            snapshot.breaker = await getBreakerState(db, { breakerKey });
          },
        ],
        [
          "controls",
          async (db) => {
            snapshot.controls = await readSendControls(db);
          },
        ],
        [
          "quota",
          async (db) => {
            snapshot.quota = await getCallerQuotaUsage(db, quotas);
          },
        ],
        [
          "feed",
          async (db) => {
            snapshot.feed = await getFeedLagsForCallers(db, callerIds);
          },
        ],
        [
          "audit",
          async (db) => {
            snapshot.audit = await getAuditStats(db);
          },
        ],
      ];

    try {
      await withBoundedConnection(
        this.pool,
        COLLECT_TOTAL_TIMEOUT_MS,
        async (client) => {
          for (const [group, run] of groups) {
            if (performance.now() >= deadline) return;
            try {
              await runReadOnly(client, run, STATEMENT_TIMEOUT_MS);
              snapshot.ok[group] = true;
            } catch (error) {
              errors.set(group, error);
              // 실패한 쿼리가 연 트랜잭션을 닫아야 다음 그룹이 같은 연결을 쓴다. 닫지 못하면 연결을 버린다.
              await client.query("ROLLBACK");
            }
          }
        },
      );
    } catch (error) {
      // 연결을 얻지 못했거나 전체 시간이 지났다. 끝내지 못한 그룹은 모두 실패다.
      for (const group of METRICS_GROUPS)
        if (!snapshot.ok[group] && !errors.has(group)) errors.set(group, error);
    }
    for (const group of METRICS_GROUPS)
      if (!snapshot.ok[group] && !errors.has(group))
        errors.set(group, new Error("timeout"));

    this.report(errors);
    // 실패한 그룹의 값은 응답에서 뺀다. 도중에 채워진 값이 있어도 성공하지 못한 그룹은 쓰지 않는다.
    for (const group of METRICS_GROUPS)
      if (!snapshot.ok[group]) delete snapshot[group];
    return { snapshot, takenAt: performance.now() };
  }

  /** 그룹이 성공에서 실패로 바뀔 때만 한 번 남긴다. 오류는 이름·코드만 쓴다(RQ-027). */
  private report(errors: ReadonlyMap<MetricsGroup, unknown>): void {
    for (const group of METRICS_GROUPS) {
      const error = errors.get(group);
      if (error === undefined) {
        this.failing.delete(group);
        continue;
      }
      if (this.failing.has(group)) continue;
      this.failing.add(group);
      logger.warn({
        event: "metrics_collect_failed",
        group,
        error: describeError(error),
      });
    }
  }
}
