import "reflect-metadata";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { startFakeSmtp, type FakeSmtp } from "../support/fake-smtp.js";
import {
  encryptContent,
  replaceJweSegment,
  rsaKey,
} from "../support/envelope.js";
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
 * REST JWE 왕복(실제 HTTP -> PostgreSQL). 근거: RQ-022·027·030, ADR-0005 결정 3, ADR-0008 결정 1·3·5.
 * 복호화 -> 복호화한 제목·본문 검증 -> 지문 -> 등록 순서를 REST가 따른다.
 * 호출처는 Mailo 공개키로 암호화하고, Mailo는 설정의 개인키 목록(키 교체 중 2개)으로 복호화한다.
 */

const CANARY = {
  subject: "CANARY-JWE-SUBJECT-4b1e",
  text: "CANARY-JWE-TEXT-c07a",
  html: "CANARY-JWE-HTML-9f22",
};
const TO = ["kim@example.com"];
const FROM = "no-reply@example.com";

const current = rsaKey("mailo-2026-11");
const previous = rsaKey("mailo-2026-05");
const unknown = rsaKey("mailo-unknown");

interface ErrorsBody {
  errors: Array<{ pointer?: string; parameter?: string; code: string }>;
}

describe("REST 통합: JWE 봉투 암호화 (RQ-022, ADR-0008)", () => {
  let db: TestDatabase;
  let app: RestApp;
  let dir: string;

  async function jobCount(): Promise<number> {
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM mail_jobs",
    );
    return rows[0].n;
  }

  const post = (
    content: string,
    options: { key?: string; auth?: string | null; extra?: object } = {},
  ) =>
    postJob(app, {
      key: options.key ?? "jwe-1",
      ...(options.auth !== undefined ? { auth: options.auth } : {}),
      body: { to: TO, from: FROM, content, ...options.extra },
    });

  const secret = {
    subject: "주문 접수 안내",
    text: "주문이 접수되었습니다.",
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mailo-envelope-it-"));
    const currentFile = path.join(dir, "current.pem");
    writeFileSync(currentFile, current.privatePem); // 시크릿 파일 마운트
    const keysFile = path.join(dir, "envelope-keys.json");
    writeFileSync(
      keysFile,
      JSON.stringify({
        keys: [
          { kid: "mailo-2026-11", privateKeyVar: "MAILO_JWE_KEY_CURRENT" },
          {
            kid: "mailo-2026-05",
            privateKeyVar: "MAILO_JWE_KEY_PREVIOUS",
            retiredAt: "2026-11-01T00:00:00Z",
          },
        ],
      }),
    );
    db = await createTestDatabase();
    await migrate(db.pool);
    app = await startRestApp({
      pool: db.pool,
      env: {
        MAILO_ENVELOPE_KEYS_FILE: keysFile,
        MAILO_JWE_KEY_CURRENT_FILE: currentFile,
        MAILO_JWE_KEY_PREVIOUS: previous.privatePem, // 환경 변수
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query("DELETE FROM mail_intake_rejections");
  });

  it("JWE 요청은 202로 등록되고 DB에는 평문이 없다", async () => {
    const content = await encryptContent(current, {
      content: { ...secret, html: `<p>${CANARY.html}</p>`, text: CANARY.text },
    });

    const res = await post(content, { key: "jwe-ok" });

    expect(res.status).toBe(202);
    const job = (await res.json()) as { jobId: string; status: string };
    expect(job.status).toBe("PENDING");
    const { rows } = await db.pool.query(
      "SELECT body_ciphertext, recipients FROM mail_jobs WHERE id = $1",
      [job.jobId],
    );
    expect(rows).toHaveLength(1);
    const dump =
      JSON.stringify(rows[0]) +
      Buffer.from(rows[0].body_ciphertext).toString("latin1");
    expect(dump).not.toContain("CANARY");
    expect(dump).not.toContain("주문 접수 안내");
    expect(content).not.toContain(CANARY.text); // 요청 본문도 평문이 아니다
    expect(rows[0].recipients.to).toEqual(TO); // 수신자는 평문이다
  });

  it("같은 Key로 같은 내용을 평문 모드와 JWE 모드로 보내면 같은 요청이다(200, 같은 작업)", async () => {
    const first = await postJob(app, {
      key: "same-1",
      body: plainMail({ to: TO, from: FROM, ...secret }),
    });
    const viaJwe = await post(
      await encryptContent(current, { content: secret }),
      {
        key: "same-1",
      },
    );
    const viaJweAgain = await post(
      await encryptContent(current, { content: secret }),
      { key: "same-1" },
    );

    expect(first.status).toBe(202);
    expect(viaJwe.status).toBe(200);
    expect(viaJweAgain.status).toBe(200);
    const id = ((await first.json()) as { jobId: string }).jobId;
    expect(((await viaJwe.json()) as { jobId: string }).jobId).toBe(id);
    expect(((await viaJweAgain.json()) as { jobId: string }).jobId).toBe(id);
    expect(await jobCount()).toBe(1);
  });

  it("JWE로 먼저 등록한 Key를 평문으로 다시 보내면 200이다. 제목이 다르면 409다", async () => {
    const first = await post(
      await encryptContent(current, { content: secret }),
      {
        key: "same-2",
      },
    );
    const plain = await postJob(app, {
      key: "same-2",
      body: plainMail({ to: TO, from: FROM, ...secret }),
    });
    const changed = await post(
      await encryptContent(current, {
        content: { ...secret, subject: "다른 제목" },
      }),
      { key: "same-2" },
    );

    expect(first.status).toBe(202);
    expect(plain.status).toBe(200);
    expect(changed.status).toBe(409);
    expect(await jobCount()).toBe(1);
  });

  it("수신자만 다른 JWE 재요청은 409다(지문 범위가 평문 필드 전체다)", async () => {
    const content = await encryptContent(current, { content: secret });
    await post(content, { key: "same-3" });

    const res = await postJob(app, {
      key: "same-3",
      body: { to: ["other@example.com"], from: FROM, content },
    });

    expect(res.status).toBe(409);
  });

  it("키 교체 중 이전 kid로 암호화한 요청도 복호화한다(ADR-0008 결정 5)", async () => {
    const old = await post(
      await encryptContent(previous, { content: secret }),
      {
        key: "old-kid",
      },
    );
    const now = await post(await encryptContent(current, { content: secret }), {
      key: "new-kid",
    });

    expect(old.status).toBe(202);
    expect(now.status).toBe(202);
  });

  it("알 수 없는 kid는 400 KID_UNKNOWN이고 등록하지 않는다", async () => {
    const res = await post(await encryptContent(unknown, { content: secret }));

    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorsBody).errors).toEqual([
      { pointer: "/content", code: "KID_UNKNOWN" },
    ]);
    expect(await jobCount()).toBe(0);
  });

  it("복호화 실패(암호문·태그 변조, 헤더 변조, 잘못된 alg)는 400 DECRYPTION_FAILED다", async () => {
    const good = await encryptContent(current, { content: secret });
    const header = JSON.parse(
      Buffer.from(good.split(".")[0] as string, "base64url").toString(),
    ) as Record<string, unknown>;
    const variants = [
      replaceJweSegment(good, 3, (x) => `${x}A`),
      replaceJweSegment(good, 4, (x) => `${x.slice(0, -2)}AA`),
      replaceJweSegment(good, 0, () =>
        Buffer.from(JSON.stringify({ ...header, note: 1 })).toString(
          "base64url",
        ),
      ),
      await encryptContent(current, {
        content: secret,
        header: { alg: "RSA-OAEP" },
      }),
      await encryptContent(current, {
        content: secret,
        header: { enc: "A128GCM" },
      }),
    ];

    for (const [i, content] of variants.entries()) {
      const res = await post(content, { key: `bad-${i}` });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorsBody).errors).toEqual([
        { pointer: "/content", code: "DECRYPTION_FAILED" },
      ]);
    }
    expect(await jobCount()).toBe(0);
  });

  it("JWE의 caller가 인증된 호출처와 다르면 400 CALLER_MISMATCH다", async () => {
    const forBeta = await encryptContent(current, {
      caller: "beta",
      content: secret,
    });

    const asAlpha = await post(forBeta, { key: "mismatch-1" });
    const asBeta = await post(forBeta, { key: "mismatch-1", auth: BETA_KEY });

    expect(asAlpha.status).toBe(400);
    expect(((await asAlpha.json()) as ErrorsBody).errors).toEqual([
      { pointer: "/content", code: "CALLER_MISMATCH" },
    ]);
    expect(asBeta.status).toBe(202); // beta 자신이 보내면 정상이다
  });

  it("암호화한 제목의 CR/LF는 복호화 뒤 400 CONTROL_CHARACTER로 거부한다(RQ-030)", async () => {
    for (const subject of ["제목\r\nBcc: evil@example.com", "제목\nX: 1"]) {
      const res = await post(
        await encryptContent(current, { content: { subject, text: "본문" } }),
        { key: "crlf" },
      );

      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorsBody).errors).toEqual([
        { pointer: "/content", code: "CONTROL_CHARACTER" },
      ]);
    }
    expect(await jobCount()).toBe(0);
  });

  it("복호화 뒤의 크기·누락·알 수 없는 필드도 400이다", async () => {
    const big = await encryptContent(current, {
      content: { subject: "s", text: "x".repeat(1024 * 1024) },
    });
    const noBody = await encryptContent(current, { content: { subject: "s" } });
    const extra = await encryptContent(current, {
      content: { ...secret, to: ["evil@example.com"] },
    });

    const errors = await Promise.all(
      [big, noBody, extra].map(async (content, i) => {
        const res = await post(content, { key: `post-${i}` });
        expect(res.status).toBe(400);
        return ((await res.json()) as ErrorsBody).errors;
      }),
    );

    expect(errors).toEqual([
      [{ pointer: "/content", code: "TOO_LARGE" }],
      [{ pointer: "/content", code: "REQUIRED" }],
      [{ pointer: "/content", code: "UNKNOWN_FIELD" }],
    ]);
  });

  it("평문 필드와 content를 섞으면 복호화하지 않고 400 CONFLICTING_FIELDS다", async () => {
    const content = await encryptContent(current, { content: secret });

    const res = await postJob(app, {
      body: plainMail({ content }),
    });

    expect(((await res.json()) as ErrorsBody).errors).toEqual([
      { pointer: "/content", code: "CONFLICTING_FIELDS" },
    ]);
  });

  it("Idempotency-Key 오류와 content 오류를 한 응답에 함께 담는다", async () => {
    const res = await postJob(app, {
      key: null,
      body: {
        to: TO,
        from: FROM,
        content: await encryptContent(unknown, { content: secret }),
      },
    });

    expect(((await res.json()) as ErrorsBody).errors).toEqual([
      { parameter: "Idempotency-Key", code: "REQUIRED" },
      { pointer: "/content", code: "KID_UNKNOWN" },
    ]);
  });

  it("실패 응답과 로그에 canary 본문·암호문이 없다(RQ-027)", async () => {
    const withCanary = {
      subject: CANARY.subject,
      text: CANARY.text,
      html: CANARY.html,
    };
    const good = await encryptContent(current, { content: withCanary });
    const attempts = [
      replaceJweSegment(good, 3, (x) => `${x}A`), // 변조
      await encryptContent(current, { caller: "beta", content: withCanary }),
      await encryptContent(unknown, { content: withCanary }),
      await encryptContent(current, {
        content: {
          ...withCanary,
          subject: `${CANARY.subject}\r\nBcc: x@example.com`,
        },
      }),
      await encryptContent(current, {
        content: { ...withCanary, text: CANARY.text.repeat(55_000) },
      }),
    ];
    const bodies: string[] = [];

    for (const [i, content] of attempts.entries()) {
      const res = await post(content, { key: `canary-${i}` });
      expect(res.status).toBe(400);
      bodies.push(await res.text());
    }

    const logs = app.logs.lines.join("\n");
    for (const text of [...bodies, logs]) {
      expect(text).not.toContain("CANARY");
      for (const content of attempts) {
        // 암호화 키·암호문·IV 조각이 응답과 로그에 없다
        for (const part of content.split(".").slice(1, 4))
          expect(text).not.toContain(part);
      }
    }
    expect(await jobCount()).toBe(0);
  });

  it("인증이 없으면 복호화 전에 401이다", async () => {
    const res = await post(await encryptContent(current, { content: secret }), {
      auth: null,
    });

    expect(res.status).toBe(401);
  });

  it("조회·이벤트 응답에도 제목·본문이 없다", async () => {
    const res = await post(
      await encryptContent(current, {
        content: { subject: CANARY.subject, text: CANARY.text },
      }),
      { key: "lookup" },
    );
    const job = (await res.json()) as { jobId: string };

    const byId = await (await getJson(app, `/jobs/${job.jobId}`)).text();
    const byKey = await (
      await getJson(app, "/jobs?idempotencyKey=lookup")
    ).text();

    expect(byId).not.toContain("CANARY");
    expect(byKey).not.toContain("CANARY");
  });
});

