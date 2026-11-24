/**
 * 결과 불명 시도의 정의와 요청별 처리 정책(RQ-048·073·074, ADR-0011 결정 5, ADR-0015 결정 5·6).
 * 불명 판정은 이 파일의 조건 하나가 정한다. TypeScript 함수(`isUncertainOutcome`)와 읽기용 SQL 조각(`UNCERTAIN_ATTEMPT_SQL`)은
 * 같은 조건이고, 둘이 같은 시도에서 같은 값을 내는 것을 통합 테스트가 확인한다(`test/queue/uncertain-outcome.integration-spec.ts`).
 * 조건을 바꾸면 두 곳을 함께 바꾼다.
 */
import type { AttemptOutcome } from "./types.js";

/**
 * 결과 불명 시도 뒤의 처리(요청 `onUncertainOutcome`). `retry`는 재시도(at-least-once, 기본), `fail`은 `OUTCOME_UNKNOWN`으로 종결한다.
 * 등록 때 `mail_jobs.on_uncertain`에 고정된다(RQ-073).
 */
export type OnUncertain = "retry" | "fail";

/** 요청이 생략했을 때의 정책. 도입 전 작업도 이 값으로 읽힌다(DB DEFAULT). */
export const DEFAULT_ON_UNCERTAIN: OnUncertain = "retry";

/** 대소문자를 구분해 정책 이름인지 본다. */
export function isOnUncertain(value: unknown): value is OnUncertain {
  return value === "retry" || value === "fail";
}

/** `fail`로 종결한 작업의 `failure_reason` 저장 값이자 응답 이름이다(ADR-0015 결정 7). */
export const OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN";

/**
 * 결과를 알 수 없는 시도의 조건(`mail_attempts` 별칭 `a`, ADR-0011 결정 5, ADR-0015 결정 5).
 * - `LEASE_EXPIRED`: lease 만료 회수는 전송 결과를 모른다. 점유 직후 프로세스가 죽어 전송 전이었던 경우도 포함한다.
 * - DATA 단계에서 응답 없이 끝난 `TRANSIENT`: 타임아웃·연결 끊김이라 서버가 수락했을 수 있다(ADR-0007 결정 3).
 * 응답 코드가 있는 실패, DATA 이전 단계, Mailo 내부 오류(`WORKER`)는 포함하지 않는다.
 * 이 SQL은 `internal` 여부를 검사하지 않는다. `mail_attempts`에 그 열이 없고, 내부 오류는 항상 `stage = 'WORKER'`로 기록되는 것(`worker`의 `internalFailure`)에 기댄다.
 * `isUncertainOutcome`은 `internal`을 따로 검사하지만 이 전제가 지켜지면 두 쪽의 결과가 같다.
 * 새 컬럼 없이 기존 컬럼에서 도출하므로 읽기 쪽(`outcomeUncertain`)에 마이그레이션이 필요 없다.
 */
export const UNCERTAIN_ATTEMPT_SQL = `(a.classification = 'LEASE_EXPIRED'
          OR (a.classification = 'TRANSIENT' AND a.stage = 'DATA' AND a.response_code IS NULL))`;

/**
 * 방금 기록하려는 결과가 불명 시도인지 판정한다. `UNCERTAIN_ATTEMPT_SQL`과 같은 조건이다.
 * 내부 오류(`internal`)는 SMTP에 닿기 전이라 불명이 아니다. 내부 오류는 `stage`가 `WORKER`이므로 SQL 쪽도 같은 결과다.
 */
export function isUncertainOutcome(
  outcome: AttemptOutcome | { classification: "LEASE_EXPIRED" },
): boolean {
  if (outcome.classification === "LEASE_EXPIRED") return true;
  return (
    outcome.classification === "TRANSIENT" &&
    outcome.internal !== true &&
    outcome.stage === "DATA" &&
    outcome.responseCode == null
  );
}
