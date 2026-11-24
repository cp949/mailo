/**
 * 이벤트 응답의 `recipientsRedacted`(RQ-072, ADR-0015 결정 3)를 고정한다. DB 없이 `presentEvent`만 본다.
 * - `JOB_*` 종류는 값이 항상 불리언이다. 비운 이벤트는 `true`이고 수신자·거부 수신자가 빈 목록이다.
 * - `INTAKE_REJECTED`에는 이 필드가 없다(수신자가 없다).
 * 주소는 모두 가짜 값이다.
 */
import { describe, expect, it } from "@jest/globals";
import type { FeedEvent } from "../../src/events/index.js";
import { presentEvent } from "../../src/intake/presenters.js";

const RECIPIENTS = { to: ["a@example.invalid"], cc: [], bcc: [] };

function jobEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    id: "1",
    type: "JOB_SENT",
    jobId: "00000000-0000-4000-8000-000000000001",
    rejectionId: null,
    idempotencyKey: "k-1",
    failureReason: null,
    failureDetail: null,
    attemptCount: 1,
    recipients: RECIPIENTS,
    rejectedRecipients: [{ address: "r@example.invalid", code: 452 }],
    recipientsRedacted: false,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

const present = (event: FeedEvent) =>
  presentEvent(event, new Map(), new Map(), new Set()) as Record<
    string,
    unknown
  >;

describe("이벤트 표현의 recipientsRedacted (RQ-072, ADR-0015 결정 3)", () => {
  it.each(["JOB_SENT", "JOB_FAILED", "JOB_EXPIRED", "JOB_CANCELED"] as const)(
    "%s는 비우기 전에 false와 수신자를 낸다",
    (type) => {
      const view = present(jobEvent({ type }));

      expect(view["recipientsRedacted"]).toBe(false);
      expect(view["recipients"]).toEqual(RECIPIENTS);
    },
  );

  it.each(["JOB_SENT", "JOB_FAILED", "JOB_EXPIRED", "JOB_CANCELED"] as const)(
    "%s를 비우면 true와 빈 수신자 목록을 내고 거부 수신자도 빈 목록이다",
    (type) => {
      const view = present(
        jobEvent({
          type,
          recipients: {},
          rejectedRecipients: null,
          recipientsRedacted: true,
        }),
      );

      expect(view["recipientsRedacted"]).toBe(true);
      expect(view["recipients"]).toEqual({ to: [], cc: [], bcc: [] });
      if (type === "JOB_SENT") expect(view["rejectedRecipients"]).toEqual([]);
    },
  );

  it("INTAKE_REJECTED에는 recipientsRedacted와 수신자 필드가 없다", () => {
    const view = present(
      jobEvent({
        type: "INTAKE_REJECTED",
        jobId: null,
        rejectionId: "7",
        recipients: null,
        rejectedRecipients: null,
      }),
    );

    expect(view).not.toHaveProperty("recipientsRedacted");
    expect(view).not.toHaveProperty("recipients");
  });
});
