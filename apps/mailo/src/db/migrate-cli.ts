import { fileURLToPath } from "node:url";
import {
  ConfigError,
  DATABASE_SECRET_VARIABLES,
  loadDatabaseOnly,
  toPgSsl,
} from "../config/index.js";
import {
  SecretAdapterLoadError,
  SecretResolutionError,
  SecretSettingsError,
  resolveSecrets,
} from "../secrets/index.js";
import { runMigrations, type MigrationProgress } from "./migrator.js";
import { createPool } from "./pool.js";

// src/db와 dist/db 모두에서 apps/mailo/migrations를 가리킨다.
const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);

/** 다른 실행이 잠금을 쥐고 있어 기다릴 때만 나오는 평문 두 줄이다. 숫자와 고정 문구만 쓴다(RQ-027). */
function printProgress(progress: MigrationProgress): void {
  const seconds = (progress.waitedMillis / 1000).toFixed(1);
  console.log(
    progress.type === "lock_wait"
      ? `마이그레이션 잠금 대기 중(다른 실행이 진행 중, 경과 ${seconds}초)`
      : `마이그레이션 잠금 획득(대기 ${seconds}초)`,
  );
}

try {
  // statement_timeout은 두지 않는다(DDL이 오래 걸릴 수 있다). 잠금 대기만 제한해, ALTER가 실행 중인 앱 쿼리를 기다리며
  // 뒤따르는 쿼리를 모두 막는 상태를 오래 두지 않는다. 인스턴스 사이 advisory lock 대기는 migrator의 try-lock 폴링이라
  // lock_timeout과 무관하다. 상한은 두지 않아 다른 인스턴스의 긴 마이그레이션을 끝까지 기다린다.
  // DB 접속 비밀(`MAILO_DATABASE_URL`, `MAILO_DB_PASSWORD`)의 `X_REF`만 해석한다. 이 프로세스는 JWS·JWE·SMTP 비밀을
  // 읽을 이유도 권한도 없다(ADR-0016 결정 2). 해석값은 `process.env`가 아니라 환경 복사본에 둔다.
  const env = await resolveSecrets(process.env, {
    names: DATABASE_SECRET_VARIABLES.map((name) => ({ name })),
  });
  const database = loadDatabaseOnly(env);
  const ssl = toPgSsl(database.ssl);
  const pool = createPool(database.url.reveal(), {
    lockTimeoutMillis: 10_000,
    ...(ssl !== undefined && { ssl }),
  });
  try {
    const applied = await runMigrations(pool, MIGRATIONS_DIR, {
      onProgress: printProgress,
    });
    console.log(`마이그레이션 적용 ${applied.length}건`);
  } finally {
    await pool.end();
  }
} catch (error) {
  // 설정·비밀값 해석 오류는 변수 이름과 고정 사유만 담는다. 그 밖의 오류 메시지에는 접속 정보가 섞일 수 있어 이름과 코드만 남긴다(RQ-027).
  if (
    error instanceof ConfigError ||
    error instanceof SecretResolutionError ||
    error instanceof SecretAdapterLoadError ||
    error instanceof SecretSettingsError
  ) {
    console.error(error.message);
  } else {
    const code = (error as { code?: unknown } | null)?.code;
    console.error(
      `마이그레이션 실패: ${error instanceof Error ? error.name : "unknown"}${
        typeof code === "string" ? ` code=${code}` : ""
      }`,
    );
  }
  process.exit(1);
}

// 성공: 어댑터가 남긴 타이머·소켓 같은 핸들이 있어도 프로세스가 끝나야 한다(compose `migrate-cli && exec main`이 멈추지 않게).
// 앞서 쓴 출력이 stdout에 모두 나간 뒤(빈 쓰기의 콜백) 종료한다. 실패는 위 catch가 종료 코드 1로 끝낸다.
process.stdout.write("", () => process.exit(0));
