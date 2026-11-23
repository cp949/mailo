import type pg from "pg";

/** 풀을 감싸 `query` 호출 수와 SQL 앞부분을 센다. `withTransaction`이 쓰는 `connect()`의 클라이언트도 같은 기록에 남긴다. */
export interface CountingPool {
  pool: pg.Pool;
  /** 지금까지 보낸 문장 수(BEGIN·COMMIT 포함) */
  count(): number;
  /** 문장의 공백을 줄인 앞 400자. 문장 수가 어긋났을 때 진단용이다. */
  statements(): string[];
  reset(): void;
}

export function countingPool(real: pg.Pool): CountingPool {
  const log: string[] = [];
  const record = (args: unknown[]): void => {
    const first = args[0];
    const text =
      typeof first === "string"
        ? first
        : ((first as { text?: string } | undefined)?.text ?? "");
    log.push(text.replace(/\s+/g, " ").trim().slice(0, 400));
  };
  const wrapClient = (client: pg.PoolClient): pg.PoolClient =>
    new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "query")
          return (...args: unknown[]) => {
            record(args);
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  const pool = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "query")
        return (...args: unknown[]) => {
          record(args);
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      if (prop === "connect")
        return async () => wrapClient(await target.connect());
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return {
    pool,
    count: () => log.length,
    statements: () => [...log],
    reset: () => {
      log.length = 0;
    },
  };
}
