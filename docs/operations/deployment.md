# 배포와 설정

compose 구성, 환경 변수, 시크릿 주입, 마이그레이션, 헬스, 종료 시간, 백업·복구를 적는다.
값과 변수 이름은 2026-11-23 코드(`apps/mailo/src/config/`, `callers/registry.ts`, `envelope/key-file.ts`)에서 가져왔다.
표기: "추정"은 코드나 실행으로 확인하지 않은 항목이다. 컨테이너 기동, 마이그레이션 실행, 백업·복구는 이 문서를 쓰는 과정에서 실행하지 않았다.

## 결론

- 상시 서비스는 `mailo`와 `postgres` 둘뿐이다(RQ-029). 저장소 루트의 `docker-compose.yml`이 둘을 정의한다.
- 예외로 개발용 `mailpit`이 같은 파일에 있다. profile `mailpit`을 줄 때만 켜지고 운영용이 아니다("개발용 Mailpit").
- 설정 오류는 기동 시점에 변수 이름과 사유를 출력하고 종료 코드 1로 끝난다. 값은 출력하지 않는다.
- `stop_grace_period`는 drain 상한(`MAILO_LEASE_SECONDS` − 10초) + 10초 이상이어야 한다. compose는 `MAILO_STOP_GRACE_PERIOD`(기본 150s)로 이 값을 정하고 앱에도 같은 값을 전달한다. 앱은 변수가 있으면 관계를 검사해 어긋나면 기동을 거부한다.
- PostgreSQL 13 이상이 필요하다. compose는 `postgres:17-alpine`이다.
- `mailo` 컨테이너는 읽기 전용 루트(`read_only`), 모든 capability 제거, `no-new-privileges`로 실행한다. 이미지의 `/repo`는 root 소유라 런타임(`node`)이 코드·`node_modules`·마이그레이션을 바꿀 수 없다.
- 지표는 `GET /metrics`(Prometheus 텍스트 형식, 읽기 토큰 `MAILO_OPS_TOKEN`)로 낸다. 관리 토큰은 403이다. 알림은 Mailo가 보내지 않고 규칙 예시만 둔다("지표").
- 앱의 로그는 모두 표준 출력의 한 줄 JSON(`ts`, `instance`, `level`, `event`, ...)이다("로그"). 기동 실패(`startup_failed`)와 `worker_fatal`도 같은 형식이다. 마이그레이션 CLI(`migrate-cli`)만 사람이 읽는 평문을 쓴다.
- DB 쓰기 권한 계정은 Mailo 앱으로 최소화한다. DB 본문 AES-GCM의 AAD가 `job_id`뿐이라 쓰기 권한자의 `recipients` 변경은 막지 못한다(ADR-0008 구현 중 확정 10, `key-management.md`).
- DB 암호화 키·지문 키·JWE 개인키를 DB 백업과 별도로 보관한다. 이 키 없이는 복원한 DB의 일부 기능이 동작하지 않는다("백업과 복구").

## compose 구성

| 서비스 | 이미지 | 노출 | 비고 |
| ------ | ------ | ---- | ---- |
| `postgres` | `postgres:17-alpine` | `127.0.0.1:${MAILO_DB_PUBLISH_PORT:-5432}` | 볼륨 `postgres-data`, `pg_isready` healthcheck, `restart: unless-stopped` |
| `mailpit`(profile `mailpit`, 개발용) | `axllent/mailpit:v1.34.0@sha256:23a2ef85…`(digest 고정) | 웹 UI·API만 `127.0.0.1:${MAILO_MAILPIT_UI_PORT:-8025}:8025`. SMTP 1025는 compose 네트워크 안에서만 | 기본 `docker compose up`에 들어가지 않는다. `user: "65534:65534"`, `read_only: true` + `tmpfs: /tmp`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`. 받은 메일은 `/tmp`에만 있어 재시작하면 사라진다 |
| `mailo` | 저장소 `Dockerfile` 빌드(`node:24.20.0-alpine@sha256:e67514e5…`, digest 고정) | `${MAILO_PUBLISH_HOST:-127.0.0.1}:${MAILO_PUBLISH_PORT:-3000}:3000` (기본 같은 호스트만) | non-root(`node`, UID 1000), `restart: unless-stopped`, `stop_grace_period: ${MAILO_STOP_GRACE_PERIOD:-150s}`, healthcheck(`/health/live`), `read_only: true` + `tmpfs: /tmp`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]` |

- `mailo`는 `.env`를 `env_file`로 읽는다. `.env`가 없으면 compose가 실패한다. `.env.example`을 복사해 만든다(`docker compose up -d postgres`만 실행할 때도 같다).
- `POSTGRES_PASSWORD`에는 compose 기본값이 없다. `.env`나 환경에 없으면 `docker compose`가 변수 이름을 알리고 중단한다(`${POSTGRES_PASSWORD:?...}`). 공개 기본 비밀번호가 운영에 남는 것을 막기 위해서다. 영향: `scripts/container/`는 `POSTGRES_PASSWORD`를 환경으로 주므로 그대로 동작한다. CI의 `integration`·`nfs` 잡은 compose가 아니라 서비스 컨테이너를 쓰므로 영향이 없다(`ci.md`).
- `NODE_ENV`는 `.env.example`에서 주석 처리돼 있어 복사한 `.env`로는 compose 기본값 `production`이 된다. production은 `.env.example`에 공개된 샘플 키(DB 본문 키·지문 키), 적합성 벡터의 공개 가짜 키(호출처 JWS 비밀키·Mailo JWE 개인키)와 샘플 DB 비밀번호(`mailo-dev-password`)를 거부하므로 새 값을 만들어 넣어야 기동한다(`key-management.md`). 공개 샘플 값으로 로컬 시험만 할 때는 `.env`에 `NODE_ENV=development`를 준다.
- 앱은 `NODE_ENV`가 없거나 `development`·`test`가 아니면 production과 같은 검사를 한다(fail closed). 호스트에서 `pnpm --filter @cp949/mailo start`로 실행할 때도 공개 샘플 값을 쓰려면 `NODE_ENV=development`를 명시해야 한다. `NODE_ENV`를 필수 변수로 만들지는 않았다. 값이 없어도 기동은 되고(검사만 엄격해진다) 로컬 개발의 변수 부담을 늘리지 않기 위해서다.
- HTTP 포트는 기본 `127.0.0.1`에만 연다. TLS 프록시가 다른 호스트에 있거나 같은 호스트의 다른 인터페이스로 접근해야 하면 `.env`에 `MAILO_PUBLISH_HOST`(예: `0.0.0.0`, 인터페이스 주소)를 준다. Mailo는 TLS를 종단하지 않으므로 `0.0.0.0`으로 열 때는 프록시나 방화벽으로 접근을 제한한다.
- compose의 `environment`가 `.env`보다 우선한다. 컨테이너에서 `NODE_ENV`(기본 `production`), `MAILO_PORT=3000`, `MAILO_DB_*`(아래), `MAILO_CALLERS_FILE=/run/mailo/callers.json`은 compose 값이 쓰인다.
- compose는 접속 URL을 이어 붙이지 않고 `MAILO_DB_HOST=postgres`, `MAILO_DB_PORT`, `MAILO_DB_USER`(`POSTGRES_USER`), `MAILO_DB_PASSWORD`(`POSTGRES_PASSWORD`), `MAILO_DB_NAME`(`POSTGRES_DB`)를 준다. 앱이 이 값으로 URL을 조립하면서 사용자·비밀번호·DB 이름을 URL 인코딩하므로 `POSTGRES_PASSWORD`에 `@`, `/`, `:`, `#`, `%`를 써도 된다. 이유: 이어 붙이는 방식은 이 문자에서 URL이 깨지고 compose는 인코딩할 수 없다. compose는 `.env`의 호스트 실행용 `MAILO_DATABASE_URL`이 컨테이너에 새지 않도록 빈 값으로 덮는다. 두 방식을 함께 주면 기동을 거부한다.
- `.env.example`의 `POSTGRES_PASSWORD=mailo-dev-password`는 개발용 가짜 값이다. production은 이 값을 DB 접속에 쓰면 기동을 거부한다(`MAILO_DATABASE_URL`·`MAILO_DB_PASSWORD`에서 읽은 비밀번호 기준). 운영은 반드시 다른 값을 준다.
- `postgres`의 호스트 포트 게시(`127.0.0.1:${MAILO_DB_PUBLISH_PORT:-5432}`)는 유지한다. 로컬 통합 테스트(`pnpm test:integration`)가 호스트에서 이 포트로 접속하기 때문이다. 바인딩이 `127.0.0.1`이라 같은 호스트의 프로세스만 접근한다. 같은 호스트에 신뢰하지 않는 계정이 있는 운영 호스트에서는 `ports`를 지우는 override를 쓴다(`scripts/container/`의 `postgres: ports: !reset []`와 같은 방식).
- `./callers.json`을 컨테이너의 `/run/mailo/callers.json`에 읽기 전용으로 마운트한다. 파일이 없으면 `callers.example.json`을 복사해 만든다. `/callers.json`은 `.gitignore` 대상이다.
- Mailo는 TLS를 종단하지 않는다(코드에 TLS 설정이 없다). Bearer 키가 평문으로 오가지 않도록 TLS를 종단하는 프록시 뒤에 두거나 신뢰하는 내부 망에서만 노출한다.
- `mailo` healthcheck는 이미지에 curl이 없어 `node -e fetch(...)`로 `GET http://127.0.0.1:3000/health/live`를 10초마다 호출한다(타임아웃 5초, 3회 실패 시 unhealthy, `start_period` 30초). DB 상태는 보지 않는다. 준비 확인은 "헬스" 절을 따른다.
- 파일 채널을 켜려면 `.env`에 `MAILO_FILE_CHANNEL_ROOT=/var/mailo/files`를 주고 `docker-compose.yml`의 주석 처리된 볼륨 줄을 연다. 폴더와 권한은 호스트에서 만든다(`caller-onboarding.md`, `nfs.md`). `<root>/inbox`가 없거나 통과할 수 없으면 앱은 기동을 거부한다(mount 전의 빈 디렉터리를 읽는 상황을 막는다. 읽기 권한은 요구하지 않는다). 호출처 폴더 하나가 없는 것은 경고다.
- NAS/NFS를 컨테이너에서 쓰는 구성 예시는 `docker-compose.nfs-example.yml`(Docker `local` 드라이버 NFS named volume)이다. 같은 호스트 loopback NFS에서 `verify-docker-volume.sh`로 실행해 확인했다(2026-11-23). 실제 NAS 제품은 확인하지 않았다(`nfs.md` "컨테이너에서 쓰는 방법").
- 읽기 전용 루트(`read_only`): 런타임이 쓸 수 있는 곳은 `/tmp`(tmpfs)와 파일 채널 볼륨(별도 마운트)뿐이다. 이 구성에서 컨테이너 검증 스크립트(`scripts/container/`, `scripts/volume/`)가 쓰기 오류 없이 통과했다(`/tmp`가 실제로 쓰였는지는 확인하지 않았다). 로그는 표준 출력이다. 이미지를 바꾸지 않고 쓰기가 필요한 경로가 생기면 그 경로만 `tmpfs`나 볼륨으로 연다.

기동:

```sh
cp .env.example .env              # 값을 실제 값으로 바꾼다(DB 본문 키·지문 키는 새로 만든다: key-management.md)
cp callers.example.json callers.json   # 해시를 실제 호출처 키의 SHA-256으로 바꾼다
docker compose up -d --build
```

### GHCR 이미지

- 릴리스 태그마다 `ghcr.io/cp949/mailo:vX.Y.Z`와 `latest`가 발행된다(`linux/amd64`만). 발행 절차는 `ci.md` "릴리스 워크플로"다. AWS 어댑터 변형은 별도 태그 `vX.Y.Z-aws`다("AWS 변형 이미지(`-aws`)").
- 태그를 고정해 쓴다: `docker pull ghcr.io/cp949/mailo:vX.Y.Z`. `latest`는 다음 릴리스에서 옮겨지므로 운영에 쓰지 않는다. 더 엄격하게 고정하려면 Release 노트의 digest(`ghcr.io/cp949/mailo@sha256:...`)를 쓴다.
- 기본 `CMD`는 마이그레이션을 실행하지 않는다("기동 순서와 마이그레이션").
- `docker-compose.yml`의 `mailo`는 `build: context: .`로 로컬 빌드한다. 발행 이미지를 쓰려면 override 파일에서 `build`를 지우고 `image`를 준 뒤 `--build` 없이 띄운다. `docker-compose.migrate-once.yml`을 쓰면 `mailo-migrate`에도 같은 두 줄을 준다.

```yaml
# docker-compose.override.yml
services:
  mailo:
    image: ghcr.io/cp949/mailo:vX.Y.Z
    build: !reset null
```

- compose v5.5.1에서 `docker compose config --images`가 `ghcr.io/cp949/mailo:<태그>`를 내고 `mailo`에 `build`가 없는 것을 확인했다(2026-11-23). `!reset`은 compose v2.24 이상이 필요하다. 이 구성으로 실제 기동은 하지 않았다.

### 개발용 Mailpit

로컬 개발에서 실제 메일 서버 없이 Mailo의 발송 결과를 보는 구성이다. 운영용이 아니다. 운영에서 profile `mailpit`을 켜지 않는다.

```txt
위험도: 낮음(개발 호스트 한정, 웹 UI는 127.0.0.1에만 열린다)
롤백: docker compose --profile mailpit stop mailpit 후 .env의 SMTP 설정을 되돌린다
```

1. `.env`에서 SMTP 설정을 Mailpit으로 바꾼다. `.env.example`의 "개발용 Mailpit" 주석 세 줄(`MAILO_SMTP_SECURITY=none`, `MAILO_SMTP_HOST=mailpit`, `MAILO_SMTP_PORT=1025`)을 풀고 기존 `MAILO_SMTP_HOST`·`MAILO_SMTP_PORT` 줄을 지운다.
2. 인증 정보는 바꾸지 않아도 된다. Mailpit은 `MP_SMTP_AUTH_ACCEPT_ANY`·`MP_SMTP_AUTH_ALLOW_INSECURE`로 평문 세션의 아무 사용자·비밀번호나 받는다. `MAILO_SMTP_USER`·`MAILO_SMTP_PASSWORD`를 둘 다 비우면 인증 없이 보내고, 그때는 `MAILO_SMTP_FROM`이 필요하다.
3. 띄운다: `docker compose --profile mailpit up -d --build`.
4. 발송을 확인한다.
   - 웹 UI: `http://127.0.0.1:8025`(`MAILO_MAILPIT_UI_PORT`로 바꾼다).
   - API: `curl -s http://127.0.0.1:8025/api/v1/messages`의 `total`과 `messages[].Subject`.
   - Mailo 로그에 `smtp_plaintext_enabled`(warn)가 한 줄 남는다("평문 SMTP 모드").
5. 끈다: `docker compose --profile mailpit down`. compose v5.5.1에서는 profile 없이 `docker compose down`을 해도 `mailpit` 컨테이너가 지워졌다.

- `docker compose config --services`는 profile 없이 `postgres`·`mailo`만 낸다. `--profile mailpit`을 주면 `mailpit`이 더해진다.
- `mailo`는 `mailpit`에 `depends_on`을 두지 않는다. profile 없이도 `mailo`가 뜨게 하기 위해서다. `mailpit`이 떠 있지 않으면 호스트 이름 조회·연결이 실패해 계정 상태 오류(`CONNECTION`)가 되고, 연속 실패가 임계값에 닿으면 차단기가 열린다(`troubleshooting.md` "전역 차단기가 open일 때").
- 확인 기록(2026-11-23, Docker 29.8.0, compose v5.5.1, 별도 compose 프로젝트): `--profile mailpit up -d --build --wait`로 세 서비스가 healthy가 됐다. `NODE_ENV=production`(compose 기본값)인 `mailo`에 `POST /jobs` 1건을 보내 `SENT`가 됐고, Mailpit `/api/v1/messages`의 `total`이 1이었다. 수동 확인이고 자동 테스트가 아니다. compose 파일의 profile·이미지 고정·포트·보안 옵션은 `config/compose-consistency.spec.ts`가 글자로 검사한다.

### 호스트 DB 포트 충돌

- `postgres`는 호스트 `127.0.0.1:${MAILO_DB_PUBLISH_PORT:-5432}`에 열린다. 기본값 5432는 바꾸지 않는다.
- 개발 호스트에 다른 PostgreSQL이 5432를 쓰면 `port is already allocated`로 `postgres`가 뜨지 않는다. `.env`의 `MAILO_DB_PUBLISH_PORT`를 비어 있는 포트(예: 15432)로 바꾼다.
- 바꾼 포트는 호스트에서 접속하는 URL(`MAILO_DATABASE_URL`, `MAILO_TEST_DATABASE_URL`)에도 같이 쓴다. 컨테이너 안 `mailo`는 `postgres:5432`로 접속하므로 바꿀 필요가 없다.
- 비어 있는지 확인: `ss -ltn | grep ':15432 '`의 출력이 없어야 한다.

## 기동 순서와 마이그레이션

컨테이너 명령은 `sh -c "node dist/db/migrate-cli.js && exec node dist/main.js"`이다. 마이그레이션이 실패하면 앱은 뜨지 않는다. `exec`로 node가 PID 1을 이어받아 SIGTERM이 node에 직접 전달된다.

- 마이그레이션 실행기(`src/db/migrator.ts`)는 `apps/mailo/migrations/NNNN_이름.sql`을 파일명 순서로 적용한다. 파일마다 트랜잭션 하나이고, 실패하면 그 파일만 롤백하고 중단한다.
- 적용 기록은 `schema_migrations`에 남는다. 이미 적용한 파일은 건너뛴다. 적용한 파일의 내용이 바뀌어도 감지하지 않으므로 적용한 파일은 고치지 않고 새 파일을 추가한다(AGENTS.md).
- 인스턴스가 동시에 기동해도 advisory lock(키 `7364221001`)으로 직렬화한다.
- `Dockerfile`의 기본 `CMD`는 `node dist/main.js`다. compose 밖에서 이미지를 실행하면 마이그레이션이 돌지 않는다. 먼저 `node dist/db/migrate-cli.js`를 실행한다.
- 호스트에서 직접 적용: `MAILO_DATABASE_URL`을 주고 `pnpm build`를 한 뒤 `pnpm --filter @cp949/mailo migrate`(빌드 결과 `dist/db/migrate-cli.js`를 실행한다).
- down 마이그레이션은 없다. 롤백은 적용 전에 받아 둔 `pg_dump`를 복원하는 방법뿐이다("백업과 복구"). 마이그레이션을 적용하기 전에 백업한다. 적용한 파일을 고쳐 되돌리지 않는다.
- 트랜잭션 안에서 쓸 수 없는 문장(`CREATE INDEX CONCURRENTLY`)은 파일 첫 줄에 `-- mailo:no-transaction`을 둔다. 이 파일은 `BEGIN` 없이 실행된다. 규칙:
  - 문장은 정확히 하나여야 한다. 실행기가 주석·문자열·달러 인용 안의 `;`를 빼고 세어 둘 이상이거나 판정이 애매하면(닫히지 않은 따옴표·`E'...'`) 실행 전에 거부한다. 여러 문장을 한 번에 보내면 PostgreSQL이 암묵 트랜잭션으로 묶어 `CONCURRENTLY`가 실패하기 때문이다.
  - 성공하면 `schema_migrations`에 기록한다. 실패하면 기록하지 않아 다음 실행(컨테이너 재시작 포함)에서 다시 시도하므로 문장은 멱등해야 한다(`IF NOT EXISTS` 등).
  - `CREATE INDEX CONCURRENTLY`가 실패하면 `INVALID` 인덱스가 남는다. 운영자가 `DROP INDEX CONCURRENTLY`로 지운 뒤 다시 실행한다(`\d <테이블>`의 `INVALID` 표시로 찾는다).
  - 실행기는 표식 파일을 실행한 뒤 기록 전에 현재 schema의 `INVALID` 인덱스(`pg_index.indisvalid = false`)를 조회한다. 있으면 기록하지 않고 인덱스 이름을 담은 오류로 실패한다. `IF NOT EXISTS`는 같은 이름의 `INVALID` 인덱스가 있으면 건너뛰고 성공하기 때문이다. 같은 schema에서 수동 `CREATE INDEX CONCURRENTLY`가 진행 중이어도 실패한다.
  - 같은 실행에서 앞서 적용한 파일은 이미 커밋돼 있다. 표식 파일이 실패해도 앞 파일은 롤백되지 않는다.
  - 현재 표식 파일은 `0005_job_priority_claim_index.sql`, `0012`~`0016`, `0018`이다. 나머지(`0001`~`0004`, `0006`~`0011`, `0017`)는 트랜잭션 실행이다.
  - 인덱스 생성(`0005`, `0012`~`0014`)의 확인·복구 절차는 `troubleshooting.md` "등급별 적체"다. 이벤트 수신자 비움 인덱스(`0018`)는 "이벤트 수신자 비움 인덱스"다.
  - 이벤트 수신자 비움(`0017`, `0018`, RQ-072)은 새 코드가 `mail_events.recipients_redacted_at`을 읽으므로 마이그레이션이 먼저 적용돼야 한다. compose 기본 구성은 시작 때 마이그레이션을 먼저 돌린다. 구버전 인스턴스는 이 컬럼을 열거하지 않아 쿼리는 깨지지 않는다(코드 읽기, 실행하지 않았다). 그러나 롤링 배포의 혼용 구간에는 영향이 있다.
    - 새 인스턴스가 뜨면 `recipients` 단계가 보존 기간 안의 기존 이벤트(최대 30일치) 중 유예(기본 7일)가 지난 것을 바로 비우기 시작한다. 구버전 인스턴스는 `recipientsRedacted`를 모른다. 구버전이 응답하는 `GET /events`는 비운 이벤트의 `{}`를 빈 `to`·`cc`·`bcc`로 내보내므로 호출처가 "원래 없음"과 "비움"을 구분하지 못한다. 거부 수신자도 같다.
    - 절차: 롤링 배포 동안 모든 인스턴스에 `MAILO_RECIPIENT_RETENTION_SECONDS`를 `MAILO_RECORD_RETENTION_SECONDS`와 같은 값(기본이면 2592000)으로 준다. 비움 대상이 삭제 대상과 겹쳐 거의 비우지 않는다. 구버전 인스턴스가 모두 없어진 것을 확인한 뒤 변수를 지우거나 원하는 유예(기본 7일)로 바꾸고 재시작한다. 그 시점부터 기존 이벤트 백필이 시작된다(진행은 `db-maintenance.md` "점검 쿼리" 5).
    - 계약 문서의 `recipientsRedacted`는 필수 필드로 쓰여 있다. 혼용 구간의 구버전 응답에는 이 필드가 없어 스키마와 어긋난다. 이벤트 스키마가 `additionalProperties`를 닫지 않았고 호출처는 모르는 필드와 없는 필드를 허용해야 하므로 위험은 낮다(코드·문서 읽기, 실행하지 않았다).
    - `0017`의 `ADD COLUMN`은 `mail_events`에 `ACCESS EXCLUSIVE` 잠금이 필요하다. 긴 읽기 트랜잭션이나 `pg_dump` 뒤에 줄을 서면 마이그레이션이 `lock_timeout`(10초) 동안 기다리고, 그 사이 `mail_events`에 닿는 쓰기(종결 전이의 이벤트 쓰기, 이벤트 조회)가 막힐 수 있다. 시간이 지나면 마이그레이션이 `55P03`으로 실패하고 앱은 뜨지 않는다. PostgreSQL 동작 지식이고 측정하지 않았다(확인하지 않음). 배포 전에 긴 트랜잭션과 덤프 작업이 없는지 `db-maintenance.md` 점검 쿼리 3으로 본다.
    - 롤백은 코드를 이전 버전으로 바꾸는 것이고 컬럼과 인덱스는 남긴다. 이미 비운 수신자는 복원하지 못한다.

