# CI (GitHub Actions)

`.github/workflows/ci.yml`이 정의한다. 2026-11-23에 작성했고 **GitHub에서 한 번도 실행하지 않았다.** 아래 "로컬 확인"은 워크플로의 각 명령을 같은 순서로 로컬에서 실행한 결과이고, GitHub 러너에서의 동작은 확인하지 않았다.

## 잡

| 잡 | 실행 내용 | 트리거 | 필수 여부 | 로컬 재현 |
| -- | --------- | ------ | --------- | --------- |
| `static` | `pnpm install --frozen-lockfile`, `format:check`, `typecheck`, `lint`, `build`, `test` | push(main), pull_request, 수동 | 필수 체크 후보 | `pnpm format:check && pnpm typecheck && pnpm lint && pnpm build && pnpm test` |
| `integration` | PostgreSQL 17 서비스 컨테이너(compose와 같은 `postgres:17-alpine`, healthcheck 대기) + `pnpm test:integration` | 위와 같음 | 필수 체크 후보 | `.env.example`을 `.env`로 복사한 뒤(compose는 `POSTGRES_PASSWORD`가 없으면 중단한다) `docker compose up -d postgres`, `pnpm test:integration` |
| `container` | `scripts/container/`(SIGKILL 중복 발송, SIGTERM 종료)와 `scripts/volume/` 7개 실행(acl·group) | 위와 같음 | 첫 GitHub 실행 성공을 본 뒤 결정 | 아래 "컨테이너 잡" |
| `nfs` | `apps/mailo/scripts/nfs/run.sh`(sudo로 NFS 서버·mount 구성 뒤 `pnpm test:nfs`) | 수동(`run_nfs=true`)과 주 1회 schedule만 | **선택. 필수 체크로 지정하지 않는다** | `apps/mailo/scripts/nfs/run.sh`(비밀번호 없는 sudo 필요) |

branch protection·필수 체크 지정은 이 저장소에서 하지 않았다. 지정은 저장소 설정에서 사람이 한다.

## 공통 설정

- Node 24.20.0(`Dockerfile`과 같은 값). `.nvmrc`는 없고 `engines`는 범위(`>=24.18`)라서 워크플로 `env.NODE_VERSION`에 고정했다. 올릴 때 `Dockerfile`·워크플로를 함께 바꾼다.
- pnpm 버전은 `package.json`의 `packageManager`를 따른다(`corepack enable`). `setup-node`의 `cache: pnpm`이 pnpm store만 캐시한다.
- 액션은 커밋 SHA로 고정했고 주석에 태그를 적었다: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `actions/upload-artifact` v7.0.2(2026-11-23 GitHub releases API로 확인).
- `docker-compose.yml`은 `POSTGRES_PASSWORD`에 기본값이 없다(비어 있으면 compose가 중단한다). 워크플로는 바꾸지 않았다. `integration`·`nfs` 잡은 compose가 아니라 서비스 컨테이너(고정 가짜 비밀번호)를 쓰고, `container` 잡은 `scripts/container/common.sh`가 `POSTGRES_PASSWORD`를 환경으로 준다. 새 잡에서 compose를 쓰면 이 변수를 준다.
- `permissions: contents: read`. 시크릿은 쓰지 않는다. DB 비밀번호 등은 테스트용 가짜 값이다.
- `concurrency`로 같은 ref의 이전 실행을 취소한다. main에 연달아 push하면 앞선 main 실행이 취소된다.

## 컨테이너 잡

