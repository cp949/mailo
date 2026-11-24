import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * AWS 어댑터 변형 이미지가 기본 이미지와 어긋나지 않게 고정하는 값을 파일 글자로 검사한다(RQ-080, ADR-0016 결정 4).
 * 이미지를 빌드해 확인하는 일은 `adapters/secret-source-aws/image-smoke/`가 한다(ci.yml `adapter` 잡).
 */

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): string => readFileSync(`${REPO}${path}`, "utf8");

const rootDockerfile = read("Dockerfile");
const adapterDockerfile = read("adapters/secret-source-aws/Dockerfile");
const rootManifest = JSON.parse(read("package.json")) as Record<
  string,
  unknown
>;
const adapterManifest = JSON.parse(
  read("adapters/secret-source-aws/package.json"),
) as Record<string, Record<string, string> | string | undefined>;

/** `FROM <이미지>@sha256:<digest> AS <이름>`의 이미지 참조(digest 포함)를 모두 읽는다. */
function pinnedBaseImages(dockerfile: string): string[] {
  return [
    ...dockerfile.matchAll(/^FROM\s+(\S+@sha256:[0-9a-f]{64})\s+AS\s+\S+/gm),
  ].map((m) => m[1] as string);
}

describe("AWS 어댑터 변형 이미지의 고정값(RQ-080, ADR-0016 결정 4)", () => {
  it("어댑터 설치 stage의 base 이미지는 루트 Dockerfile과 같은 digest로 고정돼 있다", () => {
    const root = pinnedBaseImages(rootDockerfile);
    const adapter = pinnedBaseImages(adapterDockerfile);

    expect(root).toHaveLength(1);
    expect(adapter).toEqual(root);
  });

  it("어댑터 패키지의 packageManager는 루트와 같은 sha512 해시 고정값이다", () => {
    expect(adapterManifest["packageManager"]).toBe(
      rootManifest["packageManager"],
    );
    expect(adapterManifest["packageManager"]).toMatch(/\+sha512\.[0-9a-f]+$/);
  });

  it("기준 이미지는 기본값 없는 빌드 인자이고 마지막 stage는 USER node로 끝난다", () => {
    expect(adapterDockerfile).toMatch(/^ARG MAILO_BASE_IMAGE$/m);
    expect(adapterDockerfile).toMatch(
      /^FROM \$\{MAILO_BASE_IMAGE\} AS runtime$/m,
    );
    const lastUser = [...adapterDockerfile.matchAll(/^USER (\S+)$/gm)].at(-1);
    expect(lastUser?.[1]).toBe("node");
  });

  it("SDK 의존성은 정확한 버전으로 고정돼 있고 devDependency가 없다", () => {
    const dependencies = adapterManifest["dependencies"] as Record<
      string,
      string
    >;
    expect(Object.keys(dependencies)).toEqual([
      "@aws-sdk/client-secrets-manager",
    ]);
    expect(dependencies["@aws-sdk/client-secrets-manager"]).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
    expect(adapterManifest["devDependencies"]).toBeUndefined();
    expect(adapterManifest["private"]).toBe(true);
  });

  it("어댑터는 루트 pnpm 워크스페이스 밖의 독립 워크스페이스다", () => {
    expect(read("pnpm-workspace.yaml")).toMatch(
      /^packages:\n {2}- "apps\/\*"$/m,
    );
    expect(read("pnpm-workspace.yaml")).not.toContain("adapters");
    expect(read("adapters/secret-source-aws/pnpm-workspace.yaml")).toBe(
      "packages: []\n",
    );
  });

  it("기본 이미지를 만드는 루트 Dockerfile은 어댑터 폴더를 복사하지 않고 빌드 컨텍스트에서도 뺀다", () => {
    expect(rootDockerfile).not.toMatch(/adapters/);
    expect(read(".dockerignore")).toMatch(/^adapters$/m);
  });
});
