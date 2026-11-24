/**
 * 외부 시크릿 소스 어댑터 계약(ADR-0016 결정 3). 어댑터는 Mailo 소스를 import하지 않고 이 구조만 맞춘다.
 * 어댑터 모듈의 기본 export가 이 구조여야 한다.
 */
export interface SecretSource {
  /** `X_REF=<scheme>://<참조>`의 scheme. `^[a-z][a-z0-9+.-]*$`이고 `file`은 예약어라 쓸 수 없다. */
  readonly scheme: string;
  /**
   * `X_REF` 값 전체(`<scheme>://...`)를 받아 비밀값을 돌려준다.
   * `signal`이 abort되면 작업과 열어 둔 연결을 멈춘다. 오류는 `code`에 닫힌 코드(`SecretErrorCode`)를 실어 던진다.
   * 오류 메시지는 코어가 읽지 않고 버린다. 값과 참조의 비밀 부분은 어댑터의 로그에도 쓰지 않는다.
   * 값을 돌려주거나 던진 뒤에는 어댑터가 연 연결·타이머를 닫는다. 마이그레이션 CLI는 해석 뒤 `process.exit` 없이 끝나므로 남은 핸들이 종료를 막는다.
   */
  resolve(ref: string, options: { signal: AbortSignal }): Promise<string>;
}

/** 어댑터가 오류의 `code`로 돌려줄 수 있는 닫힌 코드(ADR-0016 결정 5). 이 밖의 값은 코어가 버린다. */
export const SECRET_ERROR_CODES = [
  "not-found",
  "access-denied",
  "throttled",
  "unavailable",
  "invalid-value",
] as const;

export type SecretErrorCode = (typeof SECRET_ERROR_CODES)[number];

/** scheme 형식. 결정 1과 같다. */
export const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;

/** `file` scheme은 예약어다. 파일은 `X_FILE`로만 지정한다. */
export const RESERVED_SCHEME = "file";
