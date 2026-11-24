import { describe, expect, it } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** 모듈 경계(RQ-077, ADR-0016 결정 3): `secrets/`는 다른 앱 모듈에 의존하지 않는 leaf이고 `index.ts`로만 공개한다. */

const SRC = path.resolve(import.meta.dirname, "../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map(
    (m) => m[1] as string,
  );
}

describe("secrets 모듈 경계 (RQ-077, ADR-0016 결정 3)", () => {
  it("secrets/ 안의 파일은 같은 폴더(./)와 node: 내장 모듈만 import한다", () => {
    const files = sourceFiles(path.join(SRC, "secrets"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      for (const specifier of importsOf(file))
        expect(specifier).toMatch(/^(\.\/|node:)/);
  });

  it("다른 모듈은 secrets/index.js로만 import한다", () => {
    const outside = sourceFiles(SRC).filter(
      (f) => !f.startsWith(path.join(SRC, "secrets") + path.sep),
    );
    for (const file of outside)
      for (const specifier of importsOf(file))
        if (/(^|\/)secrets\//.test(specifier))
          expect(specifier).toMatch(/\/secrets\/index\.js$/);
  });

  it("코어 apps/mailo는 제공자 SDK와 어댑터 패키지를 의존성으로 갖지 않는다(RQ-029, ADR-0016 결정 4)", () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(SRC, "../package.json"), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
    const names = [
      ...Object.keys(manifest["dependencies"] ?? {}),
      ...Object.keys(manifest["devDependencies"] ?? {}),
      ...Object.keys(manifest["optionalDependencies"] ?? {}),
    ];
    expect(names.length).toBeGreaterThan(0);
    expect(
      names.filter(
        (n) => n.startsWith("@aws-sdk/") || n.includes("secret-source"),
      ),
    ).toEqual([]);
  });
});
