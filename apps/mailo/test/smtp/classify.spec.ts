import { describe, expect, it } from "@jest/globals";
import {
  ACCOUNT_REASON_POLICY,
  accountOpenSeconds,
  classifySmtpFailure,
  resolveRecipientOutcome,
  shouldPromoteToPermanent,
  type SmtpFailure,
} from "../../src/smtp/classify.js";
import {
  adaptNodemailerError,
  adaptNodemailerSendInfo,
  parseEnhancedStatus,
} from "../../src/smtp/nodemailer-adapter.js";

const f = (
  stage: SmtpFailure["stage"],
  responseCode: number,
  enhancedStatus: string,
  responseText = "",
): SmtpFailure => ({
  stage,
  responseCode,
  enhancedStatus,
  responseText,
});

describe("classifySmtpFailure: 한도 초과 (ADR-0007 결정 4)", () => {
  it.each(["MAIL_FROM", "RCPT", "DATA"] as const)(
    "550 5.4.5는 %s 단계에서도 일일 한도 계정 오류다 (5xx이지만 PERMANENT가 아님)",
    (stage) => {
      const r = classifySmtpFailure(
        f(stage, 550, "5.4.5", "Daily user sending limit exceeded."),
      );
      expect(r).toMatchObject({ kind: "ACCOUNT", reason: "DAILY_LIMIT" });
    },
  );

  it("550 5.7.1에 일일 relay 한도 텍스트가 있으면 일일 한도다", () => {
    const r = classifySmtpFailure(
      f(
        "MAIL_FROM",
        550,
        "5.7.1",
        "Daily SMTP relay sending limit exceeded for this customer.",
      ),
    );
    expect(r).toMatchObject({ kind: "ACCOUNT", reason: "DAILY_LIMIT" });
  });

  it("550 5.7.1 rate limited 텍스트는 순간 한도다", () => {
    const r = classifySmtpFailure(
      f("DATA", 550, "5.7.1", "This email has been rate limited."),
    );
    expect(r).toMatchObject({ kind: "ACCOUNT", reason: "BURST_LIMIT" });
  });

  it.each([
    ["421", 421, "4.7.0"],
    ["421", 421, "4.4.5"],
    ["450", 450, "4.2.1"],
  ])("%s %s는 단계와 무관하게 순간 한도다", (_name, code, enhanced) => {
    for (const stage of ["CONN", "RCPT", "DATA"] as const) {
      expect(
        classifySmtpFailure(f(stage, code, enhanced, "Try again later")),
      ).toMatchObject({
        kind: "ACCOUNT",
        reason: "BURST_LIMIT",
      });
    }
  });

  it("450 4.2.1이라도 수신자 쪽 수신 속도 제한 텍스트는 TRANSIENT다", () => {
    const r = classifySmtpFailure(
      f(
        "RCPT",
        450,
        "4.2.1",
        "The user you are trying to contact is receiving email too quickly.",
      ),
    );
    expect(r).toMatchObject({
      kind: "TRANSIENT",
      rule: "RECIPIENT_THROTTLE_450_4_2_1",
    });
  });

  it("Peak SMTP relay limit은 순간 한도다", () => {
    const r = classifySmtpFailure(
      f(
        "RCPT",
        450,
        "4.2.1",
        "Peak SMTP relay limit exceeded for this customer.",
      ),
    );
    expect(r).toMatchObject({ kind: "ACCOUNT", reason: "BURST_LIMIT" });
  });
});

