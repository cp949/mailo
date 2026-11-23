import { describe, expect, it } from "@jest/globals";
import { createJsonLogger, silentLogger } from "../src/logging/index.js";
import { EXIT_WORKER_CRASHED, createFatalHandler } from "../src/fatal-exit.js";

describe("점유 루프 치명 오류 처리 (H2)", () => {
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it("정상 종료 경로(close)를 먼저 거친 뒤 종료 코드 70으로 끝낸다", async () => {
    const events: string[] = [];
    let release!: () => void;
    const handler = createFatalHandler({
      close: () =>
        new Promise<void>((resolve) => {
          events.push("close 시작");
          release = () => {
            events.push("close 끝");
            resolve();
          };
        }),
      exit: (code) => events.push(`exit ${code}`),
      forceAfterMs: 10_000,
      logger: createJsonLogger((line) => events.push(line), {
        instance: "mailo-test",
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      }),
    });

    handler("poll_loop_crashed");
    await tick();
    expect(events).toEqual([
      // 평문이 아니라 앱 로거의 한 줄 JSON이다(N3).
      '{"ts":"2026-01-01T00:00:00.000Z","instance":"mailo-test","level":"error","event":"worker_fatal","reason":"poll_loop_crashed","exitCode":70}',
      "close 시작",
    ]);

    release();
    await tick();
    expect(events.at(-1)).toBe("exit 70");
    expect(EXIT_WORKER_CRASHED).toBe(70);
  });

  it("close가 실패해도 종료 코드는 70이다", async () => {
    const codes: number[] = [];
    const handler = createFatalHandler({
      close: () => Promise.reject(new Error("close failed")),
      exit: (code) => codes.push(code),
      forceAfterMs: 10_000,
      logger: silentLogger,
    });

    handler("poll_loop_crashed");
    await tick();

    expect(codes).toEqual([70]);
  });

  it("close가 멈추면 forceAfterMs 뒤 강제로 종료 코드 70으로 끝낸다", async () => {
    const codes: number[] = [];
    const handler = createFatalHandler({
      close: () => new Promise<void>(() => undefined),
      exit: (code) => codes.push(code),
      forceAfterMs: 30,
      logger: silentLogger,
    });

    handler("poll_loop_crashed");
    await new Promise((r) => setTimeout(r, 120));

    expect(codes).toEqual([70]);
  });

  it("두 번 불려도 한 번만 동작한다", async () => {
    let closes = 0;
    const handler = createFatalHandler({
      close: async () => {
        closes += 1;
      },
      exit: () => undefined,
      forceAfterMs: 10_000,
      logger: silentLogger,
    });

    handler("poll_loop_crashed");
    handler("poll_loop_crashed");
    await tick();

    expect(closes).toBe(1);
  });
});
