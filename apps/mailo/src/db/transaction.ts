import type pg from "pg";

/** `pg.Pool`과 `pg.PoolClient` 모두 받는 쿼리 실행 대상. 트랜잭션 안팎에서 같은 함수를 쓰기 위한 타입이다. */
export type Queryable = Pick<pg.Pool, "query">;

/**
 * 커넥션 하나로 트랜잭션을 실행한다. 성공하면 COMMIT, 예외가 나면 ROLLBACK 후 다시 던진다.
 * 기본 격리 수준은 READ COMMITTED다. 등록 경로가 이 수준을 전제로 한다(ADR-0005 결정 4).
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
