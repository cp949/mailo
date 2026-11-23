/**
 * SMTP 계정 정의와 설정 로드(RQ-053, ADR-0013 결정 1). 계정은 `default` 하나(`MAILO_SMTP_*`)이거나
 * `MAILO_SMTP_ACCOUNTS_FILE`의 JSON이 정의한다. 비밀번호 값은 JSON에 두지 않고 변수 이름(`secretVar`)만 둔다.
 * 값은 `<변수>_FILE`(우선) 또는 `<변수>`로 받는다(호출처 레지스트리의 JWS 키와 같은 방식, RQ-028).
 *
 * 파일 형식
 * ```json
 * {
 *   "accounts": [
 *     {
 *       "id": "marketing",
 *       "host": "smtp.gmail.com",
 *       "port": 587,
 *       "security": "starttls",
 *       "auth": { "user": "marketing@example.com", "secretVar": "MAILO_SMTP_SECRET_MARKETING" },
 *       "from": "marketing@example.com",
 *       "timeoutSeconds": 30
 *     }
 *   ]
 * }
 * ```
 *
 * `default` 계정의 출처는 정확히 하나다(결정 1).
 * - 파일 없음: `MAILO_SMTP_*`가 `default`를 정의한다. `MAILO_SMTP_HOST`가 필수다.
 * - 파일 있음, `MAILO_SMTP_HOST` 있음: `default`는 환경 변수 정의다. 파일에 `id: "default"`가 있으면 거부한다.
 * - 파일 있음, `MAILO_SMTP_HOST` 없음: `default`는 파일에 있으면 그것이고 없으면 `default` 계정이 없다.
 *   이때 `MAILO_SMTP_USER` 같은 다른 `MAILO_SMTP_*`가 있으면 오설정으로 거부한다.
 *
 * 오류 메시지에는 위치(`accounts[2].auth.secretVar`)와 고정 사유만 담는다. host·user·from·비밀번호 값은 담지 않는다(RQ-027).
 */
import { readFileSync } from "node:fs";
import {
  DEFAULT_MAIL_REQUEST_LIMITS,
  checkAddress,
} from "../validation/index.js";
import type { EnvReader } from "./env-reader.js";
import { Secret } from "./secret.js";

/** SMTP 계정 하나의 연결·인증·발신 주소 설정. 비밀번호는 `Secret`이다. */
export interface SmtpAccount {
  /** 계정 ID(`isAccountId`). 환경 변수로 정의한 계정은 `default`다. */
  id: string;
  host: string;
  port: number;
  /**
   * `starttls`: 587 + STARTTLS 필수(기본). `tls`: 465 implicit TLS. `none`: TLS 없는 평문 연결.
   * 연결 보안 방식은 운영자 설정이다. `none`은 NODE_ENV와 무관하게 받고 기동 때 warn 로그를 남긴다(RQ-005).
   */
  security: "starttls" | "tls" | "none";
  /** 인증이 없는 릴레이(IP 허용)는 null이다. */
  auth: { user: string; password: Secret<string> } | null;
  /**
   * 이 계정의 기본 발신 주소. 요청이 `from`을 생략했을 때 쓰고, 이 계정을 쓰는 호출처의 허용 발신 주소 집합에 든다(ADR-0013 결정 6).
   * `Message-ID` 도메인도 이 주소다(ADR-0007 결정 8).
   */
  from: string;
  /** 연결·응답 대기 초. lease보다 작아야 한다(추정). */
  timeoutSeconds: number;
  /**
   * 계정 24시간 발송 할당(결정 3). null이면 무제한이다. 환경 변수로 정의한 `default`는 항상 null이다.
   * 구현 묶음 A는 값을 검증만 하고 점유에 쓰지 않는다. 계정 단위 점유는 묶음 B다.
   */
  sendQuota24h: number | null;
  /**
   * 이 인스턴스가 이 계정에 동시에 쓰는 슬롯 상한(결정 3). null이면 기본식을 쓴다. 환경 변수로 정의한 `default`는 항상 null이다.
   * 구현 묶음 A는 값을 검증만 하고 쓰지 않는다.
   */
  concurrency: number | null;
}

