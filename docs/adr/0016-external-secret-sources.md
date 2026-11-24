# 비밀값은 `X_REF`로 기동 전에 한 번 읽어 환경 복사본에 채우고, 제공자 어댑터는 코어 밖 패키지와 변형 이미지로 둔다

## 상태

승인 (2026-11-24). 결정 1~10과 "사용자가 판단할 질문" 9개의 권고안을 모두 승인했다. 질문의 확정 답은 "구현 중 확정"에 적었다.

검증 범위는 코드·문서 읽기다(2026-11-24). 테스트, 스크립트, 이미지 빌드, 외부 서비스 호출을 실행하지 않았다. "배경"의 "확인한 사실"은 Mailo와 형제 프로젝트 storix의 코드·문서에서 읽은 것이다. 그 밖의 것은 "가정"과 "미결정·확인하지 않은 것"에 모았다. 문서에는 줄 번호 대신 파일·함수 이름으로 근거를 적었다(`docs/agents/writing-styles.md`).

입력은 "외부 시크릿 저장소(AWS Secrets Manager 등)에서 비밀값을 읽는 기능" 요청이다. `docs/requirements/roadmap.md`에는 이 항목이 없다. 범위는 비밀값 읽기이고 넓히지 않는다. 비밀 자체의 생성, 암호화 저장, 실행 중 갱신, 저장소 쓰기는 하지 않는다("하지 않는 것").

승인되면 다음 관계가 생긴다. 승인된 ADR의 결정 문구는 바꾸지 않는다.

- ADR-0008 결정 5("Mailo 개인키는 외부 설정이나 시크릿 어댑터로 주입한다")와 결정 6(DB 키도 시크릿 파일 마운트가 기본이고 환경 변수를 허용한다)이 말한 "시크릿 어댑터"를 이 ADR이 구체화한다. 충돌하지 않는다. 현재 구현은 `_FILE`과 환경 변수 둘뿐이다.
- RQ-029("운영 의존성은 Mailo 앱과 PostgreSQL로 한정한다")와 문구가 충돌한다. 기본 이미지·기본 compose·기본 설정은 그대로 두고 opt-in 배포에서만 외부 저장소가 의존성이 되게 하려면 RQ-029에 예외 한 줄이 필요하다. 변경안은 결정 4에 있고 요구사항 파일은 이번에 고치지 않았다.
- `AGENTS.md`의 "패키지를 새로 나누지 않는다"와 모듈 목록에 문구 변경이 필요하다(결정 3·4의 변경안). 이번에 고치지 않았다.
- 새 RQ 번호는 "새 RQ 번호" 절이다.

## 배경

### 확인한 사실

모두 2026-11-24에 코드와 문서를 읽어 확인했다.

Mailo의 비밀값 읽기 현황.

| 변수 | 이름이 정해지는 방식 | 읽는 곳 | 시점 |
| ---- | -------------------- | ------- | ---- |
| `MAILO_DATABASE_URL`, `MAILO_DB_PASSWORD` | 고정 | `config/load-config.ts`의 `loadDatabaseUrl`, `assembleDatabaseUrl`(`EnvReader.secret`) | 동기. `loadConfig`와 `loadDatabaseOnly`(마이그레이션 CLI) |
| `MAILO_OPS_TOKEN` | 고정 | `loadOps` | 동기. `loadConfig` |
| `MAILO_OPS_ADMIN_TOKEN_<이름>` | 동적. 이름은 `MAILO_OPS_ADMIN_NAMES`의 값을 대문자로 바꾼 것(최대 8개) | `loadOps` | 동기. `loadConfig` |
| `MAILO_SMTP_PASSWORD` | 고정(`default` 계정) | `config/smtp-accounts.ts`의 `loadSmtpAccounts` | 동기. `loadConfig` |
| `MAILO_SMTP_SECRET_<이름>` | 동적. 이름은 `MAILO_SMTP_ACCOUNTS_FILE` JSON의 `auth.secretVar`. 형식 `^MAILO_SMTP_SECRET_[A-Z0-9_]{1,40}$`, `_FILE`로 끝나는 이름은 거부(최대 20개 계정) | `loadSmtpAccounts`(JSON을 `loadConfig` 안에서 동기로 읽는다) | 동기. `loadConfig` |
| `MAILO_DB_ENCRYPTION_KEY_V<n>`, `MAILO_FINGERPRINT_KEY_V<n>` | 동적. `n`은 `reader.env`의 변수 이름을 정규식 `^<접두어>_V(\d+)(_FILE)?$`로 훑어 찾는다 | `config/key-loader.ts`의 `loadKeyRing` | 동기. `loadConfig` |
| `MAILO_JWS_SECRET_<이름>` | 동적. 이름은 `MAILO_CALLERS_FILE` JSON의 `secretVar`. 형식 `^MAILO_JWS_SECRET_[A-Z0-9_]{1,80}$` | `callers/registry.ts`의 `parseCallerRegistry` | 동기. `CALLER_REGISTRY` provider 팩토리(`callers/callers.module.ts`)가 `APP_ENV`로 읽는다. `loadConfig` 뒤 |
| `MAILO_JWE_KEY_<이름>` | 동적. 이름은 `MAILO_ENVELOPE_KEYS_FILE` JSON의 `privateKeyVar`. 형식 `^MAILO_JWE_KEY_[A-Z0-9_]{1,80}$` | `envelope/key-file.ts`의 `parseEnvelopeKeys` | 동기. `ENVELOPE_DEPS` provider 팩토리(`envelope/envelope.module.ts`)가 `APP_ENV`로 읽는다. `loadConfig` 뒤 |
| `MAILO_CLI_TOKEN` | 고정 | `cli/run.ts`의 `resolveToken`(`EnvReader`를 쓰지 않는다. 주입한 `readTextFile`로 `MAILO_CLI_TOKEN_FILE`을 읽는다) | 비동기. 별도 프로세스(`cli.ts`) |

- 이 표 밖에서 `_FILE`을 읽는 곳은 비밀이 아니다. `MAILO_DB_SSLROOTCERT_FILE`은 CA 인증서 경로다(`config/database-ssl.ts`). `callers.json`에는 API 키의 SHA-256 해시만 있다.
- 해석 규칙은 `EnvReader.secret` 한 곳이다(운영 CLI의 토큰 읽기는 제외). `<NAME>_FILE`이 있으면 파일을 읽고(끝의 개행 한 개 제거, 비었거나 읽지 못하면 기동 실패, 사유는 errno 코드만) 없으면 `<NAME>`을 쓴다. 둘 다 있어도 오류가 아니고 `_FILE`이 이긴다(`deployment.md` "시크릿 주입"이 이 우선순위를 문서화하고 compose override 예시가 이에 기댄다). 빈 문자열은 없는 값이다(`EnvReader.raw`, compose의 `${VAR:-}` 때문).
- `EnvReader`는 동기이고 `readFileSync`를 쓴다. 이 경로를 쓰는 로더가 `loadConfig`, `parseCallerRegistry`, `parseEnvelopeKeys`, `loadKeyRing`, `loadSmtpAccounts`다. 모두 동기 함수이고 단위 테스트가 이 시그니처에 기댄다.
- 환경 변수 맵은 이미 명시적으로 흐른다. `loadConfig(env = process.env)`, `createApp({ env })`(`AppModuleOptions.env`), `ConfigModule.forRoot(config, env)`가 만드는 `APP_ENV`, 두 provider 팩토리가 이 맵을 읽는다. `main.ts`는 `loadConfig()`만 부르고 `env`를 넘기지 않아 기본값 `process.env`가 쓰인다.
- 기동 경로. `main.ts`: `loadConfig()` → `createApp({ config, worker: {}, ... })` → `NestFactory.create`가 provider 팩토리(`CALLER_REGISTRY`, `ENVELOPE_DEPS`)를 실행 → `listen`. compose의 `mailo` 서비스 명령은 `sh -c "node dist/db/migrate-cli.js && exec node dist/main.js"`다. 마이그레이션 CLI(`db/migrate-cli.ts`)는 `loadDatabaseOnly()`로 DB URL과 연결 암호화 설정만 읽는다. `docker-compose.migrate-once.yml`은 마이그레이션을 별도 컨테이너(`mailo-migrate`)로 뗀다. 이미지 기본 `CMD`는 `node dist/main.js`이고 마이그레이션을 실행하지 않는다.
- compose는 `env_file: .env`로 `.env` 전체를 컨테이너에 준다. `X_REF`를 `.env`에 적으면 컨테이너에 전달된다.
- `apps/mailo/src`에는 `child_process`·`worker_threads` import가 없다(검색 결과 0건). 런타임에서 자식 프로세스는 compose 명령의 `sh`(마이그레이션 CLI와 `exec`)뿐이다.
- 로그에는 변수 이름과 고정 사유만 쓴다. `ConfigError`, `CallerRegistryError` 등 다섯 클래스는 `main.ts`의 `startup_failed` 로그가 `message`까지 싣는 오류 클래스 목록에 있고, 그 밖의 오류는 `describeError`(이름·코드)만 싣는다.
- 키 교체는 재시작이다. 레지스트리는 기동 때 한 번 읽고 핫 리로드를 만들지 않았다(ADR-0014 결정 9). 운영 토큰·SMTP 비밀번호·키 교체 절차는 모두 "값을 바꾸고 재시작"이다(`key-management.md`).
- 이전 JWE 개인키는 `retiredAt`부터 Key 보존 기간(기본 30일) 이상 보관해야 하고 삭제는 `removed` 기록이 검증한다. DB 본문 키·지문 키는 그 `key_version` 행이 모두 사라질 때까지 보관한다(`key-management.md` "키 종류와 이전 키 보관 규칙").
- 이미지·릴리스. `Dockerfile`은 base 이미지를 digest로 고정하고 `/repo`를 root 소유로 둔다. 런타임은 `USER node`, compose는 `read_only: true`, `cap_drop: [ALL]`이다. `.github/workflows/release.yml`은 `verify` 잡 뒤 `release` 잡 하나가 로컬 빌드 → 스모크(`--read-only` 실행, 설정 없는 기동이 종료 코드 1·`startup_failed`로 끝나는지) → GHCR push → config digest 확인 → `latest` → GitHub Release를 한다. `ci.yml`과 `release.yml`에서 취약점 스캔 단계를 찾지 못했다(`trivy`·`audit` 검색 0건).
- `pnpm-workspace.yaml`은 `apps/*`만 포함한다. `samples/spring-boot-relay/`가 워크스페이스·turbo·CI 밖에 있는 선례다(`AGENTS.md`).

