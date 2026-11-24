import {
  SecretResolutionError,
  SecretSettingsError,
  type SecretFailure,
  type SecretFailureKind,
} from "./errors.js";
import { loadSecretAdapters, type ImportModule } from "./loader.js";
import {
  RESERVED_SCHEME,
  SECRET_ERROR_CODES,
  type SecretErrorCode,
  type SecretSource,
} from "./source.js";

/** 비밀값을 받을 변수 이름 규칙. 고정 이름이거나 이름 규칙(정규식)이다. 정규식에 `g`·`y` 플래그를 쓰지 않는다. */
export type SecretNameRule =
  | { readonly name: string }
  | { readonly pattern: RegExp };

/** 로그 출력. `secrets_resolved` 한 줄에만 쓴다. `logging`의 `AppLogger`가 이 구조를 만족한다. */
export interface SecretsLogger {
  info(event: string, fields?: Record<string, string | number>): void;
}

export interface ResolveSecretsOptions {
  /** 해석 대상 이름 규칙. 호출자(앱 조립)가 정한다. 이 모듈은 다른 모듈의 이름 규칙을 알지 못한다(leaf). */
  names: readonly SecretNameRule[];
  /**
   * 있으면 이름이 이 접두어로 시작하고 `_REF`로 끝나는데 `names`에 없는 변수를 `unknown-name`으로 거부한다.
   * 오타가 조용히 무시되어 평문 값으로 기동하는 일을 막는다. 마이그레이션 CLI(DB 비밀만 해석)는 생략한다.
   */
  rejectUnknown?: { prefix: string };
  importModule?: ImportModule;
  logger?: SecretsLogger;
}

const ADAPTERS_VARIABLE = "MAILO_SECRET_ADAPTERS";
const TIMEOUT_VARIABLE = "MAILO_SECRET_RESOLVE_TIMEOUT_MS";
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;
const REF_SUFFIX = "_REF";
const FILE_SUFFIX = "_FILE";
const REF_FORMAT = /^([a-z][a-z0-9+.-]*):\/\/[\s\S]+$/;

function nonEmpty(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function readTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = nonEmpty(env, TIMEOUT_VARIABLE);
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const text = raw.trim();
  const parsed = /^\d{1,15}$/.test(text) ? Number(text) : Number.NaN;
  if (!(parsed >= MIN_TIMEOUT_MS && parsed <= MAX_TIMEOUT_MS))
    throw new SecretSettingsError(
      `${TIMEOUT_VARIABLE}은 ${MIN_TIMEOUT_MS} 이상 ${MAX_TIMEOUT_MS} 이하의 정수여야 한다`,
    );
  return parsed;
}

function matches(rules: readonly SecretNameRule[], name: string): boolean {
  return rules.some((rule) =>
    "name" in rule ? rule.name === name : rule.pattern.test(name),
  );
}

/** 어댑터가 던진 오류의 `code` 중 닫힌 집합에 있는 것만 꺼낸다. 메시지와 그 밖의 필드는 읽지 않는다. */
function closedCode(error: unknown): SecretErrorCode | undefined {
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" &&
      (SECRET_ERROR_CODES as readonly string[]).includes(code)
      ? (code as SecretErrorCode)
      : undefined;
  } catch {
    return undefined;
  }
}

class TimeoutSignal {}

/**
 * 어댑터 호출 하나. timeout이 지나면 `signal`을 abort하고, 어댑터가 `signal`을 무시해도 그 시점에 실패로 확정한다.
 * `Promise.race`가 `work`의 거부도 구독하므로 확정 뒤 어댑터의 늦은 거부는 미처리 거부가 되지 않는다. 코어는 재시도하지 않는다.
 */
async function callAdapter(
  source: SecretSource,
  ref: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutSignal());
    }, timeoutMs);
  });
  const work = Promise.resolve().then(() =>
    source.resolve(ref, { signal: controller.signal }),
  );
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface Target {
  variable: string;
  ref: string;
  scheme: string;
}

type Outcome =
  | { ok: true; variable: string; scheme: string; value: string }
  | { ok: false; failure: SecretFailure };

async function resolveTarget(
  target: Target,
  source: SecretSource,
  timeoutMs: number,
): Promise<Outcome> {
  const fail = (kind: SecretFailureKind): Outcome => ({
    ok: false,
    failure: {
      variable: target.variable,
      method: `ref:${target.scheme}`,
      kind,
    },
  });
  let value: unknown;
  try {
    value = await callAdapter(source, target.ref, timeoutMs);
  } catch (error) {
    if (error instanceof TimeoutSignal) return fail("timeout");
    const code = closedCode(error);
    return fail(code === undefined ? "adapter-error" : `adapter-error:${code}`);
  }
  if (typeof value !== "string") return fail("adapter-error");
  if (value === "") return fail("empty");
  return { ok: true, variable: target.variable, scheme: target.scheme, value };
}

