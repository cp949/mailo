import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { createTransport } from "nodemailer";
import {
  DEFAULT_SMTP_TIMEOUTS,
  adaptNodemailerError,
  classifySmtpFailure,
  createSmtpSender,
  type SmtpSendResult,
  type SmtpSenderConfig,
  type SmtpStage,
} from "../../src/smtp/index.js";
import {
  startFakeSmtp,
  type FakeSmtp,
  type Reply,
} from "../support/fake-smtp.js";

/**
 * ADR-0007 결정 9: 어댑터가 가정한 nodemailer 오류 필드(command, code, responseCode, response, rejectedErrors)를
 * 실제 라이브러리와 로컬 smtp-server로 확인한다. 단계별로 4xx·5xx·연결·TLS 실패를 일으켜
 * 실제 오류 객체가 분류 결과까지 올바르게 가는지 본다.
 */

const FAST: SmtpSenderConfig["timeouts"] = {
  connectionMs: 2_000,
  greetingMs: 2_000,
  socketMs: 600,
  dnsMs: 2_000,
  totalMs: 8_000,
};

const MESSAGE = {
  jobId: "11111111-1111-4111-8111-111111111111",
  from: "sender@example.com",
  to: ["to1@example.com"],
  cc: [],
  bcc: [],
  subject: "제목",
  text: "본문",
  html: null,
};

