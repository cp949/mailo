/**
 * AWS Secrets Manager 어댑터를 가짜 SDK 클라이언트로 검증한다(RQ-079, ADR-0016 결정 8).
 * 실제 SDK와 HTTP를 거치는 검증은 sdk.test.mjs가 한다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import secretSource, { createAwsSecretSource } from "../index.js";

const SECRET_VALUE = "CANARY-VALUE-7f3a";
const SECRET_ID = "CANARY-SECRET-ID/prod";
const KEY_NAME = "CANARY-KEY";
const SDK_MESSAGE = "CANARY-SDK-MESSAGE";
const ENV = Object.freeze({ AWS_REGION: "ap-northeast-2" });

/** 가짜 SDK 클라이언트 팩토리. 만든 클라이언트와 호출을 기록한다. */
function fakeClients(respond) {
  const created = [];
  const createClient = (config) => {
    const client = {
      config,
      sent: [],
      destroyed: 0,
      async send(command, options) {
        client.sent.push({ input: command.input, options });
        return respond(command.input, options);
      },
      destroy() {
        client.destroyed += 1;
      },
    };
    created.push(client);
    return client;
  };
  return { created, createClient };
}

function sourceWith(respond, env = ENV) {
  const clients = fakeClients(respond);
  const source = createAwsSecretSource({
    env,
    createClient: clients.createClient,
  });
  return { source, ...clients };
}

const signal = () => new AbortController().signal;

/** 던진 오류를 돌려준다. 성공하면 테스트를 실패시킨다. */
async function failureOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("실패해야 한다");
}

/** 오류 객체의 모든 문자열 표현에 canary가 없어야 한다. */
function assertNoCanary(error) {
  const text = [
    String(error.message),
    String(error.stack),
    JSON.stringify(Object.getOwnPropertyNames(error)),
    JSON.stringify(error, Object.getOwnPropertyNames(error)),
  ].join("\n");
  for (const canary of [SECRET_VALUE, SECRET_ID, KEY_NAME, SDK_MESSAGE]) {
    assert.ok(!text.includes(canary), `오류에 ${canary}가 있다`);
  }
  assert.equal(error.cause, undefined);
}

describe("어댑터 계약(RQ-079, ADR-0016 결정 3·8)", () => {
  it("기본 export는 scheme aws-sm의 SecretSource이고 바꿀 수 없다", () => {
    assert.equal(secretSource.scheme, "aws-sm");
    assert.equal(typeof secretSource.resolve, "function");
    assert.ok(Object.isFrozen(secretSource));
  });
});

