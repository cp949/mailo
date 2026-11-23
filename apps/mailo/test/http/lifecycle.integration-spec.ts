import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import net from "node:net";
import type { WorkerRunner } from "../../src/worker-port.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { migrate } from "../support/queue-fixtures.js";
import { ALPHA_KEY, startRestApp } from "../support/rest-app.js";

describe("앱 수명주기: WorkerRunner 연결(RQ-025, ADR-0002 결정 12)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  afterAll(async () => {
    await db.close();
  });

  it("기동 때 start 한 번, 종료 때 pause를 먼저 부르고 HTTP 서버를 닫은 뒤 stop을 부르며, 외부에서 받은 풀은 닫지 않는다", async () => {
    const events: string[] = [];
    let baseUrl = "";
    const runner: WorkerRunner = {
      async start() {
        events.push("start");
      },
      async pause() {
        events.push("pause");
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

    expect(events).toEqual(["start", "pause", "stop(http 닫힘)"]);
    await expect(db.pool.query("SELECT 1")).resolves.toBeDefined();
    app.logs.stop();
  });

  it("start가 실패하면 앱이 기동하지 않는다", async () => {
    const runner: WorkerRunner = {
      async start() {
        throw new Error("start failed");
      },
      async pause() {},
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

  it("본문을 다 보내지 않은 느린 POST가 열린 채 종료해도 Worker를 먼저 멈추고 시간제한 안에 종료한다 (ADR-0002 결정 12, RQ-025)", async () => {
    const events: string[] = [];
    const runner: WorkerRunner = {
      async start() {},
      async pause() {
        events.push("pause");
      },
      async stop() {
        events.push("stop");
      },
    };
    const app = await startRestApp({
      pool: db.pool,
      workerRunner: runner,
      // 운영 기본값은 30초다. 테스트는 줄여서 쓴다.
      httpTimeouts: {
        requestTimeoutMs: 400,
        headersTimeoutMs: 400,
        checkIntervalMs: 50,
      },
    });
    const { port } = new URL(app.baseUrl);
    const socket = net.connect(Number(port), "127.0.0.1");
    socket.on("error", () => undefined);
    const closed = new Promise<void>((resolve) =>
      socket.on("close", () => {
        events.push("slow-connection-closed");
        resolve();
      }),
    );
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    // 헤더는 보냈지만 Content-Length만큼의 본문을 보내지 않는다.
    socket.write(
      `POST /jobs HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${ALPHA_KEY}\r\nIdempotency-Key: slow-1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`,
    );
    await new Promise((r) => setTimeout(r, 100));

    const started = Date.now();
    await app.app.close();
    const elapsed = Date.now() - started;
    await closed;

    // Worker 멈춤은 느린 연결이 정리되기 전에 일어난다. HTTP 닫기를 기다리는 동안 Worker가 점유를 계속하면 안 된다.
    expect(events[0]).toBe("pause");
    expect([...events].sort()).toEqual([
      "pause",
      "slow-connection-closed",
      "stop",
    ]);
    expect(elapsed).toBeLessThan(5_000);
    socket.destroy();
    app.logs.stop();
  });
});
