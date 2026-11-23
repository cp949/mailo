import { describe, expect, it } from "@jest/globals";
import {
  DEFAULT_MAIL_REQUEST_LIMITS,
  MailValidationError,
  assertValidMailRequest,
  checkAddress,
  validateIdempotencyKey,
  validateMailRequest,
  type ValidationIssue,
} from "../../src/validation/mail-request.js";

const valid = {
  from: "noreply@example.com",
  to: ["user@example.com"],
  subject: "안녕하세요",
  text: "본문",
};

const issuesOf = (input: unknown): ValidationIssue[] => {
  const r = validateMailRequest(input);
  return r.ok ? [] : r.issues;
};
const codes = (input: unknown) =>
  issuesOf(input).map((i) => `${i.code}@${i.field}`);

describe("validateMailRequest 정상 입력", () => {
  it("최소 요청을 통과시키고 선택 필드를 기본값으로 채운다", () => {
    const r = validateMailRequest(valid);
    expect(r).toEqual({
      ok: true,
      value: {
        from: "noreply@example.com",
        replyTo: null,
        to: ["user@example.com"],
        cc: [],
        bcc: [],
        subject: "안녕하세요",
        text: "본문",
        html: null,
      },
    });
  });

  it("html만 있는 요청과 bcc만 있는 요청도 통과한다", () => {
    expect(
      validateMailRequest({ ...valid, text: undefined, html: "<p>x</p>" }).ok,
    ).toBe(true);
    expect(
      validateMailRequest({ ...valid, to: undefined, bcc: ["b@example.com"] })
        .ok,
    ).toBe(true);
  });

  it("정의되지 않은 필드는 무시한다", () => {
    expect(validateMailRequest({ ...valid, extra: 1 }).ok).toBe(true);
  });
});

describe("RQ-030 헤더 인젝션", () => {
  it.each(["\r", "\n", "\r\n", "\0", "\u2028", "\u0085"])(
    "제목에 %j가 있으면 거부한다",
    (ch) => {
      expect(
        codes({ ...valid, subject: `정상${ch}Bcc: evil@example.com` }),
      ).toEqual(["HEADER_INJECTION@subject"]);
    },
  );

  it("수신자·from·replyTo 주소의 CR/LF를 거부한다", () => {
    expect(
      codes({ ...valid, to: ["a@example.com\r\nBcc: x@example.com"] }),
    ).toEqual(["HEADER_INJECTION@to[0]"]);
    expect(codes({ ...valid, from: "a@example.com\n" })).toEqual([
      "HEADER_INJECTION@from",
    ]);
    expect(codes({ ...valid, replyTo: "a@example.com\r" })).toEqual([
      "HEADER_INJECTION@replyTo",
    ]);
    expect(
      codes({ ...valid, cc: ["ok@example.com", "a@example.com\n"] }),
    ).toEqual(["HEADER_INJECTION@cc[1]"]);
  });

  it("본문(text, html)의 줄바꿈은 정상이다", () => {
    expect(
      validateMailRequest({ ...valid, text: "a\r\nb", html: "<p>\n</p>" }).ok,
    ).toBe(true);
  });
});

