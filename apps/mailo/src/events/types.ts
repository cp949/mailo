/** JSON으로 직렬화할 수 있는 값. jsonb 컬럼에 넣는다. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JobEventType =
  | "JOB_SENT"
  | "JOB_FAILED"
  | "JOB_EXPIRED"
  | "JOB_CANCELED";
export type EventType = JobEventType | "INTAKE_REJECTED";

/** 작업 종결 이벤트 입력. 작업 종결 전이와 같은 트랜잭션에서 기록한다(ADR-0006 결정 2). */
export interface JobEventInput {
  type: JobEventType;
  callerId: string;
  jobId: string;
  idempotencyKey: string;
  failureReason?: string | null;
  /** 응답 코드와 enhanced status code. 응답 텍스트는 넣지 않는다(수신자 주소가 섞일 수 있다). */
  failureDetail?: string | null;
  attemptCount: number;
  recipients: JsonValue;
  rejectedRecipients?: JsonValue | null;
}

/** 수집 거부 기록 입력(ADR-0006 결정 3). 본문은 받지 않는다. */
export interface IntakeRejectionInput {
  callerId: string;
  fileName: string;
  sizeBytes: number;
  /** 소문자 hex sha256 */
  sha256: string;
  idempotencyKey?: string | null;
  reasonCode: string;
}

export interface FeedEvent {
  /** 이벤트 ID. 호출처가 멱등 처리에 쓴다. */
  id: string;
  type: EventType;
  jobId: string | null;
  rejectionId: string | null;
  idempotencyKey: string | null;
  failureReason: string | null;
  failureDetail: string | null;
  attemptCount: number | null;
  recipients: JsonValue | null;
  rejectedRecipients: JsonValue | null;
  /**
   * 유예 뒤 수신자를 비웠는지(`mail_events.recipients_redacted_at`이 있는지). 비웠으면 `recipients`는 `{}`이고
   * `rejectedRecipients`는 null이다(RQ-072, ADR-0015 결정 3). `INTAKE_REJECTED`는 항상 false다.
   */
  recipientsRedacted: boolean;
  createdAt: Date;
}

export interface FeedPage {
  events: FeedEvent[];
  /** 다음 요청의 `after`. 이벤트가 없으면 받은 `after`를 그대로 돌려준다(없으면 null). */
  nextCursor: string | null;
}

export interface ListEventsOptions {
  callerId: string;
  after?: string | null;
  /** 단일 종류 필터. `types`가 있으면 무시한다. */
  type?: EventType | null;
  /** 여러 종류 필터(REST `type` 반복 파라미터). 생략하거나 비면 모든 종류다. */
  types?: readonly EventType[] | null;
  limit?: number;
}

/** 수집 거부 기록의 공개 항목. 이벤트 피드의 `INTAKE_REJECTED` 응답에 쓴다. */
export interface RejectionView {
  id: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  reasonCode: string;
}
