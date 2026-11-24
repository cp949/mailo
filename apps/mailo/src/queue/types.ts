import type { JsonValue } from "../events/index.js";
import type { Priority } from "./priority.js";
import type { OnUncertain } from "./uncertain.js";

export type JobStatus =
  | "PENDING"
  | "SENDING"
  | "RETRY_WAIT"
  | "SENT"
  | "FAILED"
  | "EXPIRED"
  /** 호출처나 운영자가 나가기 전에 취소했다. 종결 상태다(RQ-040, ADR-0011 결정 4). */
  | "CANCELED";

export const TERMINAL_STATUSES = [
  "SENT",
  "FAILED",
  "EXPIRED",
  "CANCELED",
] as const;

/** DB에 저장하는 암호화 본문(ADR-0008 결정 6). */
export interface EncryptedBody {
  ciphertext: Uint8Array;
  /** 96비트 난수. 암호화마다 새로 만든다. */
  nonce: Uint8Array;
  keyVersion: number;
}

/**
 * DB 본문 암호화 인터페이스. 구현은 `crypto` 모듈이 주입한다.
 * AAD는 `jobId`다. 행 사이에 암호문을 바꿔치면 `decrypt`가 실패해야 한다.
 */
export interface BodyCipher {
  encrypt(
    jobId: string,
    plaintext: Uint8Array,
  ): EncryptedBody | Promise<EncryptedBody>;
  decrypt(jobId: string, body: EncryptedBody): Uint8Array | Promise<Uint8Array>;
}

/**
 * Key 내용 지문 인터페이스. 구현은 `crypto` 모듈이 주입한다(ADR-0005 결정 3).
 * `keyVersion`을 생략하면 현재 키로 계산한다. 저장된 버전의 키를 모르면 예외를 던져야 한다.
 */
export interface Fingerprinter {
  fingerprint(
    canonicalRequest: string,
    keyVersion?: number,
  ): { digest: Uint8Array; keyVersion: number };
}

/** 계정 상태 오류의 사유. 차단기 초기 대기 시간을 정한다(ADR-0007 결정 4·5). */
export type AccountErrorReason =
  | "DAILY_LIMIT"
  | "RATE_LIMIT"
  | "CONNECTION"
  | "TLS"
  | "AUTH"
  | "OTHER";

export interface RegisterInput {
  callerId: string;
  idempotencyKey: string;
  /**
   * 이 작업의 SMTP 계정 ID(RQ-054, ADR-0013 결정 2). 호출처 레지스트리의 `accountId`이고 등록 때 고정된다.
   * 같은 Key의 기존 행이 있으면 기존 작업의 계정을 바꾸지 않는다. 지문에 포함하지 않는다.
   */
  accountId: string;
  /** 수신자(평문). 큐는 내용을 해석하지 않고 이벤트에 복사한다. */
  recipients: JsonValue;
  /** 복호화 없이 필요한 평문 발송 필드(from, replyTo 등). */
  envelope?: JsonValue;
  /** 암호화할 평문(제목·text·html을 직렬화한 값). */
  body: Uint8Array;
  /** 지문 입력. 발송 결과에 영향을 주는 모든 요청 필드를 정규화한 평문이다. */
  canonicalRequest: string;
  /**
   * 만료 TTL 초. 만료 시각은 DB now()에 더해 계산한다(ADR-0002 결정 10).
   * 요청 `ttlSeconds`나 기본 만료 TTL이다(RQ-039). 같은 Key의 기존 행이 있으면 기존 만료 시각을 바꾸지 않는다.
   */
  expiresInSeconds: number;
  /**
   * 발송 우선순위(RQ-033). 생략하면 `NORMAL`이다. 중복 판정은 지문(`canonicalRequest`)이 하므로
   * 같은 Key의 기존 행이 있으면 이 값으로 기존 행을 바꾸지 않는다(RQ-034).
   */
  priority?: Priority;
  /**
   * 결과 불명 시도 뒤의 처리(RQ-073, ADR-0015 결정 6). 생략하면 `retry`다. 등록 때 `mail_jobs.on_uncertain`에 고정되고
   * 같은 Key의 기존 행이 있으면 기존 행을 바꾸지 않는다. 중복 판정은 지문(`canonicalRequest`)이 한다.
   */
  onUncertain?: OnUncertain;
  /**
   * true이면 새 작업을 만들지 않는다. 같은 Key의 기존 작업이 있을 때만 `duplicate`·`fingerprint_mismatch`를 돌려주고
   * 없으면 `denied`다. 호출자의 승인 정책(예: 발신 주소 허용 범위)을 통과하지 못한 요청이 이미 등록된 Key를
   * 재전송했을 때는 기존 작업을 그대로 돌려주기 위한 것이다(ADR-0005 결정 4의 멱등 재시도를 정책 변경이 깨지 않게 한다).
   */
  denyNew?: boolean;
}

export interface RegisterDeps {
  cipher: BodyCipher;
  fingerprinter: Fingerprinter;
}

export type RegisterResult =
  | { kind: "created"; jobId: string }
  /** 같은 Key, 같은 내용. 기존 작업을 반환한다(REST 200). */
  | { kind: "duplicate"; jobId: string; status: JobStatus }
  /** 같은 Key, 다른 내용. 거부한다(REST 409, 파일은 수집 거부). 기존 작업 정보는 넘기지 않는다. */
  | { kind: "fingerprint_mismatch" }
  /** `denyNew`이고 같은 Key의 기존 작업이 없다. 아무것도 쓰지 않았다. */
  | { kind: "denied" };

