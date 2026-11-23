import "reflect-metadata";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  AppModule,
  DEFAULT_HTTP_TIMEOUTS,
  type AppModuleOptions,
} from "./app.module.js";
import { CALLER_REGISTRY, createOpsAuthMiddleware } from "./callers/index.js";
import {
  requestContext,
  type HttpRequest,
  type HttpResponse,
} from "./http/index.js";
import {
  createNestLogger,
  createStdoutLogger,
  type AppLogger,
} from "./logging/index.js";

/** `createApp` 옵션. 로거는 생략하면 표준 출력 JSON 로거를 여기서 한 번 만든다(테스트가 수집기를 넣는다). */
export type CreateAppOptions = Omit<AppModuleOptions, "logger"> & {
  logger?: AppLogger;
};

/**
 * 앱을 만든다. main.ts와 통합 테스트가 같은 설정을 쓴다.
 * - 본문 파서를 끈다. `POST /jobs`가 인증 뒤에 크기 상한(2 MiB)을 적용하며 직접 읽는다(RQ-030).
 * - 요청 ID·요청 로그 미들웨어를 맨 앞에 둔다.
 * - 요청·헤더 수신 시간 상한을 둔다(기본 30초). 본문을 다 보내지 않는 연결이 오래 남지 않게 한다.
 *   종료 때의 상한은 `AppLifecycle`이 따로 건다(Node는 `server.close()` 뒤 이 시간제한 점검을 멈춘다).
 */
export async function createApp(
  createOptions: CreateAppOptions,
): Promise<INestApplication> {
  // 앱의 로거는 이 한 곳에서 만든다. Worker·파일 폴러는 DI(APP_LOGGER)로, Nest와 HTTP 계층은 Nest 로거 어댑터로 받아
  // 모든 로그가 `{ts, instance, level, event, ...}` 한 줄 JSON이 된다(M10).
  const logger =
    createOptions.logger ??
    createStdoutLogger({ instance: createOptions.config.instanceId });
  const options: AppModuleOptions = { ...createOptions, logger };
  const httpTimeouts = options.http ?? DEFAULT_HTTP_TIMEOUTS;
  const app = await NestFactory.create(AppModule.forRoot(options), {
    bodyParser: false,
    // 기동 중 오류를 process.abort() 대신 reject로 올린다. main.ts가 이름·코드만 출력하고 exit(1)한다.
    abortOnError: false,
    // 운영은 debug를 끈다. 헬스 프로브 요청 로그가 debug라서 프로브마다 한 줄씩 쌓이지 않게 한다.
    // 인스턴스를 직접 넘기면 부트스트랩 로그도 처음부터 JSON이라 bufferLogs가 필요 없다.
    logger: createNestLogger(logger, {
      debug: options.config.env !== "production",
    }),
  });
  const server = app.getHttpAdapter().getInstance() as {
    disable(name: string): void;
    use(
      handler: (req: HttpRequest, res: HttpResponse, next: () => void) => void,
    ): void;
    use(
      path: string,
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
  // `/ops` 인증은 라우트 매칭 전에 한다. 경로 파라미터 디코딩 오류가 인증보다 먼저 나가지 않게 한다(ADR-0011 결정 7).
  server.use(
    "/ops",
    createOpsAuthMiddleware(app.get(CALLER_REGISTRY), options.config.ops),
  );
  return app;
}
