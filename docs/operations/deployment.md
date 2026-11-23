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
- `NODE_ENV`는 `.env.example`에서 주석 처리돼 있어 복사한 `.env`로는 compose 기본값 `production`이 된다. production은 `.env.example`에 공개된 샘플 키(DB 본문 키·지문 키)와 샘플 DB 비밀번호(`mailo-dev-password`)를 거부하므로 새 값을 만들어 넣어야 기동한다(`key-management.md`). 공개 샘플 값으로 로컬 시험만 할 때는 `.env`에 `NODE_ENV=development`를 준다.
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

- 릴리스 태그마다 `ghcr.io/cp949/mailo:vX.Y.Z`와 `latest`가 발행된다(`linux/amd64`만). 발행 절차는 `ci.md` "릴리스 워크플로"다.
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
  - 현재 파일 중 `0005_job_priority_claim_index.sql`만 표식 파일이다. 나머지(`0001`~`0004`, `0006`, `0007`)는 트랜잭션 실행이다.
  - `0005`의 확인·복구 절차는 `troubleshooting.md` "등급별 적체"다.
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

## 환경 변수

모든 값은 `loadConfig`(`config/load-config.ts`)가 기동 때 검증한다. 빈 문자열은 설정하지 않은 값으로 본다. 정수는 숫자만 허용한다(`1e3`, 공백 포함 불가, 앞뒤 공백은 제거).
수치 기본값은 모두 설계 시점의 추정이다. `.env.example`의 주석 처리된 값은 이 표의 기본값과 같다(2026-11-23 대조).

### 실행·DB

| 변수 | 기본값 | 범위·형식 | 설명 |
| ---- | ------ | --------- | ---- |
| `NODE_ENV` | `production`(없을 때) | `development`, `test`, `production` | `development`·`test`가 아니면(값이 없어도) 공개 샘플 키와 같은 바이트의 DB 본문 키·지문 키, 같은 바이트가 반복된 키, 샘플 DB 비밀번호 `mailo-dev-password`를 거부한다(`key-management.md`). 이전에는 값이 없으면 `development`였다 |
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
| `MAILO_BODY_RETENTION_SECONDS` | 86400 | 1~31536000 | 종결 후 본문 삭제 유예 |
| `MAILO_RECORD_RETENTION_SECONDS` | 2592000 (30일) | 1~31536000 | 종결 후 작업 행·시도·이벤트·Key 보존, 거부 기록은 생성 후. `BODY` 이상이고 `JOB_EXPIRY_MAX` 이상이어야 한다 |
| `MAILO_MAINTENANCE_INTERVAL_SECONDS` | 60 | 1~86400 | 만료 sweep·lease 회수·본문 삭제·보존 삭제 주기 |

### SMTP(RQ-005)

| 변수 | 기본값 | 범위·형식 | 설명 |
| ---- | ------ | --------- | ---- |
| `MAILO_SMTP_HOST` | 없음(필수) | 호스트 이름 | |
| `MAILO_SMTP_SECURITY` | `starttls` | `starttls`, `tls`, `none` | `starttls`는 587 + STARTTLS 필수, `tls`는 465 implicit TLS, `none`은 TLS 없는 평문 연결(아래 "평문 SMTP 모드"). 인증서 검증 해제는 없다 |
| `MAILO_SMTP_PORT` | 587 (`tls`면 465) | 1~65535 | `none`도 기본 587이다 |
| `MAILO_SMTP_USER` | 없음 | 문자열 | `MAILO_SMTP_PASSWORD`와 함께 설정하거나 둘 다 비운다(IP 허용 릴레이) |
| `MAILO_SMTP_PASSWORD` | 없음 | 시크릿(`_FILE` 지원) | |
| `MAILO_SMTP_FROM` | `MAILO_SMTP_USER` | 주소 하나 | 요청이 `from`을 생략할 때의 발신 주소이자 모든 호출처가 쓸 수 있는 발신 주소. 그 밖의 `from`은 호출처의 `allowedFrom`(`callers.json`)에 있어야 하고 없으면 400 `FROM_NOT_ALLOWED`다(ADR-0008 구현 중 확정 12). USER도 없으면 필수 |
| `MAILO_SMTP_TIMEOUT_SECONDS` | 30 | 1~3600, `MAILO_LEASE_SECONDS` 미만. 기동 조건은 더 엄격하다(아래 표) | 소켓 무응답 상한. 연결·greeting·DNS는 이 값과 10초 중 작은 값, 한 건 전체 마감은 `min(이 값×3, lease−10초)` |

