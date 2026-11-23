/**
 * DB 읽기 모델을 REST 계약 응답(docs/api/openapi.yaml `Job`, `Event`)으로 바꾼다.
 * 본문, 수신자(작업 응답), SMTP 응답 텍스트는 어떤 응답에도 넣지 않는다.
 */
import type { FeedEvent, JsonValue, RejectionView } from "../events/index.js";
import type { JobLastError, JobView } from "../queue/index.js";

/** DB에 저장된 실패 원인을 계약 이름으로 바꾼다(`FailureReason`). 알 수 없는 값은 그대로 둔다. */
const FAILURE_REASON: Record<string, string> = {
  PERMANENT: "PERMANENT_ERROR",
  ATTEMPTS_EXHAUSTED: "MAX_ATTEMPTS_EXCEEDED",
  ACCOUNT_REPEATED: "ACCOUNT_ERROR_REPEATED",
  EXPIRED: "EXPIRED",
};

function failureReasonOf(stored: string | null): string | null {
  return stored === null ? null : (FAILURE_REASON[stored] ?? stored);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function presentLastError(lastError: JobLastError | null) {
  return lastError === null
    ? null
    : {
        category: lastError.category,
        smtpCode: lastError.responseCode,
        enhancedCode: lastError.enhancedCode,
        occurredAt: lastError.occurredAt.toISOString(),
      };
}

/**
 * 거부 수신자 목록을 `address`, `smtpCode`, `enhancedCode`로 정리한다.
 * Worker가 저장한 항목의 필드 이름이 달라도(`responseCode`, `enhancedStatus`) 읽고, 응답 텍스트는 버린다.
 */
export function presentRejectedRecipients(stored: JsonValue | null): Array<{
  address: string;
  smtpCode: number | null;
  enhancedCode: string | null;
}> {
  if (!Array.isArray(stored)) return [];
  const result = [];
  for (const item of stored) {
    if (!isRecord(item) || typeof item["address"] !== "string") continue;
    const code = item["smtpCode"] ?? item["responseCode"];
    const enhanced = item["enhancedCode"] ?? item["enhancedStatus"];
    result.push({
      address: item["address"],
      smtpCode: typeof code === "number" ? code : null,
      enhancedCode: typeof enhanced === "string" ? enhanced : null,
    });
  }
  return result;
}

export function presentJob(job: JobView) {
  return {
    jobId: job.id,
    idempotencyKey: job.idempotencyKey,
    status: job.status,
    // 등급 이름만 내보낸다. DB 순위 숫자는 노출하지 않는다(RQ-037).
    priority: job.priority,
    attempts: job.attempts,
    createdAt: job.createdAt.toISOString(),
    expiresAt: job.expiresAt.toISOString(),
    sentAt:
      job.status === "SENT" && job.finishedAt
        ? job.finishedAt.toISOString()
        : null,
    failedAt:
      (job.status === "FAILED" || job.status === "EXPIRED") && job.finishedAt
        ? job.finishedAt.toISOString()
        : null,
    failureReason:
      job.status === "FAILED" || job.status === "EXPIRED"
        ? failureReasonOf(job.failureReason)
        : null,
    lastError: presentLastError(job.lastError),
    rejectedRecipients:
      job.status === "SENT"
        ? presentRejectedRecipients(job.rejectedRecipients)
        : [],
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

export function presentEvent(
  event: FeedEvent,
  lastErrors: ReadonlyMap<string, JobLastError>,
  rejections: ReadonlyMap<string, RejectionView>,
) {
  const base = {
    eventId: event.id,
    type: event.type,
    occurredAt: event.createdAt.toISOString(),
  };

  if (event.type === "INTAKE_REJECTED") {
    const rejection =
      event.rejectionId === null
        ? undefined
        : rejections.get(event.rejectionId);
    return {
      ...base,
      rejectionId: event.rejectionId,
      idempotencyKey: event.idempotencyKey,
      fileName: rejection?.fileName ?? null,
      fileSize: rejection?.sizeBytes ?? null,
      sha256: rejection?.sha256 ?? null,
      // 이벤트와 거부 기록은 같은 트랜잭션에서 쓰므로 둘의 사유는 같다.
      reasonCode: rejection?.reasonCode ?? event.failureReason,
    };
  }

  const recipients =
    event.recipients !== null && isRecord(event.recipients)
      ? event.recipients
      : {};
  const common = {
    ...base,
    jobId: event.jobId,
    idempotencyKey: event.idempotencyKey,
    attempts: event.attemptCount ?? 0,
    recipients: {
      to: stringList(recipients["to"]),
      cc: stringList(recipients["cc"]),
      bcc: stringList(recipients["bcc"]),
    },
  };
  if (event.type === "JOB_SENT") {
    return {
      ...common,
      rejectedRecipients: presentRejectedRecipients(event.rejectedRecipients),
    };
  }
  return {
    ...common,
    failureReason: failureReasonOf(event.failureReason),
    lastError: presentLastError(
      event.jobId === null ? null : (lastErrors.get(event.jobId) ?? null),
    ),
  };
}
