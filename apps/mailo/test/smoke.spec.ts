import { describe, expect, it } from "@jest/globals";
import { loadConfig } from "../src/config/index.js";
import { testEnv } from "./support/rest-app.js";

describe("loadConfig", () => {
  it("MAILO_DATABASE_URL이 없으면 부팅을 거부한다", () => {
    expect(() => loadConfig({})).toThrow("MAILO_DATABASE_URL");
  });

  it("선택 값이 없으면 기본값을 쓴다", () => {
    const config = loadConfig(testEnv({ MAILO_CALLERS_FILE: "/dev/null" }));

    expect(config.port).toBe(3000);
    expect(config.worker.lease.seconds).toBe(120);
  });
});