#### 평문 SMTP 모드

```txt
위험도: 높음
롤백: MAILO_SMTP_SECURITY를 starttls 또는 tls로 바꾸고 재시작한다
```

- `MAILO_SMTP_SECURITY=none`이면 SMTP 인증 정보와 메일(본문·제목·수신자)이 암호화 없이 전송된다. 사용 판단은 운영자 책임이다.
- 모든 `NODE_ENV`에서 받는다. 기본값은 `starttls`이고, `none`은 명시해야만 쓰인다.
- 서버가 STARTTLS를 광고해도 TLS로 올리지 않는다(nodemailer `ignoreTLS: true`).
- `MAILO_SMTP_USER`·`MAILO_SMTP_PASSWORD`가 있으면 평문으로 인증한다. 평문으로 보낸 인증 정보는 노출된 것으로 보고, 운영 계정에 쓰지 않는다. 썼다면 교체한다.
- 기동 때 Worker가 warn 로그 `smtp_plaintext_enabled`를 한 줄 남긴다. 필드는 `auth`(인증 정보 사용 여부)와 고정 문구 `message`뿐이고 호스트·사용자·비밀번호는 없다.
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
| `MAILO_JOB_EXPIRY_SECONDS` ≤ `MAILO_JOB_EXPIRY_MAX_SECONDS` | 기동 실패 |
| `MAILO_JWS_IAT_MAX_AGE_SECONDS` + `MAILO_JWS_IAT_SKEW_SECONDS` ≤ `MAILO_RECORD_RETENTION_SECONDS` | 기동 실패 |
| DB 본문 키 ≠ 지문 키(모든 버전 쌍) | 기동 실패 |
| 현재 버전 키 변수가 있어야 한다 | 기동 실패 |
| `MAILO_STOP_GRACE_PERIOD` ≥ drain 상한 + 10초(`max(1초, lease − 10초) + 10초`) | `MAILO_STOP_GRACE_PERIOD`가 설정된 경우에만 기동 실패. 변수가 없으면(앱이 오케스트레이터 설정을 알 수 없는 환경) 검사하지 않는다. 어기면 종료 때 SIGKILL이 먼저 와서 진행 중 전송이 lease 회수로 재발송될 수 있다 |
| `MAILO_DB_POOL_MAX` ≥ `MAILO_WORKER_CONCURRENCY` + 4 | 기동 실패. 전송이 끝난 작업마다 결과 기록에 커넥션 1개가 필요하고, 점유·주기 작업·HTTP·헬스·파일 폴러 몫으로 4개를 남긴다(4는 추정). 풀이 모자라면 기록이 대기하다 lease가 만료돼 중복 발송이 된다 |
| `MAILO_DB_QUERY_TIMEOUT_MS` > `MAILO_DB_STATEMENT_TIMEOUT_MS` | 기동 실패. 서버가 먼저 쿼리를 취소해야 연결이 살아남는다 |
| `MAILO_DB_CONNECT_TIMEOUT_MS` + `MAILO_DB_QUERY_TIMEOUT_MS` < `MAILO_LEASE_SECONDS` × 1000 − 10000 | 기동 실패. 결과 기록 시도 하나는 연결을 기다린 뒤 응답 없는 쿼리를 최대 이 시간까지 기다린다. 기록 재시도는 다음 시도의 시작 시각에 이 합을 더해도 lease 마감(lease − 10초) 안일 때만 한다. 기본값은 5초 + 35초 = 40초이고 lease 120초에서 통과한다(lease 50초 이하는 거부). 한 트랜잭션의 여러 문장이 각각 `query_timeout` 가까이 걸리는 경우까지는 막지 못한다 |
| 호출처 `sendQuota24h`가 있으면 `MAILO_RECORD_RETENTION_SECONDS` ≥ 86400 | Worker 기동 실패(`invalid worker option (field=callerQuotas.retention)`). 사용량은 최근 24시간의 `mail_attempts`를 세는데 기록이 그 전에 지워지면 할당이 느슨해진다(RQ-032) |

