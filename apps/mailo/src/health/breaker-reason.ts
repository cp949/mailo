/**
 * 큐의 차단기 사유(`AccountErrorReason`)를 계약의 `lastReason` 값으로 바꾼다. 알 수 없는 값은 `OTHER`다.
 * 헬스 응답(`lastReason`)과 지표(`mailo_breaker_reason_info`의 `reason`)가 같은 어휘를 쓴다(ADR-0012 결정 4).
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
