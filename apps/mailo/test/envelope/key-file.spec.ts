import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError } from "../../src/config/index.js";
import {
  PrivateKeyRingError,
  createPrivateKeyRing,
  loadEnvelopeKeyFile,
  parseEnvelopeKeys,
} from "../../src/envelope/index.js";
import { rsaKey } from "../support/envelope.js";

// RQ-022, ADR-0008 결정 1·5: Mailo 개인키 키링과 "이전 키는 교체 시각부터 Key 보존 기간 이상 보관" 검증.

const RETENTION = 30 * 86_400;
const current = rsaKey("mailo-2026-11");
const previous = rsaKey("mailo-2026-05");

function keysJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    keys: [
      { kid: "mailo-2026-11", privateKeyVar: "MAILO_JWE_KEY_A" },
      {
        kid: "mailo-2026-05",
        privateKeyVar: "MAILO_JWE_KEY_B",
        retiredAt: "2026-11-01T00:00:00Z",
      },
    ],
    ...overrides,
  };
}

function messageOf(
  json: unknown,
  env: NodeJS.ProcessEnv = baseEnv(),
  retentionSeconds = RETENTION,
): string {
  try {
    parseEnvelopeKeys(json, { env, retentionSeconds });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("설정 오류가 나야 한다");
}

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MAILO_JWE_KEY_A: current.privatePem,
    MAILO_JWE_KEY_B: previous.privatePem,
    ...extra,
  };
}

