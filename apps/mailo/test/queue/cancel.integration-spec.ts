/**
 * 작업 취소(RQ-040, ADR-0011 결정 4)의 큐 계층 검증. 실제 PostgreSQL을 쓴다.
 * 고정하는 것: PENDING·RETRY_WAIT만 CANCELED로 바뀌고, 같은 트랜잭션에서 이벤트가 쓰이며 본문이 즉시 비워진다.
 * 취소와 claim은 작업 행 잠금으로 직렬화된다(잠금 순서는 작업 행 → 차단기 행).
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
  sweepExpired,
} from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  completeDeps,
  createJob,
  migrate,
  pastDue,
} from "../support/queue-fixtures.js";

describe("PostgreSQL 통합: 작업 취소(RQ-040, ADR-0011 결정 4)", () => {
  let db: TestDatabase;
  const deps = completeDeps();
  const claimOpts = { leaseSeconds: 120, limit: 5, deps };

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query(
      "UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL, probe_job_id = NULL",
    );
  });

  afterAll(async () => {
    await db.close();
  });

  async function row(id: string) {
    const { rows } = await db.pool.query(
      `SELECT status, finished_at, failure_reason, body_ciphertext, body_nonce, body_key_version,
              body_deleted_at, attempts, idempotency_key, fingerprint, recipients, envelope
         FROM mail_jobs WHERE id = $1`,
      [id],
    );
    return rows[0];
  }
  async function events(id: string) {
    const { rows } = await db.pool.query(
      `SELECT type, caller_id, idempotency_key, failure_reason, attempt_count, recipients
         FROM mail_events WHERE job_id = $1 ORDER BY id`,
      [id],
    );
    return rows;
  }

  it("PENDING 작업을 취소하면 CANCELED, finished_at, 사유, 본문 삭제, JOB_CANCELED 이벤트가 한 번에 생긴다", async () => {
    const id = await createJob(db.pool, {
      callerId: "alpha",
      idempotencyKey: "k-1",
      recipients: { to: ["kim@example.com"], cc: [], bcc: [] },
    });
    const before = await row(id);

    const result = await cancelJob(
      db.pool,
      { callerId: "alpha", jobId: id },
      "CALLER",
    );

    expect(result).toEqual({
      kind: "canceled",
      jobId: id,
      callerId: "alpha",
      accountId: "default",
    });
    const after = await row(id);
    expect(after.status).toBe("CANCELED");
    expect(after.finished_at).toBeInstanceOf(Date);
    expect(after.failure_reason).toBe("CANCELED_BY_CALLER");
    expect(after.body_ciphertext).toBeNull();
    expect(after.body_nonce).toBeNull();
    expect(after.body_key_version).toBeNull();
    expect(after.body_deleted_at).toBeInstanceOf(Date);
    // 행, Key, 지문은 남긴다(ADR-0005 결정 7).
    expect(after.idempotency_key).toBe("k-1");
    expect(Buffer.from(after.fingerprint).equals(before.fingerprint)).toBe(
      true,
    );
    expect(await events(id)).toEqual([
      {
        type: "JOB_CANCELED",
        caller_id: "alpha",
        idempotency_key: "k-1",
        failure_reason: "CANCELED_BY_CALLER",
        attempt_count: 0,
        recipients: { to: ["kim@example.com"], cc: [], bcc: [] },
      },
    ]);
  });

  it("Key로도 취소하고, 운영자 취소는 사유와 이벤트에 OPERATOR를 남긴다(확장 자리)", async () => {
    const id = await createJob(db.pool, {
      callerId: "alpha",
      idempotencyKey: "k-op",
    });

    const result = await cancelJob(
      db.pool,
      { callerId: "alpha", idempotencyKey: "k-op" },
      "OPERATOR",
    );

    expect(result).toEqual({
      kind: "canceled",
      jobId: id,
      callerId: "alpha",
      accountId: "default",
    });
    expect((await row(id)).failure_reason).toBe("CANCELED_BY_OPERATOR");
    expect((await events(id))[0]?.failure_reason).toBe("CANCELED_BY_OPERATOR");
  });

  it("RETRY_WAIT 작업도 취소한다. 시도 횟수는 그대로다", async () => {
    const id = await createJob(db.pool, { callerId: "alpha" });
    const [claimed] = await claim(db.pool, claimOpts);
    await completeAttempt(
      db.pool,
      { id, leaseToken: claimed!.leaseToken },
      { classification: "TRANSIENT", stage: "DATA", responseCode: 451 },
      deps,
    );
    expect((await row(id)).status).toBe("RETRY_WAIT");

    const result = await cancelJob(
      db.pool,
      { callerId: "alpha", jobId: id },
      "CALLER",
    );

    expect(result.kind).toBe("canceled");
    const after = await row(id);
    expect(after.status).toBe("CANCELED");
    expect(after.attempts).toBe(1);
    expect((await events(id))[0]).toMatchObject({
      type: "JOB_CANCELED",
      attempt_count: 1,
    });
  });

  it("이미 CANCELED이면 already_canceled이고 이벤트와 시각을 새로 쓰지 않는다(멱등)", async () => {
    const id = await createJob(db.pool, { callerId: "alpha" });
    await cancelJob(db.pool, { callerId: "alpha", jobId: id }, "CALLER");
    const first = await row(id);

    // 운영자가 다시 취소해도 처음 값을 바꾸지 않는다.
    const again = await cancelJob(
      db.pool,
      { callerId: "alpha", jobId: id },
      "OPERATOR",
    );

    expect(again).toEqual({ kind: "already_canceled", jobId: id });
    const second = await row(id);
    expect(second.finished_at).toEqual(first.finished_at);
    expect(second.failure_reason).toBe("CANCELED_BY_CALLER");
    expect(await events(id)).toHaveLength(1);
  });

  it("SENDING·SENT·FAILED·EXPIRED는 not_cancelable이고 현재 상태를 알린다. 아무것도 바꾸지 않는다", async () => {
    const sending = await createJob(db.pool, { callerId: "alpha" });
    const sent = await createJob(db.pool, { callerId: "alpha" });
    const failed = await createJob(db.pool, { callerId: "alpha" });
    const expired = await createJob(db.pool, { callerId: "alpha" });
    await db.pool.query(
      `UPDATE mail_jobs SET status = 'SENT', finished_at = now() WHERE id = $1`,
      [sent],
    );
    await db.pool.query(
      `UPDATE mail_jobs SET status = 'FAILED', failure_reason = 'PERMANENT', finished_at = now() WHERE id = $1`,
      [failed],
    );
    await db.pool.query(
      `UPDATE mail_jobs SET status = 'EXPIRED', failure_reason = 'EXPIRED', finished_at = now() WHERE id = $1`,
      [expired],
    );
    await db.pool.query(
      `UPDATE mail_jobs SET status = 'SENDING', lease_token = gen_random_uuid(),
              lease_until = now() + interval '2 minutes', leased_at = now() WHERE id = $1`,
      [sending],
    );

    for (const [id, status] of [
      [sending, "SENDING"],
      [sent, "SENT"],
      [failed, "FAILED"],
      [expired, "EXPIRED"],
    ] as const) {
      expect(
        await cancelJob(db.pool, { callerId: "alpha", jobId: id }, "CALLER"),
      ).toEqual({ kind: "not_cancelable", status });
      expect((await row(id)).status).toBe(status);
      expect((await row(id)).body_ciphertext).not.toBeNull();
      expect(await events(id)).toHaveLength(0);
    }
  });

  it("다른 호출처의 작업과 없는 작업은 not_found로 같다. 다른 호출처 작업은 바뀌지 않는다", async () => {
    const id = await createJob(db.pool, {
      callerId: "alpha",
      idempotencyKey: "k-iso",
    });

    const byOther = await cancelJob(
      db.pool,
      { callerId: "beta", jobId: id },
      "CALLER",
    );
    const byOtherKey = await cancelJob(
      db.pool,
      { callerId: "beta", idempotencyKey: "k-iso" },
      "CALLER",
    );
    const missing = await cancelJob(
      db.pool,
      { callerId: "alpha", jobId: "00000000-0000-4000-8000-000000000000" },
      "CALLER",
    );

    expect(byOther).toEqual({ kind: "not_found" });
    expect(byOtherKey).toEqual(byOther);
    expect(missing).toEqual(byOther);
    expect((await row(id)).status).toBe("PENDING");
    expect(await events(id)).toHaveLength(0);
  });

  it("이벤트 쓰기가 실패하면 전이도 롤백한다(같은 트랜잭션)", async () => {
    const id = await createJob(db.pool, { callerId: "alpha" });
    // 이벤트 INSERT를 실패시키려고 임시로 type CHECK를 옛 값으로 되돌린다.
    await db.pool.query(
      `ALTER TABLE mail_events DROP CONSTRAINT mail_events_type_check`,
    );
    await db.pool.query(
      `ALTER TABLE mail_events ADD CONSTRAINT mail_events_type_check
         CHECK (type IN ('JOB_SENT', 'JOB_FAILED', 'JOB_EXPIRED', 'INTAKE_REJECTED'))`,
    );
    try {
      await expect(
        cancelJob(db.pool, { callerId: "alpha", jobId: id }, "CALLER"),
      ).rejects.toMatchObject({ code: "23514" });
      const after = await row(id);
      expect(after.status).toBe("PENDING");
      expect(after.body_ciphertext).not.toBeNull();
    } finally {
      await db.pool.query(
        `ALTER TABLE mail_events DROP CONSTRAINT mail_events_type_check`,
      );
      await db.pool.query(
        `ALTER TABLE mail_events ADD CONSTRAINT mail_events_type_check
           CHECK (type IN ('JOB_SENT', 'JOB_FAILED', 'JOB_EXPIRED', 'JOB_CANCELED', 'INTAKE_REJECTED')) NOT VALID`,
      );
    }
  });

  describe("claim과의 경합(ADR-0011 결정 4 전이 쿼리)", () => {
    it("claim이 행을 잡고 있는 동안 취소는 기다렸다가 SENDING을 보고 not_cancelable이 된다", async () => {
      const id = await createJob(db.pool, { callerId: "alpha" });
      const holder = await db.pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          `SELECT id FROM mail_jobs WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const pending = cancelJob(
          db.pool,
          { callerId: "alpha", jobId: id },
          "CALLER",
        );
        // 취소가 잠금 대기 중인지 확인한다(아직 끝나지 않았다).
        const early = await Promise.race([
          pending.then(() => "done"),
          new Promise((resolve) => setTimeout(() => resolve("waiting"), 300)),
        ]);
        expect(early).toBe("waiting");
        await holder.query(
          `UPDATE mail_jobs SET status = 'SENDING', lease_token = gen_random_uuid(),
                  lease_until = now() + interval '2 minutes', leased_at = now() WHERE id = $1`,
          [id],
        );
        await holder.query("COMMIT");

        expect(await pending).toEqual({
          kind: "not_cancelable",
          status: "SENDING",
        });
        expect(await events(id)).toHaveLength(0);
        // 취소가 지다: 본문·수신자·봉투를 비우지 않았다(RQ-071).
        const kept = await row(id);
        expect(kept.body_ciphertext).not.toBeNull();
        expect(kept.body_deleted_at).toBeNull();
        expect(kept.recipients).toEqual({ to: ["to@example.invalid"] });
        expect(kept.envelope).toEqual({ from: "from@example.invalid" });
      } finally {
        holder.release();
      }
    });

    it("취소가 행을 잡고 있으면 claim은 그 행을 건너뛴다(SKIP LOCKED)", async () => {
      const id = await createJob(db.pool, { callerId: "alpha" });
      const holder = await db.pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          `UPDATE mail_jobs SET status = 'CANCELED', finished_at = now() WHERE id = $1`,
          [id],
        );

        expect(await claim(db.pool, claimOpts)).toEqual([]);
        await holder.query("COMMIT");
      } finally {
        holder.release();
      }
      expect((await row(id)).status).toBe("CANCELED");
    });

    it("취소와 claim을 동시에 반복해도 한 작업이 둘 다 이기지 않는다", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 40; i += 1)
        ids.push(await createJob(db.pool, { callerId: "alpha" }));

      const [cancels, claims] = await Promise.all([
        Promise.all(
          ids.map((id) =>
            cancelJob(db.pool, { callerId: "alpha", jobId: id }, "CALLER"),
          ),
        ),
        Promise.all(
          Array.from({ length: 8 }, () =>
            claim(db.pool, { ...claimOpts, limit: 5 }),
          ),
        ),
      ]);

      const claimedIds = new Set(claims.flat().map((j) => j.id));
      for (const [i, id] of ids.entries()) {
        const r = await row(id);
        const result = cancels[i]!;
        if (result.kind === "canceled") {
          // 취소가 이기면 점유하지 못했고 이벤트가 정확히 한 건이다.
          expect(claimedIds.has(id)).toBe(false);
          expect(r.status).toBe("CANCELED");
          expect(r.body_ciphertext).toBeNull();
          expect(r.recipients).toEqual({});
          expect(r.envelope).toEqual({});
          expect(await events(id)).toHaveLength(1);
        } else {
          // claim이 이기면 SENDING이고 취소는 거부됐으며 이벤트가 없다.
          expect(result).toEqual({ kind: "not_cancelable", status: "SENDING" });
          expect(claimedIds.has(id)).toBe(true);
          expect(r.status).toBe("SENDING");
          // claim이 이긴 행은 전송 중이라 본문·수신자·봉투가 그대로다(RQ-071).
          expect(r.body_ciphertext).not.toBeNull();
          expect(r.recipients).toEqual({ to: ["to@example.invalid"] });
          expect(r.envelope).toEqual({ from: "from@example.invalid" });
          expect(await events(id)).toHaveLength(0);
        }
      }
    });
  });

  describe("취소된 작업의 후속 처리", () => {
    it("claim·만료 sweep·본문 정리 대상이 아니다", async () => {
      const id = await createJob(db.pool, { callerId: "alpha" });
      await cancelJob(db.pool, { callerId: "alpha", jobId: id }, "CALLER");
      await pastDue(db.pool, id);
      await db.pool.query(
        "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = $1",
        [id],
      );

      expect(await claim(db.pool, claimOpts)).toEqual([]);
      expect(await sweepExpired(db.pool)).toBe(0);
      expect(await deleteExpiredBodies(db.pool, 0)).toBe(0);
      const after = await row(id);
      expect(after.status).toBe("CANCELED");
      expect(after.failure_reason).toBe("CANCELED_BY_CALLER");
      expect(await events(id)).toHaveLength(1);
    });

    it("보존 기간이 지나면 작업과 이벤트를 함께 지운다", async () => {
      const id = await createJob(db.pool, { callerId: "alpha" });
      await cancelJob(db.pool, { callerId: "alpha", jobId: id }, "CALLER");

      const result = await deleteExpiredRecords(db.pool, 0);

      expect(result.jobs).toBe(1);
      expect(await row(id)).toBeUndefined();
      expect(await events(id)).toHaveLength(0);
    });

    it("읽기 모델이 CANCELED와 종결 시각, 사유를 돌려준다", async () => {
      const id = await createJob(db.pool, { callerId: "alpha" });
      await cancelJob(db.pool, { callerId: "alpha", jobId: id }, "CALLER");

      const view = await findJobById(db.pool, "alpha", id);

      expect(view).toMatchObject({
        id,
        status: "CANCELED",
        failureReason: "CANCELED_BY_CALLER",
      });
      expect(view?.finishedAt).toBeInstanceOf(Date);
    });
  });

  describe("차단기 half_open과의 관계", () => {
    it("대표 작업(SENDING)은 취소하지 않으므로 차단기 행을 건드리지 않는다", async () => {
      const id = await createJob(db.pool, { callerId: "alpha" });
      await db.pool.query(
        `UPDATE mail_circuit_breaker
            SET state = 'open', open_until = now() - interval '1 second', last_reason = 'AUTH'`,
      );
      const [probe] = await claim(db.pool, claimOpts);
      expect(probe?.id).toBe(id);
      const breakerBefore = await db.pool.query(
        "SELECT state, probe_job_id, updated_at FROM mail_circuit_breaker",
      );

      const result = await cancelJob(
        db.pool,
        { callerId: "alpha", jobId: id },
        "CALLER",
      );

      expect(result).toEqual({ kind: "not_cancelable", status: "SENDING" });
      const breakerAfter = await db.pool.query(
        "SELECT state, probe_job_id, updated_at FROM mail_circuit_breaker",
      );
      expect(breakerAfter.rows).toEqual(breakerBefore.rows);
    });

    it("차단기가 open이어도 대기 작업은 취소할 수 있고 차단기 상태는 그대로다", async () => {
      const id = await createJob(db.pool, { callerId: "alpha" });
      await db.pool.query(
        `UPDATE mail_circuit_breaker
            SET state = 'open', open_until = now() + interval '10 minutes', last_reason = 'AUTH'`,
      );

      const result = await cancelJob(
        db.pool,
        { callerId: "alpha", jobId: id },
        "CALLER",
      );

      expect(result.kind).toBe("canceled");
      const { rows } = await db.pool.query(
        "SELECT state, last_reason FROM mail_circuit_breaker",
      );
      expect(rows[0]).toEqual({ state: "open", last_reason: "AUTH" });
    });
  });
});
