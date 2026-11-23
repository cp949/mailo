import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readdirSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type pg from "pg";
import { listEvents } from "../../src/events/index.js";
import {
  FileChannelStartError,
  type PollSummary,
} from "../../src/file-channel/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  encryptContent,
  jwsSecret,
  replaceJweSegment,
  rsaKey,
} from "../support/envelope.js";
import {
  MAILO_JWE_KID,
  createFileHarness,
  fileRequest,
  mkfifo,
  signedFile,
  type FileHarness,
} from "../support/file-channel.js";
import { migrate } from "../support/queue-fixtures.js";

/**
 * 파일 채널 폴러(실제 PostgreSQL + 임시 디렉터리). 근거: RQ-002·024·027·028·030, ADR-0004 결정 3~9, ADR-0006 결정 3,
 * ADR-0008 결정 3. NFS는 검증하지 않았다(3단계).
 */

const CANARY = {
  subject: "CANARY-FILE-SUBJECT-6a41",
  text: "CANARY-FILE-TEXT-e90d",
  raw: "CANARY-FILE-RAW-b7c2",
};
const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const json = (value: unknown) => JSON.stringify(value);
const asRoot = process.getuid?.() === 0;

interface JobRow {
  caller_id: string;
  idempotency_key: string;
  status: string;
}
interface RejectionRow {
  caller_id: string;
  file_name: string;
  size_bytes: string;
  sha256: string;
  idempotency_key: string | null;
  reason_code: string;
}

function total(
  summary: PollSummary,
  key:
    | "registered"
    | "duplicates"
    | "rejected"
    | "rejectedRepeats"
    | "errors"
    | "gone"
    | "unreadable"
    | "deleteFailed"
    | "tempDeleted",
) {
  return summary.callers.reduce((sum, c) => sum + c[key], 0);
}

