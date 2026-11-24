import { describe, expect, it } from "@jest/globals";
import {
  SecretAdapterLoadError,
  SecretResolutionError,
  SecretSettingsError,
  resolveSecrets,
  type SecretNameRule,
} from "../../src/secrets/index.js";
import {
  CANARY_MESSAGE,
  CANARY_REF,
  CANARY_VALUE,
  FakeAdapterError,
  fakeImporter,
  fakeSource,
} from "../support/secrets.js";

/**
 * `resolveSecrets`: `X_REF` 규약과 해석(RQ-075·076·078, ADR-0016 결정 1·2·5·6·7).
 * 어댑터는 가짜다. 실제 저장소·네트워크를 쓰지 않는다.
 */

const NAMES: SecretNameRule[] = [
  { name: "MAILO_DATABASE_URL" },
  { name: "MAILO_DB_PASSWORD" },
  { name: "MAILO_OPS_TOKEN" },
  { name: "MAILO_SMTP_PASSWORD" },
  { pattern: /^MAILO_JWS_SECRET_[A-Z0-9_]{1,80}$/ },
  { pattern: /^MAILO_DB_ENCRYPTION_KEY_V\d+$/ },
];

function run(
  env: NodeJS.ProcessEnv,
  sources: Parameters<typeof fakeImporter>[0] = {},
  extra: { rejectUnknown?: { prefix: string } } = {},
) {
  return resolveSecrets(env, {
    names: NAMES,
    importModule: fakeImporter(sources),
    ...extra,
  });
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("오류가 나야 한다");
}

const adapterEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  MAILO_SECRET_ADAPTERS: "fake-adapter",
  ...extra,
});

describe("resolveSecrets: 해석 대상이 없을 때 (RQ-076, ADR-0016 결정 2)", () => {
  it("X_REF도 어댑터도 없으면 입력과 같은 내용의 새 객체를 돌려주고 import를 부르지 않는다", async () => {
    let imports = 0;
    const env = { MAILO_DB_PASSWORD: "plain", OTHER: "x" };
    const result = await resolveSecrets(env, {
      names: NAMES,
      importModule: async () => {
        imports += 1;
        return {};
      },
    });
    expect(result).toEqual(env);
    expect(result).not.toBe(env);
    expect(imports).toBe(0);
  });

  it("빈 문자열 X_REF는 지정하지 않은 것으로 본다", async () => {
    const env = { MAILO_DB_PASSWORD_REF: "", MAILO_DB_PASSWORD: "plain" };
    expect(await run(env)).toEqual(env);
  });

  it("X_REF가 없는 변수에 X_FILE과 X가 함께 있어도 건드리지 않는다(현행 우선순위는 소비자가 정한다)", async () => {
    const env = {
      MAILO_DB_PASSWORD: "plain",
      MAILO_DB_PASSWORD_FILE: "/run/secrets/x",
    };
    expect(await run(env)).toEqual(env);
  });
});