참고한 storix 설계(읽기 전용, 수정하지 않았다).

- 규약: `X`, `X_FILE`, `X_REF=<scheme>://<참조>` 중 하나만 지정한다. 둘 이상이면 기동 실패. 빈 값은 지정하지 않은 것(`docs/design/15-secret-sources.md`, api ADR-0040).
- 해석: 진입점 두 곳이 기동 전에 `resolveSecrets()`를 부르고 해석값을 `process.env`에 쓴다. 대상은 고정 목록 10개(`SECRET_ENV_NAMES`). 실패는 모아서 한 번에 보고하고 값과 어댑터 오류 메시지는 쓰지 않는다. 타임아웃 기본 10초, 코어는 재시도하지 않는다.
- 어댑터: `SecretSource { scheme, resolve(ref, { signal }) }` 구조적 타입, 기본 export, 코어는 `file`만 내장. 로더는 `STORIX_SECRET_ADAPTERS`의 bare 패키지 이름만 `import()`한다.
- 자식 프로세스: `pg_dump` 호출 한 곳이 환경 변수 허용 목록으로 자식 환경을 만든다.
- 배포: 어댑터별 변형 이미지 `vX.Y.Z-aws`(api ADR-0050). 어댑터는 루트 워크스페이스 밖 독립 패키지이고 변형 job이 `release` job 뒤에 `needs`로 이어진다. 변형은 push 전에 이미지 안 스모크(가짜 HTTP 서버, `--network none`)를 통과해야 한다.
- AWS 어댑터(`packages/secret-source-aws`): `aws-sm://<SecretId>[#<키>]`, `GetSecretValue`, `SecretString`만 지원, 요청마다 클라이언트를 만들고 `AbortSignal`을 넘긴다. 자격 증명은 SDK 기본 체인이다. LocalStack 시나리오는 수동 검증이다.

storix와 구조가 달라서 그대로 옮기지 않는 부분은 "storix와 다른 점" 절이다.

### 가정

- 기동 때 외부 저장소를 한 번 읽는 방식으로 운영자의 요구가 충족된다고 본다. 실행 중 갱신이 필요한 운영자가 있는지 확인하지 않았다(결정 7).
- 한 배포의 `X_REF` 수는 많아야 수십 개라고 본다(호출처 JWS 키, SMTP 계정 20개 상한, 관리 토큰 8개 상한, 키 버전, JWE 키). 측정하지 않았다.
- Mailo 운영자는 대부분 단일 호스트 compose를 쓴다고 본다(저장소의 배포 문서가 compose 하나다). AWS 위가 아닌 호스트에서는 저장소 접근 자격 증명을 다른 경로로 줘야 한다. 이 경로를 확인하지 않았다("한계").
- AWS SDK for JavaScript v3의 `GetSecretValue` 동작과 기본 자격 증명 체인은 storix의 어댑터 코드와 가이드에서 읽은 내용이다. AWS 문서와 실제 계정으로 확인하지 않았다.

### storix와 다른 점

| 항목 | storix | Mailo | 이유 |
| ---- | ------ | ----- | ---- |
| 대상 변수 | 고정 목록 10개 | 고정 이름 + 이름 규칙(허용 목록). 설정 JSON이 가리키는 동적 이름이 있다 | 위 표. JWS·JWE·SMTP 비밀은 이름을 JSON이 정한다 |
| 해석값 위치 | `process.env`에 쓴다 | 환경 복사본(`NodeJS.ProcessEnv` 새 객체)에 쓰고 `loadConfig(env)`·`createApp({ env })`로 넘긴다 | Mailo는 이미 `env`를 명시적으로 넘긴다. `process.env`를 바꾸면 테스트 간 누수가 있고 같은 프로세스의 어떤 코드든 값을 읽는다 |
| 충돌 규칙 | 둘 이상이면 실패 | `X_REF`가 `X`·`X_FILE`과 같이 있을 때만 실패. `X_FILE`과 `X`는 현행 유지(`_FILE` 우선) | 현재 우선순위가 문서와 compose 예시에 쓰인다. 바꾸면 기존 배포가 깨진다 |
| `.env`에서 온 `X_REF` | compose가 `environment:`에 적은 변수만 컨테이너에 준다 | compose가 `env_file: .env`로 전부 준다 | 별도 전달 설정이 필요 없다. 대신 `.env`에 남은 평문 `X`와 충돌 검사가 중요하다 |
| 진입점 | `bootstrapWithEnv()`, `typeorm` CLI 둘 | `main.ts`, `db/migrate-cli.ts` 둘. 컨테이너에서 둘이 한 `sh -c`로 이어진다 | 같은 구조지만 프로세스가 둘이라 저장소를 두 번 읽는다 |
| 자식 프로세스 허용 목록 | `pg_dump` spawn이 있어 필요 | 해당 없음(`child_process` 사용 0건) | 필요한 코드가 없다. 새 spawn이 생기면 그때 정한다 |
| 어댑터 오류 | 종류 `adapter-error` 하나, 메시지·코드 버림 | 닫힌 코드 5종은 통과(결정 5) | 기동 실패 원인(권한, 없음, 제한)을 운영자가 알아야 한다. 값은 새지 않는다 |
| 어댑터 범위 | OpenBao·AWS 둘 | AWS 하나(결정 8) | OpenBao는 storix의 특정 사용처가 만든 어댑터에서 왔다. Mailo는 그런 요구가 없다 |
| 배포 | 변형 이미지, base 이미지는 태그 | 변형 이미지, base를 digest로 고정(결정 4) | `Dockerfile`·`release.yml`이 digest 고정 규칙을 둔다 |
| 소비자 수정 | 없음(`process.env`를 읽는 기존 코드) | `loadConfig`와 팩토리가 이미 `env` 인자를 받으므로 소비자 수정 없음. 단 `main.ts`·`migrate-cli.ts`·로더 secretVar 검사 몇 줄을 고친다 | 구조상 가능하다 |

## 결정

결정 문구는 선택지 표의 권고를 따랐다. 승인 전이므로 사용자가 고르면 바뀐다.

1. **규약은 `X_REF=<scheme>://<참조>`를 `X_FILE` 옆에 더한다. `X_REF`는 `X`·`X_FILE`과 함께 지정하면 기동을 거부하고, `X_FILE`과 `X`의 현행 우선순위는 바꾸지 않는다.**
   - 문제: 비밀값을 외부 저장소에서 받는 지정 방법이 없다. 규약을 정해야 `.env`·compose 예시·오류 메시지를 한 번에 맞춘다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. `X_REF`가 있으면 `X`·`X_FILE`이 비어 있어야 한다. `X_FILE`과 `X`는 현행(`_FILE` 우선) | 권고. 새 지정만 엄격하게 하고 기존 배포를 깨지 않는다. 남은 평문 값이 REF를 가리는 사고를 막는다 |
     | B. 셋 중 둘 이상이면 모두 실패(storix 규칙) | `X_FILE` + `X` 조합이 현재 문서 절차(`deployment.md` "시크릿 주입")와 compose override 예시에 있어 기존 배포가 기동하지 않게 된다 |
     | C. 우선순위로 해소(REF > FILE > env) | `.env`에 남은 평문 값이 조용히 무시된다. 어느 값이 쓰였는지 알기 어렵다 |

   - 결정 문구(A):
     - 지정 방법은 `X=값`, `X_FILE=경로`, `X_REF=<scheme>://<참조>`다.
     - 빈 문자열은 지정하지 않은 것이다. 세 이름 모두 같다(`EnvReader.raw`와 같다). compose에서 `X: ""`로 `.env` 값을 비우는 방법이 REF에도 통한다.
     - `X_REF`가 비어 있지 않고 `X` 또는 `X_FILE`도 비어 있지 않으면 `conflict`로 기동 실패다. 방식은 `env+ref`, `file+ref`, `env+file+ref`로 적는다.
     - `X_REF`는 `<scheme>://<참조>` 형식이어야 한다. scheme은 `^[a-z][a-z0-9+.-]*$`이고 `//` 뒤에 한 글자 이상 있어야 한다. `file` scheme은 예약어라 거부한다. 파일은 `X_FILE`로만 지정한다.
     - 어댑터에는 `X_REF` 값 전체를 넘긴다.
     - 해석한 값이 빈 문자열이면 `empty`로 실패한다. `EnvReader.raw`가 빈 문자열을 없는 값으로 보므로 해석 단계에서 막지 않으면 "값 없음"이 조용히 통과한다.
     - 값 끝의 개행은 어댑터가 돌려준 그대로 쓴다. 파일 방식과 달리 코어가 자르지 않는다. 키 형식 검사(`decodeKey`의 `trim`, 토큰의 공백 검사)가 각 소비자에 이미 있다.
     - 새 환경 변수 이름이 필요하다: `MAILO_SECRET_ADAPTERS`(어댑터 패키지 이름, 쉼표 구분), `MAILO_SECRET_RESOLVE_TIMEOUT_MS`(결정 5). 둘 다 비밀이 아니다.
   - 위험: `.env.example`은 가짜 평문 값(`MAILO_SMTP_PASSWORD`, `MAILO_DB_ENCRYPTION_KEY_V1`, `MAILO_FINGERPRINT_KEY_V1`)을 활성 줄로 둔다. 복사해서 `_REF`만 더하면 `conflict`로 막힌다. 오류가 변수 이름과 조합을 알려 주므로 의도한 동작이다. 이 변수들의 주석 처리 안내는 구현 때 `.env.example`에 쓴다.

