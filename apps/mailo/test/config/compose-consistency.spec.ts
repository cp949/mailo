import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SHUTDOWN_MARGIN_MS,
  loadConfig,
  workerDrainTimeoutMs,
} from "../../src/config/index.js";
import { parseComposeDurationMs } from "../../src/config/load-config.js";
import { testEnv } from "../support/rest-app.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const compose = readFileSync(`${REPO}docker-compose.yml`, "utf8");
const envExample = readFileSync(`${REPO}.env.example`, "utf8");

/** `.env.example`에서 주석 처리되지 않은 `NAME=value` 줄의 값을 읽는다. */
function exampleValue(name: string): string | undefined {
  const match = new RegExp(`^${name}=(.*)$`, "m").exec(envExample);
  return match?.[1]?.trim();
}

describe("docker-compose.yml과 .env.example의 관계 (M6, RQ-025)", () => {
  it("stop_grace_period는 MAILO_STOP_GRACE_PERIOD로 바꿀 수 있고 앱에도 같은 변수로 전달된다", () => {
    expect(compose).toMatch(
      /^\s+stop_grace_period: \$\{MAILO_STOP_GRACE_PERIOD:-150s\}$/m,
    );
    expect(compose).toMatch(
      /^\s+MAILO_STOP_GRACE_PERIOD: \$\{MAILO_STOP_GRACE_PERIOD:-150s\}$/m,
    );
  });

  it("compose 기본 grace는 .env.example의 lease로 계산한 drain 상한 + 10초 이상이다", () => {
    const grace =
      /stop_grace_period: \$\{MAILO_STOP_GRACE_PERIOD:-([^}]+)\}/.exec(
        compose,
      )![1]!;
    const lease = Number(exampleValue("MAILO_LEASE_SECONDS"));

    expect(Number.isInteger(lease)).toBe(true);
    expect(parseComposeDurationMs(grace)!).toBeGreaterThanOrEqual(
      workerDrainTimeoutMs(lease) + SHUTDOWN_MARGIN_MS,
    );
  });

  it("앱 설정 기본 lease와 .env.example의 lease가 같고, compose 기본 grace로 기동 검사를 통과한다", () => {
    const config = loadConfig(
      testEnv({
        MAILO_CALLERS_FILE: "/etc/mailo/callers.json",
        MAILO_STOP_GRACE_PERIOD: "150s",
      }),
    );

    expect(config.worker.lease.seconds).toBe(
      Number(exampleValue("MAILO_LEASE_SECONDS")),
    );
    expect(config.stopGracePeriodMs).toBe(150_000);
  });

  it(".env.example는 MAILO_STOP_GRACE_PERIOD와 DB 시간제한 변수를 설명한다", () => {
    for (const name of [
      "MAILO_STOP_GRACE_PERIOD",
      "MAILO_DB_STATEMENT_TIMEOUT_MS",
      "MAILO_DB_LOCK_TIMEOUT_MS",
      "MAILO_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS",
      "MAILO_DB_QUERY_TIMEOUT_MS",
      "MAILO_OPS_TOKEN",
    ])
      expect(envExample).toContain(name);
  });
});