/** `claim`이 반환하는 점유 작업. 본문은 암호화된 채로 넘기고 Worker가 `BodyCipher.decrypt`로 푼다. */
export interface ClaimedJob {
  id: string;
  callerId: string;
  /** 등록 때 고정된 SMTP 계정 ID(RQ-054). Worker가 이 계정의 발송기와 발신 주소로 전송한다. */
  accountId: string;
  idempotencyKey: string;
  leaseToken: string;
  leaseUntil: Date;
  /** 이 점유 전까지 최대 시도 횟수에 포함된 시도 수 */
  attempts: number;
  accountTrips: number;
  expiresAt: Date;
  recipients: JsonValue;
  envelope: JsonValue;
  /** 본문이 삭제됐으면 null */
  body: EncryptedBody | null;
  /** 차단기 half_open 대표 작업이면 true */
  isProbe: boolean;
}

/**
 * 커밋한 상태 전이 한 건. 지표(`/metrics`) 같은 관찰자에게 호출처와 전이 뒤 상태만 알린다(ADR-0012 결정 7).
 * 작업 ID·수신자 등 요청 값은 담지 않는다(RQ-027).
 */
export interface JobTransition {
  callerId: string;
  /** 작업의 SMTP 계정 ID. 구성에서 빠진 계정이면 지표가 `unregistered`로 센다(ADR-0013 결정 5). */
  accountId: string;
  status: JobStatus;
  /** `OUTCOME_UNKNOWN`으로 종결한 전이면 true다(RQ-074). 아니면 필드가 없다. */
  outcomeUnknown?: true;
}

/**
 * 전이를 커밋한 뒤 한 번 부른다. 롤백되면 부르지 않는다. 던져도 호출한 쪽 결과에 영향이 없다.
 * `queue/`는 `metrics/`를 import하지 않으므로 호출자가 이 콜백으로 counter를 올린다.
 */
export type TransitionListener = (
  transitions: ReadonlyArray<JobTransition>,
) => void;

/** 재시도 정책(RQ-008 기본값, 모두 추정). */
export interface RetryPolicy {
  /** 첫 시도를 포함한 최대 시도 횟수 */
  maxAttempts: number;
  mode: "exponential" | "fixed";
  baseSeconds: number;
  multiplier: number;
  capSeconds: number;
  /** ±비율. 0.2면 ±20% 균등 */
  jitterRatio: number;
  /** [0, 1) 난수. 테스트에서 고정한다. */
  random: () => number;
}

/** 차단기 설정(ADR-0007 결정 4·5, 수치는 모두 추정). */
export interface BreakerConfig {
  breakerKey: string;
  /** closed에서 open으로 가는 연속 계정 상태 오류 수 */
  failureThreshold: number;
  /** 사유별 open 초기 대기 시간(초) */
  initialWaitSeconds: Record<AccountErrorReason, number>;
  /** 상한은 `max(capFloorSeconds, 해당 사유의 초기값)`이다. */
  capFloorSeconds: number;
  /** 한도 초과 사유는 연속 실패 수와 무관하게 즉시 open한다. */
  immediateOpenReasons: readonly AccountErrorReason[];
  /** 같은 작업이 차단기를 이 횟수만큼 연 뒤에도 같은 응답을 받으면 FAILED로 본다. */
  maxAccountTrips: number;
}

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerSnapshot {
  state: BreakerState;
  openUntil: Date | null;
  probeUntil: Date | null;
  probeJobId: string | null;
  consecutiveFailures: number;
  waitSeconds: number;
  lastReason: string | null;
}

/** 시도 한 건의 공통 응답 정보. 본문은 받지 않는다. */
export interface AttemptDetail {
  stage?: string | null;
  responseCode?: number | null;
  enhancedCode?: string | null;
  responseText?: string | null;
}

/** SMTP 시도 결과. 분류는 `smtp` 모듈이 정해 넘긴다(ADR-0007 결정 1~3). */
export type AttemptOutcome = AttemptDetail &
  (
    | { classification: "SENT"; rejectedRecipients?: JsonValue | null }
    | {
        classification: "TRANSIENT" | "PERMANENT";
        /**
         * Mailo 내부 오류(복호화 실패, 잘못된 작업 데이터 등)로 SMTP에 닿지 못했다. 계정 상태를 확인하지 못했으므로
         * 차단기를 건드리지 않는다. half_open 대표 작업이 이 결과로 끝나도 closed로 돌아가지 않고,
         * 대표 lease(`probe_until`)가 지나면 다음 대표 작업이 이어받는다.
         */
        internal?: boolean;
      }
    | {
        classification: "ACCOUNT";
        reason: AccountErrorReason;
        /** `MAIL FROM` 이후 단계에서 받은 오류인지. true면 `account_trips`로 센다(ADR-0007 결정 4). */
        afterMailFrom: boolean;
      }
  );

export type CompleteResult =
  /** lease_token이 맞지 않거나 SENDING이 아니다. 아무것도 기록하지 않았다. */
  | { applied: false; reason: "LEASE_LOST" }
  | {
      applied: true;
      status: "SENT" | "RETRY_WAIT" | "FAILED" | "EXPIRED";
      nextAttemptAt: Date | null;
      breaker: BreakerSnapshot | null;
      /** `fail` 정책의 결과 불명으로 `OUTCOME_UNKNOWN` 종결했으면 true다(지표용, RQ-074). 아니면 필드가 없다. */
      outcomeUnknown?: true;
    };
