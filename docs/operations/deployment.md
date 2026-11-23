# 배포와 설정

compose 구성, 환경 변수, 시크릿 주입, 마이그레이션, 헬스, 종료 시간, 백업·복구를 적는다.
값과 변수 이름은 2026-11-23 코드(`apps/mailo/src/config/`, `callers/registry.ts`, `envelope/key-file.ts`)에서 가져왔다.
표기: "추정"은 코드나 실행으로 확인하지 않은 항목이다. 컨테이너 기동, 마이그레이션 실행, 백업·복구는 이 문서를 쓰는 과정에서 실행하지 않았다.

## 결론

- 상시 서비스는 `mailo`와 `postgres` 둘뿐이다(RQ-029). 저장소 루트의 `docker-compose.yml`이 둘을 정의한다.
- 설정 오류는 기동 시점에 변수 이름과 사유를 출력하고 종료 코드 1로 끝난다. 값은 출력하지 않는다.
- `stop_grace_period`는 `MAILO_LEASE_SECONDS` 이상이어야 한다. 이 관계를 검사하는 자동 검증은 없다.
- PostgreSQL 13 이상이 필요하다. compose는 `postgres:17-alpine`이다.
- DB 암호화 키·지문 키·JWE 개인키를 DB 백업과 별도로 보관한다. 이 키 없이는 복원한 DB의 일부 기능이 동작하지 않는다("백업과 복구").

## compose 구성

| 서비스 | 이미지 | 노출 | 비고 |
| ------ | ------ | ---- | ---- |
| `postgres` | `postgres:17-alpine` | `127.0.0.1:${MAILO_DB_PUBLISH_PORT:-5432}` | 볼륨 `postgres-data`, `pg_isready` healthcheck, `restart: unless-stopped` |
| `mailo` | 저장소 `Dockerfile` 빌드(`node:24.20.0-alpine`) | `${MAILO_PUBLISH_HOST:-127.0.0.1}:${MAILO_PUBLISH_PORT:-3000}:3000` (기본 같은 호스트만) | non-root(`node`, UID 1000), `restart: unless-stopped`, `stop_grace_period: 150s`, healthcheck(`/health/live`) |

- `mailo`는 `.env`를 `env_file`로 읽는다. `.env`가 없으면 compose가 실패한다. `.env.example`을 복사해 만든다.
- `NODE_ENV`는 `.env.example`에서 주석 처리돼 있어 복사한 `.env`로는 compose 기본값 `production`이 된다. production은 `.env.example`에 공개된 샘플 키(DB 본문 키·지문 키)를 거부하므로 키를 새로 만들어 넣어야 기동한다(`key-management.md`). 공개 샘플 키로 로컬 시험만 할 때는 `.env`에 `NODE_ENV=development`를 준다.
- HTTP 포트는 기본 `127.0.0.1`에만 연다. TLS 프록시가 다른 호스트에 있거나 같은 호스트의 다른 인터페이스로 접근해야 하면 `.env`에 `MAILO_PUBLISH_HOST`(예: `0.0.0.0`, 인터페이스 주소)를 준다. Mailo는 TLS를 종단하지 않으므로 `0.0.0.0`으로 열 때는 프록시나 방화벽으로 접근을 제한한다.
- compose의 `environment`가 `.env`보다 우선한다. 컨테이너에서 `NODE_ENV`(기본 `production`), `MAILO_PORT=3000`, `MAILO_DB_*`(아래), `MAILO_CALLERS_FILE=/run/mailo/callers.json`은 compose 값이 쓰인다.
- compose는 접속 URL을 이어 붙이지 않고 `MAILO_DB_HOST=postgres`, `MAILO_DB_PORT`, `MAILO_DB_USER`(`POSTGRES_USER`), `MAILO_DB_PASSWORD`(`POSTGRES_PASSWORD`), `MAILO_DB_NAME`(`POSTGRES_DB`)를 준다. 앱이 이 값으로 URL을 조립하면서 사용자·비밀번호·DB 이름을 URL 인코딩하므로 `POSTGRES_PASSWORD`에 `@`, `/`, `:`, `#`, `%`를 써도 된다. 이유: 이어 붙이는 방식은 이 문자에서 URL이 깨지고 compose는 인코딩할 수 없다. compose는 `.env`의 호스트 실행용 `MAILO_DATABASE_URL`이 컨테이너에 새지 않도록 빈 값으로 덮는다. 두 방식을 함께 주면 기동을 거부한다.
- compose 기본값 `POSTGRES_PASSWORD=mailo-dev-password`는 개발용 가짜 값이다. 운영은 반드시 다른 값을 준다.
- `./callers.json`을 컨테이너의 `/run/mailo/callers.json`에 읽기 전용으로 마운트한다. 파일이 없으면 `callers.example.json`을 복사해 만든다. `/callers.json`은 `.gitignore` 대상이다.
- Mailo는 TLS를 종단하지 않는다(코드에 TLS 설정이 없다). Bearer 키가 평문으로 오가지 않도록 TLS를 종단하는 프록시 뒤에 두거나 신뢰하는 내부 망에서만 노출한다.
- `mailo` healthcheck는 이미지에 curl이 없어 `node -e fetch(...)`로 `GET http://127.0.0.1:3000/health/live`를 10초마다 호출한다(타임아웃 5초, 3회 실패 시 unhealthy, `start_period` 30초). DB 상태는 보지 않는다. 준비 확인은 "헬스" 절을 따른다.
- 파일 채널을 켜려면 `.env`에 `MAILO_FILE_CHANNEL_ROOT=/var/mailo/files`를 주고 `docker-compose.yml`의 주석 처리된 볼륨 줄을 연다. 폴더와 권한은 호스트에서 만든다(`caller-onboarding.md`, `nfs.md`).

