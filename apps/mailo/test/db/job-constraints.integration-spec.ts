import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { createJob, migrate } from "../support/queue-fixtures.js";

/** CHECK 제약 위반이면 SQLSTATE 23514와 위반한 제약 이름을 돌려준다. */
async function violation(
  db: TestDatabase,
  sql: string,
  params: unknown[],
): Promise<{ code?: string; constraint?: string } | null> {
  try {
    await db.pool.query(sql, params);
    return null;
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
}

describe("PostgreSQL 통합: 작업 행의 CHECK 제약 (RQ-014, ADR-0002 결정 7)", () => {
  let db: TestDatabase;
  let jobId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    jobId = await createJob(db.pool);
  });

  afterAll(async () => {
    await db.close();
  });

  it("SENDING인데 lease 컬럼 일부가 비어 있으면 23514(mail_jobs_lease_state)다", async () => {
    const error = await violation(
      db,
      "UPDATE mail_jobs SET status = 'SENDING', lease_token = gen_random_uuid() WHERE id = $1",
      [jobId],
    );

    expect(error).toMatchObject({
      code: "23514",
      constraint: "mail_jobs_lease_state",
    });
  });

  it("SENDING이 아닌데 lease_token이 남아 있으면 23514(mail_jobs_lease_state)다", async () => {
    const error = await violation(
      db,
      `UPDATE mail_jobs SET lease_token = gen_random_uuid(), lease_until = now(), leased_at = now()
       WHERE id = $1`,
      [jobId],
    );

    expect(error).toMatchObject({
      code: "23514",
      constraint: "mail_jobs_lease_state",
    });
  });

  it("종결 상태인데 finished_at이 없으면, 종결이 아닌데 finished_at이 있으면 23514(mail_jobs_terminal_state)다", async () => {
    for (const sql of [
      "UPDATE mail_jobs SET status = 'SENT' WHERE id = $1",
      "UPDATE mail_jobs SET finished_at = now() WHERE id = $1",
    ])
      expect(await violation(db, sql, [jobId])).toMatchObject({
        code: "23514",
        constraint: "mail_jobs_terminal_state",
      });
  });

  it("본문 암호문·nonce·키 버전은 함께 있거나 함께 없어야 하며 하나만 있으면 23514(mail_jobs_body_state)다", async () => {
    for (const set of [
      "body_ciphertext = NULL",
      "body_nonce = NULL",
      "body_key_version = NULL",
    ])
      expect(
        await violation(db, `UPDATE mail_jobs SET ${set} WHERE id = $1`, [
          jobId,
        ]),
      ).toMatchObject({ code: "23514", constraint: "mail_jobs_body_state" });
  });

  it("알 수 없는 상태 값과 음수 시도 횟수는 23514로 거부한다", async () => {
    expect(
      await violation(
        db,
        "UPDATE mail_jobs SET status = 'CANCELED' WHERE id = $1",
        [jobId],
      ),
    ).toMatchObject({ code: "23514", constraint: "mail_jobs_status_check" });
    expect(
      await violation(db, "UPDATE mail_jobs SET attempts = -1 WHERE id = $1", [
        jobId,
      ]),
    ).toMatchObject({ code: "23514", constraint: "mail_jobs_attempts_check" });
  });

  it("제약을 만족하는 정상 전이(PENDING에서 SENDING, 종결)는 통과한다", async () => {
    await db.pool.query(
      `UPDATE mail_jobs SET status = 'SENDING', lease_token = gen_random_uuid(),
         lease_until = now() + interval '1 minute', leased_at = now() WHERE id = $1`,
      [jobId],
    );
    await db.pool.query(
      `UPDATE mail_jobs SET status = 'SENT', finished_at = now(), lease_token = NULL, lease_until = NULL,
         leased_at = NULL, body_ciphertext = NULL, body_nonce = NULL, body_key_version = NULL WHERE id = $1`,
      [jobId],
    );

    const { rows } = await db.pool.query("SELECT status FROM mail_jobs");
    expect(rows).toEqual([{ status: "SENT" }]);
  });
});
