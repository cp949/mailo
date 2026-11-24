import type { SecretErrorCode } from "./source.js";

/**
 * 비밀값 해석 실패 종류(ADR-0016 결정 5). 값, `X_REF` 참조 문자열, 어댑터 오류 메시지는 어디에도 싣지 않는다(RQ-027).
 * `adapter-error:<code>`의 코드는 닫힌 집합(`SecretErrorCode`)뿐이다.
 */
export type SecretFailureKind =
  | "conflict"
  | "empty"
  | "invalid-ref"
  | "reserved-scheme"
  | "unknown-scheme"
  | "unknown-name"
  | "timeout"
  | "adapter-error"
  | `adapter-error:${SecretErrorCode}`;

export interface SecretFailure {
  /** 비밀값을 받을 변수 이름(`X`). `unknown-name`은 참조 변수 이름(`X_REF`)이다. */
  readonly variable: string;
  /** 지정 방식. 충돌은 `env+ref`·`file+ref`·`env+file+ref`, 그 밖은 `ref` 또는 등록된 scheme을 붙인 `ref:<scheme>`이다. */
  readonly method: string;
  readonly kind: SecretFailureKind;
}

/** `X_REF` 해석 실패. 실패한 변수를 모두 모아 한 번에 던진다. 메시지는 변수 이름·방식·고정 종류만 담는다. */
export class SecretResolutionError extends Error {
  constructor(readonly failures: readonly SecretFailure[]) {
    super(
      failures
        .map((f) => `비밀값 해석 실패: ${f.variable}(${f.method}): ${f.kind}`)
        .join("\n"),
    );
    this.name = "SecretResolutionError";
  }
}

export type SecretAdapterLoadKind =
  | "invalid-specifier"
  | "not-found"
  | "import-failed"
  | "invalid-export"
  | "reserved-scheme"
  | "duplicate-scheme";

export interface SecretAdapterLoadFailure {
  /** 지정자가 bare 패키지 이름 규칙을 통과하면 그 이름, 아니면 `<n>번째 항목`이다(URL의 자격 증명이 새지 않게 원문을 싣지 않는다). */
  readonly label: string;
  readonly kind: SecretAdapterLoadKind;
}

/** 어댑터 로드 실패(`MAILO_SECRET_ADAPTERS`). `import()`가 던진 오류 메시지는 옮기지 않는다. */
export class SecretAdapterLoadError extends Error {
  constructor(readonly failures: readonly SecretAdapterLoadFailure[]) {
    super(
      failures
        .map((f) => `비밀값 어댑터 로드 실패: ${f.label}: ${f.kind}`)
        .join("\n"),
    );
    this.name = "SecretAdapterLoadError";
  }
}

/** 해석 설정(`MAILO_SECRET_RESOLVE_TIMEOUT_MS`) 오류. 변수 이름과 범위만 알린다. */
export class SecretSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretSettingsError";
  }
}
