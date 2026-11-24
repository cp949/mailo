import { describe, expect, it } from "@jest/globals";
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parseCallerRegistry } from "../../src/callers/index.js";
import {
  ConfigError,
  Secret,
  isPublicOrWeakKey,
} from "../../src/config/index.js";
import {
  createKeyRing,
  createQueueFingerprinter,
  hashApiKey,
} from "../../src/crypto/index.js";
import {
  OPEN_REQUEST_REASONS,
  PUBLIC_SAMPLE_JWE_KEY_SPKI_SHA256,
  createJweDecryptor,
  createPrivateKeyRing,
  openRequest,
  parseEnvelopeKeys,
  toRejectionReason,
  type JwsKey,
  type OpenRequestContext,
  type OpenRequestResult,
  type PrivateKeyEntry,
} from "../../src/envelope/index.js";
import { presentOpenFailure } from "../../src/intake/index.js";
import { DEFAULT_MAIL_REQUEST_LIMITS } from "../../src/validation/index.js";

// RQ-064·065, ADR-0014 결정 1~5: `docs/api/conformance/vectors.json`의 모든 케이스를 서버의 `openRequest`에 넣어
// 호출처가 관측하는 판정(파일 `reasonCode`, REST `errors`)이 같은지 확인한다. DB와 파일 시스템이 필요 없다.
// 기대값은 벡터 파일에서만 읽는다. 서버 출력에서 가져온 값을 기대로 쓰지 않는다.
// 실패 메시지에는 케이스 id와 사유 코드·위치만 담는다(요청 값은 담지 않는다, RQ-027).

interface JweKeyVector {
  kid: string;
  role: "current" | "previous";
  privateKeyPem: string;
  publicKeyPem: string;
}

interface JwsKeyVector {
  callerId: string;
  kid: string;
  secretBase64: string;
}

interface PlainRequest {
  from: string | null;
  replyTo: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string | null;
  html: string | null;
}

interface Expectation {
  accepted: boolean;
  request?: PlainRequest;
  signed?: boolean;
  encrypted?: boolean;
  reasonCode?: string;
  errors?: { pointer: string; code: string }[];
  internalReason?: string;
}

interface VectorCase {
  id: string;
  title: string;
  channel: "file" | "rest";
  callerId: string;
  signatureMode: "required" | "none";
  nowEpochSeconds: number;
  input: { fileText?: string; body?: unknown };
  jws?: { signingInput: string; signature: string; hmacKid: string | null };
  expect: Expectation;
}

interface Vectors {
  schemaVersion: number;
  profile: unknown;
  settings: { iat: { maxAgeSeconds: number; skewSeconds: number } };
  keys: { jwe: JweKeyVector[]; jws: JwsKeyVector[] };
  cases: VectorCase[];
}

const VECTORS_URL = new URL(
  "../../../../docs/api/conformance/vectors.json",
  import.meta.url,
);
const README_URL = new URL("README.md", VECTORS_URL);
const vectorsText = readFileSync(VECTORS_URL, "utf8");
const vectors = JSON.parse(vectorsText) as Vectors;

const DAY = 86_400;
/** 벡터 케이스에 `ttlSeconds`는 없다. `openRequest`가 요구하는 상한만 채운다. */
const MAX_TTL_SECONDS = 7 * DAY;

/** 판정과 무관한 지문 계산용 키. 벡터에는 지문이 없다(ADR-0014 결정 1). */
const fingerprinter = createQueueFingerprinter(
  createKeyRing({
    currentVersion: 1,
    keys: new Map([[1, Buffer.alloc(32, 5)]]),
  }),
);

function privateEntries(): PrivateKeyEntry[] {
  return vectors.keys.jwe.map((key) => ({
    kid: key.kid,
    privateKey: createPrivateKey(key.privateKeyPem),
    retiredAt: key.role === "previous" ? new Date(0) : null,
  }));
}

function jwsKeysOf(callerId: string): JwsKey[] {
  return vectors.keys.jws
    .filter((key) => key.callerId === callerId)
    .map((key) => ({
      kid: key.kid,
      secret: new Secret<Uint8Array>(Buffer.from(key.secretBase64, "base64")),
    }));
}

