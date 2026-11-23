import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import {
  DEFAULT_SMTP_TIMEOUTS,
  SmtpAbortedError,
  SmtpConfigError,
  StageTracker,
  checkSmtpTimeouts,
  createSmtpSender,
  sanitizeResponseText,
  type SmtpMessage,
  type SmtpSenderConfig,
} from "../../src/smtp/index.js";
import {
  startFakeSmtp,
  type FakeSmtp,
  type Reply,
} from "../support/fake-smtp.js";

const JOB_ID = "22222222-2222-4222-8222-222222222222";

const MESSAGE: SmtpMessage = {
  jobId: JOB_ID,
  from: "mailo@example.com",
  to: ["to1@example.com"],
  cc: ["cc1@example.com"],
  bcc: ["bcc1@example.com"],
  subject: "한글 제목 확인",
  text: "안녕하세요. 본문입니다.",
  html: null,
};

let fake: FakeSmtp;
let implicit: FakeSmtp;
beforeAll(async () => {
  fake = await startFakeSmtp();
  implicit = await startFakeSmtp({ secure: true });
});
afterAll(async () => {
  await fake.close();
  await implicit.close();
});
beforeEach(() => {
  fake.reset();
  implicit.reset();
});

function config(
  server: FakeSmtp,
  over: Partial<SmtpSenderConfig> = {},
): SmtpSenderConfig {
  return {
    host: server.host,
    port: server.port,
    tlsMode: "STARTTLS",
    auth: { user: "user@example.com", pass: "fake-password" },
    timeouts: { ...DEFAULT_SMTP_TIMEOUTS, socketMs: 2_000, totalMs: 8_000 },
    trustedCa: server.ca,
    ...over,
  };
}

/** MIME 단일 파트(헤더 + 본문)에서 본문을 Content-Transfer-Encoding에 맞게 푼다. */
function decodeBody(raw: string): string {
  const split = raw.indexOf("\r\n\r\n");
  const headers = raw.slice(0, split);
  const body = raw.slice(split + 4);
  const encoding = /^content-transfer-encoding:\s*(\S+)/im
    .exec(headers)?.[1]
    ?.toLowerCase();
  if (encoding === "base64")
    return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (encoding === "quoted-printable") {
    const joined = body.replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    for (let i = 0; i < joined.length; i++) {
      if (
        joined[i] === "=" &&
        /^[0-9A-F]{2}$/i.test(joined.slice(i + 1, i + 3))
      ) {
        bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(...Buffer.from(joined[i]!, "utf8"));
      }
    }
    return Buffer.from(bytes).toString("utf8");
  }
  return body;
}

function decodeSubject(raw: string): string {
  const header = /^subject:\s*((?:.|\r\n[ \t])+)/im.exec(raw)?.[1] ?? "";
  return header
    .replace(/\r\n[ \t]/g, "")
    .replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/gi, (_m, b64: string) =>
      Buffer.from(b64, "base64").toString("utf8"),
    )
    .replace(/=\?UTF-8\?Q\?([^?]+)\?=\s*/gi, (_m, q: string) =>
      Buffer.from(
        q
          .replace(/_/g, " ")
          .replace(/=([0-9A-F]{2})/gi, (_x, h: string) =>
            String.fromCharCode(parseInt(h, 16)),
          ),
        "latin1",
      ).toString("utf8"),
    );
}

describe("연결 방식 (RQ-005)", () => {
  it("기본 설정은 STARTTLS로 TLS 업그레이드한 뒤 인증하고 발송한다", async () => {
    const result = await createSmtpSender(config(fake)).send(MESSAGE);
    expect(result).toEqual({ kind: "SENT", rejectedRecipients: [] });
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]!.secure).toBe(true);
    expect(fake.lastAuth).toEqual({
      user: "user@example.com",
      password: "fake-password",
    });
  });

  it("IMPLICIT 설정은 연결 즉시 TLS로 발송한다", async () => {
    const result = await createSmtpSender(
      config(implicit, { tlsMode: "IMPLICIT" }),
    ).send(MESSAGE);
    expect(result.kind).toBe("SENT");
    expect(implicit.messages).toHaveLength(1);
    expect(implicit.messages[0]!.secure).toBe(true);
  });

  it("STARTTLS 설정으로 implicit TLS 포트에 붙으면 실패한다", async () => {
    const result = await createSmtpSender(config(implicit)).send(MESSAGE);
    expect(result.kind).toBe("ACCOUNT");
    expect(implicit.messages).toHaveLength(0);
  });

  it("인증 정보가 없으면 인증 없이 발송한다(IP 허용 relay)", async () => {
    const { auth: _auth, ...withoutAuth } = config(fake);
    const result = await createSmtpSender(withoutAuth).send(MESSAGE);
    expect(result.kind).toBe("SENT");
    expect(fake.counts.auths).toBe(0);
  });

  it("결과 객체에 인증 정보(비밀번호)가 들어가지 않는다 (RQ-027)", async () => {
    fake.behavior.auth = () => ({
      code: 535,
      text: "5.7.8 Username and Password not accepted",
    });
    const result = await createSmtpSender(
      config(fake, {
        auth: { user: "user@example.com", pass: "CANARY-PASSWORD-1" },
      }),
    ).send(MESSAGE);
    expect(result.kind).toBe("ACCOUNT");
    expect(JSON.stringify(result)).not.toContain("CANARY-PASSWORD-1");
  });
});

