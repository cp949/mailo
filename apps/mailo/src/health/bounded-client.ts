import type pg from "pg";

/** 서버 쪽 쿼리 시간 상한(ms). 응답만 포기하면 쿼리가 풀 슬롯을 계속 잡으므로 전체 시간 상한보다 짧게 둔다(추정). */
export const STATEMENT_TIMEOUT_MS = 2000;

/**
 * 풀 연결 하나를 얻어 `work`를 실행한다. 전체가 `ms`를 넘으면 reject하고 그 연결을 버린다.
 * 실패했거나 시간이 지난 연결은 상태를 알 수 없으므로 풀에 돌려주지 않는다(`release(error)`가 연결을 닫는다).
 * 시간 초과 뒤에 얻은 연결은 쓰지 않고 그대로 돌려준다.
 * 트랜잭션은 `work`가 연다. 헬스는 `withBoundedClient`, 지표 수집은 그룹마다 `runReadOnly`를 쓴다.
 */
export function withBoundedConnection<T>(
  pool: pg.Pool,
  ms: number,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let client: pg.PoolClient | undefined;
    let released = false;
    const release = (discard?: Error): void => {
      if (client === undefined || released) return;
      released = true;
      client.release(discard);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      release(new Error("timeout"));
      reject(new Error("timeout"));
    }, ms);
    timer.unref();

    void (async () => {
      try {
        client = await pool.connect();
        if (settled) return release(); // 시간 초과 뒤에 얻은 연결은 그대로 돌려준다.
        const result = await work(client);
        if (!settled) {
          settled = true;
          resolve(result);
        }
        release();
      } catch (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
        // 트랜잭션이 열린 채 오류가 난 연결은 상태를 알 수 없어 버린다.
        release(error instanceof Error ? error : new Error("health failed"));
      } finally {
        clearTimeout(timer);
      }
    })();
  });
}

/**
 * 연결의 읽기 전용 트랜잭션 하나로 `work`를 실행한다. `BEGIN READ ONLY`와 `SET LOCAL statement_timeout`을 건다.
 * 성공하면 `COMMIT`한다. 실패하면 던진다(롤백은 호출자의 연결 처리에 맡긴다).
 */
export async function runReadOnly<T>(
  client: pg.PoolClient,
  work: (client: pg.PoolClient) => Promise<T>,
  statementTimeoutMs = STATEMENT_TIMEOUT_MS,
): Promise<T> {
  await client.query("BEGIN READ ONLY");
  await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
  const result = await work(client);
  await client.query("COMMIT");
  return result;
}

/**
 * 연결 하나를 읽기 전용 트랜잭션으로 열어 `work`를 실행한다. 전체가 `ms`를 넘으면 reject하고 그 연결을 버린다.
 * `SET LOCAL statement_timeout`으로 서버도 쿼리를 취소하게 한다. 응답만 포기하면 쿼리가 풀 슬롯을 계속 잡는다.
 * 버린 연결은 풀에 돌아가지 않으므로 응답 없는 연결이 다음 헬스체크를 막지 않는다.
 */
export function withBoundedClient<T>(
  pool: pg.Pool,
  ms: number,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withBoundedConnection(pool, ms, (client) => runReadOnly(client, work));
}
