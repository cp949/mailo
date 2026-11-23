import { Module } from "@nestjs/common";
import { OpsController } from "./ops.controller.js";
import { OpsService } from "./ops.service.js";

/**
 * 운영 REST와 감사 기록(RQ-042~044, ADR-0011). 정지 테이블과 취소 SQL은 `queue`가, 감사 테이블(`mail_ops_audit`)은 이 모듈이 소유한다.
 * 상태 변경과 감사를 같은 트랜잭션에 쓰려고 `queue`의 함수에 연결을 넘겨 부른다.
 */
@Module({
  controllers: [OpsController],
  providers: [OpsService],
})
export class OpsModule {}
