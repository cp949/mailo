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
 * 키가 잘못되면 설정 로딩이 먼저 실패하므로, 여기서는 키링을 만들기만 한다.
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
        };
      },
    },
  ],
  exports: [ENVELOPE_DEPS],
})
export class EnvelopeModule {}