```txt
위험도: 중간 (혼용 구간에 호출처가 비운 이벤트를 구분하지 못한다. 비운 값은 복원하지 못한다. 0017이 잠금을 기다리는 동안 이벤트 쓰기가 막힐 수 있다)
롤백: 코드를 이전 버전으로 교체한다. 컬럼과 인덱스는 남긴다. 이미 비운 이벤트·시도의 수신자는 백업 복원으로만 되돌린다
```
- 잠금 대기: 기본(트랜잭션) 실행은 풀에 `lock_timeout`이 걸려 있으면 그 값(CLI는 10초)을 쓰고, 없으면(0) 10초를 `SET LOCAL`로 건다. 표식 파일은 같은 값을 세션 `SET`으로 걸고 끝나면 `RESET`한다. 마이그레이션이 다른 쿼리를 막는 잠금을 10초 넘게 기다리면 실패한다(`55P03`). 인스턴스 사이의 advisory lock 대기에는 걸지 않는다.

### 마이그레이션 일회성 실행(선택)

기본 compose는 `mailo` 컨테이너가 시작할 때마다 `migrate-cli`를 실행한다(앱 계정이 DDL 권한을 가진다). 이를 떼려면 `docker-compose.migrate-once.yml`을 덮어 쓴다.

```sh
docker compose -f docker-compose.yml -f docker-compose.migrate-once.yml up -d --build
```

- `mailo-migrate`(같은 이미지) 서비스가 `migrate-cli`를 한 번 실행하고 끝난다. `mailo`는 그것이 성공해야(`service_completed_successfully`) 시작하고 시작 명령에서 `migrate-cli`를 뺀다. `mailo`가 재시작해도 마이그레이션은 다시 돌지 않는다. 마이그레이션이 실패하면 `mailo`는 시작하지 않는다.
- 계정 분리: `.env`에 `MAILO_MIGRATE_DB_USER`·`MAILO_MIGRATE_DB_PASSWORD`를 주면 마이그레이션만 그 계정(테이블 소유자, DDL 권한)으로 돈다. 앱(`POSTGRES_USER`)은 DML 권한만 가진 계정으로 둘 수 있다. 앱 계정에는 다음을 준다(`<migrator>`는 마이그레이션 계정).

```sql
GRANT USAGE ON SCHEMA public TO <app>;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO <app>;
ALTER DEFAULT PRIVILEGES FOR ROLE <migrator> IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO <app>;
```

- 확인한 것: 로컬 PostgreSQL 17에서 위 권한으로 `mail_intake_rejections`의 INSERT·UPDATE·DELETE(식별 컬럼 포함)와 `pg_current_xact_id()`가 되고 `CREATE TABLE`은 `permission denied`였다. 확인하지 않은 것: 이 권한으로 앱 전체(Worker, 이벤트 피드, 보존 삭제)를 돌리는 것, override 파일의 실제 기동(`docker compose config` 문법 확인만 했다). 이 구성은 기본이 아니다.
- 이 파일을 쓰면 기동 때 자동 마이그레이션이 없으므로 배포 절차에서 `mailo-migrate`가 끝났는지 확인한다(`docker compose ps -a mailo-migrate`의 종료 코드 0).
- 현재 파일: `0001_queue_schema.sql`(5개 테이블, PostgreSQL 13 이상 필요), `0002_caller_quota.sql`(`mail_attempts.caller_id` 추가·채움, 부분 인덱스 2개), `0003_attempt_instance.sql`(`mail_attempts.instance` NULL 허용 컬럼과 길이 CHECK(`NOT VALID`) 추가. PostgreSQL 11 이상에서 테이블을 다시 쓰지 않는다).
- `0004_job_priority.sql`(`mail_jobs.priority smallint NOT NULL DEFAULT 20`과 허용 순위 CHECK(`NOT VALID`) 추가. 상수 DEFAULT 컬럼 추가는 PostgreSQL 11 이상에서 테이블을 다시 쓰지 않는다(문서 기준, 미측정)), `0005_job_priority_claim_index.sql`(우선순위 점유 인덱스 `mail_jobs_priority_claim_idx`를 `CREATE INDEX CONCURRENTLY IF NOT EXISTS`로 만든다).
- `0002`는 `mail_attempts` 전체를 `UPDATE`하고 인덱스를 `CONCURRENTLY` 없이 만든다. 시도 행이 많은 DB에서는 적용 중 쓰기가 잠시 막힐 수 있다(코드 읽기 결과, 대용량에서 측정하지 않았다).
- 이전 버전 인스턴스가 `0002` 적용 뒤에도 돌면 `caller_id` 없이 시도를 기록한다. 그런 행은 호출처 할당 사용량에 잡히지 않는다(마이그레이션 주석). 롤링 배포가 끝나면 사라진다.

```txt
위험도: 중간 (스키마 변경)
롤백: down 마이그레이션 없음. 적용 전 pg_dump 백업을 복원한다
```

### 우선순위 도입 배포 순서

근거: RQ-038, ADR-0009.

이전 버전 인스턴스는 요청의 `priority`를 정의되지 않은 필드(`UNKNOWN_FIELD`)로 거부한다. 그래서 호출처가 `priority`를 보내기 시작하는 시점은 모든 인스턴스가 새 버전이 된 뒤다.

1. 마이그레이션 `0004`·`0005`를 적용한다(기동 때 자동 또는 `mailo-migrate`). `0005`는 `CONCURRENTLY`라 쓰기를 막지 않지만 큰 테이블에서는 오래 걸릴 수 있다(미측정).
2. 모든 Mailo 인스턴스를 새 버전으로 바꾼다. 이 동안(이전·새 인스턴스 혼용) 호출처는 `priority`를 보내지 않는다. 이전 인스턴스가 섞여 있으면 점유 순서만 예전과 같아지고 정합성 문제는 없다.
3. 인덱스가 유효한지 확인한다(`troubleshooting.md` "등급별 적체"의 `indisvalid` 조회).
4. 호출처가 `priority` 전송을 시작한다(`caller-onboarding.md` "우선순위").

롤백:

1. 호출처 relay와 파일 게시를 일시 중지한다. 진행 중 요청과 Mailo 파일 폴러 처리가 끝날 때까지 기다린다. 이전 버전에 `priority`를 보내면 REST는 400, 파일은 수집 거부가 된다.
2. 등록 응답을 확인하지 못한 요청과 inbox에 남은 파일은 같은 호출처의 `GET /jobs?idempotencyKey=`로 확인한다. 작업이 있으면 이미 등록된 것으로 호출처에 기록하고 재전송 대상에서 제외한다. 파일은 새 게시가 멈췄고 같은 Key의 DB 등록을 확인한 뒤 기존 호출처 파일 관리 절차로 정리한다. 작업이 `PENDING`이어도 등록 확인은 끝난 것이다. 발송 결과는 기존 조회·이벤트 피드로 추적한다.
3. `LOW`·`HIGH`·`URGENT`로 등록된 요청에서 `priority`만 제거해 같은 Key로 재요청하지 않는다. 지문의 `policy.priority`가 달라져 REST는 409, 파일은 `FINGERPRINT_MISMATCH`가 된다. 새 Key로 재등록하면 별도 작업이 생겨 중복 발송할 수 있다. 조회 실패나 Key 보존 기간 경과로 등록 여부를 확정할 수 없으면 해당 요청의 재전송을 보류하고 복구 후 확인한다.
4. 아직 등록되지 않은 요청에서 `priority`를 제거하면 `NORMAL`로 등록된다. 이 의미 변경을 허용할 요청만 이전 버전으로 전달한다. 기존 등급을 유지해야 하는 요청은 호출처에서 보관하고 우선순위 지원 버전 복구 후 같은 Key·같은 내용·같은 등급으로 전달한다.
   - 파일 JWS는 `priority`도 서명 대상이다. 등급을 제거할 파일은 호출처의 서명 파이프라인에서 새 payload를 서명한다. 게시된 파일을 제자리 수정하지 않고 기존 임시 파일 → rename 절차로 다시 게시한다.
5. 이전 버전으로 되돌린다. `priority` 컬럼과 인덱스는 남겨 둔다. 이전 버전은 이 컬럼을 읽지 않고, 새로 등록한 행은 DEFAULT(`NORMAL`)가 된다. 등록된 작업의 등급은 남지만 이전 Worker는 등급을 무시하고 점유한다. `priority`를 보내지 않도록 확인한 뒤 호출처 relay와 파일 게시를 재개한다.

```txt
위험도: 중간 (미확인 요청의 등급 제거는 지문 충돌, 새 Key 재등록은 중복 발송 가능)
롤백: 미확인 요청을 정리한 뒤 앱만 이전 버전으로 되돌린다. 스키마는 그대로 둔다
```

### 요청별 만료 시간 도입 배포 순서

근거: RQ-039, ADR-0010 결정 8.

마이그레이션은 필요 없다. `expires_at` 컬럼은 `0001_queue_schema.sql`부터 있다. 이전 버전 인스턴스는 요청의 `ttlSeconds`를 정의되지 않은 필드(`UNKNOWN_FIELD`)로 거부한다.

1. 기본 TTL보다 긴 `ttlSeconds`를 허용하려면 `MAILO_JOB_EXPIRY_MAX_SECONDS`를 정한다. `MAILO_RECORD_RETENTION_SECONDS` 이하여야 기동한다("변수 사이의 제약"). 설정하지 않으면 상한은 `MAILO_JOB_EXPIRY_SECONDS`와 같다.
2. 모든 Mailo 인스턴스를 새 버전으로 바꾼다. 이 동안(이전·새 인스턴스 혼용) 호출처는 `ttlSeconds`를 보내지 않는다. 모든 인스턴스가 같은 상한을 쓰게 한다. 상한이 인스턴스마다 다르면 같은 요청이 인스턴스에 따라 400이 된다.
3. 호출처가 `ttlSeconds` 전송을 시작한다(`caller-onboarding.md` "요청별 만료 시간").

롤백:

1. 호출처의 `ttlSeconds` 전송을 먼저 끊는다. 끊지 않으면 이전 버전에서 REST는 400, 파일은 수집 거부가 된다.
2. `ttlSeconds`로 등록된 요청을 `ttlSeconds` 없이 같은 Key로 재요청하지 않는다. 지문의 `policy.ttlSeconds`가 달라져 REST는 409, 파일은 `FINGERPRINT_MISMATCH`가 된다. 등록 여부 확인 절차는 "우선순위 도입 배포 순서"의 롤백 2~3과 같다.
3. 이전 버전으로 되돌린다. 이미 등록된 작업의 `expires_at`은 그대로 쓰인다(이전 버전도 이 컬럼으로 판정한다). 이전 버전은 `MAILO_JOB_EXPIRY_MAX_SECONDS`를 읽지 않는다. 이 변수가 남아 있어도 기동에 영향이 없다.

```txt
위험도: 낮음 (스키마 변경 없음. 미확인 요청에서 ttlSeconds를 빼면 지문 충돌)
롤백: 호출처 전송을 끊은 뒤 앱만 이전 버전으로 되돌린다
```

### 결과 불명 정책 도입 배포 순서

근거: RQ-073·074, ADR-0015 결정 8~10.

새 환경 변수는 없다. 마이그레이션 `0019_job_on_uncertain.sql`이 `mail_jobs`에 `on_uncertain text NOT NULL DEFAULT 'retry'`와 `CHECK (on_uncertain IN ('retry','fail')) NOT VALID`를 더한다. 상수 DEFAULT 컬럼 추가라 PostgreSQL 11 이상에서 테이블을 다시 쓰지 않는다(통합 테스트 `test/db/job-on-uncertain-migration.integration-spec.ts`가 `relfilenode` 불변을 확인했다). `ALTER TABLE`의 `ACCESS EXCLUSIVE` 잠금 대기는 대용량 테이블에서 측정하지 않았다. `0017`·`0018`은 이벤트 수신자 비움(RQ-072)의 마이그레이션이고 `0019`는 그 뒤에 이름 순으로 적용된다(`test/db/job-on-uncertain-migration.integration-spec.ts`가 전체 폴더 적용 순서를 확인한다).

1. `pg_dump`를 받는다("백업과 복구"). `0019`를 적용한다(기동 때 자동 또는 `mailo-migrate`). 새 버전의 등록 INSERT가 `on_uncertain`을 쓰므로 새 버전 인스턴스를 띄우기 전에 적용한다.
2. 모든 Mailo 인스턴스를 새 버전으로 바꾼다. 이전 버전은 컬럼을 열거해 읽고 쓰므로 마이그레이션 직후에도 동작한다. 이전 버전의 INSERT는 DEFAULT `retry`가 된다.
3. 호출처가 `onUncertainOutcome` 전송을 시작한다(`caller-onboarding.md` "결과 불명이면 재시도하지 않기"). 2가 끝나기 전에는 시작하지 않는다.

3이 2 뒤여야 하는 이유(코드로 확인한 동작):

- 이전 버전은 `onUncertainOutcome`을 정의되지 않은 필드로 거부한다. REST는 400 `UNKNOWN_FIELD`, 파일 채널은 `VALIDATION_FAILED` 거부다. 이전 버전의 `parseRequestSchema`에 이 필드를 넣어 두 경로가 `UNKNOWN_FIELD`를 내는 것을 실행해 확인했다(2026-11-24).
- 롤링 중에 새 인스턴스가 `fail`로 등록한 작업을 이전 버전 Worker가 점유해 결과를 기록하면 `on_uncertain`을 읽지 않으므로 `retry`처럼 재시도한다. 같은 메일이 두 번 갈 수 있다.
- 종료(배포) 때 drain 상한을 넘긴 전송은 lease 회수로 `LEASE_EXPIRED`가 되고 `fail` 작업은 그대로 종결한다. `stop_grace_period`가 lease 이상인지 확인한다("종료와 stop_grace_period"). 어기면 `fail` 요청의 손실이 배포마다 생긴다.

롤백:

1. 호출처가 `onUncertainOutcome` 전송을 먼저 끊는다. 끊지 않으면 이전 버전에서 REST는 400, 파일은 수집 거부다.
2. 같은 Key로 이미 등록한 요청을 필드를 빼고 다시 보내지 않는다. 지문의 `policy.onUncertainOutcome`이 달라져 REST는 409, 파일은 `FINGERPRINT_MISMATCH`다(확인 절차는 "우선순위 도입 배포 순서"의 롤백 2~3과 같다).
3. 처리 중인 `fail` 작업을 확인한다. 이전 버전으로 바꾸면 이 작업은 `retry`처럼 처리된다. 비는 것을 기다리거나 중복 가능성을 받아들인다.

   ```sql
   SELECT status, count(*) FROM mail_jobs
    WHERE on_uncertain = 'fail' AND status IN ('PENDING','SENDING','RETRY_WAIT')
    GROUP BY status;
   ```

4. 이전 버전으로 되돌린다. `on_uncertain` 컬럼과 CHECK는 남겨도 무해하다. 이전 버전이 열거하지 않고 DEFAULT가 `retry`다.
5. 이미 `OUTCOME_UNKNOWN`으로 끝난 작업은 `FAILED`로 남는다. 이전 버전은 사유 문자열을 그대로 낸다(`failureReasonOf`의 `?? stored`). 호출처가 모르는 `failureReason`을 처리하는지는 호출처 책임이다. 이 저장소 밖 호출처는 확인하지 못했다.

```txt
위험도: 높음 (판정 순서와 큐 SQL 변경, 요청 계약과 failureReason enum 변경. 마이그레이션은 컬럼 하나)
롤백: 호출처가 onUncertainOutcome 전송을 먼저 끊고 이전 버전으로 교체한다. 컬럼은 남긴다. 처리 중이던 fail 작업은 이전 버전이 retry로 처리한다. OUTCOME_UNKNOWN으로 끝난 작업은 FAILED로 남는다
```

### 작업 취소 도입 배포 순서

근거: RQ-040·041, ADR-0011 결정 4·10.

새 환경 변수는 없다. 마이그레이션 `0006`(`mail_jobs`의 `mail_jobs_status_check`·`mail_jobs_terminal_state`)과 `0007`(`mail_events`의 `mail_events_type_check`)이 `CANCELED`·`JOB_CANCELED`를 허용하게 바꾼다. 둘 다 `DROP CONSTRAINT` 뒤 같은 이름의 `ADD CONSTRAINT ... NOT VALID`다. 제약은 미검증(`convalidated = false`) 상태로 남는다. 새 조건은 옛 조건에 새 값을 더한 것이라 기존 행은 모두 만족하므로 `VALIDATE CONSTRAINT`는 하지 않는다.

1. 호출처(사용처)가 모르는 값 규칙을 지키는지 확인한다(`docs/api/README.md` "호출처가 모르는 값을 만났을 때", `caller-onboarding.md` "작업 취소"). 이 확인이 끝나기 전에는 취소 API를 쓰지 않는다.
2. 마이그레이션 전에 `pg_dump`를 받는다("백업과 복구"). `0006`·`0007`을 적용한다(기동 때 자동 또는 `mailo-migrate`). 파일마다 트랜잭션이고 `ALTER TABLE`이 `mail_jobs`·`mail_events`에 각각 `ACCESS EXCLUSIVE` 잠금을 잡는다. 두 테이블을 한 파일에서 잠그지 않으려고 파일을 나눴다. 이미 도는 긴 쿼리가 있으면 잠금을 기다리고 `lock_timeout`(기본 10초)을 넘기면 그 파일만 롤백되며 실행기가 실패한다. 다시 실행한다. 대용량 테이블·동시 쓰기 중의 대기 시간은 측정하지 않았다.
3. 모든 Mailo 인스턴스를 새 버전으로 바꾼다. 구버전은 새 상태·이벤트 종류를 쓰지 않으므로 마이그레이션 직후에도 영향이 없다.
4. 호출처가 취소 API를 쓰기 시작한다.

롤링 중(구·신 혼용)에는 취소 API를 쓰지 않는다. 구버전 인스턴스는 `POST /jobs/{jobId}/cancel` 경로가 없어 404를 낸다. 취소로 `CANCELED`가 된 작업을 구버전 인스턴스가 조회·이벤트로 내보내면 `status: "CANCELED"`를 그대로 보이고, 구버전의 `GET /events?type=JOB_CANCELED`는 400이다(코드를 읽어 확인했고 실행하지 않았다). 구버전은 `CANCELED` 행을 점유·만료·결과 기록 대상으로 읽지 않는다.

롤백:

1. 호출처의 취소 API 사용을 먼저 멈춘다.
2. 이전 버전으로 인스턴스를 바꾼다.
3. 마이그레이션은 되돌리지 않는다. `CANCELED` 행과 `JOB_CANCELED` 이벤트가 남으면 옛 `CHECK`를 복원하지 못한다. 새 제약은 옛 값도 모두 허용하므로 이전 버전은 그대로 동작한다. 이전 버전은 `CANCELED` 작업을 조회·이벤트로 그대로 내보낸다. 호출처가 이를 모르는 값으로 처리하는지는 호출처 책임이다.
4. 롤백 중 남은 `CANCELED` 작업은 보존 기간(종결 후 30일)이 지나면 다른 종결 작업과 같이 삭제된다.

```txt
위험도: 중간 (ACCESS EXCLUSIVE 잠금 대기, 되돌릴 수 없는 CHECK 교체)
롤백: 취소 API 사용 중지 후 앱만 이전 버전으로 되돌린다. 스키마는 되돌리지 않는다(되돌리려면 pg_dump 복원)
```

### SMTP 계정 도입 배포 순서

근거: RQ-053~056, ADR-0013 결정 2·4. 구현 묶음 A의 마이그레이션은 `0010`(`mail_jobs.account_id`)·`0011`(`mail_attempts.account_id`)이다. 둘 다 `ADD COLUMN ... NOT NULL DEFAULT 'default'`와 `ADD CONSTRAINT ... NOT VALID`다. 표를 다시 쓰지 않고 백필하지 않는다. 기존 행은 `default`로 보인다. 구버전은 컬럼을 열거해 읽고 쓰므로 새 컬럼을 무시하고, 컬럼 없는 `INSERT`는 `default`가 된다. `0012`~`0016`(계정 단위 점유 인덱스 추가와 기존 점유 인덱스 삭제)은 묶음 B이고 같은 절의 "묶음 B 마이그레이션"에서 다룬다.

