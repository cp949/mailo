import "reflect-metadata";
import { ConfigError, loadConfig } from "./config/index.js";
import { CallerRegistryError } from "./callers/index.js";
import { FileChannelStartError } from "./file-channel/index.js";
import { SmtpConfigError } from "./smtp/index.js";
import { WorkerOptionsError } from "./worker/index.js";
import { createApp } from "./app.js";
import { createFatalHandler } from "./fatal-exit.js";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  // 점유 루프가 죽으면 정상 종료 경로를 거친 뒤 종료 코드 70으로 끝낸다(fatal-exit.ts).
  // 종료 경로가 멈추는 경우를 대비해 lease 길이만큼 기다린 뒤 강제 종료한다(drain 상한은 lease - 10초).
  const onWorkerFatal = createFatalHandler({
    close: () => app.close(),
    exit: (code) => process.exit(code),
    forceAfterMs: config.worker.lease.seconds * 1000,
    log: (message) => console.error(message),
  });
  // `worker`를 주면 설정으로 만든 Worker가 앱 기동 때 시작한다(app.module.ts, worker/runner.ts).
  const app = await createApp({ config, worker: {}, onWorkerFatal });
  // SIGTERM·SIGINT에서 종료 훅을 실행한다. HTTP 서버를 닫고, Worker를 drain하고, DB 풀을 닫는 순서다(app-lifecycle.ts).
  app.enableShutdownHooks();
  await app.listen(config.port);
}

try {
  await bootstrap();
} catch (error) {
  // 설정 오류 메시지는 변수 이름과 고정 사유만 담는다. 그 밖의 오류는 이름만 남긴다(시크릿이 섞일 수 있다).
  // 아래 오류 클래스의 메시지는 변수 이름·고정 코드만 담는다.
  if (
    error instanceof ConfigError ||
    error instanceof CallerRegistryError ||
    error instanceof SmtpConfigError ||
    error instanceof FileChannelStartError ||
    error instanceof WorkerOptionsError
  ) {
    console.error(error.message);
  } else {
    console.error(
      `기동 실패: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
  process.exit(1);
}