2. **해석은 `main.ts`와 `db/migrate-cli.ts`가 설정을 읽기 전에 부르는 비동기 `resolveSecrets(env, 옵션)`이 하고, 결과를 `process.env`가 아닌 새 환경 복사본에 담아 `loadConfig`와 `createApp`에 넘긴다. 설정 JSON이 가리키는 동적 이름은 JSON을 읽지 않고 이름 규칙 허용 목록과 `*_REF` 변수 훑기로 찾는다.**
   - 문제: Mailo의 비밀 읽기는 모두 동기 `EnvReader.secret`이고 변수 이름의 상당수를 설정 JSON이 정한다. 외부 저장소 호출은 비동기다. 두 사실을 이어야 한다. storix는 고정 목록이라 이 문제가 없다.
   - 선택지(해석 시점):

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 기동 전에 한 번 비동기로 해석하고 결과를 환경 복사본에 채운다. 로더는 그대로 쓴다 | 권고. 키 처리 로더 5개와 그 단위 테스트를 건드리지 않는다. 해석 실패가 설정·DI 어느 단계보다 먼저 나온다 |
     | B. `EnvReader.secret`을 비동기로 바꿔 읽는 시점에 푼다 | `loadConfig`와 팩토리 둘이 비동기가 되고 `loadConfig`를 부르는 모든 테스트가 바뀐다. 인증·키 처리 코드의 변경 면적이 크다 |
     | C. 동기 어댑터만 허용한다 | AWS SDK는 비동기 HTTP다. 막힌다 |

   - 선택지(해석 대상 이름 찾기):

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 고정 이름 + 이름 규칙 허용 목록. 환경에서 이름이 `_REF`로 끝나는 변수를 훑어 허용 목록에 맞는 것을 모두 해석한다 | 권고. JSON을 읽지 않는다. 키 버전 `n`도 같은 방식으로 찾는다(`loadKeyRing`이 이미 `reader.env`를 훑는다) |
     | B. 설정 JSON 셋을 먼저 읽어 `secretVar`·`privateKeyVar` 이름을 모으고 그 변수만 해석한다 | 쓰이는 변수만 해석한다. 그러나 JSON 셋을 해석 단계와 `loadConfig`·팩토리가 두 번 읽고 파싱하며 이름 검증을 중복한다. `loadConfig` 안에서 계정 파일을 읽는 순서와 얽힌다 |
     | C. 변수마다 어댑터를 읽기 시점에 부른다(2-B와 같다) | 위 B와 같은 이유로 보류 |

   - 결정 문구(시점 A, 이름 A):
     - 시그니처 후보: `resolveSecrets(env: NodeJS.ProcessEnv, options: { scope: "all" | "database"; importModule? }): Promise<NodeJS.ProcessEnv>`. 입력 `env`는 바꾸지 않고 `{ ...env, <이름>: <값> }` 새 객체를 돌려준다.
     - `main.ts`는 `loadConfig` 전에 `const env = await resolveSecrets(process.env, { scope: "all" })`를 부르고 `loadConfig(env)`와 `createApp({ config, env, ... })`에 같은 `env`를 넘긴다. 로더·팩토리는 이미 `APP_ENV`를 받으므로 소비자 코드는 바뀌지 않는다.
     - `db/migrate-cli.ts`는 `loadDatabaseOnly(await resolveSecrets(process.env, { scope: "database" }))`를 쓴다. `database` 범위의 대상은 `MAILO_DATABASE_URL`과 `MAILO_DB_PASSWORD`뿐이다. 마이그레이션 프로세스가 JWS·JWE·SMTP 비밀을 읽을 이유도 권한도 없다.
     - 허용 목록(범위 `all`)은 표 "Mailo의 비밀값 읽기 현황"의 이름 규칙과 같다: `MAILO_DATABASE_URL`, `MAILO_DB_PASSWORD`, `MAILO_OPS_TOKEN`, `MAILO_OPS_ADMIN_TOKEN_<이름>`, `MAILO_SMTP_PASSWORD`, `MAILO_SMTP_SECRET_<이름>`, `MAILO_DB_ENCRYPTION_KEY_V<n>`, `MAILO_FINGERPRINT_KEY_V<n>`, `MAILO_JWS_SECRET_<이름>`, `MAILO_JWE_KEY_<이름>`. 정규식은 각 로더가 쓰는 것과 같게 맞춘다. `MAILO_CLI_TOKEN`은 넣지 않는다(결정 8의 "하지 않는 것").
     - 훑는 규칙: `<NAME>_REF`가 비어 있지 않은 변수마다 `<NAME>`이 허용 목록에 있으면 해석한다. `<NAME>`이 `_FILE` 또는 `_REF`로 끝나면 `unknown-name`이다. 범위 `all`에서 이름이 `MAILO_`로 시작하고 `_REF`로 끝나는데 허용 목록에 없으면 `unknown-name`으로 실패한다. 오타(`MAILO_SMTP_PASWORD_REF`)가 조용히 무시되어 `.env`의 가짜 평문 값으로 기동하는 일을 막는다. 범위 `database`는 이 검사를 하지 않는다.
     - 해석 대상이 없고 어댑터도 지정하지 않았으면 환경 복사본은 입력과 같고 네트워크·`import()` 호출이 없다. 기존 배포의 동작이 바뀌지 않는다.
     - 해석은 병렬이다. 모든 변수가 성공했을 때만 복사본에 쓴다. 하나라도 실패하면 실패를 모아 `SecretResolutionError`로 던진다.
     - 값 검증(키 형식, 공개 샘플 키 거부, 토큰 규칙)은 기존 소비자가 한다. 해석 단계는 필수 여부를 판단하지 않는다. 지정한 참조를 해석하지 못하면 실패시킨다.
     - 로더의 `secretVar`·`privateKeyVar` 형식 검사에 `_REF` 끝 이름 거부를 더한다(`smtp-accounts.ts`는 이미 `_FILE` 끝을 거부한다. 같은 방식). `MAILO_JWS_SECRET_A_REF`가 변수 `MAILO_JWS_SECRET_A`의 참조와 이름이 겹치는 것을 막는다.
     - 허용 목록의 정규식과 각 로더의 정규식이 어긋나지 않게 하는 방법은 구현 때 정한다. 후보: 소유 모듈이 정규식을 `index.ts`로 공개하고 앱 조립 파일(예: `secret-names.ts`)이 목록을 만든다. `secrets/`는 다른 모듈에 의존하지 않는 leaf로 둔다. 어긋남을 잡는 단위 테스트를 둔다.
   - 위험: 환경에 `_REF`가 있으나 설정 JSON이 참조하지 않는 변수는 쓰이지 않는 채로 해석된다. 저장소 호출이 한 번 늘고 그 비밀을 읽을 권한이 필요하다. 해석 실패가 기동을 막는다. 운영 문서가 "쓰지 않는 `_REF`를 남기지 않는다"를 안내한다. 이 비용이 문제로 드러나면 JSON 우선(이름 B)으로 바꾼다. 환경 복사본은 `APP_ENV` provider에 남아 평문 값을 메모리에 둔다. 현재 `process.env`가 이미 `APP_ENV`로 들어 있어 노출 범위는 같다.

3. **어댑터 계약은 storix와 같은 구조적 타입 `SecretSource { scheme, resolve(ref, { signal }) }`이고 코어는 어댑터를 내장하지 않는다. 로더는 `MAILO_SECRET_ADAPTERS`의 bare 패키지 이름만 `import()`한다.**
   - 문제: 제공자 SDK를 코어에 넣지 않으면서 코어가 어댑터를 불러올 방법과 신뢰 경계가 필요하다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 구조적 계약 + bare 패키지 이름 `import()` | 권고. 어댑터는 Mailo 소스를 import하지 않는다. 이미지에 설치된 패키지만 로드된다 |
     | B. 경로·URL 지정자 허용 | 쓰기 가능한 볼륨(파일 채널 마운트)의 파일이 코드로 로드될 수 있다 |
     | C. 어댑터를 코어에 정적 import | AWS SDK가 모든 이미지에 들어간다. 결정 4와 맞지 않는다 |

   - 결정 문구(A):
     - 계약: `interface SecretSource { readonly scheme: string; resolve(ref: string, options: { signal: AbortSignal }): Promise<string> }`. 어댑터 모듈의 기본 export가 이 구조다. `scheme`은 결정 1의 형식을 따르고 `file`은 쓸 수 없다. `resolve`는 `X_REF` 전체를 받아 값을 문자열로 돌려준다. `signal`이 abort되면 작업과 열어 둔 연결을 멈춘다.
     - 지정자는 정규식 `^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$`를 통과하는 bare 패키지 이름만 받는다. 경로, `file:`·`data:`·`http(s):` URL, `node:` 접두, 하위 경로(`pkg/sub`), 대문자는 `invalid-specifier`로 거부한다.
     - 해석 기준 위치는 로더 파일(`apps/mailo/dist/secrets/`)이 속한 패키지(`apps/mailo`)의 `node_modules`다(Node ESM 탐색). 이미지의 `/repo`는 root 소유 읽기 전용이라 런타임이 어댑터를 설치하거나 바꿀 수 없다.
     - 로드 실패 종류: `invalid-specifier`, `not-found`, `import-failed`, `invalid-export`, `reserved-scheme`, `duplicate-scheme`. 실패를 모아 `SecretAdapterLoadError`로 던진다. `import()` 오류 메시지는 옮기지 않는다.
     - 어댑터 로드는 해석보다 먼저다. `MAILO_SECRET_ADAPTERS`가 비어 있고 `X_REF`가 있으면 `unknown-scheme`으로 실패한다.
     - 위협 모델: `MAILO_SECRET_ADAPTERS`는 운영자가 제어하는 값이다. 환경 변수를 제어하는 주체는 이미 `NODE_OPTIONS`로 코드를 실행할 수 있어 새 권한 경계가 아니다. bare 이름 제한은 방어 심층화다. 어댑터는 Mailo와 같은 프로세스에서 실행되고 자기 자격 증명(AWS 환경 변수 등)과 반환값에 접근한다. 어댑터 코드를 신뢰하는 것이 전제다. 이 이유로 어댑터는 이 저장소에서 만든 것만 이미지에 넣는다(결정 4).
     - `secrets/` 모듈을 새로 만든다. 다른 모듈에 의존하지 않는 leaf이고 `index.ts`로만 공개한다. `AGENTS.md`의 모듈 목록과 `CONTEXT-MAP.md` 표에 한 줄이 필요하다(변경안: "`secrets`(`X_REF` 해석·어댑터 로더, leaf)").
   - 위험: 어댑터가 반환한 문자열은 코어가 검증하지 못한다. 어댑터가 오류 메시지에 값을 쓰면 새는 경로가 생긴다. 코어는 어댑터 오류 메시지를 읽지 않고 버린다(결정 5). 어댑터 자체의 로그는 코어가 통제하지 못한다.