## 시크릿 주입

- 시크릿 변수는 `<NAME>_FILE`(파일 경로)을 주면 파일 내용을 읽는다. 파일이 있으면 같은 이름의 환경 변수보다 우선한다. 끝의 개행 한 개는 제거한다. 파일이 비었거나 읽지 못하면 기동 실패다(사유는 변수 이름과 errno 코드만 출력).
- `_FILE`을 지원하는 변수: `MAILO_DATABASE_URL`, `MAILO_DB_PASSWORD`, `MAILO_OPS_TOKEN`, `MAILO_OPS_ADMIN_TOKEN_<이름>`, `MAILO_SMTP_PASSWORD`, `MAILO_DB_ENCRYPTION_KEY_V<n>`, `MAILO_FINGERPRINT_KEY_V<n>`, 개인키 `MAILO_JWE_KEY_*`, 호출처 비밀키 `MAILO_JWS_SECRET_*`.
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
- 시크릿 파일 목록: DB 접속 URL, SMTP 비밀번호, 운영 읽기·관리 토큰, DB 본문 키 전 버전, 지문 키 전 버전, JWE 개인키 전부, JWS 비밀키 전부. 발급·교체는 `key-management.md`다.
- API 키 평문은 Mailo에 두지 않는다. `callers.json`에는 SHA-256 해시만 둔다(`caller-onboarding.md`).
- 로그·오류·이벤트에는 본문, 제목, 수신자 주소, 인증 정보, 키를 남기지 않는다(RQ-027).
- 관리 토큰 변수는 `.env`의 `MAILO_*`로 컨테이너에 전달되므로(`env_file`) compose에 이름별 설정을 더하지 않는다. `_FILE`로 받으면 파일 마운트를 따로 연다(위 `secrets:` 예시와 같다).

## 헬스

| 경로 | 인증 | 응답 |
| ---- | ---- | ---- |
| `GET /health/live` | 없음(`Authorization`을 읽지 않는다) | 200 `{"status":"UP"}` |
| `GET /health/ready` | 선택 | DB 연결 가능이면 200, 아니면 503 |