describe("RQ-030 주소 형식과 길이", () => {
  it.each([
    "a@example.com",
    "a.b+tag@sub.example.co.kr",
    "a_b-c@ex-ample.com",
    "x@a.bc",
  ])("%s는 통과한다", (a) => {
    expect(checkAddress(a, 254)).toBeUndefined();
  });

  it.each([
    "",
    "plain",
    "@example.com",
    "a@",
    "a@b",
    "a@@example.com",
    "a b@example.com",
    "a@exa mple.com",
    ".a@example.com",
    "a.@example.com",
    "a..b@example.com",
    "a@-example.com",
    "a@example-.com",
    "a@example..com",
    "a@1.2.3.4",
    "홍길동@example.com",
    "a@예시.한국",
    "Name <a@example.com>",
    '"a b"@example.com',
    "a@example.com,b@example.com",
  ])("%j는 ADDRESS_FORMAT이다", (a) => {
    expect(checkAddress(a, 254)).toBe("ADDRESS_FORMAT");
  });

  it("주소 길이 254자는 통과하고 255자는 거부한다", () => {
    const ok = `${"l".repeat(64)}@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(57)}.com`;
    expect(ok.length).toBe(254);
    expect(checkAddress(ok, 254)).toBeUndefined();
    expect(checkAddress(`${ok}m`, 254)).toBe("ADDRESS_TOO_LONG");
  });

  it("로컬 파트 64자는 통과하고 65자는 형식 오류다", () => {
    expect(checkAddress(`${"l".repeat(64)}@example.com`, 254)).toBeUndefined();
    expect(checkAddress(`${"l".repeat(65)}@example.com`, 254)).toBe(
      "ADDRESS_FORMAT",
    );
  });

  it("타입 오류와 누락을 구분한다", () => {
    expect(codes({ ...valid, from: undefined })).toEqual(["REQUIRED@from"]);
    expect(codes({ ...valid, from: 5 })).toEqual(["INVALID_TYPE@from"]);
    expect(codes({ ...valid, to: "a@example.com" })).toEqual([
      "INVALID_TYPE@to",
    ]);
    expect(codes({ ...valid, to: [1] })).toEqual(["INVALID_TYPE@to[0]"]);
    expect(codes("문자열")).toEqual(["INVALID_TYPE@$"]);
    expect(codes(null)).toEqual(["INVALID_TYPE@$"]);
    expect(codes([])).toEqual(["INVALID_TYPE@$"]);
  });

  it("수신자가 하나도 없으면 NO_RECIPIENTS다", () => {
    expect(codes({ ...valid, to: [] })).toEqual(["NO_RECIPIENTS@recipients"]);
    expect(codes({ from: valid.from, subject: "s", text: "t" })).toEqual([
      "NO_RECIPIENTS@recipients",
    ]);
  });
});