describe("값 해석(RQ-079, ADR-0016 결정 8)", () => {
  it("scheme 접두어를 뗀 이름 전체를 AWSCURRENT 단계의 SecretId로 보내고 SecretString을 그대로 돌려준다", async () => {
    const { source, created } = sourceWith(() => ({
      SecretString: " 값\n개행 ",
    }));

    const value = await source.resolve("aws-sm://prod/mailo/smtp", {
      signal: signal(),
    });

    assert.equal(value, " 값\n개행 ");
    assert.deepEqual(created[0].sent[0].input, {
      SecretId: "prod/mailo/smtp",
      VersionStage: "AWSCURRENT",
    });
    assert.deepEqual(created[0].config, { region: "ap-northeast-2" });
  });

  it("ARN도 그대로 SecretId로 보낸다", async () => {
    const arn =
      "arn:aws:secretsmanager:ap-northeast-2:000000000000:secret:x-AbCdEf";
    const { source, created } = sourceWith(() => ({ SecretString: "v" }));

    await source.resolve(`aws-sm://${arn}`, { signal: signal() });

    assert.equal(created[0].sent[0].input.SecretId, arn);
  });

  it("JSON이어도 키가 없는 참조는 SecretString 전체를 돌려준다", async () => {
    const json = '{"a":"1"}';
    const { source } = sourceWith(() => ({ SecretString: json }));

    assert.equal(
      await source.resolve("aws-sm://bundle", { signal: signal() }),
      json,
    );
  });

  it("#키가 있으면 JSON 객체의 그 키 문자열 값만 돌려주고 SecretId에는 # 앞부분만 보낸다", async () => {
    const { source, created } = sourceWith(() => ({
      SecretString: JSON.stringify({ password: "p@ss", other: "x" }),
    }));

    const value = await source.resolve("aws-sm://prod/smtp#password", {
      signal: signal(),
    });

    assert.equal(value, "p@ss");
    assert.equal(created[0].sent[0].input.SecretId, "prod/smtp");
  });

  it("JSON에 own 속성으로 적힌 __proto__ 키는 읽을 수 있다", async () => {
    const { source } = sourceWith(() => ({
      SecretString: '{"__proto__":"own"}',
    }));

    assert.equal(
      await source.resolve("aws-sm://b#__proto__", { signal: signal() }),
      "own",
    );
  });

  it("요청마다 클라이언트를 따로 만들고 각각 destroy한다", async () => {
    const { source, created } = sourceWith(({ SecretId }) => ({
      SecretString: `v-${SecretId}`,
    }));

    const values = await Promise.all([
      source.resolve("aws-sm://a", { signal: signal() }),
      source.resolve("aws-sm://b", { signal: signal() }),
    ]);

    assert.deepEqual(values, ["v-a", "v-b"]);
    assert.equal(created.length, 2);
    assert.deepEqual(
      created.map((c) => c.destroyed),
      [1, 1],
    );
  });
});

describe("값·참조 거부는 invalid-value이고 내용을 싣지 않는다(RQ-027, ADR-0016 결정 5·8)", () => {
  const cases = [
    {
      title: "JSON이 아닌 SecretString",
      ref: `aws-sm://${SECRET_ID}#${KEY_NAME}`,
      secretString: `not json ${SECRET_VALUE}`,
    },
    {
      title: "객체가 아닌 JSON(배열)",
      ref: `aws-sm://${SECRET_ID}#${KEY_NAME}`,
      secretString: `["${SECRET_VALUE}"]`,
    },
    {
      title: "객체가 아닌 JSON(null)",
      ref: `aws-sm://${SECRET_ID}#${KEY_NAME}`,
      secretString: "null",
    },
    {
      title: "없는 키",
      ref: `aws-sm://${SECRET_ID}#${KEY_NAME}`,
      secretString: JSON.stringify({ other: SECRET_VALUE }),
    },
    {
      title: "상속 속성 이름 키(constructor)",
      ref: `aws-sm://${SECRET_ID}#constructor`,
      secretString: JSON.stringify({ other: SECRET_VALUE }),
    },
    {
      title: "문자열이 아닌 값",
      ref: `aws-sm://${SECRET_ID}#${KEY_NAME}`,
      secretString: JSON.stringify({ [KEY_NAME]: 123456 }),
    },
  ];
  for (const { title, ref, secretString } of cases) {
    it(`${title}`, async () => {
      const { source } = sourceWith(() => ({ SecretString: secretString }));

      const error = await failureOf(source.resolve(ref, { signal: signal() }));

      assert.equal(error.code, "invalid-value");
      assertNoCanary(error);
    });
  }

  it("SecretBinary만 있거나 SecretString이 없는 응답", async () => {
    for (const response of [
      { SecretBinary: new TextEncoder().encode(SECRET_VALUE) },
      {},
    ]) {
      const { source, created } = sourceWith(() => response);

      const error = await failureOf(
        source.resolve(`aws-sm://${SECRET_ID}`, { signal: signal() }),
      );

      assert.equal(error.code, "invalid-value");
      assertNoCanary(error);
      assert.equal(created[0].destroyed, 1);
    }
  });

  const refCases = [
    ["scheme 접두어가 다른 참조", `ssm://${SECRET_ID}`],
    ["빈 SecretId", "aws-sm://"],
    ["빈 SecretId와 키", "aws-sm://#key"],
    ["형식이 틀린 키(공백)", `aws-sm://${SECRET_ID}#${KEY_NAME} x`],
    ["형식이 틀린 키(# 둘)", `aws-sm://${SECRET_ID}#a#${KEY_NAME}`],
    ["빈 키", `aws-sm://${SECRET_ID}#`],
  ];
  for (const [title, ref] of refCases) {
    it(`${title}는 SDK를 부르기 전에 거부한다`, async () => {
      const { source, created } = sourceWith(() => ({ SecretString: "v" }));

      const error = await failureOf(source.resolve(ref, { signal: signal() }));

      assert.equal(error.code, "invalid-value");
      assertNoCanary(error);
      assert.equal(created.length, 0);
    });
  }

  it("AWS_REGION이 없거나 비어 있으면 SDK를 부르기 전에 거부한다", async () => {
    for (const env of [{}, { AWS_REGION: "" }]) {
      const { source, created } = sourceWith(
        () => ({ SecretString: "v" }),
        env,
      );

      const error = await failureOf(
        source.resolve("aws-sm://x", { signal: signal() }),
      );

      assert.equal(error.code, "invalid-value");
      assert.equal(created.length, 0);
    }
  });
});