/** 환경 변수(`MAILO_SMTP_*`)가 정의하는 계정의 ID이자 호출처 `accountId`의 기본값. */
export const DEFAULT_SMTP_ACCOUNT_ID = "default";
/** 지표가 구성 밖 계정의 작업에 붙일 값이라 계정 ID로 쓸 수 없다(결정 1). */
export const RESERVED_ACCOUNT_ID = "unregistered";
/** 계정 수 상한. 추정값이다(결정 1). */
export const MAX_SMTP_ACCOUNTS = 20;

const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * 계정 ID 형식. 소문자 영숫자로 시작하는 1~32자이고 `_`·`-`를 쓸 수 있다. `unregistered`는 예약어라 거부한다.
 * `@`와 `.`가 없어 SMTP 사용자 주소를 ID로 쓸 수 없다. 로그·지표 라벨·감사에 주소가 들어가지 않게 하는 구조적 장치다(RQ-027).
 */
export function isAccountId(value: string): boolean {
  return ACCOUNT_ID.test(value) && value !== RESERVED_ACCOUNT_ID;
}

/** SMTP 호스트 이름 형식. 설정 오류를 값 없이 알리려고 검사한다. */
export const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

const SECRET_VAR = /^MAILO_SMTP_SECRET_[A-Z0-9_]{1,40}$/;
const ACCOUNT_FIELDS = new Set([
  "id",
  "host",
  "port",
  "security",
  "auth",
  "from",
  "timeoutSeconds",
  "sendQuota24h",
  "concurrency",
]);
const AUTH_FIELDS = new Set(["user", "secretVar"]);
const SECURITY_VALUES = ["starttls", "tls", "none"] as const;
const MAX_SEND_QUOTA = 10_000_000;
const MAX_AUTH_USER_CHARS = 256;
/** 파일이 있고 `MAILO_SMTP_HOST`가 없을 때 함께 있으면 오설정인 변수. `MAILO_SMTP_TIMEOUT_SECONDS`는 계정의 기본 대기 시간이라 뺀다. */
const ENV_ACCOUNT_VARIABLES = [
  "MAILO_SMTP_USER",
  "MAILO_SMTP_PASSWORD",
  "MAILO_SMTP_PASSWORD_FILE",
  "MAILO_SMTP_FROM",
  "MAILO_SMTP_PORT",
  "MAILO_SMTP_SECURITY",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 필드 이름을 오류에 쓸 때 영숫자·밑줄만 남기고 길이를 제한한다. 이름에 값이 섞이는 것을 막는다. */
function safeName(name: string): string {
  return /^[A-Za-z0-9_]{1,40}$/.test(name) ? name : "(이름 생략)";
}

export interface SmtpAccountsOptions {
  /** `MAILO_LEASE_SECONDS`. 계정의 `timeoutSeconds`는 이 값 미만이어야 한다(ADR-0002 결정 11). */
  leaseSeconds: number;
  /** `MAILO_WORKER_CONCURRENCY`. 계정 수와 `concurrency`의 상한이다(결정 1·3). */
  workerConcurrency: number;
}

/**
 * 환경 변수와 계정 파일에서 SMTP 계정 목록을 만든다. 문제는 `reader`에 모아 `reader.finish()`가 한 번에 던진다.
 * 환경 변수로 정의한 `default`가 목록의 맨 앞이고 파일 계정은 파일 순서다.
 * 오류가 있으면 빈 목록일 수 있다(호출자가 `finish()`로 던진다).
 */
export function loadSmtpAccounts(
  reader: EnvReader,
  options: SmtpAccountsOptions,
): SmtpAccount[] {
  const filePath = reader.raw("MAILO_SMTP_ACCOUNTS_FILE");
  const hasEnvDefault = reader.raw("MAILO_SMTP_HOST") !== undefined;
  const accounts: SmtpAccount[] = [];

  // 기본 대기 시간(`MAILO_SMTP_TIMEOUT_SECONDS`)은 환경 변수 계정과 `timeoutSeconds`를 생략한 파일 계정이 함께 쓴다.
  const defaultTimeout = reader.int("MAILO_SMTP_TIMEOUT_SECONDS", 30, {
    min: 1,
    max: 3600,
  });

  if (filePath === undefined || hasEnvDefault) {
    const account = loadEnvAccount(reader, defaultTimeout, options);
    if (account !== undefined) accounts.push(account);
  } else {
    for (const name of ENV_ACCOUNT_VARIABLES) {
      if (reader.raw(name) !== undefined)
        reader.issue(
          `${name}은 MAILO_SMTP_ACCOUNTS_FILE이 있고 MAILO_SMTP_HOST가 없을 때 쓸 수 없다(default 계정은 파일에서 정의한다)`,
        );
    }
  }

  if (filePath !== undefined) {
    accounts.push(
      ...loadFileAccounts(reader, filePath, defaultTimeout, options, {
        envDefault: accounts.length > 0,
        envUsedKeys: accounts.flatMap((a) => connectionKey(a) ?? []),
      }),
    );
  }

  if (accounts.length > MAX_SMTP_ACCOUNTS)
    reader.issue(`SMTP 계정은 ${MAX_SMTP_ACCOUNTS}개 이하여야 한다`);
  if (accounts.length > options.workerConcurrency)
    reader.issue(
      "SMTP 계정 수는 MAILO_WORKER_CONCURRENCY 이하여야 한다(계정마다 슬롯 하나를 보장한다)",
    );
  return accounts;
}

/**
 * 환경 변수 `MAILO_SMTP_*`로 `default` 계정을 만든다. `MAILO_SMTP_HOST`가 필수다.
 * 계정 한도(`sendQuota24h`)와 `concurrency`는 받지 않는다. 필요하면 `default`를 파일로 옮긴다(결정 1).
 */
function loadEnvAccount(
  reader: EnvReader,
  timeoutSeconds: number,
  options: SmtpAccountsOptions,
): SmtpAccount | undefined {
  const host = reader.requiredString("MAILO_SMTP_HOST");
  if (host !== undefined && !HOSTNAME.test(host.trim())) {
    reader.issue("MAILO_SMTP_HOST는 호스트 이름이어야 한다");
  }
  const security = reader.oneOf(
    "MAILO_SMTP_SECURITY",
    SECURITY_VALUES,
    "starttls",
  );
  const port = reader.int("MAILO_SMTP_PORT", security === "tls" ? 465 : 587, {
    min: 1,
    max: 65535,
  });
  // 전송이 lease보다 오래 걸리면 다른 Worker가 같은 작업을 다시 잡아 중복 발송한다(ADR-0002).
  if (timeoutSeconds >= options.leaseSeconds) {
    reader.issue(
      "MAILO_SMTP_TIMEOUT_SECONDS는 MAILO_LEASE_SECONDS보다 작아야 한다",
    );
  }

  const user = reader.raw("MAILO_SMTP_USER");
  const password = reader.secret("MAILO_SMTP_PASSWORD");
  if ((user === undefined) !== (password === undefined)) {
    reader.issue(
      "MAILO_SMTP_USER와 MAILO_SMTP_PASSWORD(또는 _FILE)는 함께 설정해야 한다",
    );
  }

  const fromRaw = reader.raw("MAILO_SMTP_FROM") ?? user;
  let from: string | undefined;
  if (fromRaw === undefined) {
    reader.issue(
      "MAILO_SMTP_FROM이 필요하다(MAILO_SMTP_USER가 없으면 기본 발신 주소를 정할 수 없다)",
    );
  } else if (
    checkAddress(
      fromRaw.trim(),
      DEFAULT_MAIL_REQUEST_LIMITS.maxAddressChars,
    ) !== undefined
  ) {
    reader.issue(
      "MAILO_SMTP_FROM(없으면 MAILO_SMTP_USER)은 주소 하나여야 한다",
    );
  } else {
    from = fromRaw.trim();
  }

  if (host === undefined || from === undefined) return undefined;
  return {
    id: DEFAULT_SMTP_ACCOUNT_ID,
    host: host.trim(),
    port,
    security,
    auth:
      user !== undefined && password !== undefined
        ? { user, password: new Secret(password) }
        : null,
    from,
    timeoutSeconds,
    sendQuota24h: null,
    concurrency: null,
  };
}

/** 같은 메일박스 판별 키. host·user는 공백을 지우고 대소문자를 무시한다. 인증이 없는 릴레이는 사용자가 없어 키가 없다(주소만 다른 릴레이 계정은 정당할 수 있다). */
function connectionKey(account: SmtpAccount): string | undefined {
  if (account.auth === null) return undefined;
  return `${account.host.trim().toLowerCase()}\n${account.port}\n${account.auth.user.trim().toLowerCase()}`;
}

/** 계정 파일을 읽어 검증한다. 파일 읽기·JSON 오류 사유에는 errno 코드만 적는다. */
function loadFileAccounts(
  reader: EnvReader,
  path: string,
  defaultTimeout: number,
  options: SmtpAccountsOptions,
  env: { envDefault: boolean; envUsedKeys: string[] },
): SmtpAccount[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    reader.issue(`MAILO_SMTP_ACCOUNTS_FILE을 읽지 못했다(${code})`);
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    reader.issue("MAILO_SMTP_ACCOUNTS_FILE이 올바른 JSON이 아니다");
    return [];
  }
  if (!isRecord(json) || !Array.isArray(json["accounts"])) {
    reader.issue("MAILO_SMTP_ACCOUNTS_FILE에는 accounts 배열이 필요하다");
    return [];
  }
  for (const key of Object.keys(json)) {
    if (key !== "accounts")
      reader.issue(
        `MAILO_SMTP_ACCOUNTS_FILE에 알 수 없는 최상위 필드가 있다: ${safeName(key)}`,
      );
  }
  const raw = json["accounts"] as unknown[];
  if (raw.length === 0) {
    reader.issue("accounts 배열이 하나 이상 필요하다");
    return [];
  }

  const accounts: SmtpAccount[] = [];
  const seenIds = new Set<string>();
  const seenSecretVars = new Set<string>();
  const seenConnections = new Set<string>(env.envUsedKeys);
  raw.forEach((entry: unknown, index: number) => {
    const where = `accounts[${index}]`;
    const account = parseAccount(entry, where, reader, defaultTimeout, options);
    if (account === undefined) return;
    if (seenIds.has(account.id)) {
      reader.issue(`${where}.id가 다른 항목과 겹친다`);
      return;
    }
    seenIds.add(account.id);
    if (account.id === DEFAULT_SMTP_ACCOUNT_ID && env.envDefault) {
      reader.issue(
        `${where}.id: MAILO_SMTP_HOST가 default 계정을 정의하므로 파일에 default를 둘 수 없다`,
      );
      return;
    }
    const secretVar = secretVarOf(entry);
    if (secretVar !== undefined) {
      if (seenSecretVars.has(secretVar))
        reader.issue(`${where}.auth.secretVar가 다른 계정과 같은 변수다`);
      seenSecretVars.add(secretVar);
    }
    const key = connectionKey(account);
    if (key !== undefined) {
      if (seenConnections.has(key))
        reader.issue(
          `${where}가 다른 계정과 같은 host·port·user다(같은 메일박스를 계정 둘로 나눌 수 없다)`,
        );
      seenConnections.add(key);
    }
    accounts.push(account);
  });
  return accounts;
}

