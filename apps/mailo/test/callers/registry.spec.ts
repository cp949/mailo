import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CallerRegistryError,
  loadCallerRegistryFile,
  parseCallerRegistry,
} from "../../src/callers/index.js";
import { hashApiKey } from "../../src/crypto/index.js";

const KEY_1 = "fake-key-billing-1-0000000000000000000000000";
const KEY_2 = "fake-key-billing-2-0000000000000000000000000";
const KEY_3 = "fake-key-orders-1-00000000000000000000000000";

function entry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "billing",
    apiKeyHashes: [hashApiKey(KEY_1)],
    signature: { mode: "none" },
    ...overrides,
  };
}

function messageOf(json: unknown): string {
  try {
    parseCallerRegistry(json);
  } catch (error) {
    expect(error).toBeInstanceOf(CallerRegistryError);
    return (error as Error).message;
  }
  throw new Error("레지스트리 오류가 나야 한다");
}

describe("호출처 레지스트리 (RQ-028)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mailo-callers-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("호출처당 API 키 2개가 동시에 유효하고 다른 호출처의 키는 그 호출처로 식별된다", () => {
    const registry = parseCallerRegistry({
      callers: [
        entry({ apiKeyHashes: [hashApiKey(KEY_1), hashApiKey(KEY_2)] }),
        entry({ id: "orders", apiKeyHashes: [hashApiKey(KEY_3)] }),
      ],
    });

    expect(registry.authenticate(KEY_1)).toBe("billing");
    expect(registry.authenticate(KEY_2)).toBe("billing");
    expect(registry.authenticate(KEY_3)).toBe("orders");
    expect(registry.authenticate(KEY_1 + "x")).toBeUndefined();
    expect(registry.authenticate("")).toBeUndefined();
  });

  it("해시만 저장한다. 평문 키는 항목 어디에도 없다", () => {
    const registry = parseCallerRegistry({ callers: [entry()] });

    expect(JSON.stringify(registry.callers)).not.toContain(KEY_1);
  });

  it("서명 사용 여부(signature.mode)가 명시되지 않은 항목은 거부한다", () => {
    expect(messageOf({ callers: [entry({ signature: undefined })] })).toContain(
      "signature.mode",
    );
    expect(messageOf({ callers: [entry({ signature: {} })] })).toContain(
      "signature.mode",
    );
    expect(
      messageOf({ callers: [entry({ signature: { mode: "maybe" } })] }),
    ).toContain("signature.mode");
  });

  it("API 키 해시는 1~2개다. 0개, 3개, 잘못된 형식은 거부한다", () => {
    expect(messageOf({ callers: [entry({ apiKeyHashes: [] })] })).toContain(
      "apiKeyHashes",
    );
    expect(
      messageOf({
        callers: [
          entry({
            apiKeyHashes: ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
          }),
        ],
      }),
    ).toContain("apiKeyHashes");
    expect(
      messageOf({ callers: [entry({ apiKeyHashes: [KEY_1] })] }),
    ).toContain("apiKeyHashes[0]");
  });

  it("호출처 ID 중복, 해시 중복, 잘못된 ID, 알 수 없는 필드를 거부한다. 오류에 해시 값은 없다", () => {
    const dup = hashApiKey(KEY_1);
    const message = messageOf({
      callers: [
        entry(),
        entry({ id: "billing" }),
        entry({ id: "../etc" }),
        entry({ id: "x2", apiKeyHashes: [dup] }),
        entry({ id: "x3", extra: 1 }),
      ],
    });

    expect(message).toContain("id가 다른 항목과 겹친다");
    expect(message).toContain("callers[2].id");
    expect(message).toContain("다른 키와 겹친다");
    expect(message).toContain("알 수 없는 필드");
    expect(message).not.toContain(dup);
  });

  it("호출처가 하나도 없으면 거부한다", () => {
    expect(messageOf({ callers: [] })).toContain("callers");
    expect(messageOf({})).toContain("callers");
  });

  it("2단계 필드(fileChannel, jwe)는 읽어 두기만 한다", () => {
    const registry = parseCallerRegistry({
      callers: [
        entry({
          fileChannel: true,
          jwe: { kid: "x" },
        }),
      ],
    });

    expect(registry.callers[0]).toMatchObject({
      fileChannel: true,
      signature: { mode: "none", keys: [] },
      jwe: { kid: "x" },
    });
  });

  it("파일에서 읽고, 없는 파일과 잘못된 JSON은 사유 코드만 알린다", () => {
    const file = path.join(dir, "callers.json");
    writeFileSync(file, JSON.stringify({ callers: [entry()] }));
    const broken = path.join(dir, "broken.json");
    writeFileSync(broken, `{"callers": [ ${KEY_1}`);

    expect(loadCallerRegistryFile(file).authenticate(KEY_1)).toBe("billing");
    expect(() => loadCallerRegistryFile(path.join(dir, "nope.json"))).toThrow(
      "ENOENT",
    );
    let message = "";
    try {
      loadCallerRegistryFile(broken);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("올바른 JSON이 아니다");
    expect(message).not.toContain(KEY_1);
  });
});
