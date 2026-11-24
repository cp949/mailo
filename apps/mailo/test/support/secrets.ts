import type { SecretSource } from "../../src/secrets/index.js";

/** 테스트용 가짜 값이다. 실제 시크릿이 아니다. */
export const CANARY_VALUE = "CANARY-SECRET-VALUE-8d41c7";
export const CANARY_MESSAGE = "CANARY-ADAPTER-MESSAGE-3be9f0";
export const CANARY_REF = "CANARY-REF-SECRET-ID-62a1d5";

export interface FakeSourceOptions {
  scheme?: string;
  /** ref 전체(예: `fake://db`) -> 값. 없는 ref는 `not-found` 코드로 거부한다. */
  values?: Record<string, string>;
  /** 직접 동작을 정한다. 값을 주면 `values`보다 우선한다. */
  resolve?: SecretSource["resolve"];
}

export interface FakeSource extends SecretSource {
  readonly calls: Array<{ ref: string; signal: AbortSignal }>;
}

/** 어댑터 오류. 메시지에 canary를 싣는다(코어가 메시지를 버리는지 확인한다). */
export class FakeAdapterError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string = `adapter failed ${CANARY_MESSAGE} ${CANARY_VALUE}`,
  ) {
    super(message);
    this.name = "FakeAdapterError";
  }
}

export function fakeSource(options: FakeSourceOptions = {}): FakeSource {
  const calls: FakeSource["calls"] = [];
  return {
    scheme: options.scheme ?? "fake",
    calls,
    async resolve(ref, opts) {
      calls.push({ ref, signal: opts.signal });
      if (options.resolve !== undefined) return options.resolve(ref, opts);
      const value = options.values?.[ref];
      if (value === undefined) throw new FakeAdapterError("not-found");
      return value;
    },
  };
}

/** `importModule` 대역. 지정자별로 모듈 객체(또는 던질 오류)를 준다. */
export function fakeImporter(
  modules: Record<string, unknown>,
): (specifier: string) => Promise<unknown> {
  return async (specifier) => {
    if (!(specifier in modules)) {
      throw Object.assign(
        new Error(`Cannot find package '${specifier}' imported from /x`),
        { code: "ERR_MODULE_NOT_FOUND" },
      );
    }
    const found = modules[specifier];
    if (found instanceof Error) throw found;
    return found;
  };
}
