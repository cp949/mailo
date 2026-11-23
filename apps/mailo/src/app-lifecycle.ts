import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { Server } from "node:http";
import type pg from "pg";
import type { HttpServerTimeouts } from "./app.module.js";
import { PG_POOL, POOL_OWNED } from "./db/index.js";
import { FILE_POLLER, type FilePollerRunner } from "./file-channel/index.js";
import { WORKER_RUNNER, type WorkerRunner } from "./worker-port.js";

/** HTTP 시간제한 주입 토큰. 종료 때 HTTP 닫기를 기다리는 상한에 쓴다. */
export const HTTP_TIMEOUTS = Symbol("HTTP_TIMEOUTS");

/**
 * 기동·종료 순서를 한곳에서 정한다(ADR-0002 결정 12, RQ-025).
 * 기동: 파일 폴러(root 검증이 실패하면 아무것도 켜지 않고 기동 실패) → Worker.
 * 종료(SIGTERM):
 *   1. `beforeApplicationShutdown`: Worker `pause()`(새 점유 중지, 진행 중 전송은 계속)와 파일 폴러 `stop()` 시작
 *      (새 파일 중단, 진행 중 파일의 등록·삭제 완료). 둘 다 HTTP 서버를 닫기 전에 시작한다.
 *      HTTP를 먼저 닫으면 느린 요청이 끝날 때까지 Worker가 계속 점유한다.
 *   2. Nest가 HTTP 서버를 닫는다(새 연결 차단, 유휴 연결 종료, 진행 중 요청은 끝까지 처리).
 *      Node는 `server.close()` 뒤 요청 시간제한 점검을 멈추므로, 본문을 다 보내지 않는 요청이 닫기를 영원히 붙잡을 수 있다.
 *      그래서 1에서 `requestTimeoutMs` 타이머를 걸고 시간이 지나면 남은 연결을 강제로 끊는다.
 *   3. `onApplicationShutdown`: 파일 폴러 정지를 기다리고 Worker `stop()`(진행 중 전송 drain)을 기다린다.
 *   4. DB 풀을 닫는다. 풀을 먼저 닫으면 진행 중 파일·전송이 결과를 기록하지 못한다.
 * drain 시간 상한은 1에서 시작한다. 상한을 넘으면 Worker가 lease를 풀지 않고 전송을 끊는다.
 */
@Injectable()
export class AppLifecycle
  implements
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  private pollerStopping: Promise<void> | undefined;
  private forceCloseTimer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(WORKER_RUNNER) private readonly runner: WorkerRunner,
    @Inject(FILE_POLLER) private readonly filePoller: FilePollerRunner,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(POOL_OWNED) private readonly poolOwned: boolean,
    @Inject(HttpAdapterHost) private readonly httpHost: HttpAdapterHost,
    @Inject(HTTP_TIMEOUTS) private readonly httpTimeouts: HttpServerTimeouts,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.filePoller.start();
    await this.runner.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    // 폴러 정지는 시작만 하고 기다리지 않는다. HTTP 서버 닫기와 겹쳐 진행한다.
    this.startPollerStop();
    this.scheduleHttpForceClose();
    await this.runner.pause();
  }

  async onApplicationShutdown(): Promise<void> {
    clearTimeout(this.forceCloseTimer);
    try {
      try {
        await this.startPollerStop();
      } finally {
        await this.runner.stop();
      }
    } finally {
      if (this.poolOwned) await this.pool.end();
    }
  }

  /** 유휴 연결을 닫고, 요청 시간제한이 지나도 남은 연결은 강제로 끊는다. */
  private scheduleHttpForceClose(): void {
    const server = this.httpHost.httpAdapter?.getHttpServer() as
      | Server
      | undefined;
    if (!server?.listening) return;
    server.closeIdleConnections();
    this.forceCloseTimer = setTimeout(() => {
      server.closeAllConnections();
    }, this.httpTimeouts.requestTimeoutMs);
    this.forceCloseTimer.unref();
  }

  private startPollerStop(): Promise<void> {
    if (!this.pollerStopping) {
      this.pollerStopping = this.filePoller.stop();
      // 기다리는 쪽(onApplicationShutdown)이 나중에 오류를 받는다. 그 전에 미처리 거부로 보고되지 않게 한다.
      this.pollerStopping.catch(() => undefined);
    }
    return this.pollerStopping;
  }
}
