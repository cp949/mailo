# CI (GitHub Actions)

`.github/workflows/ci.yml`이 CI를, `.github/workflows/release.yml`이 태그 발행을 정의한다("릴리스 워크플로"). AWS 어댑터와 변형 이미지는 `ci.yml`의 `adapter` 잡("어댑터 잡")과 `release.yml`의 `variants` 잡("variants 잡")이 맡는다. 아래 "로컬 확인"은 워크플로의 각 명령을 같은 순서로 로컬에서 실행한 결과다.

GitHub 실행 기록(2026-11-23, `gh run view`로 확인):

| run | 브랜치·커밋 | 트리거 | 결과 |
| --- | ----------- | ------ | ---- |
| 45106405209 | main `1f2326b` | push | `static`·`container` 성공, `integration` 실패(원인은 이 문서에 기록하지 않았다), `nfs` 건너뜀 |
| 45118335600 | main `9c31318` | push | `static`·`integration`·`container` 성공, `nfs` 건너뜀 |
| 45119061025 | main `9c31318` | 수동(`run_nfs=true`) | `static`·`integration`·`container` 성공, `nfs` 취소(아래 "NFS 잡") |
| 45126208202 | dev `addecd0` | 수동(`run_nfs=true`) | `static`·`integration`·`container` 성공, `nfs` 실패(31건 중 3건) |
| 45127889424 | dev `c75052a` | 수동(`run_nfs=true`) | 네 잡 모두 성공 |
| 45152251322 | dev `dee5d49` | 수동 | `static`·`integration`·`container` 성공, `nfs` 건너뜀 |
| 45182590945 | dev `365a9d4` | 수동 | `static`·`integration`·`container` 성공, `nfs` 건너뜀 |
| 45185115879 | dev `ab7d879` | 수동 | `static`·`integration`·`container` 성공, `nfs` 건너뜀 |

schedule 트리거 실행 기록은 없다(2026-11-23 `gh run list` 기준). schedule은 기본 브랜치 main의 워크플로로만 돈다.

## 잡

| 잡 | 실행 내용 | 트리거 | 필수 여부 | 로컬 재현 |
| -- | --------- | ------ | --------- | --------- |
| `static` | `pnpm install --frozen-lockfile`, `format:check`, `typecheck`, `lint`, `build`, `test` | push(main), pull_request, 수동 | 필수 체크 후보 | `pnpm format:check && pnpm typecheck && pnpm lint && pnpm build && pnpm test` |
| `integration` | PostgreSQL 17 서비스 컨테이너(compose와 같은 `postgres:17-alpine`, healthcheck 대기) + `pnpm test:integration` | 위와 같음 | 필수 체크 후보 | `.env.example`을 `.env`로 복사한 뒤(compose는 `POSTGRES_PASSWORD`가 없으면 중단한다) `docker compose up -d postgres`, `pnpm test:integration` |
| `container` | `scripts/container/`(SIGKILL 중복 발송, SIGTERM 종료)와 `scripts/volume/` 7개 실행(acl·group) | 위와 같음 | 첫 GitHub 실행 성공을 본 뒤 결정 | 아래 "컨테이너 잡" |
| `adapter` | `adapters/secret-source-aws` 단위 테스트, 기본 이미지 로컬 빌드와 어댑터·SDK 부재 확인, 변형 이미지 로컬 빌드와 스모크(발행 없음). "어댑터 잡" | 위와 같음 | 첫 GitHub 실행 성공을 본 뒤 결정 | 아래 "어댑터 잡" |
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

## 어댑터 잡

`ci.yml`의 `adapter` 잡(ADR-0016 결정 4·9, RQ-080). 발행하지 않는다. 어댑터 `adapters/secret-source-aws/`는 pnpm 워크스페이스·turbo·루트 lockfile 밖이라 `static`·`integration` 잡과 루트 `pnpm` 명령은 어댑터를 건드리지 않는다. 어댑터 파일은 루트 `pnpm format:check`의 대상이다.

