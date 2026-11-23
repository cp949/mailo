import { randomBytes } from "node:crypto";
import { describe, expect, it } from "@jest/globals";
import {
  BodyCipherError,
  createBodyCipher,
} from "../../src/crypto/body-cipher.js";
import { KeyRingError, createKeyRing } from "../../src/crypto/key-ring.js";

const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";
const CANARY = "CANARY-본문-9f3a";

const key = () => randomBytes(32);
const ring = (current: number, versions: number[]) =>
  createKeyRing({
    currentVersion: current,
    keys: new Map(versions.map((v) => [v, key()])),
  });

const content = {
  subject: `제목 ${CANARY}`,
  text: `텍스트 ${CANARY}`,
  html: `<p>${CANARY}</p>`,
};

describe("BodyCipher: AES-256-GCM (ADR-0008 결정 6, RQ-023)", () => {
  it("암호화한 본문을 같은 job_id로 복호화하면 원문이 나온다", () => {
    const cipher = createBodyCipher(ring(1, [1]));
    const sealed = cipher.encrypt(JOB_A, content);
    expect(sealed.keyVersion).toBe(1);
    expect(cipher.decrypt(JOB_A, sealed)).toEqual(content);
  });

  it("text와 html이 null인 본문도 왕복한다", () => {
    const cipher = createBodyCipher(ring(1, [1]));
    const body = { subject: "s", text: null, html: "<b>x</b>" };
    expect(cipher.decrypt(JOB_A, cipher.encrypt(JOB_A, body))).toEqual(body);
  });

  it("저장 값(sealed)에 평문이 읽히지 않는다", () => {
    const sealed = createBodyCipher(ring(1, [1])).encrypt(
      JOB_A,
      content,
    ).sealed;
    expect(sealed.includes(Buffer.from(CANARY))).toBe(false);
    expect(sealed.toString("latin1")).not.toContain("CANARY");
  });

  it("nonce는 암호화마다 달라 같은 입력도 암호문이 다르다", () => {
    const cipher = createBodyCipher(ring(1, [1]));
    const a = cipher.encrypt(JOB_A, content).sealed;
    const b = cipher.encrypt(JOB_A, content).sealed;
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
    expect(a.equals(b)).toBe(false);
    expect(a.length).toBe(b.length);
  });

  it("nonce는 96비트(12바이트)다", () => {
    let requested = 0;
    const cipher = createBodyCipher(ring(1, [1]), (size) => {
      requested = size;
      return randomBytes(size);
    });
    cipher.encrypt(JOB_A, content);
    expect(requested).toBe(12);
  });

  it("다른 job_id(AAD)로 복호화하면 실패한다 (행 사이 바꿔치기 방지)", () => {
    const cipher = createBodyCipher(ring(1, [1]));
    const sealed = cipher.encrypt(JOB_A, content);
    expect(() => cipher.decrypt(JOB_B, sealed)).toThrow(BodyCipherError);
    try {
      cipher.decrypt(JOB_B, sealed);
    } catch (e) {
      expect((e as BodyCipherError).code).toBe("DECRYPT_FAILED");
    }
  });

  it("암호문 한 바이트를 바꾸면 복호화가 실패한다", () => {
    const cipher = createBodyCipher(ring(1, [1]));
    const sealed = cipher.encrypt(JOB_A, content);
    const tampered = Buffer.from(sealed.sealed);
    tampered[14] = (tampered[14]! ^ 0x01) & 0xff;
    expect(() =>
      cipher.decrypt(JOB_A, { ...sealed, sealed: tampered }),
    ).toThrow(BodyCipherError);
  });

  it("너무 짧은 sealed는 MALFORMED_SEALED다", () => {
    const cipher = createBodyCipher(ring(1, [1]));
    expect(() =>
      cipher.decrypt(JOB_A, { keyVersion: 1, sealed: Buffer.alloc(10) }),
    ).toThrow("MALFORMED_SEALED");
  });

  it("키 교체 뒤에도 이전 key_version 행이 복호화된다", () => {
    const k1 = key();
    const k2 = key();
    const before = createBodyCipher(
      createKeyRing({ currentVersion: 1, keys: new Map([[1, k1]]) }),
    );
    const old = before.encrypt(JOB_A, content);

    const after = createBodyCipher(
      createKeyRing({
        currentVersion: 2,
        keys: new Map([
          [1, k1],
          [2, k2],
        ]),
      }),
    );
    expect(after.decrypt(JOB_A, old)).toEqual(content);
    const fresh = after.encrypt(JOB_B, content);
    expect(fresh.keyVersion).toBe(2);
    expect(after.decrypt(JOB_B, fresh)).toEqual(content);
  });

  it("이전 키를 지우면 해당 버전 복호화가 UNKNOWN_KEY_VERSION으로 실패한다", () => {
    const k1 = key();
    const old = createBodyCipher(
      createKeyRing({ currentVersion: 1, keys: new Map([[1, k1]]) }),
    ).encrypt(JOB_A, content);
    const onlyNew = createBodyCipher(ring(2, [2]));
    expect(() => onlyNew.decrypt(JOB_A, old)).toThrow("UNKNOWN_KEY_VERSION");
  });

  it("같은 버전 번호라도 다른 키로는 복호화되지 않는다", () => {
    const sealed = createBodyCipher(ring(1, [1])).encrypt(JOB_A, content);
    expect(() => createBodyCipher(ring(1, [1])).decrypt(JOB_A, sealed)).toThrow(
      "DECRYPT_FAILED",
    );
  });

  it("빈 job_id는 거부한다", () => {
    expect(() => createBodyCipher(ring(1, [1])).encrypt("", content)).toThrow(
      "INVALID_JOB_ID",
    );
  });
});

