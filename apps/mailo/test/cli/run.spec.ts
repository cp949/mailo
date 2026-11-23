import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLI_EXIT,
  runCli,
  sanitizeForTerminal,
  type CliDeps,
} from "../../src/cli/index.js";

// RQ-047, ADR-0011 결정 7: CLI 실행. 접속 주소·토큰 변수, 종료 코드, 토큰 비노출. 서버는 가짜 fetch로 대체한다.

// 테스트용 가짜 토큰이다. 실제 시크릿이 아니다. 출력·오류에 나오면 안 된다.
const TOKEN = "cli-fake-token-canary-0000000000000000000001";
const JOB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

interface Call {
  url: string;
  method: string;
  authorization: string | null;
}

function harness(
  respond: (call: Call) => Response | Promise<Response> = () =>
    new Response("{}", { status: 200 }),
  env: NodeJS.ProcessEnv = {},
) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    env: { MAILO_CLI_TOKEN: TOKEN, ...env },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
      };
      calls.push(call);
      return respond(call);
    },
    readTextFile: async () => {
      throw Object.assign(new Error("unused"), { code: "ENOENT" });
    },
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  };
  return { calls, out, err, deps };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("접속 주소와 토큰 (결정 7)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mailo-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("기본 주소는 http://127.0.0.1:<MAILO_PORT>이고 MAILO_PORT가 없으면 3000이다", async () => {
    const a = harness();
    await runCli(["queue", "stats"], a.deps);
    expect(a.calls[0]!.url).toBe("http://127.0.0.1:3000/health/ready");

    const b = harness(undefined, { MAILO_PORT: "4100" });
    await runCli(["queue", "stats"], b.deps);
    expect(b.calls[0]!.url).toBe("http://127.0.0.1:4100/health/ready");
  });

  it("MAILO_CLI_URL이 기본 주소보다 우선하고 끝 슬래시·경로 접두사를 처리한다", async () => {
    const a = harness(undefined, {
      MAILO_CLI_URL: "https://mailo.example.test/prefix/",
      MAILO_PORT: "4100",
    });
    await runCli(["audit", "list"], a.deps);
    expect(a.calls[0]!.url).toBe("https://mailo.example.test/prefix/ops/audit");
  });

  it.each([
    ["스킴이 http·https가 아님", "ftp://x.test"],
    ["사용자 정보 포함", "http://user:pass@x.test"],
    ["URL이 아님", "not a url"],
  ])(
    "MAILO_CLI_URL이 올바르지 않으면(%s) 호출 없이 종료 코드 1이다",
    async (_n, url) => {
      const a = harness(undefined, { MAILO_CLI_URL: url });
      const code = await runCli(["status"], a.deps);
      expect(code).toBe(CLI_EXIT.USAGE);
      expect(a.calls).toEqual([]);
      expect(a.err.join("")).not.toContain("pass");
    },
  );

  it("토큰을 Bearer 헤더로 보낸다", async () => {
    const a = harness();
    await runCli(["queue", "stats"], a.deps);
    expect(a.calls[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("MAILO_CLI_TOKEN_FILE이 MAILO_CLI_TOKEN보다 우선하고 끝의 줄바꿈을 지운다", async () => {
    const file = path.join(dir, "token");
    writeFileSync(file, "file-token-0000000000000000000000000000000\n");
    const a = harness(undefined, { MAILO_CLI_TOKEN_FILE: file });
    a.deps.readTextFile = async (p) => {
      expect(p).toBe(file);
      return "file-token-0000000000000000000000000000000\n";
    };
    await runCli(["queue", "stats"], a.deps);
    expect(a.calls[0]!.authorization).toBe(
      "Bearer file-token-0000000000000000000000000000000",
    );
  });

  it("토큰 파일을 읽지 못하면 환경 변수로 넘어가지 않고 종료 코드 1이다. 오류에는 errno 코드만 있다", async () => {
    const a = harness(undefined, {
      MAILO_CLI_TOKEN_FILE: "/run/secrets/canary-path-9d2e",
    });
    const code = await runCli(["status"], a.deps);
    expect(code).toBe(CLI_EXIT.USAGE);
    expect(a.calls).toEqual([]);
    const text = a.err.join("");
    expect(text).toContain("ENOENT");
    expect(text).not.toContain(TOKEN);
  });

  it("토큰이 없거나 공백·제어 문자를 포함하면 호출 없이 종료 코드 1이다", async () => {
    for (const env of [
      { MAILO_CLI_TOKEN: "" },
      { MAILO_CLI_TOKEN: "has space-0000000000000000000000000000" },
      { MAILO_CLI_TOKEN: "line\nbreak-00000000000000000000000000" },
    ]) {
      const a = harness(undefined, env);
      if (env.MAILO_CLI_TOKEN === "") delete a.deps.env.MAILO_CLI_TOKEN;
      expect(await runCli(["status"], a.deps)).toBe(CLI_EXIT.USAGE);
      expect(a.calls).toEqual([]);
      expect(a.err.join("")).not.toContain("has space");
    }
  });

  it("서버의 MAILO_OPS_* 변수를 읽지 않는다", async () => {
    const a = harness(undefined, {
      MAILO_OPS_TOKEN: "ops-read-token-must-not-be-used-000000001",
    });
    delete a.deps.env.MAILO_CLI_TOKEN;
    expect(await runCli(["status"], a.deps)).toBe(CLI_EXIT.USAGE);
    expect(a.calls).toEqual([]);
  });

  it("http로 loopback이 아닌 주소에 보내면 평문 전송 경고를 stderr에 낸다", async () => {
    const a = harness(undefined, {
      MAILO_CLI_URL: "http://mailo.internal:3000",
    });
    await runCli(["audit", "list"], a.deps);
    expect(a.err.join("")).toContain("평문");
    const b = harness();
    await runCli(["audit", "list"], b.deps);
    expect(b.err.join("")).toBe("");
  });
});

describe("명령과 REST 호출 (결정 7)", () => {
  it("status는 /health/ready와 /ops/pauses를 부르고 응답을 한 JSON으로 묶어 출력한다", async () => {
    const a = harness((call) =>
      call.url.endsWith("/health/ready")
        ? json({ status: "UP" })
        : json({ pauses: [] }),
    );
    const code = await runCli(["status"], a.deps);
    expect(code).toBe(CLI_EXIT.OK);
    expect(a.calls.map((c) => c.url.replace(/^.*:3000/, ""))).toEqual([
      "/health/ready",
      "/ops/pauses",
    ]);
    expect(JSON.parse(a.out.join(""))).toEqual({
      ready: { status: "UP" },
      pauses: { pauses: [] },
    });
  });

  it("queue stats는 /health/ready 응답의 queue 값만 출력한다", async () => {
    const a = harness(() => json({ status: "UP", queue: { dueCount: 3 } }));
    expect(await runCli(["queue", "stats"], a.deps)).toBe(CLI_EXIT.OK);
    expect(JSON.parse(a.out.join(""))).toEqual({ dueCount: 3 });
  });

  it("queue stats는 응답에 queue가 없으면(토큰이 운영자 토큰이 아님) 종료 코드 2다", async () => {
    const a = harness(() => json({ status: "UP" }));
    expect(await runCli(["queue", "stats"], a.deps)).toBe(CLI_EXIT.HTTP);
    expect(a.out.join("")).toBe("");
  });

  it("jobs show와 audit list는 서버 응답 JSON을 그대로 출력한다", async () => {
    const job = { jobId: JOB, status: "PENDING" };
    const a = harness(() => json(job));
    expect(await runCli(["jobs", "show", JOB], a.deps)).toBe(CLI_EXIT.OK);
    expect(a.calls[0]).toMatchObject({
      url: `http://127.0.0.1:3000/ops/jobs/${JOB}`,
      method: "GET",
    });
    expect(JSON.parse(a.out.join(""))).toEqual(job);

    const b = harness(() => json({ entries: [], nextBefore: null }));
    await runCli(["audit", "list", "--limit", "5", "--before", "40"], b.deps);
    expect(b.calls[0]!.url).toBe(
      "http://127.0.0.1:3000/ops/audit?limit=5&before=40",
    );
  });

  it("pause·resume·jobs cancel은 --yes일 때만 호출하고 알맞은 메서드·경로를 쓴다", async () => {
    const run = async (argv: string[]) => {
      const a = harness(() => json({ changed: true }));
      const code = await runCli(argv, a.deps);
      return { code, calls: a.calls };
    };
    expect((await run(["pause", "--all"])).calls).toEqual([]);
    expect((await run(["pause", "--all"])).code).toBe(CLI_EXIT.USAGE);

    const paths = async (argv: string[]) => {
      const { code, calls } = await run(argv);
      expect(code).toBe(CLI_EXIT.OK);
      return calls.map(
        (c) => `${c.method} ${c.url.replace("http://127.0.0.1:3000", "")}`,
      );
    };
    expect(await paths(["pause", "--all", "--yes"])).toEqual([
      "PUT /ops/pauses/all",
    ]);
    expect(await paths(["resume", "--all", "--yes"])).toEqual([
      "DELETE /ops/pauses/all",
    ]);
    expect(await paths(["pause", "--caller", "billing", "--yes"])).toEqual([
      "PUT /ops/pauses/callers/billing",
    ]);
    expect(await paths(["resume", "--caller", "billing", "--yes"])).toEqual([
      "DELETE /ops/pauses/callers/billing",
    ]);
    expect(await paths(["jobs", "cancel", JOB, "--yes"])).toEqual([
      `POST /ops/jobs/${JOB}/cancel`,
    ]);
  });

  it("accounts list와 pause·resume --account는 계정 경로를 쓴다 (RQ-061, ADR-0013 결정 5)", async () => {
    const run = async (argv: string[]) => {
      const a = harness(() => json({ accounts: [] }));
      const code = await runCli(argv, a.deps);
      return { code, calls: a.calls };
    };
    const paths = async (argv: string[]) => {
      const { code, calls } = await run(argv);
      expect(code).toBe(CLI_EXIT.OK);
      return calls.map(
        (c) => `${c.method} ${c.url.replace("http://127.0.0.1:3000", "")}`,
      );
    };
    expect(await paths(["accounts", "list"])).toEqual(["GET /ops/accounts"]);
    expect(await paths(["pause", "--account", "marketing", "--yes"])).toEqual([
      "PUT /ops/pauses/accounts/marketing",
    ]);
    expect(await paths(["resume", "--account", "marketing", "--yes"])).toEqual([
      "DELETE /ops/pauses/accounts/marketing",
    ]);
    // --yes 없이는 호출하지 않는다.
    const noYes = await run(["pause", "--account", "marketing"]);
    expect(noYes.code).toBe(CLI_EXIT.USAGE);
    expect(noYes.calls).toEqual([]);
  });

  it("accounts list의 오류 응답에 든 제어 문자를 치환해 낸다 (sanitizeForTerminal)", async () => {
    const a = harness(
      () => new Response('{"title":"x\u001b[31mred"}', { status: 500 }),
    );
    expect(await runCli(["accounts", "list"], a.deps)).toBe(CLI_EXIT.HTTP);
    expect(a.err.join("")).not.toContain("\u001b");
    expect(a.err.join("")).toContain("\uFFFD");
  });
});

describe("종료 코드 (결정 7: 성공 0, 사용법 1, HTTP 2, 연결 3)", () => {
  it("성공은 0이고 JSON을 stdout에 낸다", async () => {
    const a = harness(() => json({ pauses: [] }));
    expect(await runCli(["audit", "list"], a.deps)).toBe(0);
    expect(a.err.join("")).toBe("");
  });

  it("사용법 오류는 1이고 호출하지 않는다", async () => {
    const a = harness();
    expect(await runCli(["nope"], a.deps)).toBe(1);
    expect(a.calls).toEqual([]);
    expect(a.err.join("")).toContain("사용법");
  });

  it("--help는 0이고 도움말을 stdout에 낸다", async () => {
    const a = harness();
    expect(await runCli(["--help"], a.deps)).toBe(0);
    expect(a.out.join("")).toContain("MAILO_CLI_TOKEN_FILE");
    expect(a.calls).toEqual([]);
  });

  it("HTTP 오류(401·403·404·409·503·3xx)는 2이고 상태와 problem 본문을 stderr에 낸다", async () => {
    for (const status of [401, 403, 404, 409, 503, 302]) {
      const a = harness(() =>
        status === 302
          ? new Response(null, {
              status,
              headers: { Location: "http://evil.test/" },
            })
          : json({ type: "urn:mailo:problem:x", status }, status),
      );
      expect(await runCli(["jobs", "show", JOB], a.deps)).toBe(CLI_EXIT.HTTP);
      expect(a.out.join("")).toBe("");
      expect(a.err.join("")).toContain(`HTTP ${status}`);
    }
  });

  it("2xx인데 JSON이 아니면 2다", async () => {
    const a = harness(() => new Response("<html>", { status: 200 }));
    expect(await runCli(["audit", "list"], a.deps)).toBe(CLI_EXIT.HTTP);
  });

  it("연결 실패·시간 초과는 3이고 오류에 토큰과 URL이 없다", async () => {
    for (const failure of [
      Object.assign(new TypeError("fetch failed http://x:3000 " + TOKEN), {
        cause: { code: "ECONNREFUSED" },
      }),
      Object.assign(new Error("aborted"), { name: "TimeoutError" }),
    ]) {
      const a = harness(() => {
        throw failure;
      });
      expect(await runCli(["status"], a.deps)).toBe(CLI_EXIT.CONNECT);
      const text = a.err.join("");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("3000 ");
    }
    const a = harness(() => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      });
    });
    await runCli(["status"], a.deps);
    expect(a.err.join("")).toContain("ECONNREFUSED");
  });

  it("서버 유래 문자열의 제어 문자(C0 일부, DEL, C1)는 출력 전에 치환한다. 줄바꿈과 탭은 남긴다", async () => {
    const hostile = "a\u001b[31mred\u009b2Jb\u007fc\rd\u0000e";
    const failing = harness(() =>
      json({ type: "urn:mailo:problem:x", detail: hostile }, 409),
    );
    expect(await runCli(["jobs", "show", JOB], failing.deps)).toBe(
      CLI_EXIT.HTTP,
    );
    const ok = harness(() => json({ note: hostile }));
    expect(await runCli(["audit", "list"], ok.deps)).toBe(CLI_EXIT.OK);

    for (const text of [failing.err.join(""), ok.out.join("")]) {
      // eslint-disable-next-line no-control-regex
      expect(text).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
      expect(text).toContain("red");
    }
    expect(ok.out.join("")).toContain("\n");
    expect(sanitizeForTerminal("x\ty\nz\u001b\u009b")).toBe(
      "x\ty\nz\uFFFD\uFFFD",
    );
  });

  it("어떤 경로에서도 stdout·stderr에 토큰이 나오지 않는다(RQ-027)", async () => {
    const outputs: string[] = [];
    for (const respond of [
      () => json({ ok: true }),
      () => json({ type: "urn:mailo:problem:unauthorized" }, 401),
      () => {
        throw new TypeError("fetch failed " + TOKEN);
      },
    ]) {
      const a = harness(respond);
      await runCli(["status"], a.deps);
      outputs.push(...a.out, ...a.err);
    }
    const bad = harness();
    await runCli(["--token", TOKEN], bad.deps);
    outputs.push(...bad.out, ...bad.err);
    expect(outputs.join("\n")).not.toContain(TOKEN);
  });
});
