# verification

검증 정책의 정본이다. 어떤 변경에 어떤 검증을 몇 번 실행하는지, 이전 결과를 언제 다시 쓸 수 있는지, 여러 에이전트가 검증을 어떻게 나누는지 정한다. 검증을 계획·실행·보고하기 전에 이 문서를 읽는다. 작업 절차는 `workflow-shared.md`, `qq-workflow.md`, `rubber-workflow.md`가 정하고 테스트 작성 기준은 `testing.md`가 정한다. 같은 소스에서 같은 명령을 다시 실행하지 못하게 하는 훅과 `FORCE_RETEST=1` 우회는 전역 지시가 정한다.

## 검증 단계

| 단계 | 수단                                                                                                                    | 언제                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0   | `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`                                           | 소스·테스트를 바꾼 모든 변경. 문서만 바꾸면 L0을 생략하고 "문서만 바꾼 경우"를 따른다                                                                            |
| L1   | 변경 영역의 통합 spec만 실행: `pnpm --filter @cp949/mailo test:integration <경로 패턴>`                                 | 실패 수정 뒤 재확인, 소스를 바꾸지 않은 작업의 누적 대상 실행, 아래 "통합 테스트"의 중간 실행 이유가 있을 때                                                     |
| L2   | `pnpm test:integration` 전체                                                                                            | `apps/mailo/src`·`apps/mailo/migrations`를 바꾼 작업의 마무리 때 1회. 모듈 연결(`envelope`, `http`, `crypto/queue-adapters.ts`)은 통합 spec과 e2e에서만 검증된다 |
| L3   | `scripts/container/`, `scripts/volume/`, `scripts/secrets-localstack/`, `apps/mailo/scripts/nfs/run.sh`, `samples/spring-boot-relay/verify/run-e2e.sh` | 아래 표의 영역을 실제로 바꿨을 때만                                                                                                                              |

- `adapters/secret-source-aws/`를 바꾸면 L0에 더해 `AGENTS.md`의 어댑터 테스트(`cd adapters/secret-source-aws && pnpm install --frozen-lockfile && pnpm test`)를 실행한다. 루트 `pnpm test`에 포함되지 않는다.
- L1·L2 전에 `.env.example`을 `.env`로 복사하고 `docker compose up -d postgres`를 실행한다. compose는 `POSTGRES_PASSWORD`가 없으면 중단한다.
- 서버가 없으면 통합 테스트는 skip하지 않고 실패한다. 이 실패는 코드 결함이 아니라 환경 문제다. PostgreSQL부터 확인한다.
- 실행하지 않은 단계는 보고에 "실행하지 않음"으로 적는다. NFS 서버가 없어 못 돌린 `test:nfs`처럼 환경 때문에 못 돌린 경우도 같다.

L3을 돌리는 변경:

| 바꾼 영역                                              | 돌릴 것                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `Dockerfile`, `docker-compose*.yml`, 종료 순서, drain  | `verify-sigterm-file.sh`, `verify-sigkill-duplicate.sh`                           |
| 파일 채널의 권한·원자 rename·마운트 가정               | `scripts/volume/`의 해당 스크립트(`acl`·`group` 모두)                             |
| NFS 관련 코드(`file-channel/errno.ts` 등), `nfs.md`    | `apps/mailo/scripts/nfs/run.sh`                                                   |
| `samples/spring-boot-relay/`, 서명·봉투 형식(ADR-0008) | `samples/spring-boot-relay/verify/run-e2e.sh`                                     |
| `/metrics` 경로·인증(`metrics/`, `health/metrics-*.ts`, `callers/ops-auth-middleware.ts`), 지표 카탈로그 | `scripts/container/verify-metrics.sh`(`read_only` 컨테이너의 `/metrics` 응답을 관찰한다. `promtool` 이미지를 못 받으면 그 확인만 건너뛴다) |
| `secrets/`, `adapters/secret-source-aws/`, 변형 이미지, `X_REF` 기동 경로 | `scripts/secrets-localstack/run.sh`(LocalStack 최신 이미지는 Auth Token이 필요해 기본은 4.12 고정 이미지) |
| `.github/workflows/ci.yml`                             | `docs/operations/ci.md`의 로컬 재현 명령. GitHub 실행 결과가 없으면 없다고 적는다 |

