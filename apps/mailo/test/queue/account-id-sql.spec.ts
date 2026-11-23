import { describe, expect, it } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `src/`의 SQL 문자열이 작업의 계정을 바꾸지 않고 항상 명시해 쓰는지 소스 글자로 확인한다(RQ-054, ADR-0013 결정 2·4).
 * 정적 검사라 DB가 필요 없다. SQL을 만드는 방식이 바뀌어 이 검사가 통과해도 안전하다는 뜻은 아니다.
 * 동작은 `account-id.integration-spec.ts`가 실제 DB로 확인한다.
 */
const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? sourceFiles(full)
      : full.endsWith(".ts")
        ? [full]
        : [];
  });
}

/** `UPDATE ... SET` 목록에 account_id가 오는 SQL이 있으면 true다. */
function setsAccountId(text: string): boolean {
  // `UPDATE <테이블> SET ... ` 구간에서 SET 목록의 열 이름을 모은다. 다음 WHERE·RETURNING·FROM 앞까지다.
  for (const match of text.matchAll(
    /UPDATE\s+\w+\s+(?:\w+\s+)?SET\s+([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|\bFROM\b|`)/gi,
  )) {
    if (/(^|[\s,])account_id\s*=/.test(match[1]!)) return true;
  }
  return false;
}

const files = sourceFiles(SRC).map((file) => ({
  file: path.relative(SRC, file),
  text: readFileSync(file, "utf8"),
}));

describe("account_id를 쓰는 SQL의 정적 규칙(RQ-054, ADR-0013 결정 2·4)", () => {
  it("어떤 SQL도 account_id를 UPDATE의 SET 절에서 바꾸지 않는다(등록 때 고정)", () => {
    const offenders = files
      .filter(({ text }) => setsAccountId(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("검사 함수는 SET 목록의 account_id를 잡고 WHERE 조건의 account_id는 잡지 않는다", () => {
    expect(
      setsAccountId(
        "UPDATE mail_jobs SET status = 'X', account_id = $2 WHERE id = $1",
      ),
    ).toBe(true);
    expect(
      setsAccountId("UPDATE mail_jobs j SET account_id = 'a' WHERE j.id = $1"),
    ).toBe(true);
    expect(
      setsAccountId("UPDATE mail_jobs SET status = 'X' WHERE account_id = $1"),
    ).toBe(false);
  });

  it("mail_jobs와 mail_attempts의 INSERT는 account_id 열을 명시한다", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const { file, text } of files) {
      for (const match of text.matchAll(
        /INSERT\s+INTO\s+(mail_jobs|mail_attempts)\s*\(([\s\S]*?)\)\s*(?:VALUES|SELECT)/gi,
      )) {
        seen += 1;
        if (!/\baccount_id\b/.test(match[2]!))
          missing.push(`${file}:${match[1]}`);
      }
    }
    // 두 INSERT(register, completeAttempt)를 실제로 찾았는지 확인한다. 정규식이 어긋나 0건이면 이 검사는 의미가 없다.
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(missing).toEqual([]);
  });

  it("src/에 SELECT *와 RETURNING *이 없다(구버전이 새 컬럼을 무시하는 전제, 결정 4)", () => {
    const offenders = files
      .filter(({ text }) => /SELECT\s+\*|RETURNING\s+\*/i.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