- `/health/ready`는 읽기 전용 트랜잭션 하나로 PostgreSQL 점검을 3초 안에 마친다. 쿼리에는 서버 쪽 `statement_timeout` 2초를 따로 걸고, 3초를 넘기면 그 연결을 풀에서 버린다. 응답만 포기하면 쿼리가 풀 슬롯을 계속 잡기 때문이다. 차단기가 `open`·`half_open`이어도 200이다. 등록과 조회는 정상이므로 오케스트레이터가 인스턴스를 내리면 안 된다.
- 발송 정지(Worker 정지, 적체)는 200/503에 반영하지 않는다. 원인이 DB나 SMTP 계정이면 재시작이 도움이 안 되고, 오탐이면 오케스트레이터가 정상 인스턴스를 재시작하기 때문이다. 대신 운영자 토큰(`MAILO_OPS_TOKEN`)으로 호출하면 아래 필드를 준다. 모니터링은 이 값을 폴링해 경보를 만든다.
- 인증 없이는 `status`, `checks.database`, `circuitBreaker.state`만 반환한다. 유효한 호출처 Bearer가 있으면 `openUntil`, `lastReason`, `eventFeed`, `sendPaused`를 더한다. 틀린 `Authorization`은 401이다.
- `sendPaused`는 그 호출처에 해당하는 발송 정지 요약이다(`{ paused, scope }`, `scope`는 `all`·`caller`·`null`). `all`과 `caller`가 함께 걸려 있으면 `all`이다. 호출처 ID·운영자 이름·시각은 없다. 정지는 200/503에 반영하지 않는다.
- 운영자 토큰(`Authorization: Bearer $MAILO_OPS_TOKEN` 또는 관리 토큰. 응답은 같다)은 `openUntil`, `lastReason`에 더해 다음을 반환한다(`eventFeed`·`sendPaused`는 호출처 전용이라 없다). 전역 수치는 다른 호출처의 발송량을 드러내므로 호출처 API 키로는 주지 않는다. 운영자 토큰은 업무 endpoint에서 401이다. 메일 본문·수신자·작업 ID·`caller_id`는 어느 필드에도 없다.

| 필드 | 의미 | 읽는 법 |
| ---- | ---- | ------- |
| `sendControls` | `{ allPaused, pausedCallerCount }`. 호출처 ID는 없다 | `allPaused`가 true이거나 `pausedCallerCount`가 0보다 크면 발송 정지가 걸려 있다. 어느 호출처인지는 `GET /ops/pauses`로 본다("발송 정지와 운영 REST") |
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
| 정지 목록 | `curl -s -H "Authorization: Bearer $READ" http://<host>:3000/ops/pauses` |
| 감사 목록 | `curl -s -H "Authorization: Bearer $READ" "http://<host>:3000/ops/audit?limit=20"` |

- 정지는 DB 행이라 모든 인스턴스가 다음 점유부터 같은 값을 본다. 환경 변수나 레지스트리처럼 재시작이 필요하지 않다.
- 전체 정지는 일반 점유와 차단기 대표 작업(probe) 점유를 모두 막는다. 호출처 정지는 그 호출처의 작업만 점유에서 빼고 호출처별 24시간 할당 계산에서도 뺀다. 정지는 차단기와 독립이다. 정지를 풀어도 차단기 상태는 바뀌지 않는다.
- 정지 중에도 lease 복구, 결과 기록, 만료 sweep, 본문·기록 삭제, 등록(REST·파일)은 계속 돈다. 이미 `SENDING`인 작업의 전송은 끝까지 간다. 정지 응답 직후에도 최대 인스턴스 수 × `MAILO_WORKER_CONCURRENCY`건이 점유를 마친 채 남을 수 있다(코드 읽기에 따른 상한 추정, 측정하지 않았다).
- 정지 중에도 작업의 `expiresAt`은 흐른다. 정지가 길면 `PENDING` 작업이 `EXPIRED`가 된다(`JOB_EXPIRED`). 정지 시간은 호출처 TTL(기본 24시간)보다 짧게 잡는다. 재개하면 점유 가능한 작업이 한꺼번에 대상이 되고 동시 전송 수와 우선순위(RQ-035)가 처리 순서를 정한다.
- 호출처 정지는 레지스트리의 `callerId`가 아니어도 걸린다. 응답의 `inRegistry`로 오타를 확인한다. 새 요청 자체를 막으려면 API 키를 폐기한다(`key-management.md`). 호출처를 레지스트리에서 빼도 큐에 이미 있는 작업은 계속 발송된다.
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
| `pause --all` 또는 `pause --caller <호출처 ID>` | 관리 | `PUT /ops/pauses/all`, `PUT /ops/pauses/callers/{callerId}` |
| `resume --all` 또는 `resume --caller <호출처 ID>` | 관리 | `DELETE` 같은 경로 |
| `jobs cancel <jobId>` | 관리 | `POST /ops/jobs/{jobId}/cancel` |

