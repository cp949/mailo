import type { JobTransition, TransitionListener } from "./types.js";

/**
 * 커밋 뒤 관찰자를 부른다. 전이가 없으면 부르지 않고, 관찰자가 던져도 삼킨다.
 * 지표 기록 실패가 큐 동작을 바꾸면 안 된다(ADR-0012 결정 7).
 */
export function notifyTransitions(
  listener: TransitionListener | undefined,
  transitions: readonly JobTransition[],
): void {
  if (listener === undefined || transitions.length === 0) return;
  try {
    listener(transitions);
  } catch {
    // 관찰자 오류는 무시한다.
  }
}
