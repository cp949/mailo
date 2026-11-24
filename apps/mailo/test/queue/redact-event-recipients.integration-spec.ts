/**
 * 이벤트·시도 수신자의 유예 뒤 비움(RQ-072, ADR-0015 결정 3)의 큐 계층 검증. 실제 PostgreSQL을 쓴다.
 * 고정하는 것:
 * - 유예가 지난 `JOB_*` 이벤트의 `recipients`·`rejected_recipients`와 그 작업의 `mail_attempts.rejected_recipients`만 비운다.
 * - 이벤트 행은 지우지 않고 `id`·`txid`·`created_at`을 바꾸지 않으므로 피드 순서·cursor·공백 감지가 그대로다.
 * - 이미 비운 이벤트는 다시 처리하지 않는다(멱등).
 * - 정리 잠금과 작업 행 잠금이 걸린 대상은 건너뛰고, 보존 삭제와 동시에 돌아도 오류가 없다.
 * 값은 모두 가짜(canary)다. 실제 주소가 아니다.
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
  encodeCursor,
  hasEventGap,
  listEvents,
  recordIntakeRejection,
} from "../../src/events/index.js";
import {
  cancelJob,
  claim,
  completeAttempt,
  deleteExpiredRecords,
  redactEventRecipients,
  sweepExpired,
} from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { completeDeps, createJob, migrate } from "../support/queue-fixtures.js";

const CANARY = {
  to: "canary-to-9b2e@example.invalid",
  cc: "canary-cc-9b2e@example.invalid",
  bcc: "canary-bcc-9b2e@example.invalid",
  rejected: "canary-rejected-9b2e@example.invalid",
};
const RECIPIENTS = { to: [CANARY.to], cc: [CANARY.cc], bcc: [CANARY.bcc] };
const REJECTED = [{ address: CANARY.rejected, code: 452 }];

/** 수신자 유예 7일(기본값)과 같은 값. 설정 기본값과 어긋나면 이 테스트가 아니라 config 테스트가 잡는다. */
const GRACE = 604_800;
const DAY = 86_400;

