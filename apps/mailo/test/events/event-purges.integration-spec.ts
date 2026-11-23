import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import {
  encodeCursor,
  hasEventGap,
  recordIntakeRejection,
  recordJobEvent,
  type EventType,
  type JobEventType,
} from "../../src/events/index.js";
import { deleteExpiredRecords } from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { createJob, migrate } from "../support/queue-fixtures.js";

const DAY = 86_400;
const RETENTION = 30 * DAY;

const TERMINAL_STATUS: Record<JobEventType, string> = {
  JOB_SENT: "SENT",
  JOB_FAILED: "FAILED",
  JOB_EXPIRED: "EXPIRED",
  JOB_CANCELED: "CANCELED",
};

interface Placed {
  jobId: string;
  eventId: string;
  txid: string;
  cursor: string;
}

/**
 * 삭제 표지(RQ-045, ADR-0011 결정 9)의 기록과 판정을 실제 PostgreSQL로 고정한다.
 * 기록: `deleteExpiredRecords`가 지우는 이벤트의 호출처·종류별 최대 `(txid, id)`를 같은 트랜잭션에서 올린다.
 * 판정: 요청한 종류의 표지 중 하나라도 cursor보다 크면 공백이다(cursor와 같으면 공백이 아니다).
 */
describe("PostgreSQL 통합: 이벤트 삭제 표지 기록과 공백 판정 (RQ-045, ADR-0011 결정 9)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query("DELETE FROM mail_intake_rejections");
    await db.pool.query("DELETE FROM mail_event_purges");
  });

  afterEach(async () => {
    await db.pool.query(
      "DROP TRIGGER IF EXISTS fail_purge ON mail_event_purges",
    );
    await db.pool.query("DROP TRIGGER IF EXISTS fail_delete ON mail_jobs");
  });

  afterAll(async () => {
    await db.close();
  });

  /** 종결 작업과 그 이벤트를 만든다. `ageDays`가 보존 기간(30일)을 넘으면 삭제 대상이다. */
  async function place(
    callerId: string,
    type: JobEventType,
    ageDays: number,
  ): Promise<Placed> {
    const jobId = await createJob(db.pool, { callerId });
    await db.pool.query(
      `UPDATE mail_jobs SET status = $2, finished_at = now() - make_interval(days => $3)
        WHERE id = $1`,
      [jobId, TERMINAL_STATUS[type], ageDays],
    );
    await recordJobEvent(db.pool, {
      type,
      callerId,
      jobId,
      idempotencyKey: `k-${jobId}`,
      attemptCount: 1,
      recipients: { to: ["to@example.invalid"] },
    });
    const { rows } = await db.pool.query<{ id: string; txid: string }>(
      "SELECT id::text AS id, txid::text AS txid FROM mail_events WHERE job_id = $1",
      [jobId],
    );
    const row = rows[0]!;
    return {
      jobId,
      eventId: row.id,
      txid: row.txid,
      cursor: encodeCursor({ txid: row.txid, id: row.id }),
    };
  }

  async function purges(): Promise<
    Array<{ caller_id: string; type: string; txid: string; id: string }>
  > {
    const { rows } = await db.pool.query(
      `SELECT caller_id, type, purged_txid::text AS txid, purged_id::text AS id
         FROM mail_event_purges ORDER BY caller_id, type`,
    );
    return rows;
  }

  describe("기록: deleteExpiredRecords (결정 9)", () => {
    it("삭제한 이벤트의 호출처·종류별 최대 위치를 표지에 올린다", async () => {
      const a1 = await place("alpha", "JOB_SENT", 40);
      const a2 = await place("alpha", "JOB_SENT", 41);
      const aFailed = await place("alpha", "JOB_FAILED", 40);
      const aCanceled = await place("alpha", "JOB_CANCELED", 40);
      const b1 = await place("beta", "JOB_SENT", 40);

      const result = await deleteExpiredRecords(db.pool, RETENTION);

      expect(result.jobs).toBe(5);
      const rows = await purges();
      expect(rows).toEqual([
        // a2가 a1보다 늦게 쓰였으므로 id가 크다. 최대 위치는 a2다.
        { caller_id: "alpha", type: "JOB_CANCELED", ...at(aCanceled) },
        { caller_id: "alpha", type: "JOB_FAILED", ...at(aFailed) },
        { caller_id: "alpha", type: "JOB_SENT", ...at(a2) },
        { caller_id: "beta", type: "JOB_SENT", ...at(b1) },
      ]);
      expect(BigInt(a2.eventId)).toBeGreaterThan(BigInt(a1.eventId));
    });

    it("수집 거부 기록을 지울 때 INTAKE_REJECTED 이벤트의 표지도 올린다", async () => {
      await recordIntakeRejection(db.pool, {
        callerId: "alpha",
        fileName: "old.json",
        sizeBytes: 1,
        sha256: "a".repeat(64),
        reasonCode: "MALFORMED",
      });
      await db.pool.query(
        "UPDATE mail_intake_rejections SET created_at = now() - interval '40 days'",
      );
      const { rows } = await db.pool.query<{ id: string; txid: string }>(
        "SELECT id::text, txid::text FROM mail_events WHERE type = 'INTAKE_REJECTED'",
      );

      const result = await deleteExpiredRecords(db.pool, RETENTION);

      expect(result.rejections).toBe(1);
      expect(await purges()).toEqual([
        {
          caller_id: "alpha",
          type: "INTAKE_REJECTED",
          txid: rows[0]!.txid,
          id: rows[0]!.id,
        },
      ]);
    });

    it("보존 기간 안의 작업과 삭제 대상이 없는 호출처는 표지를 만들지 않는다", async () => {
      await place("alpha", "JOB_SENT", 29);
      const old = await place("beta", "JOB_FAILED", 40);

      await deleteExpiredRecords(db.pool, RETENTION);

      expect(await purges()).toEqual([
        { caller_id: "beta", type: "JOB_FAILED", ...at(old) },
      ]);
    });

    it("표지는 줄어들지 않고 나중에 더 작은 위치가 삭제돼도 값이 유지된다", async () => {
      const early = await place("alpha", "JOB_SENT", 29);
      const late = await place("alpha", "JOB_SENT", 40);
      await deleteExpiredRecords(db.pool, RETENTION);
      expect(await purges()).toEqual([
        { caller_id: "alpha", type: "JOB_SENT", ...at(late) },
      ]);

      // 앞선 위치의 이벤트가 나중에 삭제 대상이 된다(삭제는 순서가 없다).
      await db.pool.query(
        "UPDATE mail_jobs SET finished_at = now() - interval '40 days' WHERE id = $1",
        [early.jobId],
      );
      await deleteExpiredRecords(db.pool, RETENTION);

      expect(await purges()).toEqual([
        { caller_id: "alpha", type: "JOB_SENT", ...at(late) },
      ]);
    });

    it("삭제를 반복해도 표지 행은 호출처×종류 수를 넘지 않는다", async () => {
      for (let round = 0; round < 5; round += 1) {
        await place("alpha", "JOB_SENT", 40);
        await place("alpha", "JOB_FAILED", 40);
        await place("beta", "JOB_SENT", 40);
        await deleteExpiredRecords(db.pool, RETENTION);
      }
      expect(await purges()).toHaveLength(3);
    });

    it("배치 크기보다 많이 지워도 표지가 전체의 최대 위치까지 오른다", async () => {
      await place("alpha", "JOB_SENT", 40);
      await place("alpha", "JOB_SENT", 40);
      const last = await place("alpha", "JOB_SENT", 40);

      // 배치 크기 2: 한 번에 다 지우지 못한다. 선택 순서는 정해져 있지 않으므로 끝까지 돌린다.
      let rounds = 0;
      while ((await deleteExpiredRecords(db.pool, RETENTION, 2)).jobs > 0)
        rounds += 1;

      expect(rounds).toBe(2);
      const rows = await purges();
      expect(rows).toHaveLength(1);
      expect(BigInt(rows[0]!.id)).toBe(BigInt(last.eventId));
    });

    it("표지 갱신이 실패하면 삭제도 롤백한다(같은 트랜잭션)", async () => {
      const placed = await place("alpha", "JOB_SENT", 40);
      await db.pool.query(
        `CREATE FUNCTION fail_purge() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN RAISE EXCEPTION 'purge write failed'; END $$`,
      );
      await db.pool.query(
        `CREATE TRIGGER fail_purge BEFORE INSERT OR UPDATE ON mail_event_purges
           FOR EACH ROW EXECUTE FUNCTION fail_purge()`,
      );

      await expect(deleteExpiredRecords(db.pool, RETENTION)).rejects.toThrow(
        "purge write failed",
      );

      const jobs = await db.pool.query(
        "SELECT 1 FROM mail_jobs WHERE id = $1",
        [placed.jobId],
      );
      const events = await db.pool.query(
        "SELECT 1 FROM mail_events WHERE job_id = $1",
        [placed.jobId],
      );
      expect(jobs.rowCount).toBe(1);
      expect(events.rowCount).toBe(1);
    });

    it("삭제가 실패하면 표지 갱신도 롤백한다(같은 트랜잭션)", async () => {
      await place("alpha", "JOB_SENT", 40);
      await db.pool.query(
        `CREATE FUNCTION fail_delete() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN RAISE EXCEPTION 'delete failed'; END $$`,
      );
      await db.pool.query(
        `CREATE TRIGGER fail_delete BEFORE DELETE ON mail_jobs
           FOR EACH ROW EXECUTE FUNCTION fail_delete()`,
      );

      await expect(deleteExpiredRecords(db.pool, RETENTION)).rejects.toThrow(
        "delete failed",
      );

      expect(await purges()).toEqual([]);
    });
  });

  describe("판정: hasEventGap (결정 9)", () => {
    const ask = (
      cursor: string,
      options: { callerId?: string; types?: EventType[] } = {},
    ) =>
      hasEventGap(db.pool, {
        callerId: options.callerId ?? "alpha",
        after: cursor,
        types: options.types ?? [],
      });

    it("cursor가 표지와 같으면 공백이 아니고 표지보다 앞이면 공백이며 뒤면 공백이 아니다", async () => {
      const before = await place("alpha", "JOB_SENT", 29);
      const purged = await place("alpha", "JOB_SENT", 40);
      const after = await place("alpha", "JOB_SENT", 29);
      await deleteExpiredRecords(db.pool, RETENTION);

      expect(await ask(before.cursor)).toBe(true);
      expect(await ask(purged.cursor)).toBe(false);
      expect(await ask(after.cursor)).toBe(false);
    });

    it("표지가 없으면 공백이 아니다(삭제가 없는 호출처는 신호가 없다)", async () => {
      const placed = await place("alpha", "JOB_SENT", 29);
      expect(await ask(placed.cursor)).toBe(false);
    });

    it("다른 호출처의 삭제는 공백으로 판정하지 않는다(호출처 격리)", async () => {
      const mine = await place("alpha", "JOB_SENT", 29);
      await place("beta", "JOB_SENT", 40);
      await deleteExpiredRecords(db.pool, RETENTION);

      expect(await ask(mine.cursor, { callerId: "alpha" })).toBe(false);
      // beta의 표지는 beta의 cursor 기준으로만 본다. alpha의 cursor는 beta 이벤트보다 앞이지만 호출처가 다르다.
      expect(
        await ask(encodeCursor({ txid: "0", id: "0" }), { callerId: "beta" }),
      ).toBe(true);
    });

    it("type 필터를 쓰면 요청한 종류의 표지만 본다", async () => {
      const cursor = (await place("alpha", "JOB_FAILED", 29)).cursor;
      await place("alpha", "JOB_SENT", 40);
      await deleteExpiredRecords(db.pool, RETENTION);

      expect(await ask(cursor, { types: ["JOB_FAILED"] })).toBe(false);
      expect(await ask(cursor, { types: ["JOB_EXPIRED"] })).toBe(false);
      expect(await ask(cursor, { types: ["JOB_SENT"] })).toBe(true);
      expect(await ask(cursor, { types: ["JOB_FAILED", "JOB_SENT"] })).toBe(
        true,
      );
      // 필터가 없으면 모든 종류를 본다.
      expect(await ask(cursor)).toBe(true);
    });

    it("JOB_CANCELED와 INTAKE_REJECTED 삭제도 각 종류의 공백으로 판정한다", async () => {
      const cursor = (await place("alpha", "JOB_SENT", 29)).cursor;
      await place("alpha", "JOB_CANCELED", 40);
      await deleteExpiredRecords(db.pool, RETENTION);
      expect(await ask(cursor, { types: ["JOB_CANCELED"] })).toBe(true);
      expect(await ask(cursor, { types: ["INTAKE_REJECTED"] })).toBe(false);

      await recordIntakeRejection(db.pool, {
        callerId: "alpha",
        fileName: "old.json",
        sizeBytes: 1,
        sha256: "b".repeat(64),
        reasonCode: "MALFORMED",
      });
      await db.pool.query(
        "UPDATE mail_intake_rejections SET created_at = now() - interval '40 days'",
      );
      await deleteExpiredRecords(db.pool, RETENTION);
      expect(await ask(cursor, { types: ["INTAKE_REJECTED"] })).toBe(true);
    });

    it("cursor가 표지를 넘으면 신호가 사라진다(nextCursor로 이어 읽는 호출처)", async () => {
      await place("alpha", "JOB_SENT", 40);
      const survivor = await place("alpha", "JOB_SENT", 29);
      await deleteExpiredRecords(db.pool, RETENTION);

      expect(await ask(encodeCursor({ txid: "0", id: "0" }))).toBe(true);
      expect(await ask(survivor.cursor)).toBe(false);
    });
  });

  function at(placed: Placed): { txid: string; id: string } {
    return { txid: placed.txid, id: placed.eventId };
  }
});
