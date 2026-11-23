/**
 * 운영 CLI의 인자 해석(RQ-047, ADR-0011 결정 7). 순수 함수이고 입출력이 없다.
 *
 * - 토큰은 인자로 받지 않는다. 프로세스 목록에 보이기 때문이다. `MAILO_CLI_TOKEN_FILE`(우선) 또는 `MAILO_CLI_TOKEN`으로 받는다.
 * - 상태를 바꾸는 명령(`pause`, `resume`, `jobs cancel`)은 `--yes`가 없으면 실행하지 않는다.
 * - 오류 메시지에는 입력 값을 되풀이하지 않고 인자 이름과 고정 사유만 쓴다.
 */

/** 정지 범위. 서버 `/ops/pauses/...` 경로에 대응한다. */
export type CliScope = { type: "all" } | { type: "caller"; id: string };

export type CliCommand =
  | { name: "status" }
  | { name: "queue-stats" }
  | { name: "jobs-show"; jobId: string }
  | { name: "audit-list"; limit: number | null; before: string | null }
  | { name: "pause"; scope: CliScope }
  | { name: "resume"; scope: CliScope }
  | { name: "jobs-cancel"; jobId: string };

export type ParsedArgs =
  | { kind: "command"; command: CliCommand }
  | { kind: "help" }
  | { kind: "usage-error"; message: string };

// 호출처 ID 형식. 서버의 레지스트리 ID 규칙(`callers/registry.ts`의 `isCallerId`)과 같다.
// CLI가 Nest 모듈을 불러오지 않게 복사했다. 같은 판정은 `test/cli/args.spec.ts`가 고정한다.
const CALLER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const INT64_MAX = 9_223_372_036_854_775_807n;
const MAX_AUDIT_LIMIT = 200;
const VALUE_FLAGS = new Set(["caller", "limit", "before"]);
const BOOLEAN_FLAGS = new Set(["all", "yes", "help"]);
// 토큰·비밀번호를 받는 것처럼 보이는 옵션. 값을 읽지 않고 거부한다.
const SECRET_FLAG = /^(?:token|password|secret|api-?key|auth)/i;

const TOKEN_HINT =
  "토큰은 인자로 받지 않는다. MAILO_CLI_TOKEN_FILE(우선) 또는 MAILO_CLI_TOKEN 환경 변수로 준다";

function usage(message: string): ParsedArgs {
  return { kind: "usage-error", message };
}

interface Tokens {
  positionals: string[];
  flags: Map<string, string | true>;
}

/** 인자를 위치 인자와 `--이름[=값]` 옵션으로 나눈다. 문제가 있으면 사유 문장을 돌려준다. */
function tokenize(argv: readonly string[]): Tokens | { problem: string } {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (SECRET_FLAG.test(name)) return { problem: TOKEN_HINT };
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) return { problem: `--${name}은 값을 받지 않는다` };
      flags.set(name, true);
    } else if (VALUE_FLAGS.has(name)) {
      let value: string | undefined;
      if (eq !== -1) value = arg.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i += 1;
        }
      }
      if (value === undefined || value === "")
        return { problem: `--${name}에 값이 필요하다` };
      if (flags.has(name)) return { problem: `--${name}을 한 번만 쓴다` };
      flags.set(name, value);
    } else {
      return { problem: "알 수 없는 옵션이 있다" };
    }
  }
  return { positionals, flags };
}

function only(tokens: Tokens, allowed: readonly string[]): string | undefined {
  for (const name of tokens.flags.keys())
    if (!allowed.includes(name))
      return `이 명령에 쓸 수 없는 옵션이 있다(--${name})`;
  return undefined;
}

function requireYes(tokens: Tokens, what: string): string | undefined {
  return tokens.flags.has("yes")
    ? undefined
    : `${what}는 서버 상태를 바꾼다. 실행하려면 --yes를 붙인다`;
}

function scopeOf(tokens: Tokens): CliScope | string {
  const all = tokens.flags.has("all");
  const caller = tokens.flags.get("caller");
  if (all === (caller !== undefined))
    return "범위를 --all 또는 --caller <호출처 ID> 중 하나만 명시한다";
  if (all) return { type: "all" };
  if (typeof caller !== "string" || !CALLER_ID.test(caller))
    return "--caller 값이 호출처 ID 형식이 아니다";
  return { type: "caller", id: caller };
}

/** `argv`(실행 파일 이름 뒤의 인자)를 명령으로 해석한다. */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const tokens = tokenize(argv);
  if ("problem" in tokens) return usage(tokens.problem);
  if (tokens.flags.has("help")) return { kind: "help" };

  const [first, second, third, ...rest] = tokens.positionals;
  const done = (command: CliCommand): ParsedArgs => ({
    kind: "command",
    command,
  });

  switch (first) {
    case "status": {
      if (second !== undefined || only(tokens, []))
        return usage("status는 인자를 받지 않는다");
      return done({ name: "status" });
    }
    case "queue": {
      if (second !== "stats" || third !== undefined || only(tokens, []))
        return usage("사용법: queue stats");
      return done({ name: "queue-stats" });
    }
    case "audit": {
      if (second !== "list" || third !== undefined)
        return usage("사용법: audit list [--limit N] [--before ID]");
      const flagProblem = only(tokens, ["limit", "before"]);
      if (flagProblem) return usage(flagProblem);
      const rawLimit = tokens.flags.get("limit");
      let limit: number | null = null;
      if (typeof rawLimit === "string") {
        if (
          !/^\d{1,6}$/.test(rawLimit) ||
          Number(rawLimit) < 1 ||
          Number(rawLimit) > MAX_AUDIT_LIMIT
        )
          return usage(`--limit은 1~${MAX_AUDIT_LIMIT}의 정수다`);
        limit = Number(rawLimit);
      }
      const rawBefore = tokens.flags.get("before");
      let before: string | null = null;
      if (typeof rawBefore === "string") {
        if (!/^[1-9]\d{0,18}$/.test(rawBefore) || BigInt(rawBefore) > INT64_MAX)
          return usage("--before는 양의 정수 감사 ID다");
        before = rawBefore;
      }
      return done({ name: "audit-list", limit, before });
    }
    case "jobs": {
      if (
        (second !== "show" && second !== "cancel") ||
        third === undefined ||
        rest.length > 0
      )
        return usage("사용법: jobs show <jobId> | jobs cancel <jobId> --yes");
      if (!UUID.test(third)) return usage("작업 ID가 UUID 형식이 아니다");
      const jobId = third.toLowerCase();
      if (second === "show") {
        if (only(tokens, [])) return usage("jobs show는 옵션을 받지 않는다");
        return done({ name: "jobs-show", jobId });
      }
      const flagProblem = only(tokens, ["yes"]);
      if (flagProblem) return usage(flagProblem);
      const yes = requireYes(tokens, "jobs cancel");
      if (yes) return usage(yes);
      return done({ name: "jobs-cancel", jobId });
    }
    case "pause":
    case "resume": {
      if (second !== undefined)
        return usage(`사용법: ${first} --all|--caller <호출처 ID> --yes`);
      const flagProblem = only(tokens, ["all", "caller", "yes"]);
      if (flagProblem) return usage(flagProblem);
      const scope = scopeOf(tokens);
      if (typeof scope === "string") return usage(scope);
      const yes = requireYes(tokens, first);
      if (yes) return usage(yes);
      return done({ name: first, scope });
    }
    default:
      return usage(first === undefined ? "명령이 없다" : "알 수 없는 명령이다");
  }
}
