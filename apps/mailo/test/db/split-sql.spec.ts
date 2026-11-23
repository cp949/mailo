import { describe, expect, it } from "@jest/globals";
import { splitSqlStatements } from "../../src/db/migrator.js";

describe("마이그레이션 SQL 문장 분리(M7)", () => {
  it("끝의 세미콜론과 주석만 있는 조각은 문장으로 세지 않는다", () => {
    expect(
      splitSqlStatements(
        "-- 설명\nCREATE INDEX CONCURRENTLY i ON t (a);\n-- 끝\n",
      ),
    ).toEqual(["-- 설명\nCREATE INDEX CONCURRENTLY i ON t (a)"]);
  });

  it("문자열·식별자·달러 인용·주석 안의 세미콜론은 구분자가 아니다", () => {
    expect(
      splitSqlStatements(
        `SELECT 'a;b', "c;d", $$e;f$$, $t$g;h$t$ /* i;j */ -- k;l\n;`,
      ),
    ).toHaveLength(1);
  });

  it("작은따옴표 두 개 이스케이프는 문자열을 닫지 않는다", () => {
    expect(splitSqlStatements("SELECT 'it''s; ok'")).toHaveLength(1);
  });

  it("문장이 둘이면 둘로 센다", () => {
    expect(splitSqlStatements("SELECT 1; SELECT 2;")).toHaveLength(2);
  });

  it("닫히지 않은 문자열·주석·달러 인용과 E 문자열은 판정하지 않는다(null)", () => {
    for (const sql of [
      "SELECT 'abc",
      "SELECT /* abc",
      "SELECT $$abc",
      `SELECT E'it\\'s;'`,
      `SELECT "abc`,
    ])
      expect(splitSqlStatements(sql)).toBeNull();
  });

  it("빈 입력은 문장이 없다", () => {
    expect(splitSqlStatements("  \n-- 주석만\n")).toEqual([]);
  });
});
