/**
 * Worker 로그. 필드에는 식별자(작업 ID)와 사유 코드, 수치만 넣는다.
 * 메일 본문·제목·수신자 주소·SMTP 인증 정보·원본 예외 메시지는 넣지 않는다(RQ-027, AGENTS.md 시크릿과 로그).
 */
export type LogFields = Readonly<
  Record<string, string | number | boolean | null>
>;

export interface WorkerLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export const silentLogger: WorkerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** 한 줄 JSON으로 `write`에 넘기는 로거. 운영은 `process.stdout.write`, 테스트는 배열 수집기를 쓴다. */
export function createJsonLogger(write: (line: string) => void): WorkerLogger {
  const emit =
    (level: string) =>
    (event: string, fields: LogFields = {}) =>
      write(JSON.stringify({ level, event, ...fields }));
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

/** 예외를 로그용 코드로 바꾼다. 메시지는 쓰지 않는다. 시크릿이나 쿼리 값이 들어 있을 수 있다. */
export function describeError(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UnknownError";
  const rec = error as { name?: unknown; code?: unknown };
  const name = typeof rec.name === "string" ? rec.name : "Error";
  const code = typeof rec.code === "string" ? rec.code : undefined;
  return code ? `${name}:${code}` : name;
}
