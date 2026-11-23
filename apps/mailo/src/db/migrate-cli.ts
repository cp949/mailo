import { fileURLToPath } from "node:url";
import { ConfigError, loadDatabaseUrlOnly } from "../config/index.js";
import { runMigrations } from "./migrator.js";
import { createPool } from "./pool.js";

// src/db와 dist/db 모두에서 apps/mailo/migrations를 가리킨다.
const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);

try {
  // statement_timeout은 두지 않는다(DDL이 오래 걸릴 수 있다). 잠금 대기만 제한해, ALTER가 실행 중인 앱 쿼리를 기다리며
  // 뒤따르는 쿼리를 모두 막는 상태를 오래 두지 않는다. 인스턴스 사이 advisory lock 대기는 migrator가 예외로 둔다.
  const pool = createPool(loadDatabaseUrlOnly().reveal(), {
    lockTimeoutMillis: 10_000,
  });
  try {
    const applied = await runMigrations(pool, MIGRATIONS_DIR);
    console.log(`마이그레이션 적용 ${applied.length}건`);
  } finally {
    await pool.end();
  }
} catch (error) {
  // 설정 오류는 변수 이름과 고정 사유만 담는다. 그 밖의 오류 메시지에는 접속 정보가 섞일 수 있어 이름과 코드만 남긴다(RQ-027).
  if (error instanceof ConfigError) {
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
