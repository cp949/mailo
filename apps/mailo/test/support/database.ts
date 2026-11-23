import pg from "pg";

const DEFAULT_URL = "postgres://mailo:mailo-dev-password@localhost:5432/mailo";

export interface TestDatabase {
  pool: pg.Pool;
  schema: string;
  close(): Promise<void>;
}

/**
 * 테스트 파일마다 전용 schema를 만들어 격리한다.
 * 접속 URL은 MAILO_TEST_DATABASE_URL이며, 없으면 compose 기본 개발 값을 쓴다.
 * 서버가 없으면 skip하지 않고 실패한다.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const url = process.env.MAILO_TEST_DATABASE_URL || DEFAULT_URL;
  const schema = `test_${process.pid}_${Date.now()}`;

  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();

  const pool = new pg.Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  return {
    pool,
    schema,
    async close() {
      await pool.end();
      const cleaner = new pg.Client({ connectionString: url });
      await cleaner.connect();
      await cleaner.query(`DROP SCHEMA "${schema}" CASCADE`);
      await cleaner.end();
    },
  };
}