describe("파일 채널 폴러 (RQ-002, ADR-0004)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let h: FileHarness;

  const jobs = async (): Promise<JobRow[]> =>
    (
      await pool.query<JobRow>(
        "SELECT caller_id, idempotency_key, status FROM mail_jobs ORDER BY caller_id, idempotency_key",
      )
    ).rows;
  const rejections = async (): Promise<RejectionRow[]> =>
    (
      await pool.query<RejectionRow>(
        `SELECT caller_id, file_name, size_bytes::text, sha256, idempotency_key, reason_code
           FROM mail_intake_rejections ORDER BY id`,
      )
    ).rows;
  const rejectionEvents = async (): Promise<number> =>
    (
      await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM mail_events WHERE type = 'INTAKE_REJECTED'",
      )
    ).rows[0]!.n;
  const files = (callerId: string): string[] =>
    readdirSync(h.inbox(callerId)).sort();

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    await migrate(pool);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM mail_events");
    await pool.query("DELETE FROM mail_intake_rejections");
    await pool.query("DELETE FROM mail_jobs");
    h = createFileHarness(pool);
  });

  afterEach(() => {
    h.cleanup();
  });

  describe("정상 수집", () => {
    it("정상 JSON(서명 none)을 등록하고 원본을 지운다", async () => {
      h.drop("alpha", "a1.json", json(fileRequest({ idempotencyKey: "k-1" })));

      const summary = await h.makePoller().pollOnce();

      expect(total(summary, "registered")).toBe(1);
      expect(await jobs()).toEqual([
        { caller_id: "alpha", idempotency_key: "k-1", status: "PENDING" },
      ]);
      expect(files("alpha")).toEqual([]);
      expect(await rejections()).toEqual([]);
    });

    it("본문은 DB에 평문으로 남지 않는다(RQ-023)", async () => {
      h.drop(
        "alpha",
        "a1.json",
        json(fileRequest({ subject: CANARY.subject, text: CANARY.text })),
      );

      await h.makePoller().pollOnce();

      const { rows } = await pool.query("SELECT * FROM mail_jobs");
      expect(JSON.stringify(rows)).not.toContain(CANARY.subject);
      expect(JSON.stringify(rows)).not.toContain(CANARY.text);
    });

    it("서명 required 호출처의 올바른 JWS 파일을 등록한다", async () => {
      h.drop(
        "signed",
        "s1.json",
        signedFile(fileRequest({ idempotencyKey: "signed-1" })),
      );

      const summary = await h.makePoller().pollOnce();

      expect(total(summary, "registered")).toBe(1);
      expect(await jobs()).toEqual([
        { caller_id: "signed", idempotency_key: "signed-1", status: "PENDING" },
      ]);
      expect(files("signed")).toEqual([]);
    });

    it("JWE(content) 파일은 복호화해 등록하고 파일에는 제목·본문이 없다", async () => {
      const content = await encryptContent(rsaKey(MAILO_JWE_KID), {
        caller: "alpha",
        content: { subject: CANARY.subject, text: CANARY.text },
      });
      const body = json({
        version: 1,
        idempotencyKey: "jwe-1",
        to: ["kim@example.com"],
        from: "no-reply@example.com",
        content,
      });
      const file = h.drop("alpha", "j1.json", body);
      expect(body).not.toContain(CANARY.subject);
      expect(body).not.toContain(CANARY.text);
      expect(existsSync(file)).toBe(true);

      const summary = await h.makePoller().pollOnce();

      expect(total(summary, "registered")).toBe(1);
      expect((await jobs())[0]?.idempotency_key).toBe("jwe-1");
    });

    it("JWE의 caller가 폴더와 다르면 CALLER_MISMATCH, 알 수 없는 kid는 DECRYPTION_FAILED로 거부한다", async () => {
      const wrongCaller = await encryptContent(rsaKey(MAILO_JWE_KID), {
        caller: "beta",
        content: { subject: "s", text: "t" },
      });
      const unknownKid = await encryptContent(rsaKey("other-kid"), {
        caller: "alpha",
        content: { subject: "s", text: "t" },
      });
      for (const [name, content, key] of [
        ["c1.json", wrongCaller, "jwe-caller"],
        ["c2.json", unknownKid, "jwe-kid"],
      ] as const) {
        h.drop(
          "alpha",
          name,
          json({
            version: 1,
            idempotencyKey: key,
            to: ["kim@example.com"],
            content,
          }),
        );
      }

      await h.makePoller().pollOnce();

      const byKey = Object.fromEntries(
        (await rejections()).map((r) => [r.idempotency_key, r.reason_code]),
      );
      expect(byKey).toEqual({
        "jwe-caller": "CALLER_MISMATCH",
        "jwe-kid": "DECRYPTION_FAILED",
      });
      expect(await jobs()).toEqual([]);
    });

    it("암호화한 제목에 CR/LF가 있는 JWE 파일은 복호화 뒤 검증에서 거부한다(ADR-0008 결정 3)", async () => {
      const content = await encryptContent(rsaKey(MAILO_JWE_KID), {
        caller: "alpha",
        content: { subject: "안내\r\nBcc: attacker@example.com", text: "t" },
      });
      h.drop(
        "alpha",
        "crlf.json",
        json({
          version: 1,
          idempotencyKey: "jwe-crlf",
          to: ["kim@example.com"],
          content,
        }),
      );

      await h.makePoller().pollOnce();

      expect(await jobs()).toEqual([]);
      expect(await rejections()).toMatchObject([
        { reason_code: "VALIDATION_FAILED", idempotency_key: "jwe-crlf" },
      ]);
    });

    it("호출처 A 폴더의 파일은 A로만 등록되고 같은 Key도 호출처마다 따로 등록된다", async () => {
      h.drop("alpha", "x.json", json(fileRequest({ idempotencyKey: "same" })));
      h.drop("beta", "y.json", json(fileRequest({ idempotencyKey: "same" })));
      h.drop(
        "beta",
        "z.json",
        json(fileRequest({ idempotencyKey: "beta-only" })),
      );

      await h.makePoller().pollOnce();

      expect(await jobs()).toEqual([
        { caller_id: "alpha", idempotency_key: "same", status: "PENDING" },
        { caller_id: "beta", idempotency_key: "beta-only", status: "PENDING" },
        { caller_id: "beta", idempotency_key: "same", status: "PENDING" },
      ]);
    });

    it("서명 required 호출처가 다른 호출처 이름(caller 클레임)으로 서명한 파일은 CALLER_MISMATCH다", async () => {
      h.drop(
        "signed",
        "m.json",
        signedFile(fileRequest({ idempotencyKey: "mm-1" }), {
          caller: "alpha",
        }),
      );

      await h.makePoller().pollOnce();

      expect(await jobs()).toEqual([]);
      expect(await rejections()).toMatchObject([
        {
          caller_id: "signed",
          reason_code: "CALLER_MISMATCH",
          idempotency_key: "mm-1",
        },
      ]);
    });
  });

  describe("수집 대상 선별", () => {
    it("점으로 시작하는 파일과 *.json이 아닌 파일은 수집하지 않는다", async () => {
      const body = json(fileRequest());
      h.dropTemp("alpha", ".pending.json", body);
      h.dropTemp("alpha", "note.txt", body);
      h.dropTemp("alpha", "req.json.tmp", body);
      h.dropTemp("alpha", "UPPER.JSON", body);

      const summary = await h.makePoller().pollOnce();

      expect(total(summary, "registered") + total(summary, "rejected")).toBe(0);
      expect(files("alpha")).toEqual([
        ".pending.json",
        "UPPER.JSON",
        "note.txt",
        "req.json.tmp",
      ]);
      expect(await jobs()).toEqual([]);
    });

    it("rename 도중(임시 이름)인 파일은 수집하지 않고 rename한 뒤에 수집한다", async () => {
      const dir = h.inbox("alpha");
      writeFileSync(path.join(dir, ".w1.json.tmp"), '{"version":1,"idempo'); // 일부만 쓰였다
      const poller = h.makePoller();

      const first = await poller.pollOnce();
      expect(total(first, "registered") + total(first, "rejected")).toBe(0);

      writeFileSync(
        path.join(dir, ".w1.json.tmp"),
        json(fileRequest({ idempotencyKey: "w1" })),
      );
      renameSync(path.join(dir, ".w1.json.tmp"), path.join(dir, "w1.json"));
      const second = await poller.pollOnce();

      expect(total(second, "registered")).toBe(1);
      expect(await rejections()).toEqual([]);
    });

    it("등록되지 않은 폴더와 파일 폴더를 쓰지 않는 호출처의 폴더는 보지 않는다", async () => {
      h.drop("ghost", "g.json", json(fileRequest({ idempotencyKey: "ghost" })));
      h.drop(
        "restonly",
        "r.json",
        json(fileRequest({ idempotencyKey: "rest" })),
      );
      h.drop("alpha", "a.json", json(fileRequest({ idempotencyKey: "ok" })));

      await h.makePoller().pollOnce();

      expect(await jobs()).toEqual([
        { caller_id: "alpha", idempotency_key: "ok", status: "PENDING" },
      ]);
      expect(files("ghost")).toEqual(["g.json"]);
      expect(files("restonly")).toEqual(["r.json"]);
      expect(await rejections()).toEqual([]);
    });

    it("오래된 점 임시 파일만 지운다(디렉터리·새 파일·일반 파일은 그대로)", async () => {
      const dir = h.inbox("alpha");
      const old = h.dropTemp("alpha", ".old.tmp", "partial");
      h.dropTemp("alpha", ".fresh.tmp", "partial");
      symlinkSync("/nonexistent-target", path.join(dir, ".old-link"));
      const hour = 3600;
      const longAgo = new Date(Date.now() - 2 * hour * 1000);
      utimesSync(old, longAgo, longAgo);
      const { lutimesSync } = await import("node:fs");
      lutimesSync(path.join(dir, ".old-link"), longAgo, longAgo);
      await import("node:fs").then((fs) =>
        fs.mkdirSync(path.join(dir, ".olddir")),
      );
      utimesSync(path.join(dir, ".olddir"), longAgo, longAgo);

      const summary = await h.makePoller().pollOnce();

      expect(total(summary, "tempDeleted")).toBe(2);
      expect(files("alpha")).toEqual([".fresh.tmp", ".olddir"]);
    });

    it("입력 폴더가 없는 호출처는 건너뛰고 다른 호출처를 수집한다", async () => {
      h.drop("beta", "b.json", json(fileRequest({ idempotencyKey: "b" })));

      const summary = await h.makePoller().pollOnce();

      expect(
        summary.callers.find((c) => c.callerId === "alpha")?.inboxMissing,
      ).toBe(true);
      expect(total(summary, "registered")).toBe(1);
      expect(
        h.logs.filter((l) => l.includes("file_inbox_missing")).length,
      ).toBe(2); // alpha, signed
      await h.makePoller().pollOnce();
    });
  });

  describe("특수 파일과 크기 (ADR-0004 결정 5)", () => {
    it("*.json FIFO는 폴러를 멈추지 않고 거부 기록 뒤 삭제하며 다른 파일은 수집한다", async () => {
      mkfifo(path.join(h.inbox("alpha"), "pipe.json"));
      h.drop(
        "alpha",
        "ok.json",
        json(fileRequest({ idempotencyKey: "after-fifo" })),
      );
      let timer: NodeJS.Timeout | undefined;

      const summary = await Promise.race([
        h.makePoller().pollOnce(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("폴러가 멈췄다")), 5000);
        }),
      ]).finally(() => clearTimeout(timer));

      expect(total(summary, "registered")).toBe(1);
      expect(files("alpha")).toEqual([]);
      expect(await rejections()).toMatchObject([
        {
          file_name: "pipe.json",
          reason_code: "MALFORMED",
          size_bytes: "0",
          sha256: sha(""),
        },
      ]);
      expect(await rejectionEvents()).toBe(1);
    });

    it("심볼릭 링크는 따라가지 않고 거부한 뒤 링크만 지운다(대상 파일은 그대로)", async () => {
      const target = path.join(h.root, "outside.json");
      writeFileSync(target, json(fileRequest({ idempotencyKey: "via-link" })));
      symlinkSync(target, path.join(h.inbox("alpha"), "link.json"));

      await h.makePoller().pollOnce();

      expect(await jobs()).toEqual([]);
      expect(await rejections()).toMatchObject([
        { file_name: "link.json", reason_code: "MALFORMED" },
      ]);
      expect(files("alpha")).toEqual([]);
      expect(existsSync(target)).toBe(true);
    });

    it("하드링크(nlink > 1)는 읽지 않고 거부한 뒤 링크만 지운다(원본은 그대로)", async () => {
      const outside = path.join(h.root, "outside.json");
      writeFileSync(
        outside,
        json(fileRequest({ idempotencyKey: "via-hardlink" })),
      );
      linkSync(outside, path.join(h.inbox("alpha"), "hard.json"));

      await h.makePoller().pollOnce();

      expect(await jobs()).toEqual([]);
      expect(await rejections()).toMatchObject([
        { file_name: "hard.json", reason_code: "MALFORMED", sha256: sha("") },
      ]);
      expect(files("alpha")).toEqual([]);
      expect(existsSync(outside)).toBe(true);
    });

    it("정확히 상한 크기인 파일은 수집하고 1바이트 넘는 파일은 SIZE_EXCEEDED로 거부한다", async () => {
      const limit = 4096;
      h.cleanup();
      h = createFileHarness(pool, { config: { maxFileBytes: limit } });
      const padded = (extra: number, key: string) => {
        const base = json(fileRequest({ idempotencyKey: key, text: "" }));
        return json(
          fileRequest({
            idempotencyKey: key,
            text: "a".repeat(limit - Buffer.byteLength(base) + extra),
          }),
        );
      };
      const exact = padded(0, "exact");
      const over = padded(1, "over");
      expect(Buffer.byteLength(exact)).toBe(limit);
      expect(Buffer.byteLength(over)).toBe(limit + 1);
      h.drop("alpha", "exact.json", exact);
      h.drop("alpha", "over.json", over);

      await h.makePoller().pollOnce();

      expect((await jobs()).map((j) => j.idempotency_key)).toEqual(["exact"]);
      expect(await rejections()).toMatchObject([
        {
          file_name: "over.json",
          reason_code: "SIZE_EXCEEDED",
          size_bytes: String(limit + 1),
          sha256: sha(over),
          idempotency_key: null,
        },
      ]);
    });

    it("상한을 훨씬 넘는 파일의 sha256은 처음 상한 + 1바이트의 해시이고 크기는 열 때의 fstat 크기다", async () => {
      const limit = 4096;
      h.cleanup();
      h = createFileHarness(pool, { config: { maxFileBytes: limit } });
      const big = Buffer.concat([
        Buffer.alloc(limit + 1, 0x61),
        Buffer.alloc(100_000, 0x62),
      ]);
      h.drop("alpha", "big.json", big);

      await h.makePoller().pollOnce();

      expect(await rejections()).toMatchObject([
        {
          reason_code: "SIZE_EXCEEDED",
          size_bytes: String(big.length),
          sha256: sha(big.subarray(0, limit + 1)),
        },
      ]);
      expect(files("alpha")).toEqual([]);
    });

    it("rename 뒤 열어 둔 핸들로 덧써서 상한을 넘긴 파일은 크기 초과로 거부한다", async () => {
      const limit = 4096;
      h.cleanup();
      h = createFileHarness(pool, { config: { maxFileBytes: limit } });
      const dir = h.inbox("alpha");
      const tmp = path.join(dir, ".late.tmp");
      const fd = openSync(tmp, "w");
      writeSync(fd, json(fileRequest({ idempotencyKey: "late" })));
      renameSync(tmp, path.join(dir, "late.json")); // 호출처는 rename 뒤에도 핸들을 쥐고 있다
      writeSync(fd, " ".repeat(limit * 2)); // 공백이라 JSON으로는 유효하다. 크기만 넘는다
      closeSync(fd);

      await h.makePoller().pollOnce();

      expect(await jobs()).toEqual([]);
      expect(await rejections()).toMatchObject([
        { file_name: "late.json", reason_code: "SIZE_EXCEEDED" },
      ]);
    });

    it.each<[string, string, () => string, string]>([
      [
        "서명 none 호출처가 보낸 서명 봉투 파일(요청 필드가 최상위에 없다)",
        "alpha",
        () =>
          signedFile(fileRequest({ idempotencyKey: "s-none" }), {
            caller: "alpha",
          }),
        "IDEMPOTENCY_KEY_MISSING",
      ],
      ["JSON이 아닌 파일", "alpha", () => "{ not json", "MALFORMED"],
      [
        "Key 누락",
        "alpha",
        () => json(fileRequest({ idempotencyKey: undefined })),
        "IDEMPOTENCY_KEY_MISSING",
      ],
      [
        "Key 형식 위반",
        "alpha",
        () => json(fileRequest({ idempotencyKey: "bad key!" })),
        "IDEMPOTENCY_KEY_INVALID",
      ],
      [
        "attachments 포함",
        "alpha",
        () => json(fileRequest({ idempotencyKey: "att", attachments: [] })),
        "ATTACHMENTS_NOT_SUPPORTED",
      ],
      [
        "입력 검증 실패(수신자 형식)",
        "alpha",
        () => json(fileRequest({ idempotencyKey: "bad-to", to: ["nope"] })),
        "VALIDATION_FAILED",
      ],
      [
        "제목에 CR/LF",
        "alpha",
        () =>
          json(
            fileRequest({
              idempotencyKey: "crlf",
              subject: "a\r\nBcc: x@example.com",
            }),
          ),
        "VALIDATION_FAILED",
      ],
      [
        "서명 required 호출처의 서명 없는 파일",
        "signed",
        () => json(fileRequest({ idempotencyKey: "unsigned" })),
        "SIGNATURE_INVALID",
      ],
      [
        "서명 required 호출처의 잘못된 서명",
        "signed",
        () =>
          signedFile(fileRequest({ idempotencyKey: "forged" }), {
            secret: jwsSecret(99),
          }),
        "SIGNATURE_INVALID",
      ],
      [
        "서명 required 호출처의 허용 기간을 넘은 iat",
        "signed",
        () =>
          signedFile(fileRequest({ idempotencyKey: "stale" }), {
            iat: Math.floor(Date.now() / 1000) - 8 * 86_400,
          }),
        "IAT_OUT_OF_RANGE",
      ],
    ])(
      "%s는 거부 기록과 INTAKE_REJECTED 이벤트를 남기고 원본을 지운다",
      async (_name, caller, content, reason) => {
        h.drop(caller, "r.json", content());

        const summary = await h.makePoller().pollOnce();

        expect(total(summary, "rejected")).toBe(1);
        expect(await jobs()).toEqual([]);
        expect(await rejections()).toMatchObject([
          { caller_id: caller, file_name: "r.json", reason_code: reason },
        ]);
        expect(await rejectionEvents()).toBe(1);
        expect(files(caller)).toEqual([]);
      },
    );

    it("거부 기록에는 파싱할 수 있는 Key를 남기되 서명을 확인하지 못한 파일의 Key는 남기지 않는다", async () => {
      h.drop(
        "alpha",
        "a.json",
        json(fileRequest({ idempotencyKey: "keep-1", to: ["nope"] })),
      );
      h.drop(
        "signed",
        "f.json",
        signedFile(fileRequest({ idempotencyKey: "forged-key" }), {
          secret: jwsSecret(99),
        }),
      );
      h.drop(
        "signed",
        "i.json",
        signedFile(fileRequest({ idempotencyKey: "stale-key" }), {
          iat: 1_000_000,
        }),
      );

      await h.makePoller().pollOnce();

      const keys = Object.fromEntries(
        (await rejections()).map((r) => [r.file_name, r.idempotency_key]),
      );
      expect(keys).toEqual({
        "a.json": "keep-1",
        "f.json": null,
        "i.json": "stale-key",
      });
    });

    it("같은 Key에 다른 내용인 파일은 FINGERPRINT_MISMATCH로 거부하고 먼저 등록된 작업은 그대로다", async () => {
      const poller = h.makePoller();
      h.drop(
        "alpha",
        "first.json",
        json(fileRequest({ idempotencyKey: "dup", text: "원본" })),
      );
      await poller.pollOnce();
      h.drop(
        "alpha",
        "second.json",
        json(fileRequest({ idempotencyKey: "dup", text: "다른 내용" })),
      );

      const summary = await poller.pollOnce();

      expect(total(summary, "rejected")).toBe(1);
      expect(await jobs()).toHaveLength(1);
      expect(await rejections()).toMatchObject([
        {
          file_name: "second.json",
          reason_code: "FINGERPRINT_MISMATCH",
          idempotency_key: "dup",
        },
      ]);
      expect(await rejectionEvents()).toBe(1);
      expect(files("alpha")).toEqual([]);
    });

    it("같은 Key에 같은 내용인 파일은 중복으로 보고 원본만 지운다", async () => {
      const poller = h.makePoller();
      const body = json(fileRequest({ idempotencyKey: "same-body" }));
      h.drop("alpha", "one.json", body);
      h.drop("alpha", "two.json", body);

      const summary = await poller.pollOnce();

      expect(total(summary, "registered")).toBe(1);
      expect(total(summary, "duplicates")).toBe(1);
      expect(await jobs()).toHaveLength(1);
      expect(files("alpha")).toEqual([]);
    });
  });

  describe("중복·동시성·종료 (ADR-0004 결정 6, ADR-0006 결정 3)", () => {
    it("등록 직후 삭제 전에 종료돼도 다시 수집하면 같은 Key로 걸러진다", async () => {
      h.drop(
        "alpha",
        "crash.json",
        json(fileRequest({ idempotencyKey: "crash-1" })),
      );
      const crashing = h.makePoller({
        beforeDelete: () => {
          throw new Error("종료 흉내");
        },
      });

      const first = await crashing.pollOnce();
      expect(total(first, "errors")).toBe(1);
      expect(files("alpha")).toEqual(["crash.json"]);
      expect(await jobs()).toHaveLength(1);

      const second = await h.makePoller().pollOnce();

      expect(total(second, "duplicates")).toBe(1);
      expect(total(second, "registered")).toBe(0);
      expect(await jobs()).toHaveLength(1);
      expect(files("alpha")).toEqual([]);
    });

    it("거부 기록 커밋 뒤 삭제 전에 종료돼도 재수집이 같은 거부를 두 번 기록하지 않는다", async () => {
      h.drop("alpha", "bad.json", "{ not json");
      const crashing = h.makePoller({
        beforeDelete: () => {
          throw new Error("종료 흉내");
        },
      });
      await crashing.pollOnce();
      expect(files("alpha")).toEqual(["bad.json"]);
      expect(await rejections()).toHaveLength(1);

      const second = await h.makePoller().pollOnce();

      expect(total(second, "rejectedRepeats")).toBe(1);
      expect(total(second, "rejected")).toBe(0);
      expect(await rejections()).toHaveLength(1);
      expect(await rejectionEvents()).toBe(1);
      expect(files("alpha")).toEqual([]);
    });

    it("같은 이름·같은 내용을 다시 넣어도 거부 기록은 하나이고 같은 이름의 다른 내용은 새로 기록한다", async () => {
      const poller = h.makePoller();
      h.drop("alpha", "same-name.json", "{ broken-1");
      await poller.pollOnce();
      h.drop("alpha", "same-name.json", "{ broken-1");
      await poller.pollOnce();
      expect(await rejections()).toHaveLength(1);

      h.drop("alpha", "same-name.json", "{ broken-2");
      await poller.pollOnce();

      expect(await rejections()).toHaveLength(2);
      expect(await rejectionEvents()).toBe(2);
    });

    it("두 폴러가 같은 파일들을 동시에 수집해도 Key마다 하나만 등록된다", async () => {
      const count = 30;
      for (let i = 0; i < count; i += 1)
        h.drop(
          "alpha",
          `f${i}.json`,
          json(fileRequest({ idempotencyKey: `race-${i}` })),
        );
      const a = h.makePoller({
        config: { ...h.config.fileChannel, root: h.root, batchPerCaller: 100 },
      });
      const b = h.makePoller();

      const [ra, rb] = await Promise.all([a.pollOnce(), b.pollOnce()]);

      expect(await jobs()).toHaveLength(count);
      expect(total(ra, "errors") + total(rb, "errors")).toBe(0);
      expect(total(ra, "registered") + total(rb, "registered")).toBe(count);
      expect(await rejections()).toEqual([]);
      expect(files("alpha")).toEqual([]);
    });

    it("삭제 직전에 같은 이름으로 새 파일이 덮어쓰면 그 파일은 지우지 않고 다음 폴링이 수집한다", async () => {
      const dir = h.inbox("alpha");
      h.drop(
        "alpha",
        "swap.json",
        json(fileRequest({ idempotencyKey: "old-one" })),
      );
      const poller = h.makePoller({
        beforeDelete: ({ fileName }) => {
          if (fileName !== "swap.json") return;
          writeFileSync(
            path.join(dir, ".new.tmp"),
            json(fileRequest({ idempotencyKey: "new-one" })),
          );
          renameSync(path.join(dir, ".new.tmp"), path.join(dir, "swap.json"));
        },
      });

      await poller.pollOnce();
      expect(files("alpha")).toEqual(["swap.json"]); // 읽은 적 없는 새 파일이 남았다

      await h.makePoller().pollOnce();

      expect((await jobs()).map((j) => j.idempotency_key)).toEqual([
        "new-one",
        "old-one",
      ]);
      expect(files("alpha")).toEqual([]);
    });

    (asRoot ? it.skip : it)(
      "등록 뒤 삭제에 실패하면 오류가 아니라 deleteFailed로 세고 다음 폴링이 같은 Key로 거른다",
      async () => {
        const dir = h.inbox("alpha");
        h.drop(
          "alpha",
          "stuck.json",
          json(fileRequest({ idempotencyKey: "stuck" })),
        );
        chmodSync(dir, 0o555); // 폴더에 쓸 수 없어 unlink가 EACCES다

        const first = await h.makePoller().pollOnce();
        chmodSync(dir, 0o755);

        expect(total(first, "deleteFailed")).toBe(1);
        expect(total(first, "errors")).toBe(0);
        expect(files("alpha")).toEqual(["stuck.json"]);
        const second = await h.makePoller().pollOnce();
        expect(total(second, "duplicates")).toBe(1);
        expect(await jobs()).toHaveLength(1);
        expect(files("alpha")).toEqual([]);
      },
    );

    (asRoot ? it.skip : it)(
      "읽을 권한이 없는 파일은 거부하지 않고 남겨 둔다(운영 구성 오류일 수 있다)",
      async () => {
        const file = h.drop(
          "alpha",
          "noperm.json",
          json(fileRequest({ idempotencyKey: "noperm" })),
        );
        chmodSync(file, 0o000);

        const summary = await h.makePoller().pollOnce();
        chmodSync(file, 0o644);

        expect(total(summary, "unreadable")).toBe(1);
        expect(await rejections()).toEqual([]);
        expect(files("alpha")).toEqual(["noperm.json"]);
      },
    );
  });

  describe("공정성과 수명 주기", () => {
    it("호출처마다 배치 상한만큼만 처리해 한 호출처가 다른 호출처를 굶기지 않는다", async () => {
      h.cleanup();
      h = createFileHarness(pool, { config: { batchPerCaller: 2 } });
      for (let i = 0; i < 5; i += 1)
        h.drop(
          "alpha",
          `a${i}.json`,
          json(fileRequest({ idempotencyKey: `a-${i}` })),
        );
      h.drop("beta", "b.json", json(fileRequest({ idempotencyKey: "b-0" })));
      const poller = h.makePoller();

      const first = await poller.pollOnce();

      expect(
        first.callers.find((c) => c.callerId === "alpha")?.registered,
      ).toBe(2);
      expect(first.callers.find((c) => c.callerId === "beta")?.registered).toBe(
        1,
      );
      expect(first.more).toBe(true);
      expect(files("alpha")).toHaveLength(3);

      await poller.pollOnce();
      const third = await poller.pollOnce();
      expect(third.more).toBe(false);
      expect(files("alpha")).toEqual([]);
      expect(await jobs()).toHaveLength(6);
    });

    it("시작할 때 root가 없거나 디렉터리가 아니면 FileChannelStartError로 실패한다", async () => {
      const missing = h.makePoller({
        config: { ...h.config.fileChannel, root: path.join(h.root, "nope") },
      });
      const notDir = h.makePoller({
        config: {
          ...h.config.fileChannel,
          root: h.dropTemp("alpha", "plain", "x"),
        },
      });

      await expect(missing.start()).rejects.toBeInstanceOf(
        FileChannelStartError,
      );
      await expect(missing.start()).rejects.toThrow("ENOENT");
      await expect(notDir.start()).rejects.toBeInstanceOf(
        FileChannelStartError,
      );
      expect(missing.status().running).toBe(false);
    });

    it("코드는 폴더를 만들지 않는다(없는 inbox를 만들지 않는다)", async () => {
      await h.makePoller().pollOnce();

      expect(existsSync(path.join(h.root, "inbox"))).toBe(false);
    });

    it("start가 폴링을 반복하고 마지막 폴링 시각을 갖고, stop 뒤에는 수집하지 않는다", async () => {
      h.cleanup();
      h = createFileHarness(pool, { config: { pollIntervalMs: 50 } });
      h.inbox("alpha");
      const poller = h.makePoller();
      expect(poller.status()).toMatchObject({
        lastPollAt: null,
        running: false,
      });

      await poller.start();
      h.drop(
        "alpha",
        "loop.json",
        json(fileRequest({ idempotencyKey: "loop" })),
      );
      await waitFor(async () => (await jobs()).length === 1);
      const status = poller.status();
      expect(status.running).toBe(true);
      expect(status.lastPollOk).toBe(true);
      expect(status.lastPollAt).toBeInstanceOf(Date);

      await poller.stop();
      h.drop(
        "alpha",
        "late.json",
        json(fileRequest({ idempotencyKey: "late" })),
      );
      await new Promise((r) => setTimeout(r, 250));

      expect(await jobs()).toHaveLength(1);
      expect(files("alpha")).toEqual(["late.json"]);
      expect(poller.status().running).toBe(false);
    });

    it("stop은 진행 중인 파일의 등록과 삭제를 끝낸 뒤 resolve한다", async () => {
      h.cleanup();
      h = createFileHarness(pool, { config: { pollIntervalMs: 50 } });
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const atHook = new Promise<void>((resolve) => (reached = resolve));
      h.drop(
        "alpha",
        "a.json",
        json(fileRequest({ idempotencyKey: "inflight-1" })),
      );
      h.drop(
        "alpha",
        "b.json",
        json(fileRequest({ idempotencyKey: "inflight-2" })),
      );
      const poller = h.makePoller({
        beforeDelete: async () => {
          reached();
          await gate; // 등록은 끝났고 삭제 직전이다
        },
      });
      await poller.start();
      await atHook;

      const stopping = poller.stop();
      let stopped = false;
      void stopping.then(() => (stopped = true));
      await new Promise((r) => setTimeout(r, 100));
      expect(stopped).toBe(false); // 진행 중인 파일을 기다린다
      release();
      await stopping;

      // 첫 파일은 등록·삭제까지 끝났고, 둘째 파일은 시작하지 않았다.
      expect(await jobs()).toHaveLength(1);
      expect(readdirSync(h.inbox("alpha")).length).toBe(1);
    });
  });

  describe("로그와 기록에 내용이 없다 (RQ-027)", () => {
    it("거부한 파일의 본문 canary가 로그·거부 기록·이벤트 어디에도 없다", async () => {
      const limit = 4096;
      h.cleanup();
      h = createFileHarness(pool, { config: { maxFileBytes: limit } });
      // 형식 오류, 검증 실패(제목·본문에 canary), 서명 불일치, 크기 초과, 심볼릭 링크 대상 내용
      h.drop(
        "alpha",
        "m.json",
        `{ "subject": "${CANARY.subject}", "text": "${CANARY.text}" `,
      );
      h.drop(
        "alpha",
        "v.json",
        json(
          fileRequest({
            idempotencyKey: "canary-v",
            to: ["nope"],
            subject: CANARY.subject,
            text: CANARY.text,
          }),
        ),
      );
      h.drop(
        "signed",
        "f.json",
        signedFile(
          fileRequest({
            idempotencyKey: "canary-f",
            subject: CANARY.subject,
            text: CANARY.text,
          }),
          { secret: jwsSecret(98) },
        ),
      );
      h.drop("alpha", "big.json", CANARY.raw.repeat(2000));
      const target = path.join(h.root, "target.json");
      writeFileSync(target, CANARY.raw);
      symlinkSync(target, path.join(h.inbox("alpha"), "link.json"));
      const wrongCaller = await encryptContent(rsaKey(MAILO_JWE_KID), {
        caller: "beta",
        content: { subject: CANARY.subject, text: CANARY.text },
      });
      const tampered = replaceJweSegment(
        await encryptContent(rsaKey(MAILO_JWE_KID), {
          caller: "alpha",
          content: { subject: CANARY.subject, text: CANARY.text },
        }),
        3,
        (segment) => `${segment.slice(0, -4)}AAAA`,
      );
      for (const [name, content, key] of [
        ["jc.json", wrongCaller, "canary-jwe-caller"],
        ["jt.json", tampered, "canary-jwe-tamper"],
      ] as const) {
        h.drop(
          "alpha",
          name,
          json({
            version: 1,
            idempotencyKey: key,
            to: ["kim@example.com"],
            content,
          }),
        );
      }
      h.drop(
        "alpha",
        "ok.json",
        json(
          fileRequest({
            idempotencyKey: "canary-ok",
            subject: CANARY.subject,
            text: CANARY.text,
          }),
        ),
      );
      const crashing = h.makePoller({
        beforeDelete: ({ fileName }) => {
          if (fileName === "ok.json") throw new Error("종료 흉내");
        },
      });

      await crashing.pollOnce(); // 오류 로그 경로도 지난다
      await h.makePoller().pollOnce();

      const everything = JSON.stringify([
        h.logs,
        (await pool.query("SELECT * FROM mail_intake_rejections")).rows,
        (await pool.query("SELECT * FROM mail_events")).rows,
        (await pool.query("SELECT * FROM mail_jobs")).rows,
        await listEvents(pool, { callerId: "alpha" }),
      ]);
      for (const secret of Object.values(CANARY))
        expect(everything).not.toContain(secret);
      const reasons = (await rejections()).map((r) => r.reason_code);
      expect(reasons).toEqual(
        expect.arrayContaining([
          "MALFORMED",
          "VALIDATION_FAILED",
          "SIGNATURE_INVALID",
          "SIZE_EXCEEDED",
          "CALLER_MISMATCH",
          "DECRYPTION_FAILED",
        ]),
      );
      expect(h.logs.some((l) => l.includes("file_rejected"))).toBe(true);
    });
  });
});

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (!(await fn())) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor 시간 초과");
    await new Promise((r) => setTimeout(r, 25));
  }
}