1. `corepack enable`, `setup-node`(`NODE_VERSION`). pnpm 버전은 어댑터 `package.json`의 `packageManager`(루트와 같은 sha512 고정값)를 따른다.
2. `pnpm install --frozen-lockfile`, `pnpm test`(`node --test`, 가짜 SDK 클라이언트와 로컬 HTTP fixture를 거치는 실제 SDK).
3. 루트 `Dockerfile`로 기본 이미지를 로컬 빌드한다(`mailo:adapter-base`).
4. `image-smoke/verify-base.sh`: 기본 이미지 파일시스템에 `@aws-sdk`, `@smithy`, 어댑터 이름의 경로가 없음을 확인한다(RQ-029 수용 조건).
5. 변형 이미지를 로컬 빌드한다: `docker build --build-arg MAILO_BASE_IMAGE=mailo:adapter-base adapters/secret-source-aws`.
6. `image-smoke/run.sh`: 변형 이미지를 `read_only`·`--tmpfs /tmp`·`cap_drop: [ALL]`·`no-new-privileges`·`--network none`으로 실행한다. `uid=1000(node)`, 어댑터 링크, `/repo`·`/opt/mailo-secret-source-aws`가 root 소유이고 누구도 쓸 수 없음을 확인한 뒤 `smoke.mjs`를 이미지 안에서 실행한다. `smoke.mjs`는 컨테이너 안 `127.0.0.1`의 가짜 Secrets Manager를 `AWS_ENDPOINT_URL_SECRETS_MANAGER`로 가리키고 `MAILO_SECRET_ADAPTERS=@cp949/mailo-secret-source-aws`로 `resolveSecrets`를 부른다. 평문 값, JSON 키 선택, 없는 비밀·키, `AccessDenied`·`Throttling`·서버 오류의 닫힌 코드, 다른 이름 어댑터의 `not-found` 로드 오류를 확인하고 출력에 시험 값(`SMOKE-SENTINEL`)이 있으면 실패한다. 60초 안에 프로세스가 끝나지 않으면(어댑터가 핸들을 남김) 실패한다.

로컬 재현(Docker 필요):

```sh
(cd adapters/secret-source-aws && pnpm install --frozen-lockfile && pnpm test)
docker build -t mailo:adapter-base .
adapters/secret-source-aws/image-smoke/verify-base.sh mailo:adapter-base
docker build --build-arg MAILO_BASE_IMAGE=mailo:adapter-base -t mailo:adapter-aws adapters/secret-source-aws
adapters/secret-source-aws/image-smoke/run.sh mailo:adapter-aws
```

- 한계: 이미지 스모크는 `--network none`이라 실제 DNS·TLS 경로를 거치지 않는다. 자격 증명은 환경 변수(가짜 값)다. 실제 AWS는 확인하지 않는다.
- base 이미지의 Node digest는 루트 `Dockerfile`과 `adapters/secret-source-aws/Dockerfile`이 같아야 한다. `apps/mailo/test/config/adapter-image.spec.ts`가 일치를 검사한다.
- 빌드 경고 `InvalidDefaultArgInFrom`(`MAILO_BASE_IMAGE`에 기본값이 없음)이 나온다. 기본값을 두지 않는 것이 의도다(지정하지 않으면 빌드가 실패한다).

## NFS 잡