- 필요 도구: Docker, `docker compose` v2.24 이상(override의 `!override`·`!reset`), `openssl`, `curl`. sudo는 필요 없다. 잡 첫 단계가 버전을 출력한다.
- 각 단계는 출력을 `ci-logs/`에 `tee`로 남기고, 실패하면 `container-logs` artifact(보존 14일)로 올린다. 앞 단계가 실패해도 나머지 단계는 실행한다.
- 로컬 재현: `scripts/container/verify-sigkill-duplicate.sh`, `scripts/container/verify-sigterm-file.sh`, `scripts/volume/verify-permissions.sh acl|group`, `verify-root-model.sh`, `verify-atomic-rename.sh acl|group`, `verify-e2e.sh acl|group`.
- `verify-sigkill-duplicate.sh`는 관찰만 기록한다. 중복 발송이 재현되지 않아도 종료 코드는 0이고 기동·등록 실패에서만 비정상 종료한다. 이 단계의 통과는 "스크립트가 끝까지 돌았다"는 뜻이다. 결과 줄(`결과: ...`)은 로그에서 읽는다.
- 고정 자원: compose 프로젝트 `mailo-verify`(포트 127.0.0.1:13000, 서브넷 172.29.89.0/24)와 `mailo-voltest-*`(서브넷 172.29.88.0/24). 러너에서 이 대역이 이미 쓰이면 기동에 실패한다(확인하지 않았다).

## NFS 잡

- GitHub 호스티드 러너에서 커널 NFS 서버(`nfs-kernel-server`, `nfsd` 모듈 적재, loopback mount)를 구성할 수 있는지는 실행해 보기 전에는 모른다. 확인한 적이 없다.
- 그래서 `continue-on-error: true`이고 push·pull_request에서는 돌지 않는다. 첫 실행 결과를 확인하기 전까지 필수 체크가 아니다. 실패해도 워크플로 전체는 실패로 표시되지 않는다.
- 설치(`MAILO_NFS_INSTALL=1`, `acl`)는 일회용 러너를 전제로 한다. `teardown.sh`는 설치를 되돌리지 않는다.
- 이 잡이 동작하면 `nfs.md`의 "CI 러너 미확인" 항목을 갱신한다.

## 로컬에서 확인한 범위 (2026-11-23)

| 항목 | 결과 |
| ---- | ---- |
| YAML 문법 | `python3 yaml.safe_load` 통과, `actionlint`(rhysd/actionlint 1.7.7 이미지) 오류 0건 |
| `static` 명령 | `format:check`·`typecheck`·`lint`·`build`·`test` 통과. 단위 407건 통과. turbo 캐시 적중 때문에 `typecheck`·`lint`·`test`는 이전 실행 결과의 재생이다 |
| `integration` 명령 | 로컬 PostgreSQL(`postgres:17-alpine`)로 `pnpm test:integration` 15개 파일 222건 통과 |
| `container` 스크립트 | 9개 모두 통과(관찰값은 아래) |
| `nfs` | 실행하지 않았다(이번 작업에서 NFS 환경을 만들지 않았다) |

컨테이너·볼륨 스크립트 관찰값(로컬 Docker 29.8.0, compose v5.5.1):

- SIGKILL: kill 직후 `SENDING`, 재기동 뒤 lease(45초) 만료 후 101초에 같은 `Message-ID`로 2통 수신, 최종 `SENT attempts=2`.
- SIGTERM(파일 1000개): 종료 코드 0, 0.4초, 폴러 중지 → Worker `drained true`. 종료 시점 DB 22건 = 처리한 파일 22건, 재기동 뒤 1000건 `SENT`, SMTP 1000통(유일 `Message-ID` 1000개).
- 볼륨: permissions acl 28/28, group 28/28, root-model 15/15, atomic-rename acl·group 4/4, e2e acl·group 15/15(기대와 다름 0).

## 확인하지 않은 것

- GitHub 러너에서의 모든 동작: Docker·compose 버전, 이미지 pull·빌드 시간, 서브넷 충돌, `timeout-minutes` 적정성, 서비스 컨테이너 포트 매핑.
- `actions/*` 세 액션의 이 워크플로 입력(`cache: pnpm`, `persist-credentials`, `if-no-files-found`, `retention-days`)은 `actionlint`가 문법을 통과시켰을 뿐 실행하지 않았다.
- `schedule`은 기본 브랜치에서만 돈다. 저장소가 비활성이면 GitHub가 schedule을 멈출 수 있다.
