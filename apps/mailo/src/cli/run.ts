/**
 * 운영 CLI 실행(RQ-047, ADR-0011 결정 7). 운영 REST(`/health/ready`, `/ops/*`)를 Node의 `fetch`로 부른다.
 * 상주 프로세스가 없고 DB에 직접 접속하지 않는다. 새 npm 의존성이 없다.
 *
 * 연결: `MAILO_CLI_URL`(기본 `http://127.0.0.1:<MAILO_PORT>`). 토큰: `MAILO_CLI_TOKEN_FILE`(우선) 또는 `MAILO_CLI_TOKEN`.
 * 서버의 `MAILO_OPS_*` 변수는 읽지 않는다. 토큰은 인자·출력·오류 어디에도 쓰지 않는다(RQ-027).
 *
 * 종료 코드: 성공 0, 사용법·설정 오류 1, HTTP 오류 2, 연결 실패 3.
 * 출력은 서버 응답 JSON이다. 성공은 stdout, 오류는 stderr다.
 */
import { parseCliArgs, type CliCommand, type CliScope } from "./args.js";

export const CLI_EXIT = { OK: 0, USAGE: 1, HTTP: 2, CONNECT: 3 } as const;

/** 외부 의존(환경, 네트워크, 파일, 출력)을 주입해 서버 없이 시험한다. */
export interface CliDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  readTextFile(path: string): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** 응답 대기 상한(ms). 서버의 요청 시간제한(30초)보다 짧다. */
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY_CHARS = 2000;
// Authorization 헤더에 그대로 넣으므로 공백·제어 문자를 허용하지 않는다.
const TOKEN_CHARS = /^[\x21-\x7E]+$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const USAGE_TEXT = `사용법: node dist/cli.js <명령> [옵션]

읽기 명령(읽기 또는 관리 토큰)
  status                              /health/ready와 /ops/pauses
  queue stats                         /health/ready의 queue
  jobs show <jobId>                   /ops/jobs/{jobId}
  audit list [--limit N] [--before ID]  /ops/audit

변경 명령(관리 토큰, --yes 필요)
  pause --all | --caller <호출처 ID> --yes
  resume --all | --caller <호출처 ID> --yes
  jobs cancel <jobId> --yes

환경 변수
  MAILO_CLI_TOKEN_FILE  토큰 파일 경로(우선)
  MAILO_CLI_TOKEN       토큰 값(파일이 없을 때). 명령줄 인자로는 받지 않는다
  MAILO_CLI_URL         접속 주소(기본 http://127.0.0.1:<MAILO_PORT>, MAILO_PORT 기본 3000)

종료 코드: 0 성공, 1 사용법·설정 오류, 2 HTTP 오류, 3 연결 실패
`;

class CliConfigError extends Error {}

interface Connection {
  baseUrl: string;
  token: string;
  /** http이고 loopback이 아니면 토큰이 평문으로 간다. */
  plaintextRemote: boolean;
}

function resolveBaseUrl(env: NodeJS.ProcessEnv): URL {
  const raw = env["MAILO_CLI_URL"];
  if (raw === undefined || raw === "") {
    const rawPort = env["MAILO_PORT"];
    const port =
      rawPort === undefined || rawPort === "" ? 3000 : Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new CliConfigError("MAILO_PORT는 1~65535의 정수여야 한다");
    return new URL(`http://127.0.0.1:${port}`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliConfigError("MAILO_CLI_URL이 URL 형식이 아니다");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new CliConfigError("MAILO_CLI_URL은 http 또는 https여야 한다");
  if (url.username !== "" || url.password !== "")
    throw new CliConfigError(
      "MAILO_CLI_URL에 사용자 정보를 넣지 않는다(토큰은 MAILO_CLI_TOKEN_FILE로 준다)",
    );
  if (url.search !== "" || url.hash !== "")
    throw new CliConfigError("MAILO_CLI_URL에 쿼리·해시를 넣지 않는다");
  return url;
}

async function resolveToken(deps: CliDeps): Promise<string> {
  const file = deps.env["MAILO_CLI_TOKEN_FILE"];
  let token: string | undefined;
  if (file !== undefined && file !== "") {
    try {
      token = (await deps.readTextFile(file)).replace(/\s+$/, "");
    } catch (error) {
      // 파일이 있다고 밝힌 이상 환경 변수로 조용히 넘어가지 않는다. 경로와 메시지는 쓰지 않고 errno 코드만 쓴다.
      const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      throw new CliConfigError(`MAILO_CLI_TOKEN_FILE을 읽지 못했다(${code})`);
    }
  } else {
    token = deps.env["MAILO_CLI_TOKEN"];
  }
  if (token === undefined || token === "")
    throw new CliConfigError(
      "토큰이 없다. MAILO_CLI_TOKEN_FILE 또는 MAILO_CLI_TOKEN을 설정한다",
    );
  if (!TOKEN_CHARS.test(token))
    throw new CliConfigError("토큰에 공백이나 제어 문자가 있다");
  return token;
}

async function connect(deps: CliDeps): Promise<Connection> {
  const url = resolveBaseUrl(deps.env);
  const token = await resolveToken(deps);
  return {
    baseUrl: url.origin + url.pathname.replace(/\/+$/, ""),
    token,
    plaintextRemote:
      url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname),
  };
}

/** 연결 실패 신호. 사유는 errno 코드나 오류 이름뿐이다(URL·메시지에 값이 섞일 수 있다). */
class ConnectFailure extends Error {}
/** 서버가 2xx가 아닌 응답을 줬다. */
class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    /** 상태 코드만으로 알기 어려운 경우의 고정 설명(2xx인데 기대한 응답이 아닌 경우). */
    readonly note: string | null = null,
  ) {
    super(`HTTP ${status}`);
  }
}

