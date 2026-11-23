import "reflect-metadata";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { createHmac } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrator.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { migrate } from "../support/queue-fixtures.js";
import {
  BETA_KEY,
  getJson,
  plainMail,
  postJob,
  startRestApp,
  type RestApp,
} from "../support/rest-app.js";

/**
 * REST 우선순위 계약(실제 HTTP -> PostgreSQL). 근거: RQ-033·034·037·038, ADR-0009.
 * 도입 전 작업은 0001~0003만 적용한 schema에 직접 넣고 나머지 마이그레이션을 적용해 만든다.
 */

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);
// `plainMail()`을 우선순위 도입 전 코드로 정규화한 문자열(test/envelope/open-request.spec.ts 골든 값과 같다).
// 리터럴로 둔다. 도입 전 행의 지문을 새 코드로 계산하면 호환성을 검증하지 못한다.
const LEGACY_CANONICAL =
  '["mailo-fp-v1","no-reply@example.com",null,["kim@example.com"],[],[],"주문 접수 안내","주문이 접수되었습니다.",null,[]]';
// test/support/rest-app.ts의 MAILO_FINGERPRINT_KEY_V1(가짜 키)과 같은 값이다.
const FINGERPRINT_KEY = Buffer.alloc(32, 22);
const PRIORITY_CANARY = "CANARY-PRIORITY-41f7";

interface JobBody {
  jobId: string;
  priority: string;
  status: string;
}

