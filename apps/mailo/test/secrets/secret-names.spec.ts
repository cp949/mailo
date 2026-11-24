import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CallerRegistryError,
  parseCallerRegistry,
} from "../../src/callers/index.js";
import {
  ConfigError,
  DATABASE_SECRET_VARIABLES,
  loadConfig,
  loadDatabaseOnly,
} from "../../src/config/index.js";
import { hashApiKey } from "../../src/crypto/index.js";
import { parseEnvelopeKeys } from "../../src/envelope/index.js";
import { APP_SECRET_RESOLVE_OPTIONS } from "../../src/secret-names.js";
import {
  SecretResolutionError,
  resolveSecrets,
} from "../../src/secrets/index.js";
import { rsaKey } from "../support/envelope.js";
import { testEnv } from "../support/rest-app.js";
import { fakeImporter, fakeSource } from "../support/secrets.js";

/**
 * 허용 목록(`APP_SECRET_RESOLVE_OPTIONS`)과 각 로더의 이름 규칙 대조(RQ-075·076, ADR-0016 결정 2).
 * 해석한 환경 복사본으로 기존 로더가 값을 그대로 읽는지도 본다. 어댑터는 가짜다.
 */

// 테스트용 가짜 값이다. 실제 시크릿이 아니다.
const DB_URL =
  "postgres://ref-user:ref-db-password-c1@db.example.invalid:5432/mailo";
const OPS_TOKEN = "o".repeat(40);
const ADMIN_TOKEN = "a".repeat(40);
const SMTP_PASSWORD = "ref-smtp-password-7d2e";
const ACCOUNT_PASSWORD = "ref-account-password-91ab";
const KEY_V1 = Buffer.alloc(32, 41).toString("base64");
const KEY_V2 = Buffer.alloc(32, 42).toString("base64");
const FINGERPRINT_V1 = Buffer.alloc(32, 43).toString("base64");
const JWS_SECRET = Buffer.from(
  Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256),
).toString("base64");
const jweKey = rsaKey("mailo-2026-11");

const VALUES: Record<string, string> = {
  "fake://db-url": DB_URL,
  "fake://ops": OPS_TOKEN,
  "fake://admin": ADMIN_TOKEN,
  "fake://smtp": SMTP_PASSWORD,
  "fake://account": ACCOUNT_PASSWORD,
  "fake://key1": KEY_V1,
  "fake://key2": KEY_V2,
  "fake://fp1": FINGERPRINT_V1,
  "fake://jws": JWS_SECRET,
  "fake://jwe": jweKey.privatePem,
};

function appResolve(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const source = fakeSource({ values: VALUES });
  return resolveSecrets(
    { MAILO_SECRET_ADAPTERS: "fake-adapter", ...env },
    {
      ...APP_SECRET_RESOLVE_OPTIONS,
      importModule: fakeImporter({ "fake-adapter": { default: source } }),
    },
  );
}

