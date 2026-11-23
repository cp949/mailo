import { describe, expect, it } from "@jest/globals";
import { errnoCode, isStale } from "../../src/file-channel/errno.js";

/** NFS stale file handle 판별(ADR-0004 구현 중 확정). libuv에는 ESTALE 이름이 없어 errno -116으로 판별한다. */
describe("ESTALE 판별 (ADR-0004, RQ-002)", () => {
  // Node가 NFS에서 실제로 던지는 모양(NFS 통합 검증에서 관찰). `code`가 "ESTALE"이 아니다.
  const nodeEstale = Object.assign(new Error("Unknown system error -116"), {
    code: "Unknown system error -116",
    errno: -116,
    syscall: "fstat",
  });

  it("Node가 던지는 errno -116 오류를 ESTALE로 본다", () => {
    expect(isStale(nodeEstale)).toBe(true);
    expect(errnoCode(nodeEstale)).toBe("ESTALE");
  });

  it("code가 ESTALE인 오류도 ESTALE로 본다", () => {
    expect(isStale(Object.assign(new Error("x"), { code: "ESTALE" }))).toBe(
      true,
    );
  });

  it("다른 오류는 ESTALE이 아니고 code를 그대로 쓴다", () => {
    const enoent = Object.assign(new Error("x"), { code: "ENOENT", errno: -2 });
    expect(isStale(enoent)).toBe(false);
    expect(errnoCode(enoent)).toBe("ENOENT");
    expect(isStale(new Error("x"))).toBe(false);
    expect(errnoCode(new Error("x"))).toBe("UNKNOWN");
    expect(isStale(null)).toBe(false);
    expect(isStale(undefined)).toBe(false);
  });
});
