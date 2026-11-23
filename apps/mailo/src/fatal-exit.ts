import type { AppLogger } from "./logging/index.js";

/**
 * 점유 루프가 예외로 죽은 뒤의 종료 코드. 오케스트레이터가 비0 종료에 재시작하도록 한다(deployment.md).
 * sysexits의 EX_SOFTWARE(70)를 따랐다. 설정 오류(1)와 구분된다.
 */
export const EXIT_WORKER_CRASHED = 70;

export interface FatalHandlerDeps {
  /** 정상 종료 경로. Nest `app.close()`다(Worker pause -> drain -> DB 풀 닫기). */
  close: () => Promise<void>;
  exit: (code: number) => void;
  /** `close`가 이 시간 안에 끝나지 않으면 강제로 종료한다(ms). drain 상한에 여유를 더한 값이다. */
  forceAfterMs: number;
  /** 앱 로거. `worker_fatal`을 한 줄 JSON으로 남긴다(`instance` 포함). */
  logger: AppLogger;
}

/**
 * 점유 루프가 죽었을 때 부를 처리기를 만든다. 즉시 exit하지 않는다. 진행 중 SMTP 전송이 끊기면 중복 발송이 생기므로
 * 정상 종료 경로를 거친 뒤 종료 코드 70으로 끝낸다. 두 번 불려도 한 번만 동작한다.
 * 닫기가 실패하거나 멈춰도 종료 코드는 70이다.
 */
export function createFatalHandler(
  deps: FatalHandlerDeps,
): (reason: string) => void {
  let closing = false;
  return (reason) => {
    if (closing) return;
    closing = true;
    deps.logger.error("worker_fatal", {
      reason,
      exitCode: EXIT_WORKER_CRASHED,
    });
    setTimeout(() => deps.exit(EXIT_WORKER_CRASHED), deps.forceAfterMs).unref();
    void deps
      .close()
      .catch(() => undefined)
      .finally(() => deps.exit(EXIT_WORKER_CRASHED));
  };
}
