import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ProblemExceptionFilter } from "./problem.filter.js";

/** 공통 HTTP 처리: problem+json 오류 필터. 요청 ID 미들웨어는 `setupHttp`가 등록한다. */
@Module({
  providers: [{ provide: APP_FILTER, useClass: ProblemExceptionFilter }],
})
export class HttpModule {}