function contextOf(vector: VectorCase): OpenRequestContext {
  return {
    callerId: vector.callerId,
    signature:
      vector.signatureMode === "required"
        ? { mode: "required", keys: jwsKeysOf(vector.callerId) }
        : { mode: "none", keys: [] },
    limits: DEFAULT_MAIL_REQUEST_LIMITS,
    decryptor: createJweDecryptor(createPrivateKeyRing(privateEntries())),
    fingerprinter,
    iat: vectors.settings.iat,
    maxTtlSeconds: MAX_TTL_SECONDS,
    nowMs: () => vector.nowEpochSeconds * 1000,
  };
}

async function open(vector: VectorCase): Promise<OpenRequestResult> {
  const context = contextOf(vector);
  if (vector.channel === "file")
    return openRequest(
      { kind: "file", bytes: Buffer.from(vector.input.fileText ?? "", "utf8") },
      context,
    );
  return openRequest({ kind: "rest", body: vector.input.body }, context);
}

const errorsText = (
  errors: readonly { pointer?: string; code: string }[],
): string => errors.map((e) => `${e.pointer ?? ""}|${e.code}`).join(",");

/** 벡터가 적은 기대를 한 줄로 쓴다. 요청 값은 담지 않는다. */
function expectedVerdict(vector: VectorCase): string {
  const expected = vector.expect;
  if (expected.accepted)
    return `수락 signed=${expected.signed} encrypted=${expected.encrypted}`;
  const detail =
    vector.channel === "file"
      ? `reasonCode=${expected.reasonCode}`
      : `errors=${errorsText(expected.errors ?? [])}`;
  return `거부 ${detail} internal=${expected.internalReason}`;
}

/** 서버가 낸 판정을 같은 형식의 한 줄로 쓴다. */
function actualVerdict(vector: VectorCase, result: OpenRequestResult): string {
  if (result.ok) {
    if (!isDeepStrictEqual(result.request, vector.expect.request))
      return "수락(평문 필드 불일치)";
    return `수락 signed=${result.signed} encrypted=${result.encrypted}`;
  }
  const detail =
    vector.channel === "file"
      ? `reasonCode=${toRejectionReason(result.reason)}`
      : `errors=${errorsText(presentOpenFailure(result))}`;
  return `거부 ${detail} internal=${result.reason}`;
}

