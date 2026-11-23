import { Global, Module } from "@nestjs/common";
import {
  APP_CONFIG,
  APP_ENV,
  ConfigError,
  type AppConfig,
} from "../config/index.js";
import {
  BearerAuthGuard,
  MetricsReadGuard,
  OpsAdminGuard,
  OpsReadGuard,
  OptionalBearerAuthGuard,
} from "./bearer-auth.js";
import { loadCallerRegistryFile } from "./registry.js";
import type { CallerRegistry } from "./registry.js";
import { CALLER_REGISTRY } from "./tokens.js";

/**
 * 운영 토큰이 호출처 API 키와 같으면 기동을 거부한다(ADR-0011 결정 1). 같은 Bearer 경로에서 권한이 뒤섞이기 때문이다.
 * 비교는 레지스트리의 `authenticate`를 쓴다. 사유에는 변수 이름만 담고 값은 담지 않는다(RQ-027).
 */
function assertOpsTokensDistinctFromCallerKeys(
  config: AppConfig,
  registry: CallerRegistry,
): void {
  const named: Array<{ variable: string; token: string }> = [
    ...(config.ops.token === null
      ? []
      : [{ variable: "MAILO_OPS_TOKEN", token: config.ops.token.reveal() }]),
    ...config.ops.admins.map((a) => ({
      variable: `MAILO_OPS_ADMIN_TOKEN_${a.name.toUpperCase()}`,
      token: a.token.reveal(),
    })),
  ];
  const issues = named
    .filter(({ token }) => registry.authenticate(token) !== undefined)
    .map(({ variable }) => `${variable}이 호출처 API 키와 같은 값이다`);
  if (issues.length > 0) throw new ConfigError(issues);
}

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
      useFactory: (config: AppConfig, env: NodeJS.ProcessEnv) => {
        const registry = loadCallerRegistryFile(config.callersFile, {
          env,
          // 호출처가 가리키는 계정이 구성에 있는지 기동 때 확인한다(ADR-0013 결정 2).
          accountIds: config.smtpAccounts.map((a) => a.id),
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
        });
        assertOpsTokensDistinctFromCallerKeys(config, registry);
        return registry;
      },
    },
    BearerAuthGuard,
    OptionalBearerAuthGuard,
    OpsReadGuard,
    OpsAdminGuard,
    MetricsReadGuard,
  ],
  exports: [
    CALLER_REGISTRY,
    BearerAuthGuard,
    OptionalBearerAuthGuard,
    OpsReadGuard,
    OpsAdminGuard,
    MetricsReadGuard,
  ],
})
export class CallersModule {}
