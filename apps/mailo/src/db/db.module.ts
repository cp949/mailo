import { Global, Logger, Module, type DynamicModule } from "@nestjs/common";
import type pg from "pg";
import { APP_CONFIG, toPgSsl, type AppConfig } from "../config/index.js";
import { createPool } from "./pool.js";
import { PG_POOL, POOL_OWNED } from "./tokens.js";

const logger = new Logger("db");

/**
 * `pg.Pool` 제공. `pool`을 넘기면 그 풀을 쓰고(테스트), 없으면 설정으로 만든다.
 * 만든 풀은 앱이 소유한다(`POOL_OWNED`=true). 종료 때 닫는 일은 앱 수명주기가 Worker 정지 뒤에 한다.
 */
@Global()
@Module({})
export class DbModule {
  static forRoot(options: { pool?: pg.Pool } = {}): DynamicModule {
    return {
      module: DbModule,
      providers: [
        {
          provide: PG_POOL,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): pg.Pool => {
            if (options.pool) return options.pool;
            const ssl = toPgSsl(config.database.ssl);
            const pool = createPool(config.database.url.reveal(), {
              ...(ssl !== undefined && { ssl }),
              max: config.database.poolMax,
              connectionTimeoutMillis: config.database.connectTimeoutMs,
              statementTimeoutMillis: config.database.timeouts.statementMs,
              lockTimeoutMillis: config.database.timeouts.lockMs,
              idleInTransactionSessionTimeoutMillis:
                config.database.timeouts.idleInTransactionMs,
              queryTimeoutMillis: config.database.timeouts.queryMs,
              // 조용히 끊긴 연결은 query_timeout이 상한을 정한다. keepalive는 유휴 연결의 단절을 커널이 알게 하는 보조 수단이다.
              keepAlive: { initialDelayMillis: 10_000 },
            });
            // 유휴 연결 오류를 처리하지 않으면 프로세스가 종료된다. 메시지에는 접속 정보가 섞일 수 있어 이름과 코드만 남긴다.
            pool.on("error", (error: Error & { code?: string }) => {
              logger.error({
                event: "db_idle_client_error",
                name: error.name,
                code: error.code ?? null,
              });
            });
            return pool;
          },
        },
        { provide: POOL_OWNED, useValue: options.pool === undefined },
      ],
      exports: [PG_POOL, POOL_OWNED],
    };
  }
}