describe("e2e: JWE 요청과 평문 요청이 모두 발송된다 (RQ-022)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let fake: FakeSmtp;
  let app: RestApp;
  let dir: string;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function waitSent(jobId: string): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      const res = await getJson(app, `/jobs/${jobId}`);
      if (((await res.json()) as { status: string }).status === "SENT") return;
      await sleep(25);
    }
    throw new Error("SENT 대기 시간 초과");
  }
  const decodedBodies = (raw: string): string[] =>
    (raw.match(/^[A-Za-z0-9+/=]{16,}$/gm) ?? []).map((p) =>
      Buffer.from(p, "base64").toString("utf8"),
    );

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mailo-envelope-e2e-"));
    const keysFile = path.join(dir, "envelope-keys.json");
    writeFileSync(
      keysFile,
      JSON.stringify({
        keys: [
          { kid: "mailo-2026-11", privateKeyVar: "MAILO_JWE_KEY_CURRENT" },
        ],
      }),
    );
    db = await createTestDatabase();
    pool = db.pool;
    await migrate(pool);
    fake = await startFakeSmtp();
    app = await startRestApp({
      pool,
      env: {
        MAILO_SMTP_HOST: fake.host,
        MAILO_SMTP_PORT: String(fake.port),
        MAILO_WORKER_POLL_MS: "50",
        MAILO_ENVELOPE_KEYS_FILE: keysFile,
        MAILO_JWE_KEY_CURRENT: current.privatePem,
      },
      worker: { trustedCa: fake.ca },
    });
  });

  afterAll(async () => {
    await app.close();
    await fake.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("JWE로 등록한 메일과 평문으로 등록한 메일이 같은 내용으로 SMTP에 나간다", async () => {
    const content = await encryptContent(current, {
      content: { subject: "ENV-SUBJECT-1", text: "암호화 요청 본문입니다." },
    });
    const encrypted = await postJob(app, {
      key: "e2e-jwe",
      body: { to: ["kim@example.com"], from: FROM, content },
    });
    const plain = await postJob(app, {
      key: "e2e-plain",
      body: plainMail({
        to: ["lee@example.com"],
        subject: "ENV-SUBJECT-2",
        text: "평문 요청 본문입니다.",
      }),
    });
    expect(encrypted.status).toBe(202);
    expect(plain.status).toBe(202);

    await waitSent(((await encrypted.json()) as { jobId: string }).jobId);
    await waitSent(((await plain.json()) as { jobId: string }).jobId);

    const byRecipient = new Map(fake.messages.map((m) => [m.rcptTo[0], m]));
    const viaJwe = byRecipient.get("kim@example.com")!;
    const viaPlain = byRecipient.get("lee@example.com")!;
    expect(viaJwe.raw).toContain("Subject: ENV-SUBJECT-1");
    expect(decodedBodies(viaJwe.raw)).toContain("암호화 요청 본문입니다.");
    expect(viaPlain.raw).toContain("Subject: ENV-SUBJECT-2");
    expect(decodedBodies(viaPlain.raw)).toContain("평문 요청 본문입니다.");
  });
});
