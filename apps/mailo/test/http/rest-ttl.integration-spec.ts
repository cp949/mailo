import "reflect-metadata";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { migrate } from "../support/queue-fixtures.js";
import {
  getJson,
  plainMail,
  postJob,
  startRestApp,
  type RestApp,
} from "../support/rest-app.js";

/**
 * REST 요청별 만료 시간 계약(실제 HTTP -> PostgreSQL). 근거: RQ-039, ADR-0010.
 * 기본 TTL 7200초와 상한 172800초(2일)는 운영 기본값과 다르게 둬 생략·지정·상한을 서로 구분한다.
 */

const DEFAULT_TTL = 7200;
const MAX_TTL = 172_800;
const TTL_CANARY = "CANARY-TTL-8b31";

interface JobBody {
  jobId: string;
  createdAt: string;
  expiresAt: string;
}

describe("REST 통합: 요청별 만료 시간 (RQ-039, ADR-0010)", () => {
  let db: TestDatabase;
  let app: RestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    app = await startRestApp({
      pool: db.pool,
      env: {
        MAILO_JOB_EXPIRY_SECONDS: String(DEFAULT_TTL),
        MAILO_JOB_EXPIRY_MAX_SECONDS: String(MAX_TTL),
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
  });

  /** 같은 Key의 행마다 등록 시각과 만료 시각의 차(초)와 만료 시각. */
  async function stored(
    key: string,
  ): Promise<Array<{ ttl: number; expiresAt: Date }>> {
    const { rows } = await db.pool.query<{ ttl: number; expires_at: Date }>(
      `SELECT EXTRACT(EPOCH FROM expires_at - created_at)::int AS ttl, expires_at
         FROM mail_jobs WHERE idempotency_key = $1 ORDER BY created_at`,
      [key],
    );
    return rows.map((r) => ({ ttl: r.ttl, expiresAt: r.expires_at }));
  }

  const ttlOf = (job: JobBody): number =>
    (Date.parse(job.expiresAt) - Date.parse(job.createdAt)) / 1000;

  describe("등록과 만료 시각", () => {
    it.each([
      ["하한", 60],
      ["중간 값", 600],
      ["상한", MAX_TTL],
    ])(
      "%s ttlSeconds(%d)로 등록하면 expires_at이 등록 시각 + ttlSeconds이고 응답·조회의 expiresAt이 같은 값이다",
      async (_name, ttlSeconds) => {
        const key = `ttl-${ttlSeconds}`;
        const res = await postJob(app, {
          key,
          body: plainMail({ ttlSeconds }),
        });
        expect(res.status).toBe(202);
        const created = (await res.json()) as JobBody;

        expect(ttlOf(created)).toBe(ttlSeconds);
        const [row] = await stored(key);
        expect(row!.ttl).toBe(ttlSeconds);
        expect(created.expiresAt).toBe(row!.expiresAt.toISOString());
        const byId = (await (
          await getJson(app, `/jobs/${created.jobId}`)
        ).json()) as JobBody;
        expect(byId.expiresAt).toBe(created.expiresAt);
      },
    );

    it("생략하면 MAILO_JOB_EXPIRY_SECONDS로 등록하고 응답에 ttlSeconds 필드가 없다", async () => {
      const res = await postJob(app, { key: "omit-1" });
      expect(res.status).toBe(202);
      const body = (await res.json()) as JobBody & Record<string, unknown>;

      expect(ttlOf(body)).toBe(DEFAULT_TTL);
      expect(await stored("omit-1")).toMatchObject([{ ttl: DEFAULT_TTL }]);
      expect(Object.hasOwn(body, "ttlSeconds")).toBe(false);
    });
  });

  describe("같은 Key 재요청 (RQ-011, RQ-039)", () => {
    it("같은 ttlSeconds 재요청은 기존 작업(200)이고 만료 시각을 다시 계산하지 않는다", async () => {
      const body = plainMail({ ttlSeconds: 600 });
      const first = (await (
        await postJob(app, { key: "same-1", body })
      ).json()) as JobBody;
      const [before] = await stored("same-1");
      // 재요청 시각이 늦어도 만료 시각이 늘지 않음을 보려고 DB 시계가 움직일 시간을 둔다.
      await new Promise((r) => setTimeout(r, 20));

      const again = await postJob(app, { key: "same-1", body });

      expect(again.status).toBe(200);
      const repeated = (await again.json()) as JobBody;
      expect(repeated.jobId).toBe(first.jobId);
      expect(repeated.expiresAt).toBe(first.expiresAt);
      const rows = await stored("same-1");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    });

    it.each([
      ["다른 ttlSeconds", { ttlSeconds: 600 }, { ttlSeconds: 601 }],
      ["지정 뒤 생략", { ttlSeconds: 600 }, {}],
      ["생략 뒤 지정", {}, { ttlSeconds: 600 }],
      ["생략 뒤 기본값 명시", {}, { ttlSeconds: DEFAULT_TTL }],
    ])(
      "%s는 409이고 기존 작업의 만료 시각은 그대로다",
      async (_name, firstExtra, secondExtra) => {
        const key = "conflict-1";
        const first = await postJob(app, {
          key,
          body: plainMail(firstExtra),
        });
        expect(first.status).toBe(202);
        const [before] = await stored(key);

        const second = await postJob(app, {
          key,
          body: plainMail(secondExtra),
        });

        expect(second.status).toBe(409);
        const rows = await stored(key);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
      },
    );

    it("priority와 ttlSeconds를 함께 보내면 필드 순서가 달라도 같은 작업(200)이다", async () => {
      const first = await postJob(app, {
        key: "both-1",
        body: { ttlSeconds: 900, ...plainMail(), priority: "HIGH" },
      });
      expect(first.status).toBe(202);
      const again = await postJob(app, {
        key: "both-1",
        body: { priority: "HIGH", ...plainMail(), ttlSeconds: 900 },
      });
      expect(again.status).toBe(200);
      expect(
        (
          await postJob(app, {
            key: "both-1",
            body: plainMail({ priority: "HIGH" }),
          })
        ).status,
      ).toBe(409);
    });
  });

  describe("잘못된 값 (RQ-039, RQ-027)", () => {
    it.each([
      ["하한 미만", 59, "OUT_OF_RANGE"],
      ["0", 0, "OUT_OF_RANGE"],
      ["음수", -1, "OUT_OF_RANGE"],
      ["상한 초과", MAX_TTL + 1, "OUT_OF_RANGE"],
      ["소수", 600.5, "INVALID_FORMAT"],
      ["숫자 문자열", "600", "INVALID_FORMAT"],
      ["null", null, "INVALID_FORMAT"],
      ["문자열", TTL_CANARY, "INVALID_FORMAT"],
    ])(
      "%s는 400 /ttlSeconds %s이고 등록하지 않으며 값이 응답·로그에 없다",
      async (_name, ttlSeconds, code) => {
        const before = app.logs.lines.length;
        const res = await postJob(app, {
          key: "bad-1",
          body: plainMail({ ttlSeconds }),
        });

        expect(res.status).toBe(400);
        const text = await res.text();
        expect(JSON.parse(text).errors).toEqual([
          { pointer: "/ttlSeconds", code },
        ]);
        expect(text).not.toContain(TTL_CANARY);
        expect(app.logs.lines.slice(before).join("\n")).not.toContain(
          TTL_CANARY,
        );
        expect(await stored("bad-1")).toEqual([]);
      },
    );

    it("범위 밖 값의 오류에 요청 값과 상한 값이 없다(RQ-027)", async () => {
      const res = await postJob(app, {
        key: "bad-2",
        body: plainMail({ ttlSeconds: 987_654 }),
      });
      const text = await res.text();

      expect(res.status).toBe(400);
      expect(text).not.toContain("987654");
      expect(text).not.toContain(String(MAX_TTL));
    });
  });
});
