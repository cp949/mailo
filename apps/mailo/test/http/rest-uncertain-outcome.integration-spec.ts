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
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrator.js";
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
 * REST `onUncertainOutcome` 계약(실제 HTTP -> PostgreSQL). 근거: RQ-073, ADR-0015 결정 6·9.
 * 도입 전 작업은 0001~0016만 적용한 schema에 직접 넣고 0019를 적용해 만든다.
 * 같은 Key의 재요청 판정은 지문이 한다. 생략과 `retry` 명시는 다른 요청이다(결정 6).
 */

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);
// `plainMail()`을 필드 도입 전 코드로 정규화한 문자열(test/envelope/open-request.spec.ts 골든 값과 같다).
// 리터럴로 둔다. 도입 전 행의 지문을 새 코드로 계산하면 호환성을 검증하지 못한다.
const LEGACY_CANONICAL =
  '["mailo-fp-v1","no-reply@example.com",null,["kim@example.com"],[],[],"주문 접수 안내","주문이 접수되었습니다.",null,[]]';
// test/support/rest-app.ts의 MAILO_FINGERPRINT_KEY_V1(가짜 키)과 같은 값이다.
const FINGERPRINT_KEY = Buffer.alloc(32, 22);
const CANARY = "CANARY-UNCERTAIN-93ac";

interface JobBody {
  jobId: string;
  status: string;
}

describe("REST 통합: onUncertainOutcome (RQ-073, ADR-0015 결정 6·9)", () => {
  let db: TestDatabase;
  let app: RestApp;
  let legacyJobId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    // 필드·컬럼 도입 전 schema(0001~0016)에 도입 전 작업을 만든다.
    const legacyDir = mkdtempSync(path.join(tmpdir(), "mailo-legacy-mig-"));
    try {
      for (const name of readdirSync(MIGRATIONS_DIR))
        if (/^00(0[1-9]|1[0-6])_/.test(name))
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

  async function policyOf(key: string): Promise<string[]> {
    const { rows } = await db.pool.query(
      "SELECT on_uncertain FROM mail_jobs WHERE idempotency_key = $1 ORDER BY created_at",
      [key],
    );
    return rows.map((r) => r.on_uncertain);
  }

  describe("도입 전 작업 (결정 9)", () => {
    it("마이그레이션 뒤 도입 전 작업은 retry로 읽히고 조회 응답은 그대로 동작한다", async () => {
      expect(await policyOf("legacy-1")).toEqual(["retry"]);
      const res = await getJson(app, `/jobs/${legacyJobId}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ jobId: legacyJobId });
    });

    it("같은 Key의 생략 재요청은 도입 전 작업을 200으로 돌려주고 명시한 값은 409이며 기존 작업은 그대로다", async () => {
      const same = await postJob(app, { key: "legacy-1", body: plainMail() });
      expect(same.status).toBe(200);
      expect(((await same.json()) as JobBody).jobId).toBe(legacyJobId);

      // 도입 전 지문에는 이 필드가 없다. `retry` 명시도 다른 요청이라 409다(결정 6).
      for (const onUncertainOutcome of ["retry", "fail"]) {
        const res = await postJob(app, {
          key: "legacy-1",
          body: plainMail({ onUncertainOutcome }),
        });
        expect(res.status).toBe(409);
      }
      expect(await policyOf("legacy-1")).toEqual(["retry"]);
    });
  });

  describe("등록과 같은 Key 재요청", () => {
    it.each([
      ["생략", undefined, "retry"],
      ["retry", "retry", "retry"],
      ["fail", "fail", "fail"],
    ] as const)(
      "%s로 등록하면 202이고 on_uncertain이 %s로 고정되며 응답에 이 필드가 없다",
      async (_name, value, stored) => {
        const key = `reg-${stored}-${value ?? "omit"}`;
        const res = await postJob(app, {
          key,
          body: plainMail(
            value === undefined ? {} : { onUncertainOutcome: value },
          ),
        });
        expect(res.status).toBe(202);
        const body = (await res.json()) as Record<string, unknown>;
        expect(Object.hasOwn(body, "onUncertainOutcome")).toBe(false);
        expect(await policyOf(key)).toEqual([stored]);
      },
    );

    it("fail로 등록한 Key를 fail로 다시 보내면 200이고 생략·retry·다른 값이면 409이며 기존 작업의 정책은 그대로다", async () => {
      const body = plainMail({ onUncertainOutcome: "fail" });
      const first = await postJob(app, { key: "f-1", body });
      expect(first.status).toBe(202);
      const jobId = ((await first.json()) as JobBody).jobId;

      const again = await postJob(app, { key: "f-1", body });
      expect(again.status).toBe(200);
      expect(((await again.json()) as JobBody).jobId).toBe(jobId);

      expect((await postJob(app, { key: "f-1" })).status).toBe(409);
      expect(
        (
          await postJob(app, {
            key: "f-1",
            body: plainMail({ onUncertainOutcome: "retry" }),
          })
        ).status,
      ).toBe(409);
      expect(await policyOf("f-1")).toEqual(["fail"]);
    });

    it("retry로 등록한 Key를 fail로 바꿔 보내면 409이고 기존 작업의 정책은 그대로다", async () => {
      expect(
        (
          await postJob(app, {
            key: "r-1",
            body: plainMail({ onUncertainOutcome: "retry" }),
          })
        ).status,
      ).toBe(202);

      const res = await postJob(app, {
        key: "r-1",
        body: plainMail({ onUncertainOutcome: "fail" }),
      });

      expect(res.status).toBe(409);
      expect(await policyOf("r-1")).toEqual(["retry"]);
    });
  });

  describe("잘못된 값 (RQ-073, RQ-027)", () => {
    it.each([
      ["null", null],
      ["숫자", 1],
      ["대문자", "FAIL"],
      ["정의되지 않은 이름", CANARY],
    ])(
      "%s는 400 /onUncertainOutcome INVALID_FORMAT이고 등록하지 않으며 값이 응답·로그에 없다",
      async (_name, onUncertainOutcome) => {
        const before = app.logs.lines.length;
        const res = await postJob(app, {
          key: "bad-1",
          body: plainMail({ onUncertainOutcome }),
        });
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(JSON.parse(text).errors).toEqual([
          { pointer: "/onUncertainOutcome", code: "INVALID_FORMAT" },
        ]);
        expect(text).not.toContain(CANARY);
        expect(app.logs.lines.slice(before).join("\n")).not.toContain(CANARY);
        expect(await policyOf("bad-1")).toEqual([]);
      },
    );
  });
});