describe("docker-compose.yml의 DB 비밀번호 (M4)", () => {
  it("POSTGRES_PASSWORD에는 기본값이 없고 비어 있으면 compose가 중단한다(postgres·mailo 둘 다)", () => {
    const required = compose.match(/\$\{POSTGRES_PASSWORD:\?[^}]+\}/g) ?? [];

    expect(required).toHaveLength(2);
    expect(compose).not.toMatch(/POSTGRES_PASSWORD:-/);
    expect(compose).not.toContain("mailo-dev-password");
  });

  it(".env.example의 샘플 비밀번호는 production에서 거부된다", () => {
    const sample = exampleValue("POSTGRES_PASSWORD")!;
    const message = (() => {
      try {
        loadConfig(
          testEnv({
            NODE_ENV: "production",
            MAILO_CALLERS_FILE: "/etc/mailo/callers.json",
            MAILO_DATABASE_URL: `postgres://mailo:${sample}@localhost:5432/mailo`,
          }),
        );
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(message).toContain("DB 비밀번호");
  });
});

const dockerfile = readFileSync(`${REPO}Dockerfile`, "utf8");
const rootPackage = readFileSync(`${REPO}package.json`, "utf8");
const mailoService = compose.slice(compose.indexOf("\n  mailo:"));

describe("이미지·컨테이너 강화 (M9)", () => {
  it("mailo 서비스는 read_only 루트와 /tmp tmpfs, 모든 capability 제거, no-new-privileges를 쓴다", () => {
    expect(mailoService).toMatch(/^ {4}read_only: true$/m);
    expect(mailoService).toMatch(/^ {4}tmpfs:\n {6}- \/tmp$/m);
    expect(mailoService).toMatch(/^ {4}cap_drop:\n {6}- ALL$/m);
    expect(mailoService).toMatch(
      /^ {4}security_opt:\n {6}- no-new-privileges:true$/m,
    );
  });

  it("Dockerfile은 base 이미지를 sha256 digest로 고정하고 /repo 전체를 node에 chown하지 않는다", () => {
    expect(dockerfile).toMatch(
      /^FROM node:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64} AS base$/m,
    );
    // 주석은 제외하고 명령에서만 찾는다.
    expect(dockerfile.replace(/^\s*#.*$/gm, "")).not.toMatch(/chown/);
    expect(dockerfile).toMatch(/^USER node$/m);
  });

  it("packageManager는 pnpm 버전과 sha512 해시를 함께 고정한다", () => {
    expect(rootPackage).toMatch(
      /"packageManager": "pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}"/,
    );
  });
});

/** postgres와 mailo 사이에 둔 mailpit 서비스 블록. 없으면 빈 문자열이다. */
const mailpitService = (() => {
  const start = compose.indexOf("\n  mailpit:");
  return start < 0 ? "" : compose.slice(start, compose.indexOf("\n  mailo:"));
})();

/**
 * 개발용 Mailpit(GitHub 이슈 #2). 기본 `docker compose up`에 들어가지 않는 opt-in profile이어야 한다(RQ-029).
 * 환경: 없음. compose 파일을 글자로 읽는다. 실제 기동 확인은 `docs/operations/deployment.md` "개발용 Mailpit"의 절차다.
 */
describe("개발용 Mailpit profile (RQ-029, GitHub 이슈 #2)", () => {
  it("mailpit 서비스는 profile mailpit으로만 켜지고 postgres·mailo에는 profile이 없다", () => {
    expect(mailpitService).toMatch(/^ {4}profiles: \["mailpit"\]$/m);
    expect(compose.match(/^ {4}profiles:/gm)).toHaveLength(1);
  });

  it("이미지는 버전 태그와 sha256 digest로 고정한다", () => {
    expect(mailpitService).toMatch(
      /^ {4}image: axllent\/mailpit:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/m,
    );
  });

  it("웹 UI만 127.0.0.1에 공개하고 SMTP 1025는 compose 내부 네트워크에만 둔다", () => {
    const ports = mailpitService.match(/^ {6}- "(.+)"$/gm) ?? [];
    expect(ports).toEqual([
      '      - "127.0.0.1:${MAILO_MAILPIT_UI_PORT:-8025}:8025"',
    ]);
  });

  it("non-root, read_only 루트와 /tmp tmpfs, 모든 capability 제거, no-new-privileges를 쓴다", () => {
    expect(mailpitService).toMatch(/^ {4}user: "\d+:\d+"$/m);
    expect(mailpitService).not.toMatch(/^ {4}user: "0:/m);
    expect(mailpitService).toMatch(/^ {4}read_only: true$/m);
    expect(mailpitService).toMatch(/^ {4}tmpfs:\n {6}- \/tmp$/m);
    expect(mailpitService).toMatch(/^ {4}cap_drop:\n {6}- ALL$/m);
    expect(mailpitService).toMatch(
      /^ {4}security_opt:\n {6}- no-new-privileges:true$/m,
    );
  });

  it(".env.example는 Mailpit 발송 설정 예시와 UI 포트, DB 공개 포트 변경 안내를 담는다", () => {
    for (const text of [
      "#MAILO_SMTP_SECURITY=none",
      "#MAILO_SMTP_HOST=mailpit",
      "#MAILO_SMTP_PORT=1025",
      "MAILO_MAILPIT_UI_PORT",
      "#MAILO_DB_PUBLISH_PORT=15432",
    ])
      expect([text, envExample.includes(text)]).toEqual([text, true]);
    // 운영 기본값은 바꾸지 않는다.
    expect(exampleValue("MAILO_DB_PUBLISH_PORT")).toBe("5432");
    expect(compose).toContain(
      '"127.0.0.1:${MAILO_DB_PUBLISH_PORT:-5432}:5432"',
    );
  });
});