기동:

```sh
cp .env.example .env              # 값을 실제 값으로 바꾼다(DB 본문 키·지문 키는 새로 만든다: key-management.md)
cp callers.example.json callers.json   # 해시를 실제 호출처 키의 SHA-256으로 바꾼다
docker compose up -d --build
```

## 기동 순서와 마이그레이션

컨테이너 명령은 `sh -c "node dist/db/migrate-cli.js && exec node dist/main.js"`이다. 마이그레이션이 실패하면 앱은 뜨지 않는다. `exec`로 node가 PID 1을 이어받아 SIGTERM이 node에 직접 전달된다.

- 마이그레이션 실행기(`src/db/migrator.ts`)는 `apps/mailo/migrations/NNNN_이름.sql`을 파일명 순서로 적용한다. 파일마다 트랜잭션 하나이고, 실패하면 그 파일만 롤백하고 중단한다.
- 적용 기록은 `schema_migrations`에 남는다. 이미 적용한 파일은 건너뛴다. 적용한 파일의 내용이 바뀌어도 감지하지 않으므로 적용한 파일은 고치지 않고 새 파일을 추가한다(AGENTS.md).
- 인스턴스가 동시에 기동해도 advisory lock(키 `7364221001`)으로 직렬화한다.
- `Dockerfile`의 기본 `CMD`는 `node dist/main.js`다. compose 밖에서 이미지를 실행하면 마이그레이션이 돌지 않는다. 먼저 `node dist/db/migrate-cli.js`를 실행한다.
- 호스트에서 직접 적용: `MAILO_DATABASE_URL`을 주고 `pnpm build`를 한 뒤 `pnpm --filter @cp949/mailo migrate`(빌드 결과 `dist/db/migrate-cli.js`를 실행한다).
- down 마이그레이션은 없다.
- 현재 파일: `0001_queue_schema.sql`(5개 테이블, PostgreSQL 13 이상 필요), `0002_caller_quota.sql`(`mail_attempts.caller_id` 추가·채움, 부분 인덱스 2개).
- `0002`는 `mail_attempts` 전체를 `UPDATE`하고 인덱스를 `CONCURRENTLY` 없이 만든다. 시도 행이 많은 DB에서는 적용 중 쓰기가 잠시 막힐 수 있다(코드 읽기 결과, 대용량에서 측정하지 않았다).
- 이전 버전 인스턴스가 `0002` 적용 뒤에도 돌면 `caller_id` 없이 시도를 기록한다. 그런 행은 호출처 할당 사용량에 잡히지 않는다(마이그레이션 주석). 롤링 배포가 끝나면 사라진다.

