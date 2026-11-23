/**
 * Worker 연결 지점. REST 앱은 이 인터페이스로만 Worker를 시작·종료한다(RQ-025, ADR-0002 결정 12).
 * 구현체가 주입되지 않으면 `NoopWorkerRunner`가 쓰인다. 이때 앱은 등록·조회만 처리하고 발송하지 않는다.
 * - `start()`: 앱 기동 때(`onApplicationBootstrap`) 한 번 호출한다. 실패하면 앱이 기동하지 않는다.
 * - `stop()`: SIGTERM 종료 때 HTTP 서버를 닫은 뒤, DB 풀을 닫기 전에 호출한다.
 *   새 작업 점유를 멈추고 진행 중인 전송을 기다려야 한다.
 */
export interface WorkerRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** `WorkerRunner` 주입 토큰. */
export const WORKER_RUNNER = Symbol("WORKER_RUNNER");

/** 아무것도 하지 않는 기본 구현. */
export class NoopWorkerRunner implements WorkerRunner {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
