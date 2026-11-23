import type { LoggerService } from "@nestjs/common";
import type { AppLogger, LogFields } from "./logger.js";

type Level = "debug" | "info" | "warn" | "error";

/** 객체 메시지에서 로그 필드로 쓸 수 있는 값(문자열·숫자·불리언·null)만 고른다. 중첩 객체는 버린다. */
function toFields(message: Record<string, unknown>): LogFields {
  const fields: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(message)) {
    if (key === "event") continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      fields[key] = value;
  }
  return fields;
}

export interface NestLoggerOptions {
  /** false면 debug·verbose를 버린다. 운영은 헬스 프로브마다 한 줄씩 쌓이지 않게 끈다. */
  debug: boolean;
}

/**
 * Nest 로거 인터페이스를 앱 JSON 로거에 연결한다. `NestFactory.create({ logger })`에 넣으면 Nest 내부 로그,
 * `new Logger("...")`를 쓰는 앱 코드 로그가 모두 같은 형식(`{ts, instance, level, event, ...}`)으로 나온다.
 * - 객체 메시지에 문자열 `event`가 있으면 그 이름과 필드를 그대로 쓴다.
 * - 그 밖의 메시지는 `event: "nest_log"`, `message`(문자열), `context`(Nest가 마지막 인자로 붙이는 클래스·모듈 이름)로 남긴다.
 * - 오류 수준에서 Nest가 넘기는 스택은 `stack`으로 남긴다(스택 첫 줄에 예외 메시지가 들어 있다. Nest 기본 출력과 같은 정보다).
 */
export function createNestLogger(
  logger: AppLogger,
  options: NestLoggerOptions,
): LoggerService {
  const emit = (level: Level, message: unknown, params: unknown[]): void => {
    if (
      typeof message === "object" &&
      message !== null &&
      !(message instanceof Error) &&
      typeof (message as { event?: unknown }).event === "string"
    ) {
      const event = (message as { event: string }).event;
      logger[level](event, toFields(message as Record<string, unknown>));
      return;
    }
    const strings = params.filter((p): p is string => typeof p === "string");
    const context =
      strings.length > 0 ? strings[strings.length - 1] : undefined;
    const stack =
      level === "error" && strings.length > 1 ? strings[0] : undefined;
    const text =
      message instanceof Error
        ? message.name
        : typeof message === "string"
          ? message
          : String(message);
    logger[level]("nest_log", {
      message: text,
      ...(context !== undefined && { context }),
      ...(stack !== undefined && { stack }),
    });
  };
  return {
    log: (message, ...params) => emit("info", message, params),
    warn: (message, ...params) => emit("warn", message, params),
    error: (message, ...params) => emit("error", message, params),
    fatal: (message, ...params) => emit("error", message, params),
    debug: (message, ...params) => {
      if (options.debug) emit("debug", message, params);
    },
    verbose: (message, ...params) => {
      if (options.debug) emit("debug", message, params);
    },
  };
}