4. **어댑터는 이 저장소의 `adapters/secret-source-aws/`(워크스페이스 밖 독립 패키지)에 두고, 릴리스마다 변형 이미지 `ghcr.io/cp949/mailo:vX.Y.Z-aws`로 발행한다. 기본 이미지에는 어댑터와 SDK가 없다. RQ-029에 opt-in 예외를 한 줄 더한다.**
   - 문제: 외부 저장소 호출 코드와 SDK를 누가 어디서 만들어 어떻게 사용자에게 주는지 정해야 한다. 제약은 세 가지다. RQ-029(운영 의존성은 Mailo와 PostgreSQL), `AGENTS.md`의 새 npm 의존성 이유 기재와 "패키지를 새로 나누지 않는다", `Dockerfile`·`release.yml`의 digest 고정과 검증 순서다.
   - 선택지(배포):

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 코어에 포함(AWS SDK를 `apps/mailo` 의존성에 추가) | 모든 이미지가 SDK와 그 취약점을 갖는다. RQ-029와 가장 크게 어긋난다 |
     | B. 변형 이미지 `-aws`. 같은 릴리스 커밋의 기본 이미지 위에 어댑터만 얹는다 | 권고. 버전 어긋남이 없다. 기본 이미지는 그대로다. 사용자는 태그를 고른다. 대가는 릴리스 워크플로가 커지고 SDK 취약점을 이 저장소가 소유하는 것이다 |
     | C. 계약만 두고 사용자가 파생 이미지를 만든다(예제 Dockerfile만 제공) | 유지 비용이 가장 작다. 어댑터와 Mailo 버전 어긋남이 빌드 때 드러나지 않고 사용자가 제공자마다 같은 작업을 반복한다. B의 소유 비용을 지지 않으려면 이 안이 대안이다 |

   - 선택지(어댑터 위치):

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. `adapters/secret-source-aws/`. 자체 `package.json`·`pnpm-lock.yaml`·`pnpm-workspace.yaml`(`packages: []`), 루트 워크스페이스·turbo 밖. Mailo 코드를 import하지 않는다 | 권고. `samples/spring-boot-relay/`와 같이 워크스페이스 밖이다. SDK가 루트 lockfile과 코어 이미지에 들어가지 않는다 |
     | B. `apps/mailo/` 안(워크스페이스 편입) | 루트 lockfile에 SDK가 들어가 `pnpm install --prod`가 기본 이미지에도 설치한다 |
     | C. 별도 저장소 | 릴리스가 다른 저장소의 산출물을 받아 와야 해서 빌드의 외부 입력이 늘고 같은 커밋 보장이 깨진다 |

   - 결정 문구(배포 B, 위치 A):
     - 패키지 이름은 `@cp949/mailo-secret-source-aws`(`private: true`, npm에 공개하지 않는다). `MAILO_SECRET_ADAPTERS`에 이 이름을 쓴다.
     - 변형 Dockerfile(`adapters/secret-source-aws/Dockerfile`)은 빌드 인자 `MAILO_BASE_IMAGE`(기본값 없음, 값은 `ghcr.io/cp949/mailo@sha256:<digest>`)로 기준 이미지를 받는다. 어댑터 설치 stage의 base는 루트 `Dockerfile`과 같은 digest로 고정한다. 설치는 `pnpm install --prod --frozen-lockfile`이고 어댑터 파일을 root 소유로 `/opt/...`에 두고 `/repo/apps/mailo/node_modules/@cp949/mailo-secret-source-aws`에 링크한다. 기준 이미지의 `USER node`를 이 단계에서만 `root`로 바꾸고 마지막에 `USER node`로 되돌린다. `/repo`는 root 소유 읽기 전용이라는 규칙이 유지된다.
     - 릴리스: `release` 잡 뒤에 `variants` 잡을 `needs: release`로 잇는다. `release` 잡이 push한 기준 이미지의 digest(`steps.push.outputs.digest`)를 잡 출력으로 내고 변형은 그 digest 위에 빌드한다. 변형은 push 전에 이미지 안 스모크(결정 9)를 통과해야 한다. 변형 push 뒤 config digest 확인은 기준 이미지와 같은 방법을 쓴다. 변형이 실패해도 기준 이미지와 GitHub Release는 이미 발행된 상태다. "Re-run failed jobs"로 변형 잡만 다시 돌린다. 릴리스 노트에 이 사실을 적는다. 변형에 `latest-aws` 같은 이동 태그를 두지 않는다.
     - `ci.yml`에 어댑터 잡을 더한다: 어댑터 단위 테스트, 로컬 빌드한 기본 이미지 위에 변형 이미지 빌드, 이미지 스모크. 발행은 하지 않는다. 액션은 SHA로 고정한다(`AGENTS.md`).
     - 새 npm 의존성: `@aws-sdk/client-secrets-manager`는 어댑터 패키지에만 있다. 이유는 AWS Secrets Manager 호출이고 코어 `apps/mailo`에는 추가하지 않는다. 버전은 정확한 버전으로 고정하고 lockfile로 설치한다.
     - RQ-029 변경안(요구사항 파일은 이번에 고치지 않았다): "예외: 외부 시크릿 저장소(AWS Secrets Manager)는 어댑터 변형 이미지(`-aws`)와 `MAILO_SECRET_ADAPTERS`·`X_REF`를 함께 지정한 배포에서만 운영 의존성이다. 기본 이미지, 기본 compose, 기본 설정에는 들어가지 않고 Mailo 서비스를 새로 추가하지 않는다." 수용 조건에 "기본 이미지에 어댑터와 SDK가 없다"를 더한다.
     - `AGENTS.md` 변경안: "패키지를 새로 나누지 않는다" 뒤에 "예외: `adapters/`의 시크릿 어댑터는 pnpm 워크스페이스·turbo 밖의 독립 패키지이고 Mailo 코드를 import하지 않는다. 코어 `apps/mailo`에 제공자 SDK를 추가하지 않는다." 명령표에 어댑터 테스트 한 줄.
   - 위험: `release.yml`은 `v0.1.0` 태그로 한 번 실행했고(`docs/operations/ci.md`) 변형 잡은 실행한 적이 없다. SDK 취약점은 이 저장소가 소유한다. 현재 취약점 스캔 단계가 없다(미확인 항목). 변형 이미지의 `/repo` 쓰기 불가, `read_only` 컨테이너에서 SDK 동작은 확인하지 않았다.

5. **실패는 기동 실패(종료 코드 1, `startup_failed`)다. 해석 1건의 타임아웃은 기본 10초다. 코어는 재시도하지 않는다. 오류에는 변수 이름, 방식, 실패 종류, 어댑터가 돌려준 닫힌 코드만 쓰고 값과 어댑터 오류 메시지는 쓰지 않는다.**
   - 문제: 외부 저장소 장애가 기동을 막는다. 실패 원인을 운영자가 알아야 하지만 값과 참조는 새면 안 된다(RQ-027).
   - 선택지(타임아웃):

     | 값 | 판단 |
     | -- | ---- |
     | 5초 | 같은 리전 호출에 충분하지만 일시 지연에 기동이 실패한다(추정) |
     | 10초 | 권고(추정). storix 기본값과 같다. compose healthcheck `start_period` 30초 안에서 마이그레이션 CLI와 앱이 각각 한 번씩 쓴다 |
     | 30초 이상 | 저장소 장애 때 재시작 간격이 길어지고 `start_period`를 넘긴다 |

   - 선택지(어댑터 오류 정보):

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 닫힌 코드 5종 통과(`not-found`, `access-denied`, `throttled`, `unavailable`, `invalid-value`). 어댑터가 `code`를 이 중 하나로 던지면 `adapter-error:<code>`, 아니면 `adapter-error` | 권고. 자유 텍스트가 없어 값이 새지 않는다. 권한 오류와 이름 오타를 구분한다 |
     | B. 모두 `adapter-error`(storix) | 가장 단순하다. 기동 실패 원인을 알려면 운영자가 어댑터를 따로 실행해야 한다 |
     | C. 어댑터 메시지 전달 | SDK 오류가 SecretId·요청 ID를 담는다. 어댑터 오류에 값이 섞일 수 있다. 거부 |

   - 결정 문구(타임아웃 10초, 오류 A):
     - 해석 실패 종류(`SecretResolutionError`): `conflict`, `empty`, `invalid-ref`, `reserved-scheme`, `unknown-scheme`, `unknown-name`, `timeout`, `adapter-error`(및 `adapter-error:<code>`). 메시지는 `비밀값 해석 실패: <변수>(<방식>): <종류>`다. 변수를 모두 모아 한 번에 보고한다. 어댑터 로드 실패(`SecretAdapterLoadError`)는 해석보다 먼저 나고 둘은 함께 보고하지 않는다.
     - `main.ts`의 `startup_failed` 로그가 `message`를 싣는 오류 클래스 목록에 두 클래스를 더한다. 그렇지 않으면 이름만 남아 운영자가 변수를 알 수 없다. 두 클래스의 메시지는 변수 이름·방식·고정 종류만 담는다.
     - `MAILO_SECRET_RESOLVE_TIMEOUT_MS`: 기본 10000, 범위 100 이상 60000 이하의 정수다(`MAILO_DB_CONNECT_TIMEOUT_MS`와 같은 범위 관례). 값 검증은 어댑터를 불러오기 전에 한다. 어기면 `ConfigError`와 같은 방식으로 변수 이름과 범위만 알린다. 타임아웃이 지나면 `signal`을 abort하고 코어는 어댑터가 `signal`을 무시해도 그 시점에 `timeout`으로 확정한다. 어댑터의 늦은 거부는 미처리 거부가 되지 않는다.
     - 코어는 재시도하지 않는다. 어댑터가 타임아웃 안에서 재시도할 수 있다(AWS SDK의 기본 재시도 동작은 미확인).
     - 마지막 성공 값을 파일에 캐시하지 않는다. 읽기 전용 루트 파일시스템 규칙(`read_only: true`)과 맞지 않고 비밀의 평문 사본을 만든다.
     - 성공 때 로그는 `secrets_resolved`(info) 한 줄이고 필드는 `count`(해석 건수)와 `schemes`(사용한 scheme 이름)뿐이다. 참조 문자열(SecretId를 담는다)과 변수 이름은 싣지 않는다.
     - 저장소가 응답하지 않으면 새 인스턴스는 기동하지 못하고 `restart: unless-stopped`가 재시작을 반복한다. 이미 실행 중인 인스턴스는 영향이 없다(기동 때 한 번만 읽는다). 이 비대칭을 운영 문서에 쓴다.
   - 위험: 어댑터가 코드를 잘못 붙이면 운영자가 원인을 잘못 읽는다. 코드는 진단 힌트이고 값이 아니다. 어댑터가 `access-denied`로 분류한 이유가 틀리면 어댑터 버그다. 타임아웃 10초는 추정이다.

