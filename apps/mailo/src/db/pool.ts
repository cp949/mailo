import pg from "pg";

export interface PoolOptions {
  max?: number;
  /** 연결을 얻는 최대 대기(ms). DB가 내려갔을 때 요청이 오래 매달리지 않게 한다. */
  connectionTimeoutMillis?: number;
}

/** 커넥션 풀을 만든다. ORM 없이 pg를 직접 쓴다. */
export function createPool(
  databaseUrl: string,
  options: PoolOptions = {},
): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    ...(options.max !== undefined ? { max: options.max } : {}),
    ...(options.connectionTimeoutMillis !== undefined
      ? { connectionTimeoutMillis: options.connectionTimeoutMillis }
      : {}),
  });
}