1. 마이그레이션 전에 `pg_dump`를 받는다("백업과 복구"). 묶음 B 이미지로 바꾸면 `0010`~`0016`이 한 번에 적용된다(기동 때 자동 또는 `mailo-migrate`, 묶음 A를 이미 배포했다면 `0012`~`0016`만). `0012`~`0016`의 인덱스는 아래 "묶음 B 마이그레이션"이다. `0010`·`0011`은 파일마다 `ALTER TABLE`이 `mail_jobs`·`mail_attempts`에 각각 `ACCESS EXCLUSIVE` 잠금을 잡는다. 150만 행 임시 schema에서는 1.2ms였다(ADR-0013 측정, 로컬 단일 실행). 이미 도는 긴 트랜잭션이 있으면 잠금을 기다리고 `lock_timeout`(기본 10초)을 넘기면 그 파일만 롤백되며 실행기가 실패한다. 다시 실행한다.
2. 모든 Mailo 인스턴스를 새 버전으로 바꾼다. 새 버전은 계정 `default`만으로 현행과 같다. 이 단계가 끝나기 전에 `default`가 아닌 계정의 작업이 생기면 안 된다. 구버전 점유는 `account_id`를 보지 않아 그 작업을 `default` SMTP로 보낸다.
3. 계정 파일(`MAILO_SMTP_ACCOUNTS_FILE`)과 비밀 변수를 모든 인스턴스에 배포하고 재시작한다. 호출처 레지스트리는 아직 그대로다.
4. 호출처 레지스트리에 `accountId`를 넣고 재시작한다. 모든 인스턴스가 3을 마친 뒤에만 한다. 구버전은 `accountId`를 모르는 필드로 거부해 기동하지 못하고, 새 버전도 계정 파일이 없으면 구성에 없는 계정이라 기동하지 못한다. 순서는 "코드 먼저, 레지스트리 나중"이다(ADR-0009 결정 10, ADR-0011 결정 10).
5. 호출처별 전환은 레지스트리 항목 단위로 새 요청에만 적용된다. 이미 등록한 작업은 등록 때 계정으로 나간다. 같은 Key의 재전송은 기존 작업의 계정을 그대로 두고 200이나 409를 돌려준다.

`default`가 아닌 계정은 묶음 B(`0012`~`0016`과 계정 단위 점유)를 배포한 뒤에만 구성한다. 3 이전에 모든 인스턴스가 묶음 B 이상이어야 한다. 묶음 B 이전 버전(묶음 A)은 비`default` 계정이 구성에 있으면 기동을 거부하지만, 그보다 더 이전 버전은 `account_id`를 보지 않는다.

#### 묶음 B 마이그레이션(`0012`~`0016`)

- `0012`·`0013`: 계정 단위 점유 인덱스(`mail_jobs_account_priority_claim_idx`, `mail_jobs_account_claim_idx`). `0014`: 계정 24시간 할당용 `mail_attempts_account_quota_idx`. 셋 다 `CREATE INDEX CONCURRENTLY IF NOT EXISTS`라 쓰기를 막지 않는다. 150만 행 임시 schema에서 328ms·292ms·170ms였다(ADR-0013 측정, 동시 쓰기 없음, 로컬 단일 실행). 동시 쓰기 부하에서의 시간은 측정하지 않았다.
- `0015`·`0016`: 기존 점유 인덱스 `mail_jobs_priority_claim_idx`·`mail_jobs_claim_idx`를 `DROP INDEX CONCURRENTLY IF EXISTS`로 지운다. 새 인덱스와 함께 두면 계획이 기존 인덱스를 고르기 때문이다(ADR-0013 M5). 이번 릴리스의 마지막 마이그레이션이다.
- 파일 일곱이 모두 순서대로 적용된다(컨테이너 기동 때 자동). `-- mailo:no-transaction` 파일이라 실패하면 기록되지 않고 다음 실행에서 다시 시도한다. `CONCURRENTLY`가 실패해 `INVALID` 인덱스가 남으면 실행기가 인덱스 이름을 담아 실패한다. `troubleshooting.md` "등급별 적체"의 "인덱스 복구"를 따른다.
- 롤링 배포 중 영향: 인스턴스가 하나씩 새 버전으로 바뀌는 동안 아직 이전 버전(묶음 A 이전)이 도는 인스턴스는 지워진 인덱스 없이 점유한다. 정확성은 영향받지 않지만 점유와 적체 건수가 대기 건수에 비례해 느려진다(ADR-0013 M8: 대기 25만 건에서 한 쿼리 약 110~150ms, 한 쿼리 측정). 대기 건수가 작으면 무시할 수준이다. 롤링 배포를 실제로 실행해 확인하지 않았다. 대기가 많을 때는 인스턴스를 한꺼번에 바꾼다(짧은 중단을 받아들인다).
- 묶음 B 코드는 새 인덱스가 없으면 점유가 느려질 뿐 동작은 같다. 마이그레이션이 실패하면 앱이 뜨지 않는다.

계정 구성에서 빠진 계정의 작업은 점유되지 않고 만료 sweep이 `EXPIRED`로 만든다(`JOB_EXPIRED` 이벤트). 다른 계정으로 옮기지 않는다. 기동 때 구성 밖 계정의 비종결 작업이 있으면 `account_orphan_jobs`(warn, `accountId`, `count`)를 남긴다.

롤백(이 순서를 지킨다):

