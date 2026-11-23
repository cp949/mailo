import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { HttpRequest, HttpResponse } from "./types.js";

const logger = new Logger("http");

/**
 * 요청 ID를 붙이고 응답이 끝나면 한 줄 로그(`event: "http_request"`)를 남긴다.
 * 로그 항목은 `requestId`, `method`, `route`(라우트 패턴), `status`, `callerId`, `durationMs`뿐이다.
 * Nest 로거가 앱 JSON 로거에 연결돼 있어(`app.ts`) `ts`·`instance`·`level`이 함께 붙는다.
 * 원본 URL과 쿼리는 남기지 않는다. `Idempotency-Key`와 `jobId` 값이 요청 값이기 때문이다(RQ-027).
 * 헬스 요청은 프로브가 잦아 debug로 남긴다.
 */
export function requestContext(
  req: HttpRequest,
  res: HttpResponse,
  next: () => void,
): void {
  req.requestId = randomUUID();
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const route = req.route?.path ?? "-";
    const elapsedMs = Number(
      (process.hrtime.bigint() - startedAt) / 1_000_000n,
    );
    const fields = {
      event: "http_request",
      requestId: req.requestId,
      method: req.method ?? "-",
      route,
      status: res.statusCode,
      callerId: req.callerId ?? null,
      durationMs: elapsedMs,
    };
    if (route.startsWith("/health/")) logger.debug(fields);
    else logger.log(fields);
  });
  next();
}
