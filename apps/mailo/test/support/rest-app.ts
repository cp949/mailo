import type { INestApplication, LoggerService } from "@nestjs/common";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import { createApp } from "../../src/app.js";
import type { AppModuleOptions } from "../../src/app.module.js";
import { loadConfig, type AppConfig } from "../../src/config/index.js";
import { hashApiKey } from "../../src/crypto/index.js";
import type { WorkerRunner } from "../../src/worker-port.js";

// 테스트용 가짜 값이다. 실제 시크릿이 아니다.
export const ALPHA_KEY = "alpha-fake-api-key-0000000000000000000000001";
export const ALPHA_KEY_NEXT = "alpha-fake-api-key-0000000000000000000000002";
export const BETA_KEY = "beta-fake-api-key-00000000000000000000000001";
const DB_KEY_B64 = Buffer.alloc(32, 11).toString("base64");
const FINGERPRINT_KEY_B64 = Buffer.alloc(32, 22).toString("base64");

/** 로그·응답에 나오면 안 되는 문자열. 본문, 제목, 수신자, SMTP 비밀번호에 심는다. */
export const CANARY = {
  subject: "CANARY-SUBJECT-7f3a",
  text: "CANARY-TEXT-91bc",
  html: "CANARY-HTML-5d20",
  recipient: "canary-recipient-a8e1",
  smtpPassword: "CANARY-SMTP-PASSWORD-c4d9",
  key: "CANARY-IDEMPOTENCY-KEY-2e6b",
  field: "canaryField7d1",
};

export function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    MAILO_DATABASE_URL:
      process.env.MAILO_TEST_DATABASE_URL ||
      "postgres://mailo:mailo-dev-password@localhost:5432/mailo",
    MAILO_SMTP_HOST: "smtp.example.invalid",
    MAILO_SMTP_USER: "fake-user@example.invalid",
    MAILO_SMTP_PASSWORD: CANARY.smtpPassword,
    MAILO_DB_ENCRYPTION_KEY_V1: DB_KEY_B64,
    MAILO_FINGERPRINT_KEY_V1: FINGERPRINT_KEY_B64,
    ...overrides,
  };
}

/**
 * 호출처 레지스트리 파일을 임시 디렉터리에 쓴다. alpha는 키 2개, beta는 키 1개다.
 * `fileChannel`에 든 호출처만 파일 폴더를 쓴다(기본은 없음).
 */
export function writeCallersFile(
  dir: string,
  fileChannel: readonly string[] = [],
): string {
  const file = path.join(dir, "callers.json");
  writeFileSync(
    file,
    JSON.stringify({
      callers: [
        {
          id: "alpha",
          apiKeyHashes: [hashApiKey(ALPHA_KEY), hashApiKey(ALPHA_KEY_NEXT)],
          fileChannel: fileChannel.includes("alpha"),
          signature: { mode: "none" },
        },
        {
          id: "beta",
          apiKeyHashes: [hashApiKey(BETA_KEY)],
          fileChannel: fileChannel.includes("beta"),
          signature: { mode: "none" },
        },
      ],
    }),
  );
  return file;
}

export interface CapturedLogs {
  lines: string[];
  logger: LoggerService;
  stop(): void;
}

/** Nest 로거와 stdout·stderr 쓰기를 모두 모은다. 어느 경로로 새도 canary 검색에 걸리게 한다. */
export function captureLogs(): CapturedLogs {
  const lines: string[] = [];
  const text = (args: unknown[]): string =>
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const logger: LoggerService = {
    log: (...args: unknown[]) => void lines.push(text(args)),
    error: (...args: unknown[]) => void lines.push(text(args)),
    warn: (...args: unknown[]) => void lines.push(text(args)),
    debug: (...args: unknown[]) => void lines.push(text(args)),
    verbose: (...args: unknown[]) => void lines.push(text(args)),
  };
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const record =
    (original: typeof process.stdout.write) =>
    (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      lines.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
  process.stdout.write = record(out) as typeof process.stdout.write;
  process.stderr.write = record(err) as typeof process.stderr.write;
  return {
    lines,
    logger,
    stop() {
      process.stdout.write = out;
      process.stderr.write = err;
    },
  };
}

export interface RestApp {
  app: INestApplication;
  baseUrl: string;
  config: AppConfig;
  logs: CapturedLogs;
  close(): Promise<void>;
}

export interface StartRestAppOptions {
  pool: pg.Pool;
  env?: NodeJS.ProcessEnv;
  workerRunner?: WorkerRunner;
  /** 설정으로 만든 실제 Worker를 기동한다(e2e). `workerRunner`가 있으면 무시된다. */
  worker?: AppModuleOptions["worker"];
  /** 파일 폴더를 쓰는 호출처 ID. `MAILO_FILE_CHANNEL_ROOT`와 함께 쓴다. */
  fileChannelCallers?: readonly string[];
}

/** 전용 schema 풀을 주입해 앱을 임의 포트로 띄운다. 풀은 앱이 닫지 않는다. */
export async function startRestApp(
  options: StartRestAppOptions,
): Promise<RestApp> {
  const dir = mkdtempSync(path.join(tmpdir(), "mailo-rest-"));
  const logs = captureLogs();
  const env = testEnv({
    MAILO_CALLERS_FILE: writeCallersFile(dir, options.fileChannelCallers),
    ...options.env,
  });
  const config = loadConfig(env);
  let app: INestApplication;
  try {
    app = await createApp({
      config,
      env,
      pool: options.pool,
      ...(options.workerRunner ? { workerRunner: options.workerRunner } : {}),
      ...(options.worker ? { worker: options.worker } : {}),
    });
    app.useLogger(logs.logger);
    await app.listen(0, "127.0.0.1");
  } catch (error) {
    // 기동에 실패해도 stdout 가로채기와 임시 파일을 남기지 않는다.
    logs.stop();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const { port } = app.getHttpServer().address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    config,
    logs,
    async close() {
      await app.close();
      logs.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

export interface MailBody {
  to: string[];
  [key: string]: unknown;
}

export function plainMail(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    to: ["kim@example.com"],
    from: "no-reply@example.com",
    subject: "주문 접수 안내",
    text: "주문이 접수되었습니다.",
    ...overrides,
  };
}

export async function postJob(
  app: RestApp,
  options: {
    key?: string | null;
    auth?: string | null;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (options.key !== null)
    headers["Idempotency-Key"] = options.key ?? "outbox-1";
  const auth = options.auth === undefined ? ALPHA_KEY : options.auth;
  if (auth !== null) headers["Authorization"] = `Bearer ${auth}`;
  return fetch(`${app.baseUrl}/jobs`, {
    method: "POST",
    headers,
    body:
      typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body ?? plainMail()),
  });
}

export async function getJson(
  app: RestApp,
  pathAndQuery: string,
  auth: string | null = ALPHA_KEY,
): Promise<Response> {
  return fetch(`${app.baseUrl}${pathAndQuery}`, {
    headers: auth === null ? {} : bearer(auth),
  });
}
