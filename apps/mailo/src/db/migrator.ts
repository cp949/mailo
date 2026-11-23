import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
// 동시에 기동한 인스턴스가 같은 마이그레이션을 겹쳐 적용하지 않게 하는 advisory lock 키
const ADVISORY_LOCK_KEY = 7_364_221_001;

/** 첫 줄이 이 표식이면 BEGIN 없이 실행한다(`CREATE INDEX CONCURRENTLY` 등 트랜잭션 안에서 못 쓰는 문장용). */
export const NO_TRANSACTION_MARKER = "-- mailo:no-transaction";
/** 풀에 `lock_timeout`이 없을 때(0) 마이그레이션 문장에 거는 잠금 대기 상한(ms). 풀에 이미 걸려 있으면 그 값을 쓴다. */
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 10_000;

export interface MigrationOptions {
  /** 풀에 `lock_timeout`이 없을 때 쓸 값(ms). 생략하면 `DEFAULT_MIGRATION_LOCK_TIMEOUT_MS`. */
  lockTimeoutMillis?: number;
}

/**
 * SQL 텍스트를 최상위 `;` 기준 문장 목록으로 나눈다. 주석, 작은따옴표 문자열, 큰따옴표 식별자, 달러 인용 안의 `;`는 구분자가 아니다.
 * 판정이 애매하면(닫히지 않은 구성, 역슬래시 이스케이프 문자열 `E'...'`) null이다. 호출자는 null을 거부로 다룬다.
 * 비어 있는 문장(주석만 있는 조각 포함)은 결과에서 뺀다.
 */
export function splitSqlStatements(sql: string): string[] | null {
  const statements: string[] = [];
  let current = "";
  let meaningful = false; // 현재 문장에 주석·공백이 아닌 글자가 있는가
  const flush = () => {
    if (meaningful) statements.push(current.trim());
    current = "";
    meaningful = false;
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      if (depth > 0) return null;
      current += sql.slice(i, j);
      i = j;
    } else if (ch === "'" || ch === '"') {
      // E'...'는 역슬래시로 따옴표를 이스케이프할 수 있어 보수적으로 거부한다.
      if (
        ch === "'" &&
        /[eE]$/.test(current) &&
        !/[A-Za-z0-9_]/.test(current.slice(-2, -1))
      )
        return null;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return null;
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      meaningful = true;
      current += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close === -1) return null;
        meaningful = true;
        current += sql.slice(i, close + tag[0].length);
        i = close + tag[0].length;
      } else {
        // `$1` 같은 위치 매개변수 또는 식별자 안의 `$`
        meaningful = true;
        current += ch;
        i++;
      }
    } else if (ch === ";") {
      flush();
      i++;
    } else {
      if (!/\s/.test(ch)) meaningful = true;
      current += ch;
      i++;
    }
  }
  flush();
  return statements;
}

interface PendingMigration {
  name: string;
  sql: string;
  noTransaction: boolean;
}

/** 파일 내용을 읽어 실행 방식을 정한다. 표식이 있는데 문장이 하나가 아니거나 판정이 애매하면 실행 전에 거부한다. */
function parseMigration(name: string, sql: string): PendingMigration {
  const firstLine = sql.split(/\r?\n/, 1)[0]!.trim();
  const noTransaction = firstLine === NO_TRANSACTION_MARKER;
  if (noTransaction) {
    const statements = splitSqlStatements(sql);
    if (statements === null || statements.length !== 1)
      throw new Error(
        `마이그레이션 ${name}: ${NO_TRANSACTION_MARKER} 파일은 문장이 정확히 하나여야 한다(여러 문장은 암묵 트랜잭션으로 묶여 CONCURRENTLY가 실패한다)`,
      );
  }
  return { name, sql, noTransaction };
}

/**
 * 현재 schema(`current_schema()`)에 INVALID 인덱스가 있으면 이름을 담아 예외를 던진다.
 * 마이그레이션은 advisory lock으로 직렬화되므로 다른 마이그레이션이 만드는 중인 인덱스와 겹치지 않는다.
 * 운영자가 같은 schema에서 수동으로 `CREATE INDEX CONCURRENTLY`를 돌리는 중이면 그 인덱스도 걸린다(보수적으로 실패한다).
 */
async function assertNoInvalidIndexes(
  client: pg.PoolClient,
  name: string,
): Promise<void> {
  const { rows } = await client.query<{ index_name: string }>(
    `SELECT c.relname AS index_name
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE NOT i.indisvalid AND c.relnamespace = current_schema()::regnamespace
      ORDER BY c.relname`,
  );
  if (rows.length > 0)
    throw new Error(
      `마이그레이션 ${name}: INVALID 인덱스가 있어 적용으로 기록하지 않는다(${rows
        .map((r) => r.index_name)
        .join(", ")}). DROP INDEX CONCURRENTLY로 지운 뒤 다시 실행한다`,
    );
}

