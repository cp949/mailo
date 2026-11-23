/**
 * Worker가 쓰는 시계. 폴링 간격·sweep 주기·종료 대기 시간 계산용이다.
 * 작업 점유·lease·만료 판정은 DB `now()`가 기준이므로(ADR-0002 결정 10) 이 시계로 그런 시각을 계산하지 않는다.
 */
export interface Clock {
  /** 단조 증가 시각(ms). 경과 시간 계산에만 쓴다. */
  now(): number;
  /** `ms` 뒤에 resolve한다. `signal`이 중단되면 즉시 resolve한다(reject하지 않는다). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  sleep(ms, signal) {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      signal?.addEventListener("abort", done, { once: true });
    });
  },
};