describe("메시지 내용 (RQ-006, ADR-0007 결정 8)", () => {
  it("한글 제목과 text 본문이 깨지지 않고 전달된다", async () => {
    await createSmtpSender(config(fake)).send(MESSAGE);
    const raw = fake.messages[0]!.raw;
    expect(decodeSubject(raw)).toBe("한글 제목 확인");
    expect(decodeBody(raw)).toContain("안녕하세요. 본문입니다.");
  });

  it("HTML만 있는 본문도 전달된다", async () => {
    await createSmtpSender(config(fake)).send({
      ...MESSAGE,
      text: null,
      html: "<p>한글 HTML 본문</p>",
    });
    const raw = fake.messages[0]!.raw;
    expect(raw).toMatch(/content-type:\s*text\/html/i);
    expect(decodeBody(raw)).toContain("<p>한글 HTML 본문</p>");
  });

  it("작업 ID에서 유도한 Message-ID를 쓰고 같은 작업의 재시도도 같은 값이다", async () => {
    const sender = createSmtpSender(config(fake));
    await sender.send(MESSAGE);
    await sender.send(MESSAGE);
    expect(fake.messages.map((m) => m.messageId)).toEqual([
      `<${JOB_ID}@example.com>`,
      `<${JOB_ID}@example.com>`,
    ]);
  });

  it("accountAddress가 있으면 그 도메인을 Message-ID에 쓴다", async () => {
    await createSmtpSender(
      config(fake, { accountAddress: "relay@mail.example.org" }),
    ).send(MESSAGE);
    expect(fake.messages[0]!.messageId).toBe(`<${JOB_ID}@mail.example.org>`);
  });

  it("bcc는 봉투 수신자에는 있고 헤더에는 없다", async () => {
    await createSmtpSender(config(fake)).send(MESSAGE);
    const m = fake.messages[0]!;
    expect(m.rcptTo.sort()).toEqual([
      "bcc1@example.com",
      "cc1@example.com",
      "to1@example.com",
    ]);
    expect(m.raw).not.toMatch(/^bcc:/im);
    expect(m.raw).toMatch(/^cc: cc1@example.com/im);
  });

  it("replyTo가 헤더로 들어간다", async () => {
    await createSmtpSender(config(fake)).send({
      ...MESSAGE,
      replyTo: "reply@example.com",
    });
    expect(fake.messages[0]!.raw).toMatch(/^reply-to: reply@example.com/im);
  });
});

