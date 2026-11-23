import { Controller, Get, Res, UseGuards } from "@nestjs/common";
import { MetricsReadGuard } from "../callers/index.js";
import type { HttpResponse } from "../http/index.js";
import { MetricsService } from "./metrics.service.js";

/**
 * Prometheus 텍스트 형식 `GET /metrics`(RQ-049, ADR-0012 결정 1·2). 읽기 토큰만 받는다(`MetricsReadGuard`).
 * 인증 오류 외에는 항상 200이다. DB 조회가 실패해도 200이고 해당 그룹은 응답에서 빠지며 `mailo_metrics_collect_ok`가 0이다.
 * `/health/ready`의 DB 장애 503과 목적이 다르다. DB가 죽은 동안에도 인스턴스 counter와 `collect_ok=0` 신호가 수집돼야 한다.
 */
@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @UseGuards(MetricsReadGuard)
  async scrape(@Res() res: HttpResponse): Promise<void> {
    const text = await this.metrics.render();
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(text));
    res.setHeader("Cache-Control", "no-store");
    res.end(text);
  }
}
