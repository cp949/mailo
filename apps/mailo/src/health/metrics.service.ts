import { Inject, Injectable, Optional } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { CALLER_REGISTRY, type CallerRegistry } from "../callers/index.js";
import { APP_CONFIG, type AppConfig } from "../config/index.js";
import { FILE_POLLER, type FilePollerRunner } from "../file-channel/index.js";
import {
  APP_METRICS,
  renderMetrics,
  type MetricsRegistry,
  type Sample,
} from "../metrics/index.js";
import { WORKER_RUNNER, type WorkerRunner } from "../worker-port.js";
import { MetricsCollector } from "./metrics-collector.js";
import {
  globalSamples,
  instanceSamples,
  processSamples,
} from "./metrics-samples.js";

/**
 * `GET /metrics` 본문을 만든다(RQ-049, ADR-0012). 전역 gauge는 수집기의 캐시된 DB 결과, 인스턴스 값은 이 프로세스의 메모리다.
 * 어느 쪽도 요청 값(수신자·본문·Key·토큰)을 읽지 않는다(RQ-027).
 */
@Injectable()
export class MetricsService {
  constructor(
    private readonly collector: MetricsCollector,
    @Inject(CALLER_REGISTRY) private readonly registry: CallerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly moduleRef: ModuleRef,
    @Optional()
    @Inject(APP_METRICS)
    private readonly counters?: MetricsRegistry,
  ) {}

  async render(): Promise<string> {
    const { snapshot, ageSeconds } = await this.collector.snapshot();
    const worker = this.moduleRef
      .get<WorkerRunner>(WORKER_RUNNER, { strict: false })
      .status?.();
    const filePoller = this.moduleRef
      .get<FilePollerRunner>(FILE_POLLER, { strict: false })
      .status?.();
    const samples: Sample[] = [
      ...globalSamples(snapshot, this.registry, this.config.smtpAccounts),
      ...(this.counters?.counterSamples() ?? []),
      ...instanceSamples({
        worker,
        accountIds: this.config.smtpAccounts.map((a) => a.id),
        filePoller,
        snapshot,
        snapshotAgeSeconds: ageSeconds,
        nowMs: Date.now(),
      }),
      ...processSamples(),
    ];
    return renderMetrics(samples);
  }
}