## 실행 시점

검증은 세 시점으로 나눈다. 앞 시점의 결과를 뒤 시점에서 반복하지 않는다.

| 시점           | 언제                                       | 실행                                                                     |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| 개발 중        | 구현하는 동안                              | `pnpm --filter @cp949/mailo test <경로 패턴>`, 필요하면 `pnpm typecheck` |
| 실행 단위 대상 | DELTA를 리뷰에 넘기기 전                   | 이번 DELTA가 바꾼 동작의 단위 spec(`<경로 패턴>`)                        |
| 작업 최종      | 구현과 리뷰 지적 처리를 모두 끝낸 뒤 한 번 | L0 전체, 해당하면 L2, 해당하면 L3                                        |

- 개발 중과 실행 단위 대상에는 통합 테스트·L3를 실행하지 않는다. 통합 대상은 "통합 테스트"에 따라 최종에 모은다.
- 작업 최종 검증은 작업당 한 번이다. DELTA마다 반복하지 않는다.
- L0의 `pnpm test`는 단위 spec 전체를 포함한다. 그 뒤에 같은 소스에서 `<경로 패턴>` 실행을 다시 하지 않는다.
- 작업·DELTA·LEG의 종료, 커밋, `dev` 통합 자체는 검증 범위를 넓히거나 같은 검증을 다시 실행할 이유가 아니다.
- 직접 작업(작업 폴더 없음)은 실행 단위 대상과 작업 최종이 같다. 변경 끝에 L0 등 필요한 단계를 1회 실행한다.

## 검증 범위 선택

검증은 변경 영향으로 고른다. 테스트 작성·유지 여부는 `testing.md`를 먼저 확인한다. 이 문서의 범위 규칙은 스킬의 전체 테스트 지시보다 우선한다. 작업을 시작할 때 실행할 검증과 선택 근거를 기록하고, 새 근거 없이 범위를 넓히지 않는다.

- 단위 검증은 신규 spec과 변경 동작에 직접 관련된 기존 spec으로 한정한다. jest 경로 패턴으로 대상을 지정한다.
- 큐 SQL·마이그레이션·트랜잭션·잠금 변경은 해당 통합 spec을 최종 검증 대상에 넣는다. 기존 spec으로 변경된 계약을 확인할 수 없으면 필요한 테스트를 추가한다.
- L3는 위 표의 영역을 실제로 바꿨을 때만 고른다. 공통 코드를 수정했다는 사실만으로 고르지 않는다. 고를 때는 영향받는 동작과 변경 경로를 적는다.
- 재실행은 동작 변경, 실패 수정, 새로운 검증 근거가 있을 때만 한다. 주석·문서·포맷 수정만으로 동작 테스트를 반복하지 않는다. 해당 변경에 필요한 포맷·문서 검사는 실행한다.
- 실제 Gmail·Workspace SMTP 접속은 검증 수단이 아니다. SMTP는 `test/support/fake-smtp.ts`로 대체한다.

## 통합 테스트

통합 테스트는 PostgreSQL을 쓰는 `*.integration-spec.ts`다. 작업 최종에 필요한 것만 한 번 실행한다.

1. 먼저 필요 여부를 분류한다. DB·트랜잭션·잠금·마이그레이션·수명 주기에 영향이 있는지, 영향 경로가 무엇인지 적는다.
2. 필요하면 DELTA 파일의 "최종 검증 대상(누적)"에 대상 spec 경로를 쌓는다. 뒤 DELTA가 앞 DELTA의 대상을 이어받는다.
3. 중간 기록은 `미실행(최종 검증 예정)`으로 쓴다.
4. 구현 전체와 리뷰 지적 처리를 모은 뒤 실행한다. `apps/mailo/src`·`apps/mailo/migrations`를 바꿨으면 L2 전체를 1회, 아니면(테스트·지원 코드만 바꿈) 누적 대상만 L1으로 1회 실행한다.
5. 실패하면 원인을 고치고 실패한 spec과 수정이 닿는 범위만 L1으로 다시 실행한다. 전체를 처음부터 반복하지 않는다.
6. 작업은 필요한 최종 검증을 마친 뒤에만 완료한다.