describe("BodyCipher: 오류에 원문이 남지 않는다 (RQ-027)", () => {
  it("복호화 실패 오류에 본문·제목·키 canary가 없고 job_id와 사유 코드만 있다", () => {
    const keys = new Map([[1, Buffer.from("K".repeat(32))]]);
    const cipher = createBodyCipher(createKeyRing({ currentVersion: 1, keys }));
    const sealed = cipher.encrypt(JOB_A, content);
    let error: unknown;
    try {
      cipher.decrypt(JOB_B, sealed);
    } catch (e) {
      error = e;
    }
    const dump = `${(error as Error).message}\n${(error as Error).stack}\n${JSON.stringify(error)}`;
    expect(dump).not.toContain("CANARY");
    expect(dump).not.toContain("K".repeat(32));
    expect(dump).toContain("DECRYPT_FAILED");
    expect(dump).toContain(JOB_B);
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("KeyRing 검증", () => {
  it("32바이트가 아닌 키를 거부하고 오류에 키 바이트가 없다", () => {
    const bad = Buffer.from("CANARY-key-short");
    try {
      createKeyRing({ currentVersion: 1, keys: new Map([[1, bad]]) });
      throw new Error("예외가 나야 한다");
    } catch (e) {
      expect(e).toBeInstanceOf(KeyRingError);
      expect((e as Error).message).not.toContain("CANARY");
      expect((e as KeyRingError).code).toBe("INVALID_KEY_LENGTH");
    }
  });

  it("현재 버전 키가 없거나 버전이 잘못되면 거부한다", () => {
    expect(() =>
      createKeyRing({ currentVersion: 2, keys: new Map([[1, key()]]) }),
    ).toThrow("CURRENT_VERSION_MISSING");
    expect(() =>
      createKeyRing({ currentVersion: 0, keys: new Map([[0, key()]]) }),
    ).toThrow("INVALID_VERSION");
    expect(() => createKeyRing({ currentVersion: 1, keys: new Map() })).toThrow(
      "EMPTY",
    );
  });

  it("입력 버퍼를 나중에 바꿔도 키링은 영향받지 않는다", () => {
    const k = key();
    const original = Buffer.from(k);
    const kr = createKeyRing({ currentVersion: 1, keys: new Map([[1, k]]) });
    k.fill(0);
    expect(kr.getKey(1)!.equals(original)).toBe(true);
  });
});
