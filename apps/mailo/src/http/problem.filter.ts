import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { ProblemException, problems } from "./problem.js";
import type { HttpRequest, HttpResponse } from "./types.js";

const logger = new Logger("http");

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

    if (res.headersSent) {
      res.end();
      return;
    }
    const body = JSON.stringify(problem.toBody(req.requestId));
    res.statusCode = problem.status;
    res.setHeader("Content-Type", "application/problem+json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    for (const [name, value] of Object.entries(problem.options.headers ?? {}))
      res.setHeader(name, value);
    res.end(body);
  }

  private toProblem(exception: unknown, req: HttpRequest): ProblemException {
    if (exception instanceof ProblemException) return exception;
    if (exception instanceof HttpException) {
      // 라우트 없음 등 Nest가 던진 오류. 메시지는 버리고 상태 코드만 계약 type에 대응시킨다.
      const status = exception.getStatus();
      if (status === 404) return problems.notFound();
      if (status === 413) return problems.payloadTooLarge();
      if (status === 415) return problems.unsupportedMediaType();
      if (status >= 400 && status < 500) return problems.malformedRequest();
    }
    const code = (exception as { code?: unknown } | null)?.code;
    logger.error(
      `unhandled error requestId=${req.requestId} name=${
        exception instanceof Error ? exception.name : typeof exception
      }${typeof code === "string" ? ` code=${code}` : ""}`,
    );
    return problems.serviceUnavailable();
  }
}