describe("resolveSecrets: 해석과 환경 복사본 (RQ-076, ADR-0016 결정 2·6)", () => {
  it("해석한 값을 복사본의 X에 쓰고 입력 env는 바꾸지 않는다", async () => {
    const source = fakeSource({ values: { "fake://db": "pw-from-store" } });
    const env = adapterEnv({ MAILO_DB_PASSWORD_REF: "fake://db", KEEP: "1" });
    const before = JSON.stringify(env);
    const result = await run(env, { "fake-adapter": { default: source } });
    expect(result["MAILO_DB_PASSWORD"]).toBe("pw-from-store");
    expect(result["KEEP"]).toBe("1");
    expect(result["MAILO_DB_PASSWORD_REF"]).toBe("fake://db");
    expect(JSON.stringify(env)).toBe(before);
    expect(env).not.toHaveProperty("MAILO_DB_PASSWORD");
  });

  it("process.env를 바꾸지 않는다", async () => {
    const snapshot = JSON.stringify(process.env);
    const source = fakeSource({ values: { "fake://a": "v1" } });
    await run(adapterEnv({ MAILO_OPS_TOKEN_REF: "fake://a" }), {
      "fake-adapter": { default: source },
    });
    expect(JSON.stringify(process.env)).toBe(snapshot);
    expect(process.env["MAILO_OPS_TOKEN"]).toBeUndefined();
  });

  it("어댑터에는 X_REF 전체 문자열과 AbortSignal을 넘긴다", async () => {
    const source = fakeSource({ values: { "fake://a/b#c": "v" } });
    await run(adapterEnv({ MAILO_OPS_TOKEN_REF: "fake://a/b#c" }), {
      "fake-adapter": { default: source },
    });
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]!.ref).toBe("fake://a/b#c");
    expect(source.calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("동적 이름(호출처 JWS 비밀, 키 버전)도 이름 규칙으로 찾아 해석한다", async () => {
    const source = fakeSource({
      values: { "fake://jws": "jws-v", "fake://k2": "key-v2" },
    });
    const result = await run(
      adapterEnv({
        MAILO_JWS_SECRET_BILLING_REF: "fake://jws",
        MAILO_DB_ENCRYPTION_KEY_V2_REF: "fake://k2",
      }),
      { "fake-adapter": { default: source } },
    );
    expect(result["MAILO_JWS_SECRET_BILLING"]).toBe("jws-v");
    expect(result["MAILO_DB_ENCRYPTION_KEY_V2"]).toBe("key-v2");
  });

  it("여러 변수를 병렬로 해석한다", async () => {
    let active = 0;
    let peak = 0;
    const source = fakeSource({
      resolve: async (ref) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return `v-${ref}`;
      },
    });
    const result = await run(
      adapterEnv({
        MAILO_OPS_TOKEN_REF: "fake://1",
        MAILO_SMTP_PASSWORD_REF: "fake://2",
        MAILO_DB_PASSWORD_REF: "fake://3",
      }),
      { "fake-adapter": { default: source } },
    );
    expect(peak).toBe(3);
    expect(result["MAILO_SMTP_PASSWORD"]).toBe("v-fake://2");
  });

  it("이름 규칙에 없는 변수의 X_REF는 해석하지 않고 무시한다(rejectUnknown이 없을 때)", async () => {
    const source = fakeSource({ values: {} });
    const env = adapterEnv({ OTHER_THING_REF: "fake://x" });
    const result = await run(env, { "fake-adapter": { default: source } });
    expect(source.calls).toHaveLength(0);
    expect(result).toEqual(env);
  });

  it("값 끝의 개행을 자르지 않고 어댑터가 준 그대로 쓴다", async () => {
    const source = fakeSource({ values: { "fake://a": "value\n" } });
    const result = await run(adapterEnv({ MAILO_OPS_TOKEN_REF: "fake://a" }), {
      "fake-adapter": { default: source },
    });
    expect(result["MAILO_OPS_TOKEN"]).toBe("value\n");
  });
});