describe("허용 목록과 로더의 이름 규칙 (RQ-075·076, ADR-0016 결정 2)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mailo-secret-names-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("고정 이름과 동적 이름을 모두 `X_REF`로 받아 loadConfig가 기존대로 읽는다", async () => {
    const accountsFile = path.join(dir, "accounts.json");
    writeFileSync(
      accountsFile,
      JSON.stringify({
        accounts: [
          {
            id: "marketing",
            host: "smtp.example.invalid",
            from: "marketing@example.com",
            auth: {
              user: "marketing@example.invalid",
              secretVar: "MAILO_SMTP_SECRET_MARKETING",
            },
          },
          {
            id: "default",
            host: "smtp.example.invalid",
            from: "no-reply@example.com",
            auth: {
              user: "relay@example.invalid",
              secretVar: "MAILO_SMTP_SECRET_DEFAULT",
            },
          },
        ],
      }),
    );
    const env = await appResolve({
      NODE_ENV: "test",
      MAILO_CALLERS_FILE: "/etc/mailo/callers.json",
      MAILO_DATABASE_URL_REF: "fake://db-url",
      MAILO_OPS_TOKEN_REF: "fake://ops",
      MAILO_OPS_ADMIN_NAMES: "deploy",
      MAILO_OPS_ADMIN_TOKEN_DEPLOY_REF: "fake://admin",
      MAILO_SMTP_ACCOUNTS_FILE: accountsFile,
      MAILO_SMTP_SECRET_MARKETING_REF: "fake://account",
      MAILO_SMTP_SECRET_DEFAULT_REF: "fake://smtp",
      MAILO_DB_ENCRYPTION_KEY_V1_REF: "fake://key1",
      MAILO_DB_ENCRYPTION_KEY_V2_REF: "fake://key2",
      MAILO_DB_ENCRYPTION_KEY_VERSION: "2",
      MAILO_FINGERPRINT_KEY_V1_REF: "fake://fp1",
    });
    const config = loadConfig(env);
    expect(config.database.url.reveal()).toBe(DB_URL);
    expect(config.ops.token?.reveal()).toBe(OPS_TOKEN);
    expect(config.ops.admins.map((a) => [a.name, a.token.reveal()])).toEqual([
      ["deploy", ADMIN_TOKEN],
    ]);
    const passwords = new Map(
      config.smtpAccounts.map((a) => [a.id, a.auth?.password.reveal()]),
    );
    expect(passwords.get("marketing")).toBe(ACCOUNT_PASSWORD);
    expect(passwords.get("default")).toBe(SMTP_PASSWORD);
    const ring = config.keys.dbEncryption.reveal();
    expect(ring.currentVersion).toBe(2);
    expect(ring.keys.get(2)?.equals(Buffer.from(KEY_V2, "base64"))).toBe(true);
    expect(ring.keys.get(1)?.equals(Buffer.from(KEY_V1, "base64"))).toBe(true);
  });

  it("호출처 JWS 비밀(secretVar)과 JWE 개인키(privateKeyVar)도 해석한 복사본으로 읽는다", async () => {
    const env = await appResolve({
      NODE_ENV: "test",
      MAILO_JWS_SECRET_BILLING_REF: "fake://jws",
      MAILO_JWE_KEY_CURRENT_REF: "fake://jwe",
    });
    const registry = parseCallerRegistry(
      {
        callers: [
          {
            id: "billing",
            apiKeyHashes: [
              hashApiKey("billing-fake-api-key-00000000000000000001"),
            ],
            fileChannel: false,
            signature: {
              mode: "required",
              keys: [
                { kid: "billing-1", secretVar: "MAILO_JWS_SECRET_BILLING" },
              ],
            },
          },
        ],
      },
      { env },
    );
    expect(registry.callers.length).toBe(1);
    const entries = parseEnvelopeKeys(
      {
        keys: [
          { kid: "mailo-2026-11", privateKeyVar: "MAILO_JWE_KEY_CURRENT" },
        ],
      },
      { env, retentionSeconds: 30 * 86_400 },
    );
    expect(entries[0]?.privateKey.equals(jweKey.privateKey)).toBe(true);
  });

  it("마이그레이션 CLI 범위(DB 비밀)는 두 변수만 해석하고 다른 `*_REF`는 건드리지 않는다", async () => {
    const source = fakeSource({
      values: { "fake://db-url": DB_URL, "fake://pw": "ref-db-password-c1" },
    });
    const env = await resolveSecrets(
      {
        MAILO_SECRET_ADAPTERS: "fake-adapter",
        NODE_ENV: "test",
        MAILO_DATABASE_URL_REF: "fake://db-url",
        // 다른 변수의 참조와 오타 변수는 마이그레이션 프로세스가 읽을 이유가 없어 무시한다.
        MAILO_OPS_TOKEN_REF: "fake://ops",
        MAILO_SMTP_PASWORD_REF: "fake://typo",
      },
      {
        names: DATABASE_SECRET_VARIABLES.map((name) => ({ name })),
        importModule: fakeImporter({ "fake-adapter": { default: source } }),
      },
    );
    expect(source.calls.map((c) => c.ref)).toEqual(["fake://db-url"]);
    expect(loadDatabaseOnly(env).url.reveal()).toBe(DB_URL);
    expect(env["MAILO_OPS_TOKEN"]).toBeUndefined();
  });

  it("분리된 DB 변수의 비밀번호(MAILO_DB_PASSWORD_REF)로 접속 URL을 조립한다", async () => {
    const env = await appResolve({
      NODE_ENV: "test",
      MAILO_DB_HOST: "db.example.invalid",
      MAILO_DB_USER: "mailo",
      MAILO_DB_NAME: "mailo",
      MAILO_DB_PASSWORD_REF: "fake://smtp",
    });
    expect(loadDatabaseOnly(env).url.reveal()).toBe(
      `postgres://mailo:${SMTP_PASSWORD}@db.example.invalid:5432/mailo`,
    );
  });

  it("관리 토큰 이름의 최대 길이(32자)가 로더와 허용 목록에서 같다", async () => {
    const name = `a${"b".repeat(31)}`;
    const variable = `MAILO_OPS_ADMIN_TOKEN_${name.toUpperCase()}`;
    const ok = await appResolve({
      NODE_ENV: "test",
      MAILO_CALLERS_FILE: "/etc/mailo/callers.json",
      MAILO_OPS_ADMIN_NAMES: name,
      [`${variable}_REF`]: "fake://admin",
    });
    expect(loadConfig(testEnv(ok)).ops.admins.map((a) => a.name)).toEqual([
      name,
    ]);

    // 33자는 로더도 이름을 거부하므로 허용 목록에도 없다(MAILO_ 접두어라 unknown-name이다).
    await expect(
      appResolve({ [`${variable}B_REF`]: "fake://admin" }),
    ).rejects.toMatchObject({
      failures: [{ kind: "unknown-name" }],
    });
  });

  it("키 버전 변수는 `_V<n>`만 받는다(`_VERSION`, 문자 버전은 아니다)", async () => {
    await expect(
      appResolve({ MAILO_DB_ENCRYPTION_KEY_VERSION_REF: "fake://key1" }),
    ).rejects.toMatchObject({ failures: [{ kind: "unknown-name" }] });
    await expect(
      appResolve({ MAILO_DB_ENCRYPTION_KEY_VX_REF: "fake://key1" }),
    ).rejects.toMatchObject({ failures: [{ kind: "unknown-name" }] });
  });

  it("오타가 난 MAILO_*_REF와 MAILO_CLI_TOKEN_REF(범위 밖)는 unknown-name으로 기동을 거부한다", async () => {
    for (const name of ["MAILO_SMTP_PASWORD_REF", "MAILO_CLI_TOKEN_REF"]) {
      const error = await appResolve({ [name]: "fake://smtp" }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SecretResolutionError);
      expect((error as SecretResolutionError).failures).toEqual([
        { variable: name, method: "ref", kind: "unknown-name" },
      ]);
    }
  });

  it("MAILO_ 접두어가 아닌 *_REF(예: 어댑터의 AWS 설정)는 무시한다", async () => {
    const env = await appResolve({ AWS_PROFILE_REF: "x" });
    expect(env["AWS_PROFILE_REF"]).toBe("x");
  });

  it("해석 뒤 X와 X_FILE이 함께 있으면 기존 우선순위(_FILE 우선)가 그대로다(REF를 쓰지 않는 구성의 회귀)", async () => {
    const file = path.join(dir, "db-password");
    writeFileSync(file, "from-file\n");
    const env = await appResolve({
      NODE_ENV: "test",
      MAILO_DB_HOST: "db.example.invalid",
      MAILO_DB_USER: "mailo",
      MAILO_DB_NAME: "mailo",
      MAILO_DB_PASSWORD: "from-env",
      MAILO_DB_PASSWORD_FILE: file,
    });
    expect(loadDatabaseOnly(env).url.reveal()).toBe(
      "postgres://mailo:from-file@db.example.invalid:5432/mailo",
    );
  });
});