- 첫 실행 결과(2026-11-23, run 45119061025, 수동 `run_nfs=true`): 환경 준비는 성공했다. `nfs-kernel-server` 설치, nfsd 기동, export, mount 3개가 되어 `준비 완료: export=/srv/mailo-nfs-test/export mounts=.../{w,m1,m2} mailoUid=1001`까지 출력했다. 테스트 실행에서 실패했고, 잡이 30분 timeout까지 끝나지 않아 05:38에 시작한 잡이 06:08에 취소됐다. 같은 run의 `static`·`integration`·`container` 잡은 성공했다.
- 원인(로그와 로컬 재현으로 확인): 테스트가 호출처 UID(2001)로 `sudo setpriv ... node test/nfs/caller-client.mjs`를 띄우는데, 러너의 저장소 경로 `/home/runner/work/mailo/mailo/...`에 호출처 UID가 통과할 수 없어 Node가 `Error: Cannot find module '/home/runner/work/mailo/mailo/apps/mailo/test/nfs/caller-client.mjs'`(`code: 'MODULE_NOT_FOUND'`)로 종료했다. 로그에 이 오류가 10번 나온다. 로컬에서 통과를 막는 폴더(0750)에 복사한 같은 파일을 UID 2001로 실행하면 같은 오류가 재현된다. 러너의 `/home/runner` 권한(Ubuntu 기본 0750으로 추정)은 로그에 없어 확인하지 못했다.
- 매달린 원인(코드로 확인): `CallerClient.call()`은 응답 대기열에 넣고 응답을 기다리기만 했다. 자식 프로세스가 종료돼도 대기 중인 호출을 끝내지 않아 각 테스트가 jest `testTimeout`(180초)까지 기다렸다. 로그의 오류 간격이 약 3분이다. 호출처 클라이언트를 쓰지 않는 측정 테스트는 진행해 `[nfs-measure]` 줄이 06:01에 출력됐다(그 테스트의 통과 여부는 취소된 로그에 없다).
- 수정(2026-11-23): (1) `test/nfs/support.ts`가 `caller-client.mjs`를 `/tmp`의 임시 폴더(0755, 파일 0644)로 복사해 그 사본을 다른 UID로 실행한다(저장소 경로 권한은 바꾸지 않는다). (2) `CallerClient`가 자식 종료·기동 오류 때 대기 중인 호출을 즉시 실패시키고, 명령당 30초(`MAILO_NFS_CALL_TIMEOUT_MS`) 안에 응답이 없으면 클라이언트를 강제 종료하고 실패시킨다. (3) `run.sh`가 `pnpm test:nfs`를 `timeout`으로 감싼다(`MAILO_NFS_RUN_TIMEOUT`, 기본 1200초, 초과 시 종료 코드 124, teardown은 실행). (4) 워크플로의 실행 단계에 `timeout-minutes: 25`를 두었다. 시간 상한은 run.sh 20분 < 단계 25분 < 잡 30분이다.
- 로컬(WSL2)에서는 수정 직후 `nfs-kernel-server`가 없어 NFS 자체를 돌리지 못하고 NFS 없이 `CallerClient`만 UID 2001로 확인했다. 이후 같은 날 사용자 승인으로 `nfs-kernel-server` 2.6.1을 설치하고 수정한 소스(브랜치 `fix/ci-nfs`)로 `apps/mailo/scripts/nfs/run.sh`를 실행했다: 종료 코드 0, Test Suites 1 passed, Tests 31 passed(기본 NFSv4.1 클라이언트 1회). 로컬 통과이고 GitHub 러너 통과가 아니다.
- 이 잡은 `continue-on-error: true`이고 push·pull_request에서는 돌지 않는다. 첫 실행 결과를 확인하기 전까지 필수 체크가 아니다. 실패해도 워크플로 전체는 실패로 표시되지 않는다.
- 두 번째 실행 결과(2026-11-23, run 45126208202, dev, 수동 `run_nfs=true`): 이 잡이 처음으로 테스트까지 끝까지 실행됐다(06:45 시작, 46.6초). Tests 31개 중 28 통과, 3 실패. 러너: ubuntu-24.04(이미지 20261116.133.1), `nfs-kernel-server` 2.6.4-3ubuntu5.1, `mailoUid=1001`. 로컬은 2.6.1, `mailoUid=1000`이다.
  - 실패 1·2: "나중에 만든 호출처 폴더는 mount 옵션 ''에서 90000 ms 안에 보인다"(30468 ms 경과)와 "…'acdirmin=3,acdirmax=3'에서 12000 ms 안에 보인다"(3291 ms 경과). 오류는 `EACCES: permission denied, lstat '/srv/mailo-nfs-test/mnt/m1/inbox'`(`dir-check.ts` `inspectDir`, 폴링마다 하는 링크 검사)다. 경과 시간이 mount 옵션의 디렉터리 속성 캐시 만료(기본 30초, `acdirmin=3`)와 같아 캐시 만료 시점의 revalidate에서 났다고 추정한다. `lookupcache=pos` 케이스와 기존 폴더 케이스(캐시가 만료되기 전에 끝남)는 통과했다. **EACCES의 원인은 확정하지 못했다.** 로컬에서 Mailo UID 1001로 환경을 만들고(`MAILO_NFS_MAILO_UID=1001 scripts/nfs/setup.sh`) UID 1001로 `acdirmin=3` mount를 1초마다 `lstat`했을 때 재현되지 않았다. 추정 원인은 러너 커널·nfs-utils 차이이며 확인하지 못했다. 로컬 통과는 1000으로 돌린 것이라 UID 차이로 설명되지도 않는다.
  - 실패 3: "다른 클라이언트가 지운 파일에서 ESTALE이 나도 readInboxFile은 던지지 않고 gone으로 돌려준다". `ESTALE 표본 0/40`(`readInboxFile` 결과 `{"gone":40}`, 던진 오류 없음)이라 `probeStale > 0` 단언이 실패했다. 이 러너에서는 ESTALE이 재현되지 않았다(로컬은 5~50%). 코드 결함이 아니라 재현 조건의 차이로 보지만, 러너에서 ESTALE 경로가 동작하는지는 확인하지 못했다.
  - 수정(2026-11-23, ADR-0004 구현 중 확정 37·38): (1) `inspectDir`가 `EACCES`·`EPERM`이면 던지지 않고 `why: ACCESS`로 돌려주고, 폴러는 그 폴링의 해당 디렉터리를 건너뛰며 `file_dir_unsafe`를 한 번 남긴다. (2) ESTALE 표본이 0이면 실패시키지 않고 `[nfs-measure] ESTALE 재현 못 함 ... 검증되지 않았다`를 남긴다. ESTALE 분류는 단위 테스트(`errno.spec.ts`, `read-file.spec.ts`)가 확인한다. (3) 새 폴더 테스트가 오류 폴링 수와 `ACCESS` 경고 수를 `[nfs-measure]`로 남긴다.
  - 로컬(WSL2, UID 1000)에서는 수정 뒤 `run.sh` 31건이 모두 통과했다(오류 폴링 0, ACCESS 경고 0, ESTALE 표본 6/40).
