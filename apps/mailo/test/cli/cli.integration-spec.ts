/**
 * 운영 CLI를 실제 서버(`/health/ready`, `/ops/*`)와 PostgreSQL에 붙여 검증한다(RQ-047, ADR-0011 결정 7).
 * 고정하는 것: 읽기 명령의 출력, 변경 명령의 `--yes`와 감사 기록, 읽기 토큰의 변경 거부(종료 코드 2),
 * 토큰 파일로만 받은 토큰이 서버·CLI 출력 어디에도 남지 않음(RQ-027), 연결 실패(종료 코드 3).
 */
import "reflect-metadata";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI_EXIT, runCli, type CliDeps } from "../../src/cli/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { migrate } from "../support/queue-fixtures.js";
import {
  CANARY,
  postJob,
  startRestApp,
  type RestApp,
} from "../support/rest-app.js";

// 테스트용 가짜 토큰이다. 실제 시크릿이 아니다.
const READ = "cli-read-fake-token-0000000000000000000000001";
const ADMIN = "cli-admin-oncall-fake-token-000000000000001";

describe("운영 CLI 통합 (RQ-047, ADR-0011 결정 7)", () => {
  let db: TestDatabase;
  let app: RestApp;
  let dir: string;
  let readTokenFile: string;
  let adminTokenFile: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    app = await startRestApp({
      pool: db.pool,
      env: {
        MAILO_OPS_TOKEN: READ,
        MAILO_OPS_ADMIN_NAMES: "oncall",
        MAILO_OPS_ADMIN_TOKEN_ONCALL: ADMIN,
      },
    });
    dir = mkdtempSync(path.join(tmpdir(), "mailo-cli-it-"));
    readTokenFile = path.join(dir, "read-token");
    adminTokenFile = path.join(dir, "admin-token");
    writeFileSync(readTokenFile, `${READ}\n`);
    writeFileSync(adminTokenFile, `${ADMIN}\n`);
    chmodSync(readTokenFile, 0o600);
    chmodSync(adminTokenFile, 0o600);
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    app.app.useLogger(app.logs.logger);
    await db.pool.query("DELETE FROM mail_jobs");
    await db.pool.query("DELETE FROM mail_send_controls");
    await db.pool.query("DELETE FROM mail_ops_audit");
    app.logs.lines.length = 0;
  });

  /** 실제 fetch와 파일을 쓰는 CLI를 돌리고 종료 코드와 출력을 모은다. */
  async function cli(
    argv: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      env: { MAILO_CLI_URL: app.baseUrl, ...env },
      fetch: globalThis.fetch,
      readTextFile: (file) => readFile(file, "utf8"),
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
    };
    const code = await runCli(argv, deps);
    return { code, out: out.join(""), err: err.join("") };
  }
  const asRead = { MAILO_CLI_TOKEN_FILE: "" };
  const asAdmin = { MAILO_CLI_TOKEN_FILE: "" };

  beforeAll(() => {
    asRead.MAILO_CLI_TOKEN_FILE = readTokenFile;
    asAdmin.MAILO_CLI_TOKEN_FILE = adminTokenFile;
  });

  async function pauseRows(): Promise<unknown[]> {
    const { rows } = await db.pool.query(
      "SELECT scope_type, scope_id, paused_by FROM mail_send_controls ORDER BY scope_type, scope_id",
    );
    return rows;
  }

  it("status: /health/ready와 /ops/pauses를 묶어 출력한다", async () => {
    const result = await cli(["status"], asRead);

    expect(result.code).toBe(CLI_EXIT.OK);
    const body = JSON.parse(result.out);
    expect(body.ready.status).toBe("UP");
    expect(body.ready.sendControls).toEqual({
      allPaused: false,
      pausedCallerCount: 0,
      pausedAccountCount: 0,
    });
    expect(body.pauses).toEqual({ pauses: [] });
  });

  it("queue stats: 운영자 응답의 queue 값을 출력한다. 호출처 키처럼 운영자 토큰이 아니면 종료 코드 2다", async () => {
    const result = await cli(["queue", "stats"], asRead);
    expect(result.code).toBe(CLI_EXIT.OK);
    expect(JSON.parse(result.out)).toMatchObject({
      dueCount: expect.any(Number),
    });

    const wrong = await cli(["queue", "stats"], {
      MAILO_CLI_TOKEN: "alpha-fake-api-key-0000000000000000000000001",
    });
    expect(wrong.code).toBe(CLI_EXIT.HTTP);
    expect(wrong.err).toContain("읽기·관리 토큰이 아닐 수 있다");
  });

  it("--yes 없는 변경 명령은 서버를 바꾸지 않는다", async () => {
    const result = await cli(["pause", "--all"], asAdmin);

    expect(result.code).toBe(CLI_EXIT.USAGE);
    expect(await pauseRows()).toEqual([]);
    expect(app.logs.lines.join("\n")).not.toContain("ops_pause_set");
  });

  it("pause·resume: 관리 토큰으로 정지·재개하고 토큰 이름이 감사에 남는다", async () => {
    const paused = await cli(["pause", "--all", "--yes"], asAdmin);
    expect(paused.code).toBe(CLI_EXIT.OK);
    expect(JSON.parse(paused.out)).toMatchObject({
      scope: { type: "all" },
      paused: true,
      changed: true,
      pausedBy: "oncall",
    });
    expect(await pauseRows()).toEqual([
      { scope_type: "all", scope_id: "", paused_by: "oncall" },
    ]);

    const callerPause = await cli(
      ["pause", "--caller", "billing", "--yes"],
      asAdmin,
    );
    expect(JSON.parse(callerPause.out)).toMatchObject({ inRegistry: false });

    const list = await cli(["audit", "list", "--limit", "10"], asRead);
    const entries = JSON.parse(list.out).entries;
    expect(entries.map((e: { action: string }) => e.action)).toEqual([
      "PAUSE",
      "PAUSE",
    ]);
    expect(entries[0].actor).toBe("oncall");

    expect((await cli(["resume", "--all", "--yes"], asAdmin)).code).toBe(0);
    expect(
      (await cli(["resume", "--caller", "billing", "--yes"], asAdmin)).code,
    ).toBe(0);
    expect(await pauseRows()).toEqual([]);
  });

  it("accounts list와 pause·resume --account: 계정 상태를 읽고 관리 토큰으로 정지·재개한다 (RQ-061, ADR-0013 결정 5)", async () => {
    const listed = await cli(["accounts", "list"], asRead);
    expect(listed.code).toBe(CLI_EXIT.OK);
    expect(JSON.parse(listed.out).accounts).toMatchObject([
      { accountId: "default", paused: false },
    ]);

    const paused = await cli(
      ["pause", "--account", "default", "--yes"],
      asAdmin,
    );
    expect(paused.code).toBe(CLI_EXIT.OK);
    expect(JSON.parse(paused.out)).toMatchObject({
      scope: { type: "account", id: "default" },
      paused: true,
      changed: true,
      pausedBy: "oncall",
      inConfig: true,
    });
    expect(
      JSON.parse((await cli(["accounts", "list"], asRead)).out).accounts[0],
    ).toMatchObject({ paused: true });

    const denied = await cli(
      ["resume", "--account", "default", "--yes"],
      asRead,
    );
    expect(denied.code).toBe(CLI_EXIT.HTTP);
    expect(denied.err).toContain("HTTP 403");

    const resumed = await cli(
      ["resume", "--account", "default", "--yes"],
      asAdmin,
    );
    expect(resumed.code).toBe(CLI_EXIT.OK);
    expect(JSON.parse(resumed.out)).toMatchObject({
      paused: false,
      changed: true,
    });
    expect(await pauseRows()).toEqual([]);
  });

  it("계정 명령의 출력·감사 목록·로그에 계정 비밀번호·SMTP 사용자·호스트·발신 주소가 없다 (RQ-027, ADR-0013 결정 6)", async () => {
    // 앱의 `default` 계정 값(`testEnv`)이다. 어느 출력에도 나오면 안 된다.
    const secrets = [
      CANARY.smtpPassword,
      "fake-user@example.invalid",
      "smtp.example.invalid",
      "no-reply@example.com",
    ];
    const outputs = [
      await cli(["accounts", "list"], asRead),
      await cli(["pause", "--account", "default", "--yes"], asAdmin),
      await cli(["status"], asRead),
      await cli(["audit", "list"], asRead),
      await cli(["resume", "--account", "default", "--yes"], asAdmin),
    ];

    for (const result of outputs) {
      expect(result.code).toBe(CLI_EXIT.OK);
      for (const secret of secrets) {
        expect(result.out).not.toContain(secret);
        expect(result.err).not.toContain(secret);
      }
    }
    const audit = JSON.parse(outputs[3]!.out).entries;
    expect(audit[0]).toMatchObject({
      action: "PAUSE",
      scope: { type: "account", id: "default" },
    });
    for (const secret of secrets)
      expect(app.logs.lines.join("\n")).not.toContain(secret);
  });

  it("읽기 토큰으로 변경 명령을 부르면 종료 코드 2(403)이고 상태가 바뀌지 않는다", async () => {
    const result = await cli(["pause", "--all", "--yes"], asRead);

    expect(result.code).toBe(CLI_EXIT.HTTP);
    expect(result.err).toContain("HTTP 403");
    expect(await pauseRows()).toEqual([]);
  });

  it("jobs show·jobs cancel: 작업을 조회하고 관리 토큰으로 취소한다. 없는 작업은 종료 코드 2다", async () => {
    const created = await postJob(app, { key: "cli-cancel" });
    const jobId = ((await created.json()) as { jobId: string }).jobId;

    const shown = await cli(["jobs", "show", jobId], asRead);
    expect(shown.code).toBe(CLI_EXIT.OK);
    expect(JSON.parse(shown.out)).toMatchObject({
      jobId,
      callerId: "alpha",
      status: "PENDING",
    });

    const canceled = await cli(["jobs", "cancel", jobId, "--yes"], asAdmin);
    expect(canceled.code).toBe(CLI_EXIT.OK);
    expect(JSON.parse(canceled.out)).toMatchObject({ status: "CANCELED" });

    const again = await cli(["jobs", "cancel", jobId, "--yes"], asAdmin);
    expect(again.code).toBe(CLI_EXIT.OK);

    const missing = await cli(
      ["jobs", "show", "00000000-0000-4000-8000-000000000000"],
      asRead,
    );
    expect(missing.code).toBe(CLI_EXIT.HTTP);
    expect(missing.err).toContain("HTTP 404");
  });

  it("jobs show: 결과 불명 실패(DATA 뒤 연결 끊김)는 outcomeUncertain true로 보이고 수신자·Key·응답 텍스트는 없다 (RQ-048)", async () => {
    const created = await postJob(app, { key: "cli-uncertain" });
    const jobId = ((await created.json()) as { jobId: string }).jobId;
    await db.pool.query(
      `INSERT INTO mail_attempts (job_id, classification, counted, stage, response_text, started_at)
       VALUES ($1, 'TRANSIENT', true, 'DATA', 'CANARY-CLI-RESPONSE-TEXT', now())`,
      [jobId],
    );
    await db.pool.query(
      "UPDATE mail_jobs SET status = 'FAILED', finished_at = now(), failure_reason = 'ATTEMPTS_EXHAUSTED' WHERE id = $1",
      [jobId],
    );

    const shown = await cli(["jobs", "show", jobId], asRead);

    expect(shown.code).toBe(CLI_EXIT.OK);
    expect(JSON.parse(shown.out)).toMatchObject({
      jobId,
      status: "FAILED",
      outcomeUncertain: true,
    });
    expect(shown.out).not.toContain("CANARY-CLI-RESPONSE-TEXT");
    expect(shown.out).not.toContain("cli-uncertain");
    expect(shown.out).not.toContain("kim@example.com");
  });

  it("서버가 없으면 종료 코드 3이다", async () => {
    const port = await freePort();
    const result = await cli(["status"], {
      ...asRead,
      MAILO_CLI_URL: `http://127.0.0.1:${port}`,
    });

    expect(result.code).toBe(CLI_EXIT.CONNECT);
    expect(result.err).toContain("연결하지 못했다(ECONNREFUSED)");
  });

  it("토큰이 CLI 출력과 서버 로그 어디에도 남지 않는다(RQ-027)", async () => {
    const outputs: string[] = [];
    for (const [argv, env] of [
      [["status"], asRead],
      [["pause", "--all", "--yes"], asRead],
      [["resume", "--all", "--yes"], asAdmin],
      [["status", "--token", READ], asRead],
    ] as const) {
      const result = await cli([...argv], env);
      outputs.push(result.out, result.err);
    }

    const haystack = [...outputs, ...app.logs.lines].join("\n");
    expect(haystack).not.toContain(READ);
    expect(haystack).not.toContain(ADMIN);
    const { rows } = await db.pool.query("SELECT * FROM mail_ops_audit");
    expect(JSON.stringify(rows)).not.toContain(ADMIN);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
