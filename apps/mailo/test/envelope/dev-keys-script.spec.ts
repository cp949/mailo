import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey } from "node:crypto";
import { CompactEncrypt } from "jose";
import { parseCallerRegistry } from "../../src/callers/index.js";
import {
  createJweDecryptor,
  createPrivateKeyRing,
  loadEnvelopeKeyFile,
} from "../../src/envelope/index.js";
import { hashApiKey } from "../../src/crypto/index.js";

// 개발·테스트용 키 생성 스크립트(scripts/gen-dev-keys.mjs)가 만든 파일을 Mailo의 로더가 그대로 읽는지 확인한다.

const SCRIPT = fileURLToPath(
  new URL("../../scripts/gen-dev-keys.mjs", import.meta.url),
);

describe("개발용 키 생성 스크립트 (ADR-0008)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mailo-dev-keys-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("만든 키 쌍과 JWS 비밀키를 Mailo 로더가 읽고, 공개키로 만든 JWE를 개인키로 복호화한다", async () => {
    execFileSync(
      "node",
      [
        SCRIPT,
        "--kid",
        "dev-1",
        "--out",
        dir,
        "--jws-var",
        "MAILO_JWS_SECRET_DEV",
      ],
      { stdio: "pipe" },
    );
    const env: NodeJS.ProcessEnv = {};
    for (const line of readFileSync(path.join(dir, "dev-keys.env"), "utf8")
      .trim()
      .split("\n")) {
      const at = line.indexOf("=");
      env[line.slice(0, at)] = line.slice(at + 1);
    }

    const entries = loadEnvelopeKeyFile(
      env["MAILO_ENVELOPE_KEYS_FILE"] as string,
      {
        env,
        retentionSeconds: 30 * 86_400,
      },
    );
    const registry = parseCallerRegistry(
      {
        callers: [
          {
            id: "alpha",
            apiKeyHashes: [
              hashApiKey("fake-key-alpha-00000000000000000000000000"),
            ],
            signature: {
              mode: "required",
              keys: [{ kid: "alpha-1", secretVar: "MAILO_JWS_SECRET_DEV" }],
            },
          },
        ],
      },
      { env },
    );
    const publicKey = createPublicKey(
      readFileSync(path.join(dir, "dev-1.public.pem"), "utf8"),
    );
    const jwe = await new CompactEncrypt(
      new TextEncoder().encode(JSON.stringify({ subject: "s", text: "t" })),
    )
      .setProtectedHeader({
        alg: "RSA-OAEP-256",
        enc: "A256GCM",
        kid: "dev-1",
        caller: "alpha",
      })
      .encrypt(publicKey);

    const result = await createJweDecryptor(
      createPrivateKeyRing(entries),
    ).decrypt(jwe, "alpha");

    expect(entries.map((e) => e.kid)).toEqual(["dev-1"]);
    expect(
      registry.callers[0]!.signature.keys[0]!.secret.reveal(),
    ).toHaveLength(32);
    expect(result.ok).toBe(true);
    // 개인키·비밀키 파일은 소유자만 읽는다.
    expect(statSync(path.join(dir, "dev-1.private.pem")).mode & 0o777).toBe(
      0o600,
    );
    expect(statSync(path.join(dir, "jws-secret.txt")).mode & 0o777).toBe(0o600);
  });

  it("잘못된 kid는 비정상 종료한다", () => {
    expect(() =>
      execFileSync("node", [SCRIPT, "--kid", "bad kid", "--out", dir], {
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
