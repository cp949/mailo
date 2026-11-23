/**
 * 앱 전체가 쓰는 JSON 로그(M10). 한 줄에 객체 하나: `{ts, instance, level, event, ...fields}`.
 * 필드에는 식별자(작업 ID)와 사유 코드, 수치만 넣는다.
 * 메일 본문·제목·수신자 주소·SMTP 인증 정보·원본 예외 메시지는 넣지 않는다(RQ-027, AGENTS.md 시크릿과 로그).
 * 이 모듈은 다른 앱 모듈을 import하지 않는 leaf다(worker·file-channel·http가 함께 쓴다).
 */
import { hostname } from "node:os";

export type LogFields = Readonly<
  Record<string, string | number | boolean | null>
>;

export interface AppLogger {
  /** 운영(production)에서는 Nest 어댑터가 버린다. 헬스 프로브 같은 잦은 요청의 로그에 쓴다. */
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export const silentLogger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface JsonLoggerOptions {
  /** 로그 줄의 `instance` 값. 생략하면 호스트 이름(컨테이너에서는 컨테이너 ID)이다. 설정 `MAILO_INSTANCE_ID`가 이 값을 정한다. */
  instance?: string;
  /** 시각 공급자. 테스트가 고정한다. */
  now?: () => Date;
}

/**
 * 한 줄 JSON으로 `write`에 넘기는 로거. 운영은 `process.stdout.write`, 테스트는 배열 수집기를 쓴다.
 * `ts`, `instance`, `level`, `event`는 호출자의 `fields`가 덮어쓸 수 없다.
 */
export function createJsonLogger(
  write: (line: string) => void,
  options: JsonLoggerOptions = {},
): AppLogger {
  const instance = options.instance ?? hostname();
  const now = options.now ?? (() => new Date());
  const emit =
    (level: string) =>
    (event: string, fields: LogFields = {}) => {
      const line: Record<string, string | number | boolean | null> = {
        ts: now().toISOString(),
        instance,
        level,
        event,
      };
      for (const [key, value] of Object.entries(fields))
        if (!(key in line)) line[key] = value;
      write(JSON.stringify(line));
    };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  };
}

/** 운영 로그: 표준 출력 한 줄 JSON. */
export function createStdoutLogger(options: JsonLoggerOptions = {}): AppLogger {
  return createJsonLogger(
    (line) => void process.stdout.write(`${line}\n`),
    options,
  );
}

/** 예외를 로그용 코드로 바꾼다. 메시지는 쓰지 않는다. 시크릿이나 쿼리 값이 들어 있을 수 있다. */
export function describeError(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UnknownError";
  const rec = error as { name?: unknown; code?: unknown };
  const name = typeof rec.name === "string" ? rec.name : "Error";
  const code = typeof rec.code === "string" ? rec.code : undefined;
  return code ? `${name}:${code}` : name;
}