1. 레지스트리에서 `accountId`를 빼고 재시작한다. 새 작업은 `default`다. 남기면 구버전이 기동하지 못한다.
2. `default`가 아닌 계정의 비종결 작업이 0이 될 때까지 기다리거나 취소·만료시킨다. 확인 SQL: `SELECT count(*) FROM mail_jobs WHERE account_id <> 'default' AND status IN ('PENDING','RETRY_WAIT','SENDING')`. 남은 채 구버전으로 바꾸면 그 작업이 `default` SMTP로 나간다.
3. 이전 버전으로 인스턴스를 바꾼다.
4. 마이그레이션은 되돌리지 않는다. 컬럼과 제약과 새 인덱스는 구버전이 무시한다. 묶음 B 이전 버전으로 되돌리면 지운 인덱스 둘을 다시 만든다(구버전의 점유가 이 인덱스를 쓴다. 대기 건수에 비례한 느려짐은 정확성에는 영향이 없다).

   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_jobs_claim_idx ON mail_jobs (next_attempt_at, id) WHERE status IN ('PENDING','RETRY_WAIT');
   CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_jobs_priority_claim_idx ON mail_jobs (priority DESC, next_attempt_at, id) WHERE status IN ('PENDING','RETRY_WAIT');
   ```

```txt
위험도: 중간 (0010·0011의 ACCESS EXCLUSIVE 잠금 대기, 0015·0016의 인덱스 삭제로 구버전 점유 성능 저하. 순서를 어기면 default가 아닌 계정의 작업이 default SMTP로 나갈 수 있음)
롤백: 레지스트리의 accountId를 빼고, default가 아닌 계정의 비종결 작업이 0이 된 뒤 앱만 이전 버전으로 되돌리고 지운 인덱스 둘을 다시 만든다. 컬럼과 새 인덱스는 되돌리지 않는다(되돌리려면 pg_dump 복원)
```

## 환경 변수

모든 값은 `loadConfig`(`config/load-config.ts`)가 기동 때 검증한다. 빈 문자열은 설정하지 않은 값으로 본다. 정수는 숫자만 허용한다(`1e3`, 공백 포함 불가, 앞뒤 공백은 제거).
수치 기본값은 모두 설계 시점의 추정이다. `.env.example`의 주석 처리된 값은 이 표의 기본값과 같다(2026-11-23 대조).

### 실행·DB

| 변수 | 기본값 | 범위·형식 | 설명 |
| ---- | ------ | --------- | ---- |
| `NODE_ENV` | `production`(없을 때) | `development`, `test`, `production` | `development`·`test`가 아니면(값이 없어도) 공개 샘플 키와 같은 바이트의 DB 본문 키·지문 키·호출처 JWS 비밀키, 적합성 벡터의 Mailo JWE 개인키, 같은 바이트가 반복된 키, 샘플 DB 비밀번호 `mailo-dev-password`를 거부한다(`key-management.md`). 이전에는 값이 없으면 `development`였다 |
| `MAILO_PORT` | 3000 | 1~65535 | listen 포트. 컨테이너 안은 3000 고정 |
| `MAILO_DATABASE_URL` | 없음(`MAILO_DB_HOST`가 없으면 필수) | `postgres://` 또는 `postgresql://` URL | 시크릿(`_FILE` 지원). 비밀번호는 호출자가 URL 인코딩해야 한다. compose 컨테이너는 비운다 |
| `MAILO_DB_HOST`, `MAILO_DB_PORT`, `MAILO_DB_USER`, `MAILO_DB_PASSWORD`, `MAILO_DB_NAME` | 포트 5432, 나머지 없음 | `MAILO_DB_HOST`를 주면 사용자·DB 이름 필수, 비밀번호 선택 | `MAILO_DATABASE_URL`의 대안. 앱이 URL 인코딩해 조립한다. `MAILO_DB_HOST`는 호스트 이름, IPv4, 대괄호 IPv6(`[::1]`)만 받는다. 포트·경로·공백이 있으면 기동 거부(포트는 `MAILO_DB_PORT`). `MAILO_DB_PASSWORD`는 `_FILE` 지원. `MAILO_DATABASE_URL`과 함께 주면 기동 거부 |
| `MAILO_DB_SSLMODE` | 없음(암호화 설정을 하지 않는다) | `disable`, `require`, `verify-ca`, `verify-full` | `MAILO_DB_HOST` 경로 전용. 값을 pg의 `ssl` 옵션으로 직접 옮긴다(URL `sslmode`는 pg-connection-string이 `require`·`verify-ca`를 `verify-full`처럼 다루고 경고하므로 쓰지 않는다). `require`: 암호화만 하고 인증서를 검증하지 않는다(중간자 공격은 막지 못한다). `verify-ca`: 체인을 CA로 검증하고 호스트 이름은 보지 않는다. 호스트 이름을 보지 않으므로 `MAILO_DB_SSLROOTCERT_FILE` 없이 쓰면 기동을 거부한다(공개 CA에서 인증서를 받은 누구나 DB 연결을 가로챌 수 있다). `verify-full`: 체인과 호스트 이름을 모두 검증한다(권장). `MAILO_DATABASE_URL`과 함께 주면 기동 거부(그 경로는 URL의 `sslmode` 매개변수를 pg가 해석한다) |
| `MAILO_DB_SSLROOTCERT_FILE` | 없음(`verify-full`만 Node 기본 CA, `verify-ca`는 필수) | PEM 파일 경로 | `verify-ca`·`verify-full`에서 서버 인증서를 검증할 CA. 다른 모드와 함께 주면 기동 거부. 파일을 읽지 못하면 변수 이름과 errno만 알린다 |
| `MAILO_DB_ALLOW_INSECURE` | `false` | `true`, `false` | production(`NODE_ENV`가 development·test가 아님)에서 DB 호스트가 원격인데 `MAILO_DB_SSLMODE`가 없거나 `disable`이면 기동을 거부한다. `true`면 거부하지 않는다. 원격 판정: 점 없는 단일 라벨(compose 서비스 이름 `postgres`), `localhost`, 루프백(`127.x`, `::1`)은 로컬이고 그 밖(FQDN, 10/8·192.168/16 같은 사설 IP 포함)은 원격이다. `MAILO_DATABASE_URL`이면 pg가 계산한 접속 값(`pg.Client`의 `connectionParameters`의 `host`와 `ssl`)으로 판정한다. 호스트는 `?host=`가 URL의 호스트보다 우선하고 `/`로 시작하면(유닉스 소켓) 로컬이다. `ssl=true`·`ssl=1`·`sslmode`(`disable` 제외)·`sslnegotiation=direct`는 암호화이고 `ssl=0`·`sslmode=disable`은 아니다. `ssl=false`는 pg가 TLS를 요청하는 값이라 암호화로 본다. `hostaddr`는 pg 8.23.1이 접속에 쓰지 않아 보지 않는다. pg가 이 값을 주지 못하면(pg 버전 변경) production에서 기동을 거부한다 |
| `MAILO_INSTANCE_ID` | 호스트 이름(컨테이너에서는 컨테이너 ID) | 영문·숫자로 시작, 영문·숫자·`.`·`_`·`-`, 64자 이하 | 로그 줄의 `instance` 값. 컨테이너를 다시 만들어도 같은 이름이 필요하면 지정한다. 인스턴스를 가르는 용도이고 DB에는 쓰지 않는다 |
| `MAILO_DB_POOL_MAX` | 10 | 1~200, `MAILO_WORKER_CONCURRENCY` + 4 이상 | 커넥션 풀 최대 수. 어기면 기동 거부 |
| `MAILO_DB_CONNECT_TIMEOUT_MS` | 5000 | 100~60000 | 연결 대기. `MAILO_DB_QUERY_TIMEOUT_MS`와의 합이 `MAILO_LEASE_SECONDS` − 10초 미만이어야 한다(아래 표) |
| `MAILO_DB_STATEMENT_TIMEOUT_MS` | 30000 | 1000~3600000 | 서버가 쿼리 하나에 허용하는 시간(`statement_timeout`). 넘으면 서버가 취소한다(SQLSTATE 57014) |
| `MAILO_DB_LOCK_TIMEOUT_MS` | 10000 | 1000~3600000 | 잠금 대기 상한(`lock_timeout`, 55P03). 앱 풀에만 적용한다. 마이그레이션 CLI는 이 변수를 읽지 않고 10초로 고정이다 |
| `MAILO_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 60000 | 1000~3600000 | 트랜잭션을 열고 쿼리 없이 머무는 상한(`idle_in_transaction_session_timeout`). 넘으면 서버가 연결을 끊는다(25P03) |
| `MAILO_DB_QUERY_TIMEOUT_MS` | 35000 | 1000~3600000, `STATEMENT` 초과 | 클라이언트(pg `query_timeout`)의 응답 대기 상한. 서버가 응답하지 않는 단절을 끊는다 |
| `MAILO_OPS_TOKEN` | 없음(꺼짐) | 공백 없는 32자 이상 | 읽기 토큰. 시크릿(`_FILE` 지원). `GET /health/ready`의 운영자 응답과 `GET /ops/*`를 연다. 호출처 API 키로는 볼 수 없다. 업무 endpoint에는 쓸 수 없다(401) |
| `MAILO_OPS_ADMIN_NAMES` | 없음(관리 기능 꺼짐) | 쉼표 구분 이름 최대 8개. 이름은 `[a-z][a-z0-9]{0,31}` | 관리 토큰 이름. 이름은 감사 기록의 `actor`가 된다. 형식 위반, 중복, 9개 이상은 기동을 거부한다. 값이 없으면 `/ops`의 변경 endpoint는 읽기 토큰에 403, 그 밖에 401이다 |
| `MAILO_OPS_ADMIN_TOKEN_<이름 대문자>` | 이름 목록에 있으면 필수 | 공백 없는 32자 이상 | 이름마다 하나의 관리 토큰. 시크릿(`_FILE` 우선). 예: 이름 `oncall`은 `MAILO_OPS_ADMIN_TOKEN_ONCALL`. 읽기 권한을 포함한다. 이름 목록에 있는 이름의 토큰이 없거나 규칙에 어긋나면, 토큰 값이 읽기 토큰·다른 관리 토큰과 같으면, 호출처 API 키와 같으면 기동을 거부한다. 이름 목록에 없는 이름의 변수는 읽지 않는다 |
| `MAILO_METRICS_CACHE_SECONDS` | 5 | 1~60 | `GET /metrics`의 전역 gauge가 DB 수집 결과를 다시 쓰는 시간 초. 인스턴스당 DB 조회는 이 시간마다 최대 1회다. 기본값은 추정이다. 두 인스턴스의 값은 이 시간만큼 어긋날 수 있으므로 알림 규칙의 `for:`는 이보다 충분히 길게 쓴다("지표") |
| `MAILO_STOP_GRACE_PERIOD` | 없음(검사 안 함). compose는 `150s`를 넣는다 | `150s`, `2m30s`, `1h`(h·m·s·ms 조합) | 컨테이너 `stop_grace_period`와 같은 값. 있으면 drain 상한 + 10초 이상인지 기동 때 검사한다 |
| `MAILO_CALLERS_FILE` | 없음(필수) | 파일 경로 | 호출처 레지스트리 JSON. 기동 때 한 번 읽는다(핫 리로드 없음) |
| `MAILO_SECRET_ADAPTERS` | 없음(어댑터를 불러오지 않는다) | 쉼표 구분 bare 패키지 이름. 경로·URL·`node:` 접두·하위 경로·대문자는 거부 | `X_REF`를 해석할 어댑터 패키지(ADR-0016 결정 3). 어댑터 패키지는 이 저장소가 이미지에 넣은 것만 쓴다. 비밀이 아니다. "외부 시크릿 소스(`X_REF`)" |
| `MAILO_SECRET_RESOLVE_TIMEOUT_MS` | 10000(추정) | 100~60000 | `X_REF` 해석 1건과 어댑터 `import()` 1건의 제한 시간. 어기면 어댑터를 불러오기 전에 기동을 거부한다. 비밀이 아니다 |

### 입력 상한(RQ-030)

| 변수 | 기본값 | 범위 | 설명 |
| ---- | ------ | ---- | ---- |
| `MAILO_MAX_REQUEST_BYTES` | 2097152 (2 MiB) | 1024~64 MiB | 원시 요청(HTTP 본문) 상한 |
| `MAILO_MAX_CONTENT_BYTES` | 1048576 (1 MiB) | 1~64 MiB, `MAILO_MAX_REQUEST_BYTES` 이하 | 복호화 뒤 제목+text+html 합(UTF-8 바이트) |
| `MAILO_MAX_RECIPIENTS` | 50 | 1~100 | to+cc+bcc 합 |

### 큐·Worker·재시도(RQ-008)

| 변수 | 기본값 | 범위 | 설명 |
| ---- | ------ | ---- | ---- |
| `MAILO_JOB_EXPIRY_SECONDS` | 86400 | 1~31536000 | 요청이 `ttlSeconds`를 생략한 새 작업의 만료 TTL |
| `MAILO_JOB_EXPIRY_MAX_SECONDS` | `MAILO_JOB_EXPIRY_SECONDS`의 값 | 1~31536000, `MAILO_JOB_EXPIRY_SECONDS` 이상, `MAILO_RECORD_RETENTION_SECONDS` 이하 | 요청 `ttlSeconds`의 상한(RQ-039). 하한 60은 고정이다. 60 미만이면 `ttlSeconds`를 지정한 요청은 모두 400 `OUT_OF_RANGE`다. 늘리면 대기 작업이 남을 수 있는 기간이 늘어난다(긴 상한의 점유 지연은 미측정, ADR-0010 "결과"). 범위 밖·정수 아님·제약 위반은 기동 실패 |
| `MAILO_LEASE_SECONDS` | 120 | 5~86400 | 작업 점유 lease. `stop_grace_period`와 연동 |
| `MAILO_WORKER_POLL_MS` | 1000 | 50~600000 | claim 폴링 간격(±10% 흩뿌림) |
| `MAILO_WORKER_CONCURRENCY` | 4 | 1~100 | 동시 전송 수 |
| `MAILO_CLAIM_FIFO_RATIO` | 0.1 | 0 이상 1 이하(소수 가능) | claim 호출이 우선순위를 무시하고 가장 오래 기다린 순서로 고를 확률(RQ-035). 기본값은 추정이다. 0이면 항상 우선순위 순서, 1이면 항상 대기 순서다. 작업 건수가 아니라 claim 호출 수 기준이라 작업 건수 비율은 정확히 이 값이 아니다. 범위 밖·숫자 아님은 기동 실패 |
| `MAILO_RETRY_MAX_ATTEMPTS` | 8 | 1~100 | 첫 시도 포함. 계정 상태 오류 시도는 제외 |
| `MAILO_RETRY_MODE` | `exponential` | `exponential`, `fixed` | |
| `MAILO_RETRY_BASE_SECONDS` | 60 | 1~86400 | |
| `MAILO_RETRY_MULTIPLIER` | 2 | 1~10 (소수 가능) | |
| `MAILO_RETRY_CAP_SECONDS` | 3600 | 1~604800, `BASE` 이상 | |
| `MAILO_RETRY_JITTER_RATIO` | 0.2 | 0 이상 1 미만 | ±비율 |

코드에 환경 변수가 없는 값: 독성 작업 최대 시도 3회(`poisonMaxAttempts`), 배치 크기(sweep 1000, `MAINTENANCE_BATCH_SIZE`), 차단기 키 `default`.

### 전역 SMTP 차단기(ADR-0007 결정 4·5)

| 변수 | 기본값 | 범위 | 설명 |
| ---- | ------ | ---- | ---- |
| `MAILO_BREAKER_FAILURE_THRESHOLD` | 3 | 1~1000 | `open`으로 가는 연속 계정 오류 수. 한도 초과(일일·순간)는 즉시 open이다 |
| `MAILO_BREAKER_CAP_FLOOR_SECONDS` | 1800 | 1~604800 | open 대기 상한 = `max(이 값, 해당 사유의 초기값)` |
| `MAILO_BREAKER_MAX_ACCOUNT_TRIPS` | 3 | 1~100 | 같은 작업이 차단기를 연 횟수 한도 |
| `MAILO_BREAKER_WAIT_DAILY_LIMIT_SECONDS` | 3600 | 1~604800 | 사유별 open 초기 대기 |
| `MAILO_BREAKER_WAIT_RATE_LIMIT_SECONDS` | 300 | 1~604800 | |
| `MAILO_BREAKER_WAIT_CONNECTION_SECONDS` | 60 | 1~604800 | |
| `MAILO_BREAKER_WAIT_TLS_SECONDS` | 60 | 1~604800 | |
| `MAILO_BREAKER_WAIT_AUTH_SECONDS` | 60 | 1~604800 | |
| `MAILO_BREAKER_WAIT_OTHER_SECONDS` | 60 | 1~604800 | |

### 보존(ADR-0005 결정 7, ADR-0008 결정 7)

| 변수 | 기본값 | 범위 | 설명 |
| ---- | ------ | ---- | ---- |
| `MAILO_BODY_RETENTION_SECONDS` | 86400 | 1~31536000 | 종결 전이가 본문을 바로 비우므로(RQ-071) 이전 버전이 종결한 행의 본문 삭제 유예(안전망) |
| `MAILO_RECORD_RETENTION_SECONDS` | 2592000 (30일) | 1~31536000 | 종결 후 작업 행·시도·이벤트·Key 보존, 거부 기록은 생성 후. `BODY` 이상이고 `JOB_EXPIRY_MAX` 이상이어야 한다 |
| `MAILO_RECIPIENT_RETENTION_SECONDS` | 604800 (7일, 추정) | 60~31536000, `MAILO_RECORD_RETENTION_SECONDS` 이하 | 이벤트·시도의 수신자(`mail_events.recipients`·`rejected_recipients`, `mail_attempts.rejected_recipients`)를 비우기까지의 유예(RQ-072, ADR-0015 결정 3). 유예 뒤 이벤트 응답은 `recipientsRedacted: true`와 빈 수신자 목록을 낸다. 보존 기간과 같으면 끄는 것과 같다. 이 변수를 주지 않았고 `MAILO_RECORD_RETENTION_SECONDS`가 7일보다 짧으면 기본값을 그 보존 기간으로 줄인다. 명시한 값이 범위 밖이거나 보존 기간을 넘으면 기동 실패. 값을 줄이면 이미 비운 이벤트는 그대로이고 다음 사이클부터 새 유예가 적용된다. 롤링 배포 중에는 `MAILO_RECORD_RETENTION_SECONDS`와 같게 두고 구버전이 모두 사라진 뒤 줄인다("기동 순서와 마이그레이션"). 호출처가 이벤트를 읽는 간격보다 짧게 두지 않는다(호출처가 빈 수신자를 받는다) |
| `MAILO_MAINTENANCE_INTERVAL_SECONDS` | 60 | 1~86400 | 만료 sweep·lease 회수·본문 삭제·보존 삭제·수신자 비움 주기 |

### SMTP(RQ-005)

| 변수 | 기본값 | 범위·형식 | 설명 |
| ---- | ------ | --------- | ---- |
| `MAILO_SMTP_HOST` | 없음(`MAILO_SMTP_ACCOUNTS_FILE`이 없으면 필수) | 호스트 이름 | `default` 계정의 호스트. 아래 "SMTP 계정"이 `MAILO_SMTP_*`와 계정 파일의 관계를 정한다 |
| `MAILO_SMTP_SECURITY` | `starttls` | `starttls`, `tls`, `none` | `starttls`는 587 + STARTTLS 필수, `tls`는 465 implicit TLS, `none`은 TLS 없는 평문 연결(아래 "평문 SMTP 모드"). 인증서 검증 해제는 없다 |
| `MAILO_SMTP_PORT` | 587 (`tls`면 465) | 1~65535 | `none`도 기본 587이다 |
| `MAILO_SMTP_USER` | 없음 | 문자열 | `MAILO_SMTP_PASSWORD`와 함께 설정하거나 둘 다 비운다(IP 허용 릴레이) |
| `MAILO_SMTP_PASSWORD` | 없음 | 시크릿(`_FILE` 지원) | |
| `MAILO_SMTP_FROM` | `MAILO_SMTP_USER` | 주소 하나 | `default` 계정의 기본 발신 주소. 요청이 `from`을 생략할 때의 발신 주소이자 `default` 계정을 쓰는 호출처가 쓸 수 있는 발신 주소다. 그 밖의 `from`은 호출처의 `allowedFrom`(`callers.json`)에 있어야 하고 없으면 400 `FROM_NOT_ALLOWED`다(ADR-0008 구현 중 확정 12, ADR-0013 결정 6). USER도 없으면 필수 |
| `MAILO_SMTP_TIMEOUT_SECONDS` | 30 | 1~3600, `MAILO_LEASE_SECONDS` 미만. 기동 조건은 더 엄격하다(아래 표) | 소켓 무응답 상한. 연결·greeting·DNS는 이 값과 10초 중 작은 값, 한 건 전체 마감은 `min(이 값×3, lease−10초)` |
| `MAILO_SMTP_ACCOUNTS_FILE` | 없음 | 파일 경로 | SMTP 계정 정의 JSON(RQ-053, ADR-0013 결정 1). 아래 "SMTP 계정" |
| `MAILO_SMTP_SECRET_<이름>` / `_FILE` | 계정 파일이 가리킬 때 필수 | 시크릿(`_FILE` 우선) | 계정 파일의 `auth.secretVar`가 가리키는 계정 비밀번호. 이름은 `^MAILO_SMTP_SECRET_[A-Z0-9_]{1,40}$`이고 `_FILE`로 끝날 수 없다. 두 계정이 같은 변수를 쓸 수 없다 |

#### SMTP 계정

근거: RQ-053, ADR-0013 결정 1. 계정은 호출처가 쓰는 SMTP 연결과 기본 발신 주소의 묶음이다. 계정 ID는 운영자가 정한 불투명 이름이다. SMTP 사용자 주소를 로그·지표·감사에 쓰지 않으려고 주소 형태(`@`, `.`)를 ID로 받지 않는다.

`default` 계정의 출처는 아래 넷 중 하나다. 환경 변수와 파일이 모두 `default`를 정의하면 기동을 거부한다.

| 상태 | 동작 |
| ---- | ---- |
| `MAILO_SMTP_ACCOUNTS_FILE` 없음 | `MAILO_SMTP_*`가 `default` 하나를 정의한다. `MAILO_SMTP_HOST`가 필수다. 단일 계정 배포는 변경 없이 동작한다 |
| 파일 있음, `MAILO_SMTP_HOST` 있음 | `default`는 환경 변수 정의다. 파일에 `id: "default"`가 있으면 기동을 거부한다. 파일 계정이 뒤따른다 |
| 파일 있음, `MAILO_SMTP_HOST` 없음 | `default`는 파일에 있으면 그것이고 없으면 `default` 계정이 없다. 이때 `MAILO_SMTP_USER`·`PASSWORD`(`_FILE`)·`FROM`·`PORT`·`SECURITY`가 있으면 오설정으로 거부한다. `MAILO_SMTP_TIMEOUT_SECONDS`는 계정 공통 기본값이라 둘 수 있다 |
| 파일 없음, `MAILO_SMTP_HOST` 없음 | 기동을 거부한다 |

환경 변수로 정의한 `default`는 `sendQuota24h`·`concurrency`를 받지 않는다. 필요하면 `default`를 파일로 옮긴다. 이때 비밀 변수 이름을 `MAILO_SMTP_SECRET_*`로 바꿔 시크릿 파일 이름을 맞춘다.

계정 파일 형식(값은 가짜다):

```json
{
  "accounts": [
    {
      "id": "marketing",
      "host": "smtp.gmail.com",
      "port": 587,
      "security": "starttls",
      "auth": { "user": "marketing@example.com", "secretVar": "MAILO_SMTP_SECRET_MARKETING" },
      "from": "marketing@example.com",
      "timeoutSeconds": 30
    }
  ]
}
```

| 필드 | 필수 | 규칙 |
| ---- | ---- | ---- |
| `id` | 필수 | `^[a-z0-9][a-z0-9_-]{0,31}$`. `unregistered`는 예약어다. 파일 안에서 겹칠 수 없다 |
| `host` | 필수 | 호스트 이름 |
| `port` | 선택 | 1~65535. 기본은 `security`가 `tls`면 465, 아니면 587 |
| `security` | 선택 | `starttls`·`tls`·`none`. 기본 `starttls`. `none`이면 기동 때 `smtp_plaintext_enabled`(warn)에 `accountId`가 붙는다(위험은 "평문 SMTP 모드"와 같다) |
| `auth` | 선택 | `user`와 `secretVar` 쌍. 생략하면 인증 없는 릴레이다. `user`는 주소가 아닌 값도 받는다 |
| `from` | 조건부 | 주소 하나. 생략하면 `auth.user`를 쓰고, `auth`가 없거나 `user`가 주소가 아니면 거부한다 |
| `timeoutSeconds` | 선택 | 1~3600이고 `MAILO_LEASE_SECONDS` 미만. 생략하면 `MAILO_SMTP_TIMEOUT_SECONDS`(기본 30) |
| `sendQuota24h`, `concurrency` | 선택 | 로더가 형식을 검증하고 Worker가 점유에 쓴다(아래 "계정 단위 점유"). `default`를 환경 변수로 정의하면 쓸 수 없다 |

- 모르는 필드와 최상위의 `accounts` 밖 필드는 기동을 거부한다. 파일에는 비밀번호 값을 두지 않는다. 비밀 변수 이름만 둔다(호출처 레지스트리의 JWS 키와 같은 방식).
- 비밀번호는 `<변수>_FILE`(우선) 또는 `<변수>`로 받는다. `_FILE`이 있으면 파일을 읽지 못해도 환경 변수로 돌아가지 않고 기동을 거부한다.
- 같은 `(host, port, user)`(대소문자 무시)를 가진 인증 계정이 둘이면 거부한다. 같은 메일박스를 차단기 둘로 쪼개는 오설정이다. 인증 없는 릴레이는 `user`가 없어 이 검사에서 뺀다.
- 계정 수는 환경 변수 `default`를 포함해 20개 이하(추정)이고 `MAILO_WORKER_CONCURRENCY` 이하여야 한다. 한 계정에 슬롯 하나를 보장하려는 조건이다.
- 오류 메시지에는 위치(`accounts[2].auth.secretVar`)와 고정 사유만 담는다. host·user·from·비밀번호 값은 담지 않는다(RQ-027).
- 변경은 재시작 뒤 반영된다. 핫 리로드는 없다.
- 어느 호출처도 참조하지 않는 계정은 허용한다. 기동 로그 `account_unused`(info, `accountId`)를 남긴다.
- 서로 다른 계정이 같은 `from`을 가질 수 있다. 그 주소는 두 계정을 쓰는 호출처 모두의 허용 발신 주소 집합에 들어간다(집합이 합쳐진다). 코드는 이를 막지 않는다.

계정 단위 점유(구현 묶음 B)와 한계:

- 점유·차단기·정지·24시간 할당이 계정 단위다. 한 계정의 차단기 `open`이나 SMTP 지연이 다른 계정의 발송을 막지 않는다. 차단기 임계값과 대기 시간은 모든 계정이 공유하는 `MAILO_BREAKER_*` 값이다.
- Worker는 `MAILO_WORKER_CONCURRENCY`(C)를 계정에 나눈다. 계정마다 한 인스턴스가 동시에 쓰는 슬롯 상한 `cap_a`는 계정의 `concurrency`이고 생략하면 `max(1, C − (N − 1))`이다(N은 계정 수). C=4, N=2이면 한 계정은 3슬롯이다. 상한은 인스턴스별이라 계정 하나의 전체 동시 전송 수는 인스턴스 수 × `cap_a` 이하다. 다른 계정이 한가해도 `cap_a`를 넘지 못한다. 처리량이 필요하면 C를 올리거나 `concurrency`를 준다. 계정 수가 C보다 많으면 기동을 거부한다.
- `sendQuota24h`가 있는 계정은 최근 24시간의 시도 수와 점유 중 수가 한도에 닿으면 점유를 멈춘다(대표 작업 포함, 시도가 24시간 밖으로 밀려나면 재개). 단위는 메시지 시도 수이고 수신자 수로 가중하지 않는다. 인스턴스가 여럿이고 `sendQuota24h`가 있는 계정은 다른 인스턴스가 계정 advisory lock을 잡고 있으면 그 인스턴스의 이번 점유를 건너뛰고 다음 poll(`MAILO_WORKER_POLL_MS` 안팎)까지 기다리므로 점유가 지연될 수 있다(부하를 측정하지 않았다). 호출처 `sendQuota24h`와 함께 걸리면 더 작은 쪽이다. 계정 할당을 쓰면 `MAILO_RECORD_RETENTION_SECONDS`가 24시간 이상이어야 한다(미만이면 기동 실패). 인스턴스가 여럿이어도 계정 advisory lock으로 초과하지 않는다(통합 테스트는 한 인스턴스 안의 동시 호출 12개로 확인했다).
- 계정 정지는 `mail_send_controls`의 `scope_type = 'account'` 행을 점유가 읽어 그 계정을 멈춘다. 쓰고 지우는 방법은 `PUT`·`DELETE /ops/pauses/accounts/{accountId}`와 CLI `pause|resume --account <id> --yes`다("발송 정지와 운영 REST"). 구버전은 `account` 범위를 읽지 않는다. 계정 정지에 기대어 롤백하지 않는다.
- 새 로그: `account_quota_exceeded`·`account_quota_recovered`, `send_paused`·`send_resumed`의 `scope: "account"`, `claim_failed`의 `accountId`, `worker_started`의 `accounts`. 모두 계정 ID와 한도 수치만 싣는다. `account_limits_not_enforced`는 없다.
- `/health/ready`의 `queue.dueCount`는 구성한 계정별 값(각각 10000에서 멈춤)의 합이다. 합이 10000을 넘으면 10000으로 자르고 `dueCountTruncated`를 true로 둔다(계약의 상한 10000 유지, 등급별 값도 같다). `dueCountTruncated`는 어느 한 계정이라도 상한에 닿았거나 합이 상한을 넘었는지다. 구성에서 빠진 계정의 작업은 점유되지 않아 세지 않는다.
- 계정별 상태는 `GET /ops/accounts`(CLI `accounts list`)가 낸다. 계정마다 `breaker`(`state`·`openUntil`·`lastReason`), `paused`, `sendQuota24h`(`limit`·`used`, 한도가 없으면 `null`), `queue`(`dueCount`·`dueCountTruncated`·`oldestDueAgeSeconds`)다. host·user·`from`·비밀번호는 없다. 구성에서 빠진 계정은 목록에 없고 그 계정의 정지 행은 `GET /ops/pauses`에 있다. 구성한 계정의 차단기 행이 없으면 503이다(Worker 기동이 행을 만든다).
- `/metrics`의 `account_id` 라벨은 구성한 계정 ID와 `unregistered`(구성에서 빠진 계정의 작업이 만료 sweep으로 종결될 때)뿐이다. 계정마다 큐·차단기 시리즈를 낸다("지표"). 호출처 동시 상한(`maxConcurrentSends`)은 묶음 D이고 아직 없다.

#### 평문 SMTP 모드

```txt
위험도: 높음
롤백: MAILO_SMTP_SECURITY를 starttls 또는 tls로 바꾸고 재시작한다
```

- `MAILO_SMTP_SECURITY=none`이면 SMTP 인증 정보와 메일(본문·제목·수신자)이 암호화 없이 전송된다. 사용 판단은 운영자 책임이다.
- 모든 `NODE_ENV`에서 받는다. 기본값은 `starttls`이고, `none`은 명시해야만 쓰인다.
- 서버가 STARTTLS를 광고해도 TLS로 올리지 않는다(nodemailer `ignoreTLS: true`).
- `MAILO_SMTP_USER`·`MAILO_SMTP_PASSWORD`가 있으면 평문으로 인증한다. 평문으로 보낸 인증 정보는 노출된 것으로 보고, 운영 계정에 쓰지 않는다. 썼다면 교체한다.
- 기동 때 Worker가 평문 계정마다 warn 로그 `smtp_plaintext_enabled`를 한 줄 남긴다. 필드는 `accountId`, `auth`(인증 정보 사용 여부)와 고정 문구 `message`뿐이고 호스트·사용자·비밀번호는 없다.
- implicit TLS 포트(465)에 `none`으로 붙으면 TLS로 대체하지 않고 실패한다.
- 규칙 고정 테스트: `config/load-config.spec.ts`, `smtp/sender.spec.ts`, `worker/worker.spec.ts`, `e2e/smtp-plaintext.integration-spec.ts`.

### 키·봉투(ADR-0005 결정 3, ADR-0008)

| 변수 | 기본값 | 설명 |
| ---- | ------ | ---- |
| `MAILO_DB_ENCRYPTION_KEY_VERSION` | 1 | 새로 쓰는 DB 본문 키 버전(1~2147483647) |
| `MAILO_DB_ENCRYPTION_KEY_V<n>` / `_V<n>_FILE` | `V<현재 버전>` 필수 | 버전 n의 키. 32바이트 base64 또는 64자 hex |
| `MAILO_FINGERPRINT_KEY_VERSION` | 1 | 지문 키 현재 버전 |
| `MAILO_FINGERPRINT_KEY_V<n>` / `_V<n>_FILE` | `V<현재 버전>` 필수 | 같은 형식. DB 본문 키와 같은 값이면 기동 거부 |
| `MAILO_ENVELOPE_KEYS_FILE` | 없음 | JWE 개인키 목록 JSON 경로. 없으면 모든 JWE `content`가 `KID_UNKNOWN`이다 |
| `MAILO_JWE_KEY_<이름>` / `_FILE` | | 개인키 PEM. 변수 이름은 키 목록 JSON의 `privateKeyVar`가 정한다 |
| `MAILO_JWS_SECRET_<이름>` / `_FILE` | | 호출처 JWS 비밀키. 변수 이름은 `callers.json`의 `secretVar`가 정한다 |
| `MAILO_JWS_IAT_MAX_AGE_SECONDS` | 604800 (7일) | 1~31536000. JWS `iat` 허용 기간 |
| `MAILO_JWS_IAT_SKEW_SECONDS` | 300 | 0~3600. 미래 방향 허용 오차. `MAX_AGE + SKEW`가 `MAILO_RECORD_RETENTION_SECONDS` 이하여야 한다 |

### 파일 채널(ADR-0004)

| 변수 | 기본값 | 범위 | 설명 |
| ---- | ------ | ---- | ---- |
| `MAILO_FILE_CHANNEL_ROOT` | 없음(꺼짐) | 절대 경로 | 있을 때만 폴러가 켜진다. `<root>`가 읽을 수 있는 디렉터리가 아니거나 `<root>/inbox`가 없거나 통과할 수 없으면 기동 실패. 호출처 폴더 하나가 없는 것은 경고 |
| `MAILO_FILE_POLL_INTERVAL_MS` | 30000 | 50~3600000 | 폴링 간격(±10%) |
| `MAILO_FILE_BATCH_PER_CALLER` | 100 | 1~10000 | 폴링 한 번에 호출처 하나가 처리하는 파일 수 |
| `MAILO_FILE_MAX_BYTES` | `MAILO_MAX_REQUEST_BYTES` | 1024~64 MiB | 파일 원시 바이트 상한 |
| `MAILO_FILE_TEMP_MAX_AGE_SECONDS` | 3600 | 1~31536000 | 점(.) 임시 파일 삭제 기준(mtime과 Mailo 시계 차이) |

### 운영 CLI(Mailo 서버 설정 아님)

`node dist/cli.js`만 읽는 변수다. 서버의 `MAILO_OPS_*` 변수는 읽지 않는다. 자세한 사용은 "운영 CLI"다.

| 변수 | 기본값 | 설명 |
| ---- | ------ | ---- |
| `MAILO_CLI_TOKEN_FILE` | 없음 | 토큰 파일 경로(우선). 끝의 공백·줄바꿈은 지운다. 읽지 못하면 환경 변수로 넘어가지 않고 종료 코드 1이다 |
| `MAILO_CLI_TOKEN` | 없음 | 토큰 값. 파일 변수가 없을 때만 쓴다. 명령줄 인자로는 받지 않는다 |
| `MAILO_CLI_URL` | `http://127.0.0.1:<MAILO_PORT>` | 접속 주소. `http`·`https`, 사용자 정보·쿼리·해시 없음. `MAILO_PORT`는 CLI 프로세스의 환경 값이고 기본 3000이다 |

### compose 전용(Mailo 설정 아님)

`POSTGRES_USER`(`mailo`), `POSTGRES_PASSWORD`(기본값 없음, 필수), `POSTGRES_DB`(`mailo`), `MAILO_STOP_GRACE_PERIOD`(`150s`, 앱도 읽는다), `MAILO_PUBLISH_HOST`(127.0.0.1), `MAILO_PUBLISH_PORT`(3000), `MAILO_DB_PUBLISH_PORT`(5432). 컨테이너 밖 Node가 읽는 `NODE_EXTRA_CA_CERTS`는 로컬 SMTP 서버 검증용 CA에 쓴다(AGENTS.md).

### 변수 사이의 제약

| 제약 | 어기면 |
| ---- | ------ |
| `MAILO_SMTP_TIMEOUT_SECONDS` < `MAILO_LEASE_SECONDS` | 기동 실패(설정 오류). 이 검사만 통과해도 발송기 조립에서 `SmtpConfigError code=TIMEOUT_EXCEEDS_LEASE`로 실패할 수 있다. 조건은 `2×min(T,10초) + T + 10초 ≤ lease`(T = 이 변수)이고 기본값(T=30)은 lease 60초 이상이다. 실행으로 확인: lease 20초·T 10초는 `TIMEOUT_EXCEEDS_LEASE`, lease 45초·T 10초는 기동(단 DB 시간제한 기본값에서는 lease 51초 이상이어야 하므로 `scripts/container/common.sh`는 `MAILO_DB_QUERY_TIMEOUT_MS`를 15000으로 줄인다) |
| `MAILO_MAX_CONTENT_BYTES` ≤ `MAILO_MAX_REQUEST_BYTES` | 기동 실패 |
| `MAILO_RETRY_CAP_SECONDS` ≥ `MAILO_RETRY_BASE_SECONDS` | 기동 실패 |
| `MAILO_RECORD_RETENTION_SECONDS` ≥ `MAILO_BODY_RETENTION_SECONDS`, ≥ `MAILO_JOB_EXPIRY_MAX_SECONDS`(생략하면 `MAILO_JOB_EXPIRY_SECONDS`) | 기동 실패. 요청이 상한까지 TTL을 늘릴 수 있어서 기준이 상한이다(ADR-0010 결정 6) |
| `MAILO_RECIPIENT_RETENTION_SECONDS` ≤ `MAILO_RECORD_RETENTION_SECONDS` | 기동 실패. 이 변수를 생략한 경우는 기본값(7일)을 보존 기간으로 줄여 통과한다 |
| `MAILO_JOB_EXPIRY_SECONDS` ≤ `MAILO_JOB_EXPIRY_MAX_SECONDS` | 기동 실패 |
| `MAILO_JWS_IAT_MAX_AGE_SECONDS` + `MAILO_JWS_IAT_SKEW_SECONDS` ≤ `MAILO_RECORD_RETENTION_SECONDS` | 기동 실패 |
| DB 본문 키 ≠ 지문 키(모든 버전 쌍) | 기동 실패 |
| 현재 버전 키 변수가 있어야 한다 | 기동 실패 |
| `MAILO_STOP_GRACE_PERIOD` ≥ drain 상한 + 10초(`max(1초, lease − 10초) + 10초`) | `MAILO_STOP_GRACE_PERIOD`가 설정된 경우에만 기동 실패. 변수가 없으면(앱이 오케스트레이터 설정을 알 수 없는 환경) 검사하지 않는다. 어기면 종료 때 SIGKILL이 먼저 와서 진행 중 전송이 lease 회수로 재발송될 수 있다 |
| `MAILO_DB_POOL_MAX` ≥ `MAILO_WORKER_CONCURRENCY` + 4 | 기동 실패. 전송이 끝난 작업마다 결과 기록에 커넥션 1개가 필요하고, 점유·주기 작업·HTTP·헬스·파일 폴러 몫으로 4개를 남긴다(4는 추정). 풀이 모자라면 기록이 대기하다 lease가 만료돼 중복 발송이 된다 |
| `MAILO_DB_QUERY_TIMEOUT_MS` > `MAILO_DB_STATEMENT_TIMEOUT_MS` | 기동 실패. 서버가 먼저 쿼리를 취소해야 연결이 살아남는다 |
| `MAILO_DB_CONNECT_TIMEOUT_MS` + `MAILO_DB_QUERY_TIMEOUT_MS` < `MAILO_LEASE_SECONDS` × 1000 − 10000 | 기동 실패. 결과 기록 시도 하나는 연결을 기다린 뒤 응답 없는 쿼리를 최대 이 시간까지 기다린다. 기록 재시도는 다음 시도의 시작 시각에 이 합을 더해도 lease 마감(lease − 10초) 안일 때만 한다. 기본값은 5초 + 35초 = 40초이고 lease 120초에서 통과한다(lease 50초 이하는 거부). 한 트랜잭션의 여러 문장이 각각 `query_timeout` 가까이 걸리는 경우까지는 막지 못한다 |
| 호출처 `sendQuota24h`가 있으면 `MAILO_RECORD_RETENTION_SECONDS` ≥ 86400 | Worker 기동 실패(`invalid worker option (field=callerQuotas.retention)`). 사용량은 최근 24시간의 `mail_attempts`를 세는데 기록이 그 전에 지워지면 할당이 느슨해진다(RQ-032) |
| 계정 파일의 계정 수(환경 변수 `default` 포함) ≤ 20, ≤ `MAILO_WORKER_CONCURRENCY` | 기동 실패(설정 오류). 계정마다 슬롯 하나를 보장하려는 조건이다(ADR-0013 결정 1) |
| 계정의 `timeoutSeconds`(생략하면 `MAILO_SMTP_TIMEOUT_SECONDS`) < `MAILO_LEASE_SECONDS` | 기동 실패. 계정마다 위 `MAILO_SMTP_TIMEOUT_SECONDS` 행의 발송기 조건(`SmtpConfigError`)도 만족해야 한다 |
| 호출처의 `accountId`가 구성한 계정에 있다 | 기동 실패(`호출처 레지스트리가 올바르지 않다`). `accountId`를 생략한 호출처가 있는데 `default` 계정이 없어도 같다 |

## 시크릿 주입

- 시크릿 변수는 `<NAME>_FILE`(파일 경로)을 주면 파일 내용을 읽는다. 파일이 있으면 같은 이름의 환경 변수보다 우선한다. 끝의 개행 한 개는 제거한다. 파일이 비었거나 읽지 못하면 기동 실패다(사유는 변수 이름과 errno 코드만 출력).
- `_FILE`을 지원하는 변수: `MAILO_DATABASE_URL`, `MAILO_DB_PASSWORD`, `MAILO_OPS_TOKEN`, `MAILO_OPS_ADMIN_TOKEN_<이름>`, `MAILO_SMTP_PASSWORD`, 계정 비밀번호 `MAILO_SMTP_SECRET_<이름>`, `MAILO_DB_ENCRYPTION_KEY_V<n>`, `MAILO_FINGERPRINT_KEY_V<n>`, 개인키 `MAILO_JWE_KEY_*`, 호출처 비밀키 `MAILO_JWS_SECRET_*`.
- 운영은 시크릿 파일 마운트를 권장한다(ADR-0008 결정 5·6). 환경 변수도 허용하지만 `docker inspect`와 프로세스 환경에서 보인다(일반 지식).
- 이미지에는 시크릿을 넣지 않는다. `Dockerfile`에 시크릿을 넣는 단계가 없다(이미지를 빌드해 검사하지는 않았다).
- 이 저장소의 `docker-compose.yml`은 compose `secrets:`를 정의하지 않는다(기본 구성은 `.env`의 환경 변수다. `scripts/container/`와 CI가 이 구성에 의존한다). 운영은 아래처럼 compose `secrets:`와 `_FILE`로 바꾸는 것을 권한다. 이 방식은 실행해 확인하지 않았다(추정, compose는 파일 시크릿을 컨테이너의 `/run/secrets/<이름>`에 읽기 전용으로 둔다).

```yaml
# docker-compose.override.yml 예시. 값은 모두 가짜다. 시크릿 파일은 저장소 밖(예: /etc/mailo/secrets/)에 둔다.
services:
  mailo:
    environment:
      MAILO_SMTP_PASSWORD_FILE: /run/secrets/mailo_smtp_password
      MAILO_DB_ENCRYPTION_KEY_V1_FILE: /run/secrets/mailo_db_key_v1
      MAILO_FINGERPRINT_KEY_V1_FILE: /run/secrets/mailo_fingerprint_key_v1
    secrets: [mailo_smtp_password, mailo_db_key_v1, mailo_fingerprint_key_v1]
secrets:
  mailo_smtp_password: { file: /etc/mailo/secrets/smtp_password }
  mailo_db_key_v1: { file: /etc/mailo/secrets/db_key_v1 }
  mailo_fingerprint_key_v1: { file: /etc/mailo/secrets/fingerprint_key_v1 }
```

  - `_FILE`이 있으면 같은 이름의 환경 변수보다 우선하지만, `.env`에 값이 남아 있으면 `docker inspect`에 보인다. `.env`에서 `MAILO_SMTP_PASSWORD`와 키 값(`MAILO_DB_ENCRYPTION_KEY_V1` 등)을 지운다.
  - DB 비밀번호는 예시에 넣지 않았다. `docker-compose.yml`이 `POSTGRES_PASSWORD`를 `postgres`와 `mailo`(`MAILO_DB_PASSWORD`)에 함께 넣고 필수로 요구한다. 이것까지 파일로 바꾸려면 `postgres`는 `POSTGRES_PASSWORD_FILE`(공식 이미지 지원)로, `mailo`는 `MAILO_DB_PASSWORD_FILE`로 바꾸고 기본 파일의 필수 검사 줄을 덮어야 한다. 이 부분은 작성하지 않았고 확인하지 않았다.
  - 마운트한 파일은 컨테이너의 `node`(UID 1000)가 읽을 수 있어야 한다. compose `secrets`의 `file:` 시크릿은 호스트 파일의 권한을 그대로 보이므로(`uid`·`mode` 지정은 Swarm 전용) 호스트 파일을 UID 1000 또는 그룹이 읽게 둔다(추정).
- 마운트한 파일은 Mailo 실행 계정(UID 1000)이 읽을 수 있어야 한다. 다른 계정은 읽지 못하게 둔다.
- 개인키 PEM은 환경 변수로 줄 때 줄바꿈을 `\n` 두 글자로 써도 된다(`key-file.ts`). 파일로 주면 일반 PEM이다.
- 시크릿 파일 목록: DB 접속 URL, SMTP 비밀번호(계정마다 하나), 운영 읽기·관리 토큰, DB 본문 키 전 버전, 지문 키 전 버전, JWE 개인키 전부, JWS 비밀키 전부. 발급·교체는 `key-management.md`다.
- API 키 평문은 Mailo에 두지 않는다. `callers.json`에는 SHA-256 해시만 둔다(`caller-onboarding.md`).
- 로그·오류·이벤트에는 본문, 제목, 수신자 주소, 인증 정보, 키를 남기지 않는다(RQ-027).
- 관리 토큰 변수는 `.env`의 `MAILO_*`로 컨테이너에 전달되므로(`env_file`) compose에 이름별 설정을 더하지 않는다. `_FILE`로 받으면 파일 마운트를 따로 연다(위 `secrets:` 예시와 같다).

### 외부 시크릿 소스(`X_REF`)

비밀값을 외부 저장소에서 기동 때 한 번 읽는 방법이다(ADR-0016, RQ-075~078). 기본은 꺼져 있고 `_REF` 변수와 어댑터를 지정하지 않으면 동작이 달라지지 않는다.

- 코어(해석, 어댑터 계약, 로더)는 기본 이미지에 있고 저장소 어댑터는 없다. AWS Secrets Manager 어댑터는 변형 이미지 `ghcr.io/cp949/mailo:vX.Y.Z-aws`에만 들어 있다("AWS 변형 이미지(`-aws`)"). 어댑터 없이 `X_REF`를 쓰면 기동을 거부한다(`unknown-scheme`).
- 지정 방법은 셋 중 하나다: `X=값`, `X_FILE=경로`, `X_REF=<scheme>://<참조>`. 빈 문자열은 지정하지 않은 것이다.
  - `X_REF`와 `X` 또는 `X_FILE`을 함께 주면 `conflict`로 기동을 거부한다. `.env`에 남은 가짜 평문 값(`.env.example`의 `MAILO_SMTP_PASSWORD`, `MAILO_DB_ENCRYPTION_KEY_V1`, `MAILO_FINGERPRINT_KEY_V1`)은 `X_REF`를 쓸 때 주석 처리하거나 compose `environment:`에서 `X: ""`로 비운다.
  - `X_FILE`과 `X`의 우선순위(`_FILE` 우선)는 그대로다.
  - `X_REF`의 scheme은 `^[a-z][a-z0-9+.-]*$`이고 `//` 뒤에 한 글자 이상이 있어야 한다. `file`은 예약어라 거부한다(파일은 `X_FILE`로만 지정).
- `X_REF`를 쓸 수 있는 변수: `MAILO_DATABASE_URL`, `MAILO_DB_PASSWORD`, `MAILO_OPS_TOKEN`, `MAILO_OPS_ADMIN_TOKEN_<이름>`, `MAILO_SMTP_PASSWORD`, `MAILO_SMTP_SECRET_<이름>`, `MAILO_DB_ENCRYPTION_KEY_V<n>`, `MAILO_FINGERPRINT_KEY_V<n>`, `MAILO_JWS_SECRET_<이름>`, `MAILO_JWE_KEY_<이름>`. 참조 변수 이름은 뒤에 `_REF`를 붙인다(예: `MAILO_JWS_SECRET_BILLING_REF`). 설정 JSON은 읽지 않고 환경의 변수 이름을 이름 규칙으로 찾는다. `MAILO_CLI_TOKEN`은 지원하지 않는다(`MAILO_CLI_TOKEN_REF`는 알 수 없는 이름으로 거부된다).
  - 이름이 `MAILO_`로 시작하고 `_REF`로 끝나는데 위 목록에 없으면 `unknown-name`으로 기동을 거부한다(오타가 조용히 무시되어 `.env`의 평문 값으로 기동하는 일을 막는다).
  - 설정 JSON(`callers.json`, 계정 파일, 개인키 목록 파일)의 `secretVar`·`privateKeyVar`는 `_REF`로 끝날 수 없다. 이전 버전에서 `_REF`로 끝나는 변수 이름을 쓰던 배포는 이 버전에서 기동을 거부하므로 업그레이드 전에 이름을 바꾼다.
  - 환경에 있는 `_REF`는 설정 JSON이 가리키지 않아도 해석한다. 쓰지 않는 `_REF`를 남기지 않는다. 쓰이지 않는 비밀의 읽기 권한과 저장소 호출이 낭비된다.
- 해석은 프로세스 시작 때 `loadConfig` 앞에서 한 번이다. 해석값은 `process.env`가 아니라 앱이 쓰는 환경 복사본에 들어간다. 마이그레이션 CLI(`db/migrate-cli.ts`)는 별도 프로세스라 `MAILO_DATABASE_URL`·`MAILO_DB_PASSWORD`의 `_REF`만 따로 해석한다(compose 기본 명령은 CLI와 앱이 각각 저장소를 읽는다). 다른 `_REF`는 CLI가 무시한다.
- 값은 어댑터가 돌려준 문자열 그대로 쓴다. `_FILE`은 파일 끝의 개행 한 개를 제거하지만 `X_REF`는 아무것도 자르지 않는다. 저장소에 값을 넣을 때 끝에 개행이 붙으면(예: 파일에서 읽어 넣은 비밀번호) SMTP·계정 비밀번호는 인증 실패(`AUTH` 사유 차단기)로, DB 비밀번호는 접속 실패(`28P01`)로 나타난다. 키 변수(32바이트 키)와 운영 토큰은 앞뒤 공백을 소비자가 무시하므로 영향이 없다. 개행 없이 저장한다.
- 값은 기동 때 한 번만 읽고 실행 중에는 다시 읽지 않는다. 저장소에서 값을 바꾸면 재시작해야 반영된다. 같은 `_REF`의 값이 바뀐 것을 Mailo는 감지하지 못한다.
- 마이그레이션 CLI는 성공하면 어댑터가 남긴 연결·타이머와 무관하게 종료 코드 0으로 끝난다(출력 `마이그레이션 적용 N건`은 같다). 그래서 `migrate-cli && exec main`이 멈추지 않는다. 앱 프로세스에는 남은 핸들이 붙어 있으므로 어댑터는 해석 뒤 연결을 닫아야 한다.
- 저장소가 응답하지 않으면 새 인스턴스는 기동하지 못하고(`restart: unless-stopped`가 재시작을 반복한다), 이미 실행 중인 인스턴스는 영향이 없다. 해석 1건과 어댑터 모듈 `import()` 1건은 각각 `MAILO_SECRET_RESOLVE_TIMEOUT_MS`(기본 10초) 안에 끝나야 하고(`import()`가 끝나지 않으면 `import-failed`), 코어는 재시도하지 않는다. 어댑터가 재시도할 수 있다. 해석은 병렬이라 건수가 늘어도 전체 시간은 가장 느린 1건에 가깝다. 컨테이너의 healthcheck `start_period`(30초)는 마이그레이션 CLI와 앱이 각각 해석하는 시간을 포함해야 한다. 기본 timeout 10초 두 번이 모두 실패 직전까지 가면 20초다.
- 실패는 종료 코드 1이다. 앱은 `startup_failed` 로그(필드 `error`, `message`), 마이그레이션 CLI는 표준 오류에 한 줄씩 `비밀값 해석 실패: <변수>(<방식>): <종류>`를 낸다. 변수 이름, 지정 방식, 실패 종류만 담고 값·참조 문자열·어댑터 오류 메시지는 담지 않는다. 종류별 조치는 `troubleshooting.md` "기동 시 비밀값 해석 실패"다.
- 성공하면 `secrets_resolved`(info) 한 줄이 남는다. 필드는 `count`(해석 건수)와 `schemes`(쓴 scheme, 쉼표 구분)뿐이다. 해석 대상이 없으면 남지 않는다. 설정을 읽기 전에 남는 줄이라 `instance`는 호스트 이름이다.
- 프로세스 환경(`docker inspect`의 `Config.Env`, `/proc/<pid>/environ`)에는 참조(`X_REF`)와 어댑터의 저장소 접근 자격 증명(`AWS_*` 환경 변수를 쓰는 경우)이 보인다. 해석한 값은 보이지 않는다. 해석값은 앱 프로세스 메모리의 환경 복사본에 있다. 같은 프로세스 권한의 메모리 읽기는 막지 못한다(코드 읽기에 따른 설명이고 `/proc` 비노출은 측정하지 않았다).

DB 비밀번호를 `_REF`로 바꾸는 compose 예(값은 모두 가짜다. 실제 AWS와 compose 기동으로 확인하지 않았다). 어댑터가 든 변형 이미지가 있어야 동작한다.

```yaml
# docker-compose.override.yml 예시
services:
  mailo:
    image: ghcr.io/cp949/mailo:vX.Y.Z-aws
    build: !reset null
    environment:
      MAILO_SECRET_ADAPTERS: "@cp949/mailo-secret-source-aws"
      AWS_REGION: "ap-northeast-2"
      MAILO_DB_PASSWORD: "" # 기본 파일이 넣은 POSTGRES_PASSWORD 값을 비운다
      MAILO_DB_PASSWORD_REF: "aws-sm://mailo/example/db#password"
```

- `docker-compose.migrate-once.yml`을 쓰면 `mailo-migrate`도 어댑터가 필요하다. `mailo-migrate`에도 같은 변형 이미지(`image`와 `build: !reset null`), `MAILO_SECRET_ADAPTERS`, `AWS_REGION`을 준다. `_REF`만 주고 어댑터를 빼면 마이그레이션 CLI가 `unknown-scheme`으로 거부한다. 마이그레이션 CLI는 `MAILO_DATABASE_URL`·`MAILO_DB_PASSWORD`의 `_REF`만 해석한다.
- `docker-compose.migrate-once.yml`을 쓰면 `mailo-migrate`도 같은 방식으로 비운다: `MAILO_DB_PASSWORD: ""`와 `MAILO_DB_PASSWORD_REF`(마이그레이션 전용 계정이면 그 계정의 참조)를 `mailo-migrate`에 준다. `MAILO_MIGRATE_DB_PASSWORD`를 쓰는 구성은 이 줄이 대신한다.
- `postgres` 컨테이너의 `POSTGRES_PASSWORD`는 DB 초기화 값이라 compose가 계속 요구한다. 이 값을 저장소로 옮기는 구성은 다루지 않는다.

롤백 경고: 이 기능이 없는 이전 버전은 `_REF` 변수를 읽지 않고 무시한다. `_REF`로만 지정한 필수 비밀은 이전 버전에서 "필요하다" 오류로 기동하지 못해 안전하다. 선택 비밀인 `MAILO_OPS_TOKEN`은 값이 없으면 읽기 토큰 없이 기동한다(`loadOps`가 `token: null`을 만든다. 그 상태의 `/ops`·`/metrics` 응답은 확인하지 않았다). 롤백 전에 `_REF`를 `_FILE`이나 환경 변수로 되돌린다.

```txt
위험도: 중간 (기동 경로의 비밀 해석. 저장소 장애가 새 인스턴스의 기동을 막는다. 기본 설정에는 영향이 없다)
롤백: 이전 이미지로 교체한다. 데이터·마이그레이션 변경이 없다. `_REF`를 쓰던 배포는 롤백 전에 `_FILE`이나 환경 변수로 되돌린다
```

#### AWS 변형 이미지(`-aws`)

AWS Secrets Manager의 비밀을 `X_REF`로 읽는 이미지다(ADR-0016 결정 4·8, RQ-079·080).

- 이미지: `ghcr.io/cp949/mailo:vX.Y.Z-aws`. 같은 릴리스 커밋의 기본 이미지(digest) 위에 어댑터 `@cp949/mailo-secret-source-aws`와 AWS SDK(`@aws-sdk/client-secrets-manager`)만 얹었다. 기본 이미지에는 둘 다 없다. 이동 태그(`latest-aws`)는 없다. 변형은 기본 이미지와 Release를 발행한 뒤 별도 잡이 발행하므로 늦거나 없을 수 있다. 이 경우 기본 이미지는 이미 나가 있다(`ci.md` "variants 잡").
- 쓰는 법: 위 GHCR 절의 override처럼 `image`를 `-aws` 태그로 주고 `build: !reset null`을 쓴다. `MAILO_SECRET_ADAPTERS=@cp949/mailo-secret-source-aws`, `AWS_REGION`(필수), `X_REF`를 준다.
- 참조 형식: `aws-sm://<SecretId>[#<JSON 키>]`. `SecretId`는 비밀 이름 또는 ARN이다. `SecretString`을 `AWSCURRENT` 단계로 읽는다. `#<키>`가 있으면 `SecretString`을 JSON 객체로 읽어 그 키의 문자열 값만 쓴다(키는 `[A-Za-z0-9_.-]+`). `SecretBinary`, 버전 지정, 중첩 JSON 키는 지원하지 않는다. 같은 `SecretId`를 가리키는 변수마다 `GetSecretValue`가 한 번씩 나가고, 변수마다 SDK 클라이언트를 따로 만들어 자격 증명도 따로 조회한다. `SecretId`는 이름(영문 대소문자·숫자·`/_+=.@-`, 최대 512자)이나 ARN이어야 하고 공백·제어문자가 있으면 SDK를 부르기 전에 `invalid-value`로 거부한다. ARN을 쓰면 ARN의 지역이 `AWS_REGION`과 같아야 한다(어댑터는 `AWS_REGION`만 쓰고 ARN의 지역을 읽지 않는다).
- 자격 증명은 AWS SDK 기본 체인에서 얻는다(`AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY` 같은 환경 변수, 플랫폼 역할 등). 이 값은 `docker inspect`에 보일 수 있다. 호환 서버(LocalStack 등)는 SDK 표준 환경 변수 `AWS_ENDPOINT_URL_SECRETS_MANAGER`로 지정한다. 운영에서는 지정하지 않는다.
- 오류 코드(`troubleshooting.md` "기동 시 비밀값 해석 실패"): `not-found`(비밀 없음), `access-denied`(권한·자격 증명 없음·서명·KMS 복호화 거부), `throttled`, `unavailable`(서비스 오류, 네트워크, 시간 초과), `invalid-value`(참조 형식 오류, `AWS_REGION` 없음, `SecretBinary`만 있음, JSON이 아니거나 키가 없거나 값이 문자열이 아님). SDK의 오류 메시지·SecretId·값은 오류에 싣지 않는다.
- 재시도: SDK 기본(요청당 최대 3회)이 해석 제한 시간 안에서 동작한다. 코어는 재시도하지 않는다.
- `read_only: true`·`cap_drop: [ALL]`·`--network none` 컨테이너에서 환경 변수 자격 증명으로 해석 스모크가 통과했다(`adapters/secret-source-aws/image-smoke/run.sh`). 이 경로에서 SDK가 필수로 쓰는 쓰기 경로는 없었다(`HOME`은 `/home/node`이고 `~/.aws`가 없어도 오류가 아니다). 다른 자격 증명 경로(인스턴스·작업 역할, 웹 ID 토큰, SSO 캐시)는 실행하지 않았다.
- 검증하지 않은 것: 실제 AWS 계정(IAM, KMS, 자격 증명 체인, IMDSv2, 네트워크 제한, 실제 지연·제한), 변형 이미지의 취약점 스캔(스캔 단계가 없다), `variants` 잡의 GitHub 실행. IAM 정책 예시와 KMS 설정은 이 문서에 없다(별도 운영 가이드 예정).

```txt
위험도: 중간 (비밀 저장소 장애가 새 인스턴스의 기동을 막는다. 변형 이미지는 AWS SDK와 그 취약점을 이 저장소가 소유한다)
롤백: 기본 이미지로 되돌리고 `X_REF`를 `_FILE`이나 환경 변수로 바꾼다. 발행된 -aws 태그는 GHCR에 남는다
```

## 헬스

| 경로 | 인증 | 응답 |
| ---- | ---- | ---- |
| `GET /health/live` | 없음(`Authorization`을 읽지 않는다) | 200 `{"status":"UP"}` |
| `GET /health/ready` | 선택 | DB 연결 가능이면 200, 아니면 503 |

- `/health/ready`는 읽기 전용 트랜잭션 하나로 PostgreSQL 점검을 3초 안에 마친다. 쿼리에는 서버 쪽 `statement_timeout` 2초를 따로 걸고, 3초를 넘기면 그 연결을 풀에서 버린다. 응답만 포기하면 쿼리가 풀 슬롯을 계속 잡기 때문이다. 차단기가 `open`·`half_open`이어도 200이다. 등록과 조회는 정상이므로 오케스트레이터가 인스턴스를 내리면 안 된다.
- 발송 정지(Worker 정지, 적체)는 200/503에 반영하지 않는다. 원인이 DB나 SMTP 계정이면 재시작이 도움이 안 되고, 오탐이면 오케스트레이터가 정상 인스턴스를 재시작하기 때문이다. 대신 운영자 토큰(`MAILO_OPS_TOKEN`)으로 호출하면 아래 필드를 준다. 모니터링은 이 값을 폴링해 경보를 만든다.
- 인증 없이는 `status`, `checks.database`, `circuitBreaker.state`만 반환한다. 계정이 여럿이면 `circuitBreaker`는 계정별 차단기에서 정한다. 인증 없음과 운영자 토큰은 모든 계정 중 가장 나쁜 상태(`open` > `half_open` > `closed`, 같으면 계정 ID 오름차순 첫 계정의 `openUntil`·`lastReason`)이고 호출처 Bearer는 그 호출처 계정의 상태다. 계정 ID와 수는 어느 응답에도 없다. 계정별 상태는 `GET /ops/accounts`다. 단일 계정(`default`만) 배포는 계정 정지를 쓰지 않는 한 값이 이전과 같다. 단일 계정 배포에서도 `default` 계정을 정지하면(`PUT /ops/pauses/accounts/default`) 호출처 키가 `sendPaused.scope: account`를 받는다. 유효한 호출처 Bearer가 있으면 `openUntil`, `lastReason`, `eventFeed`, `sendPaused`를 더한다. 틀린 `Authorization`은 401이다.
- `sendPaused`는 그 호출처에 해당하는 발송 정지 요약이다(`{ paused, scope }`, `scope`는 `all`·`account`·`caller`·`null`). 우선순위는 `all`, 그 호출처 계정의 정지(`account`), `caller`다. 다른 계정의 정지는 보지 않는다. 호출처 ID·계정 ID·운영자 이름·시각은 없다. 정지와 계정 차단기는 200/503에 반영하지 않는다.
- 운영자 토큰(`Authorization: Bearer $MAILO_OPS_TOKEN` 또는 관리 토큰. 응답은 같다)은 `openUntil`, `lastReason`에 더해 다음을 반환한다(`eventFeed`·`sendPaused`는 호출처 전용이라 없다). 전역 수치는 다른 호출처의 발송량을 드러내므로 호출처 API 키로는 주지 않는다. 운영자 토큰은 업무 endpoint에서 401이다. 메일 본문·수신자·작업 ID·`caller_id`는 어느 필드에도 없다.

| 필드 | 의미 | 읽는 법 |
| ---- | ---- | ------- |
| `sendControls` | `{ allPaused, pausedCallerCount, pausedAccountCount }`(구성 밖 호출처·계정의 정지 행도 센다). 호출처·계정 ID는 없다 | `allPaused`가 true이거나 정지 수가 0보다 크면 발송 정지가 걸려 있다. 어느 대상인지는 `GET /ops/pauses`로 본다("발송 정지와 운영 REST") |
| `queue.dueCount` | 점유 대상(`PENDING`·`RETRY_WAIT`, `next_attempt_at` 경과) 작업 수. 상한 10000 | `queue.dueCountTruncated`가 true면 더 있다. 차단기가 `open`이거나 호출처 할당에 걸린 작업도 센다 |
| `queue.oldestDueAgeSeconds` | 가장 오래 기다린 작업이 점유 가능해진 뒤 지난 초. 없으면 null | 이 값이 커지는데 `worker.lastPollAgeSeconds`도 크면 점유 정지다. 차단기가 `closed`이고 할당에 걸리지 않았는데 커지면 이상이다 |
| `queue.dueCountByPriority` | 등급(`LOW`·`NORMAL`·`HIGH`·`URGENT`)별 `dueCount`. 네 키가 항상 있다. 상한 10000이 등급마다 따로 걸린다 | 등급별 합은 `dueCount`와 다를 수 있다(상한이 따로 걸린다). 읽는 순서는 `troubleshooting.md` "등급별 적체" |
| `queue.dueCountTruncatedByPriority` | 등급별 `dueCountTruncated` | true인 등급은 10000건보다 많다 |
| `queue.oldestDueAgeSecondsByPriority` | 등급별 `oldestDueAgeSeconds`. 그 등급의 대기 작업이 없으면 null | `LOW`만 커지는 것은 우선순위 경로의 정상 동작이다. 만료(기본 24시간)에 가까워지면 "굶음의 한계"를 본다(`caller-onboarding.md` "우선순위") |
| `worker.state` | `idle`, `running`, `paused`, `stopping`, `stopped`. Worker를 켜지 않은 앱(테스트)은 `disabled` | `running`이 아니면 종료 중이거나 시작 전이다 |
| `worker.lastPollAt`, `worker.lastPollAgeSeconds` | 점유 루프가 마지막으로 한 바퀴를 시작한 시각과 경과 초. 큐가 비어 있어도 갱신된다 | 폴링 간격(기본 1초)과 DB 시간제한(기본 최대 35초)보다 훨씬 크면 루프가 DB에서 멈춘 것이다(추정 기준: 2분 이상) |
| `worker.claimFailureStreak` | 점유가 연속으로 실패한 횟수 | 0보다 크면 `claim_failed` 로그를 본다 |
| `worker.pollLoopCrashed`, `worker.inFlight` | 점유 루프가 예외로 죽었는가, 진행 중 전송 수 | `pollLoopCrashed`가 true면 프로세스가 곧 종료 코드 70으로 끝난다("종료와 stop_grace_period") |
| `filePoller.enabled`, `running`, `callers`, `lastPollAt`, `lastPollOk` | 파일 채널이 꺼져 있으면 `enabled: false`뿐이다. 마지막 폴링이 끝난 시각과 오류 없이 끝났는가 | `lastPollOk`가 false가 이어지면 `file_poll_failed`·`file_ingest_failed` 로그를 본다. `lastPollAt`은 폴링 간격보다 훨씬 오래되면 안 된다 |

- 경보 기준값(위 "2분" 등)은 추정이다. 운영 환경에서 정상 상태의 값을 본 뒤 정한다. 이 응답을 장시간 부하에서 측정하지 않았다.
- 오케스트레이터의 liveness는 `/health/live`, readiness는 `/health/ready`(인증 없이)를 쓰는 구성을 권한다(추정, 실행해 확인하지 않았다).
- 로그 형식은 아래 "로그" 절이다. 헬스 요청 로그는 debug라 production에서는 나오지 않는다.

## 발송 정지와 운영 REST

근거: RQ-042·043·044, ADR-0011 결정 1·2·3·6·7.

토큰 두 종류를 쓴다. 읽기 토큰(`MAILO_OPS_TOKEN`)은 읽기 endpoint만 연다. 관리 토큰(`MAILO_OPS_ADMIN_TOKEN_<이름>`)은 읽기 권한을 포함하고 변경 endpoint를 연다. 변경은 모두 DB에 감사 기록(`mail_ops_audit`)을 같은 트랜잭션으로 남긴다. 토큰 발급·교체는 `key-management.md` "운영 토큰"이다.

| 하고 싶은 일 | 명령(`$ADMIN`은 관리 토큰, `$READ`는 읽기 토큰) |
| ------------ | ----------------------------------------------- |
| 전체 정지 | `curl -s -X PUT -H "Authorization: Bearer $ADMIN" http://<host>:3000/ops/pauses/all` |
| 전체 재개 | `curl -s -X DELETE -H "Authorization: Bearer $ADMIN" http://<host>:3000/ops/pauses/all` |
| 호출처만 정지 | `curl -s -X PUT -H "Authorization: Bearer $ADMIN" http://<host>:3000/ops/pauses/callers/<callerId>` |
| 호출처 재개 | `curl -s -X DELETE -H "Authorization: Bearer $ADMIN" http://<host>:3000/ops/pauses/callers/<callerId>` |
| 계정만 정지 | `curl -s -X PUT -H "Authorization: Bearer $ADMIN" http://<host>:3000/ops/pauses/accounts/<accountId>` |
| 계정 재개 | `curl -s -X DELETE -H "Authorization: Bearer $ADMIN" http://<host>:3000/ops/pauses/accounts/<accountId>` |
| 계정별 상태 | `curl -s -H "Authorization: Bearer $READ" http://<host>:3000/ops/accounts` |
| 정지 목록 | `curl -s -H "Authorization: Bearer $READ" http://<host>:3000/ops/pauses` |
| 감사 목록 | `curl -s -H "Authorization: Bearer $READ" "http://<host>:3000/ops/audit?limit=20"` |

- 정지는 DB 행이라 모든 인스턴스가 다음 점유부터 같은 값을 본다. 환경 변수나 레지스트리처럼 재시작이 필요하지 않다.
- 전체 정지는 일반 점유와 차단기 대표 작업(probe) 점유를 모두 막는다. 호출처 정지는 그 호출처의 작업만 점유에서 빼고 호출처별 24시간 할당 계산에서도 뺀다. 정지는 차단기와 독립이다. 정지를 풀어도 차단기 상태는 바뀌지 않는다.
- 정지 중에도 lease 복구, 결과 기록, 만료 sweep, 본문·기록 삭제, 등록(REST·파일)은 계속 돈다. 이미 `SENDING`인 작업의 전송은 끝까지 간다. 정지 응답 직후에도 최대 인스턴스 수 × `MAILO_WORKER_CONCURRENCY`건이 점유를 마친 채 남을 수 있다(코드 읽기에 따른 상한 추정, 측정하지 않았다).
- 정지 중에도 작업의 `expiresAt`은 흐른다. 정지가 길면 `PENDING` 작업이 `EXPIRED`가 된다(`JOB_EXPIRED`). 정지 시간은 호출처 TTL(기본 24시간)보다 짧게 잡는다. 재개하면 점유 가능한 작업이 한꺼번에 대상이 되고 동시 전송 수와 우선순위(RQ-035)가 처리 순서를 정한다.
- 호출처 정지는 레지스트리의 `callerId`가 아니어도 걸린다. 응답의 `inRegistry`로 오타를 확인한다. 새 요청 자체를 막으려면 API 키를 폐기한다(`key-management.md`). 호출처를 레지스트리에서 빼도 큐에 이미 있는 작업은 계속 발송된다.
- 계정 정지는 그 계정의 점유만 멈춘다(차단기 대표 작업 포함). 그 계정을 쓰는 호출처의 등록은 계속 받고 작업은 `PENDING`에 쌓인다. 계정 ID는 `^[a-z0-9][a-z0-9_-]{0,31}$`이고 형식이 틀리면 400이다. 구성에 있는지 확인하지 않는다(응답의 `inConfig`로 오타를 알아본다). 구성에서 뺀 계정의 정지 행을 `DELETE`로 지울 수 있다. 감사는 `scope.type: account`로 남는다. 구버전 인스턴스는 계정 정지를 읽지 않으므로 롤링 배포 중에는 쓰지 않는다.
- 정지 요약은 `GET /health/ready`에 있다. 호출처 키 응답은 `sendPaused`, 운영자 응답은 `sendControls`다. `/health/ready`의 200/503에는 반영하지 않는다.
- 발송이 멈춘 것처럼 보이면 `troubleshooting.md` "발송이 멈췄다"에서 정지를 먼저 확인한다.
- 정지 해제 직후 대량 재개가 SMTP 계정의 일일 한도·분당 한도에 닿을 수 있다. 차단기가 열릴 수 있으므로 재개 뒤 `circuitBreaker.state`를 본다(추정, 실제 Gmail 한도는 확인하지 않았다).

### 운영 토큰·정지 도입 배포 순서

근거: ADR-0011 결정 10. 마이그레이션 `0008`(`mail_send_controls`, `mail_ops_audit`)은 새 테이블만 만들고 기존 테이블을 잠그지 않는다. 구버전은 새 테이블을 읽지 않으므로 마이그레이션 직후에도 영향이 없다.

1. 마이그레이션 전에 `pg_dump`를 받는다("백업과 복구"). `0008`을 적용한다(기동 때 자동 또는 `mailo-migrate`).
2. 모든 Mailo 인스턴스를 새 버전으로 바꾼다.
3. 관리 토큰(`MAILO_OPS_ADMIN_NAMES`와 `MAILO_OPS_ADMIN_TOKEN_<이름>`)을 설정하고 인스턴스를 다시 시작한다. 환경 변수는 기동 때 읽는다. 관리 취소(`POST /ops/jobs/{jobId}/cancel`)는 호출처가 바라지 않은 `CANCELED`를 만들 수 있으므로 호출처가 모르는 값 규칙을 지키는지 확인한 뒤 이 단계를 한다("작업 취소 도입 배포 순서").

롤링 중(구·신 혼용)에는 정지 명령을 쓰지 않는다. 구버전 인스턴스는 정지를 읽지 않아 계속 발송한다.

롤백(이 순서를 지킨다):

1. 호출처의 취소 API와 관리 취소 사용을 먼저 멈춘다.
2. 정지를 모두 푼다(`GET /ops/pauses`가 빈 목록인지 확인한다). 구버전은 정지를 무시하므로 정지가 남은 채 롤백하면 발송이 조용히 재개된다.
3. 이전 버전으로 인스턴스를 바꾼다.
4. 마이그레이션은 되돌리지 않는다. `mail_send_controls`·`mail_ops_audit` 테이블은 남기고 구버전은 읽지 않는다.

```txt
위험도: 낮음~중간 (새 테이블 2개만 추가, 기존 테이블 잠금 없음. 정지 상태를 남긴 채 롤백하면 발송이 조용히 재개됨)
롤백: 정지를 모두 푼 뒤 앱만 이전 버전으로 되돌린다. 스키마는 되돌리지 않는다(되돌리려면 pg_dump 복원)
```

## 운영 CLI

근거: RQ-047, ADR-0011 결정 7. 같은 이미지의 `node dist/cli.js`다. 상주 프로세스가 아니고 DB에 접속하지 않는다. 운영 REST(`/health/ready`, `/ops/*`)를 Node의 `fetch`로 부르며 새 npm 의존성이 없다.

```bash
# 토큰 파일을 컨테이너에 마운트하고(읽기 전용) 컨테이너 안에서 실행한다. 컨테이너 안의 포트는 3000이다.
docker compose exec -e MAILO_CLI_TOKEN_FILE=/run/secrets/mailo_cli_token mailo node dist/cli.js status
```

| 명령 | 권한 | 호출하는 REST |
| ---- | ---- | ------------- |
| `status` | 읽기 | `GET /health/ready`, `GET /ops/pauses`. 출력은 `{ready, pauses}` |
| `queue stats` | 읽기 | `GET /health/ready`의 `queue` 값. 운영자 응답이 아니면 종료 코드 2 |
| `jobs show <jobId>` | 읽기 | `GET /ops/jobs/{jobId}`. 응답에 `outcomeUncertain`이 있다(`troubleshooting.md` "결과 불명 실패") |
| `audit list [--limit N] [--before ID]` | 읽기 | `GET /ops/audit` |
| `accounts list` | 읽기 | `GET /ops/accounts`. 계정별 차단기·정지·24시간 사용량·대기 건수 |
| `pause --all`, `pause --caller <호출처 ID>`, `pause --account <계정 ID>` | 관리 | `PUT /ops/pauses/all`, `.../callers/{callerId}`, `.../accounts/{accountId}` |
| `resume --all`, `resume --caller <호출처 ID>`, `resume --account <계정 ID>` | 관리 | `DELETE` 같은 경로 |
| `jobs cancel <jobId>` | 관리 | `POST /ops/jobs/{jobId}/cancel` |

- 변경 명령(`pause`, `resume`, `jobs cancel`)은 `--yes`가 없으면 서버를 부르지 않고 종료 코드 1이다. `pause`·`resume`은 범위(`--all`, `--caller`, `--account`)를 하나 명시해야 하고 기본 범위가 없다.
- 토큰은 명령줄 인자로 받지 않는다(`ps`에 보인다). `--token` 같은 옵션은 거부한다. 출력·오류에 토큰을 쓰지 않는다. 토큰 파일은 Mailo 컨테이너에 읽기 전용으로 마운트하고 읽기 토큰과 관리 토큰을 파일로 나눈다. 평소에는 읽기 토큰 파일을 쓰고 변경할 때만 관리 토큰 파일을 지정한다.
- 출력은 서버 응답 JSON(들여쓰기 2칸)이다. 성공은 stdout, 오류는 stderr다. 종료 코드: 0 성공, 1 사용법·설정 오류(토큰 없음, URL 형식 오류 포함), 2 HTTP 오류(상태와 problem 본문을 stderr에 낸다. 3xx도 따라가지 않고 2), 3 연결 실패·시간 초과(15초). 2xx이지만 JSON이 아니면 2다.
- `http`이고 loopback이 아닌 주소에 접속하면 토큰이 평문으로 가므로 stderr에 경고한다. 원격에서 쓰려면 `https`(TLS 프록시)를 쓴다.
- 읽기 전용 루트 파일 시스템(`read_only: true`)에서 쓰기가 없다. 2026-11-24에 이미지를 직접 빌드해 `--read-only --cap-drop ALL --security-opt no-new-privileges`와 `/tmp` tmpfs로 띄운 컨테이너 안에서 읽기 명령, `--yes` 없는 거부, 읽기 토큰의 변경 거부(403 → 종료 코드 2), 관리 토큰의 정지·재개, 감사 목록을 실행해 확인했다(`NODE_ENV=development`, 개발 DB 비밀번호 때문). `docker compose exec`는 실행하지 않았다.
- 컨테이너 밖(호스트)에서 쓰려면 같은 소스를 빌드한 `node apps/mailo/dist/cli.js`를 쓰고 `MAILO_CLI_URL`을 맞춘다.

### 수신 도메인 제한·이벤트 공백 감지 도입 배포 순서

근거: RQ-045·046, ADR-0011 결정 8·9·10. 마이그레이션 `0009`(`mail_event_purges`)는 새 테이블만 만들고 기존 테이블을 잠그지 않는다. 구버전은 이 테이블을 쓰지 않으므로 마이그레이션 직후에도 영향이 없다.

1. 마이그레이션 전에 `pg_dump`를 받는다("백업과 복구"). `0009`를 적용한다(기동 때 자동 또는 `mailo-migrate`).
2. 모든 Mailo 인스턴스를 새 버전으로 바꾼다. 구버전 인스턴스가 지운 이벤트는 삭제 표지에 오르지 않는다. 롤링 중에는 그 이벤트가 공백 감지에서 빠진다.
3. 호출처 레지스트리에 `allowedRecipientDomains`를 넣고 인스턴스를 다시 시작한다. 모든 인스턴스가 새 버전이 된 뒤에만 한다. 구버전은 새 필드를 거부해 기동하지 못한다. 순서는 "코드 먼저, 레지스트리 나중"이다. 호출처가 보내는 수신 도메인을 먼저 조사해 목록에 모두 넣는다.
4. 호출처는 응답 헤더 `Mailo-Cursor-Gap`을 처리하도록 바꾼 뒤 필요하면 `onGap=error`를 보낸다(`caller-onboarding.md` "공백 신호").

롤백(이 순서를 지킨다):

1. 호출처의 취소 API와 관리 취소 사용을 먼저 멈춘다.
2. 정지를 모두 푼다(`GET /ops/pauses`가 빈 목록인지 확인한다). 구버전은 정지를 무시하므로 정지가 남은 채 롤백하면 발송이 조용히 재개된다.
3. 레지스트리에서 `allowedRecipientDomains`를 뺀다. 남기면 구버전이 기동하지 못한다. 이 필드를 빼면 그 호출처의 수신자 제한이 풀린다.
4. 이전 버전으로 인스턴스를 바꾼다.
5. 마이그레이션은 되돌리지 않는다. `mail_event_purges`는 남기고 구버전은 쓰지 않는다. 테이블 행 수는 호출처 수 × 이벤트 종류 수(최대 5)가 상한이라 정리하지 않는다.

```txt
위험도: 낮음 (새 테이블 1개만 추가, 기존 테이블 잠금 없음. 레지스트리에 필드를 남긴 채 롤백하면 구버전이 기동하지 못함)
롤백: 위 순서로 레지스트리 필드를 빼고 앱만 이전 버전으로 되돌린다. 스키마는 되돌리지 않는다(되돌리려면 pg_dump 복원)
```

## 지표

근거: RQ-049~052, ADR-0012. Prometheus가 읽는 `GET /metrics`다. 알림은 Mailo가 보내지 않는다(RQ-029). 이 절의 규칙 예시는 Prometheus가 읽는 쪽의 설정이다.

### 인증과 스크레이프 설정

- 읽기 토큰(`MAILO_OPS_TOKEN`)만 200이다. 관리 토큰(`MAILO_OPS_ADMIN_TOKEN_<이름>`)은 403이고 호출처 API 키·헤더 없음·모르는 값은 401이다. `MAILO_OPS_TOKEN`을 설정하지 않으면 어떤 값도 읽기 권한이 아니다. 관리 토큰만 설정한 서버에서 관리 토큰은 403이고 그 밖의 값은 401이다. 읽기 토큰도 관리 토큰도 없는 서버는 모든 값에 401이다.
- Prometheus 설정에는 토큰이 평문 파일로 놓인다. 변경 권한이 있는 관리 토큰을 두지 않는다. 오설정이면 타깃이 `server returned HTTP status 403 Forbidden`으로 `down`이 된다.
- Mailo는 TLS를 종단하지 않는다. Prometheus는 같은 호스트, 내부 망, TLS 프록시 뒤 중 하나로 접근한다(위 "compose 구성"과 같은 전제). 기본 compose는 `127.0.0.1`만 연다.
- 타깃은 인스턴스마다 둔다. 로드 밸런서 주소 하나를 타깃으로 두면 요청이 인스턴스를 번갈아 가므로 counter가 줄었다 늘며 `rate()`가 틀린다.
- 모든 인스턴스를 새 버전으로 바꾼 뒤 타깃에 추가한다. 구버전 인스턴스는 `/metrics`가 없어 404다(코드 읽기 결과, 롤링 배포는 실행하지 않았다).

```yaml
scrape_configs:
  - job_name: mailo
    metrics_path: /metrics
    scrape_interval: 15s
    scrape_timeout: 10s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/mailo-ops-read-token
    # 인스턴스마다 타깃을 둔다. 로드 밸런서 주소 하나를 쓰지 않는다.
    static_configs:
      - targets:
          - mailo-1.internal:3000
          - mailo-2.internal:3000
```

- 토큰 파일에는 `MAILO_OPS_TOKEN`의 값(읽기 토큰)을 둔다. 파일 끝의 개행은 `credentials_file`이 허용한다.
- 확인한 것(2026-11-24): 같은 compose 네트워크에서 `prom/prometheus:v2.55.1`이 위 설정(간격만 5초)으로 컨테이너를 스크레이프했고 읽기 토큰 타깃은 `up`, 관리 토큰 타깃은 403으로 `down`이었다. `promtool check metrics`가 응답을 지적 없이 받았다. 스크레이프 간격 15초는 기본 캐시(5초)보다 길어 매번 새 DB 수집이 일어날 수 있다. 부하에서의 간격은 확인하지 않았다.

### 응답과 이름 규칙

- `Content-Type: text/plain; version=0.0.4; charset=utf-8`, `Cache-Control: no-store`다. 인증 오류 외에는 항상 200이다. DB 수집이 실패해도 200이고 실패한 그룹의 전역 지표가 빠지며 `mailo_metrics_collect_ok{group}`이 0이다.
- 이름과 종류로 합치는 법을 알 수 있다. HELP 첫 단어도 "전역." 또는 "인스턴스."다.

| 분류 | 종류 | 이름 | 합치는 법 |
| ---- | ---- | ---- | --------- |
| 전역 | gauge만 | `mailo_queue_`, `mailo_breaker_`, `mailo_send_paused`, `mailo_caller_`, `mailo_account_`, `mailo_ops_audit_` 접두 | `max by (...)`. `sum`은 인스턴스 수만큼 곱해진다 |
| 인스턴스 counter | counter만 | `mailo_*_total` | `sum by (...) (rate(...))`. 재시작하면 0에서 다시 시작한다 |
| 인스턴스 gauge | gauge | `mailo_worker_`, `mailo_file_poller_`, `mailo_metrics_` 접두 | 인스턴스별로 본다 |
| 프로세스 | counter·gauge | `process_start_time_seconds`, `process_resident_memory_bytes`, `process_cpu_seconds_total` | 인스턴스별로 본다. 시작 시각은 프로세스가 시작할 때 한 번 정한 값이라 바뀌면 재시작이다 |

- `instance` 라벨은 앱이 붙이지 않는다. Prometheus의 타깃 라벨이 준다. 앱 로그의 `instance`와 다른 값이다.
- 라벨은 `caller_id`, `account_id`, `reason`과 값이 닫힌 열거(`state`, `priority`, `result`, `stage`, `status`, `group`)뿐이다. `caller_id`는 호출처 레지스트리에 있는 값이거나 `unregistered`다(레지스트리에서 뺀 호출처의 작업이 큐에 남아 있을 때). `account_id`는 이 인스턴스가 구성한 계정 ID이거나 `unregistered`(계정이 구성에서 빠진 뒤 남은 작업이 만료 sweep으로 종결될 때)다. 계정이 하나(`default`)이면 `default` 하나다. 0 시리즈 시드는 호출처마다 그 호출처의 계정 하나만 만든다(호출처 × 계정 곱집합이 아니다). 수신자·본문·제목·`Idempotency-Key`·작업 ID·SMTP 응답 코드와 텍스트·토큰은 어느 라벨에도 없다.
- 지표 하나의 시리즈는 2000개까지다. 넘으면 새 시리즈를 만들지 않고 `mailo_metrics_dropped_samples_total`을 올리며 `metrics_series_limit`(warn, 지표 이름만)을 한 번 남긴다. 호출처가 약 400개를 넘어야 닿는다(계산). 계정이 늘면 계정마다 고정 시리즈가 약 18개 더해진다(계정 20개이면 약 360개, 계산). `mailo_attempt_errors_total`은 이론상 계정당 최대 224개라 계정 20개에서 2000을 넘을 수 있다. 실제 조합은 훨씬 적다고 추정하며 측정하지 않았다. 넘으면 위 경고가 알린다.

### 전역 gauge

DB 상태와 DB `now()`로 계산한다. 인스턴스마다 `MAILO_METRICS_CACHE_SECONDS`(기본 5초) 동안 같은 수집 결과를 다시 쓰고 동시에 온 스크레이프는 수집 하나를 기다린다. 수집은 풀 연결 하나로 그룹(`queue`·`breaker`·`controls`·`quota`·`feed`·`audit`)을 읽기 전용 트랜잭션에서 차례로 읽는다. 쓰기와 행 잠금이 없다.

| 이름 | 라벨 | 값 |
| ---- | ---- | -- |
| `mailo_queue_jobs` | `account_id`, `state`=`due`·`scheduled`·`sending` | 점유 가능, 재시도·예약 대기(`next_attempt_at`이 미래), 점유 중 건수. `due`·`scheduled`는 10000에서 멈춘다. `due`는 헬스 `queue.dueCount`와 같다 |
| `mailo_queue_jobs_truncated` | `account_id`, `state`=`due`·`scheduled` | 1이면 해당 건수가 상한에 닿았다 |
| `mailo_queue_oldest_due_age_seconds` | `account_id`, `priority`=`low`·`normal`·`high`·`urgent` | 등급별 가장 오래 기다린 점유 가능 작업의 경과 초. 대기가 없으면 0. 전체 값은 `max by (account_id)` |
| `mailo_breaker_state` | `account_id`, `state`=`closed`·`open`·`half_open` | 현재 상태만 1 |
| `mailo_breaker_reason_info` | `account_id`, `reason` | 상태가 `closed`가 아니고 사유가 있을 때만 1. 어휘는 헬스 `lastReason`과 같다 |
| `mailo_send_paused_all`, `mailo_send_paused_callers`, `mailo_send_paused_accounts` | 없음 | 전체 정지 0/1, 정지한 호출처 수(레지스트리에 없는 호출처 포함), 정지한 계정 수(구성에 없는 계정 포함) |
| `mailo_account_paused` | `account_id` | 구성한 계정별 정지 0/1 |
| `mailo_account_quota_limit`, `mailo_account_quota_used` | `account_id` | `sendQuota24h`를 설정한 계정만. 한도(이 인스턴스의 계정 구성 값)와 사용량(최근 24시간 시도 수와 점유 중 수의 합. 한도를 넘을 수 있다) |
| `mailo_caller_paused` | `caller_id` | 레지스트리 호출처별 정지 0/1 |
| `mailo_caller_quota_limit`, `mailo_caller_quota_used` | `caller_id` | `sendQuota24h`를 설정한 호출처만. 한도(이 인스턴스의 레지스트리 값)와 사용량(최근 24시간 시도 수와 점유 중 수의 합. 시도 쪽은 한도에서 멈추지만 점유 중 수를 더하므로 사용량이 한도를 넘을 수 있고 사용량/한도가 1을 넘을 수 있다) |
| `mailo_caller_latest_event_age_seconds` | `caller_id` | 피드에 보이는 최신 이벤트의 경과 초. 이벤트가 없으면 시리즈가 없다. 소비자의 처리 지연이 아니다. 새 이벤트가 없으면 시간이 지날수록 커진다 |
| `mailo_ops_audit_rows`, `mailo_ops_audit_rows_truncated`, `mailo_ops_audit_oldest_age_seconds` | 없음 | 감사 행 수(100000에서 멈춤), 상한 도달 0/1, 가장 오래된 행의 경과 초(없으면 0). 삭제 정책은 정하지 않았다 |

### 인스턴스 counter와 gauge

| 이름 | 라벨 | 뜻 |
| ---- | ---- | -- |
| `mailo_attempts_total` | `caller_id`, `account_id`, `result`=`sent`·`transient`·`permanent`·`account`·`internal` | 기록한 시도 결과. `LEASE_LOST`로 버린 결과는 세지 않는다. `internal`은 SMTP에 닿기 전 Mailo 내부 오류다 |
| `mailo_attempt_errors_total` | `account_id`, `result`, `stage`=`conn`·`tls`·`auth`·`mail_from`·`rcpt`·`data`·`worker`·`unknown`, `reason`=`none`·`daily_limit`·`rate_limit`·`connection`·`tls`·`auth`·`other` | 실패 시도의 분류. `reason`은 `result`가 `account`일 때만 `none`이 아니다 |
| `mailo_jobs_finished_total` | `caller_id`, `account_id`, `status`=`sent`·`failed`·`expired`·`canceled` | 이 프로세스가 커밋한 종결 전이(결과 기록, 만료 sweep, lease 복구, 취소) |
| `mailo_jobs_outcome_unknown_total` | `caller_id`, `account_id` | 이 프로세스가 커밋한 `OUTCOME_UNKNOWN` 종결 수(요청이 `onUncertainOutcome: fail`을 골랐고 결과 불명 시도 뒤 재시도 없이 끝난 작업). `mailo_jobs_finished_total`의 `failed`에도 함께 센다 |
| `mailo_claim_polls_total` | `result`=`claimed`·`empty`·`error` | 점유 루프의 점유 호출 |
| `mailo_claimed_jobs_total` | `caller_id`, `account_id` | 점유한 작업 수 |
| `mailo_lease_recovered_total` | `account_id` | lease 만료로 회수한 작업 수. 중복 발송 가능성의 신호다(RQ-013) |
| `mailo_file_channel_files_total` | `caller_id`, `result`=`registered`·`duplicate`·`rejected`·`unreadable`·`delete_failed` | 파일 채널이 처리한 파일 수 |
| `mailo_event_cursor_gap_total` | `caller_id` | 이벤트 피드 cursor 공백을 감지한 요청 수 |
| `mailo_metrics_dropped_samples_total` | 없음 | 시리즈 상한이나 값 검증 때문에 버린 증가 수. 정상이면 0이다 |
| `mailo_worker_state` | `state`=`disabled`·`idle`·`running`·`paused`·`stopping`·`stopped` | Worker 상태(원핫) |
| `mailo_worker_in_flight` | `account_id` | 구성한 계정마다 진행 중 전송 수(0 포함). Worker가 꺼져 있으면 시리즈가 없다. 전체 값은 아래 `mailo_worker_in_flight_jobs`다 |
| `mailo_worker_in_flight_jobs`, `mailo_worker_last_poll_age_seconds` | 없음 | 진행 중 전송 수, 점유 루프가 마지막으로 돈 뒤 경과 초. Worker가 꺼져 있거나 아직 안 돌았으면 시리즈가 없다 |
| `mailo_worker_claim_failure_streak`, `mailo_worker_poll_loop_crashed` | 없음 | 연속 점유 실패 수, 점유 루프 사망 0/1(1이면 종료 코드 70으로 끝나는 중) |
| `mailo_file_poller_enabled`, `_running`, `_callers` | 없음 | 파일 채널이 켜졌는가, 동작 중인가, 폴링 대상 호출처 수. 꺼져 있으면 0 |
| `mailo_file_poller_last_poll_age_seconds`, `_last_poll_ok` | 없음 | 마지막 폴링 뒤 경과 초와 성공 여부. 아직 안 돌았으면 시리즈가 없다 |
| `mailo_metrics_collect_ok` | `group` | 마지막 DB 수집에서 그룹이 성공했으면 1. 0이면 그 그룹의 전역 지표가 응답에 없다 |
| `mailo_metrics_snapshot_age_seconds` | 없음 | 캐시된 DB 수집의 경과 초 |

- counter는 커밋한 뒤에 오른다. 커밋과 증가 사이에 프로세스가 죽으면 그 한 건을 놓친다.
- 시리즈가 처음 생기는 순간의 증가는 `increase()`·`rate()`가 놓친다(처음 보는 값이 1이면 증가량을 알 수 없다). 그래서 알림 규칙이 쓰는 counter는 시작할 때 0으로 미리 낸다.
  - 미리 내는 것: `mailo_claim_polls_total`(3개), `mailo_lease_recovered_total`, 그리고 레지스트리 호출처마다 `mailo_attempts_total`(5개)·`mailo_jobs_finished_total`(4개)·`mailo_jobs_outcome_unknown_total`·`mailo_claimed_jobs_total`·`mailo_event_cursor_gap_total`. 호출처 400개까지 지표당 2000개 안이다. 호출처가 더 많으면 앞의 2000개만 미리 낸다.
  - 미리 내지 못하는 것: `caller_id="unregistered"` 시리즈(레지스트리에서 뺀 호출처), `mailo_file_channel_files_total`, `mailo_attempt_errors_total`(조합이 불가능한 값이 많다). 이 시리즈의 첫 증가는 `increase()`가 놓친다. 이후 증가는 센다. 부록의 알림 규칙 중 이 시리즈에만 생기는 증가를 보는 것은 없다. `MailoFailedRatioHigh`는 `unregistered` 호출처의 첫 종결 하나를 놓칠 수 있다.
- 종결 건수는 DB로 세지 않는다(상태별 `count(*)`를 받치는 인덱스가 없다). `mailo_jobs_finished_total`의 `increase`로 본다. 재시작과 인스턴스 교체를 `rate`·`increase`가 처리한다.
- 평균 발송 처리 시간은 히스토그램이 필요해 정하지 않았다.

### 알림 규칙 예시

임계값은 모두 추정이고 부하에서 확인하지 않았다. `promtool check rules`가 문법을 통과시켰고(2026-11-24, `prom/prometheus:v2.55.1`) 실제 Prometheus가 컨테이너를 스크레이프하며 12개 규칙을 평가했다(모두 `ok`). 알림이 발화하는 조건은 실행해 확인하지 않았다. 계정 규칙(묶음 C: `MailoNoProgress` 계정별 변경, `MailoSendPausedLong`·`MailoAccountQuotaNearLimit`)은 `promtool check rules`로 문법만 확인했고(13개 규칙, `prom/prometheus:v2.55.1`, 2026-11-24) 실제 Prometheus의 평가는 실행하지 않았다. 전역 gauge는 `max by`로, counter는 `sum`과 `rate`·`increase`로 쓴다. `for:`는 캐시 TTL(기본 5초)보다 충분히 길다.

```yaml
groups:
  - name: mailo
    rules:
      - alert: MailoInstanceDown
        expr: up{job="mailo"} == 0
        for: 2m

      - alert: MailoBreakerNotClosed   # 계정마다 차단기가 있다. account_id가 어느 계정인지 알려 준다
        expr: max by (account_id) (mailo_breaker_state{state=~"open|half_open"}) == 1
        for: 10m

      - alert: MailoQueueBacklogAge
        expr: max by (account_id) (mailo_queue_oldest_due_age_seconds) > 600
        for: 10m

      - alert: MailoQueueTruncated
        expr: max(mailo_queue_jobs_truncated{state="due"}) == 1
        for: 15m

      - alert: MailoNoProgress   # 계정별. 그 계정이 닫혀 있고 정지가 아닌데 적체가 있고 시도가 없다
        expr: |
          max by (account_id) (mailo_queue_jobs{state="due"}) > 0
          and on (account_id) sum by (account_id) (rate(mailo_attempts_total[10m])) == 0
          and on (account_id) max by (account_id) (mailo_breaker_state{state="closed"}) == 1
          and on (account_id) max by (account_id) (mailo_account_paused) == 0
          and on () max(mailo_send_paused_all) == 0
        for: 15m

      - alert: MailoFailedRatioHigh
        expr: |
          sum(increase(mailo_jobs_finished_total{status="failed"}[15m]))
            / clamp_min(sum(increase(mailo_jobs_finished_total{status=~"sent|failed"}[15m])), 1) > 0.2
          and sum(increase(mailo_jobs_finished_total{status="failed"}[15m])) >= 10
        for: 5m

      - alert: MailoSendPausedLong
        expr: |
          max(mailo_send_paused_all) == 1 or max(mailo_send_paused_callers) > 0
          or max(mailo_send_paused_accounts) > 0
        for: 30m   # 정지 중에도 TTL이 흘러 EXPIRED가 쌓인다

      - alert: MailoWorkerStalled
        expr: mailo_worker_last_poll_age_seconds > 60 or mailo_worker_poll_loop_crashed == 1
        for: 2m

      - alert: MailoMetricsCollectFailing
        expr: mailo_metrics_collect_ok == 0
        for: 5m

      - alert: MailoCallerQuotaNearLimit   # 사용량에 점유 중 수가 더해져 비율이 1을 넘을 수 있다. 1 이상도 이 조건에 든다
        expr: |
          max by (caller_id) (mailo_caller_quota_used)
            / max by (caller_id) (mailo_caller_quota_limit) >= 0.9
        for: 10m

      - alert: MailoAccountQuotaNearLimit   # 계정 24시간 할당. 점유 중 수가 더해져 비율이 1을 넘을 수 있다
        expr: |
          max by (account_id) (mailo_account_quota_used)
            / max by (account_id) (mailo_account_quota_limit) >= 0.9
        for: 10m

      - alert: MailoLeaseRecovered
        expr: sum(increase(mailo_lease_recovered_total[15m])) > 0   # 중복 발송 가능성 신호(RQ-013)

      - alert: MailoAuditRowsHigh
        expr: max(mailo_ops_audit_rows) > 50000   # 임계값은 근거 없는 예시
        for: 1h
```

- `MailoNoProgress`의 `sum by (account_id) (rate(mailo_attempts_total[10m])) == 0`은 호출처 시리즈를 0으로 미리 내므로 시도가 한 번도 없어도 참이다. 계정마다 따로 본다. 기동 직후 그 계정에 `due`가 있고 계정 정지·차단이 없는데 15분 동안 시도가 없으면 발화한다(추정, 실행해 확인하지 않았다). 호출처 시드가 없는 계정(어느 호출처도 쓰지 않는 계정)은 시도 시리즈가 없어 이 규칙에 들지 않는다.
- `MailoAccountQuotaNearLimit`의 `mailo_account_quota_used`는 시도 수에 점유 중 수를 더하므로 한도보다 커질 수 있다. 한도를 설정하지 않은 계정은 시리즈가 없다.
- `MailoCallerQuotaNearLimit`의 `mailo_caller_quota_used`는 시도 수에 점유 중 수를 더하므로 `mailo_caller_quota_limit`보다 커질 수 있다. 비율이 1을 넘어도 이 규칙에 든다.
- `MailoLeaseRecovered`·`MailoFailedRatioHigh`는 레지스트리 호출처의 0 시리즈가 있으므로 프로세스의 첫 회수·첫 실패도 `increase()`에 잡힌다. Prometheus가 그 인스턴스를 처음 스크레이프하기 전에 일어난 증가는 어느 경우에도 보이지 않는다.
- 발송 정지(`MailoSendPausedLong`)는 의도한 조작일 수 있다. 장기 정지가 `EXPIRED`를 만드는 점을 알리는 용도다.
- 알림 대응은 `troubleshooting.md` "지표 해석"이다.

## 로그

모든 로그는 표준 출력의 한 줄 JSON이다. Worker·파일 폴러·HTTP 요청·DB·헬스·Nest 내부 로그가 같은 로거 하나(`createApp`이 만든다)를 쓴다. 이전에는 Worker·파일 폴러만 JSON이고 나머지는 Nest 텍스트 줄이었다.

```json
{"ts":"2026-11-23T01:02:03.456Z","instance":"3f9a1c2b4d5e","level":"info","event":"http_request","requestId":"6f1c…","method":"POST","route":"/jobs","status":202,"callerId":"billing","durationMs":12}
{"ts":"2026-11-23T01:02:03.500Z","instance":"3f9a1c2b4d5e","level":"error","event":"claim_failed","error":"Error:57014","streak":1}
{"ts":"2026-11-23T01:02:04.000Z","instance":"3f9a1c2b4d5e","level":"info","event":"nest_log","message":"Nest application successfully started","context":"NestApplication"}
```

- 앞의 네 필드는 모든 줄에 있다: `ts`(ISO 8601 UTC), `instance`(`MAILO_INSTANCE_ID`, 없으면 호스트 이름 = 컨테이너 ID), `level`(`debug`·`info`·`warn`·`error`), `event`. 나머지는 이벤트마다 다르다. 호출자 필드가 이 네 값을 덮어쓰지 않는다.
- `event: "http_request"`: 응답이 끝날 때 한 줄. 필드는 `requestId`, `method`, `route`(라우트 패턴, 예 `/jobs/:jobId`), `status`, `callerId`(인증 전에는 `null`), `durationMs`뿐이다. 쿼리 문자열, 경로 값, `Idempotency-Key`, 헤더, 본문은 없다(RQ-027). `requestId`는 오류 응답 본문의 `instance`(`urn:uuid:…`)와 같다.
- `event: "nest_log"`: Nest 프레임워크와 `Logger`로 쓴 문자열 로그. `message`, `context`(클래스·모듈 이름), 오류 수준이면 Nest가 넘긴 `stack`이 있다. `stack`의 첫 줄에는 예외 메시지가 들어 있을 수 있다(이전 텍스트 출력과 같은 정보다).
- 앱이 정한 이벤트 이름: `secrets_resolved`(info, `count`·`schemes`만. 기동 때 `X_REF`를 해석했을 때 한 번, "외부 시크릿 소스"), `unhandled_error`, `readiness_check_failed`, `db_idle_client_error`, `job_canceled`(앱 계층, `jobId`·`callerId`·`canceledBy`, 호출처가 대기 작업을 취소했을 때. 이미 취소된 작업의 재요청에는 남지 않는다), `ops_pause_set`·`ops_pause_cleared`(info, `actor`·`scope`(`all`·`caller`)·`callerId`(`caller`일 때만), 상태를 바꾼 관리 요청만. 멱등 재요청은 남지 않는다), `ops_job_canceled`(info, `actor`·`jobId`), `metrics_collect_failed`(warn, `group`·`error`. `/metrics`의 DB 수집 그룹이 성공에서 실패로 바뀔 때 한 번. 같은 그룹의 연속 실패 동안 반복하지 않는다), `metrics_series_limit`(warn, `metric`만. 지표 하나의 시리즈가 상한에 처음 닿았을 때 한 번), `event_cursor_gap`(warn, `callerId`만. `GET /events`가 `after` 뒤의 삭제를 발견한 응답마다 한 줄이고 헤더든 410이든 같다), Worker의 `send_paused`(warn)·`send_resumed`(info)(`scope`, `callerId`는 `caller`일 때만. 정지 상태가 바뀐 것을 관찰할 때 한 번만 남고 폴링마다 반복하지 않는다), Worker와 파일 폴러의 이벤트(`claim_failed`, `worker_paused`, `drain_timeout`, `file_poll`, `file_inbox_missing` 등, `troubleshooting.md`).
- 필터 예: `docker compose logs --no-log-prefix mailo | jq -c 'select(.level=="error" or .level=="warn")'`. JSON이 아닌 줄(Node가 직접 쓰는 경고, 기동 전 설정 오류 메시지)이 섞일 수 있으니 `jq -R 'fromjson? | select(.)'`를 쓴다. 기동 실패는 `event: "startup_failed"`(필드 `error`는 예외 이름·코드, 설정 오류와 비밀값 해석 오류는 변수 이름·방식·고정 종류만 담은 `message`)로 남는다. 설정을 읽기 전의 실패는 `instance`가 호스트 이름이다(`MAILO_INSTANCE_ID`를 아직 읽지 못했다).
- 본문·제목·수신자 주소·SMTP 인증 정보·키는 어느 필드에도 넣지 않는다. 예외는 이름과 코드(`Error:57014`)만 쓴다(RQ-027). 이 규칙은 canary 문자열 테스트로 확인한다.
- 로그 수집기가 인스턴스를 구분하려면 `instance`를 쓴다. 로그와 DB 행의 연결: 결과를 기록한 시도의 `instance`가 `mail_attempts.instance` 컬럼에 같은 값으로 남는다(128자까지). 로그의 `jobId`(`job_completed` 등)로 시도 행을 찾고 `instance`로 기록한 인스턴스를 확인한다. lease 회수로 쓴 `LEASE_EXPIRED` 시도, 0003 적용 전 행, 롤링 배포 중 이전 버전이 쓴 행은 NULL이다(점유한 인스턴스를 DB에 쓰지 않는다: lease는 `lease_token`으로만 다룬다). REST 응답에는 노출하지 않는다. 컨테이너를 다시 만들면 호스트 이름이 바뀌므로 고정 이름이 필요하면 `MAILO_INSTANCE_ID`를 준다.

## 종료와 stop_grace_period

종료 순서(`app-lifecycle.ts`, ADR-0002 구현 중 확정 6): SIGTERM → Worker `pause()`(새 점유 중지, 진행 중 전송은 계속) → HTTP 서버 닫기와 파일 폴러 정지(진행 중 파일 완료)를 함께 진행 → Worker 진행 중 전송 drain → DB 풀 닫기.

- `pause()`는 진행 중인 점유 호출(`claim`)을 drain 상한까지만 기다린다. DB가 응답하지 않아 점유가 멈춰 있으면 상한에서 `pause_timeout` 경고를 남기고 넘어간다. 그 뒤 늦게 돌아온 점유는 처리하지 않고 `claim_after_drain_timeout`으로 남긴다(lease 만료 뒤 회수). DB 풀 닫기는 5초까지만 기다린다.
- drain 상한은 `max(1초, MAILO_LEASE_SECONDS − 10초)`이고 `pause()` 시점부터 센다. HTTP 닫기에 걸린 시간도 상한에 들어간다. 상한을 넘으면 `drain_timeout` 경고를 남기고 남은 전송을 끊는다. 끊긴 작업은 결과를 기록하지 않고 lease를 풀지 않으며, lease 만료 뒤 다음 점유가 회수한다(중복 발송 가능, RQ-013).
- HTTP 요청·헤더 수신 시간제한은 30초다(환경 변수 없음, 상수). 종료 때 유휴 연결은 바로 닫고, 본문을 다 보내지 않은 요청은 30초 뒤 끊는다.
- `stop_grace_period`는 drain 상한 + 10초 이상이어야 한다. compose는 `MAILO_STOP_GRACE_PERIOD`(기본 150s)를 `stop_grace_period`와 앱 환경에 함께 넣고, 앱은 이 값이 drain 상한 + 10초보다 짧으면 기동을 거부한다. lease가 기본값이면 `stop_grace_period`를 lease 이상으로 두면 충족한다. 더 짧으면 drain 상한에 이르기 전에 SIGKILL이 온다. 모든 재배포마다 진행 중 전송이 lease 회수 대상이 된다(ADR-0002 결정 12).
- 종료 중 SIGKILL(`stop_grace_period` 초과 포함)은 중복 발송 1회를 만들 수 있다. 시스템은 at-least-once이고(RQ-013), 같은 `Message-ID`가 중복을 줄이는지는 실제 Gmail로 확인하지 않았다.
- drain 상한은 SMTP 시간제한 중 가장 긴 값과 HTTP 요청 시간제한 30초보다 길어야 한다. 한 건 전체 마감(`totalMs`)은 기동 검증이 `totalMs + 10초 ≤ lease`로 강제하므로(위 "변수 사이의 제약") drain 상한 이하다. lease가 40초 미만이면 HTTP 30초가 drain 상한보다 길 수 있다. 둘이 병행하므로 종료 시간은 둘 중 긴 쪽이다.
- 기본값: lease 120초, drain 상한 110초, `stop_grace_period` 150초. 40초는 drain 상한 뒤 풀 닫기와 폴러 정지의 여유다(수치는 추정이며 이 시간을 측정하지 않았다).
- lease를 바꾸면 `MAILO_STOP_GRACE_PERIOD`를 함께 바꾼다. 예: `MAILO_LEASE_SECONDS=300`이면 `MAILO_STOP_GRACE_PERIOD=300s` 이상으로 둔다(drain 290초 + 10초). 안 바꾸면 기동이 거부된다. compose를 쓰지 않아 변수를 주지 않는 환경에서는 검사가 없으므로 오케스트레이터의 종료 대기 시간을 직접 맞춘다.
- 점유 루프가 예외로 죽으면(`poll_loop_crashed` 로그) 프로세스는 즉시 끝나지 않는다. 위 종료 순서(`pause` → drain → 풀 닫기)를 거친 뒤 종료 코드 70(`worker_fatal` 로그(error, `reason=poll_loop_crashed`, `exitCode=70`))으로 끝난다. 즉시 끝내면 진행 중 SMTP 전송이 끊겨 중복 발송이 생기기 때문이다. 종료 경로가 멈추면 lease 길이만큼 기다린 뒤 강제로 종료한다. compose의 `restart: unless-stopped`가 비0 종료에 재시작하는 것을 2026-11-23 일회용 컨테이너(`exit 70`)로 확인했다(재시작 4회). 실제 Mailo 컨테이너에서 이 경로를 일으켜 보지는 않았다(`apps/mailo/test/fatal-exit.spec.ts`는 처리기만 확인한다). 주기 작업 루프(`maintenance_loop_crashed`)가 죽은 경우는 로그만 남기고 종료하지 않는다.
- `docker compose stop`과 `restart`는 SIGTERM을 보낸다. 앱은 SIGTERM·SIGINT에서 종료 훅을 실행한다(`enableShutdownHooks`).
- 컨테이너에 실제 SIGTERM을 보내 확인한 것은 이 변경 이전 순서의 파일 채널 시나리오뿐이다. 변경한 순서와 느린 요청 종료는 통합 테스트로 확인했다(RQ-025).

## DB 시간제한과 장애 동작

- 앱 풀의 모든 연결에 서버 쪽 `statement_timeout`(30초), `lock_timeout`(10초), `idle_in_transaction_session_timeout`(60초)을 시작 매개변수로 건다. 클라이언트 쪽 `query_timeout`(35초)과 TCP keepalive(첫 탐침 10초)도 켠다. 값은 모두 추정이고 위 환경 변수로 바꾼다.
- 이유: 연결이 RST 없이 끊기면 `claim`이 응답을 영원히 기다려 점유와 종료가 멈춘다. 종료가 `stop_grace_period`를 넘기면 SIGKILL로 끝나 진행 중 전송이 재발송된다. 멈춘 트랜잭션이 차단기 행 잠금과 xmin을 잡으면 이벤트 피드(ADR-0006 결정 7)도 멈춘다.
- 서버가 응답하는 장애(잠금 대기, 느린 쿼리)는 서버 시간제한이 먼저 끊고 연결은 살아남는다(57014, 55P03). 서버 응답이 오지 않는 단절은 `query_timeout`이 쿼리를 끊고 `withTransaction`이 그 연결을 풀에서 버린다. keepalive만으로는 죽은 연결 감지에 수 분이 걸릴 수 있다(Linux 기본 75초 × 9회, 이 환경에서 측정하지 않았다). 따라서 실제 상한은 `query_timeout`이다.
- 마이그레이션 CLI(`migrate-cli`)는 `statement_timeout` 없이 실행한다(DDL이 오래 걸릴 수 있다). `lock_timeout` 10초는 건다. 인스턴스 사이의 advisory lock 대기에는 적용하지 않는다. 기동 때 마이그레이션이 다른 쿼리를 막는 잠금을 오래 기다리면 실패하고 컨테이너가 재시작한다.
- 정리 쿼리(만료 sweep, 본문 삭제, 보존 삭제, lease 회수)는 1000건 배치라 30초 안에 끝난다고 가정했다(측정하지 않았다). 정상 쿼리가 30초를 넘는 환경(매우 큰 테이블, 느린 디스크)에서는 `MAILO_DB_STATEMENT_TIMEOUT_MS`를 올리고 `MAILO_DB_QUERY_TIMEOUT_MS`도 함께 올린다. 호출처 할당 집계(`claim`)는 `mail_attempts`의 24시간 구간을 세므로 기록이 매우 많으면 같은 영향을 받는다.
- 결과 기록(`completeAttempt`) 실패는 lease 마감(점유 호출 전 시각 + lease − 10초, 단조 시계)까지 재시도한다. 간격은 200ms에서 2배씩 늘고 5초에서 멈추며 ±20% 흩뿌린다. 이전에는 3회(200ms, 800ms)였다. 마감이 지났거나 종료 때 전송을 끊었으면 포기하고 lease 회수에 맡긴다. 로그 `complete_failed`(`attempt`, `retry`)로 본다.

## PostgreSQL 요건

- 13 이상이 필요하다. 이벤트 피드 cursor가 `xid8`, `pg_current_xact_id()`, `pg_snapshot_xmin(pg_current_snapshot())`을 쓰기 때문이다(ADR-0006 결정 7). `0001` 마이그레이션이 13 미만에서 실패한다. `db/migrator.integration-spec.ts`가 서버 버전 13 이상을 확인한다.
- 운영 DB 계정은 기본 구성에서 테이블·인덱스 생성 권한이 필요하다(마이그레이션이 같은 계정으로 돈다). 마이그레이션 계정을 분리하면 앱 계정은 DML 권한만 필요하다("마이그레이션 일회성 실행").
- DB 연결 암호화(`MAILO_DB_SSLMODE`)는 DB가 다른 호스트일 때 쓴다. compose의 `postgres`(같은 네트워크)는 필요하지 않다. 서버 쪽 TLS 설정(`ssl=on`)은 이 저장소 범위 밖이다. 실제 TLS를 켠 PostgreSQL에 접속해 확인하지는 않았고, 옵션 매핑과 핸드셰이크 동작은 로컬 TLS 서버로 단위 테스트했다(`test/config/database-ssl.spec.ts`).
- 사용처용 DB 계정과 접속 경로를 만들지 않는다. compose는 PostgreSQL을 `127.0.0.1`에만 노출한다(RQ-003).
- 이벤트 피드는 쓰기 트랜잭션(트랜잭션 ID를 받은 트랜잭션)이 오래 열려 있으면 지연된다. 읽기 전용 트랜잭션(`pg_dump` 포함)은 트랜잭션 ID를 받지 않아 피드를 지연시키지 않았다(2026-11-23 PostgreSQL 17에서 `READ ONLY` 반복 읽기 트랜잭션을 연 채 확인. 실제 `pg_dump`를 실행하지는 않았다). 실제 위험은 열린 채 방치된 쓰기 트랜잭션, 끝나지 않은 prepared transaction이다(`troubleshooting.md`).
- 테이블 팽창·VACUUM 점검, 보존 삭제가 따라가는지 보는 쿼리, 파티셔닝 검토 조건은 [db-maintenance.md](./db-maintenance.md)다. 읽기 전용 긴 트랜잭션은 이벤트 피드를 막지 않지만 VACUUM이 죽은 행을 지우지 못하게 한다(로컬 측정, 같은 문서).
- 시각은 DB `now()`를 쓴다. 앱 서버 시계와 DB 시계가 달라도 lease·만료·할당은 DB 기준이다. JWS `iat`와 임시 파일 정리는 Mailo 호스트 시계를 쓴다.

## 백업과 복구

백업은 DB 덤프와 키를 따로 보관한다. 이 절의 명령은 실행하지 않았다. 백업에 남는 개인정보와 보존 기간은 `data-retention.md`의 "Mailo 밖에 남는 것"이다.

```sh
# 백업(compose 서비스 이름 postgres 가정)
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > mailo-$(date +%F).dump
```

- 덤프에 들어 있는 것: 작업 행(수신자 평문, 본문 암호문, 지문), 시도 기록, 이벤트, 거부 기록, 차단기 행, `schema_migrations`. 본문은 DB 본문 키로 암호화돼 있다(종결 전이에서 삭제, RQ-071). 종결한 작업 행의 수신자·봉투도 비어 있다. 예외는 이전 버전이 종결한 행(배포 전에 이미 종결된 행 포함)이다. 이 행은 본문이 유예(기본 1일) 뒤 비워지지만 수신자·봉투는 보존 삭제(`MAILO_RECORD_RETENTION_SECONDS`, 기본 30일)까지 남는다. 안전망(`deleteExpiredBodies`)이 본문 세 열만 비우기 때문이다. 배포 직후 앞당겨 비우는 SQL은 `db-maintenance.md` "배포 전 종결 행의 수신자·봉투 비우기"다. 이벤트·시도의 수신자는 유예(`MAILO_RECIPIENT_RETENTION_SECONDS`, 기본 7일) 안이면 평문이고 유예 뒤에는 비어 있다(RQ-072). 덤프는 덤프 시점의 값을 그대로 담는다.
- 복원에 필요한 키:
  - DB 본문 암호화 키: 미종결 작업(과 이전 버전이 종결해 유예(기본 1일) 안에 본문이 남은 작업)의 본문을 읽는 데 필요하다. 해당 `body_key_version`의 키가 없으면 그 작업은 복호화 실패(`BodyCipherError:UNKNOWN_KEY_VERSION`)로 `job_internal_error`를 남기고 3번째 시도에서 `FAILED`가 된다.
  - 지문 키: `fingerprint_key_version`이 남아 있는 모든 작업 행의 버전이 필요하다. 없으면 그 Key로 다시 오는 요청의 비교가 예외가 되어 REST는 503, 파일은 `file_ingest_failed`다(코드 읽기 결과). 현재 버전 키는 기동 조건이다.
  - JWE 개인키: DB 덤프를 읽는 데는 필요 없다. 수집 시점에 이미 복호화해 DB 키로 다시 암호화해 저장하기 때문이다. 서비스를 복원해 JWE를 쓰는 호출처의 요청(relay 재시도, 입력 폴더에 남은 파일)을 받으려면 필요하다. 키 목록 파일이 가리키는 변수가 없으면 기동하지 않는다.
- 키는 DB 덤프와 다른 저장소에 보관한다. 같은 곳에 두면 DB 본문 암호화의 의미가 없다(권장).
- 덤프와 복구본의 무결성을 관리한다. AAD가 `job_id`뿐이라 덤프의 `recipients`를 바꿔 복원하면 바뀐 수신자로 본문이 발송된다(ADR-0008 구현 중 확정 10). 덤프 보관 위치의 쓰기 권한을 제한하고 해시를 별도로 기록한다(권장, 실행해 확인하지 않았다).
- 복구 시점이 과거면 이후 `SENT`로 끝난 작업이 `PENDING`·`RETRY_WAIT`으로 되살아나 다시 발송될 수 있다. 백업 이후에 등록된 Key는 DB에 없어 같은 Key가 새 요청으로 등록된다. 복구 직후에는 사용처 outbox 상태와 `GET /jobs?idempotencyKey=`를 대조한다(데이터 모델에서 나온 귀결이며 복구를 실행해 확인하지 않았다).
- 복구 전에 입력 폴더의 파일은 DB와 무관하다. 폴더에 남은 파일은 복구한 DB에 대해 다시 수집되고 같은 Key로 걸러진다.

```txt
위험도: 높음 (복원은 기존 데이터를 덮어쓴다)
롤백: 복원 직전에 현재 DB를 별도로 pg_dump해 둔다. 그 덤프로 다시 복원한다
```

```sh
# 복원 예(빈 DB에 복원하는 것을 권장). 기존 객체를 지우는 --clean은 위험하다.
docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner < mailo-YYYY-MM-DD.dump
```

## 검증하지 않은 것

- 컨테이너 기동, 재생성, 재시작 후 자동 복구(RQ-025·026의 미충족 조건).
- 실제 SIGTERM을 받은 컨테이너의 종료 시간(`pause` 먼저 호출하는 새 종료 순서 포함).
- 운영 토큰·발송 정지 도입(`0008`)의 롤링 배포·롤백 실행. 다중 인스턴스에서 정지 명령 직후 점유를 마친 작업 수(상한은 코드 읽기에 따른 추정)와 정지 해제 직후의 SMTP 한도 반응.
- 수신 도메인 제한·이벤트 공백 감지 도입(`0009`)의 롤링 배포·롤백 실행. 구버전 인스턴스가 지운 이벤트가 공백 감지에서 빠진다는 동작은 코드 읽기 결과다. 30일 경과와 동시 삭제·조회는 DB 시각을 당긴 테스트로만 확인했고 실제 30일 운영은 하지 않았다.
- 운영 CLI를 `docker compose exec`로 실행하지 않았다(직접 `docker run`한 읽기 전용 컨테이너에서만 확인했다). 호스트에서 `https` 프록시 뒤 주소로 접속하는 구성도 실행하지 않았다.
- 작업 취소 도입(`0006`·`0007`)의 롤링 배포·롤백 실행, `ACCESS EXCLUSIVE` 잠금 대기 시간(대용량·쓰기 부하). 구버전의 동작은 코드를 읽어 적었다.
- 요청별 만료 시간 도입의 롤링 배포·롤백 실행, 긴 `MAILO_JOB_EXPIRY_MAX_SECONDS`에서의 대기 건수와 점유 지연.
- 이벤트 수신자 비움(`0017`·`0018`)의 롤링 배포·롤백 실행, `ADD COLUMN`의 `ACCESS EXCLUSIVE` 잠금 대기와 `CREATE INDEX CONCURRENTLY`의 쓰기 부하 아래 시간, 배포 직후 30일치 백필의 운영 크기 소요(`db-maintenance.md` "수신자 비움 측정"은 로컬 20만 건 한 번이다).
- 마이그레이션의 대용량 DB 적용 시간. `0005`(`CREATE INDEX CONCURRENTLY`)를 쓰기 부하 중에 적용한 시간도 측정하지 않았다.
- SMTP 계정 도입(묶음 A·B, `0010`~`0016`)의 롤링 배포·롤백 실행, `ACCESS EXCLUSIVE` 잠금 대기와 `CREATE INDEX CONCURRENTLY`·`DROP INDEX CONCURRENTLY`의 동시 쓰기 부하 아래 시간, 레거시 인덱스 삭제 뒤 구버전 점유 성능(한 쿼리 측정만), 다중 인스턴스(4개 이상) 동시 부하의 poll 비용·풀 점유·계정 advisory lock 경합, 둘 이상의 실제 Gmail·Workspace 계정, 계정별 한도 수치. 구버전의 `accountId` 거부와 컬럼 무시는 코드 읽기와 통합 테스트(컬럼 없는 `INSERT`)로만 확인했다. 컨테이너 `read_only`에서 계정 파일 마운트와 `_FILE` 비밀 읽기는 실행하지 않았다.
- `/metrics`(RQ-049~052): 운영 크기(수백만 행)·다중 인스턴스·Prometheus 복제본 여러 개의 동시 스크레이프에서의 쿼리 비용과 풀 점유(예비 연결 4개 가정), 롤링 배포(구버전 404는 코드 읽기 결과)와 롤백, 알림 규칙의 발화 조건과 임계값, 부하에서의 스크레이프 간격. 컨테이너·실제 Prometheus 스크레이프·`promtool`은 한 번씩 실행했다("지표").
- 백업·복구 절차.
- compose `secrets:` 방식의 시크릿 마운트(예시는 `docker compose config` 문법만 확인했다).
- 외부 시크릿 소스(`X_REF`, ADR-0016 묶음 A): 가짜 어댑터로 단위·통합 테스트(실제 PostgreSQL)와 컴파일한 진입점의 실패·성공 경로(프로세스 수준)를 확인했다. compose 예시의 실행, 롤링 배포·롤백, 저장소 장애 때 재시작 반복, `/proc/<pid>/environ`에서 해석값이 보이지 않는지는 확인하지 않았다.
- AWS 어댑터와 변형 이미지(ADR-0016 묶음 B, 2026-11-24): 어댑터 단위 테스트(가짜 SDK 클라이언트, 로컬 HTTP fixture를 거치는 실제 SDK), 로컬에서 빌드한 기본 이미지의 어댑터·SDK 부재 확인(`image-smoke/verify-base.sh`), 변형 이미지를 `read_only`·`cap_drop: [ALL]`·`--network none`으로 실행한 해석 스모크(`image-smoke/run.sh`: bare 패키지 이름 로드, 해석, JSON 키, 닫힌 코드, 로드 오류)를 실행했다. 실제 AWS(IAM, KMS, 자격 증명 체인, IMDSv2, throttling), 취약점 스캔, `release.yml` `variants` 잡의 GitHub 실행, 발행된 `-aws` 이미지의 pull과 compose 기동은 확인하지 않았다.
- `docker-compose.migrate-once.yml`의 실제 기동(문법만 확인했다). `docker-compose.nfs-example.yml`은 같은 호스트 loopback NFS에서만 기동을 확인했다(실제 NAS 미확인).
- TLS를 켠 PostgreSQL 서버에 대한 `MAILO_DB_SSLMODE` 접속.
- TLS 종단 프록시 구성, 다중 인스턴스 배포.