```txt
위험도: 중간 (스키마 변경)
롤백: down 마이그레이션 없음. 적용 전 pg_dump 백업을 복원한다
```

## 환경 변수

모든 값은 `loadConfig`(`config/load-config.ts`)가 기동 때 검증한다. 빈 문자열은 설정하지 않은 값으로 본다. 정수는 숫자만 허용한다(`1e3`, 공백 포함 불가, 앞뒤 공백은 제거).
수치 기본값은 모두 설계 시점의 추정이다. `.env.example`의 주석 처리된 값은 이 표의 기본값과 같다(2026-11-23 대조).

### 실행·DB

| 변수 | 기본값 | 범위·형식 | 설명 |
| ---- | ------ | --------- | ---- |
| `NODE_ENV` | `development` | `development`, `test`, `production` | compose 컨테이너는 `.env`·셸에 값이 없으면 `production`. `production`이면 공개 샘플 키와 같은 바이트의 DB 본문 키·지문 키, 같은 바이트가 반복된 키를 거부한다(`key-management.md`) |
| `MAILO_PORT` | 3000 | 1~65535 | listen 포트. 컨테이너 안은 3000 고정 |
| `MAILO_DATABASE_URL` | 없음(`MAILO_DB_HOST`가 없으면 필수) | `postgres://` 또는 `postgresql://` URL | 시크릿(`_FILE` 지원). 비밀번호는 호출자가 URL 인코딩해야 한다. compose 컨테이너는 비운다 |
| `MAILO_DB_HOST`, `MAILO_DB_PORT`, `MAILO_DB_USER`, `MAILO_DB_PASSWORD`, `MAILO_DB_NAME` | 포트 5432, 나머지 없음 | `MAILO_DB_HOST`를 주면 사용자·DB 이름 필수, 비밀번호 선택 | `MAILO_DATABASE_URL`의 대안. 앱이 URL 인코딩해 조립한다. `MAILO_DB_HOST`는 호스트 이름, IPv4, 대괄호 IPv6(`[::1]`)만 받는다. 포트·경로·공백이 있으면 기동 거부(포트는 `MAILO_DB_PORT`). `MAILO_DB_PASSWORD`는 `_FILE` 지원. `MAILO_DATABASE_URL`과 함께 주면 기동 거부 |
| `MAILO_DB_POOL_MAX` | 10 | 1~200 | 커넥션 풀 최대 수 |
| `MAILO_DB_CONNECT_TIMEOUT_MS` | 5000 | 100~60000 | 연결 대기 |
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
| `MAILO_JOB_EXPIRY_SECONDS` | 86400 | 1~31536000 | 새 작업의 만료 TTL |
| `MAILO_LEASE_SECONDS` | 120 | 5~86400 | 작업 점유 lease. `stop_grace_period`와 연동 |
| `MAILO_WORKER_POLL_MS` | 1000 | 50~600000 | claim 폴링 간격(±10% 흩뿌림) |
| `MAILO_WORKER_CONCURRENCY` | 4 | 1~100 | 동시 전송 수 |
| `MAILO_RETRY_MAX_ATTEMPTS` | 8 | 1~100 | 첫 시도 포함. 계정 상태 오류 시도는 제외 |
| `MAILO_RETRY_MODE` | `exponential` | `exponential`, `fixed` | |
| `MAILO_RETRY_BASE_SECONDS` | 60 | 1~86400 | |
| `MAILO_RETRY_MULTIPLIER` | 2 | 1~10 (소수 가능) | |
| `MAILO_RETRY_CAP_SECONDS` | 3600 | 1~604800, `BASE` 이상 | |
| `MAILO_RETRY_JITTER_RATIO` | 0.2 | 0 이상 1 미만 | ±비율 |