6. **해석한 값은 `process.env`에 쓰지 않고 환경 복사본에만 둔다. 로그·오류·지표·헬스·이벤트에 값과 참조 문자열을 싣지 않는다. canary 테스트로 고정한다.**
   - 문제: RQ-027은 인증 정보와 키가 로그·오류·이벤트에 남지 않게 요구한다. 외부 저장소 도입이 새 노출 경로를 만들지 않는지 코드로 확인해야 한다.
   - 확인한 경로:

     | 경로 | 판단 |
     | ---- | ---- |
     | 자식 프로세스 | `apps/mailo/src`에 `child_process` 사용이 없다. compose 명령의 `sh`는 `X_REF`(참조)만 상속하고 해석값은 복사본이라 상속하지 않는다 |
     | `/proc/<pid>/environ`, `docker inspect`의 `Config.Env` | 참조(`X_REF`)와 어댑터 자격 증명(`AWS_*` 환경 변수를 쓰는 경우)이 보인다. 해석값은 보이지 않는다(복사본이다. storix는 `process.env` 대입 값이 `/proc`에 안 나타남을 측정했다. Mailo에서 측정하지 않았다) |
     | 로그 | 변수 이름과 종류만 오류에 쓴다. 성공 로그는 건수와 scheme뿐 |
     | `/metrics`, `/health/ready` | 변경 없음. 비밀 관련 라벨·필드를 만들지 않는다 |
     | `APP_ENV` provider | 환경 복사본을 평문으로 들고 있다. 현재도 `process.env`가 같은 위치에 있다 |
     | 어댑터 내부 로그·SDK 로그 | 코어가 통제하지 못한다. 어댑터는 값과 참조의 비밀 부분을 로그에 쓰지 않는다. SDK 기본 로거가 조용한지는 확인하지 않았다 |

   - 결정 문구:
     - `resolveSecrets`는 `process.env`를 바꾸지 않는다. 입력 `env` 객체도 바꾸지 않는다.
     - 새 자식 프로세스를 도입하는 변경은 이 ADR의 전제를 다시 본다. 그때 환경 허용 목록을 정한다(storix `buildPgChildEnv` 방식). 지금은 도입하지 않는다.
     - 검증 테스트: 어댑터가 반환하는 값과 던지는 오류 메시지에 canary 문자열을 넣고 오류 메시지, `startup_failed` 로그, `secrets_resolved` 로그, `process.env` 전체에서 검색한다. 없어야 한다(RQ-027의 기존 방식).
   - 위험: 같은 프로세스 권한의 메모리·`APP_ENV` 읽기는 막지 못한다. 어댑터 자격 증명을 환경 변수로 주면 그 값은 `docker inspect`에 보인다. 결정 4의 한계에 쓴다.

7. **값은 기동 때 한 번만 읽는다. 값이 바뀌면 재시작한다(현재 `_FILE`과 같다). 핫 리로드와 주기 재조회는 만들지 않는다.**
   - 문제: 저장소는 값이 바뀌는 곳이다. 실행 중 갱신 요구가 나올 수 있다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 기동 때 1회. 교체는 롤링 재시작 | 권고. 현재 `_FILE`·환경 변수와 같다. 소비자가 값을 기동 때 잡는다(풀 비밀번호, SMTP 전송 설정, 레지스트리의 키, 키링). ADR-0014 결정 9가 레지스트리 재로드를 만들지 않은 이유와 같다 |
     | B. 주기 재조회 + 소비자 교체 | 풀·전송기·레지스트리·키링·Worker를 부분 적용 없이 바꿔야 한다. 실패 시 이전 상태 유지 규칙이 필요하다. 요구가 확인되지 않았다 |
     | C. 시그널로 재조회 | B의 소비자 교체 비용에 운영 절차가 더해진다 |

   - 결정 문구(A):
     - 기동 때 한 번 읽는다. `_REF`의 값이 저장소에서 바뀌어도 실행 중인 인스턴스는 그대로다. 새 값은 재시작 후 반영된다.
     - 키 교체 절차(`key-management.md`)는 바꾸지 않는다. 새 키 버전을 추가하고 현재 버전을 올리고 이전 키를 보관한다. 저장소에서는 키 버전마다 별도 비밀로 둔다. 버전이 있는 키(DB 본문 키 `_V<n>`, 지문 키 `_V<n>`, JWE 개인키, 호출처 JWS 비밀키)의 `X_REF`는 값이 바뀌지 않는 비밀을 가리킨다. 저장소의 자동 교체나 같은 이름의 값 덮어쓰기를 켜면 재시작 뒤 이전 행의 복호화와 Key 지문 비교가 실패한다(`key-management.md`가 "이전 키는 해당 키로 만든 데이터가 모두 사라질 때까지 지우지 않는다"고 요구한다). Mailo는 같은 `X_REF`의 값이 바뀐 것을 감지하지 못한다. 현재 `_FILE`도 같다.
     - 롤링 재시작 중 인스턴스마다 이전·새 값이 섞이는 구간은 `_FILE`과 같고 문서의 기존 절차가 다룬다.
     - AWS 어댑터는 `AWSCURRENT`만 읽는다(결정 8).
   - 위험: 저장소에서 비밀을 교체했는데 재시작하지 않으면 값이 어긋난다. 감지 수단이 없다. 운영 절차가 "저장소 교체 → 롤링 재시작 → 이전 값 폐기" 순서를 쓴다(`key-management.md`의 SMTP 계정 비밀번호 교체 절차와 같다).

8. **범위는 AWS Secrets Manager 어댑터 하나다. 참조 형식은 `aws-sm://<SecretId>[#<JSON 키>]`이고 `SecretString`만 읽는다. 다른 제공자는 계약만 열어 두고 공식 어댑터를 만들지 않는다.**
   - 문제: 어댑터를 몇 개 유지할지 정해야 한다. 이 저장소가 소유하는 코드와 취약점이 어댑터 수에 비례한다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. AWS Secrets Manager 하나 | 권고. 요청된 범위다. 가짜 HTTP 서버로 시험할 수 있다 |
     | B. AWS + OpenBao(storix와 같음) | OpenBao 어댑터는 storix의 특정 사용처가 만든 것에서 왔다(storix ADR-0050 배경). Mailo에는 그 요구가 없다. 유지할 변형 이미지와 시험이 는다 |
     | C. 계약만 두고 공식 어댑터 없음 | 요청 범위를 채우지 못한다. 결정 4의 C와 짝이다 |

   - 결정 문구(A):
     - scheme은 `aws-sm`이다. `aws-sm://` 뒤 전체를 `GetSecretValue`의 `SecretId`로 보낸다(이름 또는 ARN). `#<키>`가 있으면 `SecretString`을 JSON 객체로 읽어 그 키의 문자열 값만 돌려준다. 키 문법은 `[A-Za-z0-9_.-]+`다. JSON 파싱 실패, 객체 아님, 키 없음(상속 속성 제외), 문자열 아닌 값은 `invalid-value`로 거부한다. `SecretBinary`는 지원하지 않는다. `VersionId`·`VersionStage` 선택은 지원하지 않는다(`AWSCURRENT`만).
     - Mailo는 비밀이 많다(호출처 JWS 키, SMTP 계정, 키 버전). 한 비밀에 JSON으로 묶는 구성을 쓸 수 있게 `#<키>`를 포함한다. 같은 SecretId를 가리키는 변수마다 `GetSecretValue`가 한 번씩 호출된다(중복 제거 없음).
     - `AWS_REGION`이 필수이고 자격 증명은 SDK 기본 체인에서 얻는다. 엔드포인트 지정은 LocalStack 같은 호환 서버를 위한 것이다. SDK가 표준 환경 변수(`AWS_ENDPOINT_URL_SECRETS_MANAGER`)를 지원하면 그것을 쓰고 아니면 `MAILO_AWS_SM_ENDPOINT`를 둔다. 지원 여부는 구현 때 SDK 문서로 확인한다(미확인).
     - 요청마다 SDK 클라이언트를 만들고 `AbortSignal`을 넘기고 `destroy()`한다. 오류는 SDK 오류 이름을 닫힌 코드(결정 5)로 바꿔 던진다. 메시지에 값과 SecretId를 쓰지 않는다.
     - 다른 제공자는 `SecretSource` 계약을 구현하면 이미지를 직접 만들어 쓸 수 있다. 공식 어댑터 추가 조건은 "하지 않는 것"에 쓴다.
   - 위험: IAM·KMS·자격 증명 체인·네트워크는 실제 AWS에서 확인하지 않는다(결정 9). Mailo는 단일 호스트 compose 배포가 많다고 본다(가정). AWS 위가 아닌 호스트는 저장소 접근 자격 증명(액세스 키, 웹 ID 토큰 파일)을 다른 경로로 줘야 한다. 이 자격 증명이 `_FILE`·환경 변수 비밀로 남는다. 외부 저장소로 옮기면 비밀 하나(저장소 접근 자격 증명)가 남는다. 이득은 비밀의 중앙 보관, 접근 감사, 교체 이력이다. 평문 비밀 파일이 사라지는 것이 아니다. EC2에서 컨테이너가 인스턴스 역할을 쓰려면 메타데이터 서비스 접근 설정(IMDSv2 홉 제한)이 필요할 수 있다는 점은 일반 지식이고 확인하지 않았다.

