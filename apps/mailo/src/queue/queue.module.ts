import { Module } from "@nestjs/common";

/** 큐 모듈. Worker, 작업 점유(claim), lease 복구, 만료 sweep이 들어간다(ADR-0002). */
@Module({})
export class QueueModule {}
