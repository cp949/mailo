import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import {
  CallerRegistryError,
  parseCallerRegistry,
} from "../../src/callers/index.js";
import { hashApiKey } from "../../src/crypto/index.js";

// RQ-028, ADR-0008 결정 2: 호출처 JWS 비밀키는 해시가 아니라 원문이 필요하다. 레지스트리에는 변수 이름만 두고 값은 시크릿 파일·환경 변수로 받는다.

const KEY_A = Buffer.alloc(32, 61).toString("base64");
const KEY_B = Buffer.alloc(32, 62).toString("hex");

function entry(signature: unknown): Record<string, unknown> {
  return {
    id: "billing",
    apiKeyHashes: [hashApiKey("fake-key-billing-0000000000000000000000000")],
    signature,
  };
}

function messageOf(signature: unknown, env: NodeJS.ProcessEnv = {}): string {
  try {
    parseCallerRegistry({ callers: [entry(signature)] }, { env });
  } catch (error) {
    expect(error).toBeInstanceOf(CallerRegistryError);
    return (error as Error).message;
  }
  throw new Error("레지스트리 오류가 나야 한다");
}

describe("호출처 JWS 서명 키 (RQ-028, ADR-0008 결정 2)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mailo-jws-keys-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const required = (keys: unknown) => ({ mode: "required", keys });

  it("환경 변수의 비밀키를 읽고 값은 Secret으로 감싼다", () => {
    const registry = parseCallerRegistry(
      {
        callers: [
          entry(
            required([
              { kid: "billing-1", secretVar: "MAILO_JWS_SECRET_BILLING_1" },
              { kid: "billing-2", secretVar: "MAILO_JWS_SECRET_BILLING_2" },
            ]),
          ),
        ],
      },
      {
        env: {
          MAILO_JWS_SECRET_BILLING_1: KEY_A,
          MAILO_JWS_SECRET_BILLING_2: KEY_B,
        },
      },
    );

    const keys = registry.callers[0]!.signature.keys;
    expect(keys.map((k) => k.kid)).toEqual(["billing-1", "billing-2"]);
    expect(Buffer.from(keys[0]!.secret.reveal())).toEqual(
      Buffer.from(KEY_A, "base64"),
    );
    expect(Buffer.from(keys[1]!.secret.reveal())).toEqual(
      Buffer.from(KEY_B, "hex"),
    );
    // 레지스트리 객체를 로그에 찍어도 비밀키가 나오지 않는다(RQ-027)
    expect(inspect(registry, { depth: 6 })).not.toContain(KEY_A);
    expect(JSON.stringify(registry)).not.toContain(KEY_A);
  });

  it("시크릿 파일(_FILE)이 환경 변수보다 우선한다", () => {
    const file = path.join(dir, "billing-1.secret");
    writeFileSync(file, `${KEY_B}\n`);

    const registry = parseCallerRegistry(
      {
        callers: [
          entry(
            required([
              { kid: "billing-1", secretVar: "MAILO_JWS_SECRET_BILLING_1" },
            ]),
          ),
        ],
      },
      {
        env: {
          MAILO_JWS_SECRET_BILLING_1: KEY_A,
          MAILO_JWS_SECRET_BILLING_1_FILE: file,
        },
      },
    );

    expect(
      Buffer.from(registry.callers[0]!.signature.keys[0]!.secret.reveal()),
    ).toEqual(Buffer.from(KEY_B, "hex"));
  });

  it("required인데 키가 없거나 3개 이상이면 거부한다", () => {
    expect(messageOf({ mode: "required" })).toContain(
      "signature.keys는 키 1~2개의 배열",
    );
    expect(messageOf(required([]))).toContain(
      "signature.keys는 키 1~2개의 배열",
    );
    expect(
      messageOf(
        required(
          [1, 2, 3].map((n) => ({
            kid: `k${n}`,
            secretVar: `MAILO_JWS_SECRET_K${n}`,
          })),
        ),
      ),
    ).toContain("키 1~2개");
  });

  it("none인 호출처에 keys를 두면 거부한다(서명 사용 여부를 한 곳에서만 정한다)", () => {
    expect(
      messageOf({
        mode: "none",
        keys: [{ kid: "k1", secretVar: "MAILO_JWS_SECRET_K1" }],
      }),
    ).toContain("signature.mode가 none이면 둘 수 없다");
  });

  it("변수 이름 접두어, kid 형식, 알 수 없는 필드, 키 형식을 거부하고 값은 오류에 담지 않는다", () => {
    const names = messageOf(
      required([
        { kid: "k 1", secretVar: "MAILO_JWS_SECRET_A" },
        { kid: "k2", secretVar: "MAILO_DATABASE_URL" },
      ]),
    );
    const values = messageOf(
      required([
        { kid: "k3", secretVar: "MAILO_JWS_SECRET_C", extra: 1 },
        { kid: "k4", secretVar: "MAILO_JWS_SECRET_D" },
      ]),
      {
        MAILO_JWS_SECRET_C: "tooshort-CANARY-JWS-SECRET",
        MAILO_JWS_SECRET_D: Buffer.alloc(16, 1).toString("base64"),
      },
    );

    expect(names).toContain("signature.keys[0].kid");
    expect(names).toContain("keys[1].secretVar는 MAILO_JWS_SECRET_으로 시작");
    expect(values).toContain("keys[0]에 알 수 없는 필드가 있다: extra");
    expect(values).toContain("MAILO_JWS_SECRET_C은 32바이트 키");
    expect(values).toContain("MAILO_JWS_SECRET_D은 32바이트 키");
    expect(values).not.toContain("CANARY");
  });

  it("같은 호출처 안의 kid 중복과 변수·파일 누락, 읽기 실패를 알린다", () => {
    const duplicate = messageOf(
      required([
        { kid: "k1", secretVar: "MAILO_JWS_SECRET_A" },
        { kid: "k1", secretVar: "MAILO_JWS_SECRET_B" },
      ]),
      { MAILO_JWS_SECRET_A: KEY_A, MAILO_JWS_SECRET_B: KEY_B },
    );
    const missing = messageOf(
      required([{ kid: "k1", secretVar: "MAILO_JWS_SECRET_A" }]),
    );
    const unreadable = messageOf(
      required([{ kid: "k1", secretVar: "MAILO_JWS_SECRET_A" }]),
      { MAILO_JWS_SECRET_A_FILE: path.join(dir, "missing.secret") },
    );

    expect(duplicate).toContain("kid가 같은 호출처의 다른 키와 겹친다");
    expect(missing).toContain(
      "MAILO_JWS_SECRET_A 또는 MAILO_JWS_SECRET_A_FILE이 필요하다",
    );
    expect(unreadable).toContain(
      "MAILO_JWS_SECRET_A_FILE이 가리키는 파일을 읽지 못했다(ENOENT)",
    );
  });
});
