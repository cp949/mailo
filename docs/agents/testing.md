# 테스트와 검증

테스트를 쓰는 규칙과 검증 단계를 정한다. 중복 검증 금지(훅)와 보고 형식은 전역 지시를 따른다.

## 테스트 종류

| 종류           | 파일                                         | 실행                                                 | 환경                                |
| -------------- | -------------------------------------------- | ---------------------------------------------------- | ----------------------------------- |
| 단위           | `apps/mailo/test/**/*.spec.ts`               | `pnpm test`                                          | 없음                                |
| PostgreSQL 통합 | `*.integration-spec.ts`, e2e는 `test/e2e/`   | `pnpm test:integration`                              | PostgreSQL 13 이상, `--runInBand`   |
| NFS            | `test/nfs/*.nfs-spec.ts`                     | `apps/mailo/scripts/nfs/run.sh` 또는 `pnpm test:nfs` | 커널 NFS, 비밀번호 없는 sudo        |
| 컨테이너·볼륨  | `scripts/container/`, `scripts/volume/`      | 각 스크립트 직접 실행                                | Docker, 자동 테스트 아님            |
| 시크릿 소스    | `scripts/secrets-localstack/`                | `run.sh` 직접 실행(LocalStack 4.12, 가짜 값)         | Docker, 자동 테스트 아님            |
| 샘플 e2e       | `samples/spring-boot-relay/verify/run-e2e.sh` | 스크립트 직접 실행                                   | Docker, JDK 21, 자동 테스트 아님    |

SMTP는 `test/support/fake-smtp.ts`로 대체한다. 테스트와 검증 스크립트는 실제 Gmail·Workspace SMTP에 접속하지 않는다.

## 검증 단계

검증 방법은 작업 계획 단계에서 가장 싼 단계부터 고른다. 변경 묶음 끝에 1회 실행한다.

| 단계 | 수단                                                                                                          | 언제                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| L0   | `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`                                 | 소스·테스트를 바꾼 모든 변경. 문서만 바꾸면 L0을 생략하고 아래 문서 점검만 한다 |
| L1   | 변경 영역의 통합 spec만 실행: `pnpm --filter @cp949/mailo test:integration <경로 패턴>`                       | DB를 쓰는 영역(`queue`, `db`, `intake`, `worker`, `file-channel` 등)을 바꿨을 때 |
| L2   | `pnpm test:integration` 전체                                                                                  | 마무리 때 1회. 변경 묶음마다 돌리지 않는다                            |
| L3   | `scripts/container/`, `scripts/volume/`, `scripts/secrets-localstack/`, `apps/mailo/scripts/nfs/run.sh`, `samples/spring-boot-relay/verify/run-e2e.sh` | 아래 표의 영역을 실제로 바꿨을 때만                                   |

- L1·L2 전에 `.env.example`을 `.env`로 복사하고 `docker compose up -d postgres`를 실행한다. compose는 `POSTGRES_PASSWORD`가 없으면 중단한다.
- 서버가 없으면 통합 테스트는 skip하지 않고 실패한다. 이 실패는 코드 결함이 아니라 환경 문제다. PostgreSQL부터 확인한다.
- 소스가 같으면 재검증하지 않는다. 수정 뒤 재확인은 실패한 spec만 다시 돌린다.
- 실행하지 않은 단계는 보고에 "실행하지 않음"으로 적는다. NFS 서버가 없어 못 돌린 `test:nfs`처럼 환경 때문에 못 돌린 경우도 같다.

L3을 돌리는 변경:

| 바꾼 영역                                              | 돌릴 것                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `Dockerfile`, `docker-compose*.yml`, 종료 순서, drain  | `verify-sigterm-file.sh`, `verify-sigkill-duplicate.sh`                    |
| 파일 채널의 권한·원자 rename·마운트 가정               | `scripts/volume/`의 해당 스크립트(`acl`·`group` 모두)                      |
| NFS 관련 코드(`file-channel/errno.ts` 등), `nfs.md`    | `apps/mailo/scripts/nfs/run.sh`                                            |
| `samples/spring-boot-relay/`, 서명·봉투 형식(ADR-0008) | `samples/spring-boot-relay/verify/run-e2e.sh`                              |
| `secrets/`, `adapters/secret-source-aws/`, 변형 이미지, `X_REF` 기동 경로 | `scripts/secrets-localstack/run.sh`(LocalStack 최신 이미지는 Auth Token이 필요해 기본은 4.12 고정 이미지) |
| `.github/workflows/ci.yml`                             | `docs/operations/ci.md`의 로컬 재현 명령. GitHub 실행 결과가 없으면 없다고 적는다 |

## 테스트 작성 규칙

- 기능·버그 수정은 회귀 테스트를 먼저 쓰고 RED를 확인한 뒤 구현한다. RED 근거(실패 메시지 한 줄)를 보고에 남긴다.
- 기존 테스트를 지우거나 assertion을 약화해 통과시키지 않는다. 테스트가 틀렸다고 판단하면 변경안과 이유를 사용자에게 제시한다.
- `skip`·`only`를 커밋하지 않는다.
- 테스트 제목(`describe`/`it`)에 RQ·ADR을 참조한다. 예: `describe("재시도 대기 시간(RQ-008, ADR-0003 결정 5)")`. 제목 문체는 전역 지시를 따른다.
- 파일 접미사가 환경을 정한다. DB가 필요하면 `*.integration-spec.ts`로 쓰고, 단위 `*.spec.ts`에 DB 접속을 넣지 않는다.
- DB 테스트는 `test/support/database.ts`의 `createTestDatabase()`로 파일마다 전용 schema를 받고 `afterAll`에서 `close()`한다. 공용 schema를 쓰지 않는다.
- 시크릿 비노출(RQ-027)은 본문·비밀번호에 canary 문자열을 넣고 로그·오류·이벤트·거부 기록에서 검색해 검증한다. 예: `test/crypto/fingerprint.spec.ts`.
- 테스트가 만든 자원(임시 폴더, 서버, 풀, 타이머, 리스너)은 만든 쪽이 `finally`나 `afterAll`에서 정리한다. 정리 하나가 실패해도 나머지 정리를 막지 않는다.
- fixture·helper가 두 테스트 파일에서 필요해지면 `test/support/`로 올린다. 새 helper를 쓰기 전에 기존 `test/support/`를 확인한다.
- 무작위에 의존하는 순수 로직은 주입한 값으로 검증한다. 예: `RetryPolicy.random`. 큐 SQL의 시각은 DB `now()`만 쓴다(`AGENTS.md`).
- 성능 회귀는 실행 시간이 아니라 호출 횟수 같은 결정적 작업량으로 검증한다. 시간 상한은 심각한 붕괴 탐지에만 쓴다.
- 테스트 파일을 나누거나 옮길 때는 순수 이동으로 하고, 전후 테스트 제목 집합이 같음을 확인한다.

## 결과 기록

- 검증 수치(통과 수, 파일 수)는 `docs/requirements/mail-sending.md`의 "용어와 진행 상태" 판정 근거에만 적는다. 다른 문서에 개수를 새로 쓰지 않는다. `docs/operations/ci.md`의 기존 실측 기록은 예외다.
- `[x]` 체크는 코드와 자동 검증으로 확인한 항목에만 한다. L3 스크립트 결과는 자동 테스트가 아니므로 `[x]` 근거로 쓸 때 스크립트 이름과 실행일을 함께 적는다.
- 이슈 완료 댓글의 검증 범위는 `docs/agents/issue-tracker.md`의 종료 절차를 따른다.