9. **검증은 (1) 코어 단위·통합 테스트(가짜 어댑터), (2) 어댑터 단위 테스트(가짜 HTTP 서버), (3) 변형 이미지 스모크(이미지 안, 가짜 HTTP 서버, `--network none`), (4) 수동 LocalStack 시나리오(선택)로 하고, 실제 AWS는 검증하지 않았다고 표시한다.**
   - 문제: 외부 서비스를 호출하는 기능을 자동 검증 범위와 수동 범위, 미검증 범위로 나눠야 한다.
   - 선택지(수동 시나리오):

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 가짜 HTTP 서버 스모크만 | 자동이고 네트워크가 없다. SDK의 실제 서명·엔드포인트 처리는 가짜 서버가 흉내 내는 범위만 본다 |
     | B. A + LocalStack 수동 시나리오(`scripts/` 아래, Docker 필요, 자동 테스트 아님) | 권고. SDK가 실제 Secrets Manager 호환 API 흐름을 거치는지 본다. 기본 compose에 넣지 않는다. storix는 LocalStack Auth Token이 필요하다고 문서화했다. 같은 제약이면 CI에 넣지 못한다 |
     | C. LocalStack을 compose profile로 추가 | RQ-029의 예외(Mailpit)에 두 번째 예외가 생긴다. 시나리오 폴더의 별도 compose 파일로 충분하다 |

   - 결정 문구(B):
     - 코어 단위(어느 시험을 통합으로 올릴지는 구현 계획서가 정한다): 충돌 조합 셋, 빈 값, 형식 오류, `file` 예약, 알 수 없는 scheme·이름, 타임아웃과 `signal`을 무시하는 어댑터, 어댑터 늦은 거부의 미처리 거부 없음, 닫힌 코드 통과와 그 밖 코드의 `adapter-error`, 일부 실패 시 복사본 무변경, 입력 `env`·`process.env` 무변경, 로더 지정자 거부(경로, URL, `node:`, 하위 경로, 대문자)와 로드 실패 종류, 허용 목록과 각 로더 정규식의 일치, 로더 `secretVar` `_REF` 거부, 동적 이름(키 버전 `n`, 관리 토큰 이름, 호출처·SMTP·JWE 변수) 해석, 해석한 복사본으로 `loadConfig`·`parseCallerRegistry`·`parseEnvelopeKeys`가 기존대로 통과, canary(결정 6).
     - 통합(PostgreSQL): `createApp({ env })`에 환경 복사본을 넘겨 기동하고 `/health/ready`가 200, 마이그레이션 CLI 경로(`loadDatabaseOnly` + 복사본)로 DB에 접속한다. `X_REF` 없는 기존 구성이 그대로 기동한다.
     - 어댑터: `node --test`, 가짜 HTTP 서버. 정상 값, JSON 키 선택, 없는 비밀과 키, `SecretBinary`, 중단된 `signal`, 오류 코드 변환, 값·SecretId가 오류 메시지에 없음.
     - 이미지 스모크: 변형 이미지 안에서 `dist/secrets`의 `resolveSecrets`를 부르고 가짜 Secrets Manager(127.0.0.1)를 엔드포인트로 지정한다. 해석, JSON 키, 없는 비밀, 옛 이름 어댑터의 `not-found`. 시험 값에 센티널 문자열을 넣고 출력에 센티널이 있으면 실패한다.
     - LocalStack 시나리오(수동): 비밀 생성, 변형 이미지, compose 기동, 비밀 없음·키 없음의 값 없는 기동 실패, 컨테이너 로그에 값 없음. `docs/operations/`가 "수동, CI 아님"이라고 표시한다.
     - 실제 AWS는 검증하지 않는다. IAM 정책, KMS 키 권한, 자격 증명 체인(역할·IRSA·Pod Identity·액세스 키), 네트워크 제한, 실제 지연·제한(throttling)이 대상이다. 문서가 "검증하지 않은 것"에 적는다.
   - 위험: LocalStack 통과가 실제 AWS 동작을 보증하지 않는다. 이미지 스모크는 `--network none`이라 실제 DNS·TLS 경로를 거치지 않는다.

10. **호출처에는 영향이 없다. 운영 문서(`deployment.md`, `key-management.md`, `troubleshooting.md`), `.env.example`, `docs/operations/README.md`를 구현 변경과 같은 변경에서 갱신한다. AWS 전용 가이드는 새 운영 문서로 둔다.**
   - 문제: 환경 변수와 오류 메시지가 늘고 운영 절차(교체, 롤백)가 바뀐다. `AGENTS.md`는 환경 변수 변경 때 같은 변경에서 `docs/operations/`를 갱신하라고 요구한다.
   - 결정 문구:
     - 호출처 계약(REST, 파일 채널, 이벤트)은 바뀌지 않는다. `caller-onboarding.md`는 바꾸지 않는다.
     - `deployment.md` "시크릿 주입": `_REF` 지정 방법, 충돌 규칙, 환경 변수(`MAILO_SECRET_ADAPTERS`, `MAILO_SECRET_RESOLVE_TIMEOUT_MS`) 표, compose에서 DB 비밀번호를 `_REF`로 바꾸는 예(`MAILO_DB_PASSWORD: ""`로 비우고 `MAILO_DB_PASSWORD_REF`를 지정, `docker-compose.migrate-once.yml`의 `MAILO_MIGRATE_DB_PASSWORD` 경로 포함), 변형 이미지 사용, healthcheck `start_period`와 타임아웃의 관계, 저장소 장애 때의 동작("새 인스턴스는 못 뜨고 실행 중 인스턴스는 영향 없음").
     - `key-management.md`: "기타 시크릿"에 저장소 사용 시 교체 절차, 버전 있는 키의 `_REF`는 불변 비밀을 가리킨다는 규칙, 저장소 자동 교체 금지, 기동 오류 해석 표에 해석 실패 종류.
     - `troubleshooting.md`: "기동 시 비밀값 해석 실패" 절. 종류별 조치와 닫힌 코드의 뜻.
     - 롤백 경고: 이전 버전(이 기능이 없는 버전)은 `_REF`를 무시한다. REF로만 지정한 필수 비밀은 "필요하다" 오류로 기동에 실패해 안전하다. 선택 비밀인 `MAILO_OPS_TOKEN`은 값이 없으면 읽기 토큰이 없는 상태로 기동한다(`loadOps`는 값이 없으면 `token: null`). 롤백 전에 REF를 `_FILE`이나 환경 변수로 되돌린다.
     - `.env.example`: `_REF`와 `MAILO_SECRET_ADAPTERS`를 주석 처리한 예로 더한다. 가짜 값만 쓴다.
     - 새 운영 문서 `docs/operations/aws-secrets-manager.md`: 이미지, 참조 형식, IAM 최소 권한 예, 자격 증명 체인 주의, 한계, 검증하지 않은 것. 실제 계정 ID·ARN을 쓰지 않는다.
     - `docs/operations/ci.md`: 새 CI 잡과 릴리스 변형 잡. 워크플로를 바꾸면 이 문서를 같은 변경에서 갱신한다(`AGENTS.md`).
     - `AGENTS.md`·`CONTEXT-MAP.md`·RQ-029 변경은 결정 3·4의 변경안을 승인 뒤 구현 묶음 A·B에서 반영한다.
   - 위험: 문서가 코드와 어긋나면 틀린 안내가 된다. 구현 묶음마다 같은 변경에서 고친다.

## 구현 순서

이 ADR이 승인된 뒤의 순서다. 작업 방식은 `AGENTS.md`의 "작업 실행"을 따른다.

- 이 작업은 "직접 작업으로 하지 않는 변경"(인증·암호화·키 처리, 시크릿 비노출 경로, 기동 순서)에 해당한다. 크기와 관계없이 계획서와 독립 리뷰가 필요하다.
- 묶음 A·B·C가 각각 결과 하나와 계획서 하나로 정의되므로 `qq-workflow`를 후보로 둔다. 묶음 B는 A가 만든 계약과 `dist/secrets`에 의존한다. 이 브랜치의 `docs/agents/`에는 `qq-workflow.md`, `rubber-workflow.md`, `workflow-shared.md`, `verification.md`가 없다. 읽지 못했다. 시작 전에 해당 문서를 확인하고 사용자가 방식을 정한다.

| 묶음 | 내용 | 마이그레이션 | 건드리는 파일 |
| ---- | ---- | ------------ | ------------- |
| A. 코어 | 결정 1·2·3·5·6의 코드와 기본 문서. 어댑터 없이 가짜 어댑터로 테스트 | 없음 | 신규 `apps/mailo/src/secrets/`(해석, 로더, 오류, `index.ts`), 이름 규칙 조립 파일(후보 `src/secret-names.ts`), `main.ts`, `db/migrate-cli.ts`, `config/smtp-accounts.ts`·`callers/registry.ts`·`envelope/key-file.ts`(`secretVar` `_REF` 끝 거부와 오류 문구), 신규 `test/secrets/`, `docs/operations/deployment.md`·`key-management.md`·`troubleshooting.md`·`operations/README.md`, `.env.example`, `AGENTS.md`, `CONTEXT-MAP.md`, RQ-029 |
| B. AWS 어댑터와 이미지 | 결정 4·8·9의 자동 부분 | 없음 | 신규 `adapters/secret-source-aws/`(`index.js`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `Dockerfile`, `README.md`, `test/`, `image-smoke/`), 이미지 스모크 스크립트, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `docs/operations/ci.md`, `AGENTS.md`(명령표·예외) |
| C. 운영 가이드와 수동 시나리오 | 결정 9의 수동 부분과 결정 10의 AWS 전용 문서 | 없음 | 신규 `docs/operations/aws-secrets-manager.md`, 신규 시나리오 폴더(예: `scripts/secrets-localstack/`), `key-management.md`의 교체 절차 보강, 요구사항 진행 상태 |

순서는 A → B → C다. C의 문서 작성은 B와 겹칠 수 있으나 이미지 이름과 어댑터 오류 코드가 B에서 정해지므로 B 뒤에 확정한다. 환경 변수 문서는 A에 포함한다(`AGENTS.md`가 같은 변경에서 갱신을 요구한다).

```txt
묶음 A
위험도: 중간 (기동 경로와 키·비밀 처리 코드 주변 변경. `X_REF`를 쓰지 않으면 동작이 같도록 테스트로 고정한다. 새로 생기는 실패는 알 수 없는 `MAILO_*_REF` 변수와 `MAILO_SECRET_*` 설정 오류뿐)
롤백: 이전 이미지로 교체한다. 데이터·마이그레이션 변경이 없다. REF를 쓰던 배포는 이전 버전이 `_REF`를 무시하므로 롤백 전에 `_FILE`이나 환경 변수로 되돌린다(결정 10의 경고)

묶음 B
위험도: 중간 (release.yml 변경과 새 의존성(AWS SDK). `variants` 잡이 실패해도 기본 이미지·Release는 발행된 상태로 남도록 `release` 잡과 분리한다)
롤백: 워크플로·패키지 변경을 되돌린다. 이미 발행한 `-aws` 태그는 GHCR에 남는다. 태그 삭제는 사용자가 정한다

묶음 C
위험도: 낮음 (문서와 수동 스크립트. 전용 compose project에 한정)
롤백: 문서·스크립트를 이전 커밋으로 되돌린다
```

## 검증 계획

구현 때 다음을 확인한다. 이 ADR은 아무것도 실행하지 않았다.