DELTA 중간에 통합 테스트를 실행해야 하면 계획서나 DELTA에 이유를 적는다. 이유는 그 DELTA 안에서만 확인할 수 있는 위험이다. 예: 다음 DELTA가 이번 DELTA의 잠금 순서에 기대어 설계된다. 이유가 없으면 최종 검증으로 미룬다.

L3처럼 Docker·NFS 자원을 띄우는 검증은 리뷰로 코드가 바뀔 수 있는 동안 실행하지 않는다. 리뷰 지적 처리까지 마친 뒤 한 번 실행한다.

## 통합 테스트 동시 실행

여러 작업 폴더(worktree)나 에이전트가 통합 테스트를 같은 시각에 돌릴 때 적용한다. 같은 compose PostgreSQL 서버를 쓰되 database를 나눈다.

```bash
export MAILO_TEST_DATABASE_URL=$(scripts/test-db.sh create)   # 작업 폴더 이름에서 만든 mailo_test_* database
pnpm test:integration
scripts/test-db.sh drop                                       # 작업을 끝내고 정리한다
```

- 다른 jest가 돌고 있어도 database 이름이 다르면 기다리지 않고 실행한다. 같은 database를 쓰는 jest가 돌고 있으면(같은 `MAILO_TEST_DATABASE_URL`) 기다린다.
- 돌고 있는 jest는 `pgrep -af '^node .*jest.*--config'`로 본다. 출력이 없으면 다른 jest가 없다. 출력은 database를 구분하지 않으므로 같은 `MAILO_TEST_DATABASE_URL`인지는 따로 판단한다.
  - 한계: node를 절대경로로 실행하는 환경에서는 놓칠 수 있다. `pgrep -f "jest --config"`는 그 문자열을 인자로 가진 셸·pnpm 래퍼(`sh -c ...`)까지 잡는다.
  - 확인(2026-11-24, `pnpm test <단위 spec 하나>`, node 24.20.0, pnpm이 `node .../jest/bin/jest.js --config ...`를 실행하는 환경): `^node .*jest.*--config`는 node 프로세스만 잡았고 `jest --config`는 pnpm의 `sh -c` 래퍼도 잡았다.
- 같은 database를 동시에 쓰면 안 되는 이유는 DB 전체에 걸리는 잠금이다. schema 격리로는 막지 못한다.
  - 마이그레이터 advisory lock(`pg_try_advisory_lock(7364221001)` 폴링). database 전체의 잠금이라 한쪽이 끝날 때까지 다른 쪽이 기다린다. 기다리는 쪽은 폴링 사이에 스냅샷이 없어 교착하지 않는다(`docs/operations/deployment.md` "동시 실행 교착"). 그러나 한쪽의 `-- mailo:no-transaction` 마이그레이션(`CREATE INDEX CONCURRENTLY`)은 그 database의 모든 트랜잭션이 끝나기를 기다린다. `test/db/migrator.integration-spec.ts`의 잠금 대기 테스트는 `pg_stat_activity` 상태와 이 잠금에 의존하므로 전용 database에서만 실행한다.
  - 호출처 할당 잠금(`7364222`, `hashtext(caller_id)`)과 정리 단계 잠금(`7364223`, 단계 1~4). `pg_try_advisory_xact_lock`이라 다른 jest가 쥐고 있으면 기다리지 않고 건너뛴다. 같은 호출처 ID를 쓰는 다른 jest와 겹치면 그 회차의 점유·sweep이 비어 `waitFor` 시간 초과나 개수 불일치가 날 수 있다.