describe("PostgreSQL 통합: 이벤트·시도 수신자 비움(RQ-072, ADR-0015 결정 3)", () => {
  let db: TestDatabase;
  const deps = completeDeps();
  const claimOpts = { leaseSeconds: 120, limit: 1, deps };

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query("DELETE FROM mail_intake_rejections");
    await db.pool.query("DELETE FROM mail_event_purges");
    await db.pool.query(
      "UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL, probe_job_id = NULL, consecutive_failures = 0",
    );
  });

  afterAll(async () => {
    await db.close();
  });

  const create = (overrides = {}) =>
    createJob(db.pool, { recipients: RECIPIENTS, ...overrides });

  async function claimOne(id: string) {
    const [job] = await claim(db.pool, claimOpts);
    if (job?.id !== id) throw new Error("의도한 작업이 점유되지 않았다");
    return job;
  }

  /** 실제 전이 경로로 종결한다. 모두 이벤트 한 건과 시도 기록을 만든다. */
  const finish = {
    async sent(rejected: unknown = REJECTED): Promise<string> {
      const id = await create();
      const job = await claimOne(id);
      await completeAttempt(
        db.pool,
        { id, leaseToken: job.leaseToken },
        {
          classification: "SENT",
          rejectedRecipients: rejected as never,
        },
        deps,
      );
      return id;
    },
    async failed(): Promise<string> {
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
      return id;
    },
    async expired(): Promise<string> {
      const id = await create();
      await db.pool.query(
        "UPDATE mail_jobs SET expires_at = now() - interval '1 second' WHERE id = $1",
        [id],
      );
      expect(await sweepExpired(db.pool)).toBe(1);
      return id;
    },
    async canceled(): Promise<string> {
      const id = await create();
      const result = await cancelJob(
        db.pool,
        { callerId: "caller-a", jobId: id },
        "CALLER",
      );
      expect(result.kind).toBe("canceled");
      return id;
    },
  };

  /** 이벤트 시각을 과거로 당겨 유예 경과를 흉내 낸다. 피드 순서(`txid`, `id`)는 바꾸지 않는다. */
  async function age(jobId: string, seconds: number): Promise<void> {
    await db.pool.query(
      "UPDATE mail_events SET created_at = now() - make_interval(secs => $2) WHERE job_id = $1",
      [jobId, seconds],
    );
  }

  async function eventRow(jobId: string) {
    const { rows } = await db.pool.query(
      `SELECT id::text AS id, txid::text AS txid, type, caller_id, idempotency_key,
              failure_reason, failure_detail, attempt_count, recipients, rejected_recipients,
              recipients_redacted_at, created_at, row_to_json(mail_events)::text AS as_text
         FROM mail_events WHERE job_id = $1`,
      [jobId],
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function attemptRows(jobId: string) {
    const { rows } = await db.pool.query(
      `SELECT classification, stage, response_code, enhanced_code, rejected_recipients,
              row_to_json(mail_attempts)::text AS as_text
         FROM mail_attempts WHERE job_id = $1 ORDER BY id`,
      [jobId],
    );
    return rows;
  }

  async function expectRedacted(jobId: string): Promise<void> {
    const event = await eventRow(jobId);
    expect(event.recipients).toEqual({});
    expect(event.rejected_recipients).toBeNull();
    expect(event.recipients_redacted_at).toBeInstanceOf(Date);
    for (const value of Object.values(CANARY))
      expect(event.as_text).not.toContain(value);
    for (const attempt of await attemptRows(jobId)) {
      expect(attempt.rejected_recipients).toBeNull();
      for (const value of Object.values(CANARY))
        expect(attempt.as_text).not.toContain(value);
    }
  }

  async function expectUntouched(jobId: string): Promise<void> {
    const event = await eventRow(jobId);
    expect(event.recipients).toEqual(RECIPIENTS);
    expect(event.recipients_redacted_at).toBeNull();
  }

  it("유예가 지난 JOB_SENT·JOB_FAILED·JOB_EXPIRED·JOB_CANCELED의 수신자와 거부 수신자를 비우고 표지를 쓴다", async () => {
    const ids = [
      await finish.sent(),
      await finish.failed(),
      await finish.expired(),
      await finish.canceled(),
    ];
    for (const id of ids) await age(id, GRACE + DAY);
    // 비우기 전: 이벤트와 SENT 시도 기록에 거부 수신자가 남아 있다(RQ-071이 비우지 않는 값).
    expect((await eventRow(ids[0]!)).rejected_recipients).toEqual(REJECTED);
    expect((await attemptRows(ids[0]!))[0].rejected_recipients).toEqual(
      REJECTED,
    );

    const count = await redactEventRecipients(db.pool, GRACE);

    expect(count).toBe(4);
    for (const id of ids) await expectRedacted(id);
  });

  it("유예 경계: 유예를 넘긴 이벤트만 비우고 유예 안(1초 남음)과 최근 이벤트는 그대로다", async () => {
    const over = await finish.sent();
    const justUnder = await finish.sent();
    const recent = await finish.sent();
    await age(over, GRACE + 1);
    await age(justUnder, GRACE - 5);

    expect(await redactEventRecipients(db.pool, GRACE)).toBe(1);

    await expectRedacted(over);
    for (const id of [justUnder, recent]) {
      await expectUntouched(id);
      expect((await eventRow(id)).rejected_recipients).toEqual(REJECTED);
      expect((await attemptRows(id))[0].rejected_recipients).toEqual(REJECTED);
    }
  });

  it("INTAKE_REJECTED 이벤트는 대상이 아니다(수신자가 없고 표지를 쓰지 않는다)", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await recordIntakeRejection(client, {
        callerId: "caller-a",
        fileName: "a.jws",
        sizeBytes: 10,
        sha256: "a".repeat(64),
        reasonCode: "SIGNATURE_INVALID",
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await db.pool.query(
      "UPDATE mail_events SET created_at = now() - make_interval(secs => $1) WHERE type = 'INTAKE_REJECTED'",
      [GRACE * 2],
    );

    expect(await redactEventRecipients(db.pool, GRACE)).toBe(0);

    const { rows } = await db.pool.query(
      "SELECT recipients_redacted_at FROM mail_events WHERE type = 'INTAKE_REJECTED'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].recipients_redacted_at).toBeNull();
  });

  it("다시 실행해도 이미 비운 이벤트를 처리하지 않는다(멱등, 표지 시각이 바뀌지 않는다)", async () => {
    const id = await finish.sent();
    await age(id, GRACE + DAY);
    expect(await redactEventRecipients(db.pool, GRACE)).toBe(1);
    const first = (await eventRow(id)).recipients_redacted_at as Date;

    expect(await redactEventRecipients(db.pool, GRACE)).toBe(0);

    expect((await eventRow(id)).recipients_redacted_at).toEqual(first);
  });

  it("한 번에 배치 크기까지만 비우고 남은 대상은 다음 호출이 이어받는다", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = await finish.failed();
      await age(id, GRACE + DAY + i);
      ids.push(id);
    }

    expect(await redactEventRecipients(db.pool, GRACE, 2)).toBe(2);
    expect(await redactEventRecipients(db.pool, GRACE, 2)).toBe(2);
    expect(await redactEventRecipients(db.pool, GRACE, 2)).toBe(1);
    expect(await redactEventRecipients(db.pool, GRACE, 2)).toBe(0);
    for (const id of ids) await expectRedacted(id);
  });

  it("비워도 이벤트 ID·txid·종류·사유·시각과 시도 기록의 나머지 열은 바뀌지 않는다", async () => {
    const id = await finish.failed();
    await age(id, GRACE + DAY);
    const before = await eventRow(id);
    const attemptsBefore = await attemptRows(id);

    await redactEventRecipients(db.pool, GRACE);

    const after = await eventRow(id);
    for (const key of [
      "id",
      "txid",
      "type",
      "caller_id",
      "idempotency_key",
      "failure_reason",
      "failure_detail",
      "attempt_count",
      "created_at",
    ] as const)
      expect(after[key]).toEqual(before[key]);
    const attemptsAfter = await attemptRows(id);
    expect(attemptsAfter).toHaveLength(attemptsBefore.length);
    expect(attemptsAfter[0]).toMatchObject({
      classification: "PERMANENT",
      stage: "RCPT",
      response_code: 550,
      enhanced_code: "5.1.1",
    });
  });

  it("비운 이벤트도 피드가 같은 순서·같은 cursor로 돌려주고 recipientsRedacted와 빈 수신자를 낸다", async () => {
    const ids = [
      await finish.sent(),
      await finish.failed(),
      await finish.expired(),
      await finish.canceled(),
    ];
    for (const id of ids) await age(id, GRACE + DAY);
    const before = await listEvents(db.pool, { callerId: "caller-a" });
    const firstPage = await listEvents(db.pool, {
      callerId: "caller-a",
      limit: 2,
    });

    await redactEventRecipients(db.pool, GRACE);

    const after = await listEvents(db.pool, { callerId: "caller-a" });
    expect(after.events.map((e) => e.id)).toEqual(
      before.events.map((e) => e.id),
    );
    expect(after.events.map((e) => e.type)).toEqual(
      before.events.map((e) => e.type),
    );
    expect(after.nextCursor).toBe(before.nextCursor);
    for (const event of before.events) {
      expect(event.recipientsRedacted).toBe(false);
      expect(event.recipients).toEqual(RECIPIENTS);
    }
    for (const event of after.events) {
      expect(event.recipientsRedacted).toBe(true);
      expect(event.recipients).toEqual({});
      expect(event.rejectedRecipients).toBeNull();
    }
    // 비우기 전에 받은 cursor로 이어 읽어도 나머지가 빠지거나 겹치지 않는다.
    const rest = await listEvents(db.pool, {
      callerId: "caller-a",
      after: firstPage.nextCursor,
    });
    expect(rest.events.map((e) => e.id)).toEqual(
      before.events.slice(2).map((e) => e.id),
    );
  });

  it("비움은 삭제 표지를 쓰지 않아 공백 감지가 바뀌지 않는다", async () => {
    const id = await finish.sent();
    await age(id, GRACE + DAY);
    const page = await listEvents(db.pool, { callerId: "caller-a" });
    const cursor = encodeCursor({ txid: "0", id: "0" });
    expect(
      await hasEventGap(db.pool, { callerId: "caller-a", after: cursor }),
    ).toBe(false);

    await redactEventRecipients(db.pool, GRACE);

    const { rows } = await db.pool.query("SELECT 1 FROM mail_event_purges");
    expect(rows).toHaveLength(0);
    expect(
      await hasEventGap(db.pool, { callerId: "caller-a", after: cursor }),
    ).toBe(false);
    expect(
      await hasEventGap(db.pool, {
        callerId: "caller-a",
        after: page.nextCursor!,
      }),
    ).toBe(false);
  });

  it("정리 잠금(단계 recipients)을 다른 세션이 잡고 있으면 아무것도 하지 않고 0을 돌려준다", async () => {
    const id = await finish.sent();
    await age(id, GRACE + DAY);
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      // 정리 잠금 키 공간(7364223)과 단계 5(`recipients`)는 queue/maintenance.ts의 값이다.
      // 일부러 리터럴로 둔다. 값이 바뀌면 이 테스트가 실패해 다른 단계 잠금과 겹치지 않는지 다시 보게 한다.
      await holder.query("SELECT pg_advisory_xact_lock(7364223, 5)");

      expect(await redactEventRecipients(db.pool, GRACE)).toBe(0);
      await expectUntouched(id);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }

    expect(await redactEventRecipients(db.pool, GRACE)).toBe(1);
  });

  it("다른 단계의 정리 잠금은 이 단계를 막지 않는다", async () => {
    const id = await finish.sent();
    await age(id, GRACE + DAY);
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      for (const step of [1, 2, 3, 4])
        await holder.query("SELECT pg_advisory_xact_lock(7364223, $1)", [step]);

      expect(await redactEventRecipients(db.pool, GRACE)).toBe(1);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("작업 행을 다른 트랜잭션이 잠그고 있으면 그 작업의 이벤트는 건너뛰고 나머지를 비운다(보존 삭제와의 교착 방지)", async () => {
    const locked = await finish.sent();
    const free = await finish.sent();
    await age(locked, GRACE + DAY);
    await age(free, GRACE + DAY);
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM mail_jobs WHERE id = $1 FOR UPDATE", [
        locked,
      ]);

      expect(await redactEventRecipients(db.pool, GRACE)).toBe(1);
      await expectRedacted(free);
      await expectUntouched(locked);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }

    expect(await redactEventRecipients(db.pool, GRACE)).toBe(1);
    await expectRedacted(locked);
  });

  it("보존 삭제와 동시에 돌려도 교착 없이 끝나고 남은 이벤트는 모두 비워져 있다", async () => {
    // 같은 행이 비움 대상이자 삭제 대상인 경우(유예 = 보존)를 겹쳐 돌린다.
    // 작업 행 잠금이 없으면 이쪽(이벤트 → 시도)과 삭제의 cascade(시도 → 이벤트)가 교착해 이 크기에서 매번 실패했다(PostgreSQL 17).
    await db.pool.query(
      `INSERT INTO mail_jobs
         (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version, recipients, expires_at, status, finished_at)
       SELECT gen_random_uuid(), 'caller-a', 'bulk-' || g, '\\x00', 1, '{}', now() + interval '1 day', 'SENT',
              now() - make_interval(secs => $1)
         FROM generate_series(1, 400) g`,
      [GRACE + DAY],
    );
    await db.pool.query(
      `INSERT INTO mail_events (caller_id, type, job_id, idempotency_key, attempt_count, recipients, rejected_recipients, created_at)
       SELECT caller_id, 'JOB_SENT', id, idempotency_key, 1, $2::jsonb, $3::jsonb, now() - make_interval(secs => $1)
         FROM mail_jobs`,
      [GRACE + DAY, JSON.stringify(RECIPIENTS), JSON.stringify(REJECTED)],
    );
    await db.pool.query(
      `INSERT INTO mail_attempts (job_id, classification, counted, started_at, rejected_recipients)
       SELECT id, 'SENT', true, now(), $1::jsonb FROM mail_jobs`,
      [JSON.stringify(REJECTED)],
    );

    for (let round = 0; round < 30; round++) {
      const [redacted, deleted] = await Promise.all([
        redactEventRecipients(db.pool, GRACE, 100),
        deleteExpiredRecords(db.pool, GRACE, 100),
      ]);
      if (redacted === 0 && deleted.jobs === 0) break;
    }

    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM mail_events WHERE recipients_redacted_at IS NULL",
    );
    expect(rows[0].n).toBe(0);
  });
});
