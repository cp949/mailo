import { describe, expect, it } from "@jest/globals";
import {
  createJsonLogger,
  createNestLogger,
  describeError,
} from "../../src/logging/index.js";

const NOW = new Date("2026-11-23T01:02:03.456Z");

function collect(instance = "mailo-1") {
  const lines: string[] = [];
  const logger = createJsonLogger((line) => void lines.push(line), {
    instance,
    now: () => NOW,
  });
  const parsed = () =>
    lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { lines, logger, parsed };
}

describe("JSON 로거(M10)", () => {
  it("모든 줄에 ISO 시각 ts와 instance, level, event가 앞에 있고 필드가 뒤따른다", () => {
    const { lines, logger } = collect();

    logger.info("worker_started", { concurrency: 4 });

    expect(lines).toEqual([
      '{"ts":"2026-11-23T01:02:03.456Z","instance":"mailo-1","level":"info","event":"worker_started","concurrency":4}',
    ]);
  });

  it("호출자 필드가 ts·instance·level·event를 덮어쓰지 못한다", () => {
    const { logger, parsed } = collect();

    logger.warn("real_event", {
      ts: "fake",
      instance: "fake",
      level: "fake",
      event: "fake",
      keep: 1,
    });

    expect(parsed()[0]).toEqual({
      ts: NOW.toISOString(),
      instance: "mailo-1",
      level: "warn",
      event: "real_event",
      keep: 1,
    });
  });

  it("instance를 주지 않으면 호스트 이름 문자열이 들어간다", () => {
    const lines: string[] = [];
    createJsonLogger((l) => void lines.push(l)).error("x");

    const entry = JSON.parse(lines[0]!) as { instance: unknown };
    expect(typeof entry.instance).toBe("string");
    expect((entry.instance as string).length).toBeGreaterThan(0);
  });

  it("describeError는 메시지를 쓰지 않고 이름과 코드만 쓴다", () => {
    const error = Object.assign(new Error("password=hunter2"), {
      code: "ECONNREFUSED",
    });

    expect(describeError(error)).toBe("Error:ECONNREFUSED");
    expect(describeError("x")).toBe("UnknownError");
  });
});

describe("Nest 로거 어댑터(M10)", () => {
  it("문자열 로그는 event nest_log에 message와 context(마지막 문자열 인자)로 남긴다", () => {
    const { logger, parsed } = collect();
    const nest = createNestLogger(logger, { debug: true });

    nest.log("Nest application successfully started", "NestApplication");
    nest.warn("느린 응답", "http");

    expect(parsed()).toMatchObject([
      {
        level: "info",
        event: "nest_log",
        message: "Nest application successfully started",
        context: "NestApplication",
      },
      {
        level: "warn",
        event: "nest_log",
        message: "느린 응답",
        context: "http",
      },
    ]);
  });

  it("event가 있는 객체 메시지는 그 이름과 원시 값 필드로 남기고 중첩 객체는 버린다", () => {
    const { logger, parsed } = collect();
    const nest = createNestLogger(logger, { debug: true });

    nest.log(
      {
        event: "http_request",
        status: 200,
        callerId: null,
        nested: { secret: "x" },
      },
      "http",
    );

    const [entry] = parsed();
    expect(entry).toMatchObject({
      level: "info",
      event: "http_request",
      status: 200,
      callerId: null,
    });
    expect(entry).not.toHaveProperty("nested");
    expect(JSON.stringify(entry)).not.toContain('"secret"');
  });

  it("오류 수준은 Nest가 넘긴 스택을 stack으로 남기고 fatal은 error다", () => {
    const { logger, parsed } = collect();
    const nest = createNestLogger(logger, { debug: true });

    nest.error("boom", "Error: boom\n    at x", "ExceptionsHandler");
    nest.fatal?.("fatal", "ctx");

    expect(parsed()).toMatchObject([
      {
        level: "error",
        message: "boom",
        stack: "Error: boom\n    at x",
        context: "ExceptionsHandler",
      },
      { level: "error", message: "fatal", context: "ctx" },
    ]);
  });

  it("debug를 끄면 debug·verbose 로그를 버리고, 켜면 level debug로 남긴다", () => {
    const off = collect();
    const on = collect();

    for (const [nest] of [
      [createNestLogger(off.logger, { debug: false })],
      [createNestLogger(on.logger, { debug: true })],
    ] as const) {
      nest.debug?.("d", "ctx");
      nest.verbose?.("v", "ctx");
    }

    expect(off.lines).toEqual([]);
    expect(on.parsed().map((e) => e.level)).toEqual(["debug", "debug"]);
  });
});