describe("resolveSecrets: 충돌·형식·알 수 없는 이름 (RQ-075, ADR-0016 결정 1·2)", () => {
  const source = () => ({ "fake-adapter": { default: fakeSource() } });

  it.each([
    ["env+ref", { MAILO_DB_PASSWORD: "plain" }],
    ["file+ref", { MAILO_DB_PASSWORD_FILE: "/run/secrets/x" }],
    [
      "env+file+ref",
      { MAILO_DB_PASSWORD: "plain", MAILO_DB_PASSWORD_FILE: "/run/secrets/x" },
    ],
  ])("X_REF와 %s 조합을 conflict로 거부한다", async (method, extra) => {
    const error = await failureOf(
      run(
        adapterEnv({ MAILO_DB_PASSWORD_REF: "fake://a", ...extra }),
        source(),
      ),
    );
    expect(error).toBeInstanceOf(SecretResolutionError);
    expect((error as SecretResolutionError).failures).toEqual([
      { variable: "MAILO_DB_PASSWORD", method, kind: "conflict" },
    ]);
    expect(error.message).toBe(
      `비밀값 해석 실패: MAILO_DB_PASSWORD(${method}): conflict`,
    );
  });

  it("X가 빈 문자열이면 충돌이 아니다(compose에서 X를 비워 REF로 바꾸는 방법)", async () => {
    const src = fakeSource({ values: { "fake://a": "v" } });
    const result = await run(
      adapterEnv({
        MAILO_DB_PASSWORD: "",
        MAILO_DB_PASSWORD_FILE: "",
        MAILO_DB_PASSWORD_REF: "fake://a",
      }),
      { "fake-adapter": { default: src } },
    );
    expect(result["MAILO_DB_PASSWORD"]).toBe("v");
  });

  it.each(["plain-value", "fake:/one-slash", "fake://", "Fake://a", "1x://a"])(
    "형식이 틀린 X_REF %j는 invalid-ref로 거부하고 어댑터를 부르지 않는다",
    async (ref) => {
      const src = fakeSource({ values: {} });
      const error = await failureOf(
        run(adapterEnv({ MAILO_OPS_TOKEN_REF: ref }), {
          "fake-adapter": { default: src },
        }),
      );
      expect((error as SecretResolutionError).failures[0]).toMatchObject({
        variable: "MAILO_OPS_TOKEN",
        kind: "invalid-ref",
      });
      expect(src.calls).toHaveLength(0);
    },
  );

  it("file scheme은 예약어라 reserved-scheme으로 거부한다", async () => {
    const error = await failureOf(
      run(adapterEnv({ MAILO_OPS_TOKEN_REF: "file:///run/secrets/x" }), {
        "fake-adapter": { default: fakeSource() },
      }),
    );
    expect((error as SecretResolutionError).failures[0]?.kind).toBe(
      "reserved-scheme",
    );
  });

  it("등록된 어댑터가 없는 scheme은 unknown-scheme이고 어댑터가 없으면 import도 하지 않는다", async () => {
    let imports = 0;
    const error = await failureOf(
      resolveSecrets(
        { MAILO_OPS_TOKEN_REF: "aws-sm://x" },
        {
          names: NAMES,
          importModule: async () => {
            imports += 1;
            return {};
          },
        },
      ),
    );
    expect((error as SecretResolutionError).failures).toEqual([
      { variable: "MAILO_OPS_TOKEN", method: "ref", kind: "unknown-scheme" },
    ]);
    expect(imports).toBe(0);
  });

  it("등록된 scheme이면 방식에 scheme을 적고, 등록되지 않은 scheme은 적지 않는다", async () => {
    const src = fakeSource({ values: {} });
    const error = await failureOf(
      run(
        adapterEnv({
          MAILO_OPS_TOKEN_REF: "fake://missing",
          MAILO_SMTP_PASSWORD_REF: "other://x",
        }),
        { "fake-adapter": { default: src } },
      ),
    );
    expect((error as SecretResolutionError).failures).toEqual([
      {
        variable: "MAILO_OPS_TOKEN",
        method: "ref:fake",
        kind: "adapter-error:not-found",
      },
      {
        variable: "MAILO_SMTP_PASSWORD",
        method: "ref",
        kind: "unknown-scheme",
      },
    ]);
  });

  it("해석한 값이 빈 문자열이면 empty로 실패한다", async () => {
    const src = fakeSource({ values: { "fake://a": "" } });
    const error = await failureOf(
      run(adapterEnv({ MAILO_OPS_TOKEN_REF: "fake://a" }), {
        "fake-adapter": { default: src },
      }),
    );
    expect((error as SecretResolutionError).failures[0]?.kind).toBe("empty");
  });

  it("어댑터가 문자열이 아닌 값을 주면 adapter-error로 실패한다", async () => {
    const src = fakeSource({ resolve: async () => 42 as unknown as string });
    const error = await failureOf(
      run(adapterEnv({ MAILO_OPS_TOKEN_REF: "fake://a" }), {
        "fake-adapter": { default: src },
      }),
    );
    expect((error as SecretResolutionError).failures[0]?.kind).toBe(
      "adapter-error",
    );
  });

  it("rejectUnknown이 있으면 접두어로 시작하고 _REF로 끝나는데 규칙에 없는 이름을 unknown-name으로 거부한다", async () => {
    const error = await failureOf(
      run(adapterEnv({ MAILO_SMTP_PASWORD_REF: "fake://a" }), source(), {
        rejectUnknown: { prefix: "MAILO_" },
      }),
    );
    expect((error as SecretResolutionError).failures).toEqual([
      {
        variable: "MAILO_SMTP_PASWORD_REF",
        method: "ref",
        kind: "unknown-name",
      },
    ]);
  });

  it("접두어가 다른 변수는 rejectUnknown이어도 무시한다", async () => {
    const env = adapterEnv({ AWS_THING_REF: "x" });
    expect(
      await run(env, source(), { rejectUnknown: { prefix: "MAILO_" } }),
    ).toEqual(env);
  });

  it.each(["MAILO_DB_PASSWORD_FILE_REF", "MAILO_JWS_SECRET_A_REF_REF"])(
    "이름이 _FILE이나 _REF로 끝나는 변수의 참조 %s는 unknown-name이다",
    async (name) => {
      const error = await failureOf(
        run(adapterEnv({ [name]: "fake://a" }), source(), {
          rejectUnknown: { prefix: "MAILO_" },
        }),
      );
      expect((error as SecretResolutionError).failures[0]?.kind).toBe(
        "unknown-name",
      );
    },
  );

  it("규칙에 맞는 이름이 _FILE로 끝나면 rejectUnknown이 없어도 unknown-name이다", async () => {
    const error = await failureOf(
      run(adapterEnv({ MAILO_JWS_SECRET_A_FILE_REF: "fake://a" }), source()),
    );
    expect((error as SecretResolutionError).failures[0]).toMatchObject({
      variable: "MAILO_JWS_SECRET_A_FILE_REF",
      kind: "unknown-name",
    });
  });
});