코드에 환경 변수가 없는 값: 독성 작업 최대 시도 3회(`poisonMaxAttempts`), 배치 크기(sweep 500), 차단기 키 `default`.

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
| `MAILO_RECORD_RETENTION_SECONDS` | 2592000 (30일) | 1~31536000 | 종결 후 작업 행·시도·이벤트·Key 보존, 거부 기록은 생성 후. `BODY` 이상이고 `JOB_EXPIRY` 이상이어야 한다 |
| `MAILO_MAINTENANCE_INTERVAL_SECONDS` | 60 | 1~86400 | 만료 sweep·lease 회수·본문 삭제·보존 삭제 주기 |

### SMTP(RQ-005)

| 변수 | 기본값 | 범위·형식 | 설명 |
| ---- | ------ | --------- | ---- |
| `MAILO_SMTP_HOST` | 없음(필수) | 호스트 이름 | |
| `MAILO_SMTP_SECURITY` | `starttls` | `starttls`, `tls` | `starttls`는 587 + STARTTLS 필수, `tls`는 465 implicit TLS. 평문과 인증서 검증 해제는 없다 |
| `MAILO_SMTP_PORT` | 587 (`tls`면 465) | 1~65535 | |
| `MAILO_SMTP_USER` | 없음 | 문자열 | `MAILO_SMTP_PASSWORD`와 함께 설정하거나 둘 다 비운다(IP 허용 릴레이) |
| `MAILO_SMTP_PASSWORD` | 없음 | 시크릿(`_FILE` 지원) | |
| `MAILO_SMTP_FROM` | `MAILO_SMTP_USER` | 주소 하나 | 요청이 `from`을 생략할 때의 발신 주소. USER도 없으면 필수 |
| `MAILO_SMTP_TIMEOUT_SECONDS` | 30 | 1~3600, `MAILO_LEASE_SECONDS` 미만. 기동 조건은 더 엄격하다(아래 표) | 소켓 무응답 상한. 연결·greeting·DNS는 이 값과 10초 중 작은 값, 한 건 전체 마감은 `min(이 값×3, lease−10초)` |

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
| `MAILO_FILE_CHANNEL_ROOT` | 없음(꺼짐) | 절대 경로 | 있을 때만 폴러가 켜진다. 읽을 수 있는 디렉터리가 아니면 기동 실패 |
| `MAILO_FILE_POLL_INTERVAL_MS` | 30000 | 50~3600000 | 폴링 간격(±10%) |
| `MAILO_FILE_BATCH_PER_CALLER` | 100 | 1~10000 | 폴링 한 번에 호출처 하나가 처리하는 파일 수 |
| `MAILO_FILE_MAX_BYTES` | `MAILO_MAX_REQUEST_BYTES` | 1024~64 MiB | 파일 원시 바이트 상한 |
| `MAILO_FILE_TEMP_MAX_AGE_SECONDS` | 3600 | 1~31536000 | 점(.) 임시 파일 삭제 기준(mtime과 Mailo 시계 차이) |

### compose 전용(Mailo 설정 아님)

`POSTGRES_USER`(`mailo`), `POSTGRES_PASSWORD`(`mailo-dev-password`), `POSTGRES_DB`(`mailo`), `MAILO_PUBLISH_HOST`(127.0.0.1), `MAILO_PUBLISH_PORT`(3000), `MAILO_DB_PUBLISH_PORT`(5432). 컨테이너 밖 Node가 읽는 `NODE_EXTRA_CA_CERTS`는 로컬 SMTP 서버 검증용 CA에 쓴다(AGENTS.md).

### 변수 사이의 제약