describe("secretVar·privateKeyVar의 `_REF` 끝 이름 거부 (RQ-075, ADR-0016 결정 2)", () => {
  it("호출처 서명 키의 secretVar가 _REF로 끝나면 거부한다", () => {
    expect(() =>
      parseCallerRegistry(
        {
          callers: [
            {
              id: "billing",
              apiKeyHashes: [
                hashApiKey("billing-fake-api-key-00000000000000000001"),
              ],
              fileChannel: false,
              signature: {
                mode: "required",
                keys: [
                  { kid: "billing-1", secretVar: "MAILO_JWS_SECRET_B_REF" },
                ],
              },
            },
          ],
        },
        { env: { MAILO_JWS_SECRET_B_REF: JWS_SECRET } },
      ),
    ).toThrow(CallerRegistryError);
  });

  it("JWE privateKeyVar가 _REF로 끝나면 거부한다", () => {
    expect(() =>
      parseEnvelopeKeys(
        {
          keys: [
            { kid: "mailo-2026-11", privateKeyVar: "MAILO_JWE_KEY_A_REF" },
          ],
        },
        {
          env: { MAILO_JWE_KEY_A_REF: jweKey.privatePem },
          retentionSeconds: 30 * 86_400,
        },
      ),
    ).toThrow(ConfigError);
  });

  it("SMTP 계정의 secretVar가 _REF로 끝나면 거부한다", () => {
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), "mailo-secret-names-acc-")),
      "accounts.json",
    );
    writeFileSync(
      file,
      JSON.stringify({
        accounts: [
          {
            id: "default",
            host: "smtp.example.invalid",
            from: "no-reply@example.com",
            auth: {
              user: "u@example.invalid",
              secretVar: "MAILO_SMTP_SECRET_A_REF",
            },
          },
        ],
      }),
    );
    expect(() =>
      loadConfig(
        testEnv({
          MAILO_CALLERS_FILE: "/etc/mailo/callers.json",
          MAILO_SMTP_HOST: "",
          MAILO_SMTP_USER: "",
          MAILO_SMTP_PASSWORD: "",
          MAILO_SMTP_FROM: "",
          MAILO_SMTP_ACCOUNTS_FILE: file,
          MAILO_SMTP_SECRET_A_REF: ACCOUNT_PASSWORD,
        }),
      ),
    ).toThrow(/_REF로 끝날 수 없다/);
    rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe(".env.example의 X_REF 예시 (RQ-075, ADR-0016 결정 10)", () => {
  const text = readFileSync(
    path.resolve(import.meta.dirname, "../../../../.env.example"),
    "utf8",
  );
  const lines = text.split("\n");

  it("활성 줄에는 X_REF가 없다(기존 구성이 해석 단계에서 바뀌지 않는다)", async () => {
    const active = Object.fromEntries(
      lines
        .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(Object.keys(active).filter((n) => n.endsWith("_REF"))).toEqual([]);
    const copy = await resolveSecrets(active, {
      ...APP_SECRET_RESOLVE_OPTIONS,
    });
    expect(copy).toEqual(active);
  });

  it("주석 처리한 *_REF 예시는 모두 허용 목록의 이름이고 주석을 풀어도 해석된다", async () => {
    const examples = lines
      .map((l) => /^#(MAILO_[A-Z0-9_]+_REF)=(.+)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1] as string, m[2] as string] as const);
    expect(examples.length).toBeGreaterThan(0);
    const source = fakeSource({
      scheme: "aws-sm",
      resolve: async () => "resolved-value",
    });
    const env = await resolveSecrets(
      {
        MAILO_SECRET_ADAPTERS: "fake-adapter",
        ...Object.fromEntries(examples),
      },
      {
        ...APP_SECRET_RESOLVE_OPTIONS,
        importModule: fakeImporter({ "fake-adapter": { default: source } }),
      },
    );
    for (const [name] of examples)
      expect(env[name.slice(0, -"_REF".length)]).toBe("resolved-value");
  });

  it("MAILO_SECRET_ADAPTERS와 MAILO_SECRET_RESOLVE_TIMEOUT_MS 예시가 있다", () => {
    expect(text).toContain("#MAILO_SECRET_ADAPTERS=");
    expect(text).toContain("#MAILO_SECRET_RESOLVE_TIMEOUT_MS=10000");
  });
});
