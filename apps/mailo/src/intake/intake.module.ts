import { Module } from "@nestjs/common";
import { IntakeController } from "./intake.controller.js";
import { IntakeService } from "./intake.service.js";

/** REST 입력 채널. 등록·조회 API와 Idempotency-Key 처리가 들어간다(RQ-001, ADR-0005·0006). */
@Module({
  controllers: [IntakeController],
  providers: [IntakeService],
})
export class IntakeModule {}