let fake: FakeSmtp;
beforeAll(async () => {
  fake = await startFakeSmtp();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => fake.reset());

function config(over: Partial<SmtpSenderConfig> = {}): SmtpSenderConfig {
  return {
    host: fake.host,
    port: fake.port,
    tlsMode: "STARTTLS",
    auth: { user: "user@example.com", pass: "fake-password" },
    timeouts: FAST,
    trustedCa: fake.ca,
    ...over,
  };
}

function send(
  over: Partial<SmtpSenderConfig> = {},
  message = MESSAGE,
): Promise<SmtpSendResult> {
  return createSmtpSender(config(over)).send(message);
}

const reply = (code: number, text: string): Reply => ({ code, text });

type Expected = {
  kind: SmtpSendResult["kind"];
  stage: SmtpStage;
  responseCode?: number;
  enhancedStatus?: string;
  reason?: string;
};

function expectFailure(result: SmtpSendResult, expected: Expected): void {
  expect(result.kind).toBe(expected.kind);
  if (result.kind === "SENT") return;
  expect(result.failure.stage).toBe(expected.stage);
  if (expected.responseCode !== undefined)
    expect(result.failure.responseCode).toBe(expected.responseCode);
  if (expected.enhancedStatus !== undefined)
    expect(result.failure.enhancedStatus).toBe(expected.enhancedStatus);
  if (expected.reason !== undefined) {
    expect(result.kind === "ACCOUNT" && result.reason).toBe(expected.reason);
  }
}

describe("nodemailer 오류 필드 실측 (ADR-0007 결정 9)", () => {
  async function rawError(): Promise<Record<string, unknown>> {
    const t = createTransport({
      host: fake.host,
      port: fake.port,
      secure: false,
      requireTLS: true,
      tls: { ca: fake.ca, minVersion: "TLSv1.2" },
      socketTimeout: 600,
      auth: { user: "u", pass: "p" },
    });
    try {
      await t.sendMail({
        from: "a@example.com",
        to: ["x@example.com", "y@example.com"],
        subject: "s",
        text: "t",
      });
    } catch (error) {
      return error as Record<string, unknown>;
    } finally {
      t.close();
    }
    throw new Error("오류가 발생해야 한다");
  }

  it("MAIL FROM 거부는 code EENVELOPE, command 'MAIL FROM', 숫자 responseCode, 응답 원문을 가진다", async () => {
    fake.behavior.mailFrom = () =>
      reply(550, "5.4.5 Daily user sending limit exceeded.");
    const e = await rawError();
    expect(e).toMatchObject({
      code: "EENVELOPE",
      command: "MAIL FROM",
      responseCode: 550,
      response: "550 5.4.5 Daily user sending limit exceeded.",
    });
  });

  it("RCPT 전원 거부는 rejectedErrors에 수신자별 code·command·responseCode·response·recipient가 있다", async () => {
    fake.behavior.rcpt = () => reply(550, "5.1.1 no such user");
    const e = await rawError();
    expect(e["code"]).toBe("EENVELOPE");
    expect(e["command"]).toBe("RCPT TO");
    expect(e["rejected"]).toEqual(["x@example.com", "y@example.com"]);
    expect(e["rejectedErrors"]).toEqual([
      expect.objectContaining({
        code: "EENVELOPE",
        command: "RCPT TO",
        responseCode: 550,
        response: "550 5.1.1 no such user",
        recipient: "x@example.com",
      }),
      expect.objectContaining({
        recipient: "y@example.com",
        responseCode: 550,
      }),
    ]);
  });

  it("DATA 본문 응답 거부는 code EMESSAGE, command 'DATA'다", async () => {
    fake.behavior.data = () => reply(550, "5.7.1 likely unsolicited");
    expect(await rawError()).toMatchObject({
      code: "EMESSAGE",
      command: "DATA",
      responseCode: 550,
    });
  });

  it("AUTH 거부는 code EAUTH, command 'AUTH PLAIN'이다", async () => {
    fake.behavior.auth = () =>
      reply(535, "5.7.8 Username and Password not accepted");
    expect(await rawError()).toMatchObject({
      code: "EAUTH",
      command: "AUTH PLAIN",
      responseCode: 535,
    });
  });

  it("연결 거부는 code ESOCKET, originalCode ECONNREFUSED, command 'CONN'이다(추정은 ECONNECTION이었다)", async () => {
    const t = createTransport({
      host: "127.0.0.1",
      port: 1,
      secure: false,
      requireTLS: true,
    });
    const e = await t
      .sendMail({
        from: "a@example.com",
        to: "x@example.com",
        subject: "s",
        text: "t",
      })
      .catch((x) => x);
    t.close();
    expect(e).toMatchObject({
      code: "ESOCKET",
      originalCode: "ECONNREFUSED",
      command: "CONN",
    });
    expect(e.responseCode).toBeUndefined();
  });

  it("DATA 응답 대기 중 소켓 타임아웃도 command가 'CONN'이다(단계를 알 수 없다)", async () => {
    fake.behavior.hangAfterData = () => true;
    expect(await rawError()).toMatchObject({
      code: "ETIMEDOUT",
      command: "CONN",
    });
  });
});

describe("단계별 실패 분류 (MAIL FROM)", () => {
  const cases: Array<[string, Reply, Expected]> = [
    [
      "550 5.4.5 일일 한도",
      reply(550, "5.4.5 Daily user sending limit exceeded."),
      {
        kind: "ACCOUNT",
        stage: "MAIL_FROM",
        responseCode: 550,
        enhancedStatus: "5.4.5",
        reason: "DAILY_LIMIT",
      },
    ],
    [
      "550 5.7.1 고객 전체 일일 relay 한도",
      reply(
        550,
        "5.7.1 Daily SMTP relay sending limit exceeded for this customer.",
      ),
      {
        kind: "ACCOUNT",
        stage: "MAIL_FROM",
        responseCode: 550,
        enhancedStatus: "5.7.1",
        reason: "DAILY_LIMIT",
      },
    ],
    [
      "550 5.7.1 relay 자격 오류",
      reply(550, "5.7.1 Invalid credentials for relay"),
      {
        kind: "ACCOUNT",
        stage: "MAIL_FROM",
        responseCode: 550,
        reason: "GENERAL",
      },
    ],
    [
      "421 4.7.0 순간 한도",
      reply(421, "4.7.0 Try again later, closing connection."),
      {
        kind: "ACCOUNT",
        stage: "MAIL_FROM",
        responseCode: 421,
        enhancedStatus: "4.7.0",
        reason: "BURST_LIMIT",
      },
    ],
    [
      "450 4.2.1 relay 순간 한도",
      reply(450, "4.2.1 Peak SMTP relay limit exceeded for this customer."),
      {
        kind: "ACCOUNT",
        stage: "MAIL_FROM",
        responseCode: 450,
        reason: "BURST_LIMIT",
      },
    ],
  ];

  it.each(cases)("%s", async (_name, r, expected) => {
    fake.behavior.mailFrom = () => r;
    expectFailure(await send(), expected);
  });
});

describe("단계별 실패 분류 (RCPT TO)", () => {
  const cases: Array<[string, Reply, Expected]> = [
    [
      "550 5.1.1 없는 사용자는 PERMANENT",
      reply(550, "5.1.1 no such user"),
      {
        kind: "PERMANENT",
        stage: "RCPT",
        responseCode: 550,
        enhancedStatus: "5.1.1",
      },
    ],
    [
      "450 4.2.1 수신자 쪽 속도 제한은 TRANSIENT",
      reply(
        450,
        "4.2.1 The user you are trying to contact is receiving email too quickly.",
      ),
      { kind: "TRANSIENT", stage: "RCPT", responseCode: 450 },
    ],
    [
      "452 4.5.3 수신자 수 초과는 TRANSIENT",
      reply(452, "4.5.3 Too many recipients"),
      { kind: "TRANSIENT", stage: "RCPT", responseCode: 452 },
    ],
    [
      "550 5.4.5 한도 초과는 단계와 무관하게 계정 상태 오류",
      reply(550, "5.4.5 Daily user sending limit exceeded."),
      { kind: "ACCOUNT", stage: "RCPT", reason: "DAILY_LIMIT" },
    ],
  ];

  it.each(cases)("%s", async (_name, r, expected) => {
    fake.behavior.rcpt = () => r;
    expectFailure(await send(), expected);
  });

  it("수신자 전원 거부에서 4xx와 5xx가 섞이면 TRANSIENT다 (ADR-0007 결정 7)", async () => {
    fake.behavior.rcpt = (address) =>
      address.startsWith("to1")
        ? reply(550, "5.1.1 no such user")
        : reply(450, "4.2.2 mailbox full");
    expectFailure(
      await send(
        {},
        { ...MESSAGE, to: ["to1@example.com", "to2@example.com"] },
      ),
      {
        kind: "TRANSIENT",
        stage: "RCPT",
      },
    );
  });

  it("일부 수신자만 거부되면 SENT이고 rejectedRecipients에 응답이 남는다 (RQ-016)", async () => {
    fake.behavior.rcpt = (address) =>
      address.startsWith("to1") ? reply(550, "5.1.1 no such user") : undefined;
    const result = await send(
      {},
      { ...MESSAGE, to: ["to1@example.com", "to2@example.com"] },
    );
    expect(result).toEqual({
      kind: "SENT",
      rejectedRecipients: [
        {
          address: "to1@example.com",
          responseCode: 550,
          enhancedStatus: "5.1.1",
          responseText: "550 5.1.1 no such user",
        },
      ],
    });
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]!.rcptTo).toEqual(["to2@example.com"]);
  });

  it("일부 수신자가 4xx로 거부돼도 SENT이고 재시도 대상이 아니다 (ADR-0007 결정 7)", async () => {
    fake.behavior.rcpt = (address) =>
      address.startsWith("to1") ? reply(450, "4.2.2 mailbox full") : undefined;
    const result = await send(
      {},
      { ...MESSAGE, to: ["to1@example.com", "to2@example.com"] },
    );
    expect(result.kind).toBe("SENT");
    expect(result.kind === "SENT" && result.rejectedRecipients).toEqual([
      expect.objectContaining({
        address: "to1@example.com",
        responseCode: 450,
      }),
    ]);
  });

  it("응답 텍스트에 수신자 주소가 있으면 가려서 돌려준다 (RQ-027)", async () => {
    fake.behavior.rcpt = (address) =>
      reply(550, `5.1.1 <${address}> does not exist`);
    const result = await send();
    expect(result.kind).toBe("PERMANENT");
    const text =
      result.kind === "SENT" ? "" : (result.failure.responseText ?? "");
    expect(text).toContain("[address]");
    expect(text).not.toContain("to1@example.com");
  });
});

