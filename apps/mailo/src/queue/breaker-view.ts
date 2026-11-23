import type { BreakerSnapshot, BreakerState } from "./types.js";

/**
 * 큐의 차단기 사유(`AccountErrorReason`)를 계약의 `lastReason` 값으로 바꾼다. 알 수 없는 값은 `OTHER`다.
 * 헬스 응답(`lastReason`)·`GET /ops/accounts`·지표(`mailo_breaker_reason_info`의 `reason`)가 같은 어휘를 쓴다(ADR-0012 결정 4).
 */
const LAST_REASON: Record<string, string> = {
  AUTH: "AUTH_FAILED",
  TLS: "TLS_FAILED",
  CONNECTION: "CONNECTION_FAILED",
  DAILY_LIMIT: "QUOTA_DAILY",
  RATE_LIMIT: "QUOTA_BURST",
  OTHER: "OTHER",
};

export function lastReasonOf(reason: string): string {
  return LAST_REASON[reason] ?? "OTHER";
}

/** 운영자·호출처에 내는 차단기 상태. `openUntil`·`lastReason`은 인증된 호출에만 낸다. */
export interface BreakerView {
  state: BreakerState;
  /** 상태가 open일 때만 값이 있다. */
  openUntil: Date | null;
  /** closed이면 null이다. closed에서도 마지막 실패 사유가 DB에 남지만 "열었던 사유"가 아니라서 숨긴다(추정). */
  lastReason: string | null;
}

export function breakerView(snapshot: BreakerSnapshot): BreakerView {
  return {
    state: snapshot.state,
    openUntil:
      snapshot.state === "open" && snapshot.openUntil
        ? snapshot.openUntil
        : null,
    lastReason:
      snapshot.state === "closed" || snapshot.lastReason === null
        ? null
        : lastReasonOf(snapshot.lastReason),
  };
}
