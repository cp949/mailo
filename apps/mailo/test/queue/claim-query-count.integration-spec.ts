import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { claim } from "../../src/queue/index.js";
import { countingPool } from "../support/counting-pool.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { completeDeps, createJob, migrate } from "../support/queue-fixtures.js";

/**
 * 계정이 하나(`default`)일 때 `claim` 한 번이 보내는 문장 수(ADR-0013 결정 3 바, 검증 계획).
 * 묶음 A까지의 `claim`(계정별 호출 전)의 문장 수를 기준값으로 고정한다. 계정별 `claim`으로 바꾼 뒤에도 N=1의 값이 같아야 한다.
 * 문장 수에는 BEGIN·COMMIT과 lease 복구 트랜잭션(BEGIN, SELECT, COMMIT)이 들어간다.
 */
describe("PostgreSQL 통합: N=1 claim의 문장 수 불변 (RQ-054, ADR-0013 결정 3)", () => {
  let db: TestDatabase;
  const deps = completeDeps();

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query("DELETE FROM mail_send_controls");
    await db.pool.query(
      `UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL,
         probe_job_id = NULL, consecutive_failures = 0, wait_seconds = 0, last_reason = NULL,
         last_trip_job_id = NULL, last_trip_token = NULL`,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  const claimOpts = { leaseSeconds: 120, limit: 4, deps };

  it("closed이고 할당이 없으면 복구 3 + BEGIN·차단기·정지·점유·COMMIT 5 = 8문장이다", async () => {
    await createJob(db.pool);
    const counted = countingPool(db.pool);

    const claimed = await claim(counted.pool, claimOpts);

    expect(claimed).toHaveLength(1);
    expect(counted.statements()).toHaveLength(8);
  });

  it("호출처 할당이 하나 있으면 advisory lock과 사용량 쿼리 2문장이 더해져 10문장이다", async () => {
    await createJob(db.pool);
    const counted = countingPool(db.pool);

    const claimed = await claim(counted.pool, {
      ...claimOpts,
      callerQuotas: new Map([["caller-a", 100]]),
    });

    expect(claimed).toHaveLength(1);
    expect(counted.statements()).toHaveLength(10);
  });

  it("open이고 대기 시간이 남았으면 점유 없이 복구 3 + BEGIN·차단기·정지·COMMIT 4 = 7문장이다", async () => {
    await createJob(db.pool);
    await db.pool.query(
      `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() + interval '1 hour',
         wait_seconds = 60, last_reason = 'CONNECTION' WHERE breaker_key = 'default'`,
    );
    const counted = countingPool(db.pool);

    const claimed = await claim(counted.pool, claimOpts);

    expect(claimed).toHaveLength(0);
    expect(counted.statements()).toHaveLength(7);
  });

  it("전체 정지면 점유 없이 7문장이다", async () => {
    await createJob(db.pool);
    await db.pool.query(
      "INSERT INTO mail_send_controls (scope_type, scope_id, paused_by) VALUES ('all', '', 'ops')",
    );
    const counted = countingPool(db.pool);

    expect(await claim(counted.pool, claimOpts)).toHaveLength(0);
    expect(counted.statements()).toHaveLength(7);
  });

  it("대표 작업(probe) 점유는 복구 3 + BEGIN·차단기·정지·후보·작업 UPDATE·차단기 UPDATE·COMMIT 7 = 10문장이다", async () => {
    await createJob(db.pool);
    await db.pool.query(
      `UPDATE mail_circuit_breaker SET state = 'open', open_until = now() - interval '1 second',
         wait_seconds = 60, last_reason = 'CONNECTION' WHERE breaker_key = 'default'`,
    );
    const counted = countingPool(db.pool);

    const claimed = await claim(counted.pool, claimOpts);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.isProbe).toBe(true);
    expect(counted.statements()).toHaveLength(10);
  });
});
