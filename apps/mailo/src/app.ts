import "reflect-metadata";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigError, DEFAULT_SMTP_ACCOUNT_ID } from "./config/index.js";
import {
  AppModule,
  DEFAULT_HTTP_TIMEOUTS,
  type AppModuleOptions,
} from "./app.module.js";
import {
  CALLER_REGISTRY,
  createMetricsAuthMiddleware,
  createOpsAuthMiddleware,
} from "./callers/index.js";
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
 * `default`가 아닌 SMTP 계정이 구성에 있으면 기동을 거부한다(ADR-0013 묶음 A의 방어, 묶음 B에서 제거).
 * 묶음 A의 `claim` 한 번은 모든 계정을 다루고 차단기 모드를 `default` 행 하나로 정한다. 비default 계정의 차단기는 open에서
 * 닫히지 않고, 계정 오류의 재시도 시각(`next_attempt_at`)이 과거로 쓰여 즉시 재점유·SMTP 연속 호출이 생길 수 있다.
 * 계정 파일 로더와 호출처 `accountId` 검증은 비default 계정을 그대로 받는다. 메시지에는 계정 ID만 싣는다(RQ-027).
 */
function assertDefaultAccountOnly(options: CreateAppOptions): void {
  if (options.allowNonDefaultAccounts === true) return;
  const others = options.config.smtpAccounts
    .map((a) => a.id)
    .filter((id) => id !== DEFAULT_SMTP_ACCOUNT_ID);
  if (others.length > 0)
    throw new ConfigError([
      `SMTP 계정 ${others.join(", ")}은 default가 아니라 이 버전에서 지원하지 않는다(계정 단위 점유는 ADR-0013 묶음 B 전이다. 설정에서 뺀다)`,
    ]);
}

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
  assertDefaultAccountOnly(createOptions);
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
  // `/metrics`도 같은 이유로 라우트 매칭 전에 인증한다. 읽기 토큰만 통과한다(ADR-0012 결정 1).
  server.use(
    "/metrics",
    createMetricsAuthMiddleware(app.get(CALLER_REGISTRY), options.config.ops),
  );
  return app;
}