describe("Mailo JWE 개인키 목록 (RQ-022, ADR-0008 결정 5)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mailo-envelope-keys-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("환경 변수의 개인키로 현재 키와 이전 키를 읽는다", () => {
    const entries = parseEnvelopeKeys(keysJson(), {
      env: baseEnv(),
      retentionSeconds: RETENTION,
    });

    expect(entries.map((e) => e.kid)).toEqual([
      "mailo-2026-11",
      "mailo-2026-05",
    ]);
    expect(entries[0]?.retiredAt).toBeNull();
    expect(entries[1]?.retiredAt).toEqual(new Date("2026-11-01T00:00:00Z"));
    const ring = createPrivateKeyRing(entries);
    expect(ring.find("mailo-2026-11")).toBeDefined();
    expect(ring.find("mailo-2026-05")).toBeDefined();
    expect(ring.find("nope")).toBeUndefined();
  });

  it("시크릿 파일(_FILE)이 환경 변수보다 우선한다", () => {
    const file = path.join(dir, "key-a.pem");
    writeFileSync(file, previous.privatePem);

    const entries = parseEnvelopeKeys(keysJson(), {
      env: baseEnv({ MAILO_JWE_KEY_A_FILE: file }),
      retentionSeconds: RETENTION,
    });

    expect(entries[0]?.privateKey.equals(previous.privateKey)).toBe(true);
  });

  it("환경 변수 PEM의 줄바꿈을 \\n 두 글자로 써도 읽는다", () => {
    const entries = parseEnvelopeKeys(keysJson(), {
      env: baseEnv({
        MAILO_JWE_KEY_A: current.privatePem.trim().replace(/\n/g, "\\n"),
      }),
      retentionSeconds: RETENTION,
    });

    expect(entries[0]?.privateKey.equals(current.privateKey)).toBe(true);
  });

  it("RSA 3072비트가 아닌 키(RSA 2048, EC)와 PEM이 아닌 값을 거부한다", () => {
    const rsa2048 = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();

    expect(
      messageOf(keysJson(), baseEnv({ MAILO_JWE_KEY_A: rsa2048 })),
    ).toContain("MAILO_JWE_KEY_A은 RSA 3072비트 키여야 한다");
    expect(messageOf(keysJson(), baseEnv({ MAILO_JWE_KEY_A: ec }))).toContain(
      "MAILO_JWE_KEY_A은 RSA 개인키여야 한다",
    );
    expect(
      messageOf(keysJson(), baseEnv({ MAILO_JWE_KEY_A: "not a pem" })),
    ).toContain("MAILO_JWE_KEY_A은 PEM 형식의 RSA 개인키여야 한다");
  });

  it("공개키 PEM을 개인키 자리에 두면 거부한다", () => {
    const publicPem = current.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();

    expect(
      messageOf(keysJson(), baseEnv({ MAILO_JWE_KEY_A: publicPem })),
    ).toContain("MAILO_JWE_KEY_A");
  });

  it("변수가 없거나 파일을 읽지 못하면 변수 이름과 사유만 알린다", () => {
    const missing = messageOf(keysJson(), {
      MAILO_JWE_KEY_A: current.privatePem,
    });
    const unreadable = messageOf(
      keysJson(),
      baseEnv({ MAILO_JWE_KEY_B_FILE: path.join(dir, "none.pem") }),
    );

    expect(missing).toContain(
      "MAILO_JWE_KEY_B 또는 MAILO_JWE_KEY_B_FILE이 필요하다",
    );
    expect(unreadable).toContain(
      "MAILO_JWE_KEY_B_FILE이 가리키는 파일을 읽지 못했다(ENOENT)",
    );
    expect(unreadable).not.toContain(dir);
  });

  it("kid 형식·중복, 변수 이름 접두어, 알 수 없는 필드를 한 번에 보고하고 키 내용은 담지 않는다", () => {
    const message = messageOf({
      keys: [
        { kid: "mailo 1", privateKeyVar: "MAILO_JWE_KEY_A" },
        { kid: "dup", privateKeyVar: "MAILO_JWE_KEY_A" },
        { kid: "dup", privateKeyVar: "MAILO_JWE_KEY_B", extra: 1 },
        { kid: "x", privateKeyVar: "MAILO_DATABASE_URL" },
      ],
    });

    expect(message).toContain("keys[0].kid");
    expect(message).toContain("keys[2].kid가 다른 항목과 겹친다");
    expect(message).toContain("keys[2]에 알 수 없는 필드가 있다: extra");
    expect(message).toContain("keys[3].privateKeyVar는 MAILO_JWE_KEY_로 시작");
    expect(message).not.toContain("BEGIN");
  });

  it("retiredAt이 없는 현재 키가 하나도 없으면 거부한다", () => {
    const json = keysJson({
      keys: [
        {
          kid: "mailo-2026-11",
          privateKeyVar: "MAILO_JWE_KEY_A",
          retiredAt: "2026-11-01T00:00:00Z",
        },
      ],
    });

    expect(messageOf(json)).toContain("현재 키가 하나 이상 필요하다");
  });

  it("retiredAt은 시간대가 있는 ISO 8601이어야 한다", () => {
    const json = keysJson();
    (json["keys"] as Array<Record<string, unknown>>)[1]!["retiredAt"] =
      "2026-11-01";

    expect(messageOf(json)).toContain("keys[1].retiredAt");
  });

  describe("이전 키 삭제 기록(removed): 교체 시각부터 Key 보존 기간 전에는 삭제할 수 없다", () => {
    const removedAt = (retiredAt: string, afterSeconds: number): string =>
      new Date(Date.parse(retiredAt) + afterSeconds * 1000).toISOString();
    const retiredAt = "2026-01-01T00:00:00.000Z";

    it("보존 기간 미만에 지운 키는 기동을 거부한다", () => {
      const json = keysJson({
        removed: [
          {
            kid: "mailo-2025-11",
            retiredAt,
            removedAt: removedAt(retiredAt, RETENTION - 1),
          },
        ],
      });

      expect(messageOf(json)).toContain(
        "교체 시각부터 Key 보존 기간(MAILO_RECORD_RETENTION_SECONDS)이 지나기 전에는 이전 키를 삭제할 수 없다",
      );
    });

    it("보존 기간이 정확히 지난 뒤 지운 기록은 받는다", () => {
      const json = keysJson({
        removed: [
          {
            kid: "mailo-2025-11",
            retiredAt,
            removedAt: removedAt(retiredAt, RETENTION),
          },
        ],
      });

      const entries = parseEnvelopeKeys(json, {
        env: baseEnv(),
        retentionSeconds: RETENTION,
      });

      expect(entries).toHaveLength(2);
    });

    it("보존 기간 설정을 늘리면 같은 기록이 거부된다", () => {
      const json = keysJson({
        removed: [
          {
            kid: "mailo-2025-11",
            retiredAt,
            removedAt: removedAt(retiredAt, RETENTION),
          },
        ],
      });

      expect(messageOf(json, baseEnv(), RETENTION + 1)).toContain(
        "삭제할 수 없다",
      );
    });

    it("removedAt이 현재 시각보다 미래이면 보존 기간을 채워도 거부한다", () => {
      const json = keysJson({
        removed: [
          {
            kid: "mailo-2025-11",
            retiredAt,
            removedAt: removedAt(retiredAt, RETENTION),
          },
        ],
      });
      const beforeRemoval = new Date(
        Date.parse(retiredAt) + (RETENTION - 1) * 1000,
      );

      expect(() =>
        parseEnvelopeKeys(json, {
          env: baseEnv(),
          retentionSeconds: RETENTION,
          now: beforeRemoval,
        }),
      ).toThrow("removed[0].removedAt이 현재 시각보다 미래다");
      expect(
        parseEnvelopeKeys(json, {
          env: baseEnv(),
          retentionSeconds: RETENTION,
          now: new Date(Date.parse(retiredAt) + RETENTION * 1000),
        }),
      ).toHaveLength(2);
    });

    it("keys에 남아 있는 kid의 삭제 기록과 형식이 틀린 기록을 거부한다", () => {
      const json = keysJson({
        removed: [
          {
            kid: "mailo-2026-05",
            retiredAt,
            removedAt: removedAt(retiredAt, RETENTION),
          },
          { kid: "x", retiredAt: "yesterday", removedAt: "now" },
        ],
      });

      const message = messageOf(json);
      expect(message).toContain("removed[0].kid가 keys에도 있다");
      expect(message).toContain("removed[1].retiredAt과 removedAt");
    });
  });

  it("파일에서 읽고, 없는 파일과 잘못된 JSON은 사유 코드만 알린다", () => {
    const file = path.join(dir, "keys.json");
    writeFileSync(file, JSON.stringify(keysJson()));
    const broken = path.join(dir, "broken.json");
    writeFileSync(broken, "{ not json");
    const options = { env: baseEnv(), retentionSeconds: RETENTION };

    expect(loadEnvelopeKeyFile(file, options)).toHaveLength(2);
    expect(() =>
      loadEnvelopeKeyFile(path.join(dir, "none.json"), options),
    ).toThrow("(ENOENT)");
    expect(() => loadEnvelopeKeyFile(broken, options)).toThrow(
      "올바른 JSON이 아니다",
    );
  });

  it("키링은 중복 kid와 현재 키 없음, RSA 3072가 아닌 키를 거부한다", () => {
    const entry = { kid: "a", privateKey: current.privateKey, retiredAt: null };
    const rsa2048 = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey;

    expect(() => createPrivateKeyRing([])).toThrow(PrivateKeyRingError);
    expect(() => createPrivateKeyRing([entry, entry])).toThrow("DUPLICATE_KID");
    expect(() =>
      createPrivateKeyRing([{ ...entry, retiredAt: new Date() }]),
    ).toThrow("NO_ACTIVE_KEY");
    expect(() =>
      createPrivateKeyRing([{ ...entry, privateKey: rsa2048 }]),
    ).toThrow("INVALID_KEY");
  });
});
