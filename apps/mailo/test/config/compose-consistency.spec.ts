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
