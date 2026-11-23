/**
 * 파일 폴러 연결 지점. 앱은 이 인터페이스로만 폴러를 시작·종료한다(`worker-port.ts`와 같은 모양).
 * 파일 채널이 꺼져 있으면(`MAILO_FILE_CHANNEL_ROOT` 없음) `NoopFilePoller`가 쓰인다.
 */
import type { FilePollerStatus } from "./poller.js";

export interface FilePollerRunner {
  /** 앱 기동 때 한 번 부른다. root 검증에 실패하면 던지고 앱이 기동하지 않는다. */
  start(): Promise<void>;
  /** 종료 때 HTTP 서버를 닫은 뒤, DB 풀을 닫기 전에 부른다. 진행 중인 파일을 끝낸 뒤 resolve한다. */
  stop(): Promise<void>;
  /** 헬스가 읽는 상태 스냅샷. 생략하면 꺼진 것으로 본다. 쿼리와 파일 접근 없이 메모리 값만 준다. */
  status?(): FilePollerStatus;
}

export const FILE_POLLER = Symbol("FILE_POLLER");

export class NoopFilePoller implements FilePollerRunner {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