- 결정 9가 정한 단위·통합·어댑터·이미지 스모크·수동 시나리오. 결과와 실패 수를 구현 변경이 기록한다.
- 시크릿(RQ-027): 어댑터가 값과 오류 메시지에 넣은 canary가 `startup_failed`·`secrets_resolved` 로그, 오류 메시지, `process.env`에 없다.
- 회귀: `X_REF` 없는 구성(`.env.example` 기반 기존 구성, `_FILE` 구성)이 기존대로 기동한다. 기존 단위·통합 테스트가 그대로 통과한다. 새 실패(`unknown-name`)가 `.env.example`과 `scripts/container/`의 기존 변수로 나지 않는다.
- 이미지: 기본 이미지에 `adapters/`의 패키지와 `@aws-sdk`가 없다. 변형 이미지는 `/repo`가 root 소유이고 `node`가 쓰지 못한다. 변형 이미지가 `read_only`·`cap_drop: [ALL]`로 해석 스모크를 통과한다.
- 문서: 금지 표기 검사(`docs/agents/writing-styles.md` "검증"), 새 링크의 존재 확인.

## 검토한 대안

| 결정 | 대안 | 채택하지 않은 이유 |
| ---- | ---- | ------------------ |
| 1 | 셋 중 둘 이상이면 모두 실패 | 현행 `_FILE` > `X` 우선순위를 쓰는 배포가 깨진다 |
| 1 | 우선순위 REF > FILE > env | `.env`에 남은 평문이 조용히 무시된다 |
| 2 | `EnvReader.secret`을 비동기로 변경 | `loadConfig`·팩토리·테스트 전체 변경. 키 처리 코드 변경 면적이 크다 |
| 2 | 설정 JSON을 먼저 읽어 이름을 모은다 | JSON 이중 읽기와 이름 검증 중복. 해석 순서가 `loadConfig` 안의 계정 파일 읽기와 얽힌다 |
| 2 | `process.env`에 쓴다(storix) | 테스트 누수, 같은 프로세스의 모든 코드가 값을 읽는다. Mailo는 `env` 인자를 이미 넘긴다 |
| 3 | 경로·URL 지정자 허용 | 쓰기 가능한 볼륨에서 코드가 로드될 수 있다 |
| 4 | AWS SDK를 코어에 포함 | 모든 이미지가 SDK와 취약점을 갖는다. RQ-029 |
| 4 | 어댑터를 워크스페이스에 편입 | 루트 lockfile과 `pnpm install --prod`가 기본 이미지에 SDK를 넣는다 |
| 4 | 변형을 `release` 잡에서 함께 발행 | 변형 실패가 기본 이미지·Release 발행을 막거나 변형만 빠진 채 성공한다 |
| 4 | 변형 base를 태그로 지정 | 태그는 옮겨질 수 있다. 같은 커밋의 digest로 고정한다 |
| 5 | 마지막 성공 값의 파일 캐시 | `read_only` 규칙과 맞지 않고 평문 사본을 만든다 |
| 5 | 어댑터 오류 메시지 전달 | SDK 오류가 SecretId·요청 ID를 담는다 |
| 7 | 주기 재조회·시그널 재조회 | 소비자 교체와 부분 적용 방지 비용. 요구 미확인. ADR-0014 결정 9와 같은 판단 |
| 8 | OpenBao 어댑터 동시 제공 | Mailo에 요구가 없다. 유지할 이미지와 시험이 늘어난다 |
| 9 | LocalStack을 compose profile로 추가 | RQ-029의 두 번째 예외가 생긴다 |

## 결과

- 승인·구현 뒤: 운영자는 `X_REF=aws-sm://...`와 `-aws` 이미지로 비밀값을 AWS Secrets Manager에서 기동 때 한 번 받을 수 있다. 기본 이미지·기본 compose·기존 설정은 바뀌지 않는다.
- 해석값은 `process.env`가 아니라 환경 복사본에 있다. 로더와 키 처리 코드는 그대로이고 `main.ts`·`migrate-cli.ts`와 `secretVar` 형식 검사 몇 줄이 바뀐다.
- 저장소 접근 자격 증명이 새로 필요하다. 이 자격 증명은 `_FILE`·환경 변수·플랫폼 역할 중 하나로 줘야 한다. 저장소가 응답하지 않으면 새 인스턴스는 기동하지 못한다.
- 새 npm 의존성은 어댑터 패키지의 `@aws-sdk/client-secrets-manager` 하나다. 코어 `apps/mailo`에는 없다. 마이그레이션이 없다.
- 호출처 계약은 바뀌지 않는다.
- 이 ADR의 모든 동작은 구현하지 않았다.

## 새 RQ 번호

마지막 RQ는 RQ-074다. 승인 때 아래 번호로 정한다. 요구사항 파일은 이번에 고치지 않았다.

| 후보 | 내용 | 묶음 |
| ---- | ---- | ---- |
| RQ-075 | `X_REF` 규약(충돌, 빈 값, 형식, 예약 scheme)과 알 수 없는 `MAILO_*_REF` 거부 | A |
| RQ-076 | 기동 전 해석, 환경 복사본, 동적 이름 허용 목록, 마이그레이션 CLI 범위 | A |
| RQ-077 | 어댑터 계약과 로더(bare 패키지 이름, 로드 실패 종류) | A |
| RQ-078 | 해석 실패 정책(타임아웃, 닫힌 오류 코드, 기동 실패)과 값 비노출 | A |
| RQ-079 | AWS Secrets Manager 어댑터(`aws-sm`, JSON 키 선택) | B |
| RQ-080 | 변형 이미지 `-aws`, CI 잡, 릴리스 변형 잡, 기본 이미지에 어댑터·SDK 없음 | B |
| RQ-081 | 운영 문서와 수동 시나리오, 검증하지 않은 것의 표기 | C |

갱신할 기존 RQ: RQ-029(opt-in 예외, 결정 4), RQ-025(이미지에 인증 정보 없음. 변형 이미지도 해당), RQ-027(새 오류 경로의 canary).

## 하지 않는 것

| 항목 | 이유 | 재검토 조건 |
| ---- | ---- | ----------- |
| 실행 중 값 갱신(핫 리로드, 주기 재조회) | 소비자가 기동 때 값을 잡는다. ADR-0014 결정 9와 같은 판단이다(결정 7) | 운영자가 재시작 없는 교체를 요구하고 소비자별 교체 비용을 감당할 이유가 생긴다 |
| 비밀 생성, 비밀 자체의 암호화 저장, 저장소에 쓰기 | 읽기만 범위다. 키 생성은 운영 절차다(`key-management.md`) | |
| OpenBao 등 다른 제공자의 공식 어댑터 | 요구가 없다. 계약은 열려 있다(결정 8) | 운영자 둘 이상이 요구하고 가짜 서버로 시험할 수 있다. 변형 이미지 하나와 시험이 늘어나는 비용을 정한다 |
| `MAILO_CLI_TOKEN`의 `_REF` | CLI는 운영자 단말에서 실행되는 별도 프로세스이고 어댑터가 설치되지 않은 환경에서 쓴다. 사람이 쥔 토큰이다 | 운영자가 CLI 토큰도 저장소에서 받겠다고 요구한다 |
| 호출처 JWS 비밀키를 호출처가 저장소에 직접 등록하는 흐름 | Mailo는 호출처 키를 설정으로 받는다(ADR-0008 결정 2). 저장소는 운영자의 몫이다 | |
| 마지막 성공 값 캐시, 저장소 장애 때 대체 값 | `read_only` 규칙과 맞지 않고 평문 사본을 만든다(결정 5) | |
| AWS `VersionId`·`VersionStage`, `SecretBinary`, 중첩 JSON 키 | 요구가 없다. 버전 선택은 키 버전 규칙(결정 7)과 충돌할 수 있다 | |
| 같은 이미지에 어댑터 둘 | 쓰지 않는 제공자의 SDK가 들어간다. 이미지당 어댑터 하나 | |
| 변형 이미지의 이동 태그(`latest-aws`) | 기준 이미지와 같은 커밋 보장이 깨진다 | |
| 새 자식 프로세스용 환경 허용 목록 | 자식 프로세스가 없다(결정 6) | 자식 프로세스를 도입한다 |
| 어댑터 자격 증명 변수를 Mailo가 관리 | 어댑터가 제공자 표준 방식으로 얻는다 | |
| 같은 `X_REF` 값 변경 감지(키 확인 값 저장) | 현재 `_FILE`도 없다. 범위를 넓힌다 | 키 값 변경 사고가 반복된다 |

## 미결정·확인하지 않은 것

### 사용자가 판단할 질문

1. RQ-029에 opt-in 예외를 더하는 것을 허용하는가(결정 4). 권고 허용. 대안은 외부 저장소를 지원하지 않는 것.
2. 어댑터를 `adapters/`에 두고 변형 이미지 `-aws`를 릴리스마다 발행하는가(결정 4). 권고 예. 대안은 계약과 예제 Dockerfile만 두고 사용자가 파생 이미지를 만드는 것. 이 경우 `AGENTS.md`의 패키지 규칙 예외와 릴리스 변경이 없다.
3. 해석값 위치(결정 2). 권고 환경 복사본. 대안은 storix처럼 `process.env`.
4. 동적 변수 이름 찾기(결정 2). 권고 허용 목록과 `*_REF` 훑기. 대안은 설정 JSON 우선(쓰는 변수만 해석, 구현이 더 크다).
5. 어댑터 오류 코드 5종 통과(결정 5). 권고 통과. 대안은 storix처럼 모두 `adapter-error`.
6. 타임아웃 기본 10초와 범위 100~60000(결정 5). 권고 10초(추정).
7. `MAILO_CLI_TOKEN`을 이번 범위에서 뺀다(하지 않는 것). 권고 제외.
8. 작업 방식. 권고 `qq-workflow` 후보, 묶음 A·B·C 계획서 셋. 방식 문서가 이 브랜치에 없어 확인하지 못했다.
9. LocalStack 수동 시나리오를 둘 것인가(결정 9). 권고 둔다. 대안은 가짜 HTTP 서버 스모크만.

### 확인하지 않은 것

