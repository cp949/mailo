import { describe, expect, it } from "@jest/globals";
import type pg from "pg";
import { loadConfig, type SmtpAccount } from "../../src/config/index.js";
import { createJsonLogger } from "../../src/logging/index.js";
import type { BodyCipher } from "../../src/queue/index.js";
import type { MailSender } from "../../src/smtp/index.js";
import {
  createWorker,
  createWorkerRunner,
  defaultWorkerOptions,
  reportAccountConfig,
} from "../../src/worker/index.js";
import { testEnv } from "../support/rest-app.js";

/**
 * 기동 때 계정 구성 점검과 Worker의 계정 조립(RQ-053·055, ADR-0013 결정 1·2·3 나).
 * 환경: 없음. DB·SMTP에 접속하지 않는다(풀은 가짜다).
 */

function account(
  id: string,
  overrides: Partial<SmtpAccount> = {},
): SmtpAccount {
  return {
    id,
    host: `${id}.host-canary.example.invalid`,
    port: 587,
    security: "starttls",
    auth: null,
    from: `${id}-from-canary@example.com`,
    timeoutSeconds: 30,
    sendQuota24h: null,
    concurrency: null,
    ...overrides,
  };
}

function collect() {
  const lines: string[] = [];
  const logger = createJsonLogger((line) => void lines.push(line), {
    instance: "t",
  });
  const events = () =>
    lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, lines, events };
}

describe("기동 때 계정 구성 점검(ADR-0013 결정 1·6)", () => {
  it("어느 호출처도 참조하지 않는 계정은 info account_unused로 알린다", () => {
    const { logger, events } = collect();

    reportAccountConfig(
      logger,
      [account("default"), account("idle")],
      [{ id: "alpha", accountId: "default", allowedFrom: [] }],
    );

    expect(events().filter((e) => e["event"] === "account_unused")).toEqual([
      expect.objectContaining({
        level: "info",
        event: "account_unused",
        accountId: "idle",
      }),
    ]);
  });

  it("allowedFrom이 다른 계정의 from과 같으면(대소문자 무시) warn allowed_from_other_account를 호출처마다 한 번 남긴다", () => {
    const { logger, events } = collect();

    reportAccountConfig(
      logger,
      [account("default"), account("mk")],
      [
        {
          id: "alpha",
          accountId: "default",
          allowedFrom: ["MK-FROM-CANARY@example.com", "other@example.com"],
        },
        { id: "beta", accountId: "mk", allowedFrom: ["unrelated@example.com"] },
      ],
    );

    const found = events().filter(
      (e) => e["event"] === "allowed_from_other_account",
    );
    expect(found).toEqual([
      expect.objectContaining({ level: "warn", callerId: "alpha" }),
    ]);
  });

  it("호출처 자기 계정의 from과 같은 allowedFrom은 알리지 않는다", () => {
    const { logger, lines } = collect();

    reportAccountConfig(
      logger,
      [account("default")],
      [
        {
          id: "alpha",
          accountId: "default",
          allowedFrom: ["default-from-canary@example.com"],
        },
      ],
    );

    expect(lines.join("\n")).not.toContain("allowed_from_other_account");
  });

  it("한도(sendQuota24h·concurrency)를 설정한 계정은 아직 쓰지 않는다고 warn으로 알린다(묶음 A)", () => {
    const { logger, events } = collect();

    reportAccountConfig(
      logger,
      [
        account("default", { sendQuota24h: 400 }),
        account("mk", { concurrency: 2 }),
        account("plain"),
      ],
      [
        { id: "a", accountId: "default", allowedFrom: [] },
        { id: "b", accountId: "mk", allowedFrom: [] },
        { id: "c", accountId: "plain", allowedFrom: [] },
      ],
    );

    expect(
      events()
        .filter((e) => e["event"] === "account_limits_not_enforced")
        .map((e) => e["accountId"]),
    ).toEqual(["default", "mk"]);
  });

  it("어떤 점검 로그에도 host·from 값이 없다(RQ-027)", () => {
    const { logger, lines } = collect();

    reportAccountConfig(
      logger,
      [
        account("default", { sendQuota24h: 10 }),
        account("mk"),
        account("idle"),
      ],
      [
        {
          id: "a",
          accountId: "default",
          allowedFrom: ["mk-from-canary@example.com"],
        },
        { id: "b", accountId: "mk", allowedFrom: [] },
      ],
    );

    const text = lines.join("\n");
    expect(text).not.toContain("canary");
    expect(text).not.toContain("example.invalid");
  });
});

describe("Worker의 계정 조립(RQ-054, ADR-0013 결정 2·3 나)", () => {
  const sender: MailSender = {
    send: () => Promise.reject(new Error("쓰이지 않는다")),
  };
  const deps = { pool: {} as pg.Pool, bodyCipher: {} as BodyCipher };

  it("accounts와 단일 계정 형태(sender·defaultFrom)를 함께 주면 던진다", () => {
    expect(() =>
      createWorker(
        {
          ...deps,
          accounts: new Map([["default", { sender, from: "a@example.com" }]]),
          sender,
        },
        defaultWorkerOptions(),
      ),
    ).toThrow("함께 쓸 수 없다");
  });

  it("계정이 없으면 던진다", () => {
    expect(() => createWorker({ ...deps }, defaultWorkerOptions())).toThrow(
      "accounts 또는 sender와 defaultFrom이 필요하다",
    );
    expect(() =>
      createWorker({ ...deps, accounts: new Map() }, defaultWorkerOptions()),
    ).toThrow("accounts가 비어 있다");
  });

  it("sender 하나만 주고 defaultFrom을 빼면 던진다", () => {
    expect(() =>
      createWorker({ ...deps, sender }, defaultWorkerOptions()),
    ).toThrow("accounts 또는 sender와 defaultFrom이 필요하다");
  });

  it("차단기 행을 만들지 못하면 start()가 실패하고 Worker는 시작하지 않는다(fail-closed)", async () => {
    const failing = {
      query: () => Promise.reject(new Error("db down")),
    } as unknown as pg.Pool;
    const lines: string[] = [];
    const worker = createWorkerRunner({
      pool: failing,
      config: loadConfig(
        testEnv({ MAILO_CALLERS_FILE: "/unused/callers.json" }),
      ),
      bodyCipher: {} as BodyCipher,
      logger: createJsonLogger((line) => void lines.push(line)),
      sender,
    });

    await expect(worker.start()).rejects.toThrow("db down");

    expect(worker.status().state).toBe("idle");
    expect(lines.join("\n")).not.toContain("worker_started");
  });
});
