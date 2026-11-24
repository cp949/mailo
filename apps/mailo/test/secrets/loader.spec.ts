import { describe, expect, it } from "@jest/globals";
import {
  SecretAdapterLoadError,
  loadSecretAdapters,
} from "../../src/secrets/index.js";
import { fakeImporter, fakeSource } from "../support/secrets.js";

/** 어댑터 로더: bare 패키지 이름만 import한다(RQ-077, ADR-0016 결정 3). */

async function loadFailures(
  adapters: string,
  modules: Record<string, unknown> = {},
) {
  try {
    await loadSecretAdapters(adapters, fakeImporter(modules));
  } catch (error) {
    expect(error).toBeInstanceOf(SecretAdapterLoadError);
    return (error as SecretAdapterLoadError).failures;
  }
  throw new Error("로드 오류가 나야 한다");
}

describe("어댑터 로더: 지정자 규칙 (RQ-077)", () => {
  it.each([
    "./local-adapter",
    "../x",
    "/abs/path/adapter",
    "file:///etc/adapter.js",
    "data:text/javascript;charset=utf-8",
    "https://example.invalid/a.js",
    "node:fs",
    "pkg/sub",
    "@scope/pkg/sub",
    "UpperCase",
    "@Scope/pkg",
    "has space",
    "a\\b",
    "-leading-dash",
    ".hidden",
  ])(
    "지정자 %j는 invalid-specifier로 거부하고 import하지 않는다",
    async (specifier) => {
      let imports = 0;
      await expect(
        loadSecretAdapters(specifier, async () => {
          imports += 1;
          return {};
        }),
      ).rejects.toMatchObject({
        failures: [{ label: "1번째 항목", kind: "invalid-specifier" }],
      });
      expect(imports).toBe(0);
    },
  );

  it("거부 사유에 지정자 원문을 싣지 않는다(URL의 자격 증명 방지)", async () => {
    const failures = await loadFailures("https://user:CANARY-URL-PW@host/a.js");
    expect(JSON.stringify(failures)).not.toContain("CANARY-URL-PW");
    try {
      await loadSecretAdapters(
        "https://user:CANARY-URL-PW@host/a.js",
        async () => ({}),
      );
    } catch (error) {
      expect((error as Error).message).not.toContain("CANARY-URL-PW");
    }
  });

  it.each(["pkg", "@cp949/mailo-secret-source-aws", "my-adapter.v2", "a1_b"])(
    "bare 패키지 이름 %s는 받는다",
    async (name) => {
      const source = fakeSource({ scheme: "ok" });
      const result = await loadSecretAdapters(
        name,
        fakeImporter({ [name]: { default: source } }),
      );
      expect(result.get("ok")).toBe(source);
    },
  );

  it("빈 문자열과 빈 항목은 어댑터 없음으로 본다", async () => {
    expect((await loadSecretAdapters("", fakeImporter({}))).size).toBe(0);
    expect((await loadSecretAdapters(" , ,", fakeImporter({}))).size).toBe(0);
    expect((await loadSecretAdapters(undefined, fakeImporter({}))).size).toBe(
      0,
    );
  });

  it("쉼표로 여러 어댑터를 받고 공백을 자른다", async () => {
    const a = fakeSource({ scheme: "aa" });
    const b = fakeSource({ scheme: "bb" });
    const result = await loadSecretAdapters(
      " one , two ",
      fakeImporter({ one: { default: a }, two: { default: b } }),
    );
    expect([...result.keys()]).toEqual(["aa", "bb"]);
  });
});

describe("어댑터 로더: 로드 실패 종류 (RQ-077)", () => {
  it("패키지가 없으면 not-found다", async () => {
    expect(await loadFailures("missing-pkg")).toEqual([
      { label: "missing-pkg", kind: "not-found" },
    ]);
  });

  it("어댑터 내부 의존성이 없어서 난 오류는 not-found가 아니라 import-failed다", async () => {
    const error = Object.assign(
      new Error("Cannot find package 'some-dep' imported from /adapter"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    expect(await loadFailures("pkg", { pkg: error })).toEqual([
      { label: "pkg", kind: "import-failed" },
    ]);
  });

  it("import가 던진 그 밖의 오류는 import-failed이고 메시지를 옮기지 않는다", async () => {
    const error = new SyntaxError("CANARY-IMPORT-MESSAGE");
    const failures = await loadFailures("pkg", { pkg: error });
    expect(failures).toEqual([{ label: "pkg", kind: "import-failed" }]);
    try {
      await loadSecretAdapters("pkg", async () => {
        throw error;
      });
    } catch (e) {
      expect((e as Error).message).not.toContain("CANARY-IMPORT-MESSAGE");
    }
  });

  const brokenExports: Array<[string, unknown]> = [
    ["기본 export 없음", {}],
    ["기본 export가 null", { default: null }],
    ["scheme이 없음", { default: { resolve: async () => "v" } }],
    [
      "scheme이 형식 위반",
      { default: { scheme: "Bad_Scheme", resolve: async () => "v" } },
    ],
    [
      "scheme이 빈 문자열",
      { default: { scheme: "", resolve: async () => "v" } },
    ],
    ["resolve가 함수가 아님", { default: { scheme: "ok", resolve: "no" } }],
    ["기본 export가 문자열", { default: "adapter" }],
  ];
  it.each(brokenExports)(
    "어댑터 구조가 틀리면(%s) invalid-export다",
    async (_label, module) => {
      expect(await loadFailures("pkg", { pkg: module })).toEqual([
        { label: "pkg", kind: "invalid-export" },
      ]);
    },
  );

  it("scheme이 file이면 reserved-scheme이다", async () => {
    const failures = await loadFailures("pkg", {
      pkg: { default: fakeSource({ scheme: "file" }) },
    });
    expect(failures).toEqual([{ label: "pkg", kind: "reserved-scheme" }]);
  });

  it("두 어댑터가 같은 scheme이면 뒤의 것이 duplicate-scheme이다", async () => {
    const failures = await loadFailures("a-pkg,b-pkg", {
      "a-pkg": { default: fakeSource({ scheme: "same" }) },
      "b-pkg": { default: fakeSource({ scheme: "same" }) },
    });
    expect(failures).toEqual([{ label: "b-pkg", kind: "duplicate-scheme" }]);
  });

  it("실패를 모아서 한 번에 보고한다", async () => {
    const failures = await loadFailures("missing-one,./bad,pkg", {
      pkg: { default: { scheme: "x" } },
    });
    expect(failures).toEqual([
      { label: "missing-one", kind: "not-found" },
      { label: "2번째 항목", kind: "invalid-specifier" },
      { label: "pkg", kind: "invalid-export" },
    ]);
  });

  it("오류 메시지는 고정 문구, 라벨, 종류만 담는다", async () => {
    try {
      await loadSecretAdapters("missing-one", fakeImporter({}));
    } catch (error) {
      expect((error as Error).message).toBe(
        "비밀값 어댑터 로드 실패: missing-one: not-found",
      );
      return;
    }
    throw new Error("오류가 나야 한다");
  });
});

describe("어댑터 로더: 기본 importer (RQ-077)", () => {
  it("실제 import()로 없는 패키지를 찾으면 not-found다", async () => {
    await expect(
      loadSecretAdapters("mailo-secret-adapter-that-does-not-exist-9f3a"),
    ).rejects.toMatchObject({
      failures: [
        {
          label: "mailo-secret-adapter-that-does-not-exist-9f3a",
          kind: "not-found",
        },
      ],
    });
  });
});
