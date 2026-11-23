import type pg from "pg";
import { isQueryReadTimeout } from "./pool.js";

/** `pg.Pool`과 `pg.PoolClient` 모두 받는 쿼리 실행 대상. 트랜잭션 안팎에서 같은 함수를 쓰기 위한 타입이다. */
export type Queryable = Pick<pg.Pool, "query">;

/**
 * 커넥션 하나로 트랜잭션을 실행한다. 성공하면 COMMIT, 예외가 나면 ROLLBACK 후 다시 던진다.
 * 기본 격리 수준은 READ COMMITTED다. 등록 경로가 이 수준을 전제로 한다(ADR-0005 결정 4).
 * 클라이언트 `query_timeout`이 나거나 ROLLBACK이 실패하면 그 연결을 풀에 돌려주지 않고 버린다.
 * 응답이 없는 연결에 ROLLBACK을 보내면 같은 시간만큼 더 기다리기 때문이다.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discard: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (isQueryReadTimeout(error)) {
      discard = error as Error;
    } else {
      await client.query("ROLLBACK").catch((rollbackError: unknown) => {
        discard =
          rollbackError instanceof Error
            ? rollbackError
            : new Error("rollback failed");
      });
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
