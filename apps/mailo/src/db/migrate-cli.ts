import { fileURLToPath } from "node:url";
import { ConfigError, loadDatabaseUrlOnly } from "../config/index.js";
import { runMigrations } from "./migrator.js";
import { createPool } from "./pool.js";

// src/db와 dist/db 모두에서 apps/mailo/migrations를 가리킨다.
const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);

try {
  const pool = createPool(loadDatabaseUrlOnly().reveal());
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