describe("classifySmtpFailure: 550 5.7.1 단계별 (ADR-0007 결정 4)", () => {
  it("relay 자격 텍스트는 계정 오류(GENERAL)다", () => {
    const r = classifySmtpFailure(
      f("MAIL_FROM", 550, "5.7.1", "Invalid credentials for relay 1.2.3.4."),
    );
    expect(r).toMatchObject({ kind: "ACCOUNT", reason: "GENERAL" });
  });

  it("텍스트로 구분할 수 없으면 계정 오류다 (안전한 쪽)", () => {
    for (const stage of ["MAIL_FROM", "RCPT", "DATA"] as const) {
      expect(
        classifySmtpFailure(f(stage, 550, "5.7.1", "something unknown")),
      ).toMatchObject({
        kind: "ACCOUNT",
        reason: "GENERAL",
        rule: "ACCOUNT_5_7_1_UNRECOGNIZED",
      });
    }
  });

  it("스팸·정책 거부 텍스트는 메시지 오류 PERMANENT다", () => {
    const r = classifySmtpFailure(
      f("DATA", 550, "5.7.1", "This message is likely unsolicited email."),
    );
    expect(r).toMatchObject({ kind: "PERMANENT" });
  });

  it("CONN·TLS·AUTH 단계의 550 5.7.1은 항상 계정 오류다", () => {
    for (const stage of ["CONN", "TLS", "AUTH"] as const) {
      expect(
        classifySmtpFailure(
          f(stage, 550, "5.7.1", "This message is likely unsolicited email."),
        ),
      ).toMatchObject({
        kind: "ACCOUNT",
      });
    }
  });
});

describe("classifySmtpFailure: 인증·연결·TLS", () => {
  it("AUTH 단계 535는 계정 오류다", () => {
    expect(
      classifySmtpFailure(
        f("AUTH", 535, "5.7.8", "Username and Password not accepted."),
      ),
    ).toMatchObject({
      kind: "ACCOUNT",
      reason: "GENERAL",
    });
  });

  it("MAIL FROM 단계에서 온 530 STARTTLS 요구도 계정 오류다", () => {
    expect(
      classifySmtpFailure(
        f("MAIL_FROM", 530, "5.7.0", "Must issue a STARTTLS command first."),
      ),
    ).toMatchObject({
      kind: "ACCOUNT",
    });
  });

  it("앱 비밀번호 필요(534)와 웹 로그인 필요는 계정 오류다", () => {
    expect(
      classifySmtpFailure(
        f("AUTH", 534, "5.7.9", "Application-specific password required."),
      ),
    ).toMatchObject({
      kind: "ACCOUNT",
    });
    expect(
      classifySmtpFailure(
        f("MAIL_FROM", 534, "5.7.14", "Please log in via your web browser"),
      ),
    ).toMatchObject({
      kind: "ACCOUNT",
    });
  });

  it("CONN 단계 타임아웃과 TLS 단계 오류는 계정 오류다", () => {
    expect(
      classifySmtpFailure({ stage: "CONN", transportFault: "TIMEOUT" }),
    ).toMatchObject({ kind: "ACCOUNT" });
    expect(
      classifySmtpFailure({ stage: "TLS", transportFault: "DISCONNECT" }),
    ).toMatchObject({ kind: "ACCOUNT" });
  });
});

describe("classifySmtpFailure: 메시지 단계 기본 규칙 (ADR-0007 결정 3)", () => {
  it("DATA 단계 타임아웃·연결 끊김은 TRANSIENT다", () => {
    expect(
      classifySmtpFailure({ stage: "DATA", transportFault: "TIMEOUT" }),
    ).toMatchObject({ kind: "TRANSIENT" });
    expect(
      classifySmtpFailure({ stage: "DATA", transportFault: "DISCONNECT" }),
    ).toMatchObject({ kind: "TRANSIENT" });
  });

  it("MAIL FROM·RCPT 단계 타임아웃은 계정 오류다 (ADR-0003 결정 7)", () => {
    expect(
      classifySmtpFailure({ stage: "RCPT", transportFault: "TIMEOUT" }),
    ).toMatchObject({ kind: "ACCOUNT" });
    expect(
      classifySmtpFailure({ stage: "MAIL_FROM", transportFault: "DISCONNECT" }),
    ).toMatchObject({
      kind: "ACCOUNT",
    });
  });

  it("4xx는 TRANSIENT, 5xx는 PERMANENT다", () => {
    expect(classifySmtpFailure(f("RCPT", 452, "4.5.3"))).toMatchObject({
      kind: "TRANSIENT",
    });
    expect(
      classifySmtpFailure(f("RCPT", 550, "5.1.1", "No such user")),
    ).toMatchObject({ kind: "PERMANENT" });
    expect(classifySmtpFailure(f("DATA", 552, "5.3.4"))).toMatchObject({
      kind: "PERMANENT",
    });
  });

  it("규칙에 없는 응답은 TRANSIENT 폴백이다", () => {
    expect(classifySmtpFailure({ stage: "DATA" })).toMatchObject({
      kind: "TRANSIENT",
      rule: "TRANSIENT_UNKNOWN_FALLBACK",
    });
  });

  it("분류 결과에 응답 텍스트가 들어가지 않는다", () => {
    const canary = "CANARY-recipient@example.com";
    const r = classifySmtpFailure(
      f("RCPT", 550, "5.1.1", `No such user ${canary}`),
    );
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });
});