- 변경 명령(`pause`, `resume`, `jobs cancel`)은 `--yes`가 없으면 서버를 부르지 않고 종료 코드 1이다. `pause`·`resume`은 범위(`--all` 또는 `--caller`)를 하나 명시해야 하고 기본 범위가 없다.
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
| 전역 | gauge만 | `mailo_queue_`, `mailo_breaker_`, `mailo_send_paused`, `mailo_caller_`, `mailo_ops_audit_` 접두 | `max by (...)`. `sum`은 인스턴스 수만큼 곱해진다 |
| 인스턴스 counter | counter만 | `mailo_*_total` | `sum by (...) (rate(...))`. 재시작하면 0에서 다시 시작한다 |
| 인스턴스 gauge | gauge | `mailo_worker_`, `mailo_file_poller_`, `mailo_metrics_` 접두 | 인스턴스별로 본다 |
| 프로세스 | counter·gauge | `process_start_time_seconds`, `process_resident_memory_bytes`, `process_cpu_seconds_total` | 인스턴스별로 본다. 시작 시각은 프로세스가 시작할 때 한 번 정한 값이라 바뀌면 재시작이다 |

- `instance` 라벨은 앱이 붙이지 않는다. Prometheus의 타깃 라벨이 준다. 앱 로그의 `instance`와 다른 값이다.
- 라벨은 `caller_id`, `account_id`, `reason`과 값이 닫힌 열거(`state`, `priority`, `result`, `stage`, `status`, `group`)뿐이다. `caller_id`는 호출처 레지스트리에 있는 값이거나 `unregistered`다(레지스트리에서 뺀 호출처의 작업이 큐에 남아 있을 때). `account_id`는 `default` 하나다. 수신자·본문·제목·`Idempotency-Key`·작업 ID·SMTP 응답 코드와 텍스트·토큰은 어느 라벨에도 없다.
- 지표 하나의 시리즈는 2000개까지다. 넘으면 새 시리즈를 만들지 않고 `mailo_metrics_dropped_samples_total`을 올리며 `metrics_series_limit`(warn, 지표 이름만)을 한 번 남긴다. 호출처가 약 400개를 넘어야 닿는다(계산).

### 전역 gauge

DB 상태와 DB `now()`로 계산한다. 인스턴스마다 `MAILO_METRICS_CACHE_SECONDS`(기본 5초) 동안 같은 수집 결과를 다시 쓰고 동시에 온 스크레이프는 수집 하나를 기다린다. 수집은 풀 연결 하나로 그룹(`queue`·`breaker`·`controls`·`quota`·`feed`·`audit`)을 읽기 전용 트랜잭션에서 차례로 읽는다. 쓰기와 행 잠금이 없다.