function secretVarOf(entry: unknown): string | undefined {
  if (!isRecord(entry) || !isRecord(entry["auth"])) return undefined;
  const value = entry["auth"]["secretVar"];
  return typeof value === "string" ? value : undefined;
}

/** 계정 항목 하나를 검증한다. 문제가 있으면 위치와 사유를 `reader`에 쌓고 undefined를 돌려준다. */
function parseAccount(
  raw: unknown,
  where: string,
  reader: EnvReader,
  defaultTimeout: number,
  options: SmtpAccountsOptions,
): SmtpAccount | undefined {
  if (!isRecord(raw)) {
    reader.issue(`${where}은 객체여야 한다`);
    return undefined;
  }
  let ok = true;
  const fail = (message: string): void => {
    reader.issue(message);
    ok = false;
  };
  for (const key of Object.keys(raw)) {
    if (!ACCOUNT_FIELDS.has(key))
      fail(`${where}에 알 수 없는 필드가 있다: ${safeName(key)}`);
  }

  const id = raw["id"];
  if (typeof id !== "string" || !isAccountId(id)) {
    fail(
      `${where}.id는 소문자 영숫자로 시작하는 1~32자(영숫자·_·-)여야 하고 ${RESERVED_ACCOUNT_ID}는 예약어다`,
    );
  }

  const host = raw["host"];
  if (typeof host !== "string" || !HOSTNAME.test(host.trim()))
    fail(`${where}.host는 호스트 이름이어야 한다`);

  let security: SmtpAccount["security"] = "starttls";
  if (raw["security"] !== undefined) {
    const found = SECURITY_VALUES.find((v) => v === raw["security"]);
    if (found === undefined)
      fail(
        `${where}.security는 ${SECURITY_VALUES.join(", ")} 중 하나여야 한다`,
      );
    else security = found;
  }

  const port = integerField(raw["port"], security === "tls" ? 465 : 587, {
    min: 1,
    max: 65535,
  });
  if (port === undefined)
    fail(`${where}.port는 1 이상 65535 이하의 정수여야 한다`);

  let timeoutSeconds = defaultTimeout;
  if (raw["timeoutSeconds"] !== undefined) {
    const value = integerField(raw["timeoutSeconds"], defaultTimeout, {
      min: 1,
      max: 3600,
    });
    if (value === undefined)
      fail(`${where}.timeoutSeconds는 1 이상 3600 이하의 정수여야 한다`);
    else timeoutSeconds = value;
  }
  // 전송이 lease보다 오래 걸리면 다른 Worker가 같은 작업을 다시 잡아 중복 발송한다(ADR-0002 결정 11).
  if (timeoutSeconds >= options.leaseSeconds)
    fail(
      raw["timeoutSeconds"] === undefined
        ? `${where}: 기본 대기 시간(MAILO_SMTP_TIMEOUT_SECONDS)은 MAILO_LEASE_SECONDS보다 작아야 한다`
        : `${where}.timeoutSeconds는 MAILO_LEASE_SECONDS보다 작아야 한다`,
    );

  const auth = parseAuth(raw["auth"], where, reader, fail);

  let from: string | undefined;
  const fromRaw = raw["from"];
  if (fromRaw !== undefined) {
    if (
      typeof fromRaw !== "string" ||
      checkAddress(
        fromRaw.trim(),
        DEFAULT_MAIL_REQUEST_LIMITS.maxAddressChars,
      ) !== undefined
    )
      fail(`${where}.from은 주소 하나여야 한다`);
    else from = fromRaw.trim();
  } else if (auth !== undefined && auth !== null) {
    if (
      checkAddress(
        auth.user.trim(),
        DEFAULT_MAIL_REQUEST_LIMITS.maxAddressChars,
      ) !== undefined
    )
      fail(
        `${where}.from이 필요하다(auth.user가 주소가 아니라 기본 발신 주소를 정할 수 없다)`,
      );
    else from = auth.user.trim();
  } else if (auth === null) {
    fail(`${where}.from이 필요하다(auth가 없으면 생략할 수 없다)`);
  }

  let sendQuota24h: number | null = null;
  if (raw["sendQuota24h"] !== undefined) {
    const value = integerField(raw["sendQuota24h"], 0, {
      min: 1,
      max: MAX_SEND_QUOTA,
    });
    if (value === undefined)
      fail(
        `${where}.sendQuota24h는 1 이상 ${MAX_SEND_QUOTA} 이하의 정수이거나 생략(무제한)이어야 한다`,
      );
    else sendQuota24h = value;
  }
  let concurrency: number | null = null;
  if (raw["concurrency"] !== undefined) {
    const value = integerField(raw["concurrency"], 0, {
      min: 1,
      max: options.workerConcurrency,
    });
    if (value === undefined)
      fail(
        `${where}.concurrency는 1 이상 MAILO_WORKER_CONCURRENCY 이하의 정수여야 한다`,
      );
    else concurrency = value;
  }

  if (
    !ok ||
    typeof id !== "string" ||
    typeof host !== "string" ||
    port === undefined ||
    from === undefined ||
    auth === undefined
  )
    return undefined;
  return {
    id,
    host: host.trim(),
    port,
    security,
    auth,
    from,
    timeoutSeconds,
    sendQuota24h,
    concurrency,
  };
}