/**
 * `X_REF=<scheme>://<참조>`를 기동 전에 한 번 해석해 환경 복사본에 `X`로 채운다(ADR-0016 결정 1·2).
 * - 입력 `env`와 `process.env`는 바꾸지 않는다. 해석 대상이 없으면 입력과 같은 내용의 새 객체를 돌려준다.
 * - `X_REF`와 `X` 또는 `X_FILE`이 함께 비어 있지 않으면 `conflict`다. 빈 문자열은 지정하지 않은 것이다.
 * - 하나라도 실패하면 어떤 값도 돌려주지 않고 실패를 모아 `SecretResolutionError`를 던진다.
 * - 값은 기동 때 한 번만 읽는다. 재조회와 캐시는 없다(결정 7).
 * 오류와 로그에는 변수 이름·방식·고정 종류만 싣는다. 값, 참조 문자열, 어댑터 오류 메시지는 싣지 않는다(RQ-027).
 */
export async function resolveSecrets(
  env: NodeJS.ProcessEnv,
  options: ResolveSecretsOptions,
): Promise<NodeJS.ProcessEnv> {
  // 설정 검증과 어댑터 로드는 해석보다 먼저다. 둘은 해석 오류와 함께 보고하지 않는다.
  const timeoutMs = readTimeoutMs(env);
  const adapters = await loadSecretAdapters(
    nonEmpty(env, ADAPTERS_VARIABLE),
    options.importModule,
  );

  const failures: SecretFailure[] = [];
  const pending: Array<Promise<Outcome>> = [];
  for (const key of Object.keys(env).sort()) {
    if (!key.endsWith(REF_SUFFIX)) continue;
    const ref = nonEmpty(env, key);
    if (ref === undefined) continue;
    const variable = key.slice(0, -REF_SUFFIX.length);

    const known = matches(options.names, variable);
    const reserved =
      variable.endsWith(FILE_SUFFIX) || variable.endsWith(REF_SUFFIX);
    if (!known || reserved) {
      // 규칙에 맞는 이름이 `_FILE`·`_REF`로 끝나면 다른 변수의 참조와 겹치므로 알 수 없는 이름이다.
      // 규칙에 없는 이름은 `rejectUnknown`의 접두어로 시작할 때만 거부한다(범위 밖 변수는 무시).
      const prefix = options.rejectUnknown?.prefix;
      if (
        (known && reserved) ||
        (prefix !== undefined && key.startsWith(prefix))
      )
        failures.push({ variable: key, method: "ref", kind: "unknown-name" });
      continue;
    }

    const hasEnv = nonEmpty(env, variable) !== undefined;
    const hasFile = nonEmpty(env, `${variable}${FILE_SUFFIX}`) !== undefined;
    if (hasEnv || hasFile) {
      const method = `${hasEnv ? "env+" : ""}${hasFile ? "file+" : ""}ref`;
      failures.push({ variable, method, kind: "conflict" });
      continue;
    }

    const scheme = REF_FORMAT.exec(ref)?.[1];
    if (scheme === undefined) {
      failures.push({ variable, method: "ref", kind: "invalid-ref" });
      continue;
    }
    if (scheme === RESERVED_SCHEME) {
      failures.push({ variable, method: "ref", kind: "reserved-scheme" });
      continue;
    }
    const source = adapters.get(scheme);
    if (source === undefined) {
      // 등록되지 않은 scheme은 오타나 비밀 값일 수 있어 방식에 싣지 않는다.
      failures.push({ variable, method: "ref", kind: "unknown-scheme" });
      continue;
    }
    pending.push(resolveTarget({ variable, ref, scheme }, source, timeoutMs));
  }

  const outcomes = await Promise.all(pending);
  const resolved: Array<{ variable: string; scheme: string; value: string }> =
    [];
  for (const outcome of outcomes) {
    if (outcome.ok) resolved.push(outcome);
    else failures.push(outcome.failure);
  }
  if (failures.length > 0)
    throw new SecretResolutionError(
      failures.sort((a, b) =>
        a.variable < b.variable ? -1 : a.variable > b.variable ? 1 : 0,
      ),
    );

  const copy: NodeJS.ProcessEnv = { ...env };
  for (const item of resolved) copy[item.variable] = item.value;
  if (resolved.length > 0)
    options.logger?.info("secrets_resolved", {
      count: resolved.length,
      schemes: [...new Set(resolved.map((r) => r.scheme))].sort().join(","),
    });
  return copy;
}
