import { describe, expect, it } from "@jest/globals";
import {
  BodyCipherError,
  createBodyCipher,
  createFingerprinter,
  createKeyRing,
  createQueueBodyCipher,
  createQueueFingerprinter,
  canonicalizeFingerprintInput,
} from "../../src/crypto/index.js";

const bodyRing = createKeyRing({
  currentVersion: 1,
  keys: new Map([[1, Buffer.alloc(32, 5)]]),
});
const fpRing = createKeyRing({
  currentVersion: 2,
  keys: new Map([
    [1, Buffer.alloc(32, 6)],
    [2, Buffer.alloc(32, 7)],
  ]),
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");

describe("큐 어댑터 (ADR-0008 결정 6, ADR-0005 결정 3)", () => {
  it("본문 JSON 바이트를 봉인하고 nonce와 암호문으로 나눠 돌려주며, 복호화하면 v:1 JSON이 나온다", () => {
    const cipher = createQueueBodyCipher(createBodyCipher(bodyRing));

    const sealed = cipher.encrypt(
      "job-1",
      bytes({ subject: "제목", text: "본문", html: null }),
    );
    const plain = JSON.parse(
      Buffer.from(cipher.decrypt("job-1", sealed)).toString("utf8"),
    );

    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.ciphertext.length).toBeGreaterThan(16);
    expect(plain).toEqual({ v: 1, subject: "제목", text: "본문", html: null });
  });

  it("다른 jobId로는 복호화되지 않는다(AAD)", () => {
    const cipher = createQueueBodyCipher(createBodyCipher(bodyRing));
    const sealed = cipher.encrypt(
      "job-1",
      bytes({ subject: "s", text: "t", html: null }),
    );

    expect(() => cipher.decrypt("job-2", sealed)).toThrow(BodyCipherError);
  });

  it("모양이 틀린 본문은 MALFORMED_PLAINTEXT이고 오류에 원문이 없다", () => {
    const cipher = createQueueBodyCipher(createBodyCipher(bodyRing));

    let message = "";
    try {
      cipher.encrypt("job-1", bytes({ subject: 1, text: "CANARY-BODY" }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("MALFORMED_PLAINTEXT");
    expect(message).not.toContain("CANARY-BODY");
  });

  it("지문기는 구조화 지문기와 같은 값을 내고, 저장된 키 버전으로 다시 계산한다", () => {
    const input = {
      from: null,
      to: ["a@example.com"],
      subject: "s",
      text: "t",
    };
    const canonical = canonicalizeFingerprintInput(input);

    const adapter = createQueueFingerprinter(fpRing).fingerprint(canonical);
    const stored = createFingerprinter(fpRing).compute(input);
    const old = createQueueFingerprinter(fpRing).fingerprint(canonical, 1);

    expect(adapter.keyVersion).toBe(2);
    expect(Buffer.from(adapter.digest).toString("hex")).toBe(
      stored.fingerprint,
    );
    expect(old.keyVersion).toBe(1);
    expect(Buffer.from(old.digest).equals(Buffer.from(adapter.digest))).toBe(
      false,
    );
    expect(() =>
      createQueueFingerprinter(fpRing).fingerprint(canonical, 9),
    ).toThrow("UNKNOWN_KEY_VERSION");
  });

  it("from을 생략한 요청과 from을 명시한 요청은 다른 내용이다. 생략과 null은 같다", () => {
    const base = { to: ["a@example.com"], subject: "s", text: "t" };

    expect(canonicalizeFingerprintInput({ ...base })).toBe(
      canonicalizeFingerprintInput({ ...base, from: null }),
    );
    expect(canonicalizeFingerprintInput({ ...base })).not.toBe(
      canonicalizeFingerprintInput({ ...base, from: "no-reply@example.com" }),
    );
  });
});
