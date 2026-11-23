import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { WorkerRunner } from "../../src/worker-port.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { migrate } from "../support/queue-fixtures.js";
import { startRestApp } from "../support/rest-app.js";

describe("앱 수명주기: WorkerRunner 연결(RQ-025, ADR-0002 결정 12)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  afterAll(async () => {
    await db.close();
  });

  it("기동 때 start 한 번, 종료 때 HTTP 서버를 닫은 뒤 stop을 부르고, 외부에서 받은 풀은 닫지 않는다", async () => {
    const events: string[] = [];
    let baseUrl = "";
    const runner: WorkerRunner = {
      async start() {
        events.push("start");
      },
      async stop() {
        // 이 시점에 HTTP 서버는 이미 닫혀 있어야 한다. 새 등록이 막힌 뒤에 진행 중 전송을 기다린다.
        const reachable = await fetch(`${baseUrl}/health/live`).then(
          () => true,
          () => false,
        );
        events.push(reachable ? "stop(http 열림)" : "stop(http 닫힘)");
      },
    };
    const app = await startRestApp({ pool: db.pool, workerRunner: runner });
    baseUrl = app.baseUrl;
    expect(events).toEqual(["start"]);

    await app.app.close();

    expect(events).toEqual(["start", "stop(http 닫힘)"]);
    await expect(db.pool.query("SELECT 1")).resolves.toBeDefined();
    app.logs.stop();
  });

  it("start가 실패하면 앱이 기동하지 않는다", async () => {
    const runner: WorkerRunner = {
      async start() {
        throw new Error("start failed");
      },
      async stop() {},
    };

    await expect(
      startRestApp({ pool: db.pool, workerRunner: runner }),
    ).rejects.toThrow("start failed");
  });

  it("WorkerRunner가 없으면 no-op으로 기동하고 종료한다", async () => {
    const app = await startRestApp({ pool: db.pool });

    const res = await fetch(`${app.baseUrl}/health/live`);

    expect(res.status).toBe(200);
    await app.close();
  });
});
