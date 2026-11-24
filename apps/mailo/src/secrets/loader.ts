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
 * 실패는 모아서 `SecretAdapterLoadError`로 던진다. 어댑터 코드는 Mailo와 같은 프로세스에서 실행되므로
 * 이 저장소가 이미지에 넣은 패키지만 지정한다(ADR-0016 결정 3의 위협 모델).
 */
export async function loadSecretAdapters(
  adapters: string | undefined,
  importModule: ImportModule = defaultImport,
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
      module = await importModule(specifier);
    } catch (error) {
      failures.push({
        label: specifier,
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
