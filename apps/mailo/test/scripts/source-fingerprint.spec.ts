import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 저장소 루트 scripts/source-fingerprint.sh가 내용 기반 지문을 내는지 임시 git 저장소에서 확인한다.
// 실제 저장소 상태에 의존하지 않는다. 규칙은 docs/agents/verification.md의 "소스·환경 지문"이다.

const SCRIPT = fileURLToPath(
  new URL("../../../../scripts/source-fingerprint.sh", import.meta.url),
);
const SOURCE_LINE = /^source=([0-9a-f]{12}) files=(\d+)$/;
const ENV_LINE = /^env=([0-9a-f]{12})$/;

/** 사용자 전역 git 설정과 무관하게 같은 결과가 나오도록 환경을 고정한다. */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  delete env.MAILO_TEST_DATABASE_URL;
  return { ...env, ...extra };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, env: baseEnv() });
  if (result.status !== 0) throw new Error(result.stderr.toString());
}

/** 파일 2개와 .gitignore를 커밋한 저장소를 만든다. */
function makeRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "mailo-fingerprint-"));
  dirs.push(repo);
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, ".gitignore"), "dist/\n_works/\n");
  writeFileSync(path.join(repo, "src", "a.txt"), "alpha\n");
  writeFileSync(path.join(repo, "b.txt"), "beta\n");
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

function run(
  repo: string,
  args: string[] = [],
  extra: Record<string, string> = {},
) {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    cwd: repo,
    env: baseEnv(extra),
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function source(repo: string): string {
  const result = run(repo);
  expect(result.status).toBe(0);
  const match = SOURCE_LINE.exec(result.stdout.trim());
  expect(match).not.toBeNull();
  return match![1]!;
}

function envFingerprint(repo: string, extra: Record<string, string> = {}) {
  const result = run(repo, ["--env"], extra);
  expect(result.status).toBe(0);
  const lines = result.stdout.trim().split("\n");
  expect(lines).toHaveLength(2);
  const match = ENV_LINE.exec(lines[1]!);
  expect(match).not.toBeNull();
  return { value: match![1]!, output: result.stdout + result.stderr };
}

describe("소스 지문 스크립트", () => {
  it("같은 내용이면 커밋이 달라도 같은 지문이고 스테이징 여부는 영향이 없다", () => {
    const repo = makeRepo();
    const before = source(repo);
    git(repo, "commit", "-q", "--allow-empty", "-m", "empty");
    expect(source(repo)).toBe(before);

    writeFileSync(path.join(repo, "b.txt"), "beta2\n");
    const unstaged = source(repo);
    git(repo, "add", "b.txt");
    expect(source(repo)).toBe(unstaged);
  });

  it("내용 한 글자를 바꾸면 지문이 달라지고 되돌리면 같아진다", () => {
    const repo = makeRepo();
    const before = source(repo);
    writeFileSync(path.join(repo, "src", "a.txt"), "alphb\n");
    expect(source(repo)).not.toBe(before);
    writeFileSync(path.join(repo, "src", "a.txt"), "alpha\n");
    expect(source(repo)).toBe(before);
  });

  it("untracked 파일은 지문과 파일 수에 들어가고 ignore된 파일은 들어가지 않는다", () => {
    const repo = makeRepo();
    const before = run(repo).stdout.trim();
    mkdirSync(path.join(repo, "_works"));
    writeFileSync(path.join(repo, "_works", "note.md"), "x");
    expect(run(repo).stdout.trim()).toBe(before);

    writeFileSync(path.join(repo, "새 파일.txt"), "x");
    const after = run(repo).stdout.trim();
    expect(after).not.toBe(before);
    expect(Number(SOURCE_LINE.exec(after)![2])).toBe(
      Number(SOURCE_LINE.exec(before)![2]) + 1,
    );
  });

  it("삭제한 추적 파일은 건너뛰고 지문이 달라진다", () => {
    const repo = makeRepo();
    const before = source(repo);
    unlinkSync(path.join(repo, "b.txt"));
    expect(source(repo)).not.toBe(before);
  });

  it("일반 파일이 아닌 항목(끊어진 symlink)이 목록 마지막에 와도 건너뛰고 성공한다", () => {
    const repo = makeRepo();
    const before = source(repo);
    // 정렬 순서상 마지막에 오도록 이름을 고른다.
    symlinkSync("없는-대상", path.join(repo, "zz-dangling"));
    expect(source(repo)).toBe(before);
  });

  it("env 지문은 DB 주소의 비밀번호를 입력·출력에 넣지 않고 나머지 값이 바뀌면 달라진다 (RQ-027)", () => {
    const repo = makeRepo();
    const canary = "pw-CANARY-1";
    const base = envFingerprint(repo, {
      MAILO_TEST_DATABASE_URL: `postgres://mailo:${canary}@127.0.0.1:5432/mailo`,
    });
    expect(base.output).not.toContain(canary);
    expect(base.output).not.toContain("127.0.0.1");
    expect(
      envFingerprint(repo, {
        MAILO_TEST_DATABASE_URL: "postgres://mailo:other@127.0.0.1:5432/mailo",
      }).value,
    ).toBe(base.value);
    for (const url of [
      "postgres://mailo:x@127.0.0.1:5433/mailo",
      "postgres://other:x@127.0.0.1:5432/mailo",
    ]) {
      expect(
        envFingerprint(repo, { MAILO_TEST_DATABASE_URL: url }).value,
      ).not.toBe(base.value);
    }
    expect(envFingerprint(repo).value).not.toBe(base.value);
  });

  it("비밀번호에 @가 있거나 password 쿼리로 주어져도 비밀번호를 env 지문 입력에 넣지 않는다 (RQ-027)", () => {
    const repo = makeRepo();
    const fp = (url: string) =>
      envFingerprint(repo, { MAILO_TEST_DATABASE_URL: url }).value;
    expect(fp("postgres://mailo:p@ss-1@127.0.0.1:5432/mailo")).toBe(
      fp("postgres://mailo:other@127.0.0.1:5432/mailo"),
    );
    expect(fp("postgres://127.0.0.1:5432/mailo?user=mailo&password=pw-1")).toBe(
      fp("postgres://127.0.0.1:5432/mailo?user=mailo&password=pw-2"),
    );
  });

  it("--env가 없으면 source 줄만 내고 알 수 없는 인자는 종료 코드 2로 거부한다", () => {
    const repo = makeRepo();
    expect(run(repo).stdout.trim().split("\n")).toHaveLength(1);
    const rejected = run(repo, ["--unknown"]);
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("Usage");
  });
});