- 세 번째 실행 결과(2026-11-23, run 45127889424, dev `c75052a`, 수동 `run_nfs=true`): `nfs` 잡이 GitHub 러너에서 처음 통과했다. 잡 1분 38초(06:59:35~07:01:13), Test Suites 1 passed, Tests 31 passed. 러너 이미지 ubuntu-24.04 20261116.133.1, `nfs-kernel-server` 2.6.4-3ubuntu5.1, `mailoUid=1001`. 범위는 같은 러너 안의 loopback NFS뿐이다.
  - 새 폴더 테스트의 `[nfs-measure]`: 옵션 `''`은 30474 ms, `acdirmin=3,acdirmax=3`은 3273 ms에 보였고 둘 다 오류 폴링 0, ACCESS 경고 1이다. `lookupcache=pos`는 4 ms, ACCESS 경고 0이다. 러너에서 `ACCESS`(`EACCES`·`EPERM`)가 다시 났고 (1)의 건너뛰기로 테스트가 통과했다. 원인은 여전히 확정하지 못했다.
  - ESTALE 테스트의 `[nfs-measure]`: `ESTALE 표본 0/40`, `ESTALE 재현 못 함`. (2)로 통과했고 러너에서 ESTALE 경로는 검증되지 않았다.
- 설치(`MAILO_NFS_INSTALL=1`, `acl`)는 일회용 러너를 전제로 한다. `teardown.sh`는 설치를 되돌리지 않는다.
- 러너 통과는 위 세 번째 실행 1회다. schedule 실행은 아직 없다. 필수 체크 지정 여부는 따로 정한다.

## 릴리스 워크플로

`.github/workflows/release.yml`. `vX.Y.Z` 태그 push 때 이미지를 `ghcr.io/cp949/mailo`에 발행하고 GitHub Release를 만든다. `v0.1.0` 태그(run 45189361321, 커밋 `771f083`, 2026-11-23)로 1회 실행해 성공했다("확인하지 않은 것").

| 항목 | 내용 |
| ---- | ---- |
| 트리거 | `push: tags: ["v[0-9]+.[0-9]+.[0-9]+"]`만. 수동 실행은 없다 |
| 동시 실행 | `release-<ref>` 그룹으로 같은 태그를 직렬화한다. `cancel-in-progress: false`라 진행 중 발행을 취소하지 않는다 |
| 권한 | 최상위 `contents: read`. `release` 잡만 `contents: write`(Release 생성, 릴리스 노트 생성 API)와 `packages: write`(GHCR push). `variants` 잡은 `contents: read`와 `packages: write`(GHCR push)뿐이다. `verify` 잡은 읽기 권한으로 의존성 설치·검사를 돌린다 |
| 시크릿 | `GITHUB_TOKEN`만 쓴다 |
| 이미지 태그 | `ghcr.io/cp949/mailo:vX.Y.Z`, `ghcr.io/cp949/mailo:latest`. `linux/amd64`만. AWS 어댑터 변형은 `ghcr.io/cp949/mailo:vX.Y.Z-aws`(이동 태그 없음) |
| 라벨 | `org.opencontainers.image.revision`(태그 커밋), `version`(태그), `created`(빌드 시각 UTC), `source`(저장소 URL) |

`verify` 잡(가드와 검사):

1. 태그 커밋이 `origin/main`의 조상이 아니면 실패한다(`git merge-base --is-ancestor`).
2. 태그 버전(`v` 제외)이 루트 `package.json`과 `apps/mailo/package.json`의 `version`과 모두 같지 않으면 실패한다.
3. `ci.yml`의 `static` 잡과 같은 Node·pnpm 설정으로 `pnpm install --frozen-lockfile`, `format:check`, `typecheck`, `lint`, `build`, `test`를 돌린다.

- 통합·컨테이너·NFS 검사는 돌리지 않는다. 태그 커밋은 가드 1로 main의 조상이고, main push마다 `ci.yml`이 `integration`·`container` 잡을 돌린다.
- 이 판단은 main push의 CI가 성공했다는 것을 확인하지 않는다. 태그를 달기 전에 그 커밋의 main CI 결과를 사람이 확인한다("릴리스 절차").

`release` 잡(`verify` 성공 뒤). 스모크를 통과한 이미지만 GHCR에 올린다:

1. 빌드: `docker/build-push-action`을 `load: true`, `push: false`, `provenance: false`로 호출해 `linux/amd64` 이미지를 러너의 docker에 `ghcr.io/cp949/mailo:vX.Y.Z` 태그로 넣는다. SBOM은 만들지 않는다.
2. 스모크: 1의 로컬 이미지를 `--pull never`로 실행한다. compose와 같은 보안 옵션(`--read-only`, `--cap-drop ALL`, `no-new-privileges`)을 쓰고 다음을 확인한다. DB가 필요한 확인은 하지 않는다. 실패하면 GHCR에는 아무것도 올라가지 않는다.
   - `revision` 라벨이 태그 커밋과 같다.
   - `id`가 `uid=1000(node) gid=1000(node)`로 시작한다.
   - `node --version`이 `NODE_VERSION`과 같다.
   - `dist/main.js`, `dist/db/migrate-cli.js`, `migrations/*.sql`이 있다. `/repo/apps/mailo/dist`·`/repo/node_modules`에 쓸 수 없다. `npm`이 없다.
   - 설정 없이 기본 `CMD`로 기동하면 종료 코드 1과 `startup_failed` 로그로 끝난다. `main.ts`가 모든 모듈을 import한 뒤 설정 검증에서 끝나므로 운영 의존성 누락을 잡는다.
3. push: 다시 빌드하지 않고 스모크한 로컬 이미지를 `docker push`로 올린다. 순서는 다음과 같다.
   1. 스모크한 이미지의 config digest를 `docker save`의 `manifest.json`에서 읽는다. 이 방법은 docker 이미지 저장소 종류(classic·containerd)와 무관하다. containerd 저장소에서는 `docker image inspect`의 `Id`가 config digest가 아니라 manifest digest다(로컬 Docker 29.8.0에서 확인).
   2. `vX.Y.Z`를 push한다.
   3. `docker buildx imagetools inspect --raw`로 GHCR에 올라간 `vX.Y.Z`의 `linux/amd64` config digest를 읽어 1과 비교한다. 다르면 실패하고 `latest`는 붙이지 않는다.
   4. 같은 이미지에 `latest`를 붙여 push하고, `latest`의 manifest digest가 `vX.Y.Z`와 같은지 확인한다.
4. GitHub Release를 만든다. 노트는 `releases/generate-notes` API로 생성한 본문 끝에 pull 명령, digest, 마이그레이션 안내(`deployment.md` "기동 순서와 마이그레이션" 링크)를 덧붙인다.
   - `gh release create --generate-notes`에 `--notes`·`--notes-file`을 함께 주면 그 내용이 생성 노트 앞에 붙는다(gh 2.100.0 `--help`). 안내를 끝에 두려고 API로 생성한 뒤 `--notes-file`로 만든다.
   - 같은 태그의 Release가 이미 있으면 만들지 않고 `::notice::`만 남긴다(재실행 대비).

### variants 잡

`release` 잡 뒤(`needs: release`)에 도는 별도 잡이다. `release` 잡이 push한 기준 이미지의 manifest digest(`outputs.digest`)와 태그·커밋(`outputs.tag`, `outputs.commit`)을 받아 같은 릴리스 커밋의 기준 이미지 위에 어댑터만 얹는다(ADR-0016 결정 4, RQ-080). 스모크를 통과한 이미지만 push한다.

1. 어댑터 `pnpm install --frozen-lockfile`과 `pnpm test`. 실패하면 이미지를 만들지 않는다.
2. GHCR 로그인. `docker/setup-buildx-action`은 쓰지 않는다. docker-container 드라이버가 기본 빌더가 되면 `docker build`가 이미지를 로컬 docker에 싣지 않는다. `docker buildx imagetools`는 러너의 buildx 플러그인으로 동작한다(로컬 확인은 기본 드라이버, setup 없음).
3. 기준 이미지를 `ghcr.io/cp949/mailo@<digest>`로 pull한다(태그를 쓰지 않는다). `revision` 라벨이 태그 커밋과 같은지 확인하고 `verify-base.sh`로 발행된 기준 이미지에 어댑터·SDK가 없음을 확인한다.
4. 변형 빌드: `docker build --build-arg MAILO_BASE_IMAGE=ghcr.io/cp949/mailo@<digest> --tag ghcr.io/cp949/mailo:vX.Y.Z-aws adapters/secret-source-aws`. 라벨(`revision`·`version`·`created`)은 기준 이미지에서 이어받는다.
5. 변형 스모크: 변형의 `revision` 라벨이 태그 커밋과 같은지 확인하고 `image-smoke/run.sh`를 돌린다("어댑터 잡"의 6과 같다).
6. push와 확인: `release` 잡과 같은 방법(`docker save`의 config digest와 GHCR의 `linux/amd64` config digest 비교)으로 같은 이미지가 올라갔는지 확인한다. manifest digest는 잡 요약(`$GITHUB_STEP_SUMMARY`)에 남긴다. `latest-aws` 같은 이동 태그는 만들지 않는다.