describe("resolveSecrets: 실패 모으기와 값 비노출 (RQ-078, RQ-027, ADR-0016 결정 5·6)", () => {
  it("실패를 모아 한 번에 보고하고 하나라도 실패하면 어떤 값도 돌려주지 않는다", async () => {
    const src = fakeSource({ values: { "fake://ok": "fine" } });
    const error = await failureOf(
      run(
        adapterEnv({
          MAILO_OPS_TOKEN_REF: "fake://ok",
          MAILO_DB_PASSWORD_REF: "fake://missing",
          MAILO_SMTP_PASSWORD_REF: "broken",
        }),
        { "fake-adapter": { default: src } },
      ),
    );
    const failures = (error as SecretResolutionError).failures;
    expect(failures.map((f) => f.variable)).toEqual([
      "MAILO_DB_PASSWORD",
      "MAILO_SMTP_PASSWORD",
    ]);
    expect(error.message.split("\n")).toHaveLength(2);
    // 성공한 변수의 해석 호출은 일어났다(병렬이다). 그 값은 오류에도 없다.
    expect(error.message).not.toContain("fine");
  });

  it.each([
    "not-found",
    "access-denied",
    "throttled",
    "unavailable",
    "invalid-value",
  ])(
    "어댑터가 닫힌 코드 %s로 던지면 adapter-error:%s로 보고한다",
    async (code) => {
      const src = fakeSource({
        resolve: async () => {
          throw new FakeAdapterError(code);
        },
      });
      const error = await failureOf(
        run(adapterEnv({ MAILO_OPS_TOKEN_REF: "fake://a" }), {
          "fake-adapter": { default: src },
        }),
      );
      expect((error as SecretResolutionError).failures[0]?.kind).toBe(
        `adapter-error:${code}`,
      );
    },
  );

  it.each([undefined, "ECONNRESET", "SOMETHING_ELSE", "NOT-FOUND"])(
    "닫힌 집합 밖의 코드 %j는 adapter-error로만 보고한다",
    async (code) => {
      const src = fakeSource({
        resolve: async () => {
          throw new FakeAdapterError(code);
        },
      });
      const error = await failureOf(
        run(adapterEnv({ MAILO_OPS_TOKEN_REF: "fake://a" }), {
          "fake-adapter": { default: src },
        }),
      );
      expect((error as SecretResolutionError).failures[0]?.kind).toBe(
        "adapter-error",
      );
    },
  );

  it("문자열 등 객체가 아닌 값을 던져도 adapter-error로 보고한다", async () => {
    const src = fakeSource({
      resolve: async () => {
        throw CANARY_MESSAGE;
      },
    });
    const error = await failureOf(
      run(adapterEnv({ MAILO_OPS_TOKEN_REF: "fake://a" }), {
        "fake-adapter": { default: src },
      }),
    );
    expect((error as SecretResolutionError).failures[0]?.kind).toBe(
      "adapter-error",
    );
  });

  it("오류 메시지와 오류 객체에 값·참조 문자열·어댑터 메시지(canary)가 없다", async () => {
    const src = fakeSource({
      resolve: async (ref) => {
        if (ref.includes("boom")) throw new FakeAdapterError("access-denied");
        return CANARY_VALUE;
      },
    });
    const error = await failureOf(
      run(
        adapterEnv({
          MAILO_OPS_TOKEN_REF: `fake://boom/${CANARY_REF}`,
          MAILO_DB_PASSWORD_REF: `fake://ok/${CANARY_REF}`,
          MAILO_SMTP_PASSWORD_REF: `not-a-ref-${CANARY_REF}`,
        }),
        { "fake-adapter": { default: src } },
      ),
    );
    const dump = [
      error.message,
      error.name,
      error.stack ?? "",
      JSON.stringify(error),
      JSON.stringify((error as SecretResolutionError).failures),
    ].join("\n");
    for (const canary of [CANARY_VALUE, CANARY_MESSAGE, CANARY_REF])
      expect(dump).not.toContain(canary);
  });

  it("어댑터를 지정하지 않고 X_REF만 있으면 어댑터 로드 없이 unknown-scheme이다(참조 문자열 비노출)", async () => {
    const error = await failureOf(
      run({ MAILO_OPS_TOKEN_REF: `aws-sm://${CANARY_REF}` }),
    );
    expect(error.message).not.toContain(CANARY_REF);
    expect(error.message).toBe(
      "비밀값 해석 실패: MAILO_OPS_TOKEN(ref): unknown-scheme",
    );
  });
});