async function call(
  deps: CliDeps,
  connection: Connection,
  method: "GET" | "PUT" | "DELETE" | "POST",
  pathAndQuery: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await deps.fetch(`${connection.baseUrl}${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        Accept: "application/json",
      },
      // 다른 곳으로 옮겨 가는 응답을 따라가지 않는다. 3xx는 HTTP 오류로 다룬다.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } }).cause;
    const name = error instanceof Error ? error.name : "UNKNOWN";
    throw new ConnectFailure(
      typeof cause?.code === "string"
        ? cause.code
        : name === "TimeoutError" || name === "AbortError"
          ? "시간 초과"
          : name,
    );
  }
  const text = await response.text();
  if (response.status < 200 || response.status >= 300)
    throw new HttpFailure(response.status, text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpFailure(response.status, "", "응답이 JSON이 아니다");
  }
}

function scopePath(scope: CliScope): string {
  return scope.type === "all"
    ? "/ops/pauses/all"
    : `/ops/pauses/callers/${encodeURIComponent(scope.id)}`;
}

async function execute(
  deps: CliDeps,
  connection: Connection,
  command: CliCommand,
): Promise<unknown> {
  const send = (method: Parameters<typeof call>[2], path: string) =>
    call(deps, connection, method, path);
  switch (command.name) {
    case "status": {
      const ready = await send("GET", "/health/ready");
      const pauses = await send("GET", "/ops/pauses");
      return { ready, pauses };
    }
    case "queue-stats": {
      const ready = (await send("GET", "/health/ready")) as {
        queue?: unknown;
      } | null;
      // 운영자 토큰이 아니면 `queue`가 없다. 빈 출력으로 성공시키지 않는다.
      if (
        ready === null ||
        typeof ready !== "object" ||
        ready.queue === undefined
      )
        throw new HttpFailure(
          200,
          "",
          "응답에 queue가 없다. 읽기·관리 토큰이 아닐 수 있다",
        );
      return ready.queue;
    }
    case "jobs-show":
      return send("GET", `/ops/jobs/${command.jobId}`);
    case "audit-list": {
      const query = new URLSearchParams();
      if (command.limit !== null) query.set("limit", String(command.limit));
      if (command.before !== null) query.set("before", command.before);
      const text = query.toString();
      return send("GET", `/ops/audit${text === "" ? "" : `?${text}`}`);
    }
    case "pause":
      return send("PUT", scopePath(command.scope));
    case "resume":
      return send("DELETE", scopePath(command.scope));
    case "jobs-cancel":
      return send("POST", `/ops/jobs/${command.jobId}/cancel`);
  }
}

/** 오류 응답 본문 중 problem+json처럼 보이는 JSON만 길이를 제한해 낸다. */
function describeHttpFailure(failure: HttpFailure): string {
  const body = failure.body.trim();
  const shown =
    body.startsWith("{") && body.length <= MAX_ERROR_BODY_CHARS
      ? `\n${body}`
      : "";
  return `HTTP ${failure.status}${failure.note === null ? "" : `: ${failure.note}`}${shown}\n`;
}

/**
 * CLI를 실행하고 종료 코드를 돌려준다. `process.exit`을 부르지 않는다(호출자가 종료 코드를 정한다).
 * @param argv 실행 파일 이름 뒤의 인자
 */
export async function runCli(
  argv: readonly string[],
  deps: CliDeps,
): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed.kind === "help") {
    deps.stdout(USAGE_TEXT);
    return CLI_EXIT.OK;
  }
  if (parsed.kind === "usage-error") {
    deps.stderr(`${parsed.message}\n\n${USAGE_TEXT}`);
    return CLI_EXIT.USAGE;
  }

  let connection: Connection;
  try {
    connection = await connect(deps);
  } catch (error) {
    if (error instanceof CliConfigError) {
      deps.stderr(`${error.message}\n`);
      return CLI_EXIT.USAGE;
    }
    throw error;
  }
  if (connection.plaintextRemote)
    deps.stderr(
      "경고: loopback이 아닌 주소에 http로 접속한다. 토큰이 평문으로 전송된다. https를 쓴다\n",
    );

  try {
    const result = await execute(deps, connection, parsed.command);
    deps.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return CLI_EXIT.OK;
  } catch (error) {
    if (error instanceof HttpFailure) {
      deps.stderr(describeHttpFailure(error));
      return CLI_EXIT.HTTP;
    }
    if (error instanceof ConnectFailure) {
      deps.stderr(`연결하지 못했다(${error.message})\n`);
      return CLI_EXIT.CONNECT;
    }
    throw error;
  }
}
