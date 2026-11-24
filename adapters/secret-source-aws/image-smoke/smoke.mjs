/**
 * 변형 이미지(-aws) 안에서 어댑터 로드와 X_REF 해석을 확인한다(ADR-0016 결정 9).
 * 가짜 Secrets Manager는 컨테이너 안 127.0.0.1에만 뜬다(`--network none`에서도 동작). 엔드포인트는
 * SDK 표준 환경 변수로 준다. 시험 값은 모두 SMOKE-SENTINEL을 포함하고 출력하지 않는다.
 * 실행: image-smoke/run.sh. 이 파일을 /smoke에 읽기 전용으로 마운트한다. `process.exit`를 쓰지 않는다
 * (어댑터가 연결을 남기면 종료하지 않아 run.sh의 제한 시간에 걸린다).
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const ADAPTER = "@cp949/mailo-secret-source-aws";
const VALUE = "SMOKE-SENTINEL-value";
const JSON_VALUE = "SMOKE-SENTINEL-json-value";
const ACCESS_KEY = "SMOKE-SENTINEL-access-key";
const SECRET_KEY = "SMOKE-SENTINEL-secret-key";
const SENTINELS = [VALUE, JSON_VALUE, ACCESS_KEY, SECRET_KEY];

const { resolveSecrets } = await import(
  pathToFileURL("/repo/apps/mailo/dist/secrets/index.js").href
);

/** GetSecretValue만 흉내 낸다. 이름으로 평문·JSON·오류를 고른다. */
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const { SecretId } = JSON.parse(body);
  const headers = {
    "content-type": "application/x-amz-json-1.1",
    "x-amzn-requestid": "smoke",
  };
  const secretStrings = {
    "example/smtp": VALUE,
    "example/bundle": JSON.stringify({ password: JSON_VALUE, count: 3 }),
  };
  const errors = {
    "example/denied": [400, "AccessDeniedException"],
    "example/throttled": [400, "ThrottlingException"],
    "example/broken": [500, "InternalServiceError"],
  };
  if (
    request.headers["x-amz-target"] === "secretsmanager.GetSecretValue" &&
    Object.hasOwn(secretStrings, SecretId)
  ) {
    response.writeHead(200, headers);
    response.end(
      JSON.stringify({ Name: SecretId, SecretString: secretStrings[SecretId] }),
    );
    return;
  }
  const [status, type] = errors[SecretId] ?? [400, "ResourceNotFoundException"];
  response.writeHead(status, { ...headers, "x-amzn-errortype": type });
  response.end(JSON.stringify({ __type: type, message: SENTINELS.join(" ") }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

// 어댑터는 SDK 표준 환경 변수에서 AWS 설정을 읽는다. 메타데이터 서비스는 끈다.
Object.assign(process.env, {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: ACCESS_KEY,
  AWS_SECRET_ACCESS_KEY: SECRET_KEY,
  AWS_EC2_METADATA_DISABLED: "true",
  AWS_ENDPOINT_URL_SECRETS_MANAGER: `http://127.0.0.1:${server.address().port}`,
});

const names = [{ pattern: /^MAILO_SMOKE_[A-Z]+$/ }];

/** resolveSecrets가 던진 오류를 돌려준다. 성공하면 undefined다. */
async function failureOf(env) {
  try {
    await resolveSecrets(env, { names });
  } catch (error) {
    return error;
  }
  return undefined;
}

function assertNoSentinel(error) {
  for (const sentinel of SENTINELS)
    assert.ok(!String(error.message).includes(sentinel));
}

const baseEnv = { MAILO_SECRET_ADAPTERS: ADAPTER };

try {
  // 1. bare 패키지 이름으로 어댑터를 불러와 참조를 해석한다. 입력 env는 바뀌지 않는다.
  const input = { ...baseEnv, MAILO_SMOKE_A_REF: "aws-sm://example/smtp" };
  const resolved = await resolveSecrets(input, { names });
  assert.equal(resolved.MAILO_SMOKE_A, VALUE);
  assert.equal(input.MAILO_SMOKE_A, undefined);

  // 2. JSON 비밀에서 키를 골라 채운다.
  const json = await resolveSecrets(
    { ...baseEnv, MAILO_SMOKE_A_REF: "aws-sm://example/bundle#password" },
    { names },
  );
  assert.equal(json.MAILO_SMOKE_A, JSON_VALUE);

  // 3. 없는 비밀, 없는 키, 문자열이 아닌 값, 권한·제한·서버 오류는 닫힌 코드로만 실패한다. 값·자격 증명은 오류에 없다.
  const expected = {
    "aws-sm://example/missing": "adapter-error:not-found",
    "aws-sm://example/bundle#absent": "adapter-error:invalid-value",
    "aws-sm://example/bundle#count": "adapter-error:invalid-value",
    "aws-sm://example/denied": "adapter-error:access-denied",
    "aws-sm://example/throttled": "adapter-error:throttled",
    "aws-sm://example/broken": "adapter-error:unavailable",
  };
  for (const [ref, kind] of Object.entries(expected)) {
    const failure = await failureOf({ ...baseEnv, MAILO_SMOKE_A_REF: ref });
    assert.equal(failure?.name, "SecretResolutionError", ref);
    assert.equal(failure.failures[0].kind, kind, ref);
    assertNoSentinel(failure);
    assert.ok(!String(failure.message).includes("example/"));
  }

  // 4. 다른 이름의 어댑터는 로드 오류로 끝난다.
  for (const specifier of [
    "@cp949/mailo-secret-source-aws-example",
    "mailo-secret-source-bao",
  ]) {
    const loadFailure = await failureOf({ MAILO_SECRET_ADAPTERS: specifier });
    assert.equal(loadFailure?.name, "SecretAdapterLoadError");
    assert.equal(loadFailure.failures[0].kind, "not-found");
  }

  console.log(
    "aws 이미지 스모크 통과: 참조 해석, JSON 키 선택, 닫힌 오류 코드, 로드 오류",
  );
} finally {
  server.closeAllConnections();
  server.close();
}
