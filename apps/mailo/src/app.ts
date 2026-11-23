import "reflect-metadata";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  AppModule,
  DEFAULT_HTTP_TIMEOUTS,
  type AppModuleOptions,
} from "./app.module.js";
import {
  requestContext,
  type HttpRequest,
  type HttpResponse,
} from "./http/index.js";

/**
 * 앱을 만든다. main.ts와 통합 테스트가 같은 설정을 쓴다.
 * - 본문 파서를 끈다. `POST /jobs`가 인증 뒤에 크기 상한(2 MiB)을 적용하며 직접 읽는다(RQ-030).
 * - 요청 ID·요청 로그 미들웨어를 맨 앞에 둔다.
 * - 요청·헤더 수신 시간 상한을 둔다(기본 30초). 본문을 다 보내지 않는 연결이 오래 남지 않게 한다.
 *   종료 때의 상한은 `AppLifecycle`이 따로 건다(Node는 `server.close()` 뒤 이 시간제한 점검을 멈춘다).
 */
export async function createApp(
  options: AppModuleOptions,
): Promise<INestApplication> {
  const httpTimeouts = options.http ?? DEFAULT_HTTP_TIMEOUTS;
  const app = await NestFactory.create(AppModule.forRoot(options), {
    bodyParser: false,
    // 기동 중 오류를 process.abort() 대신 reject로 올린다. main.ts가 이름·코드만 출력하고 exit(1)한다.
    abortOnError: false,
    // 운영은 debug를 끈다. 헬스 프로브 요청 로그가 debug라서 프로브마다 한 줄씩 쌓이지 않게 한다.
    logger:
      options.config.env === "production"
        ? ["log", "warn", "error"]
        : ["log", "warn", "error", "debug"],
  });
  const server = app.getHttpAdapter().getInstance() as {
    disable(name: string): void;
    use(
      handler: (req: HttpRequest, res: HttpResponse, next: () => void) => void,
    ): void;
  };
  // `connectionsCheckingInterval`은 Node 런타임에는 있으나 타입 정의에 없다.
  const httpServer = app.getHttpServer() as Server & {
    connectionsCheckingInterval: number;
  };
  httpServer.requestTimeout = httpTimeouts.requestTimeoutMs;
  httpServer.headersTimeout = httpTimeouts.headersTimeoutMs;
  if (httpTimeouts.checkIntervalMs !== undefined)
    httpServer.connectionsCheckingInterval = httpTimeouts.checkIntervalMs;
  server.disable("x-powered-by");
  server.use(requestContext);
  return app;
}
