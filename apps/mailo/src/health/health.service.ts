import { Inject, Injectable, Logger } from "@nestjs/common";
import type pg from "pg";
import { APP_CONFIG, type AppConfig } from "../config/index.js";
import { PG_POOL } from "../db/index.js";
import { getFeedLag } from "../events/index.js";
import { getBreakerState } from "../queue/index.js";

const logger = new Logger("health");
const CHECK_TIMEOUT_MS = 3000;

/** 큐의 차단기 사유(`AccountErrorReason`)를 계약의 `lastReason` 값으로 바꾼다. 알 수 없는 값은 `OTHER`다. */
const LAST_REASON: Record<string, string> = {
  AUTH: "AUTH_FAILED",
  TLS: "TLS_FAILED",
  CONNECTION: "CONNECTION_FAILED",
  DAILY_LIMIT: "QUOTA_DAILY",
  RATE_LIMIT: "QUOTA_BURST",
  OTHER: "OTHER",
};

export interface ReadyResult {
  httpStatus: 200 | 503;
  body: {
    status: "UP" | "DOWN";
    checks: { database: "UP" | "DOWN" };
    circuitBreaker: {
      state: "closed" | "open" | "half_open" | "unknown";
      openUntil?: string | null;
      lastReason?: string | null;
    };
    /** 인증된 호출에만 있다. 호출처 자신의 이벤트 피드 지연(RQ-017). */
    eventFeed?: { latestEventAt: string | null; lagSeconds: number | null };
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * PostgreSQL 연결을 확인한다. 연결이 안 되면 503이다(RQ-031).
   * 차단기가 open·half_open이어도 200이다. 등록과 조회는 정상이라 오케스트레이터가 인스턴스를 내리면 안 된다.
   * `openUntil`과 `lastReason`은 SMTP 계정 상태를 드러내므로 인증된 호출에만 포함한다.
   * - `openUntil`: 상태가 open일 때만 값이 있고 그 밖에는 null이다.
   * - `lastReason`: 상태가 closed이면 null이다. closed에서도 마지막 실패 사유가 DB에 남지만 "열었던 사유"가 아니라서 숨긴다(추정).
   * SMTP 응답 텍스트와 계정 정보는 반환하지 않는다.
   * `eventFeed`는 인증된 호출처 자신의 피드 지연이다(RQ-017). 다른 호출처의 이벤트 시각은 드러나지 않는다.
   * @param callerId 유효한 Bearer로 확인된 호출처. 인증 없으면 undefined.
   */
  async ready(callerId: string | undefined): Promise<ReadyResult> {
    const authenticated = callerId !== undefined;
    try {
      const { breaker, lag } = await withTimeout(
        (async () => {
          await this.pool.query("SELECT 1");
          const breaker = await getBreakerState(this.pool, {
            breakerKey: this.config.worker.breaker.breakerKey,
          });
          const lag =
            callerId === undefined
              ? null
              : await getFeedLag(this.pool, callerId);
          return { breaker, lag };
        })(),
        CHECK_TIMEOUT_MS,
      );
      return {
        httpStatus: 200,
        body: {
          status: "UP",
          checks: { database: "UP" },
          circuitBreaker: {
            state: breaker.state,
            ...(authenticated
              ? {
                  openUntil:
                    breaker.state === "open" && breaker.openUntil
                      ? breaker.openUntil.toISOString()
                      : null,
                  lastReason:
                    breaker.state === "closed" || breaker.lastReason === null
                      ? null
                      : (LAST_REASON[breaker.lastReason] ?? "OTHER"),
                }
              : {}),
          },
          ...(lag !== null
            ? {
                eventFeed: {
                  latestEventAt: lag.latestEventAt?.toISOString() ?? null,
                  lagSeconds: lag.lagSeconds,
                },
              }
            : {}),
        },
      };
    } catch (error) {
      // 원인 메시지에는 접속 정보가 섞일 수 있다. 클래스 이름과 pg 오류 코드만 남긴다.
      const code = (error as { code?: unknown } | null)?.code;
      logger.warn(
        `readiness check failed name=${error instanceof Error ? error.name : typeof error}${
          typeof code === "string" ? ` code=${code}` : ""
        }`,
      );
      return {
        httpStatus: 503,
        body: {
          status: "DOWN",
          checks: { database: "DOWN" },
          circuitBreaker: { state: "unknown" },
        },
      };
    }
  }
}
