import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import {
  ConfigError,
  EnvReader,
  isAccountId,
  loadConfig,
  loadSmtpAccounts,
  type SmtpAccount,
} from "../../src/config/index.js";
import { testEnv } from "../support/rest-app.js";

/**
 * SMTP 계정 정의와 설정 로드(RQ-053, ADR-0013 결정 1). 환경 없이 파일 시스템만 쓰는 단위 테스트다.
 * 비밀번호는 모두 가짜 값이고, 오류 메시지에 값이 새지 않는지(RQ-027)를 canary로 확인한다.
 */

const PASSWORD_A = "CANARY-ACCOUNT-PASSWORD-AAAA";
const PASSWORD_B = "CANARY-ACCOUNT-PASSWORD-BBBB";
const HOST_CANARY = "canary-host.example.invalid";
const USER_CANARY = "canary-user@example.invalid";

const OPTIONS = { leaseSeconds: 120, workerConcurrency: 4 };

describe("SMTP 계정 설정 로드(RQ-053, ADR-0013 결정 1)", () => {
  let dir: string;
  let seq = 0;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mailo-accounts-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, content: unknown): string {
    seq += 1;
    const target = path.join(dir, `${seq}-${name}`);
    writeFileSync(
      target,
      typeof content === "string" ? content : JSON.stringify(content),
    );
    return target;
  }

  function account(overrides: Record<string, unknown> = {}) {
    return {
      id: "marketing",
      host: HOST_CANARY,
      auth: { user: USER_CANARY, secretVar: "MAILO_SMTP_SECRET_MARKETING" },
      ...overrides,
    };
  }

  function load(
    env: NodeJS.ProcessEnv,
    options = OPTIONS,
  ): { accounts: SmtpAccount[]; error?: ConfigError } {
    const reader = new EnvReader(env);
    const accounts = loadSmtpAccounts(reader, options);
    try {
      reader.finish();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return { accounts, error: error as ConfigError };
    }
    return { accounts };
  }

  function expectIssue(env: NodeJS.ProcessEnv, fragment: string): string {
    const { error } = load(env);
    if (error === undefined) throw new Error("설정 오류가 나야 한다");
    expect(error.message).toContain(fragment);
    // 값(호스트·사용자·비밀번호)은 어떤 오류 사유에도 들어가면 안 된다(RQ-027).
    for (const canary of [HOST_CANARY, USER_CANARY, PASSWORD_A, PASSWORD_B])
      expect(error.message).not.toContain(canary);
    return error.message;
  }

  const ENV_DEFAULT = {
    MAILO_SMTP_HOST: "smtp.example.invalid",
    MAILO_SMTP_USER: "relay-user@example.invalid",
    MAILO_SMTP_PASSWORD: PASSWORD_A,
  };

  describe("계정 ID 형식(결정 1)", () => {
    it.each(["default", "a", "marketing", "m-1_x", "0abc", "a".repeat(32)])(
      "%s는 받는다",
      (id) => {
        expect(isAccountId(id)).toBe(true);
      },
    );

    it.each([
      "",
      "Marketing",
      "-lead",
      "_lead",
      "a.b",
      "a@b",
      "a".repeat(33),
      "unregistered",
      "mk ting",
    ])("%j는 거부한다(대문자·기호·길이·예약어)", (id) => {
      expect(isAccountId(id)).toBe(false);
    });
  });

  describe("default 계정의 출처(결정 1)", () => {
    it("파일이 없으면 MAILO_SMTP_*가 default 하나를 정의한다(기존 단일 계정 호환)", () => {
      const { accounts, error } = load(ENV_DEFAULT);

      expect(error).toBeUndefined();
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        id: "default",
        host: "smtp.example.invalid",
        port: 587,
        security: "starttls",
        from: "relay-user@example.invalid",
        timeoutSeconds: 30,
        sendQuota24h: null,
        concurrency: null,
      });
      expect(accounts[0]!.auth!.password.reveal()).toBe(PASSWORD_A);
    });

    it("파일이 없고 MAILO_SMTP_HOST도 없으면 거부한다", () => {
      expectIssue({}, "MAILO_SMTP_HOST이 설정되지 않았다");
    });

    it("파일과 MAILO_SMTP_HOST가 함께 있으면 default는 환경 변수 정의이고 파일 계정이 뒤따른다", () => {
      const filePath = file("ok.json", { accounts: [account()] });
      const { accounts, error } = load({
        ...ENV_DEFAULT,
        MAILO_SMTP_ACCOUNTS_FILE: filePath,
        MAILO_SMTP_SECRET_MARKETING: PASSWORD_B,
      });

      expect(error).toBeUndefined();
      expect(accounts.map((a) => a.id)).toEqual(["default", "marketing"]);
      expect(accounts[1]!.auth!.password.reveal()).toBe(PASSWORD_B);
    });

    it("default 출처가 둘 다이면(환경 변수 HOST와 파일의 id: default) 거부한다", () => {
      const filePath = file("both.json", {
        accounts: [account({ id: "default" })],
      });
      expectIssue(
        {
          ...ENV_DEFAULT,
          MAILO_SMTP_ACCOUNTS_FILE: filePath,
          MAILO_SMTP_SECRET_MARKETING: PASSWORD_B,
        },
        "default",
      );
    });

    it("파일이 있고 MAILO_SMTP_HOST가 없으면 default는 파일에 있는 것이다", () => {
      const filePath = file("file-default.json", {
        accounts: [account({ id: "default" })],
      });
      const { accounts, error } = load({
        MAILO_SMTP_ACCOUNTS_FILE: filePath,
        MAILO_SMTP_SECRET_MARKETING: PASSWORD_B,
      });

      expect(error).toBeUndefined();
      expect(accounts.map((a) => a.id)).toEqual(["default"]);
    });

    it("파일이 있고 default가 어디에도 없으면 default 계정 없이 기동한다", () => {
      const filePath = file("no-default.json", { accounts: [account()] });
      const { accounts, error } = load({
        MAILO_SMTP_ACCOUNTS_FILE: filePath,
        MAILO_SMTP_SECRET_MARKETING: PASSWORD_B,
      });

      expect(error).toBeUndefined();
      expect(accounts.map((a) => a.id)).toEqual(["marketing"]);
    });

    it.each([
      "MAILO_SMTP_USER",
      "MAILO_SMTP_PASSWORD",
      "MAILO_SMTP_FROM",
      "MAILO_SMTP_PORT",
      "MAILO_SMTP_SECURITY",
    ])(
      "파일이 있고 MAILO_SMTP_HOST가 없는데 %s가 있으면 오설정으로 거부한다",
      (name) => {
        const filePath = file("stray.json", { accounts: [account()] });
        expectIssue(
          {
            MAILO_SMTP_ACCOUNTS_FILE: filePath,
            MAILO_SMTP_SECRET_MARKETING: PASSWORD_B,
            [name]: name === "MAILO_SMTP_PORT" ? "587" : "x",
          },
          name,
        );
      },
    );

    it("MAILO_SMTP_TIMEOUT_SECONDS는 계정 공통 기본값이라 HOST가 없어도 함께 둘 수 있다", () => {
      const filePath = file("timeout.json", { accounts: [account()] });
      const { accounts, error } = load({
        MAILO_SMTP_ACCOUNTS_FILE: filePath,
        MAILO_SMTP_SECRET_MARKETING: PASSWORD_B,
        MAILO_SMTP_TIMEOUT_SECONDS: "45",
      });

      expect(error).toBeUndefined();
      expect(accounts[0]!.timeoutSeconds).toBe(45);
    });
  });

  describe("파일 계정의 필드 규칙(결정 1)", () => {
    const withFile = (content: unknown, extra: NodeJS.ProcessEnv = {}) => ({
      MAILO_SMTP_ACCOUNTS_FILE: file("case.json", content),
      MAILO_SMTP_SECRET_MARKETING: PASSWORD_B,
      ...extra,
    });

    it("생략한 값은 기본을 쓴다(포트 587, STARTTLS, 대기 시간 30초, from은 auth.user)", () => {
      const { accounts } = load(withFile({ accounts: [account()] }));

      expect(accounts[0]).toMatchObject({
        id: "marketing",
        port: 587,
        security: "starttls",
        timeoutSeconds: 30,
        from: USER_CANARY,
        sendQuota24h: null,
        concurrency: null,
      });
    });

    it("security가 tls이면 포트 기본값이 465이고 명시한 포트를 우선한다", () => {
      expect(
        load(withFile({ accounts: [account({ security: "tls" })] }))
          .accounts[0]!.port,
      ).toBe(465);
      expect(
        load(withFile({ accounts: [account({ security: "tls", port: 2465 })] }))
          .accounts[0]!.port,
      ).toBe(2465);
    });

    it("인증 없는 릴레이는 from이 필요하고 auth가 null로 로드된다", () => {
      const relay = account({ id: "relay", from: "relay@example.com" });
      delete (relay as Record<string, unknown>)["auth"];
      const { accounts, error } = load(withFile({ accounts: [relay] }));

      expect(error).toBeUndefined();
      expect(accounts[0]).toMatchObject({
        auth: null,
        from: "relay@example.com",
      });
      const noFrom = account({ id: "relay" });
      delete (noFrom as Record<string, unknown>)["auth"];
      expectIssue(withFile({ accounts: [noFrom] }), "accounts[0].from");
    });

    it("auth.user가 주소가 아니면 from을 생략할 수 없고 from을 주면 받는다", () => {
      const plainUser = account({
        auth: {
          user: "smtp-login-name",
          secretVar: "MAILO_SMTP_SECRET_MARKETING",
        },
      });
      expectIssue(withFile({ accounts: [plainUser] }), "accounts[0].from");
      const { accounts, error } = load(
        withFile({ accounts: [{ ...plainUser, from: "out@example.com" }] }),
      );
      expect(error).toBeUndefined();
      expect(accounts[0]!.from).toBe("out@example.com");
    });

    it("sendQuota24h와 concurrency는 범위를 검증해 읽는다(묶음 A는 점유에 쓰지 않는다)", () => {
      const { accounts } = load(
        withFile({
          accounts: [account({ sendQuota24h: 400, concurrency: 2 })],
        }),
      );
      expect(accounts[0]).toMatchObject({ sendQuota24h: 400, concurrency: 2 });

      expectIssue(
        withFile({ accounts: [account({ sendQuota24h: 0 })] }),
        "accounts[0].sendQuota24h",
      );
      expectIssue(
        withFile({ accounts: [account({ concurrency: 5 })] }),
        "accounts[0].concurrency",
      );
    });

    it.each([
      ["잘못된 ID(대문자)", { id: "Marketing" }, "accounts[0].id"],
      ["예약어 unregistered", { id: "unregistered" }, "accounts[0].id"],
      ["주소 형태 ID", { id: "a@b.com" }, "accounts[0].id"],
      ["잘못된 호스트", { host: "bad host" }, "accounts[0].host"],
      ["잘못된 보안 방식", { security: "plain" }, "accounts[0].security"],
      ["범위 밖 포트", { port: 70000 }, "accounts[0].port"],
      [
        "lease 이상의 대기 시간",
        { timeoutSeconds: 120 },
        "accounts[0].timeoutSeconds",
      ],
      ["모르는 필드", { weird: 1 }, "accounts[0]에 알 수 없는 필드"],
      ["잘못된 from", { from: "not-an-address" }, "accounts[0].from"],
      [
        "_FILE로 끝나는 secretVar",
        {
          auth: {
            user: "u@example.com",
            secretVar: "MAILO_SMTP_SECRET_X_FILE",
          },
        },
        "accounts[0].auth.secretVar",
      ],
      [
        "접두사가 다른 secretVar",
        { auth: { user: "u@example.com", secretVar: "OTHER_SECRET" } },
        "accounts[0].auth.secretVar",
      ],
      [
        "auth의 모르는 필드",
        {
          auth: {
            user: "u@example.com",
            secretVar: "MAILO_SMTP_SECRET_MARKETING",
            password: "x",
          },
        },
        "accounts[0].auth에 알 수 없는 필드",
      ],
    ])("%s는 위치와 사유만 담아 거부한다", (_label, override, fragment) => {
      expectIssue(
        {
          MAILO_SMTP_ACCOUNTS_FILE: file("bad.json", {
            accounts: [account(override)],
          }),
          MAILO_SMTP_SECRET_MARKETING: PASSWORD_B,
          MAILO_SMTP_SECRET_X_FILE: PASSWORD_B,
        },
        fragment,
      );
    });

    it("최상위의 accounts 밖 필드, 빈 배열, 잘못된 JSON, 없는 파일은 거부한다", () => {
      expectIssue(
        withFile({ accounts: [account()], extra: [] }),
        "알 수 없는 최상위 필드",
      );
      expectIssue(
        withFile({ accounts: [] }),
        "accounts 배열이 하나 이상 필요하다",
      );
      expectIssue(withFile({ other: 1 }), "accounts 배열이 필요하다");
      expectIssue(withFile("{not json"), "올바른 JSON이 아니다");
      expectIssue(
        { MAILO_SMTP_ACCOUNTS_FILE: path.join(dir, "missing.json") },
        "MAILO_SMTP_ACCOUNTS_FILE을 읽지 못했다(ENOENT)",
      );
    });

    it("계정 ID가 겹치면 거부한다", () => {
      expectIssue(
        withFile(
          {
            accounts: [
              account(),
              account({
                auth: {
                  user: "other@example.com",
                  secretVar: "MAILO_SMTP_SECRET_OTHER",
                },
              }),
            ],
          },
          { MAILO_SMTP_SECRET_OTHER: PASSWORD_A },
        ),
        "accounts[1].id가 다른 항목과 겹친다",
      );
    });

    it("비밀 변수가 없으면 변수 이름과 위치만 담아 거부한다", () => {
      const message = expectIssue(
        {
          MAILO_SMTP_ACCOUNTS_FILE: file("missing-secret.json", {
            accounts: [account()],
          }),
        },
        "MAILO_SMTP_SECRET_MARKETING 또는 MAILO_SMTP_SECRET_MARKETING_FILE이 필요하다",
      );
      expect(message).toContain("accounts[0].auth.secretVar");
    });

    it("두 계정이 같은 비밀 변수를 쓰면 거부한다", () => {
      expectIssue(
        withFile({
          accounts: [
            account(),
            account({
              id: "other",
              auth: {
                user: "other@example.com",
                secretVar: "MAILO_SMTP_SECRET_MARKETING",
              },
            }),
          ],
        }),
        "accounts[1].auth.secretVar가 다른 계정과 같은 변수다",
      );
    });

    it("같은 host·port·user(대소문자 무시)를 가진 계정이 둘이면 거부한다", () => {
      expectIssue(
        withFile(
          {
            accounts: [
              account(),
              account({
                id: "twin",
                host: HOST_CANARY.toUpperCase(),
                auth: {
                  user: USER_CANARY.toUpperCase(),
                  secretVar: "MAILO_SMTP_SECRET_TWIN",
                },
              }),
            ],
          },
          { MAILO_SMTP_SECRET_TWIN: PASSWORD_A },
        ),
        "accounts[1]가 다른 계정과 같은 host·port·user다",
      );
    });

    it("환경 변수 default와 같은 host·port·user인 파일 계정도 거부한다", () => {
      expectIssue(
        {
          ...ENV_DEFAULT,
          MAILO_SMTP_ACCOUNTS_FILE: file("dup-env.json", {
            accounts: [
              account({
                host: "smtp.example.invalid",
                auth: {
                  user: "relay-user@example.invalid",
                  secretVar: "MAILO_SMTP_SECRET_MARKETING",
                },
              }),
            ],
          }),
          MAILO_SMTP_SECRET_MARKETING: PASSWORD_B,
        },
        "accounts[0]가 다른 계정과 같은 host·port·user다",
      );
    });
  });

  describe("계정 수 상한(결정 1)", () => {
    function many(count: number) {
      const accounts = Array.from({ length: count }, (_, i) => ({
        id: `acct${i}`,
        host: `smtp${i}.example.invalid`,
        from: `a${i}@example.com`,
      }));
      return { MAILO_SMTP_ACCOUNTS_FILE: file("many.json", { accounts }) };
    }

    it("계정 수가 MAILO_WORKER_CONCURRENCY를 넘으면 거부한다(계정마다 슬롯 하나를 보장한다)", () => {
      const { error } = load(many(5), {
        leaseSeconds: 120,
        workerConcurrency: 4,
      });
      expect(error?.message).toContain(
        "SMTP 계정 수는 MAILO_WORKER_CONCURRENCY 이하",
      );
    });

    it("계정 수가 20개를 넘으면 거부한다", () => {
      const { error } = load(many(21), {
        leaseSeconds: 120,
        workerConcurrency: 100,
      });
      expect(error?.message).toContain("SMTP 계정은 20개 이하");
      expect(
        load(many(20), { leaseSeconds: 120, workerConcurrency: 100 }).error,
      ).toBeUndefined();
    });

    it("환경 변수 default도 계정 수에 센다", () => {
      const withEnv = { ...ENV_DEFAULT, ...many(4) };
      expect(load(withEnv, OPTIONS).error?.message).toContain(
        "MAILO_WORKER_CONCURRENCY 이하",
      );
    });
  });

  describe("비밀번호 읽기(RQ-027, ADR-0013 결정 1)", () => {
    it("<변수>_FILE이 <변수>보다 우선하고 끝의 개행은 지운다", () => {
      const secretFile = file("secret.txt", `${PASSWORD_B}\n`);
      const { accounts, error } = load({
        MAILO_SMTP_ACCOUNTS_FILE: file("sec.json", { accounts: [account()] }),
        MAILO_SMTP_SECRET_MARKETING: PASSWORD_A,
        MAILO_SMTP_SECRET_MARKETING_FILE: secretFile,
      });

      expect(error).toBeUndefined();
      expect(accounts[0]!.auth!.password.reveal()).toBe(PASSWORD_B);
    });

    it("_FILE이 있으면 파일을 읽지 못해도 환경 변수로 돌아가지 않고 errno 코드만 담아 거부한다", () => {
      const message = expectIssue(
        {
          MAILO_SMTP_ACCOUNTS_FILE: file("sec2.json", {
            accounts: [account()],
          }),
          MAILO_SMTP_SECRET_MARKETING: PASSWORD_A,
          MAILO_SMTP_SECRET_MARKETING_FILE: path.join(dir, "no-such-secret"),
        },
        "MAILO_SMTP_SECRET_MARKETING_FILE이 가리키는 파일을 읽지 못했다(ENOENT)",
      );
      expect(message).not.toContain(PASSWORD_A);
    });

    it("비밀번호는 Secret이라 설정 객체를 찍거나 직렬화해도 값이 나오지 않는다", () => {
      const { accounts } = load({
        ...ENV_DEFAULT,
        MAILO_SMTP_ACCOUNTS_FILE: file("sec3.json", { accounts: [account()] }),
        MAILO_SMTP_SECRET_MARKETING: PASSWORD_B,
      });

      const dump = `${inspect(accounts, { depth: 6 })}${JSON.stringify(accounts)}${String(accounts[1]!.auth!.password)}`;
      expect(dump).not.toContain(PASSWORD_A);
      expect(dump).not.toContain(PASSWORD_B);
    });
  });

  describe("loadConfig 연결(RQ-053)", () => {
    it("loadConfig는 smtpAccounts에 계정 목록을 싣고 오류는 한 번에 모아 던진다", () => {
      const filePath = file("lc.json", { accounts: [account()] });
      const config = loadConfig(
        testEnv({
          MAILO_CALLERS_FILE: "/etc/mailo/callers.json",
          MAILO_SMTP_ACCOUNTS_FILE: filePath,
          MAILO_SMTP_SECRET_MARKETING: PASSWORD_B,
        }),
      );
      // testEnv는 MAILO_SMTP_HOST를 넣으므로 default는 환경 변수 정의다.
      expect(config.smtpAccounts.map((a) => a.id)).toEqual([
        "default",
        "marketing",
      ]);
    });
  });
});
