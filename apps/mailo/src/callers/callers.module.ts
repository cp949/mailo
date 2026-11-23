import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, APP_ENV, type AppConfig } from "../config/index.js";
import { BearerAuthGuard, OptionalBearerAuthGuard } from "./bearer-auth.js";
import { loadCallerRegistryFile } from "./registry.js";
import { CALLER_REGISTRY } from "./tokens.js";

/**
 * 호출처 레지스트리와 API 키 인증(RQ-028). 레지스트리는 기동 때 한 번 읽는다.
 * 파일이 잘못되면 provider 생성이 실패해 앱이 기동하지 않는다.
 * 키 교체는 파일을 고치고 재시작해야 반영된다(핫 리로드 없음, 추정).
 */
@Global()
@Module({
  providers: [
    {
      provide: CALLER_REGISTRY,
      inject: [APP_CONFIG, APP_ENV],
      useFactory: (config: AppConfig, env: NodeJS.ProcessEnv) =>
        loadCallerRegistryFile(config.callersFile, {
          env,
          // JWS 서명 키는 DB 본문 키·지문 키와 달라야 한다(한 키가 여러 용도로 쓰이면 한 곳의 유출이 모두에 번진다).
          otherKeys: [
            {
              label: "DB 본문 키링",
              keys: config.keys.dbEncryption.reveal().keys.values(),
            },
            {
              label: "지문 키링",
              keys: config.keys.fingerprint.reveal().keys.values(),
            },
          ],
        }),
    },
    BearerAuthGuard,
    OptionalBearerAuthGuard,
  ],
  exports: [CALLER_REGISTRY, BearerAuthGuard, OptionalBearerAuthGuard],
})
export class CallersModule {}
