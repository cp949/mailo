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

/**
 * 취소 사유 저장 값(`CANCELED_BY_CALLER`·`CANCELED_BY_OPERATOR`)을 응답의 `canceledBy`로 바꾼다(RQ-040).
 * 운영자 이름은 저장하지 않으므로 응답에도 없다. 모르는 값은 null이다.
 */
export function canceledByOf(
  stored: string | null,
): "CALLER" | "OPERATOR" | null {
  if (stored === "CANCELED_BY_CALLER") return "CALLER";
  if (stored === "CANCELED_BY_OPERATOR") return "OPERATOR";
  return null;
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
    ...presentJobFields(job),
    rejectedRecipients:
      job.status === "SENT"
        ? presentRejectedRecipients(job.rejectedRecipients)
        : [],
  };
}

/** `Job` 응답에서 호출처가 정한 Key와 `rejectedRecipients`(수신자 주소가 든다)를 뺀 나머지. 호출처 응답과 운영자 읽기가 같은 필드를 쓴다. */
function presentJobFields(job: JobView) {
  return {
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
    // 취소는 실패가 아니라서 `failedAt`·`failureReason`은 null이다(RQ-040).
    canceledAt:
      job.status === "CANCELED" && job.finishedAt
        ? job.finishedAt.toISOString()
        : null,
    canceledBy:
      job.status === "CANCELED" ? canceledByOf(job.failureReason) : null,
    lastError: presentLastError(job.lastError),
    // 모든 상태에서 불리언이다. 생략하지 않는다(RQ-048).
    outcomeUncertain: job.outcomeUncertain,
  };
}

/**
 * 운영자 읽기(`GET /ops/jobs/{jobId}`)의 작업 응답(ADR-0011 결정 7). `Job`에서 `idempotencyKey`와 `rejectedRecipients`를 빼고 `callerId`를 더한다.
 * 호출처가 정한 Key와 거부된 수신자 주소는 운영자 읽기에도 주지 않는다(RQ-027). 수신자와 본문은 `Job`에 없다.
 */
export function presentOperatorJob(job: JobView) {
  return {
    jobId: job.id,
    callerId: job.callerId,
    accountId: job.accountId,
    ...presentJobFields(job),
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
  uncertainJobIds: ReadonlySet<string>,
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
  if (event.type === "JOB_CANCELED") {
    return { ...common, canceledBy: canceledByOf(event.failureReason) };
  }
  return {
    ...common,
    failureReason: failureReasonOf(event.failureReason),
    lastError: presentLastError(
      event.jobId === null ? null : (lastErrors.get(event.jobId) ?? null),
    ),
    // `JOB_FAILED`·`JOB_EXPIRED`에만 있다. `Job.outcomeUncertain`과 같은 판정이다(RQ-048).
    outcomeUncertain: event.jobId !== null && uncertainJobIds.has(event.jobId),
  };
}
