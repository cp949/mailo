import { Module, type DynamicModule } from "@nestjs/common";
import type pg from "pg";
import { AppLifecycle, HTTP_TIMEOUTS } from "./app-lifecycle.js";
import {
  CALLER_REGISTRY,
  CallersModule,
  type CallerRegistry,
} from "./callers/index.js";
import { APP_CONFIG, ConfigModule, type AppConfig } from "./config/index.js";
import {
  CryptoModule,
  QUEUE_BODY_CIPHER,
  QUEUE_FINGERPRINTER,
  type QueueBodyCipher,
  type QueueFingerprinter,
} from "./crypto/index.js";
import { DbModule, PG_POOL } from "./db/index.js";
import { ENVELOPE_DEPS, EnvelopeModule } from "./envelope/index.js";
import type { OpenRequestDeps } from "./envelope/index.js";
import {
  FILE_POLLER,
  NoopFilePoller,
  createFilePoller,
  type FilePollerRunner,
} from "./file-channel/index.js";
import { EventsModule } from "./events/index.js";
import { HealthModule } from "./health/index.js";
import { HttpModule } from "./http/index.js";
import { IntakeModule } from "./intake/index.js";
import { APP_LOGGER, type AppLogger } from "./logging/index.js";
import { QueueModule } from "./queue/index.js";
import { SmtpModule, type MailSender } from "./smtp/index.js";
import { createWorkerRunner } from "./worker/index.js";
import {
  NoopWorkerRunner,
  WORKER_RUNNER,
  type WorkerRunner,
} from "./worker-port.js";

/** HTTP 서버 시간제한(ms). 느린 요청이 연결을 오래 붙잡지 못하게 하고, 종료 때 HTTP 닫기의 대기 상한이 된다. */
export interface HttpServerTimeouts {
  /** 요청 전체(헤더+본문)를 받는 시간 상한. 넘기면 Node가 408로 응답하고 연결을 닫는다. */
  requestTimeoutMs: number;
  /** 헤더를 받는 시간 상한. Node는 `headersTimeout <= requestTimeout`을 요구한다. */
  headersTimeoutMs: number;
  /** Node가 시간 초과 연결을 훑는 간격. 생략하면 Node 기본값(30초)이다. 테스트가 줄인다. */
  checkIntervalMs?: number;
}

/** 운영 기본값. 환경 변수로 받지 않는 상수다. 본문 상한이 2 MiB라 30초면 정상 클라이언트에 충분하다(RQ-030). */
export const DEFAULT_HTTP_TIMEOUTS: HttpServerTimeouts = {
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 30_000,
};

export interface AppModuleOptions {
  config: AppConfig;
  /** 앱이 공유하는 JSON 로거. `createApp`이 한 곳에서 만들어 Worker·파일 폴러에 DI로 전달한다(M10). */
  logger: AppLogger;
  /** 설정을 읽은 환경 변수. 호출처 JWS 비밀키와 JWE 개인키를 이 맵에서 읽는다. 없으면 `process.env`다. */
  env?: NodeJS.ProcessEnv;
  /** 외부에서 만든 풀. 테스트가 전용 schema 풀을 넘긴다. 없으면 설정으로 만들고 종료 때 닫는다. */
  pool?: pg.Pool;
  /** Worker 구현을 직접 주입한다(테스트). 있으면 `worker`는 무시한다. */
  workerRunner?: WorkerRunner;
  /**
   * 설정으로 실제 Worker를 만들어 기동한다. main.ts가 쓴다. `workerRunner`도 없으면 아무것도 발송하지 않는다.
   * - `trustedCa`: 사설 relay·테스트 서버 인증서를 신뢰할 CA(PEM). 검증을 끄지 않는다.
   * - `sender`: 발송기 직접 주입(테스트).
   */
  worker?: { trustedCa?: string; sender?: MailSender };
  /**
   * Worker 점유 루프가 예외로 끝났을 때 부른다(`WorkerDeps.onFatal`). main.ts가 정상 종료 경로를 거쳐 프로세스를 끝낸다.
   * `worker`로 만든 실제 Worker에만 적용된다.
   */
  onWorkerFatal?: (reason: "poll_loop_crashed") => void;
  /** HTTP 서버 시간제한. 생략하면 `DEFAULT_HTTP_TIMEOUTS`(30초)다. */
  http?: HttpServerTimeouts;
}

@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(options.config, options.env),
        DbModule.forRoot(options.pool ? { pool: options.pool } : {}),
        HttpModule,
        CallersModule,
        CryptoModule,
        EnvelopeModule,
        IntakeModule,
        QueueModule,
        SmtpModule,
        EventsModule,
        HealthModule,
      ],
      providers: [
        { provide: APP_LOGGER, useValue: options.logger },
        {
          provide: WORKER_RUNNER,
          inject: [
            PG_POOL,
            APP_CONFIG,
            QUEUE_BODY_CIPHER,
            CALLER_REGISTRY,
            APP_LOGGER,
          ],
          useFactory: (
            pool: pg.Pool,
            config: AppConfig,
            bodyCipher: QueueBodyCipher,
            registry: CallerRegistry,
            logger: AppLogger,
          ): WorkerRunner => {
            if (options.workerRunner) return options.workerRunner;
            if (!options.worker) return new NoopWorkerRunner();
            return createWorkerRunner({
              pool,
              config,
              bodyCipher,
              logger,
              // 호출처별 24시간 발송 할당(RQ-032). 레지스트리는 기동 때 한 번 읽으므로 변경은 재시작 뒤 반영된다.
              callerQuotas: new Map(
                registry.callers.flatMap((c) =>
                  c.sendQuota24h === null
                    ? []
                    : ([[c.id, c.sendQuota24h]] as const),
                ),
              ),
              ...(options.worker.trustedCa !== undefined && {
                trustedCa: options.worker.trustedCa,
              }),
              ...(options.worker.sender && { sender: options.worker.sender }),
              ...(options.onWorkerFatal && { onFatal: options.onWorkerFatal }),
            });
          },
        },
        {
          // 파일 채널은 `MAILO_FILE_CHANNEL_ROOT`가 있을 때만 켠다(기본 꺼짐, ADR-0004).
          provide: FILE_POLLER,
          inject: [
            PG_POOL,
            APP_CONFIG,
            CALLER_REGISTRY,
            ENVELOPE_DEPS,
            QUEUE_BODY_CIPHER,
            QUEUE_FINGERPRINTER,
            APP_LOGGER,
          ],
          useFactory: (
            pool: pg.Pool,
            config: AppConfig,
            registry: CallerRegistry,
            envelope: OpenRequestDeps,
            cipher: QueueBodyCipher,
            fingerprinter: QueueFingerprinter,
            logger: AppLogger,
          ): FilePollerRunner => {
            const { fileChannel } = config;
            if (fileChannel.root === null) {
              const configured = registry.callers.filter(
                (c) => c.fileChannel,
              ).length;
              if (configured > 0)
                logger.warn("file_channel_disabled", { callers: configured });
              return new NoopFilePoller();
            }
            return createFilePoller({
              pool,
              registry,
              envelope,
              cipher,
              fingerprinter,
              config: { ...fileChannel, root: fileChannel.root },
              jobExpirySeconds: config.queue.jobExpirySeconds,
              defaultFrom: config.smtp.defaultFrom,
              logger,
            });
          },
        },
        {
          provide: HTTP_TIMEOUTS,
          useValue: options.http ?? DEFAULT_HTTP_TIMEOUTS,
        },
        AppLifecycle,
      ],
    };
  }
}