| 제약 | 어기면 |
| ---- | ------ |
| `MAILO_SMTP_TIMEOUT_SECONDS` < `MAILO_LEASE_SECONDS` | 기동 실패(설정 오류). 이 검사만 통과해도 발송기 조립에서 `SmtpConfigError code=TIMEOUT_EXCEEDS_LEASE`로 실패할 수 있다. 조건은 `2×min(T,10초) + T + 10초 ≤ lease`(T = 이 변수)이고 기본값(T=30)은 lease 60초 이상이다. 실행으로 확인: lease 20초·T 10초는 `TIMEOUT_EXCEEDS_LEASE`, lease 45초·T 10초는 기동 |
| `MAILO_MAX_CONTENT_BYTES` ≤ `MAILO_MAX_REQUEST_BYTES` | 기동 실패 |
| `MAILO_RETRY_CAP_SECONDS` ≥ `MAILO_RETRY_BASE_SECONDS` | 기동 실패 |
| `MAILO_RECORD_RETENTION_SECONDS` ≥ `MAILO_BODY_RETENTION_SECONDS`, ≥ `MAILO_JOB_EXPIRY_SECONDS` | 기동 실패 |
| `MAILO_JWS_IAT_MAX_AGE_SECONDS` + `MAILO_JWS_IAT_SKEW_SECONDS` ≤ `MAILO_RECORD_RETENTION_SECONDS` | 기동 실패 |
| DB 본문 키 ≠ 지문 키(모든 버전 쌍) | 기동 실패 |
| 현재 버전 키 변수가 있어야 한다 | 기동 실패 |
| `stop_grace_period` ≥ `MAILO_LEASE_SECONDS` | 자동 검사 없음. 어기면 종료 때 SIGKILL이 먼저 와서 진행 중 전송이 lease 회수로 재발송될 수 있다 |
| `MAILO_WORKER_CONCURRENCY` < `MAILO_DB_POOL_MAX` | 자동 검사 없음(`.env.example` 권고). 코드는 전송 한 건이 순간 커넥션 1개를 쓴다고 가정한다 |

## 시크릿 주입

- 시크릿 변수는 `<NAME>_FILE`(파일 경로)을 주면 파일 내용을 읽는다. 파일이 있으면 같은 이름의 환경 변수보다 우선한다. 끝의 개행 한 개는 제거한다. 파일이 비었거나 읽지 못하면 기동 실패다(사유는 변수 이름과 errno 코드만 출력).
- `_FILE`을 지원하는 변수: `MAILO_DATABASE_URL`, `MAILO_DB_PASSWORD`, `MAILO_SMTP_PASSWORD`, `MAILO_DB_ENCRYPTION_KEY_V<n>`, `MAILO_FINGERPRINT_KEY_V<n>`, 개인키 `MAILO_JWE_KEY_*`, 호출처 비밀키 `MAILO_JWS_SECRET_*`.
- 운영은 시크릿 파일 마운트를 권장한다(ADR-0008 결정 5·6). 환경 변수도 허용하지만 `docker inspect`와 프로세스 환경에서 보인다(일반 지식).
- 이미지에는 시크릿을 넣지 않는다. `Dockerfile`에 시크릿을 넣는 단계가 없다(이미지를 빌드해 검사하지는 않았다).
- 이 저장소의 `docker-compose.yml`은 compose `secrets:`를 정의하지 않는다. 쓰려면 호스트 파일을 컨테이너에 읽기 전용으로 마운트하고(`/run/secrets/...` 등) `.env`에 `_FILE` 변수를 준다. 이 방식은 실행해 확인하지 않았다(추정).
- 마운트한 파일은 Mailo 실행 계정(UID 1000)이 읽을 수 있어야 한다. 다른 계정은 읽지 못하게 둔다.
- 개인키 PEM은 환경 변수로 줄 때 줄바꿈을 `\n` 두 글자로 써도 된다(`key-file.ts`). 파일로 주면 일반 PEM이다.
- 시크릿 파일 목록: DB 접속 URL, SMTP 비밀번호, DB 본문 키 전 버전, 지문 키 전 버전, JWE 개인키 전부, JWS 비밀키 전부. 발급·교체는 `key-management.md`다.
- API 키 평문은 Mailo에 두지 않는다. `callers.json`에는 SHA-256 해시만 둔다(`caller-onboarding.md`).
- 로그·오류·이벤트에는 본문, 제목, 수신자 주소, 인증 정보, 키를 남기지 않는다(RQ-027).

## 헬스

| 경로 | 인증 | 응답 |
| ---- | ---- | ---- |
| `GET /health/live` | 없음(`Authorization`을 읽지 않는다) | 200 `{"status":"UP"}` |
| `GET /health/ready` | 선택 | DB 연결 가능이면 200, 아니면 503 |

