/**
 * 실제 AWS SDK와 로컬 HTTP fixture로 어댑터를 검증한다(RQ-079, ADR-0016 결정 8·9).
 * 가짜 클라이언트로는 볼 수 없는 것을 본다: 엔드포인트 환경 변수, SDK 오류의 이름·상태, 재시도, 연결 정리, 자연 종료.
 * 실제 AWS(IAM, KMS, 자격 증명 체인, 서명 검증)는 확인하지 않는다.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import secretSource from "../index.js";
import {
  eventually,
  sendError,
  sendSecret,
  startFixture,
} from "./support/fixture.mjs";

const CANARY = "CANARY-SDK-HTTP-9c1e";
const CHILD = new URL("./support/resolve-in-child.mjs", import.meta.url);

let fixture;
const savedEnv = {};
const ENV_NAMES = [
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_SECRETS_MANAGER",
];

/** fixture를 엔드포인트로 가리키는 환경. 자격 증명은 가짜다. */
function fixtureEnv(endpoint) {
  return {
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_ENDPOINT_URL_SECRETS_MANAGER: endpoint,
  };
}

beforeEach(() => {
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
});

afterEach(async () => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  await fixture?.close();
  fixture = undefined;
});

async function start(handler) {
  fixture = await startFixture(handler);
  Object.assign(process.env, fixtureEnv(fixture.endpoint));
}

const signal = () => new AbortController().signal;

async function failureOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("실패해야 한다");
}

describe("실제 SDK 경로(RQ-079, ADR-0016 결정 8)", () => {
  it("SDK 표준 환경 변수 AWS_ENDPOINT_URL_SECRETS_MANAGER의 엔드포인트로 GetSecretValue를 AWSCURRENT 단계로 보낸다", async () => {
    await start(({ response }) => sendSecret(response, '{"password":"p"}'));

    const value = await secretSource.resolve("aws-sm://prod/smtp#password", {
      signal: signal(),
    });

    assert.equal(value, "p");
    assert.deepEqual(fixture.requests, [
      {
        target: "secretsmanager.GetSecretValue",
        body: { SecretId: "prod/smtp", VersionStage: "AWSCURRENT" },
      },
    ]);
  });

  it("서비스가 돌려준 오류 이름을 닫힌 코드로 바꾸고 서비스 메시지와 SecretId를 싣지 않는다", async () => {
    const cases = [
      [400, "ResourceNotFoundException", "not-found"],
      [400, "AccessDeniedException", "access-denied"],
      [400, "InvalidRequestException", "invalid-value"],
      [400, "InvalidParameterException", "invalid-value"],
      [400, "DecryptionFailure", "access-denied"],
    ];
    for (const [status, type, code] of cases) {
      await start(({ response }) =>
        sendError(response, status, type, `${CANARY} message`),
      );

      const error = await failureOf(
        secretSource.resolve(`aws-sm://${CANARY}/id`, { signal: signal() }),
      );

      assert.equal(error.code, code, type);
      assert.ok(
        !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(
          CANARY,
        ),
      );
      assert.ok(!error.stack.includes(CANARY));
      await fixture.close();
      fixture = undefined;
    }
  });

  it("제한 오류는 SDK 기본 재시도(3회) 뒤 throttled로, 서버 오류는 unavailable로 끝난다", async () => {
    await start(({ response }) =>
      sendError(response, 400, "ThrottlingException", CANARY),
    );
    const throttled = await failureOf(
      secretSource.resolve("aws-sm://x", { signal: signal() }),
    );
    assert.equal(throttled.code, "throttled");
    assert.equal(fixture.requests.length, 3);
    await fixture.close();

    await start(({ response }) =>
      sendError(response, 500, "InternalServiceError", CANARY),
    );
    const unavailable = await failureOf(
      secretSource.resolve("aws-sm://x", { signal: signal() }),
    );
    assert.equal(unavailable.code, "unavailable");
    assert.equal(fixture.requests.length, 3);
  });

  it("엔드포인트에 닿지 못하면 unavailable이다", async () => {
    await start(({ response }) => sendSecret(response, "v"));
    process.env.AWS_ENDPOINT_URL_SECRETS_MANAGER = "http://127.0.0.1:1";

    const error = await failureOf(
      secretSource.resolve("aws-sm://x", { signal: signal() }),
    );

    assert.equal(error.code, "unavailable");
  });
});

describe("연결 정리와 중단(ADR-0016 결정 3·8, 묶음 A 리뷰 지적)", () => {
  it("해석이 끝나면 SDK가 연 연결을 모두 닫는다", async () => {
    await start(({ response }) => sendSecret(response, "v"));

    await secretSource.resolve("aws-sm://x", { signal: signal() });

    assert.ok(
      await eventually(() => fixture.openConnections() === 0),
      "해석 뒤 서버 쪽 연결이 남아 있다",
    );
  });

  it("오류로 끝나도 연결을 모두 닫는다", async () => {
    await start(({ response }) =>
      sendError(response, 400, "AccessDeniedException", "x"),
    );

    await failureOf(secretSource.resolve("aws-sm://x", { signal: signal() }));

    assert.ok(await eventually(() => fixture.openConnections() === 0));
  });

  it("응답을 기다리는 중 abort하면 바로 unavailable로 끝나고 연결을 닫는다", async () => {
    await start(() => {
      // 응답하지 않는다.
    });
    const controller = new AbortController();

    const pending = failureOf(
      secretSource.resolve("aws-sm://x", { signal: controller.signal }),
    );
    assert.ok(await eventually(() => fixture.requests.length === 1));
    controller.abort();
    const error = await pending;

    assert.equal(error.code, "unavailable");
    assert.ok(await eventually(() => fixture.openConnections() === 0));
  });
});

/** 자식 프로세스를 실행하고 종료까지 기다린다. 제한 시간 안에 끝나지 않으면 죽이고 timedOut으로 표시한다. */
function runChild(args, env, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD.pathname, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    });
  });
}

describe("프로세스 수명(ADR-0016 결정 3, 묶음 A 리뷰 지적)", () => {
  it("모듈을 불러오기만 하면 핸들을 남기지 않고 자연 종료한다", async () => {
    const result = await runChild(["load"], {});

    assert.deepEqual(result, {
      code: 0,
      stdout: "loaded:aws-sm",
      stderr: "",
      timedOut: false,
    });
  });

  it("해석 한 번 뒤 process.exit 없이 자연 종료하고 stdout·stderr에 값과 SecretId가 없다", async () => {
    await start(({ response }) => sendSecret(response, `${CANARY}-value`));

    const result = await runChild(
      ["resolve", `aws-sm://${CANARY}/id`],
      fixtureEnv(fixture.endpoint),
    );

    assert.deepEqual(result, {
      code: 0,
      stdout: "resolved",
      stderr: "",
      timedOut: false,
    });
  });

  it("실패해도 자연 종료하고 출력에 서비스 메시지가 없다(SDK 기본 로거는 조용하다)", async () => {
    await start(({ response }) =>
      sendError(response, 500, "InternalServiceError", `${CANARY} message`),
    );

    const result = await runChild(
      ["resolve", `aws-sm://${CANARY}/id`],
      fixtureEnv(fixture.endpoint),
    );

    assert.deepEqual(result, {
      code: 0,
      stdout: "rejected:unavailable",
      stderr: "",
      timedOut: false,
    });
  });
});