describe("차단기 사유별 대기 (ADR-0007 결정 5, RQ-009)", () => {
  it("초기값은 일반 1분, 순간 한도 5분, 일일 한도 1시간이다", () => {
    expect(ACCOUNT_REASON_POLICY.GENERAL.initialOpenSeconds).toBe(60);
    expect(ACCOUNT_REASON_POLICY.BURST_LIMIT.initialOpenSeconds).toBe(300);
    expect(ACCOUNT_REASON_POLICY.DAILY_LIMIT.initialOpenSeconds).toBe(3600);
  });

  it("대표 작업이 실패할 때마다 2배로 늘고 상한은 max(30분, 초기값)이다", () => {
    expect(
      [0, 1, 2, 3, 4, 5, 6].map((n) => accountOpenSeconds("GENERAL", n)),
    ).toEqual([60, 120, 240, 480, 960, 1800, 1800]);
    expect(
      [0, 1, 2, 3].map((n) => accountOpenSeconds("BURST_LIMIT", n)),
    ).toEqual([300, 600, 1200, 1800]);
    expect(
      [0, 1, 5, 100].map((n) => accountOpenSeconds("DAILY_LIMIT", n)),
    ).toEqual([3600, 3600, 3600, 3600]);
  });

  it("한도 초과는 즉시 open이고 일반 오류는 아니다", () => {
    expect(ACCOUNT_REASON_POLICY.DAILY_LIMIT.opensImmediately).toBe(true);
    expect(ACCOUNT_REASON_POLICY.BURST_LIMIT.opensImmediately).toBe(true);
    expect(ACCOUNT_REASON_POLICY.GENERAL.opensImmediately).toBe(false);
  });

  it("account_trips는 MAIL FROM 이후 단계에서 3회 뒤부터 PERMANENT로 승격한다", () => {
    expect(shouldPromoteToPermanent("RCPT", 2)).toBe(false);
    expect(shouldPromoteToPermanent("RCPT", 3)).toBe(true);
    expect(shouldPromoteToPermanent("AUTH", 10)).toBe(false);
  });
});

describe("resolveRecipientOutcome: 일부 수신자 거부 (ADR-0007 결정 7)", () => {
  it("한 명이라도 수락되면 SENT이고 거부 수신자가 rejectedRecipients에 남는다", () => {
    const r = resolveRecipientOutcome([
      { address: "a@example.com", accepted: true },
      {
        address: "b@example.com",
        accepted: false,
        responseCode: 450,
        enhancedStatus: "4.2.2",
        responseText: "full",
      },
    ]);
    expect(r).toEqual({
      kind: "SENT",
      rejectedRecipients: [
        {
          address: "b@example.com",
          responseCode: 450,
          enhancedStatus: "4.2.2",
          responseText: "full",
        },
      ],
    });
  });

  it("전원 거부에 4xx가 하나라도 있으면 TRANSIENT다", () => {
    const r = resolveRecipientOutcome([
      {
        address: "a@example.com",
        accepted: false,
        responseCode: 550,
        enhancedStatus: "5.1.1",
      },
      {
        address: "b@example.com",
        accepted: false,
        responseCode: 452,
        enhancedStatus: "4.2.2",
      },
    ]);
    expect(r.kind).toBe("TRANSIENT");
  });

  it("전원 거부가 모두 5xx이면 PERMANENT다", () => {
    const r = resolveRecipientOutcome([
      {
        address: "a@example.com",
        accepted: false,
        responseCode: 550,
        enhancedStatus: "5.1.1",
      },
      {
        address: "b@example.com",
        accepted: false,
        responseCode: 553,
        enhancedStatus: "5.1.2",
      },
    ]);
    expect(r.kind).toBe("PERMANENT");
  });

  it("전원 거부에 일일 한도(550 5.4.5)가 섞이면 계정 오류가 우선한다", () => {
    const r = resolveRecipientOutcome([
      {
        address: "a@example.com",
        accepted: false,
        responseCode: 550,
        enhancedStatus: "5.1.1",
      },
      {
        address: "b@example.com",
        accepted: false,
        responseCode: 550,
        enhancedStatus: "5.4.5",
      },
    ]);
    expect(r).toMatchObject({ kind: "ACCOUNT", reason: "DAILY_LIMIT" });
  });

  it("수신자 결과가 비어 있으면 오류다", () => {
    expect(() => resolveRecipientOutcome([])).toThrow("NO_RECIPIENT_RESULTS");
  });
});