- 실제 AWS 계정에서의 동작 전부. IAM 정책 예, KMS 키 권한, 자격 증명 체인(EC2 역할, ECS 작업 역할, EKS Pod Identity·IRSA, 액세스 키), 네트워크 제한, `GetSecretValue`의 실제 지연과 제한(throttling).
- 컨테이너에서 EC2 인스턴스 역할을 쓸 때 메타데이터 서비스(IMDSv2) 홉 제한 설정이 필요한지. 일반 지식이고 확인하지 않았다.
- AWS SDK for JavaScript v3의 서비스별 엔드포인트 환경 변수(`AWS_ENDPOINT_URL_SECRETS_MANAGER`) 지원, 기본 재시도 횟수와 `AbortSignal` 동작, 기본 로거의 출력.
- storix 어댑터 코드를 Mailo 이미지에 설치했을 때 로더(`apps/mailo/dist/secrets`)가 `/repo/apps/mailo/node_modules/@cp949/...`를 찾는지. pnpm 워크스페이스의 `apps/mailo/node_modules` 구조에 심볼릭 링크를 더하는 방식은 storix 변형 Dockerfile에서 읽은 것이다.
- 루트 `pnpm install --frozen-lockfile`이 `adapters/` 안의 별도 `pnpm-workspace.yaml`(`packages: []`)에 영향을 받지 않는지. storix 패키지 구조에서 읽었고 Mailo 루트에서 실행하지 않았다.
- `read_only: true`·`cap_drop: [ALL]` 컨테이너에서 AWS SDK가 필요로 하는 쓰기 경로(`~/.aws` 캐시, 임시 파일)가 있는지.
- 한 배포에서 `X_REF` 수십 개를 병렬 해석할 때 시작 시간과 저장소 제한. 같은 비밀의 JSON 키를 여러 변수가 가리키면 호출이 변수 수만큼 나간다.
- `ci.yml`·`release.yml`에 취약점 스캔이 없다. AWS SDK 취약점의 감시 방법을 정하지 않았다(storix는 변형 이미지에 Trivy를 쓴다).
- 변형 `variants` 잡을 실제 태그 push로 실행하지 않았다. `release.yml`의 기존 단계(스모크, config digest 확인)와 변형 단계의 결합을 실행해 보지 않았다.
- 롤링 배포 중 이 기능을 켠 인스턴스와 켜지 않은 인스턴스가 섞일 때의 동작은 코드에서 추론했다. 구버전은 `_REF`를 무시한다.
- `MAILO_OPS_TOKEN`이 없을 때 `/ops`와 `/metrics`가 어떻게 응답하는지(`loadOps`가 `token: null`을 만든다는 것만 읽었다).
- storix 시나리오가 요구하는 LocalStack Auth Token 조건이 Mailo 시나리오에도 적용되는지, 무료 이미지가 쓰이는지.
- `docs/agents/qq-workflow.md`, `rubber-workflow.md`, `workflow-shared.md`, `verification.md`는 이 브랜치에 없다. 읽지 못했다.
- 같은 `X_REF`가 가리키는 값이 저장소에서 바뀐 사실을 Mailo가 감지하지 못한다. 현재 `_FILE`도 같다.

## 구현 중 확정

### 2026-11-24 승인 때 확정한 질문 9개

"사용자가 판단할 질문"의 권고안을 그대로 확정했다. 결정 문구는 바꾸지 않았다.

| 질문 | 확정 |
| ---- | ---- |
| 1. RQ-029 예외 | 허용한다. RQ-029에 opt-in 예외 한 줄을 더한다. 기본 이미지는 SDK가 없고 변형 이미지는 선택이다. `AGENTS.md`의 "운영 의존성은 Mailo와 PostgreSQL뿐" 문구에도 같은 예외(개발용 `mailpit`과 외부 시크릿 소스 어댑터 변형 이미지)를 적는다 |
| 2. 어댑터 위치·배포 | 독립 패키지 `adapters/secret-source-aws/`(워크스페이스 밖)와 릴리스마다 변형 이미지 `-aws` 태그를 발행한다(묶음 B) |
| 3. 해석값 위치 | `process.env`가 아니라 환경 복사본으로 전달한다 |
| 4. 동적 변수 이름 찾기 | 이름 규칙 허용 목록과 `*_REF` 변수 훑기. 설정 JSON은 읽지 않는다 |
| 5. 어댑터 오류 | 닫힌 코드 5개(`not-found`, `access-denied`, `throttled`, `unavailable`, `invalid-value`)만 통과한다. 그 밖은 `adapter-error` |
| 6. 해석 타임아웃 | 기본 10초(10000), 범위 100~60000. 변수 이름 `MAILO_SECRET_RESOLVE_TIMEOUT_MS` |
| 7. `MAILO_CLI_TOKEN` | 이번 범위에서 제외한다 |
| 8. 작업 방식 | `rubber-workflow`의 LEG로 진행한다. 구현 순서의 "`qq-workflow` 후보"는 따르지 않는다. 묶음 A가 첫 LEG다 |
| 9. LocalStack 수동 시나리오 | 묶음 C에서 결정한다. 묶음 A·B 범위가 아니다 |

번호는 "사용자가 판단할 질문"의 순서와 같다.

새 RQ는 RQ-075~081을 "새 RQ 번호"의 후보 표 그대로 확정한다(`docs/requirements/mail-sending.md` 19절, 모두 미착수).

### 2026-11-24 묶음 A(코어) 구현 때 확정

결정 문구는 바꾸지 않았다. 구현이 후보 문구와 다르게 정한 곳과 후보 문구가 열어 둔 곳만 적는다.

- 시그니처. 결정 2의 후보 `resolveSecrets(env, { scope, importModule? })` 대신 `resolveSecrets(env, { names, rejectUnknown?, importModule?, logger? })`다. `secrets/`가 다른 모듈의 이름 규칙을 알면 leaf가 아니므로 호출자가 허용 목록(`names`)을 넘긴다. 범위 `all`은 `src/secret-names.ts`의 `APP_SECRET_RESOLVE_OPTIONS`(`names` + `rejectUnknown: { prefix: "MAILO_" }`)이고, 범위 `database`는 `config`가 공개한 `DATABASE_SECRET_VARIABLES`(`MAILO_DATABASE_URL`, `MAILO_DB_PASSWORD`)만 `names`로 주고 `rejectUnknown`을 생략한다(알 수 없는 `*_REF` 검사 없음).
- 이름 규칙의 소유. 정규식은 값을 읽는 로더가 소유하고 공개한다: `config/secret-variables.ts`(관리 토큰, SMTP 계정 비밀, 키링 접두어, 고정 이름), `callers`의 `JWS_SECRET_VARIABLE`, `envelope`의 `JWE_KEY_VARIABLE`. 로더가 쓰는 정규식과 허용 목록이 같은 객체라서 어긋나지 않고, 대조 테스트(`test/secrets/secret-names.spec.ts`)가 관리 토큰 이름 최대 길이 같은 경계와 동적 이름 해석을 확인한다. 키링은 `^<접두어>_V\d+$`이고 앞자리 0(`_V01`)은 해석 뒤 키 로더가 기존 오류로 거부한다.
- `unknown-name` 판정. 이름 `<NAME>_REF`에서 `<NAME>`이 허용 목록의 규칙에 맞는데 `_FILE`·`_REF`로 끝나면 `unknown-name`이다. 규칙에 맞지 않으면 `rejectUnknown.prefix`로 시작할 때만 `unknown-name`이고 그 밖의 변수(`AWS_*` 등)는 무시한다. 실패 목록의 변수 칸에는 참조 변수 이름(`X_REF`)을 적는다. `MAILO_CLI_TOKEN_REF`는 범위 밖이라 같은 이유로 거부된다.
- 실패 표기. 방식 칸은 충돌이면 `env+ref`·`file+ref`·`env+file+ref`, 어댑터가 등록된 scheme이면 `ref:<scheme>`, 그 밖(형식 오류, `file` 예약, 등록되지 않은 scheme)은 `ref`다. 등록되지 않은 scheme과 참조 문자열은 오류에 싣지 않는다(오타나 평문 비밀이 `_REF`에 들어갔을 수 있다). 실패는 변수 이름 순으로 정렬해 줄마다 `비밀값 해석 실패: <변수>(<방식>): <종류>`로 보고한다.
- 정적 실패(충돌, 형식, 예약, 알 수 없는 이름·scheme)가 있는 변수는 어댑터를 부르지 않고 나머지 변수는 병렬로 해석해 실패를 모두 보고한다. 하나라도 실패하면 어떤 값도 돌려주지 않는다.
- 어댑터 로드 실패의 라벨. 지정자가 bare 이름 규칙을 통과하면 이름을, 아니면 `<n>번째 항목`(원문 없음)을 적는다. `ERR_MODULE_NOT_FOUND`(Jest는 `MODULE_NOT_FOUND`)는 메시지에 지정자 이름이 있을 때만 `not-found`이고 어댑터 내부 의존성 누락은 `import-failed`다. 메시지는 판정에만 쓰고 옮기지 않는다.
- 설정 오류. 해석 제한 시간의 형식·범위 오류는 `config`의 `ConfigError`를 쓰지 못하므로(leaf) `SecretSettingsError`다. `main.ts`의 `startup_failed` 로그와 마이그레이션 CLI가 `SecretResolutionError`·`SecretAdapterLoadError`·`SecretSettingsError`의 `message`를 싣는다. 마이그레이션 CLI는 표준 오류에 메시지만 낸다.
- `secrets_resolved`(info)는 해석한 변수가 1건 이상일 때만 남고 필드는 `count`·`schemes`뿐이다. 설정을 읽기 전의 로거로 남기므로 `instance`는 호스트 이름이다. 마이그레이션 CLI는 로그를 남기지 않는다.
- 해석값은 환경 복사본의 `X`에 쓰고 `X_REF`는 복사본에 그대로 둔다. `docker inspect`·`/proc`에는 참조와 어댑터 자격 증명이 보이고 값은 보이지 않는다는 결정 6의 설명은 코드 읽기에 따른 것이고 `/proc`에서 측정하지 않았다.
- 검증 범위. 가짜 어댑터로 단위(`test/secrets/`), 통합(`test/e2e/secret-sources.integration-spec.ts`, 실제 PostgreSQL과 로컬 `smtp-server`)과 컴파일한 진입점의 실패·성공 경로(`test/e2e/secret-startup.integration-spec.ts`, `node_modules/.cache` 아래로 컴파일, 가짜 어댑터는 그 컴파일 폴더의 `node_modules`에 설치, 전용 schema)를 확인했다. 컨테이너·compose 기동, 롤링 배포·롤백, 실제 저장소 어댑터, `/proc` 비노출 측정은 확인하지 않았다. `AGENTS.md`의 패키지 규칙 예외와 명령표(결정 4의 변경안)는 묶음 B에서 반영한다.
