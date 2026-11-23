/**
 * `outcomeUncertain` 판정(RQ-048, ADR-0011 결정 5)을 실제 PostgreSQL의 `mail_attempts`로 검증한다.
 * 고정하는 것: 불확실로 보는 시도 두 종류(`LEASE_EXPIRED`, DATA 단계 응답 없는 `TRANSIENT`)와
 * 확실한 실패로 보는 시도(응답 코드가 있거나 DATA 이전 단계), 일괄 조회와 단건 조회의 같은 판정, 호출처 범위.
 * 판정은 기존 `mail_attempts` 컬럼에서 도출하고 마이그레이션이나 새 컬럼을 쓰지 않는다.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import type pg from "pg";
import {
  findJobById,
  findJobByIdForOperator,
  findJobByKey,
  findOutcomeUncertain,
} from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { createJob, migrate } from "../support/queue-fixtures.js";

interface AttemptSeed {
  classification: string;
  stage?: string | null;
  responseCode?: number | null;
}

async function addAttempt(
  pool: pg.Pool,
  jobId: string,
  seed: AttemptSeed,
): Promise<void> {
  await pool.query(
    `INSERT INTO mail_attempts (job_id, classification, counted, stage, response_code, started_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [
      jobId,
      seed.classification,
      seed.classification !== "ACCOUNT",
      seed.stage ?? null,
      seed.responseCode ?? null,
    ],
  );
}

describe("outcomeUncertain 판정(RQ-048, ADR-0011 결정 5)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
  });

  async function uncertainOf(seeds: AttemptSeed[]): Promise<boolean> {
    const jobId = await createJob(db.pool);
    for (const seed of seeds) await addAttempt(db.pool, jobId, seed);
    const view = await findJobById(db.pool, "caller-a", jobId);
    const batch = await findOutcomeUncertain(db.pool, [jobId]);
    // 단건 조회와 일괄 조회는 같은 판정이다.
    expect(batch.has(jobId)).toBe(view!.outcomeUncertain);
    return view!.outcomeUncertain;
  }

  it("시도가 없으면 false다", async () => {
    expect(await uncertainOf([])).toBe(false);
  });

  it("LEASE_EXPIRED 시도가 있으면 true다(lease 회수는 전송 결과를 모른다)", async () => {
    expect(await uncertainOf([{ classification: "LEASE_EXPIRED" }])).toBe(true);
  });

  it("DATA 단계에서 응답 없이 끝난 TRANSIENT 시도는 true다(타임아웃·연결 끊김)", async () => {
    expect(
      await uncertainOf([{ classification: "TRANSIENT", stage: "DATA" }]),
    ).toBe(true);
  });

  it("DATA 단계라도 SMTP 응답 코드가 있는 TRANSIENT(451)는 false다", async () => {
    expect(
      await uncertainOf([
        { classification: "TRANSIENT", stage: "DATA", responseCode: 451 },
      ]),
    ).toBe(false);
  });

  it("DATA 단계의 영구 오류(550)는 false다", async () => {
    expect(
      await uncertainOf([
        { classification: "PERMANENT", stage: "DATA", responseCode: 550 },
      ]),
    ).toBe(false);
  });

  it("DATA 이전 단계의 응답 없는 TRANSIENT·ACCOUNT 시도는 false다", async () => {
    expect(
      await uncertainOf([
        { classification: "TRANSIENT", stage: "CONN" },
        { classification: "TRANSIENT", stage: "RCPT" },
        { classification: "ACCOUNT", stage: "MAIL_FROM" },
        { classification: "ACCOUNT", stage: "AUTH", responseCode: 535 },
      ]),
    ).toBe(false);
  });

  it("Mailo 내부 오류(stage WORKER)는 SMTP에 닿기 전이라 false다", async () => {
    expect(
      await uncertainOf([{ classification: "TRANSIENT", stage: "WORKER" }]),
    ).toBe(false);
  });

  it("불확실한 시도가 한 건이라도 있으면 뒤의 시도가 확실해도 true다(SENT 포함)", async () => {
    expect(
      await uncertainOf([
        { classification: "TRANSIENT", stage: "DATA" },
        { classification: "TRANSIENT", stage: "DATA", responseCode: 451 },
        { classification: "SENT", stage: "DATA", responseCode: 250 },
      ]),
    ).toBe(true);
  });

  it("호출처·운영자·Key 조회가 같은 값을 돌려주고 다른 호출처 범위에서는 조회되지 않는다", async () => {
    const jobId = await createJob(db.pool, {
      callerId: "caller-a",
      idempotencyKey: "uncertain-key",
    });
    await addAttempt(db.pool, jobId, { classification: "LEASE_EXPIRED" });

    const byId = await findJobById(db.pool, "caller-a", jobId);
    const byKey = await findJobByKey(db.pool, "caller-a", "uncertain-key");
    const forOperator = await findJobByIdForOperator(db.pool, jobId);

    expect(byId?.outcomeUncertain).toBe(true);
    expect(byKey?.outcomeUncertain).toBe(true);
    expect(forOperator?.outcomeUncertain).toBe(true);
    expect(await findJobById(db.pool, "caller-b", jobId)).toBeNull();
  });

  it("일괄 조회는 요청한 작업 중 불확실한 것만 담고 빈 입력은 쿼리 없이 빈 집합이다", async () => {
    const uncertain = await createJob(db.pool);
    const certain = await createJob(db.pool);
    await addAttempt(db.pool, uncertain, {
      classification: "TRANSIENT",
      stage: "DATA",
    });
    await addAttempt(db.pool, certain, {
      classification: "TRANSIENT",
      stage: "DATA",
      responseCode: 452,
    });

    const result = await findOutcomeUncertain(db.pool, [uncertain, certain]);

    expect([...result]).toEqual([uncertain]);
    expect((await findOutcomeUncertain(db.pool, [])).size).toBe(0);
  });
});