describe("REST 통합: 우선순위 (RQ-033·034·037, ADR-0009)", () => {
  let db: TestDatabase;
  let app: RestApp;
  let legacyJobId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    // 우선순위 도입 전 schema(0001~0003)에 도입 전 작업을 만든다.
    const legacyDir = mkdtempSync(path.join(tmpdir(), "mailo-legacy-mig-"));
    try {
      for (const name of [
        "0001_queue_schema.sql",
        "0002_caller_quota.sql",
        "0003_attempt_instance.sql",
      ])
        copyFileSync(
          path.join(MIGRATIONS_DIR, name),
          path.join(legacyDir, name),
        );
      await runMigrations(db.pool, legacyDir);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO mail_jobs (id, caller_id, idempotency_key, fingerprint, fingerprint_key_version,
                              recipients, envelope, expires_at)
       VALUES (gen_random_uuid(), 'alpha', 'legacy-1', $1, 1, '{"to":["kim@example.com"],"cc":[],"bcc":[]}'::jsonb,
               '{"from":"no-reply@example.com","replyTo":null}'::jsonb, now() + interval '1 day')
       RETURNING id`,
      [createHmac("sha256", FINGERPRINT_KEY).update(LEGACY_CANONICAL).digest()],
    );
    legacyJobId = rows[0]!.id;
    await migrate(db.pool);
    app = await startRestApp({ pool: db.pool });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    await db.pool.query(
      "DELETE FROM mail_jobs WHERE idempotency_key <> 'legacy-1'",
    );
  });

  async function rank(key: string): Promise<number[]> {
    const { rows } = await db.pool.query(
      "SELECT priority FROM mail_jobs WHERE idempotency_key = $1 ORDER BY created_at",
      [key],
    );
    return rows.map((r) => r.priority);
  }

  describe("도입 전 작업 (RQ-034·038)", () => {
    it("마이그레이션 뒤 도입 전 작업은 NORMAL로 읽힌다", async () => {
      const res = await getJson(app, `/jobs/${legacyJobId}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as JobBody).priority).toBe("NORMAL");
      expect(await rank("legacy-1")).toEqual([20]);
    });

    it("같은 Key의 생략·NORMAL 재요청은 도입 전 작업을 200으로 돌려주고 다른 등급은 409이며 기존 작업은 그대로다", async () => {
      for (const body of [
        plainMail(),
        plainMail({ priority: "NORMAL" }),
      ] as const) {
        const res = await postJob(app, { key: "legacy-1", body });
        expect(res.status).toBe(200);
        expect((await res.json()) as JobBody).toMatchObject({
          jobId: legacyJobId,
          priority: "NORMAL",
        });
      }
      for (const priority of ["LOW", "HIGH", "URGENT"]) {
        const res = await postJob(app, {
          key: "legacy-1",
          body: plainMail({ priority }),
        });
        expect(res.status).toBe(409);
      }
      expect(await rank("legacy-1")).toEqual([20]);
    });
  });

  describe("등록·조회 응답", () => {
    it.each([
      ["LOW", 10],
      ["NORMAL", 20],
      ["HIGH", 30],
      ["URGENT", 40],
    ] as const)(
      "%s로 등록하면 202 응답·ID 조회·Key 조회가 등급 이름을 주고 DB에는 순위 %d로 저장한다",
      async (priority, stored) => {
        const key = `grade-${priority}`;
        const res = await postJob(app, { key, body: plainMail({ priority }) });
        expect(res.status).toBe(202);
        const created = (await res.json()) as JobBody;
        expect(created.priority).toBe(priority);

        const byId = (await (
          await getJson(app, `/jobs/${created.jobId}`)
        ).json()) as JobBody;
        const byKey = (await (
          await getJson(app, `/jobs?idempotencyKey=${key}`)
        ).json()) as JobBody;
        expect(byId.priority).toBe(priority);
        expect(byKey.priority).toBe(priority);
        expect(await rank(key)).toEqual([stored]);
      },
    );

    it("생략하면 NORMAL로 등록되고 응답에 순위 숫자가 없다", async () => {
      const res = await postJob(app, { key: "omit-1" });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["priority"]).toBe("NORMAL");
      expect(JSON.stringify(body)).not.toMatch(/"priority":\d/);
    });

    it("같은 Key의 생략과 NORMAL은 같은 작업(200)이고 등급을 바꾸면 409이며 기존 작업의 등급은 그대로다", async () => {
      const first = await postJob(app, { key: "same-1" });
      expect(first.status).toBe(202);
      const again = await postJob(app, {
        key: "same-1",
        body: plainMail({ priority: "NORMAL" }),
      });
      expect(again.status).toBe(200);

      const conflict = await postJob(app, {
        key: "same-1",
        body: plainMail({ priority: "URGENT" }),
      });
      expect(conflict.status).toBe(409);
      expect(await rank("same-1")).toEqual([20]);
    });

    it("URGENT로 등록한 Key를 URGENT로 다시 보내면 200이고 생략하면 409다", async () => {
      const body = plainMail({ priority: "URGENT" });
      expect((await postJob(app, { key: "u-1", body })).status).toBe(202);
      expect((await postJob(app, { key: "u-1", body })).status).toBe(200);
      expect((await postJob(app, { key: "u-1" })).status).toBe(409);
      expect(await rank("u-1")).toEqual([40]);
    });

    it("다른 호출처는 우선순위 작업을 조회할 수 없다(404)", async () => {
      const res = await postJob(app, {
        key: "iso-1",
        body: plainMail({ priority: "URGENT" }),
      });
      const { jobId } = (await res.json()) as JobBody;
      expect((await getJson(app, `/jobs/${jobId}`, BETA_KEY)).status).toBe(404);
      expect(
        (await getJson(app, "/jobs?idempotencyKey=iso-1", BETA_KEY)).status,
      ).toBe(404);
    });
  });

  describe("잘못된 값 (RQ-033, RQ-027)", () => {
    it.each([
      ["null", null],
      ["숫자", 40],
      ["빈 문자열", ""],
      ["소문자", "urgent"],
      ["정의되지 않은 이름", PRIORITY_CANARY],
    ])(
      "%s는 400 /priority INVALID_FORMAT이고 등록하지 않으며 값이 응답·로그에 없다",
      async (_name, priority) => {
        const before = app.logs.lines.length;
        const res = await postJob(app, {
          key: "bad-1",
          body: plainMail({ priority }),
        });
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(JSON.parse(text).errors).toEqual([
          { pointer: "/priority", code: "INVALID_FORMAT" },
        ]);
        expect(text).not.toContain(PRIORITY_CANARY);
        expect(app.logs.lines.slice(before).join("\n")).not.toContain(
          PRIORITY_CANARY,
        );
        expect(await rank("bad-1")).toEqual([]);
      },
    );
  });
});
