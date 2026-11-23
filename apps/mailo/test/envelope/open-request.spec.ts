import { describe, expect, it, jest } from "@jest/globals";
import {
  createKeyRing,
  createQueueFingerprinter,
  type QueueFingerprinter,
} from "../../src/crypto/index.js";
import {
  NO_SIGNATURE,
  createJweDecryptor,
  createPrivateKeyRing,
  openRequest,
  toRejectionReason,
  type JweDecryptor,
  type OpenRequestContext,
  type OpenRequestFailure,
  type OpenRequestInput,
} from "../../src/envelope/index.js";
import { Secret } from "../../src/config/index.js";
import { DEFAULT_MAIL_REQUEST_LIMITS } from "../../src/validation/index.js";
import {
  b64url,
  encryptContent,
  jwsSecret,
  replaceJweSegment,
  rsaKey,
  signJws,
} from "../support/envelope.js";

// RQ-022·024·030, ADR-0008 결정 1~4. REST와 파일 채널이 같은 openRequest를 쓴다.

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const DAY = 86_400;
const CANARY = {
  subject: "CANARY-ENV-SUBJECT-31ac",
  text: "CANARY-ENV-TEXT-77de",
};
const SECRET_ALPHA = jwsSecret(41);
const SECRET_OTHER = jwsSecret(42);

const MAIL = {
  to: ["kim@example.com"],
  from: "no-reply@example.com",
  subject: "주문 접수 안내",
  text: "주문이 접수되었습니다.",
};

function fileRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { version: 1, idempotencyKey: "outbox-1", ...MAIL, ...overrides };
}

const asBytes = (value: unknown): Uint8Array =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value));

const key1 = rsaKey("mailo-1");
const key0 = rsaKey("mailo-0");
const unknownKey = rsaKey("mailo-unknown");

const fingerprinter = createQueueFingerprinter(
  createKeyRing({
    currentVersion: 1,
    keys: new Map([[1, Buffer.alloc(32, 5)]]),
  }),
);

function makeCtx(
  overrides: Partial<OpenRequestContext> = {},
): OpenRequestContext {
  return {
    callerId: "alpha",
    signature: {
      mode: "required",
      keys: [{ kid: "alpha-1", secret: new Secret<Uint8Array>(SECRET_ALPHA) }],
    },
    limits: DEFAULT_MAIL_REQUEST_LIMITS,
    decryptor: createJweDecryptor(
      createPrivateKeyRing([
        { kid: "mailo-1", privateKey: key1.privateKey, retiredAt: null },
        {
          kid: "mailo-0",
          privateKey: key0.privateKey,
          retiredAt: new Date(NOW - 10 * DAY * 1000),
        },
      ]),
    ),
    fingerprinter,
    iat: { maxAgeSeconds: 7 * DAY, skewSeconds: 300 },
    nowMs: () => NOW,
    ...overrides,
  };
}

function signed(
  payload: Record<string, unknown> | string,
  options: Partial<Parameters<typeof signJws>[0]> = {},
): OpenRequestInput {
  return {
    kind: "file",
    bytes: asBytes(
      signJws({ secret: SECRET_ALPHA, payload, nowMs: NOW, ...options }),
    ),
  };
}

async function failureOf(
  input: OpenRequestInput,
  ctx: OpenRequestContext = makeCtx(),
): Promise<OpenRequestFailure> {
  const result = await openRequest(input, ctx);
  if (result.ok) throw new Error("거부돼야 한다");
  return result;
}