describe("RQ-030 수신자 합 50명", () => {
  const list = (n: number, prefix = "u") =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}@example.com`);

  it("to+cc+bcc 합 50명은 통과하고 51명은 거부한다", () => {
    expect(
      validateMailRequest({
        ...valid,
        to: list(20, "t"),
        cc: list(20, "c"),
        bcc: list(10, "b"),
      }).ok,
    ).toBe(true);
    expect(
      codes({
        ...valid,
        to: list(20, "t"),
        cc: list(20, "c"),
        bcc: list(11, "b"),
      }),
    ).toEqual(["RECIPIENTS_TOO_MANY@recipients"]);
  });

  it("상한을 넘으면 주소별 검사를 하지 않는다 (거대한 배열 비용 방지)", () => {
    const huge = Array.from({ length: 10_000 }, () => "잘못된주소");
    expect(codes({ ...valid, to: huge })).toEqual([
      "RECIPIENTS_TOO_MANY@recipients",
    ]);
  });
});

describe("RQ-030 제목 255자와 본문 1MiB", () => {
  it("제목 255자는 통과하고 256자는 거부한다 (코드 포인트 기준)", () => {
    expect(
      validateMailRequest({ ...valid, subject: "가".repeat(255) }).ok,
    ).toBe(true);
    expect(codes({ ...valid, subject: "가".repeat(256) })).toEqual([
      "SUBJECT_TOO_LONG@subject",
    ]);
    // UTF-16 서로게이트 쌍 이모지는 1자로 센다
    expect(
      validateMailRequest({ ...valid, subject: "😀".repeat(255) }).ok,
    ).toBe(true);
    expect(codes({ ...valid, subject: "😀".repeat(256) })).toEqual([
      "SUBJECT_TOO_LONG@subject",
    ]);
  });

  it("빈 제목은 REQUIRED다", () => {
    expect(codes({ ...valid, subject: "" })).toEqual(["REQUIRED@subject"]);
    expect(codes({ ...valid, subject: undefined })).toEqual([
      "REQUIRED@subject",
    ]);
  });

  it("제목+text+html 합이 1 MiB이면 통과하고 1바이트 넘으면 거부한다 (UTF-8 바이트 기준)", () => {
    const max = DEFAULT_MAIL_REQUEST_LIMITS.maxContentBytes;
    const subject = "s";
    expect(
      validateMailRequest({
        ...valid,
        subject,
        text: "a".repeat(max - 1 - 10),
        html: "b".repeat(10),
      }).ok,
    ).toBe(true);
    expect(
      codes({
        ...valid,
        subject,
        text: "a".repeat(max - 1 - 10),
        html: "b".repeat(11),
      }),
    ).toEqual(["CONTENT_TOO_LARGE@content"]);
  });

  it("한글은 3바이트로 센다", () => {
    const max = DEFAULT_MAIL_REQUEST_LIMITS.maxContentBytes;
    const ok = "가".repeat(Math.floor((max - 1) / 3));
    expect(validateMailRequest({ ...valid, subject: "s", text: ok }).ok).toBe(
      true,
    );
    expect(codes({ ...valid, subject: "s", text: ok + "가가" })).toEqual([
      "CONTENT_TOO_LARGE@content",
    ]);
  });

  it("text와 html이 모두 없으면 REQUIRED다", () => {
    expect(codes({ ...valid, text: undefined })).toEqual([
      "REQUIRED@text|html",
    ]);
    expect(codes({ ...valid, text: "", html: "" })).toEqual([
      "REQUIRED@text|html",
    ]);
  });

  it("한도는 설정으로 바꿀 수 있다", () => {
    const r = validateMailRequest(valid, {
      ...DEFAULT_MAIL_REQUEST_LIMITS,
      maxSubjectChars: 3,
    });
    expect(r.ok).toBe(false);
  });
});

describe("RQ-030 attachments 거부", () => {
  it.each([[[]], [[{ filename: "a.txt" }]], [null], ["x"]])(
    "attachments=%j가 있으면 거부한다",
    (v) => {
      expect(codes({ ...valid, attachments: v })).toEqual([
        "ATTACHMENTS_NOT_SUPPORTED@attachments",
      ]);
    },
  );
});

describe("RQ-011 Idempotency-Key", () => {
  it("1자와 128자는 통과하고 0자와 129자는 거부한다", () => {
    expect(validateIdempotencyKey("a")).toEqual({ ok: true, value: "a" });
    expect(validateIdempotencyKey("a".repeat(128)).ok).toBe(true);
    expect(validateIdempotencyKey("")).toEqual({
      ok: false,
      issues: [{ code: "KEY_LENGTH", field: "idempotencyKey" }],
    });
    expect(validateIdempotencyKey("a".repeat(129))).toEqual({
      ok: false,
      issues: [{ code: "KEY_LENGTH", field: "idempotencyKey" }],
    });
  });

  it("허용 문자 [A-Za-z0-9._:-]만 통과한다", () => {
    expect(validateIdempotencyKey("Order_1.2:3-x").ok).toBe(true);
    for (const bad of ["a b", "a/b", "a\nb", "한글", "a@b", "a+b"]) {
      expect(validateIdempotencyKey(bad)).toEqual({
        ok: false,
        issues: [{ code: "KEY_FORMAT", field: "idempotencyKey" }],
      });
    }
  });

  it("누락과 타입 오류를 구분한다", () => {
    expect(validateIdempotencyKey(undefined)).toEqual({
      ok: false,
      issues: [{ code: "REQUIRED", field: "idempotencyKey" }],
    });
    expect(validateIdempotencyKey(123)).toEqual({
      ok: false,
      issues: [{ code: "INVALID_TYPE", field: "idempotencyKey" }],
    });
  });
});

describe("검증 오류에 입력 값이 남지 않는다 (RQ-027)", () => {
  const CANARY = "CANARY-secret-9f3a";

  it("issues와 MailValidationError 메시지·스택·JSON에 canary가 없다", () => {
    const input = {
      from: `${CANARY}`,
      replyTo: `${CANARY}@bad..example.com`,
      to: [`${CANARY}\r\nBcc: x@example.com`, `${CANARY} <a@example.com>`],
      subject: `${CANARY}\n${"x".repeat(300)}`,
      text: CANARY,
      attachments: [{ filename: CANARY, content: CANARY }],
    };
    const result = validateMailRequest(input);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("CANARY");

    let error: unknown;
    try {
      assertValidMailRequest(input);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MailValidationError);
    const dump = `${(error as Error).message}\n${(error as Error).stack}\n${JSON.stringify(error)}`;
    expect(dump).not.toContain("CANARY");
    expect(dump).toContain("HEADER_INJECTION@subject");
  });

  it("키 검증 오류에도 canary가 없다", () => {
    expect(
      JSON.stringify(validateIdempotencyKey(`${CANARY} bad key`)),
    ).not.toContain("CANARY");
  });
});
