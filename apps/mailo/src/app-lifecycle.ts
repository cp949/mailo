import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type pg from "pg";
import { PG_POOL, POOL_OWNED } from "./db/index.js";
import { FILE_POLLER, type FilePollerRunner } from "./file-channel/index.js";
import { WORKER_RUNNER, type WorkerRunner } from "./worker-port.js";

/**
 * 기동·종료 순서를 한곳에서 정한다.
 * 기동: 파일 폴러(root 검증이 실패하면 아무것도 켜지 않고 기동 실패) → Worker.
 * 종료: Nest가 HTTP 서버를 닫은 뒤(새 등록 차단, 진행 중 요청은 끝까지 처리) 이 훅이 파일 폴러를 멈추고
 * (새 파일 중단, 진행 중 파일의 등록·삭제 완료) Worker를 멈추고(새 점유 중지, 진행 중 전송 대기) 마지막에 DB 풀을 닫는다.
 * 풀을 먼저 닫으면 진행 중 파일·전송이 결과를 기록하지 못한다.
 */
@Injectable()
export class AppLifecycle
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  constructor(
    @Inject(WORKER_RUNNER) private readonly runner: WorkerRunner,
    @Inject(FILE_POLLER) private readonly filePoller: FilePollerRunner,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(POOL_OWNED) private readonly poolOwned: boolean,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.filePoller.start();
    await this.runner.start();
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      try {
        await this.filePoller.stop();
      } finally {
        await this.runner.stop();
      }
    } finally {
      if (this.poolOwned) await this.pool.end();
    }
  }
}