/** 정수 필드. 생략하면 `fallback`이고 형식·범위가 틀리면 undefined다. */
function integerField(
  value: unknown,
  fallback: number,
  range: { min: number; max: number },
): number | undefined {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < range.min ||
    value > range.max
  )
    return undefined;
  return value;
}

/**
 * `auth`를 읽는다. 생략하면 인증 없는 릴레이(null)다. 문제가 있으면 undefined다.
 * 비밀번호는 `secretVar`가 가리키는 `<변수>_FILE`(우선) 또는 `<변수>`에서 읽는다.
 */
function parseAuth(
  raw: unknown,
  where: string,
  reader: EnvReader,
  fail: (message: string) => void,
): SmtpAccount["auth"] | undefined {
  if (raw === undefined) return null;
  const at = `${where}.auth`;
  if (!isRecord(raw)) {
    fail(`${at}는 user와 secretVar를 가진 객체여야 한다`);
    return undefined;
  }
  let ok = true;
  for (const key of Object.keys(raw)) {
    if (!AUTH_FIELDS.has(key)) {
      fail(`${at}에 알 수 없는 필드가 있다: ${safeName(key)}`);
      ok = false;
    }
  }
  const user = raw["user"];
  if (
    typeof user !== "string" ||
    user.trim() === "" ||
    user.length > MAX_AUTH_USER_CHARS
  ) {
    fail(
      `${at}.user는 비어 있지 않은 ${MAX_AUTH_USER_CHARS}자 이하 문자열이어야 한다`,
    );
    ok = false;
  }
  const variable = raw["secretVar"];
  if (
    typeof variable !== "string" ||
    !SECRET_VAR.test(variable) ||
    variable.endsWith("_FILE")
  ) {
    fail(
      `${at}.secretVar는 MAILO_SMTP_SECRET_으로 시작하는 대문자 변수 이름이어야 하고 _FILE로 끝날 수 없다`,
    );
    return undefined;
  }
  const password = reader.secret(variable);
  if (password === undefined) {
    // 파일 읽기 실패는 reader가 이미 기록했다.
    if (
      reader.raw(variable) === undefined &&
      reader.raw(`${variable}_FILE`) === undefined
    )
      fail(`${variable} 또는 ${variable}_FILE이 필요하다(${at}.secretVar)`);
    else ok = false;
    return undefined;
  }
  if (!ok || typeof user !== "string") return undefined;
  return { user, password: new Secret(password) };
}
