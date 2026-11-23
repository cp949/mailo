import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import {
  getQueueBacklog,
  BACKLOG_COUNT_LIMIT,
  type Priority,
} from "../../src/queue/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { createJob, migrate, pastDue } from "../support/queue-fixtures.js";
import {
  ALPHA_KEY,
  getJson,
  postJob,
  startRestApp,
  type RestApp,
} from "../support/rest-app.js";

// 테스트용 가짜 토큰이다. 실제 시크릿이 아니다.
const OPS_TOKEN = "ops-fake-token-0000000000000000000000000001";

/**
 * /health/ready의 운영자 응답(RQ-031, H2). 발송 정지 감지용 수치는 운영자 토큰에만 준다.
 * 정지 상태는 ready(200/503)에 반영하지 않는다.
 */
describe("PostgreSQL 통합: 헬스 운영자 응답 (RQ-031)", () => {
  let db: TestDatabase;
  let app: RestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    app = await startRestApp({
      pool: db.pool,
      env: { MAILO_OPS_TOKEN: OPS_TOKEN },
    });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
  });

  it("운영자 토큰은 큐 적체와 Worker·파일 폴러 상태를 받는다(Worker와 파일 채널이 꺼져 있으면 disabled)", async () => {
    const id = await createJob(db.pool, { callerId: "alpha" });
    await db.pool.query(
      "UPDATE mail_jobs SET next_attempt_at = now() - interval '90 seconds' WHERE id = $1",
      [id],
    );
    await createJob(db.pool, { callerId: "beta" });

    const res = await getJson(app, "/health/ready", OPS_TOKEN);
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body["status"]).toBe("UP");
    expect(body["queue"].dueCount).toBe(2);
    expect(body["queue"].dueCountTruncated).toBe(false);
    expect(body["queue"].oldestDueAgeSeconds).toBeGreaterThanOrEqual(90);
    expect(body["queue"].oldestDueAgeSeconds).toBeLessThan(100);
    expect(body["worker"]).toEqual({ state: "disabled" });
    expect(body["filePoller"]).toEqual({ enabled: false });
    // 운영자도 차단기 상세를 받는다. 호출처 전용 eventFeed는 없다.
    expect(body["circuitBreaker"]).toEqual({
      state: "closed",
      openUntil: null,
      lastReason: null,
    });
    expect(body["eventFeed"]).toBeUndefined();
    // 작업 ID·수신자·키는 응답에 없다.
    expect(JSON.stringify(body)).not.toContain(id);
    expect(JSON.stringify(body)).not.toContain("example.invalid");
  });

  it("호출처 API 키와 인증 없는 호출에는 전역 큐 수치를 주지 않는다", async () => {
    await createJob(db.pool, { callerId: "alpha" });

    for (const auth of [ALPHA_KEY, null]) {
      const res = await getJson(app, "/health/ready", auth);
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body["queue"]).toBeUndefined();
      expect(body["worker"]).toBeUndefined();
      expect(body["filePoller"]).toBeUndefined();
    }
  });

  it("운영자 토큰은 업무 endpoint에서 401이다", async () => {
    const res = await postJob(app, { auth: OPS_TOKEN, key: "ops-key" });

    expect(res.status).toBe(401);
  });

  it("미래 시각 작업은 적체에 세지 않고 대기 작업이 없으면 oldestDueAgeSeconds는 null이다", async () => {
    const id = await createJob(db.pool, { callerId: "alpha" });
    await db.pool.query(
      "UPDATE mail_jobs SET next_attempt_at = now() + interval '1 hour', status = 'RETRY_WAIT' WHERE id = $1",
      [id],
    );

    const body = (await (
      await getJson(app, "/health/ready", OPS_TOKEN)
    ).json()) as { queue: Record<string, unknown> };

    expect(body.queue).toEqual({
      dueCount: 0,
      dueCountTruncated: false,
      oldestDueAgeSeconds: null,
      dueCountByPriority: { LOW: 0, NORMAL: 0, HIGH: 0, URGENT: 0 },
      dueCountTruncatedByPriority: {
        LOW: false,
        NORMAL: false,
        HIGH: false,
        URGENT: false,
      },
      oldestDueAgeSecondsByPriority: {
        LOW: null,
        NORMAL: null,
        HIGH: null,
        URGENT: null,
      },
    });
  });

  it(`적체가 ${BACKLOG_COUNT_LIMIT}건을 넘으면 dueCount는 상한에서 멈추고 truncated가 true다`, async () => {
    const id = await createJob(db.pool, { callerId: "alpha" });
    await pastDue(db.pool, id);
    await db.pool.query(
      `INSERT INTO mail_jobs (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version,
                              expires_at, recipients)
       SELECT gen_random_uuid(), 'bulk', 'bulk-' || g, '\\x00', 1, now() + interval '1 day', '{}'::jsonb
         FROM generate_series(1, ${BACKLOG_COUNT_LIMIT + 5}) g`,
    );

    const backlog = await getQueueBacklog(db.pool);

    expect(backlog.dueCount).toBe(BACKLOG_COUNT_LIMIT);
    expect(backlog.truncated).toBe(true);
    expect(backlog.oldestDueAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  describe("등급별 적체 (RQ-037, ADR-0009)", () => {
    async function graded(
      priority: Priority,
      waited: number,
      status = "PENDING",
    ): Promise<string> {
      const id = await createJob(db.pool, { callerId: "alpha", priority });
      await db.pool.query(
        "UPDATE mail_jobs SET status = $3, next_attempt_at = now() - make_interval(secs => $2) WHERE id = $1",
        [id, waited, status],
      );
      return id;
    }

    it("운영자 토큰 응답에 네 등급의 dueCount·oldestDueAgeSeconds가 등급 이름 키로 있다", async () => {
      await graded("LOW", 200);
      await graded("LOW", 50, "RETRY_WAIT");
      await graded("NORMAL", 90);
      await graded("URGENT", 10);
      await graded("URGENT", -3600, "RETRY_WAIT"); // 미래 재시도는 세지 않는다
      const sending = await graded("HIGH", 30);
      await db.pool.query(
        `UPDATE mail_jobs SET status = 'SENDING', lease_token = gen_random_uuid(),
                leased_at = now(), lease_until = now() + interval '1 minute' WHERE id = $1`,
        [sending],
      );

      const { queue } = (await (
        await getJson(app, "/health/ready", OPS_TOKEN)
      ).json()) as { queue: Record<string, Record<string, unknown>> };

      expect(queue["dueCount"]).toBe(4);
      expect(queue["dueCountByPriority"]).toEqual({
        LOW: 2,
        NORMAL: 1,
        HIGH: 0,
        URGENT: 1,
      });
      expect(queue["dueCountTruncatedByPriority"]).toEqual({
        LOW: false,
        NORMAL: false,
        HIGH: false,
        URGENT: false,
      });
      const ages = queue["oldestDueAgeSecondsByPriority"] as Record<
        string,
        number | null
      >;
      expect(Object.keys(ages).sort()).toEqual(
        ["HIGH", "LOW", "NORMAL", "URGENT"].sort(),
      );
      expect(ages["HIGH"]).toBeNull();
      expect(ages["LOW"]).toBeGreaterThanOrEqual(200);
      expect(ages["LOW"]).toBeLessThan(210);
      expect(ages["NORMAL"]).toBeGreaterThanOrEqual(90);
      expect(ages["NORMAL"]).toBeLessThan(100);
      expect(ages["URGENT"]).toBeGreaterThanOrEqual(10);
      expect(ages["URGENT"]).toBeLessThan(20);
    });

    it("전체·등급별 적체를 문장 하나로 읽어 헬스의 문 시간제한 하나 안에 든다", async () => {
      await graded("HIGH", 10);
      let queries = 0;
      const counting = {
        query: (...args: Parameters<typeof db.pool.query>) => {
          queries += 1;
          return (db.pool.query as (...a: unknown[]) => unknown)(...args);
        },
      } as unknown as typeof db.pool;

      const backlog = await getQueueBacklog(counting);

      expect(queries).toBe(1);
      expect(backlog.dueCount).toBe(1);
      expect(backlog.byPriority.HIGH.dueCount).toBe(1);
    });

    it("운영자 토큰이 없으면 등급별 수치도 나오지 않는다", async () => {
      await graded("URGENT", 10);
      for (const auth of [ALPHA_KEY, null]) {
        const text = await (await getJson(app, "/health/ready", auth)).text();
        expect(text).not.toContain("ByPriority");
        expect(text).not.toContain("URGENT");
      }
    });

    it(`등급별 수치는 등급마다 ${BACKLOG_COUNT_LIMIT}건 상한이 따로 걸린다`, async () => {
      await graded("LOW", 5);
      await graded("LOW", 6);
      await db.pool.query(
        `INSERT INTO mail_jobs (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version,
                                expires_at, recipients, priority)
         SELECT gen_random_uuid(), 'bulk', 'bulk-' || g, '\\x00', 1, now() + interval '1 day', '{}'::jsonb, 40
           FROM generate_series(1, ${BACKLOG_COUNT_LIMIT + 5}) g`,
      );

      const backlog = await getQueueBacklog(db.pool);

      expect(backlog.byPriority.URGENT).toMatchObject({
        dueCount: BACKLOG_COUNT_LIMIT,
        truncated: true,
      });
      expect(backlog.byPriority.LOW).toMatchObject({
        dueCount: 2,
        truncated: false,
      });
      expect(backlog.byPriority.NORMAL).toEqual({
        dueCount: 0,
        truncated: false,
        oldestDueAgeSeconds: null,
      });
    });
  });
});
