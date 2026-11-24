/**
 * 환경에서 비밀값을 읽는 변수 이름 규칙(ADR-0016 결정 2). `X_REF` 해석(`secrets/`)의 허용 목록이 이 규칙으로 만들어진다.
 * 호출처 JWS 비밀(`callers`)과 JWE 개인키(`envelope`)의 규칙은 각 모듈이 소유하고 공개한다.
 * 정규식은 각 로더가 값을 읽을 때 쓰는 것과 같다. 로더 쪽을 고치면 이 파일과 `secret-names.ts`의 대조 테스트가 어긋남을 잡는다.
 */

/** 마이그레이션 CLI가 읽는 비밀(`loadDatabaseOnly`). */
export const DATABASE_SECRET_VARIABLES = [
  "MAILO_DATABASE_URL",
  "MAILO_DB_PASSWORD",
] as const;

/** 이름이 고정인 비밀. */
export const FIXED_SECRET_VARIABLES = [
  ...DATABASE_SECRET_VARIABLES,
  "MAILO_OPS_TOKEN",
  "MAILO_SMTP_PASSWORD",
] as const;

/** 관리 토큰 `MAILO_OPS_ADMIN_TOKEN_<이름 대문자>`. 이름 규칙은 `OPS_ADMIN_NAME`(`load-config.ts`)과 같다(최대 32자). */
export const OPS_ADMIN_TOKEN_VARIABLE =
  /^MAILO_OPS_ADMIN_TOKEN_[A-Z][A-Z0-9]{0,31}$/;

/** 계정 파일의 `auth.secretVar`(`smtp-accounts.ts`). */
export const SMTP_ACCOUNT_SECRET_VARIABLE =
  /^MAILO_SMTP_SECRET_[A-Z0-9_]{1,40}$/;

/** DB 본문 키링과 지문 키링의 변수 이름 접두어(`key-loader.ts`의 `loadKeyRing`). */
export const DB_ENCRYPTION_KEY_PREFIX = "MAILO_DB_ENCRYPTION_KEY";
export const FINGERPRINT_KEY_PREFIX = "MAILO_FINGERPRINT_KEY";

/** 키링의 버전 변수 `<접두어>_V<n>`. `loadKeyRing`이 쓰는 `^<접두어>_V(\d+)(_FILE)?$`에서 `_FILE`을 뺀 것이다. */
export function keyRingSecretVariable(prefix: string): RegExp {
  return new RegExp(`^${prefix}_V\\d+$`);
}
