import { describe, expect, it } from "@jest/globals";
import { hostname } from "node:os";
import { ConfigError, loadConfig } from "../../src/config/index.js";
import { testEnv } from "../support/rest-app.js";

const base = { MAILO_CALLERS_FILE: "/etc/mailo/callers.json" };

describe("MAILO_INSTANCE_ID (M10)", () => {
  it("없으면 호스트 이름을 쓴다", () => {
    expect(loadConfig(testEnv(base)).instanceId).toBe(hostname());
  });

  it("있으면 그 값을 쓴다", () => {
    expect(
      loadConfig(testEnv({ ...base, MAILO_INSTANCE_ID: "mailo-a_1.prod" }))
        .instanceId,
    ).toBe("mailo-a_1.prod");
  });

  it("공백·특수문자·65자 이상은 변수 이름으로 거부한다", () => {
    for (const value of ["has space", "a/b", "한글", "x".repeat(65), "-start"])
      expect(() =>
        loadConfig(testEnv({ ...base, MAILO_INSTANCE_ID: value })),
      ).toThrow(ConfigError);
    expect(() =>
      loadConfig(testEnv({ ...base, MAILO_INSTANCE_ID: "a b" })),
    ).toThrow("MAILO_INSTANCE_ID");
  });
});