describe("단계별 실패 분류 (DATA)", () => {
  const cases: Array<[string, Reply, Expected]> = [
    [
      "550 5.7.1 스팸 의심은 PERMANENT",
      reply(550, "5.7.1 Message likely unsolicited mail."),
      {
        kind: "PERMANENT",
        stage: "DATA",
        responseCode: 550,
        enhancedStatus: "5.7.1",
      },
    ],
    [
      "552 5.3.4 크기 초과는 PERMANENT",
      reply(552, "5.3.4 Message size exceeds fixed limit"),
      { kind: "PERMANENT", stage: "DATA", responseCode: 552 },
    ],
    [
      "451 4.3.0 임시 오류는 TRANSIENT",
      reply(451, "4.3.0 Temporary local problem"),
      { kind: "TRANSIENT", stage: "DATA", responseCode: 451 },
    ],
    [
      "550 5.4.5 한도 초과는 계정 상태 오류",
      reply(550, "5.4.5 Daily user sending limit exceeded."),
      { kind: "ACCOUNT", stage: "DATA", reason: "DAILY_LIMIT" },
    ],
    [
      "421 4.4.5 연결 종료 응답은 계정 상태 오류",
      reply(421, "4.4.5 Server busy, try again later."),
      {
        kind: "ACCOUNT",
        stage: "DATA",
        responseCode: 421,
        reason: "BURST_LIMIT",
      },
    ],
  ];

  it.each(cases)("%s", async (_name, r, expected) => {
    fake.behavior.data = () => r;
    expectFailure(await send(), expected);
  });

  it("본문 수신 뒤 응답 없이 연결이 끊기면 DATA 단계 TRANSIENT다 (수락 여부 불명, RQ-013)", async () => {
    fake.behavior.dropAfterData = () => true;
    expectFailure(await send(), { kind: "TRANSIENT", stage: "DATA" });
  });

  it("본문 수신 뒤 소켓 타임아웃이 나면 DATA 단계 TRANSIENT다", async () => {
    fake.behavior.hangAfterData = () => true;
    expectFailure(await send(), { kind: "TRANSIENT", stage: "DATA" });
  });

  it("전체 마감(totalMs)에 걸려도 DATA 단계 TRANSIENT다", async () => {
    fake.behavior.hangAfterData = () => true;
    const started = Date.now();
    const result = await send({
      timeouts: { ...FAST, socketMs: 5_000, totalMs: 500 },
    });
    expectFailure(result, { kind: "TRANSIENT", stage: "DATA" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("단계별 실패 분류 (연결·TLS·인증)", () => {
  it("535 인증 실패는 AUTH 단계 계정 상태 오류다", async () => {
    fake.behavior.auth = () =>
      reply(535, "5.7.8 Username and Password not accepted");
    expectFailure(await send(), {
      kind: "ACCOUNT",
      stage: "AUTH",
      responseCode: 535,
      enhancedStatus: "5.7.8",
      reason: "GENERAL",
    });
  });

  it("454 로그인 시도 과다도 AUTH 단계 계정 상태 오류다", async () => {
    fake.behavior.auth = () =>
      reply(454, "4.7.0 Too many login attempts, please try again later.");
    expectFailure(await send(), {
      kind: "ACCOUNT",
      stage: "AUTH",
      responseCode: 454,
    });
  });

  it("534 앱 비밀번호 요구는 계정 상태 오류다", async () => {
    fake.behavior.auth = () =>
      reply(534, "5.7.9 Application-specific password required.");
    expectFailure(await send(), {
      kind: "ACCOUNT",
      stage: "AUTH",
      responseCode: 534,
    });
  });

  it("연결 거부는 CONN 단계 계정 상태 오류다", async () => {
    expectFailure(await send({ port: 1 }), { kind: "ACCOUNT", stage: "CONN" });
  });

  it("서버가 연결 직후 421로 닫으면 계정 상태 오류다", async () => {
    fake.behavior.connect = () => reply(421, "4.3.2 Service shutting down");
    const result = await send();
    expect(result.kind).toBe("ACCOUNT");
  });

  it("RCPT TO 응답이 없어 소켓 타임아웃이 나면 RCPT 단계 계정 상태 오류다 (DATA 단계가 아니다)", async () => {
    fake.behavior.hangAtRcpt = true;
    expectFailure(await send(), { kind: "ACCOUNT", stage: "RCPT" });
  });

  it("STARTTLS를 지원하지 않는 서버에는 평문으로 보내지 않고 TLS 단계 계정 상태 오류로 실패한다 (RQ-005)", async () => {
    const plain = await startFakeSmtp({ disableStarttls: true });
    try {
      const result = await createSmtpSender(
        config({ port: plain.port, trustedCa: plain.ca }),
      ).send(MESSAGE);
      expectFailure(result, { kind: "ACCOUNT", stage: "TLS" });
      expect(plain.counts.mailFroms).toBe(0);
      expect(plain.counts.auths).toBe(0);
      expect(plain.messages).toHaveLength(0);
    } finally {
      await plain.close();
    }
  });

  it("신뢰하지 않는 인증서는 검증에 실패하고 TLS 단계 계정 상태 오류다 (RQ-005)", async () => {
    const { trustedCa: _unused, ...withoutCa } = config();
    expectFailure(await createSmtpSender(withoutCa).send(MESSAGE), {
      kind: "ACCOUNT",
      stage: "TLS",
    });
    expect(fake.counts.auths).toBe(0);
    expect(fake.messages).toHaveLength(0);
  });

  it("TLS 1.1까지만 지원하는 서버는 협상에 실패한다 (RQ-005: TLS 1.2 미만 금지)", async () => {
    const old = await startFakeSmtp({
      tlsServer: {
        minVersion: "TLSv1",
        maxVersion: "TLSv1.1",
        ciphers: "DEFAULT@SECLEVEL=0",
      },
    });
    try {
      const result = await createSmtpSender(
        config({ port: old.port, trustedCa: old.ca }),
      ).send(MESSAGE);
      expectFailure(result, { kind: "ACCOUNT", stage: "TLS" });
      expect(old.messages).toHaveLength(0);
    } finally {
      await old.close();
    }
  });

  it("implicit TLS 설정으로 평문 서버에 붙으면 실패한다", async () => {
    const result = await send({ tlsMode: "IMPLICIT" });
    expect(result.kind).toBe("ACCOUNT");
    expect(fake.messages).toHaveLength(0);
  });
});

describe("어댑터 직접 검증", () => {
  it("hint 없이 전송 계층 타임아웃을 받으면 CONN 단계로 본다", () => {
    const failure = adaptNodemailerError({
      code: "ETIMEDOUT",
      command: "CONN",
      message: "Timeout",
    });
    expect(failure).toMatchObject({ stage: "CONN", transportFault: "TIMEOUT" });
    expect(classifySmtpFailure(failure).kind).toBe("ACCOUNT");
  });

  it("hint가 DATA이면 같은 오류를 TRANSIENT로 분류한다", () => {
    const failure = adaptNodemailerError(
      { code: "ETIMEDOUT", command: "CONN", message: "Timeout" },
      { inFlightStage: "DATA" },
    );
    expect(failure.stage).toBe("DATA");
    expect(classifySmtpFailure(failure).kind).toBe("TRANSIENT");
  });

  it("서버 응답이 있는 오류는 hint보다 command를 따른다", () => {
    const failure = adaptNodemailerError(
      {
        code: "EMESSAGE",
        command: "DATA",
        responseCode: 550,
        response: "550 5.7.1 likely unsolicited",
      },
      { inFlightStage: "RCPT" },
    );
    expect(failure.stage).toBe("DATA");
  });

  it("기본 타임아웃 상수는 모두 양수다", () => {
    expect(Object.values(DEFAULT_SMTP_TIMEOUTS).every((v) => v > 0)).toBe(true);
  });
});
