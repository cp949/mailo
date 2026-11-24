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
   * 값을 돌려주거나 던진 뒤에는 어댑터가 연 연결·타이머를 닫는다. 진입점은 마이그레이션 CLI가 성공하면 남은 핸들과 무관하게 종료하지만,
   * 앱 프로세스(`main.ts`)에는 남은 핸들이 계속 붙어 있다.
   * `signal`의 abort 리스너에서 예외를 던지지 않는다(Node는 리스너 예외를 비동기 uncaught exception으로 보고하고 코어는 잡지 못한다).
   * 모듈 로드(최상위) 중에는 끝나지 않는 비동기 작업을 하지 않는다. 코어가 `import()`에 해석 제한 시간을 두지만, 시간이 지나면
   * 그 어댑터는 `import-failed`로 실패하고 기동을 거부한다.
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