describe("openRequest: 서명(JWS) (RQ-024, ADR-0008 결정 2·4)", () => {
  it("정상 서명 파일은 payload의 요청을 돌려주고 signed가 true다", async () => {
    const result = await openRequest(signed(fileRequest()), makeCtx());

    expect(result).toMatchObject({
      ok: true,
      signed: true,
      encrypted: false,
      idempotencyKey: "outbox-1",
      request: { to: ["kim@example.com"], subject: "주문 접수 안내" },
    });
  });

  it("payload를 바꾸면 SIGNATURE_INVALID다(서명 변조)", async () => {
    const jws = signJws({
      secret: SECRET_ALPHA,
      payload: fileRequest(),
      nowMs: NOW,
    });
    const tampered = {
      ...jws,
      payload: b64url(
        JSON.stringify(fileRequest({ to: ["evil@example.com"] })),
      ),
    };

    const failure = await failureOf({ kind: "file", bytes: asBytes(tampered) });

    expect(failure).toMatchObject({
      reason: "SIGNATURE_INVALID",
      field: "/signature",
    });
  });

  it("서명 문자열을 바꾸거나 비워도 SIGNATURE_INVALID다", async () => {
    const jws = signJws({
      secret: SECRET_ALPHA,
      payload: fileRequest(),
      nowMs: NOW,
    });

    for (const signature of ["", jws.signature.replace(/.$/, "A"), "AAAA"]) {
      const failure = await failureOf({
        kind: "file",
        bytes: asBytes({ ...jws, signature }),
      });
      expect(failure.reason).toBe("SIGNATURE_INVALID");
    }
  });

  it("alg none 공격을 거부한다(서명을 비우거나 임의 값을 넣어도)", async () => {
    for (const signature of ["", "AAAA"]) {
      const jws = signJws({
        secret: SECRET_ALPHA,
        payload: fileRequest(),
        nowMs: NOW,
        header: { alg: "none" },
      });
      const failure = await failureOf({
        kind: "file",
        bytes: asBytes({ ...jws, signature }),
      });

      expect(failure).toMatchObject({
        reason: "SIGNATURE_INVALID",
        field: "/protected/alg",
      });
    }
  });

  it("alg 혼동(HS384·HS512·RS256·소문자)을 거부한다. 같은 비밀키로 올바르게 서명해도 마찬가지다", async () => {
    for (const alg of ["HS384", "HS512", "RS256", "hs256", "None", "ES256"]) {
      const failure = await failureOf(
        signed(fileRequest(), { header: { alg } }),
      );
      expect(failure).toMatchObject({
        reason: "SIGNATURE_INVALID",
        field: "/protected/alg",
      });
    }
  });

  it("알 수 없는 kid와 다른 호출처 키로 서명한 파일은 SIGNATURE_INVALID다", async () => {
    const unknownKid = await failureOf(
      signed(fileRequest(), { kid: "alpha-9" }),
    );
    const otherKey = await failureOf(
      signed(fileRequest(), { secret: SECRET_OTHER }),
    );

    expect(unknownKid).toMatchObject({
      reason: "SIGNATURE_INVALID",
      field: "/protected/kid",
    });
    expect(otherKey.reason).toBe("SIGNATURE_INVALID");
  });

  it("교체 중인 키 2개 모두로 서명한 파일을 받는다", async () => {
    const ctx = makeCtx({
      signature: {
        mode: "required",
        keys: [
          { kid: "alpha-1", secret: new Secret<Uint8Array>(SECRET_ALPHA) },
          { kid: "alpha-2", secret: new Secret<Uint8Array>(SECRET_OTHER) },
        ],
      },
    });

    const first = await openRequest(signed(fileRequest()), ctx);
    const second = await openRequest(
      signed(fileRequest(), { kid: "alpha-2", secret: SECRET_OTHER }),
      ctx,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("서명이 required인데 서명 없는 평문 파일은 SIGNATURE_REQUIRED다", async () => {
    const failure = await failureOf({
      kind: "file",
      bytes: asBytes(fileRequest()),
    });

    expect(failure.reason).toBe("SIGNATURE_REQUIRED");
    expect(toRejectionReason(failure.reason)).toBe("SIGNATURE_INVALID");
  });

  it("iat가 허용 기간(7일)보다 오래되면 IAT_OUT_OF_RANGE이고 경계(정확히 7일)는 받는다", async () => {
    const nowSec = NOW / 1000;
    const edge = await openRequest(
      signed(fileRequest(), { iat: nowSec - 7 * DAY }),
      makeCtx(),
    );
    const expired = await failureOf(
      signed(fileRequest(), { iat: nowSec - 7 * DAY - 1 }),
    );

    expect(edge.ok).toBe(true);
    expect(expired).toMatchObject({
      reason: "IAT_OUT_OF_RANGE",
      field: "/protected/iat",
    });
  });

  it("iat가 허용 오차(5분)를 넘어 미래이면 IAT_OUT_OF_RANGE이고 5분 이내는 받는다", async () => {
    const nowSec = NOW / 1000;
    const within = await openRequest(
      signed(fileRequest(), { iat: nowSec + 300 }),
      makeCtx(),
    );
    const future = await failureOf(
      signed(fileRequest(), { iat: nowSec + 301 }),
    );

    expect(within.ok).toBe(true);
    expect(future.reason).toBe("IAT_OUT_OF_RANGE");
  });

  it("서명 안의 caller가 요청 호출처와 다르면 CALLER_MISMATCH다", async () => {
    const failure = await failureOf(signed(fileRequest(), { caller: "beta" }));

    expect(failure).toMatchObject({
      reason: "CALLER_MISMATCH",
      field: "/protected/caller",
    });
  });

  it("호출처 폴더에 다른 호출처가 서명한 파일이 들어오면 거부한다(호출처 키만 쓴다)", async () => {
    const failure = await failureOf(
      signed(fileRequest(), {
        caller: "beta",
        secret: SECRET_OTHER,
        kid: "beta-1",
      }),
    );

    expect(failure.reason).toBe("SIGNATURE_INVALID");
  });

  it("iat가 없거나 숫자가 아니면 MALFORMED다", async () => {
    for (const iat of [null, "1700000000", Number.NaN]) {
      const failure = await failureOf(
        signed(fileRequest(), { header: { iat } }),
      );
      expect(failure).toMatchObject({
        reason: "MALFORMED",
        field: "/protected/iat",
      });
    }
  });

  it("서명 범위 밖 필드(unprotected header, 알 수 없는 protected 필드, crit)를 거부한다", async () => {
    const jws = signJws({
      secret: SECRET_ALPHA,
      payload: fileRequest(),
      nowMs: NOW,
    });

    const withHeader = await failureOf({
      kind: "file",
      bytes: asBytes({ ...jws, header: { kid: "alpha-1" } }),
    });
    const extraField = await failureOf(
      signed(fileRequest(), { header: { crit: ["b64"], b64: false } }),
    );

    expect(withHeader.reason).toBe("MALFORMED");
    expect(extraField.reason).toBe("MALFORMED");
  });

  it("JSON이 아닌 파일과 payload가 JSON이 아닌 파일은 MALFORMED다", async () => {
    const notJson = await failureOf({
      kind: "file",
      bytes: asBytes("{not json"),
    });
    const badPayload = await failureOf(signed("not json at all"));
    const notObject = await failureOf(signed("[1,2,3]"));

    expect(notJson.reason).toBe("MALFORMED");
    expect(badPayload).toMatchObject({
      reason: "MALFORMED",
      field: "/payload",
    });
    expect(notObject.reason).toBe("VALIDATION_FAILED");
  });

  it("서명이 none인 호출처는 파일 전체를 요청 JSON으로 읽고, 서명 파일은 정의되지 않은 필드로 거부한다", async () => {
    const ctx = makeCtx({ signature: NO_SIGNATURE });

    const plain = await openRequest(
      { kind: "file", bytes: asBytes(fileRequest()) },
      ctx,
    );
    const asJws = await failureOf(signed(fileRequest()), ctx);

    expect(plain).toMatchObject({ ok: true, signed: false });
    expect(asJws.ok).toBe(false);
    expect(asJws.issues).toContainEqual({ pointer: "", code: "UNKNOWN_FIELD" });
  });

  it("REST는 서명 정책과 무관하게 서명을 요구하지 않는다", async () => {
    const result = await openRequest({ kind: "rest", body: MAIL }, makeCtx());

    expect(result).toMatchObject({
      ok: true,
      signed: false,
      idempotencyKey: null,
    });
  });
});

describe("openRequest: 파일 채널 스키마 (ADR-0004 결정 1, ADR-0005 결정 1)", () => {
  const plain = (body: unknown): OpenRequestInput => ({
    kind: "file",
    bytes: asBytes(body),
  });
  const ctx = makeCtx({ signature: NO_SIGNATURE });

  it("idempotencyKey 누락과 형식 위반은 각각 전용 사유다", async () => {
    const { idempotencyKey: _omit, ...withoutKey } = fileRequest();

    const missing = await failureOf(plain(withoutKey), ctx);
    const empty = await failureOf(
      plain(fileRequest({ idempotencyKey: "" })),
      ctx,
    );
    const badChars = await failureOf(
      plain(fileRequest({ idempotencyKey: "a b" })),
      ctx,
    );
    const tooLong = await failureOf(
      plain(fileRequest({ idempotencyKey: "k".repeat(129) })),
      ctx,
    );

    expect(missing.reason).toBe("IDEMPOTENCY_KEY_MISSING");
    expect(empty.reason).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(badChars.reason).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(tooLong.reason).toBe("IDEMPOTENCY_KEY_INVALID");
  });

  it("version이 없거나 1이 아니면 VALIDATION_FAILED다", async () => {
    const { version: _omit, ...withoutVersion } = fileRequest();

    const missing = await failureOf(plain(withoutVersion), ctx);
    const wrong = await failureOf(plain(fileRequest({ version: 2 })), ctx);

    expect(missing.issues).toEqual([{ pointer: "/version", code: "REQUIRED" }]);
    expect(wrong.issues).toEqual([
      { pointer: "/version", code: "INVALID_FORMAT" },
    ]);
  });

  it("attachments가 있으면 ATTACHMENTS_NOT_SUPPORTED다", async () => {
    const failure = await failureOf(
      plain(fileRequest({ attachments: [{ name: "a" }] })),
      ctx,
    );

    expect(failure.reason).toBe("ATTACHMENTS_NOT_SUPPORTED");
  });

  it("REST에서는 version·idempotencyKey가 정의되지 않은 필드다", async () => {
    const failure = await failureOf(
      { kind: "rest", body: { ...MAIL, version: 1 } },
      ctx,
    );

    expect(failure.issues).toEqual([{ pointer: "", code: "UNKNOWN_FIELD" }]);
  });
});

describe("openRequest: 봉투 암호화(JWE) (RQ-022, ADR-0008 결정 1)", () => {
  const restBody = (content: string, extra: Record<string, unknown> = {}) =>
    ({
      kind: "rest",
      body: {
        to: ["kim@example.com"],
        from: "no-reply@example.com",
        content,
        ...extra,
      },
    }) as const;
  const secret = { subject: MAIL.subject, text: MAIL.text };

  it("정상 JWE는 복호화한 제목·본문으로 검증된 요청을 돌려준다", async () => {
    const content = await encryptContent(key1, { content: secret });

    const result = await openRequest(restBody(content), makeCtx());

    expect(result).toMatchObject({
      ok: true,
      encrypted: true,
      request: {
        to: ["kim@example.com"],
        subject: "주문 접수 안내",
        text: "주문이 접수되었습니다.",
        html: null,
      },
    });
  });

  it("알 수 없는 kid는 KID_UNKNOWN이고 파일 채널 사유 코드로는 DECRYPTION_FAILED다", async () => {
    const content = await encryptContent(unknownKey, { content: secret });

    const failure = await failureOf(restBody(content));

    expect(failure).toMatchObject({ reason: "KID_UNKNOWN", field: "/content" });
    expect(toRejectionReason(failure.reason)).toBe("DECRYPTION_FAILED");
  });

  it("kid가 없는 JWE도 KID_UNKNOWN이다", async () => {
    const content = await encryptContent(key1, {
      content: secret,
      header: { kid: undefined },
    });

    expect((await failureOf(restBody(content))).reason).toBe("KID_UNKNOWN");
  });

  it("보호 헤더를 바꾸면(AAD 위반) DECRYPTION_FAILED다. 필드를 하나 더하는 변경도 마찬가지다", async () => {
    const content = await encryptContent(key1, { content: secret });
    const header = JSON.parse(
      Buffer.from(content.split(".")[0] as string, "base64url").toString(),
    ) as Record<string, unknown>;

    const extraField = replaceJweSegment(content, 0, () =>
      b64url(JSON.stringify({ ...header, note: "x" })),
    );
    const reordered = replaceJweSegment(content, 0, () =>
      b64url(JSON.stringify({ caller: "alpha", ...header })),
    );

    expect((await failureOf(restBody(extraField))).reason).toBe(
      "DECRYPTION_FAILED",
    );
    expect((await failureOf(restBody(reordered))).reason).toBe(
      "DECRYPTION_FAILED",
    );
  });

  it("헤더의 caller를 바꿔 재인코딩하면 복호화 단계에서 막힌다(인증 전 caller를 믿지 않는다)", async () => {
    const content = await encryptContent(key1, { content: secret });
    const header = JSON.parse(
      Buffer.from(content.split(".")[0] as string, "base64url").toString(),
    ) as Record<string, unknown>;

    const forged = replaceJweSegment(content, 0, () =>
      b64url(JSON.stringify({ ...header, caller: "beta" })),
    );

    expect((await failureOf(restBody(forged))).reason).toBe(
      "DECRYPTION_FAILED",
    );
  });

  it("JWE의 caller가 요청 호출처와 다르면 CALLER_MISMATCH다", async () => {
    const content = await encryptContent(key1, {
      caller: "beta",
      content: secret,
    });

    const failure = await failureOf(restBody(content));

    expect(failure).toMatchObject({
      reason: "CALLER_MISMATCH",
      field: "/content",
    });
  });

  it("암호문·태그·IV·암호화 키가 변조되거나 다른 키로 암호화됐으면 DECRYPTION_FAILED다", async () => {
    const content = await encryptContent(key1, { content: secret });
    // 같은 kid를 단 채 다른 개인키의 공개키로 암호화한 JWE(키 불일치)
    const wrongKey = await encryptContent(
      { ...unknownKey, kid: "mailo-1" },
      { content: secret },
    );
    const flip = (segment: string): string =>
      (segment[0] === "A" ? "B" : "A") + segment.slice(1);

    for (const index of [1, 2, 3, 4]) {
      const failure = await failureOf(
        restBody(replaceJweSegment(content, index, flip)),
      );
      expect(failure.reason).toBe("DECRYPTION_FAILED");
    }
    expect((await failureOf(restBody(wrongKey))).reason).toBe(
      "DECRYPTION_FAILED",
    );
    expect((await failureOf(restBody("aaa.bbb.ccc.ddd.eee"))).reason).toBe(
      "DECRYPTION_FAILED",
    );
  });

  it("alg·enc가 고정값이 아니면 복호화를 시도하지 않고 DECRYPTION_FAILED다", async () => {
    const wrongAlg = await encryptContent(key1, {
      content: secret,
      header: { alg: "RSA-OAEP" },
    });
    const wrongEnc = await encryptContent(key1, {
      content: secret,
      header: { enc: "A128GCM" },
    });

    expect((await failureOf(restBody(wrongAlg))).reason).toBe(
      "DECRYPTION_FAILED",
    );
    expect((await failureOf(restBody(wrongEnc))).reason).toBe(
      "DECRYPTION_FAILED",
    );
  });

  it("키 교체 중에는 이전 kid로 암호화한 요청도 복호화한다(ADR-0008 결정 5)", async () => {
    const oldKid = await encryptContent(key0, { content: secret });
    const newKid = await encryptContent(key1, { content: secret });
    const ctx = makeCtx();

    expect((await openRequest(restBody(oldKid), ctx)).ok).toBe(true);
    expect((await openRequest(restBody(newKid), ctx)).ok).toBe(true);
  });

  it("복호화한 제목의 CR/LF는 복호화 뒤 거부한다(헤더 인젝션, RQ-030)", async () => {
    for (const subject of [
      `제목\r\nBcc: evil@example.com`,
      "제목\nX-Injected: 1",
      "제목 줄",
    ]) {
      const content = await encryptContent(key1, {
        content: { subject, text: MAIL.text },
      });

      const failure = await failureOf(restBody(content));

      expect(failure).toMatchObject({ reason: "VALIDATION_FAILED" });
      expect(failure.issues).toEqual([
        { pointer: "/content", code: "CONTROL_CHARACTER" },
      ]);
    }
  });

  it("복호화한 평문의 형식 오류·알 수 없는 필드·크기 초과를 거부한다", async () => {
    const notJson = await encryptContent(key1, { content: "not json" });
    const array = await encryptContent(key1, { content: "[1]" });
    const unknown = await encryptContent(key1, {
      content: { ...secret, extra: "x" },
    });
    const big = await encryptContent(key1, {
      content: { subject: "s", text: "x".repeat(1024 * 1024) },
    });
    const noText = await encryptContent(key1, { content: { subject: "s" } });
    const attachments = await encryptContent(key1, {
      content: { ...secret, attachments: [] },
    });

    expect((await failureOf(restBody(notJson))).issues).toEqual([
      { pointer: "/content", code: "INVALID_FORMAT" },
    ]);
    expect((await failureOf(restBody(array))).issues).toEqual([
      { pointer: "/content", code: "INVALID_FORMAT" },
    ]);
    expect((await failureOf(restBody(unknown))).issues).toEqual([
      { pointer: "/content", code: "UNKNOWN_FIELD" },
    ]);
    expect((await failureOf(restBody(big))).issues).toEqual([
      { pointer: "/content", code: "TOO_LARGE" },
    ]);
    expect((await failureOf(restBody(noText))).issues).toEqual([
      { pointer: "/content", code: "REQUIRED" },
    ]);
    expect((await failureOf(restBody(attachments))).reason).toBe(
      "ATTACHMENTS_NOT_SUPPORTED",
    );
  });

  it("서명과 암호화를 함께 쓰는 파일은 서명 검증 뒤 복호화한다", async () => {
    const content = await encryptContent(key1, { content: secret });

    const result = await openRequest(
      signed({
        version: 1,
        idempotencyKey: "outbox-7",
        to: ["kim@example.com"],
        content,
      }),
      makeCtx(),
    );

    expect(result).toMatchObject({
      ok: true,
      signed: true,
      encrypted: true,
      idempotencyKey: "outbox-7",
      request: { subject: "주문 접수 안내", from: null },
    });
  });

  it("같은 내용의 평문 요청과 JWE 요청은 같은 지문을 낸다(ADR-0005 결정 3, 같은 Key 재요청 200)", async () => {
    const encrypted = await encryptContent(key1, { content: secret });
    const another = await encryptContent(key1, { content: secret });
    const ctx = makeCtx();

    const plain = await openRequest({ kind: "rest", body: MAIL }, ctx);
    const viaJwe = await openRequest(restBody(encrypted), ctx);
    const viaJweAgain = await openRequest(restBody(another), ctx);

    if (!plain.ok || !viaJwe.ok || !viaJweAgain.ok)
      throw new Error("성공해야 한다");
    expect(encrypted).not.toBe(another); // 암호문은 매번 다르다
    expect(viaJwe.fingerprint.canonicalRequest).toBe(
      plain.fingerprint.canonicalRequest,
    );
    expect(Buffer.from(viaJwe.fingerprint.digest).toString("hex")).toBe(
      Buffer.from(plain.fingerprint.digest).toString("hex"),
    );
    expect(viaJweAgain.fingerprint.canonicalRequest).toBe(
      plain.fingerprint.canonicalRequest,
    );
  });

  it("제목이 다르면 지문이 다르다", async () => {
    const other = await encryptContent(key1, {
      content: { ...secret, subject: "다른 제목" },
    });
    const ctx = makeCtx();

    const a = await openRequest({ kind: "rest", body: MAIL }, ctx);
    const b = await openRequest(restBody(other), ctx);

    if (!a.ok || !b.ok) throw new Error("성공해야 한다");
    expect(b.fingerprint.canonicalRequest).not.toBe(
      a.fingerprint.canonicalRequest,
    );
  });
});

describe("openRequest: 파이프라인 순서 (ADR-0008 결정 3)", () => {
  function spies(): {
    decryptor: JweDecryptor;
    decrypt: jest.Mock<JweDecryptor["decrypt"]>;
    fingerprinter: QueueFingerprinter;
    fingerprint: jest.Mock<QueueFingerprinter["fingerprint"]>;
  } {
    const real = createJweDecryptor(
      createPrivateKeyRing([
        { kid: "mailo-1", privateKey: key1.privateKey, retiredAt: null },
      ]),
    );
    const decrypt = jest.fn<JweDecryptor["decrypt"]>((c, caller) =>
      real.decrypt(c, caller),
    );
    const fingerprint = jest.fn<QueueFingerprinter["fingerprint"]>((c, v) =>
      fingerprinter.fingerprint(c, v),
    );
    return {
      decryptor: { decrypt },
      decrypt,
      fingerprinter: { fingerprint },
      fingerprint,
    };
  }

  async function encryptedPayload(): Promise<Record<string, unknown>> {
    return {
      version: 1,
      idempotencyKey: "outbox-1",
      to: ["kim@example.com"],
      content: await encryptContent(key1, {
        content: { subject: MAIL.subject, text: MAIL.text },
      }),
    };
  }

  it("서명 검증에 실패하면 복호화를 시도하지 않는다", async () => {
    const s = spies();
    const ctx = makeCtx({
      decryptor: s.decryptor,
      fingerprinter: s.fingerprinter,
    });
    const payload = await encryptedPayload();
    const jws = signJws({ secret: SECRET_ALPHA, payload, nowMs: NOW });
    const inputs: OpenRequestInput[] = [
      // 서명 변조
      {
        kind: "file",
        bytes: asBytes({
          ...jws,
          payload: b64url(
            JSON.stringify({ ...payload, to: ["evil@example.com"] }),
          ),
        }),
      },
      // alg none
      signed(payload, { header: { alg: "none" } }),
      // 다른 키
      signed(payload, { secret: SECRET_OTHER }),
      // caller 불일치·iat 만료(서명은 유효)
      signed(payload, { caller: "beta" }),
      signed(payload, { iat: NOW / 1000 - 8 * DAY }),
      // 서명 없는 파일
      { kind: "file", bytes: asBytes(payload) },
    ];

    for (const input of inputs)
      expect((await openRequest(input, ctx)).ok).toBe(false);

    expect(s.decrypt).not.toHaveBeenCalled();
    expect(s.fingerprint).not.toHaveBeenCalled();
  });

  it("스키마 검증에 실패하면 복호화하지 않는다", async () => {
    const s = spies();
    const ctx = makeCtx({
      decryptor: s.decryptor,
      fingerprinter: s.fingerprinter,
    });
    const payload = { ...(await encryptedPayload()), to: [] };

    const failure = await failureOf(signed(payload), ctx);

    expect(failure.reason).toBe("VALIDATION_FAILED");
    expect(s.decrypt).not.toHaveBeenCalled();
  });

  it("서명과 스키마를 통과하면 복호화를 한 번 하고, 복호화한 제목 검증이 실패하면 지문을 계산하지 않는다", async () => {
    const s = spies();
    const ctx = makeCtx({
      decryptor: s.decryptor,
      fingerprinter: s.fingerprinter,
    });
    const bad = await encryptContent(key1, {
      content: { subject: "a\r\nb", text: MAIL.text },
    });

    const failure = await failureOf(
      signed({ ...(await encryptedPayload()), content: bad }),
      ctx,
    );

    expect(failure.reason).toBe("VALIDATION_FAILED");
    expect(s.decrypt).toHaveBeenCalledTimes(1);
    expect(s.fingerprint).not.toHaveBeenCalled();
  });

  it("성공하면 복호화 1회, 지문 계산 1회다", async () => {
    const s = spies();
    const ctx = makeCtx({
      decryptor: s.decryptor,
      fingerprinter: s.fingerprinter,
    });

    const result = await openRequest(signed(await encryptedPayload()), ctx);

    expect(result.ok).toBe(true);
    expect(s.decrypt).toHaveBeenCalledTimes(1);
    expect(s.decrypt).toHaveBeenCalledWith(expect.any(String), "alpha");
    expect(s.fingerprint).toHaveBeenCalledTimes(1);
  });

  it("복호화 실패 시 지문을 계산하지 않는다", async () => {
    const s = spies();
    const ctx = makeCtx({
      decryptor: s.decryptor,
      fingerprinter: s.fingerprinter,
    });
    const payload = await encryptedPayload();
    const content = replaceJweSegment(
      payload["content"] as string,
      3,
      (x) => `${x}A`,
    );

    const failure = await failureOf(signed({ ...payload, content }), ctx);

    expect(failure.reason).toBe("DECRYPTION_FAILED");
    expect(s.fingerprint).not.toHaveBeenCalled();
  });
});

describe("openRequest: 거부 사유에 값이 없다 (RQ-027)", () => {
  it("canary를 넣은 제목·본문·키가 어떤 실패 결과에도 나오지 않는다", async () => {
    const secretWithCanary = {
      subject: `${CANARY.subject}\r\n`,
      text: CANARY.text,
    };
    const good = await encryptContent(key1, { content: secretWithCanary });
    const tampered = replaceJweSegment(good, 3, (x) => `${x}A`);
    const wrongCaller = await encryptContent(key1, {
      caller: "beta",
      content: secretWithCanary,
    });
    const unknown = await encryptContent(unknownKey, {
      content: secretWithCanary,
    });
    const rest = (
      content: string,
      to = ["kim@example.com"],
    ): OpenRequestInput => ({
      kind: "rest",
      body: { to, content },
    });

    const failures = await Promise.all([
      failureOf(rest(good)), // 복호화한 제목의 CR/LF
      failureOf(rest(tampered)),
      failureOf(rest(wrongCaller)),
      failureOf(rest(unknown)),
      failureOf({
        kind: "rest",
        body: {
          to: ["kim@example.com"],
          subject: CANARY.subject,
          [CANARY.text]: 1,
        },
      }),
      failureOf(
        signed(
          { ...fileRequest(), subject: CANARY.subject },
          { caller: "beta" },
        ),
      ),
    ]);

    for (const failure of failures) {
      const text = JSON.stringify(failure);
      expect(text).not.toContain("CANARY");
      expect(text).not.toContain("example.com");
      expect(Object.keys(failure).sort()).toEqual(
        expect.arrayContaining(["ok", "reason"]),
      );
    }
  });
});