- database를 나눠도 PostgreSQL 서버는 하나다. 이벤트 피드는 `pg_snapshot_xmin(pg_current_snapshot()) > txid`인 행만 읽는다(`events/event-store.ts`). xmin은 서버 전체의 진행 중 트랜잭션에서 정해지므로 다른 database의 열린 트랜잭션이 이벤트를 잠시 가린다. 이벤트 피드·피드 지연 지표를 읽는 spec(`events.integration-spec.ts`, `metrics-reads`, `metrics-gauges` 등)이 동시 실행 중 이 이유로 실패할 수 있다.
  - 동시 실행 중 이런 spec이 실패하면 다른 jest가 끝난 뒤 그 spec만 L1로 다시 실행해 간섭인지 확인한다. 같은 소스 재실행이므로 `FORCE_RETEST=1`과 이유를 보고에 적는다.
  - 서버까지 나누려면(별도 컨테이너) 사용자 결정이 필요하다. 지금 규칙은 compose의 PostgreSQL 하나다.
- `scripts/test-db.sh`는 `mailo_test_` 접두사 database만 만들고 지운다. 개발 DB(`mailo`)는 건드리지 않는다.
- env 지문은 database 이름을 포함한다. database가 다른 실행의 결과를 재사용할 때는 같은 서버·같은 마이그레이션이라는 근거를 적는다("결과 재사용").
- 로드가 높을 때(여러 jest·build가 동시에 도는 상태) `waitFor` 시간 초과가 날 수 있다. 같은 소스에서 실패한 spec만 다시 돌려 통과해도 "부하 때문"이라는 근거는 아니다. 실패 로그의 첫 오류와 `uptime`을 함께 기록한다.

## 문서만 바꾼 경우

문서만 바꾸면 L0~L2를 실행하지 않는다. 다음을 실행한다.

- `git diff --check`
- 금지 표기 잔존 검사: `writing-styles.md` "검증"의 명령
- 옮기거나 지운 절·파일을 가리키던 링크와 참조를 `grep`으로 전수 확인한다.

테스트가 직접 읽는 파일을 바꾸면 해당 테스트를 실행한다. 문서가 아닌 파일도 포함한다.

