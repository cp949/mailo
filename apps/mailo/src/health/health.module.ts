import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";
import { MetricsCollector } from "./metrics-collector.js";
import { MetricsController } from "./metrics.controller.js";
import { MetricsService } from "./metrics.service.js";

/** 헬스 응답(차단기 상태 노출, ADR-0007 결정 5)과 `/metrics`(ADR-0012). 둘 다 `queue`·`events`·Worker 상태를 읽는다. */
@Module({
  controllers: [HealthController, MetricsController],
  providers: [HealthService, MetricsCollector, MetricsService],
})
export class HealthModule {}