describe("resolveSecrets: timeout (RQ-078, ADR-0016 결정 5)", () => {
  const hanging = () =>
    fakeSource({ resolve: () => new Promise<string>(() => undefined) });

  it("signal을 무시하는 어댑터도 timeout으로 확정하고 signal을 abort한다", async () => {
    const src = hanging();
    const started = Date.now();
    const error = await failureOf(
      run(
        adapterEnv({
          MAILO_SECRET_RESOLVE_TIMEOUT_MS: "100",
          MAILO_OPS_TOKEN_REF: "fake://a",
        }),
        { "fake-adapter": { default: src } },
      ),
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect((error as SecretResolutionError).failures[0]).toEqual({
      variable: "MAILO_OPS_TOKEN",
      method: "ref:fake",
      kind: "timeout",
    });
    expect(src.calls[0]!.signal.aborted).toBe(true);
  });

  it("timeout 뒤 어댑터가 늦게 거부해도 미처리 거부가 되지 않는다", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const src = fakeSource({
        resolve: (_ref, { signal }) =>
          new Promise<string>((_resolve, reject) => {
            setTimeout(() => reject(new FakeAdapterError("unavailable")), 250);
            void signal;
          }),
      });
      await failureOf(
        run(
          adapterEnv({
            MAILO_SECRET_RESOLVE_TIMEOUT_MS: "100",
            MAILO_OPS_TOKEN_REF: "fake://a",
          }),
          { "fake-adapter": { default: src } },
        ),
      );
      await new Promise((r) => setTimeout(r, 400));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("timeout 안에 끝나면 타이머가 남지 않고 값을 돌려준다", async () => {
    const src = fakeSource({ values: { "fake://a": "v" } });
    const result = await run(
      adapterEnv({
        MAILO_SECRET_RESOLVE_TIMEOUT_MS: "100",
        MAILO_OPS_TOKEN_REF: "fake://a",
      }),
      { "fake-adapter": { default: src } },
    );
    expect(result["MAILO_OPS_TOKEN"]).toBe("v");
    expect(src.calls[0]!.signal.aborted).toBe(false);
  });

  it.each(["99", "60001", "abc", "1.5", "-5", "10s"])(
    "MAILO_SECRET_RESOLVE_TIMEOUT_MS=%j는 범위·형식 오류로 거부하고 어댑터를 불러오지 않는다",
    async (value) => {
      let imports = 0;
      const error = await failureOf(
        resolveSecrets(adapterEnv({ MAILO_SECRET_RESOLVE_TIMEOUT_MS: value }), {
          names: NAMES,
          importModule: async () => {
            imports += 1;
            return {};
          },
        }),
      );
      expect(error).toBeInstanceOf(SecretSettingsError);
      expect(error.message).toBe(
        "MAILO_SECRET_RESOLVE_TIMEOUT_MS은 100 이상 60000 이하의 정수여야 한다",
      );
      expect(imports).toBe(0);
    },
  );

  it("경계값 100과 60000, 빈 문자열(기본값)을 받는다", async () => {
    for (const value of ["100", "60000", ""])
      await expect(
        run({ MAILO_SECRET_RESOLVE_TIMEOUT_MS: value }),
      ).resolves.toBeDefined();
  });
});

describe("resolveSecrets: 로그 (RQ-078, ADR-0016 결정 5)", () => {
  function recorder() {
    const lines: Array<{ event: string; fields: unknown }> = [];
    return {
      lines,
      logger: {
        info: (event: string, fields?: unknown) =>
          void lines.push({ event, fields }),
      },
    };
  }

  it("해석했을 때 secrets_resolved 한 줄에 건수와 scheme만 싣는다", async () => {
    const { lines, logger } = recorder();
    const src = fakeSource({ values: { "fake://a": "v1", "fake://b": "v2" } });
    await resolveSecrets(
      adapterEnv({
        MAILO_OPS_TOKEN_REF: "fake://a",
        MAILO_DB_PASSWORD_REF: "fake://b",
      }),
      {
        names: NAMES,
        importModule: fakeImporter({ "fake-adapter": { default: src } }),
        logger,
      },
    );
    expect(lines).toEqual([
      { event: "secrets_resolved", fields: { count: 2, schemes: "fake" } },
    ]);
  });

  it("해석 대상이 없으면 로그를 남기지 않는다", async () => {
    const { lines, logger } = recorder();
    await resolveSecrets({}, { names: NAMES, logger });
    expect(lines).toEqual([]);
  });

  it("실패하면 secrets_resolved를 남기지 않는다", async () => {
    const { lines, logger } = recorder();
    await failureOf(
      resolveSecrets(
        { MAILO_OPS_TOKEN_REF: "aws-sm://x" },
        { names: NAMES, logger },
      ),
    );
    expect(lines).toEqual([]);
  });
});

describe("resolveSecrets: 어댑터 로드는 해석보다 먼저다 (RQ-077, ADR-0016 결정 3)", () => {
  it("어댑터 로드에 실패하면 SecretAdapterLoadError만 던지고 해석 오류와 함께 보고하지 않는다", async () => {
    const error = await failureOf(
      resolveSecrets(
        { MAILO_SECRET_ADAPTERS: "missing-adapter", MAILO_OPS_TOKEN_REF: "x" },
        { names: NAMES, importModule: fakeImporter({}) },
      ),
    );
    expect(error).toBeInstanceOf(SecretAdapterLoadError);
  });
});
