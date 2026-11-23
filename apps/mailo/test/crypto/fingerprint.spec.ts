import { randomBytes } from "node:crypto";
import { describe, expect, it } from "@jest/globals";
import { createKeyRing } from "../../src/crypto/key-ring.js";
import {
  FingerprintError,
  canonicalizeFingerprintInput,
  createFingerprinter,
  type FingerprintInput,
} from "../../src/crypto/fingerprint.js";

const base: FingerprintInput = {
  from: "noreply@example.com",
  replyTo: "help@example.com",
  to: ["a@example.com", "b@example.com"],
  cc: ["c@example.com"],
  bcc: [],
  subject: "안녕하세요",
  text: "본문",
  html: "<p>본문</p>",
};

const fp = () =>
  createFingerprinter(
    createKeyRing({ currentVersion: 1, keys: new Map([[1, randomBytes(32)]]) }),
  );

describe("Fingerprinter 정규화 (ADR-0005 결정 3, RQ-011)", () => {
  const f = fp();
  const hash = (input: FingerprintInput) => f.compute(input).fingerprint;

  it("지문은 64자 소문자 hex이고 키 버전을 함께 돌려준다", () => {
    const r = f.compute(base);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.keyVersion).toBe(1);
  });

  it("같은 입력은 같은 지문이다", () => {
    expect(hash(base)).toBe(hash({ ...base }));
  });

  it("수신자 순서와 중복은 지문에 영향이 없다", () => {
    expect(
      hash({
        ...base,
        to: ["b@example.com", "a@example.com", "a@example.com"],
      }),
    ).toBe(hash(base));
  });

  it("도메인 대소문자와 앞뒤 공백은 같고 로컬 파트 대소문자는 다르다", () => {
    expect(hash({ ...base, to: [" a@EXAMPLE.com ", "b@example.com"] })).toBe(
      hash(base),
    );
    expect(hash({ ...base, to: ["A@example.com", "b@example.com"] })).not.toBe(
      hash(base),
    );
  });

  it("생략과 빈 목록, undefined와 null은 같다", () => {
    const { bcc: _bcc, ...withoutBcc } = base;
    expect(hash(withoutBcc)).toBe(hash(base));
    expect(hash({ ...base, replyTo: undefined })).toBe(
      hash({ ...base, replyTo: null }),
    );
    expect(hash({ ...base, html: undefined })).toBe(
      hash({ ...base, html: null }),
    );
  });

  it("빈 문자열 본문은 null과 다르다", () => {
    expect(hash({ ...base, html: "" })).not.toBe(hash({ ...base, html: null }));
  });

  it.each([
    ["cc만 다름", { cc: ["x@example.com"] }],
    ["bcc 추가", { bcc: ["z@example.com"] }],
    ["from만 다름", { from: "other@example.com" }],
    ["replyTo만 다름", { replyTo: "x@example.com" }],
    ["제목 대소문자", { subject: "안녕하세요 " }],
    ["text 다름", { text: "본문!" }],
    ["html 다름", { html: "<p>본문2</p>" }],
    ["정책 필드 추가", { policy: { ttlSeconds: 60 } }],
  ] as const)("%s이면 다른 요청이다", (_name, patch) => {
    expect(hash({ ...base, ...(patch as Partial<FingerprintInput>) })).not.toBe(
      hash(base),
    );
  });

  it("to와 cc에 같은 주소를 옮기면 다른 요청이다 (목록 사이는 합치지 않는다)", () => {
    const a = { ...base, to: ["a@example.com"], cc: ["b@example.com"] };
    const b = { ...base, to: ["b@example.com"], cc: ["a@example.com"] };
    expect(hash(a)).not.toBe(hash(b));
  });

  it("필드 경계를 옮긴 값은 구분된다 (제목과 text)", () => {
    expect(hash({ ...base, subject: "ab", text: "c" })).not.toBe(
      hash({ ...base, subject: "a", text: "bc" }),
    );
  });

  it("정책 필드는 키 순서와 undefined 값에 영향받지 않는다", () => {
    const a = hash({ ...base, policy: { b: 1, a: "x", c: undefined } });
    const b = hash({ ...base, policy: { a: "x", b: 1 } });
    expect(a).toBe(b);
  });

  it("정책 필드의 NaN은 거부한다", () => {
    expect(() => hash({ ...base, policy: { n: Number.NaN } })).toThrow(
      FingerprintError,
    );
  });

  it("정규화 문자열은 고정 필드 순서의 JSON이다", () => {
    expect(JSON.parse(canonicalizeFingerprintInput(base))).toEqual([
      "mailo-fp-v1",
      "noreply@example.com",
      "help@example.com",
      ["a@example.com", "b@example.com"],
      ["c@example.com"],
      [],
      "안녕하세요",
      "본문",
      "<p>본문</p>",
      [],
    ]);
  });
});

describe("Fingerprinter 키 버전 (ADR-0005 결정 3)", () => {
  it("키를 교체한 뒤에도 이전 버전 지문으로 정상 재시도를 같은 내용으로 판정한다", () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const stored = createFingerprinter(
      createKeyRing({ currentVersion: 1, keys: new Map([[1, k1]]) }),
    ).compute(base);

    const rotated = createFingerprinter(
      createKeyRing({
        currentVersion: 2,
        keys: new Map([
          [1, k1],
          [2, k2],
        ]),
      }),
    );
    expect(rotated.matches(base, stored)).toBe(true);
    expect(rotated.matches({ ...base, cc: [] }, stored)).toBe(false);
    expect(rotated.compute(base).keyVersion).toBe(2);
    expect(rotated.compute(base).fingerprint).not.toBe(stored.fingerprint);
  });

  it("저장된 키 버전의 키가 없으면 false가 아니라 오류다", () => {
    const f = createFingerprinter(
      createKeyRing({
        currentVersion: 2,
        keys: new Map([[2, randomBytes(32)]]),
      }),
    );
    expect(() =>
      f.matches(base, { fingerprint: "0".repeat(64), keyVersion: 1 }),
    ).toThrow("UNKNOWN_KEY_VERSION");
  });

  it("저장된 지문 형식이 이상해도 예외 없이 불일치로 판정한다", () => {
    expect(fp().matches(base, { fingerprint: "short", keyVersion: 1 })).toBe(
      false,
    );
  });

  it("지문 키가 다르면 같은 입력도 지문이 다르다 (본문 키와 분리된 비밀)", () => {
    expect(fp().compute(base).fingerprint).not.toBe(
      fp().compute(base).fingerprint,
    );
  });

  it("지문과 오류에 본문 canary가 나오지 않는다", () => {
    const f = fp();
    const input = { ...base, text: "CANARY-본문", subject: "CANARY-제목" };
    expect(JSON.stringify(f.compute(input))).not.toContain("CANARY");
    try {
      f.matches(input, { fingerprint: "0".repeat(64), keyVersion: 9 });
    } catch (e) {
      expect(`${(e as Error).message}${(e as Error).stack}`).not.toContain(
        "CANARY",
      );
    }
  });
});