- `/health/ready`는 PostgreSQL에 `SELECT 1`을 3초 안에 실행한다. 차단기가 `open`·`half_open`이어도 200이다. 등록과 조회는 정상이므로 오케스트레이터가 인스턴스를 내리면 안 된다.
- 인증 없이는 `status`, `checks.database`, `circuitBreaker.state`만 반환한다. 유효한 Bearer가 있으면 `openUntil`, `lastReason`, `eventFeed`를 더한다. 틀린 `Authorization`은 401이다.
- 오케스트레이터의 liveness는 `/health/live`, readiness는 `/health/ready`(인증 없이)를 쓰는 구성을 권한다(추정, 실행해 확인하지 않았다).
- 파일 폴러의 마지막 폴링 상태는 외부로 노출하지 않는다(내부 `status()`뿐). 폴러 이상은 로그로 본다(`troubleshooting.md`).
- 로그는 표준 출력이다. Worker·파일 폴러는 한 줄 JSON(`{"level","event",...}`)이고, HTTP 요청·DB·헬스는 Nest 로거의 텍스트 줄이다. 헬스 요청 로그는 debug라 기본 출력에 나오지 않는다(추정).

## 종료와 stop_grace_period

종료 순서(`app-lifecycle.ts`): HTTP 서버 닫기 → 파일 폴러 정지(진행 중 파일 완료) → Worker drain → DB 풀 닫기.

- drain 상한은 `max(1초, MAILO_LEASE_SECONDS − 10초)`다. 상한을 넘으면 `drain_timeout` 경고를 남기고 남은 전송을 끊는다. 끊긴 작업은 결과를 기록하지 않고 lease 만료 뒤 회수된다(중복 발송 가능, RQ-013).
- `stop_grace_period`가 lease보다 짧으면 drain 상한에 이르기 전에 SIGKILL이 온다. 모든 재배포마다 진행 중 전송이 lease 회수 대상이 된다(ADR-0002 결정 12).
- 기본값: lease 120초, drain 상한 110초, `stop_grace_period` 150초. 40초는 HTTP 닫기, 폴러 정지, 풀 닫기의 여유다(수치는 추정이며 이 시간을 측정하지 않았다).
- lease를 바꾸면 `stop_grace_period`를 함께 바꾼다. 예: `MAILO_LEASE_SECONDS=300`이면 `stop_grace_period`를 330s 이상으로 둔다.
- `docker compose stop`과 `restart`는 SIGTERM을 보낸다. 앱은 SIGTERM·SIGINT에서 종료 훅을 실행한다(`enableShutdownHooks`).
- 컨테이너에 실제 SIGTERM을 보내 확인하지 않았다. Worker와 앱 종료 훅은 통합 테스트로 확인했다(RQ-025).

## PostgreSQL 요건

- 13 이상이 필요하다. 이벤트 피드 cursor가 `xid8`, `pg_current_xact_id()`, `pg_snapshot_xmin(pg_current_snapshot())`을 쓰기 때문이다(ADR-0006 결정 7). `0001` 마이그레이션이 13 미만에서 실패한다. `db/migrator.integration-spec.ts`가 서버 버전 13 이상을 확인한다.
- 운영 DB 계정은 테이블·인덱스 생성 권한이 필요하다(마이그레이션이 같은 계정으로 돈다).
- 사용처용 DB 계정과 접속 경로를 만들지 않는다. compose는 PostgreSQL을 `127.0.0.1`에만 노출한다(RQ-003).
- 이벤트 피드는 DB 어디서든 긴 트랜잭션이 있으면 지연된다. 긴 트랜잭션을 여는 작업(대용량 `pg_dump` 등)은 피드 지연을 만든다(`troubleshooting.md`).
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
- 실제 SIGTERM을 받은 컨테이너의 종료 시간.
- 마이그레이션의 대용량 DB 적용 시간.
- 백업·복구 절차.
- compose `secrets:` 방식의 시크릿 마운트.
- TLS 종단 프록시 구성, 다중 인스턴스 배포.