| 이름 | 라벨 | 값 |
| ---- | ---- | -- |
| `mailo_queue_jobs` | `account_id`, `state`=`due`·`scheduled`·`sending` | 점유 가능, 재시도·예약 대기(`next_attempt_at`이 미래), 점유 중 건수. `due`·`scheduled`는 10000에서 멈춘다. `due`는 헬스 `queue.dueCount`와 같다 |
| `mailo_queue_jobs_truncated` | `account_id`, `state`=`due`·`scheduled` | 1이면 해당 건수가 상한에 닿았다 |
| `mailo_queue_oldest_due_age_seconds` | `account_id`, `priority`=`low`·`normal`·`high`·`urgent` | 등급별 가장 오래 기다린 점유 가능 작업의 경과 초. 대기가 없으면 0. 전체 값은 `max by (account_id)` |
| `mailo_breaker_state` | `account_id`, `state`=`closed`·`open`·`half_open` | 현재 상태만 1 |
| `mailo_breaker_reason_info` | `account_id`, `reason` | 상태가 `closed`가 아니고 사유가 있을 때만 1. 어휘는 헬스 `lastReason`과 같다 |
| `mailo_send_paused_all`, `mailo_send_paused_callers` | 없음 | 전체 정지 0/1, 정지한 호출처 수(레지스트리에 없는 호출처 포함) |
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
| `mailo_claim_polls_total` | `result`=`claimed`·`empty`·`error` | 점유 루프의 점유 호출 |
| `mailo_claimed_jobs_total` | `caller_id`, `account_id` | 점유한 작업 수 |
| `mailo_lease_recovered_total` | `account_id` | lease 만료로 회수한 작업 수. 중복 발송 가능성의 신호다(RQ-013) |
| `mailo_file_channel_files_total` | `caller_id`, `result`=`registered`·`duplicate`·`rejected`·`unreadable`·`delete_failed` | 파일 채널이 처리한 파일 수 |
| `mailo_event_cursor_gap_total` | `caller_id` | 이벤트 피드 cursor 공백을 감지한 요청 수 |
| `mailo_metrics_dropped_samples_total` | 없음 | 시리즈 상한이나 값 검증 때문에 버린 증가 수. 정상이면 0이다 |
| `mailo_worker_state` | `state`=`disabled`·`idle`·`running`·`paused`·`stopping`·`stopped` | Worker 상태(원핫) |
| `mailo_worker_in_flight_jobs`, `mailo_worker_last_poll_age_seconds` | 없음 | 진행 중 전송 수, 점유 루프가 마지막으로 돈 뒤 경과 초. Worker가 꺼져 있거나 아직 안 돌았으면 시리즈가 없다 |
| `mailo_worker_claim_failure_streak`, `mailo_worker_poll_loop_crashed` | 없음 | 연속 점유 실패 수, 점유 루프 사망 0/1(1이면 종료 코드 70으로 끝나는 중) |
| `mailo_file_poller_enabled`, `_running`, `_callers` | 없음 | 파일 채널이 켜졌는가, 동작 중인가, 폴링 대상 호출처 수. 꺼져 있으면 0 |
| `mailo_file_poller_last_poll_age_seconds`, `_last_poll_ok` | 없음 | 마지막 폴링 뒤 경과 초와 성공 여부. 아직 안 돌았으면 시리즈가 없다 |
| `mailo_metrics_collect_ok` | `group` | 마지막 DB 수집에서 그룹이 성공했으면 1. 0이면 그 그룹의 전역 지표가 응답에 없다 |
| `mailo_metrics_snapshot_age_seconds` | 없음 | 캐시된 DB 수집의 경과 초 |

- counter는 커밋한 뒤에 오른다. 커밋과 증가 사이에 프로세스가 죽으면 그 한 건을 놓친다.
- 시리즈가 처음 생기는 순간의 증가는 `increase()`·`rate()`가 놓친다(처음 보는 값이 1이면 증가량을 알 수 없다). 그래서 알림 규칙이 쓰는 counter는 시작할 때 0으로 미리 낸다.
  - 미리 내는 것: `mailo_claim_polls_total`(3개), `mailo_lease_recovered_total`, 그리고 레지스트리 호출처마다 `mailo_attempts_total`(5개)·`mailo_jobs_finished_total`(4개)·`mailo_claimed_jobs_total`·`mailo_event_cursor_gap_total`. 호출처 400개까지 지표당 2000개 안이다. 호출처가 더 많으면 앞의 2000개만 미리 낸다.
  - 미리 내지 못하는 것: `caller_id="unregistered"` 시리즈(레지스트리에서 뺀 호출처), `mailo_file_channel_files_total`, `mailo_attempt_errors_total`(조합이 불가능한 값이 많다). 이 시리즈의 첫 증가는 `increase()`가 놓친다. 이후 증가는 센다. 부록의 알림 규칙 중 이 시리즈에만 생기는 증가를 보는 것은 없다. `MailoFailedRatioHigh`는 `unregistered` 호출처의 첫 종결 하나를 놓칠 수 있다.