- 실패해도 기준 이미지와 GitHub Release는 이미 발행된 상태다. 릴리스 노트의 "변형 이미지" 절이 이 사실을 알린다.
- Release 노트에는 변형의 digest를 쓰지 않는다. `variants` 잡이 저장소에 쓰지 않도록(`contents: read`) Release를 고치지 않기 때문이다. digest는 잡 요약에서 본다.

```txt
위험도: 중간 (GHCR에 새 태그를 발행하는 경로가 하나 늘어난다. 변형이 AWS SDK와 그 취약점을 포함한다. 저장소 쓰기 권한은 없다)
롤백: release.yml 변경은 커밋을 되돌린다. 이미 발행된 vX.Y.Z-aws 태그는 GHCR에 남는다. 기본 이미지와 Release는 영향이 없다. 태그 삭제는 사용자가 GHCR 패키지 설정에서 정한다(이미 pull한 사용자와 어긋난다)
```

| 실패 위치 | 상태 | 조치 |
| --------- | ---- | ---- |
| 어댑터 단위 테스트, 기준 이미지 pull·부재 확인, 변형 빌드, 스모크 | `-aws` 태그가 GHCR에 없다. 기준 이미지·Release는 있다 | 일시 실패면 "Re-run failed jobs"(`variants`만 다시 돈다. 같은 기준 digest를 쓴다). 어댑터·이미지 결함이면 main에서 고친 뒤 다음 패치 버전으로 태그를 단다. 같은 태그를 옮기지 않는다 |
| push의 config 비교 | `-aws` 태그가 GHCR에 있을 수 있다(불일치면 있다) | 로그를 본 뒤 "Re-run failed jobs". 재실행은 다시 빌드하므로 태그가 새 이미지로 덮인다 |

동일성 기준과 provenance:

- 스모크한 이미지와 발행한 이미지는 config digest로 같다고 판정한다. config에 레이어 `diff_ids`(압축 전 레이어 digest)와 라벨이 들어 있다.
- manifest digest는 기준으로 쓰지 않는다. `docker push`가 레이어를 다시 압축하고 manifest를 새로 만들기 때문이다. 릴리스 노트의 digest는 GHCR에 올라간 `vX.Y.Z`의 manifest digest다.
- 같은 `build-push-action`을 `push: true`로 다시 호출하는 방식은 쓰지 않는다. 두 번째 빌드의 config가 첫 빌드와 바이트 단위로 같다는 보장을 찾지 못했다. 그 방식은 push 뒤에야 불일치를 알 수 있어 태그가 이미 발행된다.
- provenance attestation은 붙이지 않는다. `docker push`는 로컬 이미지 하나만 올리고 attestation을 싣지 못한다. `provenance: false`는 빌드 결과를 단일 manifest로 고정하려고 명시한다. `load: true`이면 v7.4.0은 기본 provenance를 붙이지 않는다(`src/context.ts` `getAttestArgs`의 `hasDockerExporter` 조건).

### 실패 시 재실행

| 실패 위치 | 상태 | 조치 |
| --------- | ---- | ---- |
| `verify` 가드(조상·버전) | 이미지·Release 없음 | 아래 "태그 다시 달기" |
| `verify` 검사 | 이미지·Release 없음 | 일시 실패면 Actions의 "Re-run all jobs". 코드 결함이면 main에서 고친 뒤 새 버전으로 태그를 단다 |
| `release` 빌드 | 이미지·Release 없음 | "Re-run failed jobs"(`verify`는 다시 돌지 않는다) |
| `release` 스모크 | 이미지·Release 없음. GHCR에 올라간 것이 없다 | 일시 실패면 "Re-run failed jobs". 이미지 결함이면 main에서 고친 뒤 다음 패치 버전으로 태그를 단다 |
| `release` push의 `vX.Y.Z` push·config 비교 | `vX.Y.Z`가 GHCR에 있을 수 있다(config 불일치면 있다). `latest`는 이전 이미지 그대로. Release 없음 | 원인을 로그로 확인한 뒤 "Re-run failed jobs". 재실행은 다시 빌드하므로 `vX.Y.Z`가 새 이미지로 덮인다(`created` 라벨이 바뀌어 digest가 달라진다) |
| `release` push의 `latest` push·digest 비교 | `vX.Y.Z` 있음. `latest`는 이전 이미지이거나 새 이미지. Release 없음 | "Re-run failed jobs". `vX.Y.Z`가 새 이미지로 덮인다 |
| `release` Release 생성 | 이미지 있음, Release 없음 | "Re-run failed jobs". 이미지는 같은 태그로 다시 push된다(`created` 라벨이 바뀌어 digest가 달라질 수 있다) |

