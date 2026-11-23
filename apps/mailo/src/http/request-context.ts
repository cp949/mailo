import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { HttpRequest, HttpResponse } from "./types.js";

const logger = new Logger("http");

/**
 * 요청 ID를 붙이고 응답이 끝나면 한 줄 로그를 남긴다.
 * 로그 항목은 요청 ID, 메서드, 라우트 패턴, 상태 코드, 호출처 ID, 소요 시간이다.
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
    const line =
      `request requestId=${req.requestId} method=${req.method ?? "-"} route=${route} ` +
      `status=${res.statusCode} caller=${req.callerId ?? "-"} ms=${elapsedMs}`;
    if (route.startsWith("/health/")) logger.debug(line);
    else logger.log(line);
  });
  next();
}