- 종결 건수는 DB로 세지 않는다(상태별 `count(*)`를 받치는 인덱스가 없다). `mailo_jobs_finished_total`의 `increase`로 본다. 재시작과 인스턴스 교체를 `rate`·`increase`가 처리한다.
- 평균 발송 처리 시간은 히스토그램이 필요해 정하지 않았다.

### 알림 규칙 예시

임계값은 모두 추정이고 부하에서 확인하지 않았다. `promtool check rules`가 문법을 통과시켰고(2026-11-24, `prom/prometheus:v2.55.1`) 실제 Prometheus가 컨테이너를 스크레이프하며 12개 규칙을 평가했다(모두 `ok`). 알림이 발화하는 조건은 실행해 확인하지 않았다. 전역 gauge는 `max by`로, counter는 `sum`과 `rate`·`increase`로 쓴다. `for:`는 캐시 TTL(기본 5초)보다 충분히 길다.

```yaml
groups:
  - name: mailo
    rules:
      - alert: MailoInstanceDown
        expr: up{job="mailo"} == 0
        for: 2m

      - alert: MailoBreakerNotClosed
        expr: max by (account_id) (mailo_breaker_state{state=~"open|half_open"}) == 1
        for: 10m

      - alert: MailoQueueBacklogAge
        expr: max by (account_id) (mailo_queue_oldest_due_age_seconds) > 600
        for: 10m

      - alert: MailoQueueTruncated
        expr: max(mailo_queue_jobs_truncated{state="due"}) == 1
        for: 15m

      - alert: MailoNoProgress
        expr: |
          max(mailo_queue_jobs{state="due"}) > 0
          and sum(rate(mailo_attempts_total[10m])) == 0
          and max(mailo_send_paused_all) == 0
          and max(mailo_breaker_state{state="closed"}) == 1
        for: 15m

      - alert: MailoFailedRatioHigh
        expr: |
          sum(increase(mailo_jobs_finished_total{status="failed"}[15m]))
            / clamp_min(sum(increase(mailo_jobs_finished_total{status=~"sent|failed"}[15m])), 1) > 0.2
          and sum(increase(mailo_jobs_finished_total{status="failed"}[15m])) >= 10
        for: 5m

      - alert: MailoSendPausedLong
        expr: max(mailo_send_paused_all) == 1 or max(mailo_send_paused_callers) > 0
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

      - alert: MailoLeaseRecovered
        expr: sum(increase(mailo_lease_recovered_total[15m])) > 0   # 중복 발송 가능성 신호(RQ-013)

      - alert: MailoAuditRowsHigh
        expr: max(mailo_ops_audit_rows) > 50000   # 임계값은 근거 없는 예시
        for: 1h
```

