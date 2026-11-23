import { afterEach, describe, expect, it } from "@jest/globals";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CLI_EXIT, runCli, type CliDeps } from "../../src/cli/index.js";

// RQ-047, ADR-0011 결정 7·구현 중 확정 28: 시간 초과는 헤더 대기와 본문 읽기 모두 종료 코드 3이고 스택 트레이스가 없다.
// 실제 로컬 HTTP 서버와 실제 fetch를 쓴다. DB는 필요 없다.

// 테스트용 가짜 토큰이다. 실제 시크릿이 아니다.
const TOKEN = "cli-fake-token-timeout-000000000000000000001";

describe("CLI 시간 초과 (결정 7)", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.closeAllConnections();
            s.close(() => resolve());
          }),
      ),
    );
  });

  async function listen(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function deps(url: string): { deps: CliDeps; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      deps: {
        env: { MAILO_CLI_TOKEN: TOKEN, MAILO_CLI_URL: url },
        fetch: globalThis.fetch,
        readTextFile: async () => "",
        stdout: (t) => void out.push(t),
        stderr: (t) => void err.push(t),
        timeoutMs: 300,
      },
    };
  }

  it("서버가 헤더만 보내고 본문을 멈추면 종료 코드 3이고 스택 트레이스가 없다", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"entries":');
      // 본문을 끝내지 않는다.
    });
    const h = deps(url);

    const code = await runCli(["audit", "list"], h.deps);

    expect(code).toBe(CLI_EXIT.CONNECT);
    expect(h.out).toEqual([]);
    const text = h.err.join("");
    expect(text).toContain("연결하지 못했다(시간 초과)");
    expect(text).not.toMatch(/\bat \S+ \(|TimeoutError|DOMException/);
    expect(text).not.toContain(TOKEN);
  });

  it("오류 상태의 본문이 멈춰도 종료 코드 3이다", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/problem+json" });
      res.write('{"type":');
    });
    const h = deps(url);
    expect(await runCli(["audit", "list"], h.deps)).toBe(CLI_EXIT.CONNECT);
  });

  it("헤더 자체가 오지 않아도 종료 코드 3이다", async () => {
    const url = await listen(() => {
      // 응답하지 않는다.
    });
    const h = deps(url);
    expect(await runCli(["audit", "list"], h.deps)).toBe(CLI_EXIT.CONNECT);
    expect(h.err.join("")).toContain("시간 초과");
  });
});