| 바꾼 파일                                                                                          | 실행할 테스트                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docker-compose.yml`, `Dockerfile`, 루트 `package.json`                                            | `pnpm --filter @cp949/mailo test test/config/compose-consistency.spec.ts test/config/adapter-image.spec.ts`                                       |
| `.dockerignore`, `pnpm-workspace.yaml`, `adapters/secret-source-aws/`의 `Dockerfile`·`package.json`·`pnpm-workspace.yaml` | `pnpm --filter @cp949/mailo test test/config/adapter-image.spec.ts`                                                                |
| `.env.example`                                                                                     | `pnpm --filter @cp949/mailo test test/config/compose-consistency.spec.ts test/config/load-config.spec.ts test/secrets/secret-names.spec.ts`      |
| `docs/api/conformance/vectors.json`                                                                | `pnpm --filter @cp949/mailo test test/envelope/conformance-vectors.spec.ts`                                                                      |
| `apps/mailo/scripts/gen-dev-keys.mjs`                                                              | `pnpm --filter @cp949/mailo test test/envelope/dev-keys-script.spec.ts`                                                                          |
| `apps/mailo/migrations/*.sql`                                                                      | L2(마이그레이션을 적용하는 통합 spec 전체)                                                                                                       |
| `scripts/source-fingerprint.sh`                                                                    | `pnpm --filter @cp949/mailo test test/scripts/source-fingerprint.spec.ts`                                                                        |

- `turbo.json`에 `inputs`·`globalDependencies`가 없다. `apps/mailo` 밖의 파일(`.env.example`, `scripts/source-fingerprint.sh` 등)만 바뀌면 turbo `test` 해시가 그대로라 `pnpm test`가 캐시를 재생한다(`turbo run test --dry=json`으로 확인). 표의 명령은 `pnpm --filter`로 직접 실행한다.

## TDD

TDD의 RED→GREEN은 지금 구현하는 동작의 spec 하나로 한정한다. 사이클마다 L0·통합 테스트를 실행하지 않는다. 테스트 작성 여부와 TDD 적용 기준은 `testing.md`가 정한다.

## 소스·환경 지문

검증 결과를 다시 쓸 수 있는지는 두 지문으로 판단한다. 전역 훅의 지문은 HEAD를 포함한다. 이 지문은 HEAD를 포함하지 않아 커밋 뒤에도 같은 내용이면 같다.

- 내용 지문: `scripts/source-fingerprint.sh`가 출력하는 `source=<12자> files=<n>`이다. 추적 파일과 untracked 파일의 경로·내용으로 만든다. HEAD, 브랜치, 커밋 시각, 스테이징 여부는 입력이 아니다. `.gitignore` 대상(`node_modules/`, `dist/`, 작업 폴더 `_works/<작업>/`, `.env`)은 영향이 없다. 추적하는 `_works/README.md`와 템플릿은 입력이다.
- env 지문: `scripts/source-fingerprint.sh --env`가 출력하는 `env=<12자>`다. `node --version`, `pnpm --version`, 비밀번호를 지운 `MAILO_TEST_DATABASE_URL`만 입력으로 쓴다. URL의 userinfo는 마지막 `@`까지를 사용자 이름만 남기고, `password=` 쿼리 값은 지운다. 비밀번호는 입력에도 출력에도 넣지 않는다.
- 스크립트는 GNU coreutils(`comm -z`, `sort -z`, `sha256sum`)가 필요하다. 개발·CI 환경(Linux)을 기준으로 한다. 이 스크립트의 spec이 L0의 `pnpm test`에 들어가므로 macOS·BSD 기본 도구로는 L0가 실패한다.

두 지문이 모르는 입력이 있다.

- PostgreSQL 서버 버전·상태와 테스트 schema 외의 DB 상태
- Docker 데몬·이미지, NFS 서버, sudo 가능 여부
- `.env`, `.dev-keys/` 같은 ignore 파일의 값
- `MAILO_TEST_DATABASE_URL` 외의 환경 변수(`NODE_OPTIONS`, `MAILO_*`)
- `PATH`의 도구와 버전, 시각

turbo의 캐시 적중(`cache hit, replaying logs`)은 이전 실행 로그의 재생이다. 이번 실행의 증거가 아니다.

## 결과 재사용

이전 결과를 다시 쓸 수 있는 조건은 다음 셋을 모두 충족하는 것이다.

1. 내용 지문과 env 지문이 원 실행과 같다. 다르면 차이가 이 검증의 입력에 영향이 없다는 근거를 기록에 적어야 한다.
2. 원 실행이 새 실행이고 종료 코드가 0이다.
3. 원 실행의 범위가 지금 필요한 범위를 포함한다. 명령, 경로 패턴, 단계를 비교한다.

조건을 충족하면 다시 실행하지 않고 재사용한다. 다음은 재사용 여부의 근거가 아니다.

- 커밋, 리뷰, 세션, 담당 에이전트가 바뀐 것
- 커밋 SHA가 같거나 다른 것

재사용할 때는 원 실행의 기록을 인용한다. 기록에는 명령, 범위, 종료 코드, 통과·실패 수, 로그 경로, 두 지문이 들어 있다.

결과는 세 가지로 구분해 보고한다.

| 구분                 | 뜻                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------- |
| 새 실행              | 이번 소스·환경에서 대상 검증을 실제로 실행했다. turbo 캐시 재생은 새 실행이 아니다. |
| 재사용(원 실행 기록) | 위 조건을 충족해(지문이 달라 근거를 적은 경우 포함) 이전 새 실행의 결과를 인용했다. |
| 미실행               | 실행하지 않았다. 이유를 적는다.                                                     |

- 실패·중단한 실행을 새 실행의 성공으로 보고하지 않는다.
- 통합 테스트는 지문이 DB 서버 상태를 모른다. 재사용하려면 환경이 같다는 근거를 따로 적는다. 예: 같은 PostgreSQL 컨테이너를 쓰고 그 사이에 마이그레이션 파일이 바뀌지 않았다.
- 지문이 다른데 재사용하는 경우는 조건 1의 근거를 적는다. 예: 문서만 바뀌었고 그 검증이 문서를 읽지 않는다.
- 테스트가 읽는 파일은 지문이 달라지면 입력이 바뀐 것이다. "문서만 바꾼 경우"의 표에 있는 파일이 그렇다.
- 같은 명령을 소스 변경 없이 다시 실행해야 하면(환경 문제, 간헐 실패 확인) 이유를 기록에 적는다.

## 여러 에이전트

여러 에이전트가 한 작업에 참여하면 작업 폴더의 검증 기록(`verification-log.md`, 템플릿은 `_works/templates/verification-log.md`)으로 검증을 나눈다.

- 최종 검증 담당자를 한 명 지정한다. 기본은 구현자이고 계획서에서 달리 지정할 수 있다.
- 실행하기 전에 기록에 담당자, 상태(`실행 중`), 대상 범위(명령·경로 패턴), 시작 시각을 적는다.
- 다른 에이전트는 같거나 겹치는 검증을 동시에 실행하지 않는다. 같은 database를 쓰는 통합 테스트와 같은 Docker 자원을 쓰는 L3도 겹치는 검증이다. 통합 테스트는 에이전트마다 다른 database를 쓰면 겹치지 않는다("통합 테스트 동시 실행").
- 검증하는 동안 대상 입력(추적 파일과 untracked 파일)을 바꾸지 않는다.
- 검증이 끝나면 같은 행에 두 지문, 명령, 범위, 환경, 종료 코드, 통과·실패 수, 로그 경로를 적는다.
- 리뷰어와 다른 에이전트는 기록을 인용한다. 지문이 같으면 다시 실행하지 않는다.
- 구현자와 리뷰어가 같은 작업 트리를 쓰면 리뷰어는 입력 파일을 바꾸지 않는다. 리뷰 중에 구현자도 리뷰 대상 파일을 바꾸지 않는다.

## 증거 기록

- 계획에 변경 대상과 회귀 위험에 맞는 검증 명령과 기대 결과를 적는다. 선택은 "검증 범위 선택"을 따른다.
- workflow 선택을 이유로 기존 검증 의무를 낮추지 않는다.
- API 계약·스키마·인증·암호화·외부 연동 변경은 해당 계약을 확인하는 검증을 완료 조건에 넣는다. 큐 SQL·스키마 변경은 실제 PostgreSQL과 실패 시나리오를 포함한다.
- 소스나 검증 조건이 달라진 결과를 현재 변경의 증거로 제시하지 않는다. 이전 결과를 쓰려면 "결과 재사용"의 조건과 인용을 따른다.
- 실행 명령, 두 지문, 종료 코드, 통과·실패 수, 로그 위치를 기록한다. 기존 실패와 이번 변경으로 생긴 실패를 구분한다.
- 실행하지 않은 테스트·빌드·L3 검증은 `미실행`으로 기록한다. 전달받은 로그와 직접 실행한 결과도 구분한다.
- fake SMTP·단위 검증을 실제 Gmail·NAS·운영 검증으로 확대 해석하지 않는다.
- 구현에 필요한 문서 변경도 해당 실행 단위의 검증·리뷰·커밋 범위에 포함한다. 리뷰 뒤 변경이 생기면 영향받은 범위를 다시 검증하고 해당 workflow의 리뷰 규칙을 적용한다.
- 검증 수치를 저장소 문서에 남기는 자리는 `testing.md`의 "결과 기록"이 정한다.

## 커밋과 완료

- 실행 단위(DELTA) 커밋에는 그 단위의 대상 검증 결과가 있어야 한다. 통합 검증은 최종에 한 번 실행한다.
- 작업 완료와 `dev` 통합은 필요한 최종 검증을 마친 뒤에만 한다.
- 최종 검증은 구현 전체와 리뷰 지적 처리를 모은 뒤의 소스에 대한 것이어야 한다. 마지막 DELTA를 커밋하기 전에 실행해도 되고 커밋한 뒤 통합하기 전에 실행해도 된다.