describe("SDK 오류를 닫힌 코드로 바꾼다(RQ-078, RQ-079, ADR-0016 결정 5)", () => {
  /** 이름 외에 메시지·요청 정보에 canary를 담은 SDK 형태의 오류. */
  function sdkError(name, extra = {}) {
    return Object.assign(new Error(`${SDK_MESSAGE} ${SECRET_ID}`), {
      name,
      $metadata: { requestId: SECRET_ID, httpStatusCode: 400 },
      ...extra,
    });
  }
  const table = [
    ["ResourceNotFoundException", "not-found"],
    ["AccessDeniedException", "access-denied"],
    ["UnrecognizedClientException", "access-denied"],
    ["ExpiredTokenException", "access-denied"],
    ["InvalidSignatureException", "access-denied"],
    ["CredentialsProviderError", "access-denied"],
    ["DecryptionFailure", "access-denied"],
    ["ThrottlingException", "throttled"],
    ["TooManyRequestsException", "throttled"],
    ["RequestLimitExceeded", "throttled"],
    ["InternalServiceError", "unavailable"],
    ["ServiceUnavailable", "unavailable"],
    ["TimeoutError", "unavailable"],
    ["AbortError", "unavailable"],
    ["InvalidRequestException", "invalid-value"],
    ["InvalidParameterException", "invalid-value"],
  ];
  for (const [name, code] of table) {
    it(`${name} → ${code}`, async () => {
      const { source, created } = sourceWith(() => {
        throw sdkError(name);
      });

      const error = await failureOf(
        source.resolve(`aws-sm://${SECRET_ID}`, { signal: signal() }),
      );

      assert.equal(error.code, code);
      assertNoCanary(error);
      assert.equal(created[0].destroyed, 1);
    });
  }

  it("이름을 몰라도 SDK의 재시도 분류와 HTTP 상태, 네트워크 오류 코드로 분류한다", async () => {
    const cases = [
      [sdkError("Weird", { $retryable: { throttling: true } }), "throttled"],
      [
        sdkError("Weird", { $metadata: { httpStatusCode: 503 } }),
        "unavailable",
      ],
      [sdkError("Weird", { $metadata: { httpStatusCode: 429 } }), "throttled"],
      [
        sdkError("Weird", { $metadata: { httpStatusCode: 403 } }),
        "access-denied",
      ],
      [
        sdkError("Error", { code: "ECONNREFUSED", $metadata: undefined }),
        "unavailable",
      ],
      [
        sdkError("Error", { code: "ENOTFOUND", $metadata: undefined }),
        "unavailable",
      ],
    ];
    for (const [thrown, code] of cases) {
      const { source } = sourceWith(() => {
        throw thrown;
      });

      const error = await failureOf(
        source.resolve("aws-sm://x", { signal: signal() }),
      );

      assert.equal(error.code, code);
      assertNoCanary(error);
    }
  });

  it("분류하지 못한 오류와 객체가 아닌 던짐은 코드 없이 고정 문구로 던진다", async () => {
    for (const thrown of [
      sdkError("Weird", { $metadata: undefined }),
      "문자열 던짐",
      null,
    ]) {
      const { source, created } = sourceWith(() => {
        throw thrown;
      });

      const error = await failureOf(
        source.resolve(`aws-sm://${SECRET_ID}`, { signal: signal() }),
      );

      assert.equal(error.code, undefined);
      assertNoCanary(error);
      assert.equal(created[0].destroyed, 1);
    }
  });

  it("속성을 읽다 던지는 오류 객체도 코드 없이 처리한다", async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(SDK_MESSAGE);
        },
      },
    );
    const { source } = sourceWith(() => {
      throw hostile;
    });

    const error = await failureOf(
      source.resolve("aws-sm://x", { signal: signal() }),
    );

    assert.equal(error.code, undefined);
    assertNoCanary(error);
  });
});

