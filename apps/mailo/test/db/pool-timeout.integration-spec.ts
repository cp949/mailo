import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import pg from "pg";
import {
  createPool,
  isQueryReadTimeout,
  withTransaction,
} from "../../src/db/index.js";

const URL =
  process.env.MAILO_TEST_DATABASE_URL ||
  "postgres://mailo:mailo-dev-password@localhost:5432/mailo";

/**
 * DB 시간제한(H1). 서버 쪽 시간제한은 SQLSTATE로, 클라이언트 쪽 query_timeout은 pg 오류 메시지로 확인한다.
 */
describe("PostgreSQL 통합: 풀 시간제한 (H1)", () => {
  const pools: pg.Pool[] = [];
  const table = `pool_timeout_${process.pid}`;
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE TABLE "${table}" (id int PRIMARY KEY, v int)`);
    await admin.query(`INSERT INTO "${table}" VALUES (1, 0)`);
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    await admin.query(`DROP TABLE IF EXISTS "${table}"`);
    await admin.end();
  });

  function pool(options: Parameters<typeof createPool>[1]): pg.Pool {
    const p = createPool(URL, options);
    pools.push(p);
    return p;
  }

  it("statement_timeout을 넘긴 쿼리는 서버가 취소하고(57014) 연결은 살아서 다음 쿼리를 받는다", async () => {
    const p = pool({
      max: 1,
      statementTimeoutMillis: 300,
      queryTimeoutMillis: 5_000,
    });
    const started = Date.now();

    await expect(p.query("SELECT pg_sleep(5)")).rejects.toMatchObject({
      code: "57014",
    });

    expect(Date.now() - started).toBeLessThan(2_000);
    const { rows } = await p.query("SELECT 1 AS ok");
    expect(rows[0].ok).toBe(1);
  });

  it("lock_timeout을 넘긴 잠금 대기는 실패한다(55P03)", async () => {
    const holder = new pg.Client({ connectionString: URL });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query(`SELECT * FROM "${table}" WHERE id = 1 FOR UPDATE`);
    const p = pool({
      max: 1,
      lockTimeoutMillis: 300,
      statementTimeoutMillis: 5_000,
    });
    try {
      const started = Date.now();

      await expect(
        p.query(`SELECT * FROM "${table}" WHERE id = 1 FOR UPDATE`),
      ).rejects.toMatchObject({ code: "55P03" });

      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
  });

  it("idle_in_transaction_session_timeout을 넘기면 서버가 연결을 끊고 잠금을 푼다", async () => {
    const p = pool({ max: 2, idleInTransactionSessionTimeoutMillis: 300 });
    p.on("error", () => undefined); // 서버가 유휴 연결을 끊으면 pool이 error를 낸다.
    const client = await p.connect();
    client.on("error", () => undefined);
    await client.query("BEGIN");
    await client.query(`SELECT * FROM "${table}" WHERE id = 1 FOR UPDATE`);

    await new Promise((r) => setTimeout(r, 900));

    // 잠금이 풀렸는지 다른 연결에서 본다.
    const probe = new pg.Client({ connectionString: URL });
    await probe.connect();
    try {
      await probe.query("SET lock_timeout = 500");
      await expect(
        probe.query(`SELECT * FROM "${table}" WHERE id = 1 FOR UPDATE`),
      ).resolves.toBeDefined();
    } finally {
      await probe.end();
    }
    await expect(client.query("SELECT 1")).rejects.toBeDefined();
    client.release(true);
  });

  it("query_timeout은 응답 없는 쿼리를 클라이언트에서 끊고, withTransaction은 그 연결을 버린다", async () => {
    // 서버 쪽 제한 없이 클라이언트 제한만 둬서 응답 없음(단절)을 흉내 낸다.
    const p = pool({ max: 1, queryTimeoutMillis: 300 });
    const started = Date.now();

    const error = await withTransaction(p, (client) =>
      client.query("SELECT pg_sleep(3)"),
    ).catch((e: unknown) => e);

    expect(isQueryReadTimeout(error)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    // 버려진 연결이 풀 슬롯을 계속 잡지 않는다. max=1인데 다음 쿼리가 바로 새 연결로 처리된다.
    const next = Date.now();
    const { rows } = await p.query("SELECT 1 AS ok");
    expect(rows[0].ok).toBe(1);
    expect(Date.now() - next).toBeLessThan(1_000);
  });

  it("keepAlive를 켠 풀도 정상적으로 쿼리한다", async () => {
    const p = pool({ max: 1, keepAlive: { initialDelayMillis: 10_000 } });

    const { rows } = await p.query("SELECT 1 AS ok");

    expect(rows[0].ok).toBe(1);
  });

  it("마이그레이션과 테스트 풀은 시간제한 없이 만들어진다(옵션 생략 시 서버 기본)", async () => {
    const p = pool({ max: 1 });

    const { rows } = await p.query(
      "SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l",
    );

    expect(rows[0]).toEqual({ s: "0", l: "0" });
  });
});