describe("적합성 벡터 파일 형식 (RQ-064, ADR-0014 결정 2)", () => {
  it("최상위 필드와 profile·settings가 계약대로다", () => {
    expect(vectors.schemaVersion).toBe(1);
    expect(vectors.profile).toEqual({
      jws: { alg: "HS256" },
      jwe: { alg: "RSA-OAEP-256", enc: "A256GCM", rsaModulusBits: 3072 },
    });
    expect(vectors.settings).toEqual({
      iat: { maxAgeSeconds: 604_800, skewSeconds: 300 },
    });
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  it("케이스 id는 kebab-case이고 겹치지 않는다", () => {
    const ids = vectors.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("모든 케이스가 필수 필드와 채널에 맞는 입력을 갖는다", () => {
    for (const c of vectors.cases) {
      expect(typeof c.title).toBe("string");
      expect(c.title.length).toBeGreaterThan(0);
      expect(["file", "rest"]).toContain(c.channel);
      expect(["required", "none"]).toContain(c.signatureMode);
      expect(Number.isInteger(c.nowEpochSeconds)).toBe(true);
      if (c.channel === "file") {
        expect(typeof c.input.fileText).toBe("string");
      } else {
        // REST는 서명을 쓰지 않는다(ADR-0008 결정 2).
        expect(c.signatureMode).toBe("none");
        expect(c.input.body).toBeDefined();
      }
      if (c.expect.accepted) {
        expect(c.expect.request).toBeDefined();
      } else if (c.channel === "file") {
        expect(typeof c.expect.reasonCode).toBe("string");
      } else {
        expect(Array.isArray(c.expect.errors)).toBe(true);
      }
    }
  });

  it("벡터 README가 모든 케이스 id를 목록에 적고 공개 가짜 키임을 밝힌다", () => {
    const readme = readFileSync(README_URL, "utf8");
    const missing = vectors.cases
      .map((c) => c.id)
      .filter((id) => !readme.includes(`\`${id}\``));
    expect(missing).toEqual([]);
    expect(readme).toContain("공개 가짜");
    expect(readme).toContain("실제 운영 키가 아니다");
  });

  it("벡터 JSON에 fingerprint 필드가 없다(ADR-0014 결정 1)", () => {
    const names: string[] = [];
    JSON.parse(vectorsText, function (this: unknown, name: string, value) {
      names.push(name);
      return value;
    });
    expect(names.filter((n) => /fingerprint/i.test(n))).toEqual([]);
  });
});

describe("적합성 벡터의 서버 판정 (RQ-064, ADR-0014 결정 5)", () => {
  it.each(vectors.cases.map((c) => [c.id, c] as const))(
    "케이스 %s는 호출처가 관측하는 판정이 기대와 같다",
    async (_id, vector) => {
      const result = await open(vector);
      expect(`${vector.id}: ${actualVerdict(vector, result)}`).toBe(
        `${vector.id}: ${expectedVerdict(vector)}`,
      );
    },
  );

  it("OPEN_REQUEST_REASONS 11종이 모두 한 케이스 이상의 internalReason으로 나온다", () => {
    const covered = new Set(
      vectors.cases.map((c) => c.expect.internalReason).filter(Boolean),
    );
    expect(OPEN_REQUEST_REASONS.filter((r) => !covered.has(r))).toEqual([]);
  });

  it("파일 채널의 reasonCode 9종이 모두 나온다", () => {
    const covered = new Set(
      vectors.cases
        .filter((c) => c.channel === "file")
        .map((c) => c.expect.reasonCode)
        .filter(Boolean),
    );
    const expected = new Set(OPEN_REQUEST_REASONS.map(toRejectionReason));
    expect(expected.size).toBe(9);
    expect([...expected].filter((r) => !covered.has(r))).toEqual([]);
    expect([...covered].filter((r) => !expected.has(r as never))).toEqual([]);
  });

  it("REST 거부 케이스는 서명·iat 사유를 내지 않는다(REST는 서명을 쓰지 않는다)", () => {
    const rest = vectors.cases.filter((c) => c.channel === "rest");
    const reasons = new Set(rest.map((c) => c.expect.internalReason));
    for (const reason of [
      "MALFORMED",
      "SIGNATURE_REQUIRED",
      "SIGNATURE_INVALID",
      "IAT_OUT_OF_RANGE",
      "IDEMPOTENCY_KEY_MISSING",
      "IDEMPOTENCY_KEY_INVALID",
    ])
      expect(reasons.has(reason)).toBe(false);
  });
});

describe("적합성 벡터의 JWS 서명 입력 (RQ-064, ADR-0014 결정 2)", () => {
  const signed = vectors.cases.filter((c) => c.jws !== undefined);

  it("서명 케이스가 한 개 이상 있다", () => {
    expect(signed.length).toBeGreaterThan(0);
  });

  it.each(signed.map((c) => [c.id, c] as const))(
    "케이스 %s의 signingInput과 signature가 파일 내용과 HMAC-SHA256 계산에 맞는다",
    (_id, vector) => {
      const jws = vector.jws!;
      const top = JSON.parse(vector.input.fileText ?? "") as {
        protected?: string;
        payload?: string;
        signature?: string;
      };
      expect(`${top.protected}.${top.payload}`).toBe(jws.signingInput);
      expect(top.signature).toBe(jws.signature);

      // 서버와 jose를 거치지 않고 node:crypto로 직접 계산한다. 호출처가 openssl로 하는 확인과 같다.
      const hmacOf = (key: JwsKeyVector): string =>
        createHmac("sha256", Buffer.from(key.secretBase64, "base64"))
          .update(jws.signingInput)
          .digest("base64url");
      if (jws.hmacKid === null) {
        // 어느 벡터 키로도 만들 수 없는 서명(alg none, 변조 등)이다.
        expect(
          vectors.keys.jws.filter((k) => hmacOf(k) === jws.signature),
        ).toEqual([]);
      } else {
        const holder = vectors.keys.jws.find((k) => k.kid === jws.hmacKid);
        expect(holder).toBeDefined();
        expect(hmacOf(holder!)).toBe(jws.signature);
      }
    },
  );
});

describe("벡터 키는 공개 가짜 키다 (RQ-065, ADR-0014 결정 3)", () => {
  it("JWE 키 쌍은 둘이고 공개키가 개인키와 짝이며 RSA 3072다", () => {
    expect(vectors.keys.jwe.map((k) => k.kid)).toEqual([
      "conformance-1",
      "conformance-2",
    ]);
    for (const key of vectors.keys.jwe) {
      const privateKey = createPrivateKey(key.privateKeyPem);
      expect(privateKey.asymmetricKeyType).toBe("rsa");
      expect(privateKey.asymmetricKeyDetails?.modulusLength).toBe(3072);
      const derived = createPublicKey(privateKey).export({
        type: "spki",
        format: "der",
      });
      const published = createPublicKey(key.publicKeyPem).export({
        type: "spki",
        format: "der",
      });
      expect(Buffer.compare(derived, published)).toBe(0);
    }
  });

  it("벡터 공개키의 SHA-256이 서버의 공개 샘플 JWE 키 상수와 같다", () => {
    const hashes = vectors.keys.jwe.map((key) =>
      createHash("sha256")
        .update(
          createPublicKey(key.publicKeyPem).export({
            type: "spki",
            format: "der",
          }),
        )
        .digest("hex"),
    );
    expect(hashes.sort()).toEqual(
      [...PUBLIC_SAMPLE_JWE_KEY_SPKI_SHA256].sort(),
    );
  });

  it("JWS 비밀키 셋(호출처 둘, 한 호출처에 kid 둘)은 32바이트이고 공개 샘플 키로 판정된다", () => {
    expect(
      vectors.keys.jws.map((k) => `${k.callerId}/${k.kid}`).sort(),
    ).toEqual(["alpha/alpha-1", "alpha/alpha-2", "beta/beta-1"]);
    for (const key of vectors.keys.jws) {
      const bytes = Buffer.from(key.secretBase64, "base64");
      expect(bytes.length).toBe(32);
      expect(isPublicOrWeakKey(bytes)).toBe(true);
      // 반복 바이트 규칙이 아니라 공개 샘플 목록으로 걸리는지 본다.
      expect(bytes.every((byte) => byte === bytes[0])).toBe(false);
    }
  });

  describe("production에서 기동을 거부한다", () => {
    const jweKeysJson = (): Record<string, unknown> => ({
      keys: vectors.keys.jwe.map((key, index) => ({
        kid: key.kid,
        privateKeyVar: `MAILO_JWE_KEY_CONFORMANCE_${index + 1}`,
        ...(key.role === "previous"
          ? { retiredAt: "2026-11-01T00:00:00Z" }
          : {}),
      })),
    });
    const jweEnv = (node?: string): NodeJS.ProcessEnv => ({
      ...(node === undefined ? {} : { NODE_ENV: node }),
      ...Object.fromEntries(
        vectors.keys.jwe.map((key, index) => [
          `MAILO_JWE_KEY_CONFORMANCE_${index + 1}`,
          key.privateKeyPem,
        ]),
      ),
    });

    it.each([[undefined], ["production"], ["staging"]])(
      "NODE_ENV=%s이면 Mailo JWE 개인키 거부 오류가 나고 오류에 키 값과 kid가 없다",
      (node) => {
        let message = "";
        try {
          parseEnvelopeKeys(jweKeysJson(), {
            env: jweEnv(node),
            retentionSeconds: 30 * DAY,
          });
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          message = (error as Error).message;
        }
        expect(message).toContain("envelope keys[0]");
        expect(message).toContain("envelope keys[1]");
        expect(message).toContain("production에서 쓸 수 없다");
        for (const key of vectors.keys.jwe) {
          expect(message).not.toContain(key.kid);
          expect(message).not.toContain("BEGIN");
          expect(message).not.toContain(
            key.privateKeyPem.split("\n")[1] as string,
          );
        }
      },
    );

    it.each([["development"], ["test"]])(
      "NODE_ENV=%s이면 같은 키를 허용한다",
      (node) => {
        const entries = parseEnvelopeKeys(jweKeysJson(), {
          env: jweEnv(node),
          retentionSeconds: 30 * DAY,
        });
        expect(entries.map((e) => e.kid)).toEqual([
          "conformance-1",
          "conformance-2",
        ]);
      },
    );

    it("`kid` 이름만 같고 키가 다르면 거부하지 않는다(이름은 신뢰 근거가 아니다)", () => {
      const other = generateKeyPairSync("rsa", { modulusLength: 3072 });
      const entries = parseEnvelopeKeys(
        { keys: [{ kid: "conformance-1", privateKeyVar: "MAILO_JWE_KEY_X" }] },
        {
          env: {
            MAILO_JWE_KEY_X: other.privateKey
              .export({ type: "pkcs8", format: "pem" })
              .toString(),
          },
          retentionSeconds: 30 * DAY,
        },
      );
      expect(entries.map((e) => e.kid)).toEqual(["conformance-1"]);
    });

    const registryJson = (): Record<string, unknown> => ({
      callers: ["alpha", "beta"].map((id) => ({
        id,
        apiKeyHashes: [hashApiKey(`fake-key-${id}-`.padEnd(42, "0"))],
        signature: {
          mode: "required",
          keys: vectors.keys.jws
            .filter((k) => k.callerId === id)
            .map((k) => ({
              kid: k.kid,
              secretVar: `MAILO_JWS_SECRET_${k.kid.toUpperCase().replace("-", "_")}`,
            })),
        },
      })),
    });
    const registryEnv = (node: string | undefined): NodeJS.ProcessEnv => ({
      ...(node === undefined ? {} : { NODE_ENV: node }),
      ...Object.fromEntries(
        vectors.keys.jws.map((k) => [
          `MAILO_JWS_SECRET_${k.kid.toUpperCase().replace("-", "_")}`,
          k.secretBase64,
        ]),
      ),
    });

    it.each([[undefined], ["production"]])(
      "NODE_ENV=%s이면 호출처 JWS 비밀키 셋을 레지스트리가 거부하고 오류에 키 값이 없다",
      (node) => {
        let message = "";
        try {
          parseCallerRegistry(registryJson(), { env: registryEnv(node) });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain("production에서 쓸 수 없다");
        for (const key of vectors.keys.jws) {
          expect(message).not.toContain(key.secretBase64);
          expect(message).not.toContain(
            Buffer.from(key.secretBase64, "base64").toString("utf8"),
          );
        }
      },
    );

    it("development에서는 같은 비밀키 셋을 허용한다", () => {
      expect(() =>
        parseCallerRegistry(registryJson(), {
          env: registryEnv("development"),
        }),
      ).not.toThrow();
    });
  });

  it("벡터에는 예약 도메인 밖의 주소가 없다(JWS payload 포함)", () => {
    const texts = [vectorsText];
    for (const c of vectors.cases) {
      if (c.input.fileText === undefined) continue;
      try {
        const top = JSON.parse(c.input.fileText) as { payload?: unknown };
        if (typeof top.payload === "string")
          texts.push(Buffer.from(top.payload, "base64url").toString("utf8"));
      } catch {
        // JSON이 아닌 입력은 원문 검사로 충분하다.
      }
    }
    const domains = new Set<string>();
    for (const text of texts)
      for (const match of text.matchAll(/[\w.+-]+@([A-Za-z0-9.-]+\.[a-z]+)/g))
        domains.add(match[1]!.toLowerCase());
    expect(
      [...domains].filter(
        (d) => !["example.com", "example.org", "example.net"].includes(d),
      ),
    ).toEqual([]);
  });

  it("벡터 파일에 PEM 개인키는 선언한 JWE 키 쌍 둘뿐이다", () => {
    expect(vectorsText.match(/BEGIN PRIVATE KEY/g)?.length).toBe(2);
    expect(vectorsText).not.toMatch(/BEGIN (RSA|EC|ENCRYPTED) PRIVATE KEY/);
  });
});
