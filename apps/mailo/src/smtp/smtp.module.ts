import { Module } from "@nestjs/common";

/** SMTP 전송. 단계 기준 오류 분류와 전역 차단기가 들어간다(ADR-0007). */
@Module({})
export class SmtpModule {}
