import { Inject, Injectable, Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type pg from "pg";
import { APP_CONFIG, type AppConfig } from "../config/index.js";
import { PG_POOL } from "../db/index.js";
import { getFeedLag } from "../events/index.js";
import { FILE_POLLER, type FilePollerRunner } from "../file-channel/index.js";
import {
  PRIORITIES,
  getBreakerState,
  getCallerPauseSummary,
  getQueueBacklog,
  getSendControlsSummary,
  type Priority,
} from "../queue/index.js";
import { WORKER_RUNNER, type WorkerRunner } from "../worker-port.js";
import { lastReasonOf } from "./breaker-reason.js";
import { withBoundedClient } from "./bounded-client.js";

const logger = new Logger("health");
const CHECK_TIMEOUT_MS = 3000;

/** 등급별 적체 값을 등급 이름 키의 객체로 펼친다. 키 순서는 `PRIORITIES`(LOW → URGENT)다. */
function byPriority<V, T>(
  values: Record<Priority, V>,
  pick: (value: V) => T,
): Record<Priority, T> {
  const result = {} as Record<Priority, T>;
  for (const p of PRIORITIES) result[p] = pick(values[p]);
  return result;
}

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
    /**
     * 호출처 키 호출에만 있다. 그 호출처에 해당하는 발송 정지 요약(ADR-0011 결정 2).
     * `all`과 `caller`가 함께 걸려 있으면 `all`이다. 호출처 ID·운영자 이름·시각은 담지 않는다.
     */
    sendPaused?: { paused: boolean; scope: "all" | "caller" | null };
    /** 운영자 토큰(읽기·관리) 호출에만 있다. 호출처 ID는 담지 않는다. */
    sendControls?: { allPaused: boolean; pausedCallerCount: number };
    /**
     * 운영자 토큰 호출에만 있다. 호출처 전체의 점유 대상 작업 적체(RQ-031).
     * `dueCount`는 상한(10000)에서 멈추고 `dueCountTruncated`가 true이면 더 있다.
     */
    queue?: {
      dueCount: number;
      dueCountTruncated: boolean;
      oldestDueAgeSeconds: number | null;
      /** 등급별 `dueCount`(RQ-037). 네 등급이 항상 키로 있다. 등급마다 상한(10000)이 따로 걸린다. */
      dueCountByPriority: Record<Priority, number>;
      /** 등급별 `dueCountTruncated`. true이면 그 등급에 상한보다 많은 작업이 있다. */
      dueCountTruncatedByPriority: Record<Priority, boolean>;
      /** 등급별 `oldestDueAgeSeconds`. 그 등급의 대기 작업이 없으면 null이다. */
      oldestDueAgeSecondsByPriority: Record<Priority, number | null>;
    };
    /** 운영자 토큰 호출에만 있다. 이 프로세스의 Worker 상태. 발송이 멈췄는지 가르는 신호다. */
    worker?:
      | { state: "disabled" }
      | {
          state: string;
          inFlight: number;
          lastPollAt: string | null;
          lastPollAgeSeconds: number | null;
          claimFailureStreak: number;
          pollLoopCrashed: boolean;
        };
    /** 운영자 토큰 호출에만 있다. 파일 채널이 꺼져 있으면 `enabled: false`뿐이다. */
    filePoller?:
      | { enabled: false }
      | {
          enabled: true;
          running: boolean;
          callers: number;
          lastPollAt: string | null;
          lastPollOk: boolean | null;
        };
  };
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * PostgreSQL 연결을 확인한다. 연결이 안 되면 503이다(RQ-031).
   * 차단기가 open·half_open이어도 200이다. 등록과 조회는 정상이라 오케스트레이터가 인스턴스를 내리면 안 된다.
   * `openUntil`과 `lastReason`은 SMTP 계정 상태를 드러내므로 인증된 호출에만 포함한다.
   * - `openUntil`: 상태가 open일 때만 값이 있고 그 밖에는 null이다.
   * - `lastReason`: 상태가 closed이면 null이다. closed에서도 마지막 실패 사유가 DB에 남지만 "열었던 사유"가 아니라서 숨긴다(추정).
   * SMTP 응답 텍스트와 계정 정보는 반환하지 않는다.
   * `eventFeed`는 인증된 호출처 자신의 피드 지연이다(RQ-017). 다른 호출처의 이벤트 시각은 드러나지 않는다.
   * 발송 정지(`PUT /ops/pauses/...`)와 Worker 정지·적체는 응답 코드에 반영하지 않는다. 정지 요약은 본문에만 둔다. 원인이 DB나 SMTP 계정이면 재시작이 도움이 안 되고,
   * 오탐이면 오케스트레이터가 정상 인스턴스를 재시작한다. 운영자 토큰 호출에만 `queue`·`worker`·`filePoller` 수치를 준다.
   * 점유 루프가 죽은 경우는 프로세스가 스스로 종료한다(main.ts, 종료 코드 70).
   * @param callerId 유효한 Bearer로 확인된 호출처. 인증 없으면 undefined.
   * @param isOperator 운영자 토큰으로 확인된 호출. 호출처 전체 수치를 본다.
   */
  async ready(
    callerId: string | undefined,
    isOperator = false,
  ): Promise<ReadyResult> {
    const authenticated = callerId !== undefined || isOperator;
    try {
      const { breaker, lag, backlog, sendPaused, sendControls } =
        await withBoundedClient(this.pool, CHECK_TIMEOUT_MS, async (client) => {
          await client.query("SELECT 1");
          const breaker = await getBreakerState(client, {
            breakerKey: this.config.worker.breaker.breakerKey,
          });
          const lag =
            callerId === undefined ? null : await getFeedLag(client, callerId);
          const backlog = isOperator
            ? await getQueueBacklog(
                client,
                this.config.smtpAccounts.map((a) => a.id),
              )
            : null;
          const sendPaused =
            callerId === undefined
              ? null
              : await getCallerPauseSummary(client, callerId);
          const sendControls = isOperator
            ? await getSendControlsSummary(client)
            : null;
          return { breaker, lag, backlog, sendPaused, sendControls };
        });
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
                      : lastReasonOf(breaker.lastReason),
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
          ...(sendPaused !== null ? { sendPaused } : {}),
          ...(sendControls !== null ? { sendControls } : {}),
          ...(backlog !== null
            ? {
                queue: {
                  dueCount: backlog.dueCount,
                  dueCountTruncated: backlog.truncated,
                  oldestDueAgeSeconds: backlog.oldestDueAgeSeconds,
                  dueCountByPriority: byPriority(
                    backlog.byPriority,
                    (v) => v.dueCount,
                  ),
                  dueCountTruncatedByPriority: byPriority(
                    backlog.byPriority,
                    (v) => v.truncated,
                  ),
                  oldestDueAgeSecondsByPriority: byPriority(
                    backlog.byPriority,
                    (v) => v.oldestDueAgeSeconds,
                  ),
                },
                worker: this.workerStatus(),
                filePoller: this.filePollerStatus(),
              }
            : {}),
        },
      };
    } catch (error) {
      // 원인 메시지에는 접속 정보가 섞일 수 있다. 클래스 이름과 pg 오류 코드만 남긴다.
      const code = (error as { code?: unknown } | null)?.code;
      logger.warn({
        event: "readiness_check_failed",
        name: error instanceof Error ? error.name : typeof error,
        code: typeof code === "string" ? code : null,
      });
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

  /** WORKER_RUNNER는 앱 모듈이 제공한다. 헬스 모듈에서 보이지 않아 `ModuleRef`로 찾는다. */
  private workerStatus(): NonNullable<ReadyResult["body"]["worker"]> {
    const runner = this.moduleRef.get<WorkerRunner>(WORKER_RUNNER, {
      strict: false,
    });
    const status = runner.status?.();
    if (status === undefined) return { state: "disabled" };
    return {
      state: status.state,
      inFlight: status.inFlight,
      lastPollAt: status.lastPollAt?.toISOString() ?? null,
      lastPollAgeSeconds: status.lastPollAgeSeconds,
      claimFailureStreak: status.claimFailureStreak,
      pollLoopCrashed: status.pollLoopCrashed,
    };
  }

  private filePollerStatus(): NonNullable<ReadyResult["body"]["filePoller"]> {
    const poller = this.moduleRef.get<FilePollerRunner>(FILE_POLLER, {
      strict: false,
    });
    const status = poller.status?.();
    if (status === undefined) return { enabled: false };
    return {
      enabled: true,
      running: status.running,
      callers: status.callers,
      lastPollAt: status.lastPollAt?.toISOString() ?? null,
      lastPollOk: status.lastPollOk,
    };
  }
}
