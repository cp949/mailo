import { Global, Module, type DynamicModule } from "@nestjs/common";
import { APP_CONFIG, APP_ENV } from "./tokens.js";
import type { AppConfig } from "./load-config.js";

/** 설정 모듈. 환경 변수 로딩은 load-config.ts가 맡고, 이 모듈은 읽은 설정을 주입 대상으로 만든다. */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(
    config: AppConfig,
    env: NodeJS.ProcessEnv = process.env,
  ): DynamicModule {
    return {
      module: ConfigModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_ENV, useValue: env },
      ],
      exports: [APP_CONFIG, APP_ENV],
    };
  }
}
