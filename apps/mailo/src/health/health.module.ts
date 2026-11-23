import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

/** 헬스 응답. 차단기 상태 노출이 들어간다(ADR-0007 결정 5). */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
