/**
 * 종결 전이 때 본문·수신자·봉투를 같은 UPDATE로 비우는 규칙(RQ-071, ADR-0015 결정 2)의 큐 계층 검증.
 * 실제 PostgreSQL을 쓴다. 고정하는 것:
 * - 결과 기록·lease 회수·만료 sweep·취소의 모든 종결 경로가 본문 세 열, `body_deleted_at`, `recipients`, `envelope`를 비운다.
 * - 종결 이벤트의 수신자는 비우기 전 값이다.
 * - 재시도로 가는 시도는 아무것도 비우지 않는다.
 * - 비운 행에서 조회·재등록·보존 삭제가 깨지지 않는다.
 * 값은 모두 가짜(canary)다. 실제 주소·본문이 아니다.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import {
  cancelJob,
  claim,
  completeAttempt,
  deleteExpiredBodies,
  deleteExpiredRecords,
  findJobById,
  recoverExpiredLeases,
  register,
  sweepExpired,
} from "../../src/queue/index.js";
import { listEvents } from "../../src/events/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  completeDeps,
  createJob,
  jobInput,
  migrate,
  registerDeps,
} from "../support/queue-fixtures.js";

const CANARY = {
  to: "canary-to-7f3a@example.invalid",
  cc: "canary-cc-7f3a@example.invalid",
  bcc: "canary-bcc-7f3a@example.invalid",
  from: "canary-from-7f3a@example.invalid",
  replyTo: "canary-reply-7f3a@example.invalid",
  body: "canary-body-7f3a",
};
const RECIPIENTS = {
  to: [CANARY.to],
  cc: [CANARY.cc],
  bcc: [CANARY.bcc],
};
const ENVELOPE = { from: CANARY.from, replyTo: CANARY.replyTo };

describe("PostgreSQL 통합: 종결 때 본문·수신자·봉투 비움(RQ-071, ADR-0015 결정 2)", () => {
  let db: TestDatabase;
  const deps = completeDeps({ maxAttempts: 2 });
  const claimOpts = { leaseSeconds: 120, limit: 1, deps };

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query(
      "UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL, probe_job_id = NULL, consecutive_failures = 0",
    );
  });

  afterAll(async () => {
    await db.close();
  });

  const create = (overrides = {}) =>
    createJob(db.pool, {
      recipients: RECIPIENTS,
      envelope: ENVELOPE,
      body: Buffer.from(CANARY.body),
      ...overrides,
    });

  async function jobRow(id: string) {
    const { rows } = await db.pool.query(
      `SELECT status, body_ciphertext, body_nonce, body_key_version, body_deleted_at,
              recipients, envelope, idempotency_key, fingerprint, finished_at,
              row_to_json(mail_jobs)::text AS as_text
         FROM mail_jobs WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  /** 종결한 행에 본문·수신자·봉투가 남지 않았음을 확인한다. 행, Key, 지문은 남아야 한다. */
  async function expectRedacted(id: string): Promise<void> {
    const row = await jobRow(id);
    expect(row.body_ciphertext).toBeNull();
    expect(row.body_nonce).toBeNull();
    expect(row.body_key_version).toBeNull();
    expect(row.body_deleted_at).toBeInstanceOf(Date);
    expect(row.recipients).toEqual({});
    expect(row.envelope).toEqual({});
    for (const value of Object.values(CANARY)) {
      expect(row.as_text).not.toContain(value);
    }
    expect(row.idempotency_key).toBeTruthy();
    expect(row.fingerprint).toBeTruthy();
    expect(row.finished_at).toBeInstanceOf(Date);
  }

  /** 종결 이벤트는 비우기 전 수신자를 담고, 본문·`from`·`replyTo`는 담지 않는다. */
  async function expectEventKeepsRecipients(
    id: string,
    type: string,
  ): Promise<void> {
    const { rows } = await db.pool.query(
      "SELECT type, recipients, row_to_json(mail_events)::text AS as_text FROM mail_events WHERE job_id = $1",
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(type);
    expect(rows[0].recipients).toEqual(RECIPIENTS);
    expect(rows[0].as_text).not.toContain(CANARY.body);
    expect(rows[0].as_text).not.toContain(CANARY.from);
    expect(rows[0].as_text).not.toContain(CANARY.replyTo);
  }

  async function claimOne(id: string) {
    const [job] = await claim(db.pool, claimOpts);
    if (job?.id !== id) throw new Error("의도한 작업이 점유되지 않았다");
    return job;
  }

  describe("결과 기록(completeAttempt)", () => {
    it("SENT 전이가 본문·수신자·봉투를 비우고 이벤트에는 비우기 전 수신자를 쓴다", async () => {
      const id = await create();
      const job = await claimOne(id);

      await completeAttempt(
        db.pool,
        { id, leaseToken: job.leaseToken },
        { classification: "SENT" },
        deps,
      );

      await expectRedacted(id);
      await expectEventKeepsRecipients(id, "JOB_SENT");
    });

    it("일부 거부 수신자가 있는 SENT도 시도 기록과 이벤트의 거부 수신자는 그대로다(비움은 ADR-0015 결정 3의 몫)", async () => {
      const id = await create();
      const job = await claimOne(id);
      const rejected = [{ address: CANARY.cc, code: 452 }];

      await completeAttempt(
        db.pool,
        { id, leaseToken: job.leaseToken },
        { classification: "SENT", rejectedRecipients: rejected },
        deps,
      );

      await expectRedacted(id);
      const { rows } = await db.pool.query(
        "SELECT rejected_recipients FROM mail_events WHERE job_id = $1",
        [id],
      );
      expect(rows[0].rejected_recipients).toEqual(rejected);
    });

    it("영구 오류 FAILED가 비운다", async () => {
      const id = await create();
      const job = await claimOne(id);

      await completeAttempt(
        db.pool,
        { id, leaseToken: job.leaseToken },
        {
          classification: "PERMANENT",
          responseCode: 550,
          enhancedCode: "5.1.1",
          stage: "RCPT",
        },
        deps,
      );

      await expectRedacted(id);
      await expectEventKeepsRecipients(id, "JOB_FAILED");
    });

    it("시도 횟수 소진 FAILED가 비운다", async () => {
      const id = await create();
      const first = await claimOne(id);
      await completeAttempt(
        db.pool,
        { id, leaseToken: first.leaseToken },
        { classification: "TRANSIENT" },
        deps,
      );
      await db.pool.query(
        "UPDATE mail_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
        [id],
      );
      const second = await claimOne(id);

      const result = await completeAttempt(
        db.pool,
        { id, leaseToken: second.leaseToken },
        { classification: "TRANSIENT" },
        deps,
      );

      expect(result).toMatchObject({ applied: true, status: "FAILED" });
      await expectRedacted(id);
      await expectEventKeepsRecipients(id, "JOB_FAILED");
    });

    it("다음 시도가 만료 시각을 넘어 EXPIRED가 되면 비운다", async () => {
      const id = await create({ expiresInSeconds: 30 });
      const job = await claimOne(id);

      const result = await completeAttempt(
        db.pool,
        { id, leaseToken: job.leaseToken },
        { classification: "TRANSIENT" },
        deps,
      );

      expect(result).toMatchObject({ applied: true, status: "EXPIRED" });
      await expectRedacted(id);
      await expectEventKeepsRecipients(id, "JOB_EXPIRED");
    });

    it("재시도로 가는 시도(RETRY_WAIT)는 아무것도 비우지 않고 다음 점유가 같은 값을 받는다", async () => {
      const id = await create();
      const first = await claimOne(id);

      const result = await completeAttempt(
        db.pool,
        { id, leaseToken: first.leaseToken },
        { classification: "TRANSIENT" },
        deps,
      );

      expect(result).toMatchObject({ applied: true, status: "RETRY_WAIT" });
      const row = await jobRow(id);
      expect(row.body_ciphertext).not.toBeNull();
      expect(row.body_deleted_at).toBeNull();
      expect(row.recipients).toEqual(RECIPIENTS);
      expect(row.envelope).toEqual(ENVELOPE);
      await db.pool.query(
        "UPDATE mail_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
        [id],
      );
      const second = await claimOne(id);
      expect(second.recipients).toEqual(RECIPIENTS);
      expect(second.envelope).toEqual(ENVELOPE);
      expect(second.body).toBeDefined();
    });
  });

  describe("lease 회수(recoverExpiredLeases)", () => {
    async function expireLease(id: string, alsoExpire: boolean) {
      await db.pool.query(
        `UPDATE mail_jobs SET lease_until = now() - interval '1 second',
                expires_at = CASE WHEN $2::boolean THEN now() - interval '1 second' ELSE expires_at END
          WHERE id = $1`,
        [id, alsoExpire],
      );
    }

    it("회수 결과가 소진 FAILED이면 비운다", async () => {
      const id = await create();
      await claimOne(id);
      await expireLease(id, false);
      const oneShot = completeDeps({ maxAttempts: 1 });

      expect(await recoverExpiredLeases(db.pool, oneShot)).toBe(1);

      expect((await jobRow(id)).status).toBe("FAILED");
      await expectRedacted(id);
      await expectEventKeepsRecipients(id, "JOB_FAILED");
    });

    it("회수 결과가 EXPIRED이면 비운다", async () => {
      const id = await create();
      await claimOne(id);
      await expireLease(id, true);

      expect(await recoverExpiredLeases(db.pool, deps)).toBe(1);

      expect((await jobRow(id)).status).toBe("EXPIRED");
      await expectRedacted(id);
      await expectEventKeepsRecipients(id, "JOB_EXPIRED");
    });

    it("회수 결과가 RETRY_WAIT이면 비우지 않는다", async () => {
      const id = await create();
      await claimOne(id);
      await expireLease(id, false);

      expect(await recoverExpiredLeases(db.pool, deps)).toBe(1);

      const row = await jobRow(id);
      expect(row.status).toBe("RETRY_WAIT");
      expect(row.body_ciphertext).not.toBeNull();
      expect(row.recipients).toEqual(RECIPIENTS);
      expect(row.envelope).toEqual(ENVELOPE);
    });
  });

  describe("만료 sweep(sweepExpired)", () => {
    it("만료된 PENDING과 RETRY_WAIT를 EXPIRED로 바꾸며 비운다", async () => {
      const pending = await create();
      const retryWait = await create();
      await db.pool.query(
        "UPDATE mail_jobs SET status = 'RETRY_WAIT' WHERE id = $1",
        [retryWait],
      );
      await db.pool.query(
        "UPDATE mail_jobs SET expires_at = now() - interval '1 second'",
      );

      expect(await sweepExpired(db.pool)).toBe(2);

      for (const id of [pending, retryWait]) {
        await expectRedacted(id);
        await expectEventKeepsRecipients(id, "JOB_EXPIRED");
      }
    });

    it("만료되지 않은 작업은 건드리지 않는다", async () => {
      const id = await create();

      expect(await sweepExpired(db.pool)).toBe(0);

      const row = await jobRow(id);
      expect(row.body_ciphertext).not.toBeNull();
      expect(row.recipients).toEqual(RECIPIENTS);
    });
  });

  describe("취소(cancelJob)", () => {
    it("본문에 더해 수신자·봉투도 비우고 이벤트에는 비우기 전 수신자를 쓴다", async () => {
      const id = await create({ callerId: "alpha" });

      const result = await cancelJob(
        db.pool,
        { callerId: "alpha", jobId: id },
        "CALLER",
      );

      expect(result.kind).toBe("canceled");
      await expectRedacted(id);
      await expectEventKeepsRecipients(id, "JOB_CANCELED");
    });
  });

  describe("비운 행의 기존 읽기 경로", () => {
    it("작업 조회, 이벤트 피드, 같은 Key의 재등록, 본문 정리, 보존 삭제가 비운 값으로 깨지지 않는다", async () => {
      const id = await create({ idempotencyKey: "redact-key-1" });
      const job = await claimOne(id);
      await completeAttempt(
        db.pool,
        { id, leaseToken: job.leaseToken },
        { classification: "SENT" },
        deps,
      );

      const found = await findJobById(db.pool, "caller-a", id);
      expect(found).toMatchObject({ id, status: "SENT", attempts: 1 });
      const page = await listEvents(db.pool, { callerId: "caller-a" });
      expect(page.events).toHaveLength(1);
      expect(page.events[0]!.recipients).toEqual(RECIPIENTS);

      const again = await register(
        db.pool,
        registerDeps,
        jobInput({
          idempotencyKey: "redact-key-1",
          recipients: RECIPIENTS,
          envelope: ENVELOPE,
          body: Buffer.from(CANARY.body),
        }),
      );
      expect(again.kind).toBe("duplicate");

      // 이미 비운 행은 본문 정리의 대상이 아니다.
      await db.pool.query(
        "UPDATE mail_jobs SET finished_at = now() - interval '2 days' WHERE id = $1",
        [id],
      );
      expect(await deleteExpiredBodies(db.pool, 86_400)).toBe(0);

      await db.pool.query(
        "UPDATE mail_jobs SET finished_at = now() - interval '31 days' WHERE id = $1",
        [id],
      );
      const purged = await deleteExpiredRecords(db.pool, 30 * 86_400);
      expect(purged.jobs).toBe(1);
    });
  });
});
