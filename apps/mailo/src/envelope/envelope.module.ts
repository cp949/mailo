import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, APP_ENV, type AppConfig } from "../config/index.js";
import {
  QUEUE_FINGERPRINTER,
  type QueueFingerprinter,
} from "../crypto/index.js";
import { createJweDecryptor } from "./jwe.js";
import { loadEnvelopeKeyFile } from "./key-file.js";
import { EMPTY_PRIVATE_KEY_RING, createPrivateKeyRing } from "./key-ring.js";
import type { OpenRequestDeps } from "./open-request.js";
import { ENVELOPE_DEPS } from "./tokens.js";

/**
 * 봉투 수집 파이프라인의 공용 의존성(ADR-0008). 개인키가 없으면 JWE `content`는 모두 `KID_UNKNOWN`이다.
 * 개인키 파일은 이 팩토리가 읽고 검증한다(`loadEnvelopeKeyFile`). `loadConfig`는 파일 경로만 받는다.
 * 키가 잘못되면(공개 샘플 키 포함) `ConfigError`가 `createApp` 안에서 listen 전에 던져진다. `main.ts`가 `startup_failed`를 남기고 종료한다.
 */
@Global()
@Module({
  providers: [
    {
      provide: ENVELOPE_DEPS,
      inject: [APP_CONFIG, APP_ENV, QUEUE_FINGERPRINTER],
      useFactory: (
        config: AppConfig,
        env: NodeJS.ProcessEnv,
        fingerprinter: QueueFingerprinter,
      ): OpenRequestDeps => {
        const entries =
          config.envelope.keysFile === null
            ? []
            : loadEnvelopeKeyFile(config.envelope.keysFile, {
                env,
                retentionSeconds:
                  config.worker.retention.recordRetentionSeconds,
                now: new Date(),
              });
        return {
          limits: config.limits,
          decryptor: createJweDecryptor(
            entries.length === 0
              ? EMPTY_PRIVATE_KEY_RING
              : createPrivateKeyRing(entries),
          ),
          fingerprinter,
          iat: config.envelope.iat,
          maxTtlSeconds: config.queue.jobExpiryMaxSeconds,
        };
      },
    },
  ],
  exports: [ENVELOPE_DEPS],
})
export class EnvelopeModule {}