태그 다시 달기(가드 실패, 이미지 발행 전에만):

```txt
위험도: 중간 (원격 태그 삭제. 이미 태그를 받아 간 사람과 어긋난다)
롤백: 지운 태그를 같은 커밋에 다시 push한다
```

```sh
git push origin :refs/tags/vX.Y.Z   # 원격 태그 삭제
git tag -d vX.Y.Z                   # 로컬 태그 삭제
# 원인(버전 불일치, main 미병합)을 고친 뒤 main의 커밋에 다시 단다
git tag vX.Y.Z <main의 커밋> && git push origin vX.Y.Z
```

이미지를 발행한 뒤에는 태그를 옮기지 않고 다음 패치 버전을 발행한다.

### GHCR 공개 범위

- 첫 발행 뒤 `https://github.com/users/cp949/packages/container/package/mailo`의 Package settings에서 공개 범위와 저장소 연결을 확인한다.
- 첫 발행(v0.1.0) 뒤 로그인 정보 없는 클라이언트(빈 `DOCKER_CONFIG`)로 manifest 조회가 성공했다. 익명 pull이 가능한 것으로 본다. 실제 pull은 하지 않았고 패키지 설정 화면도 보지 않았다. private이면 `docker pull`에 `read:packages` 권한 토큰으로 `docker login ghcr.io`가 필요하다.
- 추정: `org.opencontainers.image.source` 라벨로 패키지가 `cp949/mailo` 저장소에 연결된다. 확인하지 않았다.

### 릴리스 절차

1. dev에서 루트 `package.json`과 `apps/mailo/package.json`의 `version`을 같은 값(`X.Y.Z`)으로 올려 커밋한다.
2. dev를 main에 병합하고 push한다. main push의 `ci.yml` 실행이 성공했는지 확인한다.
3. main의 그 커밋에 태그를 달고 push한다: `git tag vX.Y.Z origin/main && git push origin vX.Y.Z`.
4. `Release` 워크플로 결과와 GHCR 패키지, GitHub Release를 확인한다. `variants` 잡이 성공해 `vX.Y.Z-aws`가 있는지도 본다(첫 실행 전에는 GitHub에서 한 번도 실행되지 않았다). 첫 발행이면 "GHCR 공개 범위"를 확인한다.

## 로컬에서 확인한 범위 (2026-11-23)

| 항목 | 결과 |
| ---- | ---- |
| YAML 문법 | `python3 yaml.safe_load` 통과, `actionlint`(rhysd/actionlint 1.7.7 이미지) 오류 0건 |
| `static` 명령 | `format:check`·`typecheck`·`lint`·`build`·`test` 통과. 단위 407건 통과. turbo 캐시 적중 때문에 `typecheck`·`lint`·`test`는 이전 실행 결과의 재생이다 |
| `integration` 명령 | 로컬 PostgreSQL(`postgres:17-alpine`)로 `pnpm test:integration` 15개 파일 222건 통과 |
| `container` 스크립트 | 9개 모두 통과(관찰값은 아래) |
| `release.yml` 문법 | `actionlint`(rhysd/actionlint 1.7.7 이미지, shellcheck 0.10.0 포함) 오류 0건 |
| `release.yml` 가드 | 워크플로의 `run` 본문을 그대로 꺼내 임시 클론에서 실행했다. 조상: main 커밋 태그 성공, dev 커밋 태그 실패. 버전: `v0.1.0` 성공, `v0.2.0` 실패 |
| `release.yml` 이미지 | Docker 29.8.0(containerd 이미지 저장소), buildx `docker-container` 드라이버(BuildKit v0.35.1)로 `docker buildx build --platform linux/amd64 --load --provenance=false` 성공. 스모크 단계 본문을 그대로 실행해 통과했고 `revision` 라벨이 다르면 실패했다 |
| `release.yml` push | 로컬 레지스트리(`registry:2`, `localhost:5005`)를 대상으로 push 단계 본문을 그대로 실행했다. `vX.Y.Z`·`latest`가 올라갔고 레지스트리의 config digest가 `docker save`로 읽은 값과 같았다. 비교 값을 다르게 바꾸면 실패했고 `latest`는 올라가지 않았다. 레지스트리 결과는 단일 manifest였다. index 분기는 공개 다중 아키텍처 이미지(`node:24.20.0-alpine`)로 `linux/amd64` config digest를 고르는 것만 확인했다 |
| `adapter` 잡 명령(2026-11-24) | 어댑터 `pnpm test` 54건 통과. 루트 `Dockerfile`로 기본 이미지 로컬 빌드, `verify-base.sh` 통과(어댑터·SDK 경로 없음), 변형 이미지 빌드, `run.sh` 통과(구조 확인과 스모크). 변형 이미지를 `verify-base.sh`에 넣으면 실패한다(검사가 비어 있지 않음). Docker 29.8.0(containerd 이미지 저장소) |
| `release.yml` `variants`(2026-11-24) | `actionlint` 1.7.7 오류 0건. 로컬 레지스트리(`registry:2`, `localhost:5005`)를 대상으로 `variants` 잡의 `run` 본문을 순서대로 실행했다(기준 이미지 pull·라벨 확인·부재 확인, 변형 빌드, 스모크, push와 config digest 비교 모두 통과). 태그 커밋 인자를 다르게 주면 기준 이미지 라벨 확인에서 실패했다. 릴리스 노트 본문은 `gh`를 가짜로 바꿔 출력해 확인했다. 어댑터 단위 테스트 단계(`pnpm`)와 `docker/login-action`·`setup-buildx-action`·`actions/*` 실행은 로컬에서 하지 않았다 |
| `nfs` | 작성 시에는 실행하지 않았다. 수정 뒤 로컬에서는 먼저 NFS 없이 `CallerClient`의 사본 실행·종료 감지·응답 timeout·`run.sh` timeout을 확인했고, 이어 `nfs-kernel-server`를 설치해 `run.sh` 전체(31건)가 통과했다. GitHub 러너 결과는 위 "NFS 잡"에 적었다 |

