import pg from "pg";

export interface PoolOptions {
  max?: number;
  /** 연결을 얻는 최대 대기(ms). DB가 내려갔을 때 요청이 오래 매달리지 않게 한다. */
  connectionTimeoutMillis?: number;
  /**
   * 서버가 쿼리 하나에 허용하는 시간(ms, `statement_timeout`). 넘으면 서버가 쿼리를 취소한다(SQLSTATE 57014).
   * 생략하면 서버 기본(무제한)이다. 마이그레이션 CLI와 테스트 풀이 생략한다.
   */
  statementTimeoutMillis?: number;
  /** 잠금 대기 상한(ms, `lock_timeout`). 넘으면 쿼리가 실패한다(55P03). 행 잠금 순서가 꼬였을 때 무한 대기를 막는다. */
  lockTimeoutMillis?: number;
  /**
   * 트랜잭션을 연 채 쿼리를 보내지 않는 시간의 상한(ms, `idle_in_transaction_session_timeout`).
   * 넘으면 서버가 연결을 끊는다(25P03). 멈춘 클라이언트가 차단기 행 잠금과 xmin을 붙잡는 것을 막는다.
   */
  idleInTransactionSessionTimeoutMillis?: number;
  /**
   * 클라이언트 쪽 쿼리 응답 대기 상한(ms, `query_timeout`). RST 없이 연결이 끊겨 서버 응답이 오지 않는 경우를 끊는다.
   * 서버 쪽 `statement_timeout`보다 길게 둔다. 이 시간이 지나도 pg는 연결을 닫지 않으므로 호출자가 그 연결을 버려야 한다
   * (`withTransaction`은 버린다. `pool.query`는 pg-pool이 버린다).
   */
  queryTimeoutMillis?: number;
  /** TCP keepalive(`SO_KEEPALIVE`)와 첫 탐침까지의 유휴 시간(ms). 조용히 끊긴 연결을 커널이 알아채게 한다. */
  keepAlive?: { initialDelayMillis: number };
}

/** 커넥션 풀을 만든다. ORM 없이 pg를 직접 쓴다. */
export function createPool(
  databaseUrl: string,
  options: PoolOptions = {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ...(options.max !== undefined ? { max: options.max } : {}),
    ...(options.connectionTimeoutMillis !== undefined
      ? { connectionTimeoutMillis: options.connectionTimeoutMillis }
      : {}),
    ...(options.statementTimeoutMillis !== undefined
      ? { statement_timeout: options.statementTimeoutMillis }
      : {}),
    ...(options.lockTimeoutMillis !== undefined
      ? { lock_timeout: options.lockTimeoutMillis }
      : {}),
    ...(options.idleInTransactionSessionTimeoutMillis !== undefined
      ? {
          idle_in_transaction_session_timeout:
            options.idleInTransactionSessionTimeoutMillis,
        }
      : {}),
    ...(options.queryTimeoutMillis !== undefined
      ? { query_timeout: options.queryTimeoutMillis }
      : {}),
    ...(options.keepAlive
      ? {
          keepAlive: true,
          keepAliveInitialDelayMillis: options.keepAlive.initialDelayMillis,
        }
      : {}),
  });
  return pool;
}

/** pg의 클라이언트 쪽 `query_timeout` 오류인지 확인한다. 이 오류가 나면 연결에서 쿼리가 계속 돌고 있을 수 있다. */
export function isQueryReadTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === "Query read timeout";
}
