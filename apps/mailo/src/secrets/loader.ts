import {
  SecretAdapterLoadError,
  type SecretAdapterLoadFailure,
} from "./errors.js";
import {
  RESERVED_SCHEME,
  SCHEME_PATTERN,
  type SecretSource,
} from "./source.js";

/** `import()`를 대신하는 함수. 테스트가 바꿔 끼운다. 기본은 이 파일 위치에서 해석하는 `import()`다. */
export type ImportModule = (specifier: string) => Promise<unknown>;

/**
 * bare 패키지 이름만 받는다. 경로, `file:`·`data:`·`http(s):` URL, `node:` 접두, 하위 경로, 대문자는 거부한다.
 * 쓰기 가능한 볼륨의 파일이 코드로 로드되는 길을 막는다(ADR-0016 결정 3).
 */
const SPECIFIER = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

const defaultImport: ImportModule = (specifier) => import(specifier);

/** `loadSecretAdapters`의 import 제한 시간 기본값(ms). `resolveSecrets`는 해석 제한 시간(`MAILO_SECRET_RESOLVE_TIMEOUT_MS`)을 넘긴다. */
export const DEFAULT_IMPORT_TIMEOUT_MS = 10_000;

class ImportTimeout {}

/**
 * `import()` 하나에 제한 시간을 둔다. 최상위 await가 끝나지 않는 어댑터 모듈은 프라미스가 영원히 대기해
 * 기동이 멈추거나(미해결 최상위 await로 종료 코드 13) 조용히 매달린다. 시간이 지나면 실패로 확정하고,
 * `Promise.race`가 원래 프라미스도 구독하므로 늦은 거부가 미처리 거부가 되지 않는다.
 */
async function importWithTimeout(
  importModule: ImportModule,
  specifier: string,
  timeoutMs: number,
): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ImportTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => importModule(specifier)),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isNotFound(error: unknown, specifier: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND")
    return false;
  // 어댑터 안쪽 의존성이 없어서 난 같은 코드의 오류와 구분한다. 메시지는 판정에만 쓰고 옮기지 않는다.
  return typeof message === "string" && message.includes(`'${specifier}'`);
}

function toSource(module: unknown): SecretSource | undefined {
  if (typeof module !== "object" || module === null) return undefined;
  const candidate = (module as { default?: unknown }).default;
  if (
    (typeof candidate !== "object" && typeof candidate !== "function") ||
    candidate === null
  )
    return undefined;
  const { scheme, resolve } = candidate as {
    scheme?: unknown;
    resolve?: unknown;
  };
  if (
    typeof scheme !== "string" ||
    !SCHEME_PATTERN.test(scheme) ||
    typeof resolve !== "function"
  )
    return undefined;
  return candidate as SecretSource;
}

/**
 * `MAILO_SECRET_ADAPTERS`(쉼표 구분)의 어댑터를 불러와 scheme별 맵으로 돌려준다.
 * 실패는 모아서 `SecretAdapterLoadError`로 던진다. `import()`가 `timeoutMs` 안에 끝나지 않으면 `import-failed`다.
 * 어댑터 코드는 Mailo와 같은 프로세스에서 실행되므로
 * 이 저장소가 이미지에 넣은 패키지만 지정한다(ADR-0016 결정 3의 위협 모델).
 */
export async function loadSecretAdapters(
  adapters: string | undefined,
  importModule: ImportModule = defaultImport,
  timeoutMs: number = DEFAULT_IMPORT_TIMEOUT_MS,
): Promise<ReadonlyMap<string, SecretSource>> {
  const sources = new Map<string, SecretSource>();
  const failures: SecretAdapterLoadFailure[] = [];
  const items = (adapters ?? "").split(",").map((item) => item.trim());
  for (const [index, specifier] of items.entries()) {
    if (specifier === "") continue;
    if (!SPECIFIER.test(specifier)) {
      failures.push({
        label: `${index + 1}번째 항목`,
        kind: "invalid-specifier",
      });
      continue;
    }
    let module: unknown;
    try {
      module = await importWithTimeout(importModule, specifier, timeoutMs);
    } catch (error) {
      failures.push({
        label: specifier,
        // 제한 시간 초과도 `import-failed`다(닫힌 종류를 늘리지 않는다).
        kind: isNotFound(error, specifier) ? "not-found" : "import-failed",
      });
      continue;
    }
    const source = toSource(module);
    if (source === undefined) {
      failures.push({ label: specifier, kind: "invalid-export" });
    } else if (source.scheme === RESERVED_SCHEME) {
      failures.push({ label: specifier, kind: "reserved-scheme" });
    } else if (sources.has(source.scheme)) {
      failures.push({ label: specifier, kind: "duplicate-scheme" });
    } else {
      sources.set(source.scheme, source);
    }
  }
  if (failures.length > 0) throw new SecretAdapterLoadError(failures);
  return sources;
}
