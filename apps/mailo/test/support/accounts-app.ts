import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import { ensureBreakerRows } from "../../src/queue/index.js";
import {
  startRestApp,
  type RestApp,
  type StartRestAppOptions,
} from "./rest-app.js";

// 테스트용 가짜 값이다. 실제 시크릿이 아니다.
export const OPS_READ = "ops-read-token-accounts-0000000000000000001";
export const OPS_ADMIN = "ops-admin-oncall-accounts-token-00000000001";

/**
 * 다중 계정 운영 표면 시험용 시크릿 canary. 계정 파일과 환경 변수에만 넣고 어떤 응답·로그에도 나오면 안 된다(RQ-027, ADR-0013 결정 6).
 */
export const ACCOUNT_CANARY = {
  defaultUser: "canary-default-login-3f9a@example.invalid",
  defaultPassword: "CANARY-DEFAULT-PASSWORD-91ac",
  marketingHost: "smtp.canary-marketing-host.invalid",
  marketingUser: "canary-marketing-login-7b2d@example.invalid",
  marketingFrom: "canary-marketing-from-55e1@marketing.example.net",
  marketingPassword: "CANARY-MARKETING-PASSWORD-77aa",
};

/** 응답·로그에서 검색할 문자열 전체. */
export const ACCOUNT_CANARY_VALUES = Object.values(ACCOUNT_CANARY);

export function marketingAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "marketing",
    host: ACCOUNT_CANARY.marketingHost,
    port: 587,
    auth: {
      user: ACCOUNT_CANARY.marketingUser,
      secretVar: "MAILO_SMTP_SECRET_MARKETING",
    },
    from: ACCOUNT_CANARY.marketingFrom,
    sendQuota24h: 5,
    ...overrides,
  };
}

export interface AccountsApp extends RestApp {
  /** 계정 파일과 임시 폴더를 지우고 앱을 닫는다. */
  close(): Promise<void>;
}

export interface StartAccountsAppOptions extends Pick<
  StartRestAppOptions,
  "worker" | "callerFields"
> {
  pool: pg.Pool;
  /** 계정 파일의 계정. 생략하면 `marketing` 하나다. 빈 배열이면 계정 파일 없이 `default`만 쓴다. */
  accounts?: unknown[];
  env?: NodeJS.ProcessEnv;
  /** 기동 전에 차단기 행을 만든다(Worker를 켜지 않은 앱은 만들지 않는다). 기본 true. */
  ensureRows?: boolean;
}

/**
 * 계정 `default`(환경 변수)와 파일 계정을 가진 앱을 띄운다. 호출처 `beta`는 `marketing` 계정을 쓰고 `alpha`는 `default`다.
 * 읽기 토큰(`OPS_READ`)과 관리 토큰(`OPS_ADMIN`, 이름 `oncall`)이 있다. Worker는 기본으로 켜지 않는다.
 */
export async function startAccountsApp(
  options: StartAccountsAppOptions,
): Promise<AccountsApp> {
  const dir = mkdtempSync(path.join(tmpdir(), "mailo-accounts-app-"));
  const accounts = options.accounts ?? [marketingAccount()];
  const file = path.join(dir, "accounts.json");
  const useFile = accounts.length > 0;
  if (useFile) writeFileSync(file, JSON.stringify({ accounts }));
  if (options.ensureRows !== false) {
    const ids = ["default", ...accounts.map((a) => (a as { id: string }).id)];
    await ensureBreakerRows(options.pool, ids);
  }
  try {
    const app = await startRestApp({
      pool: options.pool,
      env: {
        MAILO_SMTP_USER: ACCOUNT_CANARY.defaultUser,
        MAILO_SMTP_PASSWORD: ACCOUNT_CANARY.defaultPassword,
        MAILO_OPS_TOKEN: OPS_READ,
        MAILO_OPS_ADMIN_NAMES: "oncall",
        MAILO_OPS_ADMIN_TOKEN_ONCALL: OPS_ADMIN,
        ...(useFile && {
          MAILO_SMTP_ACCOUNTS_FILE: file,
          MAILO_SMTP_SECRET_MARKETING: ACCOUNT_CANARY.marketingPassword,
        }),
        ...options.env,
      },
      callerFields: options.callerFields ?? {
        beta: { accountId: "marketing" },
      },
      ...(options.worker ? { worker: options.worker } : {}),
    });
    return {
      ...app,
      async close() {
        try {
          await app.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** 운영 토큰으로 `/ops`·`/health` 같은 경로를 부른다. */
export function opsFetch(
  app: RestApp,
  method: string,
  route: string,
  token: string | null = OPS_READ,
): Promise<Response> {
  return fetch(`${app.baseUrl}${route}`, {
    method,
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
}
