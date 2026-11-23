import { describe, expect, it } from "@jest/globals";
import { MessageIdError, buildMessageId } from "../../src/smtp/message-id.js";

describe("buildMessageId (ADR-0007 결정 8)", () => {
  const jobId = "0b6c0f0e-6d0b-4c53-9a3e-8f4f6d3b2a11";

  it("작업 ID와 발신 도메인으로 같은 값을 만든다", () => {
    expect(buildMessageId(jobId, "Sender@Example.COM")).toBe(
      `<${jobId}@example.com>`,
    );
    expect(buildMessageId(jobId, "Sender@Example.COM")).toBe(
      buildMessageId(jobId, "other@example.com"),
    );
  });

  it("작업 ID가 다르면 값이 다르다", () => {
    expect(buildMessageId("a-1", "a@example.com")).not.toBe(
      buildMessageId("a-2", "a@example.com"),
    );
  });

  it("꺾쇠·공백이 든 작업 ID와 잘못된 도메인은 거부한다", () => {
    expect(() => buildMessageId("a>b", "a@example.com")).toThrow(
      MessageIdError,
    );
    expect(() => buildMessageId(jobId, "no-at-sign")).toThrow(
      "INVALID_SENDER_DOMAIN",
    );
    expect(() => buildMessageId(jobId, "a@exa mple.com")).toThrow(
      "INVALID_SENDER_DOMAIN",
    );
  });
});
