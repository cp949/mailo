import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { ValidationErrorItem } from "../validation/index.js";
import { ProblemException, problems } from "./problem.js";
import type { HttpRequest, HttpResponse } from "./types.js";

const logger = new Logger("http");

/**
 * problem+json 응답을 쓴다. 필터와, Nest 밖(Express 미들웨어)에서 먼저 거절하는 곳이 같은 형식을 쓰게 한다.
 * 헤더를 이미 보냈으면 연결만 닫는다.
 */
export function sendProblem(
  res: HttpResponse,
  requestId: string,
  problem: ProblemException,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(problem.toBody(requestId));
  res.statusCode = problem.status;
  res.setHeader("Content-Type", "application/problem+json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  for (const [name, value] of Object.entries(problem.options.headers ?? {}))
    res.setHeader(name, value);
  res.end(body);
}

/**
 * 모든 오류를 `application/problem+json`으로 바꾼다(docs/api/README.md "오류 형식").
 * 예상하지 못한 오류는 503이다. DB 장애 등 내부 오류는 relay가 같은 Key로 재시도하는 응답이다(ADR-0005 결정 5).
 * 로그에는 오류 클래스 이름과 pg 오류 코드만 남긴다. 메시지에는 쿼리 파라미터나 값이 섞일 수 있다(RQ-027).
 */
@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<HttpRequest>();
    const res = http.getResponse<HttpResponse>();
    const problem = this.toProblem(exception, req);
    sendProblem(res, req.requestId, problem);
  }

  private toProblem(exception: unknown, req: HttpRequest): ProblemException {
    if (exception instanceof ProblemException) return exception;
    // Express가 경로 파라미터의 퍼센트 인코딩을 풀지 못해 던진 오류(예: `/jobs/%`).
    // Nest 어댑터가 URIError를 BadRequestException("Failed to decode param ...")으로 바꿔 전달한다.
    // 경로 파라미터는 `/jobs/{jobId}`·`/jobs/{jobId}/cancel`의 jobId와 `/ops/jobs/{jobId}`·`/ops/pauses/callers/{callerId}`뿐이다.
    // 이 경로만 validation-failed로 보고 나머지는 404다(ADR-0011 결정 7).
    if (isParamDecodeError(exception)) {
      const errors = paramDecodeErrors(req.url);
      return errors ? problems.validationFailed(errors) : problems.notFound();
    }
    if (exception instanceof HttpException) {
      // 라우트 없음 등 Nest가 던진 오류. 메시지는 버리고 상태 코드만 계약 type에 대응시킨다.
      const status = exception.getStatus();
      if (status === 404) return problems.notFound();
      if (status === 413) return problems.payloadTooLarge();
      if (status === 415) return problems.unsupportedMediaType();
      if (status >= 400 && status < 500) return problems.malformedRequest();
    }
    const code = (exception as { code?: unknown } | null)?.code;
    logger.error({
      event: "unhandled_error",
      requestId: req.requestId,
      name: exception instanceof Error ? exception.name : typeof exception,
      code: typeof code === "string" ? code : null,
    });
    return problems.serviceUnavailable();
  }
}

/** 퍼센트 디코딩에 실패한 경로 파라미터의 위치. 경로 파라미터가 없는 경로는 null이다. */
function paramDecodeErrors(
  url: string | undefined,
): ValidationErrorItem[] | null {
  if (url === undefined) return null;
  if (url.startsWith("/jobs/") || url.startsWith("/ops/jobs/"))
    return [{ parameter: "jobId", code: "INVALID_FORMAT" }];
  if (url.startsWith("/ops/pauses/callers/"))
    return [{ parameter: "callerId", code: "INVALID_FORMAT" }];
  return null;
}

function isParamDecodeError(exception: unknown): boolean {
  if (exception instanceof URIError) return true;
  return (
    exception instanceof HttpException &&
    exception.getStatus() === 400 &&
    exception.message.startsWith("Failed to decode param")
  );
}