describe("abort와 클라이언트 정리(ADR-0016 결정 3·8, 묶음 A 리뷰 지적)", () => {
  it("이미 abort된 signal이면 클라이언트를 만들지 않고 unavailable로 거부한다", async () => {
    const { source, created } = sourceWith(() => ({ SecretString: "v" }));
    const controller = new AbortController();
    controller.abort();

    const error = await failureOf(
      source.resolve("aws-sm://x", { signal: controller.signal }),
    );

    assert.equal(error.code, "unavailable");
    assert.equal(created.length, 0);
  });

  it("진행 중 abort는 SDK에 같은 signal로 전달되고 unavailable로 끝나며 클라이언트를 destroy한다", async () => {
    const controller = new AbortController();
    const { source, created } = sourceWith(
      (_input, options) =>
        new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () =>
            reject(
              Object.assign(new Error(SDK_MESSAGE), { name: "AbortError" }),
            ),
          );
        }),
    );

    const pending = failureOf(
      source.resolve(`aws-sm://${SECRET_ID}`, { signal: controller.signal }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const error = await pending;

    assert.equal(created[0].sent[0].options.abortSignal, controller.signal);
    assert.equal(error.code, "unavailable");
    assertNoCanary(error);
    assert.equal(created[0].destroyed, 1);
  });

  it("어댑터는 signal에 리스너를 달지 않는다(abort 리스너 예외가 코어에 닿지 않게)", async () => {
    const controller = new AbortController();
    let added = 0;
    const original = controller.signal.addEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => {
      added += 1;
      return original(...args);
    };
    const { source } = sourceWith(() => ({ SecretString: "v" }));

    await source.resolve("aws-sm://x", { signal: controller.signal });

    assert.equal(added, 0);
  });

  it("destroy가 던져도 해석 결과와 오류를 바꾸지 않는다", async () => {
    const createClient = () => ({
      async send() {
        return { SecretString: "v" };
      },
      destroy() {
        throw new Error(SDK_MESSAGE);
      },
    });
    const source = createAwsSecretSource({ env: ENV, createClient });

    assert.equal(await source.resolve("aws-sm://x", { signal: signal() }), "v");
  });
});

