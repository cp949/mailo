# CI (GitHub Actions)

`.github/workflows/ci.yml`이 정의한다. 2026-11-23에 작성했다. 같은 날 수동 실행 1회(run 45119061025, `run_nfs=true`, 커밋 `9c31318`)에서 `static`·`integration`·`container` 잡은 성공했고 `nfs` 잡은 취소됐다(아래 "NFS 잡"). 아래 "로컬 확인"은 워크플로의 각 명령을 같은 순서로 로컬에서 실행한 결과다. **`nfs` 잡은 GitHub 러너에서 통과를 확인하지 못했다.**

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

- 첫 실행 결과(2026-11-23, run 45119061025, 수동 `run_nfs=true`): 환경 준비는 성공했다. `nfs-kernel-server` 설치, nfsd 기동, export, mount 3개가 되어 `준비 완료: export=/srv/mailo-nfs-test/export mounts=.../{w,m1,m2} mailoUid=1001`까지 출력했다. 테스트 실행에서 실패했고, 잡이 30분 timeout까지 끝나지 않아 05:38에 시작한 잡이 06:08에 취소됐다. 같은 run의 `static`·`integration`·`container` 잡은 성공했다.
- 원인(로그와 로컬 재현으로 확인): 테스트가 호출처 UID(2001)로 `sudo setpriv ... node test/nfs/caller-client.mjs`를 띄우는데, 러너의 저장소 경로 `/home/runner/work/mailo/mailo/...`에 호출처 UID가 통과할 수 없어 Node가 `Error: Cannot find module '/home/runner/work/mailo/mailo/apps/mailo/test/nfs/caller-client.mjs'`(`code: 'MODULE_NOT_FOUND'`)로 종료했다. 로그에 이 오류가 10번 나온다. 로컬에서 통과를 막는 폴더(0750)에 복사한 같은 파일을 UID 2001로 실행하면 같은 오류가 재현된다. 러너의 `/home/runner` 권한(Ubuntu 기본 0750으로 추정)은 로그에 없어 확인하지 못했다.
- 매달린 원인(코드로 확인): `CallerClient.call()`은 응답 대기열에 넣고 응답을 기다리기만 했다. 자식 프로세스가 종료돼도 대기 중인 호출을 끝내지 않아 각 테스트가 jest `testTimeout`(180초)까지 기다렸다. 로그의 오류 간격이 약 3분이다. 호출처 클라이언트를 쓰지 않는 측정 테스트는 진행해 `[nfs-measure]` 줄이 06:01에 출력됐다(그 테스트의 통과 여부는 취소된 로그에 없다).
- 수정(2026-11-23): (1) `test/nfs/support.ts`가 `caller-client.mjs`를 `/tmp`의 임시 폴더(0755, 파일 0644)로 복사해 그 사본을 다른 UID로 실행한다(저장소 경로 권한은 바꾸지 않는다). (2) `CallerClient`가 자식 종료·기동 오류 때 대기 중인 호출을 즉시 실패시키고, 명령당 30초(`MAILO_NFS_CALL_TIMEOUT_MS`) 안에 응답이 없으면 클라이언트를 강제 종료하고 실패시킨다. (3) `run.sh`가 `pnpm test:nfs`를 `timeout`으로 감싼다(`MAILO_NFS_RUN_TIMEOUT`, 기본 1200초, 초과 시 종료 코드 124, teardown은 실행). (4) 워크플로의 실행 단계에 `timeout-minutes: 25`를 두었다. 시간 상한은 run.sh 20분 < 단계 25분 < 잡 30분이다.
- 수정 뒤 재실행 전이다. **`nfs` 잡이 GitHub 러너에서 통과하는지는 여전히 확인하지 못했다.** 사본 경로로 바꾼 뒤 다른 uid·NFS 동작이 로컬과 같은지, 러너에서 나머지 테스트가 통과하는지는 재실행해야 안다. 로컬(WSL2)에서는 `nfs-kernel-server`가 없어 NFS 자체를 돌리지 못했고, NFS 없이 `CallerClient`만 UID 2001로 확인했다.
- 그래서 `continue-on-error: true`이고 push·pull_request에서는 돌지 않는다. 첫 실행 결과를 확인하기 전까지 필수 체크가 아니다. 실패해도 워크플로 전체는 실패로 표시되지 않는다.
- 설치(`MAILO_NFS_INSTALL=1`, `acl`)는 일회용 러너를 전제로 한다. `teardown.sh`는 설치를 되돌리지 않는다.
- 이 잡이 러너에서 통과하면 `nfs.md`의 "CI 러너 미확인" 항목을 갱신한다.

## 로컬에서 확인한 범위 (2026-11-23)

| 항목 | 결과 |
| ---- | ---- |
| YAML 문법 | `python3 yaml.safe_load` 통과, `actionlint`(rhysd/actionlint 1.7.7 이미지) 오류 0건 |
| `static` 명령 | `format:check`·`typecheck`·`lint`·`build`·`test` 통과. 단위 407건 통과. turbo 캐시 적중 때문에 `typecheck`·`lint`·`test`는 이전 실행 결과의 재생이다 |
| `integration` 명령 | 로컬 PostgreSQL(`postgres:17-alpine`)로 `pnpm test:integration` 15개 파일 222건 통과 |
| `container` 스크립트 | 9개 모두 통과(관찰값은 아래) |
| `nfs` | 작성 시에는 실행하지 않았다. 첫 GitHub 실행은 위 "NFS 잡"에 적었다. 수정 뒤 로컬에서는 NFS 없이 `CallerClient`의 사본 실행·종료 감지·응답 timeout·`run.sh` timeout만 확인했다 |

컨테이너·볼륨 스크립트 관찰값(로컬 Docker 29.8.0, compose v5.5.1):

- SIGKILL: kill 직후 `SENDING`, 재기동 뒤 lease(45초) 만료 후 101초에 같은 `Message-ID`로 2통 수신, 최종 `SENT attempts=2`.
- SIGTERM(파일 1000개): 종료 코드 0, 0.4초, 폴러 중지 → Worker `drained true`. 종료 시점 DB 22건 = 처리한 파일 22건, 재기동 뒤 1000건 `SENT`, SMTP 1000통(유일 `Message-ID` 1000개).
- 볼륨: permissions acl 28/28, group 28/28, root-model 15/15, atomic-rename acl·group 4/4, e2e acl·group 15/15(기대와 다름 0).

## 확인하지 않은 것

- GitHub 러너에서의 모든 동작: Docker·compose 버전, 이미지 pull·빌드 시간, 서브넷 충돌, `timeout-minutes` 적정성, 서비스 컨테이너 포트 매핑.
- `actions/*` 세 액션의 이 워크플로 입력(`cache: pnpm`, `persist-credentials`, `if-no-files-found`, `retention-days`)은 `actionlint`가 문법을 통과시켰을 뿐 실행하지 않았다.
- `schedule`은 기본 브랜치에서만 돈다. 저장소가 비활성이면 GitHub가 schedule을 멈출 수 있다.
