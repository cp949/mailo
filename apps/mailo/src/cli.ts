/**
 * 운영 CLI 진입점(`node dist/cli.js`, RQ-047, ADR-0011 결정 7). 앱(`main.ts`)과 별개 프로세스이고 Nest를 불러오지 않는다.
 * 같은 이미지에서 `docker compose exec mailo node dist/cli.js <명령>`으로 실행한다.
 */
import { readFile } from "node:fs/promises";
import { runCli } from "./cli/index.js";

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  fetch: globalThis.fetch,
  readTextFile: (path) => readFile(path, "utf8"),
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
});
process.exitCode = code;