describe("SecretId 형식은 SDK를 부르기 전에 거른다(RQ-079, ADR-0016 결정 8)", () => {
  const NAME_CHARS = "azAZ09/_+=.@-";
  const ARN = (partition, region, name) =>
    `arn:${partition}:secretsmanager:${region}:000000000000:secret:${name}`;

  const rejected = [
    ["끝 공백", "aws-sm://prod/smtp "],
    ["앞 공백", "aws-sm:// prod/smtp"],
    ["중간 공백", "aws-sm://prod /smtp"],
    ["개행", "aws-sm://prod/smtp\n"],
    ["제어 문자", "aws-sm://prod/\u0000smtp"],
    ["허용하지 않는 문자(*)", "aws-sm://prod/*"],
    ["허용하지 않는 문자(비ASCII)", "aws-sm://prod/비밀"],
    ["길이 513의 이름", `aws-sm://${"a".repeat(513)}`],
    ["secretsmanager가 아닌 ARN", "aws-sm://arn:aws:s3:::bucket"],
    [
      "secret 리소스가 없는 ARN",
      "aws-sm://arn:aws:secretsmanager:us-east-1:000000000000",
    ],
    [
      "계정 번호가 12자리가 아닌 ARN",
      "aws-sm://arn:aws:secretsmanager:us-east-1:1234:secret:x-AbCdEf",
    ],
    ["끝 공백이 붙은 ARN", `aws-sm://${ARN("aws", "us-east-1", "x-AbCdEf")} `],
  ];
  for (const [title, ref] of rejected) {
    it(`${title}: SDK를 부르기 전에 invalid-value로 거부한다`, async () => {
      const { source, created } = sourceWith(() => ({ SecretString: "v" }));

      const error = await failureOf(source.resolve(ref, { signal: signal() }));

      assert.equal(error.code, "invalid-value");
      assertNoCanary(error);
      assert.equal(created.length, 0);
    });
  }

  const accepted = [
    ["허용 문자 전부", `aws-sm://${NAME_CHARS}`],
    ["길이 512의 이름", `aws-sm://${"a".repeat(512)}`],
    ["길이 1의 이름", "aws-sm://a"],
    [
      "aws 파티션 ARN",
      `aws-sm://${ARN("aws", "ap-northeast-2", "prod/x-AbCdEf")}`,
    ],
    [
      "aws-cn 파티션 ARN",
      `aws-sm://${ARN("aws-cn", "cn-north-1", "x-AbCdEf")}`,
    ],
    [
      "aws-us-gov 파티션 ARN",
      `aws-sm://${ARN("aws-us-gov", "us-gov-west-1", "x-AbCdEf")}`,
    ],
  ];
  for (const [title, ref] of accepted) {
    it(`${title}: SDK로 보낸다`, async () => {
      const { source, created } = sourceWith(() => ({ SecretString: "v" }));

      await source.resolve(ref, { signal: signal() });

      assert.equal(
        created[0].sent[0].input.SecretId,
        ref.slice("aws-sm://".length),
      );
    });
  }
});

describe("클라이언트 생성 실패와 상태 경계(ADR-0016 결정 5)", () => {
  it("클라이언트를 만들다 던져도 SDK 오류가 아니라 고정 문구의 어댑터 오류로 나간다", async () => {
    const source = createAwsSecretSource({
      env: ENV,
      createClient() {
        throw Object.assign(new Error(`${SDK_MESSAGE} ${SECRET_ID}`), {
          name: "CredentialsProviderError",
        });
      },
    });

    const error = await failureOf(
      source.resolve(`aws-sm://${SECRET_ID}`, { signal: signal() }),
    );

    assert.equal(error.name, "AwsSecretSourceError");
    assert.equal(error.code, "access-denied");
    assertNoCanary(error);
  });

  it("HTTP 상태만으로 분류할 때 500은 unavailable이고 499는 분류하지 않는다", async () => {
    for (const [status, code] of [
      [500, "unavailable"],
      [499, undefined],
    ]) {
      const { source } = sourceWith(() => {
        throw Object.assign(new Error(SDK_MESSAGE), {
          name: "Weird",
          $metadata: { httpStatusCode: status },
        });
      });

      const error = await failureOf(
        source.resolve("aws-sm://x", { signal: signal() }),
      );

      assert.equal(error.code, code, String(status));
    }
  });
});