컨테이너·볼륨 스크립트 관찰값(로컬 Docker 29.8.0, compose v5.5.1):

- SIGKILL: kill 직후 `SENDING`, 재기동 뒤 lease(45초) 만료 후 101초에 같은 `Message-ID`로 2통 수신, 최종 `SENT attempts=2`.
- SIGTERM(파일 1000개): 종료 코드 0, 0.4초, 폴러 중지 → Worker `drained true`. 종료 시점 DB 22건 = 처리한 파일 22건, 재기동 뒤 1000건 `SENT`, SMTP 1000통(유일 `Message-ID` 1000개).
- 볼륨: permissions acl 28/28, group 28/28, root-model 15/15, atomic-rename acl·group 4/4, e2e acl·group 15/15(기대와 다름 0).

## 확인하지 않은 것

- `ci.yml` `adapter` 잡과 `release.yml` `variants` 잡은 GitHub에서 실행한 적이 없다. 위 로컬 확인은 `run` 본문을 로컬 레지스트리로 실행한 것이다. `variants` 잡이 GHCR에서 기준 이미지를 digest로 pull하는 단계, `GITHUB_TOKEN`의 `packages: write`로 `-aws` 태그를 push하는 단계, 러너의 `docker build`가 로컬 태그(`mailo:adapter-base`)를 `FROM`으로 쓰는지는 확인하지 않았다.
- 변형 이미지에 취약점 스캔 단계가 없다. AWS SDK 취약점은 이 저장소가 소유하고 감시 수단이 정해지지 않았다.
- `variants` 잡 push 뒤 변형 이미지를 실제로 pull해 기동한 적이 없다.
- `ci.yml`: `static`·`integration`·`container` 잡은 러너에서 성공했다(위 실행 기록). 러너의 Docker·compose 버전, 이미지 pull·빌드 시간, `timeout-minutes` 여유는 기록하지 않았다.
- `release.yml`: `v0.1.0` 태그로 1회 성공했다(run 45189361321, 2분). `verify` 34초, `release` 약 1분 20초. 러너에서 스모크, GHCR push(config digest 일치), `latest` 부착, Release 생성이 통과했다. `vX.Y.Z`와 `latest`의 manifest digest는 같았다(`sha256:d5c5657f…`). 로그인 정보 없이 `docker buildx imagetools inspect`로 manifest를 조회할 수 있었다. 실패 경로(재실행 표)는 GitHub에서 실행하지 않았다. 실제 `docker pull` 후 기동과 패키지 설정 화면의 공개 범위·저장소 연결은 확인하지 않았다.
- 러너(ubuntu-24.04)의 Docker 저장소는 `overlay2`(classic)였고 이 환경에서 config digest 비교가 통과했다. containerd 저장소 러너에서의 결과는 확인하지 않았다.
- `actions/*` 세 액션의 이 워크플로 입력(`cache: pnpm`, `persist-credentials`, `if-no-files-found`, `retention-days`)은 `actionlint`가 문법을 통과시켰을 뿐 실행하지 않았다.
- `schedule`은 기본 브랜치에서만 돈다. 저장소가 비활성이면 GitHub가 schedule을 멈출 수 있다.