- `MailoNoProgress`의 `sum(rate(mailo_attempts_total[10m])) == 0`은 호출처 시리즈를 0으로 미리 내므로 시도가 한 번도 없어도 참이다. 기동 직후 `due`가 있고 정지·차단이 없는데 15분 동안 시도가 없으면 발화한다(추정, 실행해 확인하지 않았다).
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
- 앱이 정한 이벤트 이름: `unhandled_error`, `readiness_check_failed`, `db_idle_client_error`, `job_canceled`(앱 계층, `jobId`·`callerId`·`canceledBy`, 호출처가 대기 작업을 취소했을 때. 이미 취소된 작업의 재요청에는 남지 않는다), `ops_pause_set`·`ops_pause_cleared`(info, `actor`·`scope`(`all`·`caller`)·`callerId`(`caller`일 때만), 상태를 바꾼 관리 요청만. 멱등 재요청은 남지 않는다), `ops_job_canceled`(info, `actor`·`jobId`), `metrics_collect_failed`(warn, `group`·`error`. `/metrics`의 DB 수집 그룹이 성공에서 실패로 바뀔 때 한 번. 같은 그룹의 연속 실패 동안 반복하지 않는다), `metrics_series_limit`(warn, `metric`만. 지표 하나의 시리즈가 상한에 처음 닿았을 때 한 번), `event_cursor_gap`(warn, `callerId`만. `GET /events`가 `after` 뒤의 삭제를 발견한 응답마다 한 줄이고 헤더든 410이든 같다), Worker의 `send_paused`(warn)·`send_resumed`(info)(`scope`, `callerId`는 `caller`일 때만. 정지 상태가 바뀐 것을 관찰할 때 한 번만 남고 폴링마다 반복하지 않는다), Worker와 파일 폴러의 이벤트(`claim_failed`, `worker_paused`, `drain_timeout`, `file_poll`, `file_inbox_missing` 등, `troubleshooting.md`).
- 필터 예: `docker compose logs --no-log-prefix mailo | jq -c 'select(.level=="error" or .level=="warn")'`. JSON이 아닌 줄(Node가 직접 쓰는 경고, 기동 전 설정 오류 메시지)이 섞일 수 있으니 `jq -R 'fromjson? | select(.)'`를 쓴다. 기동 실패는 `event: "startup_failed"`(필드 `error`는 예외 이름·코드, 설정 오류는 변수 이름만 담은 `message`)로 남는다. 설정을 읽기 전의 실패는 `instance`가 호스트 이름이다(`MAILO_INSTANCE_ID`를 아직 읽지 못했다).
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
- 시각은 DB `now()`를 쓴다. 앱 서버 시계와 DB 시계가 달라도 lease·만료·할당은 DB 기준이다. JWS `iat`와 임시 파일 정리는 Mailo 호스트 시계를 쓴다.

## 백업과 복구

백업은 DB 덤프와 키를 따로 보관한다. 이 절의 명령은 실행하지 않았다.

```sh
# 백업(compose 서비스 이름 postgres 가정)
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > mailo-$(date +%F).dump
```

- 덤프에 들어 있는 것: 작업 행(수신자 평문, 본문 암호문, 지문), 시도 기록, 이벤트, 거부 기록, 차단기 행, `schema_migrations`. 본문은 DB 본문 키로 암호화돼 있다(종결 후 1일 뒤 삭제).
- 복원에 필요한 키:
  - DB 본문 암호화 키: 미종결 작업과 종결 후 유예(기본 1일) 안의 작업 본문을 읽는 데 필요하다. 해당 `body_key_version`의 키가 없으면 그 작업은 복호화 실패(`BodyCipherError:UNKNOWN_KEY_VERSION`)로 `job_internal_error`를 남기고 3번째 시도에서 `FAILED`가 된다.
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
- 마이그레이션의 대용량 DB 적용 시간. `0005`(`CREATE INDEX CONCURRENTLY`)를 쓰기 부하 중에 적용한 시간도 측정하지 않았다.
- `/metrics`(RQ-049~052): 운영 크기(수백만 행)·다중 인스턴스·Prometheus 복제본 여러 개의 동시 스크레이프에서의 쿼리 비용과 풀 점유(예비 연결 4개 가정), 롤링 배포(구버전 404는 코드 읽기 결과)와 롤백, 알림 규칙의 발화 조건과 임계값, 부하에서의 스크레이프 간격. 컨테이너·실제 Prometheus 스크레이프·`promtool`은 한 번씩 실행했다("지표").
- 백업·복구 절차.
- compose `secrets:` 방식의 시크릿 마운트(예시는 `docker compose config` 문법만 확인했다).
- `docker-compose.migrate-once.yml`의 실제 기동(문법만 확인했다). `docker-compose.nfs-example.yml`은 같은 호스트 loopback NFS에서만 기동을 확인했다(실제 NAS 미확인).
- TLS를 켠 PostgreSQL 서버에 대한 `MAILO_DB_SSLMODE` 접속.
- TLS 종단 프록시 구성, 다중 인스턴스 배포.
