import { JWS_SECRET_VARIABLE } from "./callers/index.js";
import {
  DB_ENCRYPTION_KEY_PREFIX,
  FINGERPRINT_KEY_PREFIX,
  FIXED_SECRET_VARIABLES,
  OPS_ADMIN_TOKEN_VARIABLE,
  SMTP_ACCOUNT_SECRET_VARIABLE,
  keyRingSecretVariable,
} from "./config/index.js";
import { JWE_KEY_VARIABLE } from "./envelope/index.js";
import type { ResolveSecretsOptions } from "./secrets/index.js";

/**
 * 앱(`main.ts`)이 `X_REF`로 해석할 수 있는 비밀 변수의 허용 목록(ADR-0016 결정 2).
 * 이름 규칙은 값을 읽는 로더가 소유하고 공개한 것을 그대로 쓴다. 로더의 정규식이 바뀌면 여기도 함께 바뀐다.
 * `secrets/`는 다른 모듈에 의존하지 않는 leaf라서 규칙을 조립하는 일은 앱 조립 계층의 몫이다.
 * `MAILO_CLI_TOKEN`은 별도 프로세스(`cli.ts`)가 읽고 어댑터가 설치되지 않은 환경에서 쓰므로 넣지 않는다.
 */
export const APP_SECRET_RESOLVE_OPTIONS: Pick<
  ResolveSecretsOptions,
  "names" | "rejectUnknown"
> = {
  names: [
    ...FIXED_SECRET_VARIABLES.map((name) => ({ name })),
    { pattern: OPS_ADMIN_TOKEN_VARIABLE },
    { pattern: SMTP_ACCOUNT_SECRET_VARIABLE },
    { pattern: keyRingSecretVariable(DB_ENCRYPTION_KEY_PREFIX) },
    { pattern: keyRingSecretVariable(FINGERPRINT_KEY_PREFIX) },
    { pattern: JWS_SECRET_VARIABLE },
    { pattern: JWE_KEY_VARIABLE },
  ],
  // 오타(`MAILO_SMTP_PASWORD_REF`)가 조용히 무시되어 `.env`의 평문 값으로 기동하는 일을 막는다.
  rejectUnknown: { prefix: "MAILO_" },
};