describe("nodemailer 어댑터 (예상 형태, 실제 라이브러리 미검증)", () => {
  it("response 문자열에서 코드와 enhanced status를 읽는다", () => {
    const failure = adaptNodemailerError({
      code: "EENVELOPE",
      command: "RCPT TO",
      response:
        "550-5.4.5 Daily user sending limit exceeded.\n550 5.4.5 More info",
      responseCode: 550,
    });
    expect(failure).toMatchObject({
      stage: "RCPT",
      responseCode: 550,
      enhancedStatus: "5.4.5",
    });
  });

  it("command로 단계를 판별한다", () => {
    const stage = (command: string) =>
      adaptNodemailerError({ command, responseCode: 550 }).stage;
    expect(stage("CONN")).toBe("CONN");
    expect(stage("STARTTLS")).toBe("TLS");
    expect(stage("AUTH PLAIN")).toBe("AUTH");
    expect(stage("MAIL FROM")).toBe("MAIL_FROM");
    expect(stage("RCPT TO")).toBe("RCPT");
    expect(stage("DATA")).toBe("DATA");
  });

  it("ETIMEDOUT·ECONNECTION은 응답 코드가 없으면 전송 계층 장애로 본다", () => {
    expect(
      adaptNodemailerError({ code: "ETIMEDOUT", command: "DATA" }),
    ).toEqual({ stage: "DATA", transportFault: "TIMEOUT" });
    expect(
      adaptNodemailerError({ code: "ECONNECTION", command: "CONN" }),
    ).toEqual({
      stage: "CONN",
      transportFault: "DISCONNECT",
    });
  });

  it("EAUTH와 ETLS는 command가 없어도 단계를 안다", () => {
    expect(
      adaptNodemailerError({ code: "EAUTH", responseCode: 535 }).stage,
    ).toBe("AUTH");
    expect(adaptNodemailerError({ code: "ETLS" }).stage).toBe("TLS");
  });

  it("알 수 없는 입력은 CONN 단계로 본다", () => {
    expect(adaptNodemailerError("문자열")).toEqual({ stage: "CONN" });
    expect(adaptNodemailerError(null)).toEqual({ stage: "CONN" });
  });

  it("enhanced status는 코드 계열과 같은 첫 줄에서만 읽는다", () => {
    expect(parseEnhancedStatus("421 4.7.0 Try again later")).toBe("4.7.0");
    expect(parseEnhancedStatus("250 OK")).toBeUndefined();
    expect(parseEnhancedStatus(undefined)).toBeUndefined();
  });

  it("발송 결과를 수신자별 결과로 바꾼다", () => {
    const results = adaptNodemailerSendInfo({
      accepted: ["a@example.com"],
      rejected: ["b@example.com"],
      rejectedErrors: [
        {
          recipient: "b@example.com",
          command: "RCPT TO",
          responseCode: 550,
          response: "550 5.1.1 No such user",
        },
      ],
    });
    expect(results).toEqual([
      { address: "a@example.com", accepted: true },
      {
        address: "b@example.com",
        accepted: false,
        responseCode: 550,
        enhancedStatus: "5.1.1",
        responseText: "550 5.1.1 No such user",
      },
    ]);
  });
});
