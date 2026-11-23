/**
 * Worker의 슬롯 배분(RQ-055, ADR-0013 결정 3 바). 순수 함수만 둔다. 상태(진행 중 건수, 백오프)는 Worker가 가진다.
 *
 * 전체 상한 C(`MAILO_WORKER_CONCURRENCY`)를 계정에 나눈다. 한 계정이 전송 대기(SMTP 무응답)로 모든 슬롯을 쥐면
 * 다른 계정이 마감(lease·전송 마감)까지 기다리므로 계정마다 상한 `cap_a`를 둔다. 상한은 인스턴스별이다.
 */

/**
 * 계정의 슬롯 상한 `cap_a`. 계정의 `concurrency`가 있으면 그 값이다.
 * 생략하면 `max(1, C - (N - 1))`이다. 다른 계정마다 슬롯을 하나 남기는 값이다(N은 구성한 계정 수).
 * N이 C보다 크면 기동을 거부하므로(`config`·`createWorker`) 식의 `max(1, ...)`은 안전망일 뿐이다.
 */
export function accountSlotCap(
  account: { concurrency: number | null },
  total: number,
  accountCount: number,
): number {
  return account.concurrency ?? Math.max(1, total - (accountCount - 1));
}

/**
 * 계정 하나에 부르는 `claim`의 `limit`. `min(cap_a - 진행 중, 남은 전체 슬롯)`이다.
 * 0 이하이면 0이고 호출하지 않는다.
 */
export function claimLimit(input: {
  cap: number;
  inFlight: number;
  remaining: number;
}): number {
  return Math.max(0, Math.min(input.cap - input.inFlight, input.remaining));
}

/**
 * 계정 순서를 `start`번째부터 한 바퀴 돌린 새 배열을 돌려준다. poll 라운드마다 시작점을 무작위로 바꿔
 * 앞 계정이 매번 슬롯을 먼저 가져가지 않게 한다. 원본을 바꾸지 않는다.
 */
export function rotateFrom<T>(items: readonly T[], start: number): T[] {
  if (items.length === 0) return [];
  const offset = ((start % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}