/**
 * migrations 디렉터리의 `NNNN_이름.sql`을 파일명 순서로 적용한다.
 * - 기본: 파일마다 트랜잭션 하나이며 실패하면 그 파일만 롤백하고 중단한다. 트랜잭션 안에서 `SET LOCAL lock_timeout`을 건다.
 * - 첫 줄이 `-- mailo:no-transaction`이면 BEGIN 없이 실행한다. 문장 하나만 허용한다(검사 실패는 실행 전에 거부).
 *   실패하면 `schema_migrations`에 기록하지 않아 다음 실행에서 다시 시도하므로 문장은 멱등해야 한다(`IF NOT EXISTS` 등).
 *   `CREATE INDEX CONCURRENTLY`가 실패하면 INVALID 인덱스가 남는다. 운영자가 `DROP INDEX CONCURRENTLY`로 지운 뒤 다시 실행한다.
 *   실행 뒤 기록 전에 현재 schema의 INVALID 인덱스를 찾아, 있으면 기록하지 않고 인덱스 이름을 담아 실패한다(fail-closed).
 *   `IF NOT EXISTS`는 같은 이름의 INVALID 인덱스가 있으면 아무것도 하지 않고 성공하기 때문이다(ADR-0009 구현 중 확정).
 * - `lock_timeout`: 풀에 이미 걸려 있으면(`SHOW lock_timeout`이 0이 아님) 그 값을 쓰고, 없으면 `options.lockTimeoutMillis`(기본 10초)를 건다.
 *   인스턴스 사이의 advisory lock 대기에는 걸지 않는다.
 * 적용 기록은 `schema_migrations`에 남기며, 이미 적용한 파일은 건너뛴다.
 * 적용한 파일의 내용 변경은 감지하지 않는다. 적용된 파일을 고치지 말고 새 파일을 추가한다.
 * @returns 이번 실행에서 적용한 파일명
 */
export async function runMigrations(
  pool: pg.Pool,
  dir: string,
  options: MigrationOptions = {},
): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  for (const name of names) {
    if (!MIGRATION_FILE.test(name)) {
      throw new Error(`마이그레이션 파일명이 규칙에 맞지 않는다: ${name}`);
    }
  }
  const lockTimeoutMillis =
    options.lockTimeoutMillis ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;

  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // 다른 인스턴스의 마이그레이션이 끝나기를 기다리는 것은 정상이다. 연결 기본 lock_timeout은 이 대기에 적용하지 않는다.
    await client.query("SET lock_timeout = 0");
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    await client.query("RESET lock_timeout");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (
        await client.query<{ name: string }>(
          "SELECT name FROM schema_migrations",
        )
      ).rows.map((r) => r.name),
    );
    // 적용 전에 남은 파일을 모두 읽고 검사한다. 뒤쪽 파일의 표식 오류가 앞 파일 적용 뒤에야 드러나지 않게 한다.
    const pending: PendingMigration[] = [];
    for (const name of names) {
      if (done.has(name)) continue;
      pending.push(
        parseMigration(name, await readFile(path.join(dir, name), "utf8")),
      );
    }
    // 풀(연결 시작 매개변수)에 lock_timeout이 이미 있으면 그 값을 존중한다. 0(무제한)일 때만 기본값을 건다.
    const configured = (
      await client.query<{ lock_timeout: string }>("SHOW lock_timeout")
    ).rows[0]!.lock_timeout;
    const needsDefault = configured === "0";

    for (const migration of pending) {
      if (migration.noTransaction) {
        // 트랜잭션이 없으므로 SET LOCAL은 효과가 없다. 세션 SET 뒤 RESET한다.
        if (needsDefault)
          await client.query(`SET lock_timeout = ${lockTimeoutMillis}`);
        try {
          await client.query(migration.sql);
        } finally {
          if (needsDefault) await client.query("RESET lock_timeout");
        }
        await assertNoInvalidIndexes(client, migration.name);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          migration.name,
        ]);
      } else {
        try {
          await client.query("BEGIN");
          if (needsDefault)
            await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMillis}`);
          await client.query(migration.sql);
          await client.query(
            "INSERT INTO schema_migrations (name) VALUES ($1)",
            [migration.name],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      applied.push(migration.name);
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
  return applied;
}
