import { Controller, Get, Req, Res, UseGuards } from "@nestjs/common";
import { OptionalBearerAuthGuard } from "../callers/index.js";
import {
  sendJson,
  type HttpRequest,
  type HttpResponse,
} from "../http/index.js";
import { HealthService } from "./health.service.js";

/**
 * 헬스 endpoint(RQ-031). 인증 없이 호출할 수 있다.
 * `/health/live`는 외부 의존성을 보지 않고 `Authorization` 헤더도 보지 않는다. 생존 확인이 자격 설정에 영향받지 않게 한다.
 * `/health/ready`는 유효한 Bearer가 있을 때만 `openUntil`·`lastReason`을 반환한다.
 * 헤더를 보냈는데 자격이 틀리면 401이고 공개 응답으로 낮추지 않는다.
 */
@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  live(@Res() res: HttpResponse): void {
    sendJson(res, 200, { status: "UP" }, { "Cache-Control": "no-store" });
  }

  @Get("ready")
  @UseGuards(OptionalBearerAuthGuard)
  async ready(
    @Req() req: HttpRequest,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const result = await this.health.ready(req.callerId);
    sendJson(res, result.httpStatus, result.body, {
      "Cache-Control": "no-store",
    });
  }
}
