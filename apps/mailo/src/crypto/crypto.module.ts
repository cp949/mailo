import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/index.js";
import { createBodyCipher } from "./body-cipher.js";
import { createKeyRing } from "./key-ring.js";
import {
  createQueueBodyCipher,
  createQueueFingerprinter,
} from "./queue-adapters.js";
import { QUEUE_BODY_CIPHER, QUEUE_FINGERPRINTER } from "./tokens.js";

/**
 * DB 본문 암호화와 Key 내용 지문(ADR-0005, ADR-0008). 키링은 설정에서 받는다.
 * 본문 키링과 지문 키링은 서로 다른 인스턴스다(ADR-0008 결정 6). 키가 잘못되면 provider 생성이 실패해 기동하지 않는다.
 */
@Global()
@Module({
  providers: [
    {
      provide: QUEUE_BODY_CIPHER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        createQueueBodyCipher(
          createBodyCipher(createKeyRing(config.keys.dbEncryption.reveal())),
        ),
    },
    {
      provide: QUEUE_FINGERPRINTER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        createQueueFingerprinter(
          createKeyRing(config.keys.fingerprint.reveal()),
        ),
    },
  ],
  exports: [QUEUE_BODY_CIPHER, QUEUE_FINGERPRINTER],
})
export class CryptoModule {}