describe("취소와 입력 오류", () => {
  it("호출자 signal이 이미 중단돼 있으면 연결하지 않고 SmtpAbortedError로 거부한다", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createSmtpSender(config(fake)).send(MESSAGE, {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(SmtpAbortedError);
    expect(fake.counts.connects).toBe(0);
  });

  it("전송 중 호출자 signal로 중단하면 SmtpAbortedError로 거부한다(결과를 분류하지 않는다)", async () => {
    fake.behavior.hangAfterData = () => true;
    const controller = new AbortController();
    const pending = createSmtpSender(config(fake)).send(MESSAGE, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toBeInstanceOf(SmtpAbortedError);
  });

  it("잘못된 작업 ID는 연결 전에 내부 오류로 거부한다", async () => {
    await expect(
      createSmtpSender(config(fake)).send({ ...MESSAGE, jobId: "bad id>" }),
    ).rejects.toMatchObject({
      name: "SmtpInternalError",
    });
    expect(fake.counts.connects).toBe(0);
  });
});

describe("수신자 전원 거부 (ADR-0007 결정 7)", () => {
  const reply = (code: number, text: string): Reply => ({ code, text });

  it("failure는 첫 거부 수신자가 아니라 결과를 정한 수신자의 응답이다", async () => {
    fake.behavior.rcpt = (address) =>
      address === "to1@example.com"
        ? reply(550, "5.1.1 no such user")
        : reply(550, "5.4.5 Daily user sending limit exceeded.");

    const result = await createSmtpSender(config(fake)).send({
      ...MESSAGE,
      to: ["to1@example.com", "to2@example.com"],
      cc: [],
      bcc: [],
    });

    expect(result).toMatchObject({
      kind: "ACCOUNT",
      reason: "DAILY_LIMIT",
      failure: {
        stage: "RCPT",
        responseCode: 550,
        enhancedStatus: "5.4.5",
      },
    });
  });
});

describe("타임아웃 검증 (ADR-0002 결정 11)", () => {
  const timeouts = {
    connectionMs: 10_000,
    greetingMs: 10_000,
    socketMs: 30_000,
    dnsMs: 10_000,
    totalMs: 90_000,
  };

  it("전체 마감과 여유의 합이 lease보다 짧으면 통과한다", () => {
    expect(() => checkSmtpTimeouts(timeouts, 120)).not.toThrow();
  });

  it("기본 타임아웃은 기본 lease 120초 안에 들어간다", () => {
    expect(() => checkSmtpTimeouts(DEFAULT_SMTP_TIMEOUTS, 120)).not.toThrow();
  });

  it("전체 마감 + 여유가 lease를 넘으면 기동을 거부한다", () => {
    expect(() => checkSmtpTimeouts(timeouts, 95)).toThrow(SmtpConfigError);
  });

  it("단계별 타임아웃 합 + 여유가 lease를 넘으면 기동을 거부한다", () => {
    expect(() =>
      checkSmtpTimeouts(
        { ...timeouts, socketMs: 100_000, totalMs: 20_000 },
        120,
      ),
    ).toThrow(SmtpConfigError);
  });

  it("0이나 음수 값은 거부한다", () => {
    expect(() => checkSmtpTimeouts({ ...timeouts, socketMs: 0 }, 120)).toThrow(
      SmtpConfigError,
    );
    expect(() => checkSmtpTimeouts(timeouts, 0)).toThrow(SmtpConfigError);
  });

  it("발송기 생성 시 잘못된 연결·타임아웃 값을 거부한다", () => {
    expect(() => createSmtpSender(config(fake, { port: 0 }))).toThrow(
      SmtpConfigError,
    );
    expect(() => createSmtpSender(config(fake, { host: " " }))).toThrow(
      SmtpConfigError,
    );
    expect(() =>
      createSmtpSender(
        config(fake, { timeouts: { ...timeouts, totalMs: -1 } }),
      ),
    ).toThrow(SmtpConfigError);
  });
});

describe("응답 텍스트 정리와 단계 추적", () => {
  it("이메일 주소를 가리고 500자로 자른다", () => {
    expect(sanitizeResponseText("550 5.1.1 <a.b+c@example.com> unknown")).toBe(
      "550 5.1.1 <[address]> unknown",
    );
    expect(sanitizeResponseText("<o'brien@example.com> unknown")).toBe(
      "<[address]> unknown",
    );
    expect(sanitizeResponseText("'a@example.com' unknown")).toBe(
      "'[address]' unknown",
    );
    expect(sanitizeResponseText("x".repeat(600))!.length).toBe(503);
    expect(sanitizeResponseText(undefined)).toBeUndefined();
  });

  it("StageTracker는 파이프라인 명령 중 응답이 없는 가장 오래된 명령을 단계로 본다", () => {
    const t = new StageTracker();
    const log = (tnx: string, m: string) => t.logger.debug({ tnx }, m);
    expect(t.stage()).toBe("CONN");
    log("server", "220 hello");
    log("client", "EHLO [127.0.0.1]");
    log("server", "250-x\n250 PIPELINING");
    log("client", "MAIL FROM:<a@example.com>");
    log("client", "RCPT TO:<b@example.com>");
    log("client", "DATA");
    expect(t.stage()).toBe("MAIL_FROM");
    log("server", "250 OK");
    expect(t.stage()).toBe("RCPT");
    log("server", "250 OK");
    expect(t.stage()).toBe("DATA");
    log("server", "354 go ahead");
    expect(t.stage()).toBe("DATA");
    log("server", "250 queued");
    expect(t.stage()).toBe("DATA");
  });

  it("StageTracker는 STARTTLS 응답 뒤 핸드셰이크 중에는 TLS 단계로 남는다", () => {
    const t = new StageTracker();
    const log = (tnx: string, m: string) => t.logger.debug({ tnx }, m);
    log("server", "220 hello");
    log("client", "EHLO x");
    log("server", "250 OK");
    log("client", "STARTTLS");
    expect(t.stage()).toBe("TLS");
    log("server", "220 ready");
    expect(t.stage()).toBe("TLS");
  });
});
