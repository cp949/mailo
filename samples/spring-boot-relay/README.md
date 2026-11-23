# Spring Boot outbox + relay 샘플

사용처(호출 서버)가 비즈니스 트랜잭션과 메일 요청을 같은 DB 트랜잭션에 쓰고, 별도 relay가 커밋 뒤 Mailo로 전달하는 구성의 실행 가능한 예시다.
근거: RQ-004, RQ-021, RQ-017, RQ-022, ADR-0001 결정 4·5, ADR-0005, ADR-0006, ADR-0008, ADR-0011 구현 순서 1(모르는 값 처리). 연동 규칙의 기준은 `docs/operations/caller-onboarding.md`와 `docs/api/openapi.yaml`이다.

## 검증 상태

2026-11-24에 이 저장소의 Mailo(`apps/mailo`)와 실제로 연결해 실행했다(`verify/run-e2e.sh`). 결과는 아래 "실행 검증 결과"에 있다.

- 컴파일과 단위 테스트 30건은 JDK 21.0.13, Gradle 8.14.3으로 통과했다. 이벤트 피드·`NeedsCheckResolver` 테스트는 DB와 Mailo 없이 대역(`FakeMailoClient`, `FakeOutbox`)으로 돈다.
- Mailo와의 상호 운용은 로컬 PostgreSQL 17과 로컬 SMTP 서버(`smtp-server`) 대상이다. 실제 Gmail·Workspace SMTP로는 확인하지 않았다.
- 이 샘플의 검증은 Mailo CI에 넣지 않았다. Mailo CI는 Node 환경만 갖고 있고, Java 빌드 환경(JDK, Gradle, 의존성 다운로드)을 분리해 두기 위해서다. 필요하면 로컬이나 별도 잡에서 `verify/run-e2e.sh`를 실행한다.
- 이 폴더는 pnpm 워크스페이스(`apps/*`)와 turbo 대상이 아니다.

## 구조

```txt
samples/spring-boot-relay/
  build.gradle.kts, settings.gradle.kts, gradlew, gradle/wrapper/   Gradle 8.14.3 wrapper
  compose.yaml                      샘플 비즈니스 DB(PostgreSQL 17, 127.0.0.1:15432)
  src/main/resources/schema.sql     비즈니스 테이블, mail_outbox, 이벤트 cursor·기록 (모든 문장이 멱등)
  src/main/java/sample/relay/
    order/OrderService              주문 + 재고 차감 + outbox 행을 한 @Transactional에 쓴다
    outbox/OutboxRepository         INSERT, FOR UPDATE SKIP LOCKED 조회, 상태 갱신(시각은 DB now())
    relay/RelayWorker               행 하나씩 잠그고 전송, 결과별 상태 전이와 backoff
    relay/SendDecision, Backoff     상태 코드 판정, exponential backoff + jitter
    relay/JobStatusMapping          Job.status → outbox 상태. 모르는 상태는 NEEDS_CHECK
    relay/NeedsCheckResolver        NEEDS_CHECK 행을 GET /jobs?idempotencyKey=로 확인
    relay/RestTransport             POST /jobs (기본)
    relay/FileTransport             파일 채널 쓰기 (옵션)
    mailo/MailoClient               JDK java.net.http. POST /jobs, GET /jobs, GET /events. 리다이렉트를 따라가지 않는다
    mailo/MailRequestFactory        POST /jobs 본문(JSON) 생성. 암호화를 켜면 content(JWE)를 넣는다
    mailo/EnvelopeEncryptor         JWE (RSA-OAEP-256 + A256GCM), 옵션
    mailo/RequestSigner             JWS flattened (HS256), 파일 채널 전용, 옵션
    mailo/FileChannelWriter         임시 이름 쓰기, fsync, 0660, 같은 폴더 rename
    events/EventFeedPoller          GET /events cursor 폴링, 이벤트를 outbox 상태와 기록 테이블에 반영
  src/test/java/                    단위 테스트(DB·Mailo 불필요)
  verify/run-e2e.sh, fake-smtp.mjs  Mailo와의 실행 검증(아래)
```

운영 의존성은 `spring-boot-starter-web`, `spring-boot-starter-jdbc`, PostgreSQL JDBC 드라이버, nimbus-jose-jwt다. HTTP 클라이언트는 JDK 내장, JSON은 starter-web의 Jackson이다.

| 항목                    | 고정 버전                                        |
| ----------------------- | ------------------------------------------------ |
| Spring Boot             | 3.5.16 (3.x 최신, 2026-11-23 Maven Central 기준) |
| Java toolchain          | 21 (실행 확인 JDK 21.0.13.1)                     |
| Gradle wrapper          | 8.14.3                                           |
| nimbus-jose-jwt         | 10.10 (`strictly`)                               |
| PostgreSQL JDBC         | 42.7.14                                          |
| Mailo의 JOSE 라이브러리 | `jose` 6.2.18 (`apps/mailo/package.json`)        |

## 실행

사전 조건: JDK 21, Docker. 처음 한 번 Gradle이 wrapper와 의존성을 내려받는다.

```sh
cd samples/spring-boot-relay
./gradlew test bootJar          # 컴파일, 단위 테스트 30건, build/libs/mailo-relay-sample-0.1.0.jar
```

### Mailo와의 실행 검증 (한 번에)

필요: docker, node 24 이상, pnpm(`pnpm install` 완료), curl, jq, openssl. 포트 15432, 13100, 12525, 18080이 비어 있어야 한다.

```sh
samples/spring-boot-relay/verify/run-e2e.sh
```

스크립트가 하는 일: Mailo 빌드, 임시 PostgreSQL 컨테이너(`mailo-sample-verify-pg`), 개발용 키·인증서 생성(`apps/mailo/scripts/gen-dev-keys.mjs`), 호출처 `sample` 등록(`signature.mode=required`, 파일 채널 켬), 로컬 SMTP와 Mailo 기동, 샘플 앱을 설정 조합별로 기동해 시나리오 실행. 끝나면 컨테이너, 프로세스, 임시 키·로그를 지운다(`KEEP=1`이면 지우지 않는다). 키와 인증서는 임시 디렉터리에만 있고 저장소에 남지 않는다.

### 직접 연결해 실행

```sh
# 1. 샘플 DB
docker compose -f samples/spring-boot-relay/compose.yaml up -d

# 2. Mailo는 저장소 README·deployment.md대로 띄우고 호출처 `sample`의 API 키 평문을 받는다.
#    callers.json 항목 예: {"id":"sample","apiKeyHashes":["<sha256>"],"signature":{"mode":"none"}}

# 3. 샘플 앱(REST 평문). 비밀 값은 환경 변수로만 준다.
RELAY_API_KEY='<Mailo가 발급한 API 키>' RELAY_BASE_URL=http://127.0.0.1:3000 \
  java -jar samples/spring-boot-relay/build/libs/mailo-relay-sample-0.1.0.jar

# 4. 주문 한 건. 응답의 outboxId가 Idempotency-Key다.
curl -s -X POST http://127.0.0.1:8080/orders -H 'Content-Type: application/json' \
  -d '{"email":"kim@example.com","sku":"SKU-OK","quantity":1}'

# 5. 상태 확인
docker compose -f samples/spring-boot-relay/compose.yaml exec sample-db \
  psql -U sample -d sample -c "SELECT id, status, attempt_count, last_http_status, last_error FROM mail_outbox"
```

`SKU-EMPTY`는 재고가 0이라 주문이 409로 실패하고 outbox 행도 함께 롤백된다.

### 설정(`relay.*`, 환경 변수는 relaxed binding)

| 속성                                                                   | 환경 변수 예           | 기본값                   | 설명                                                             |
| ---------------------------------------------------------------------- | ---------------------- | ------------------------ | ---------------------------------------------------------------- |
| `relay.base-url`                                                       | `RELAY_BASE_URL`       | `http://127.0.0.1:3000`  | Mailo 주소                                                       |
| `relay.api-key`                                                        | `RELAY_API_KEY`        | 없음(필수)               | 호출처 API 키 평문. 설정 파일에 두지 않는다                      |
| `relay.caller-id`                                                      | `RELAY_CALLER_ID`      | `sample`                 | JWE·JWS의 `caller`                                               |
| `relay.from`                                                           | `RELAY_FROM`           | `no-reply@example.com`   | 비우면 Mailo SMTP 발신 계정                                      |
| `relay.transport`                                                      | `RELAY_TRANSPORT`      | `REST`                   | `REST` 또는 `FILE`                                               |
| `relay.file-inbox-dir`                                                 | `RELAY_FILE_INBOX_DIR` | 없음                     | `FILE`일 때 `<root>/inbox/<caller_id>`                           |
| `relay.encryption.enabled/kid/public-key-file`                         | `RELAY_ENCRYPTION_*`   | `false`                  | JWE. 공개키는 RSA 3072 PEM(SPKI)                                 |
| `relay.signature.enabled/kid/secret-file`                              | `RELAY_SIGNATURE_*`    | `false`                  | JWS HS256. 32바이트 base64 또는 64자 hex 파일. `FILE`에서만 쓴다 |
| `relay.retry.base-delay/multiplier/max-delay/jitter-ratio/max-age`     | `RELAY_RETRY_*`        | 30초, 2, 1시간, 0.2, 7일 | 모두 사용처가 정하는 값이다. 기본값은 문서의 예시 값이다(추정)   |
| `relay.retry.poll-interval/batch-size/connect-timeout/request-timeout` | `RELAY_RETRY_*`        | 5초, 20, 5초, 10초       | relay 폴링과 HTTP 타임아웃                                       |
| `relay.events.poll-interval/limit`                                     | `RELAY_EVENTS_*`       | 30초, 100                | 이벤트 피드 폴링. `NEEDS_CHECK` 행 확인도 같은 간격이다          |

## outbox 스키마

`src/main/resources/schema.sql`에 있고 기동 때 실행한다(`spring.sql.init.mode=always`). 운영에서는 마이그레이션 도구로 옮긴다.

```sql
CREATE TABLE mail_outbox (
  id               uuid PRIMARY KEY,                 -- Idempotency-Key로 쓴다. 요청 단위로 고유하다
  request_json     text NOT NULL,                    -- 등록 시점에 확정한 REST 본문. 재시도에서 바꾸지 않는다(바꾸면 409)
  status           text NOT NULL DEFAULT 'PENDING',  -- 허용 값은 아래 mail_outbox_status_check
  attempt_count    integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_http_status integer,
  last_error       text                              -- 고정 사유 코드만. 본문·수신자는 넣지 않는다
);
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_status_check
  CHECK (status IN ('PENDING','DELIVERED','SENT','FAILED','EXPIRED','DEAD','REJECTED','QUARANTINED','NEEDS_CHECK','CANCELED'));
CREATE INDEX mail_outbox_due_idx ON mail_outbox (next_attempt_at) WHERE status = 'PENDING';
CREATE TABLE mailo_event_cursor (name text PRIMARY KEY, cursor text NOT NULL);  -- 행 하나
CREATE TABLE mailo_event_log (                                                 -- FAILED·EXPIRED·CANCELED·INTAKE_REJECTED·모르는 이벤트 종류 기록
  event_id text PRIMARY KEY, type text NOT NULL, outbox_id uuid, reason text,
  payload jsonb NOT NULL, occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
```

`caller-onboarding.md` 7절의 예시 스키마와 다른 점: `status`에 `REJECTED`, `QUARANTINED`, `NEEDS_CHECK`를 추가했고 `updated_at`, `last_error`를 두었다. 실제 `schema.sql`은 `CREATE TABLE IF NOT EXISTS`가 기존 테이블을 바꾸지 않으므로 기동 때마다 `DROP CONSTRAINT IF EXISTS` 뒤 `ADD CONSTRAINT`로 상태 `CHECK`를 교체한다.

## relay 규칙

행마다 짧은 트랜잭션에서 `SELECT ... WHERE status='PENDING' AND next_attempt_at <= now() ... FOR UPDATE SKIP LOCKED LIMIT 1`로 잠그고 전송한 뒤 같은 트랜잭션에서 결과를 쓴다.

| 결과                                             | outbox 상태                                                                                                      | 동작                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 202, 200                                         | `DELIVERED`. 200 본문의 Job 상태가 `SENT`·`FAILED`·`EXPIRED`·`CANCELED`면 그 값. 모르는 Job 상태면 `NEEDS_CHECK` | 등록 완료. 발송 완료가 아니다. `PENDING`·`SENDING`·`RETRY_WAIT`는 `DELIVERED`다                            |
| 네트워크 오류, 타임아웃, 5xx, 429                | `PENDING` 유지, `next_attempt_at` 미룸                                                                           | 같은 Key·같은 본문으로 backoff 재시도                                                                      |
| 409                                              | `QUARANTINED`                                                                                                    | 재시도하지 않는다. 같은 Key에 다른 내용이다. 호출처 버그를 의심한다                                        |
| 401                                              | `REJECTED`                                                                                                       | relay를 멈춘다(프로세스 재시작 전까지). API 키를 고친 뒤 재시작한다                                        |
| 400, 413, 415, 그 밖의 4xx·3xx                   | `REJECTED`                                                                                                       | 재시도하지 않는다. 요청을 고친 뒤 `PENDING`으로 되돌려야 한다                                              |
| `created_at` 기준 7일 초과                       | `DEAD`                                                                                                           | 전송하지 않고 종결한다. 알림 대상이다                                                                      |
| 이벤트 `JOB_SENT` / `JOB_FAILED` / `JOB_EXPIRED` | `SENT` / `FAILED` / `EXPIRED`                                                                                    | `PENDING`·`DELIVERED` 행만 바꾼다(멱등)                                                                    |
| 이벤트 `JOB_CANCELED`                            | `CANCELED`, 사유 `CANCELED_BY_CALLER`·`CANCELED_BY_OPERATOR`                                                     | 실패가 아닌 취소 종결이다. 같은 행만 바꾸고 `mailo_event_log`에 기록한다. 새 메일은 새 Key(새 행)로 보낸다 |
| 이벤트 `INTAKE_REJECTED`                         | `REJECTED` (`FINGERPRINT_MISMATCH`는 `QUARANTINED`)                                                              | Key가 null이면 `fileName`(`<id>.json`)으로 행을 찾는다                                                     |
| 모르는 이벤트 종류                               | `NEEDS_CHECK`(`PENDING`·`DELIVERED` 행만)                                                                        | `mailo_event_log`에 기록하고 `GET /jobs`로 확인한다. 건너뛰지 않는다                                       |
| 이벤트 공백 신호(헤더·410)                       | `DELIVERED` 행 전부 `NEEDS_CHECK`                                                                                | 놓친 이벤트의 행을 알 수 없어 등록됨 행을 모두 `GET /jobs`로 확인한다                                      |

- 429는 Mailo가 쓰지 않는다(등록 단계에 쿼터가 없다). 앞단 프록시를 대비한 재시도다.
- `NEEDS_CHECK`는 종결이 아니다. `NeedsCheckResolver`가 `GET /jobs?idempotencyKey=<행 ID>`로 확인한다.
  - `SENT`·`FAILED`·`EXPIRED`·`CANCELED`면 그 상태로 닫는다. `FAILED`의 사유는 `failureReason`, `CANCELED`의 사유는 `canceledBy`(`CANCELED_BY_<주체>`)다.
  - `PENDING`·`SENDING`·`RETRY_WAIT`면 `DELIVERED`로 되돌리고 이후 종결 이벤트를 기다린다.
  - 모르는 상태와 404(보존 기간이 지났거나 등록된 적 없음)는 `NEEDS_CHECK`로 남긴다. 운영 알림 대상이고 처리는 사용처가 정한다. 로그는 `needs_check_unresolved`, `needs_check_not_found`다.
  - 401은 이번 주기의 나머지 확인을 멈춘다. 5xx·429도 멈추고 다음 주기에 다시 한다.
- 막힌 행을 되돌리는 SQL 예: `UPDATE mail_outbox SET status='PENDING', next_attempt_at=now() WHERE id='<id>'`. 같은 Key로 다른 내용을 보내면 409이므로 `request_json`을 고치지 않는다. 내용을 바꿔야 하면 새 행(새 Key)을 만든다.
- 로그에는 outbox ID, 상태 코드, 고정 사유 코드만 남긴다. 주소, 제목, 본문, API 키는 남기지 않는다(실행 검증에서 앱 로그를 검색해 확인했다).

## 이벤트 피드

`GET /events?limit=<n>[&after=<cursor>]`를 설정한 간격(기본 30초)으로 폴링한다. type 필터는 쓰지 않는다.

- 이벤트 반영과 cursor 저장은 한 트랜잭션이다. HTTP 호출은 트랜잭션 밖이다.
- `hasMore`가 `true`이면 바로 이어서 읽는다. `nextCursor`가 문자열일 때만 저장한다.
- `mailo_event_log`는 `event_id` 기본 키로 같은 이벤트의 재전달을 걸러낸다. 로그 줄(`mailo_event`)도 처음 기록할 때만 낸다.
- `JOB_SENT`는 outbox만 바꾼다. `rejectedRecipients`가 있으면 `mailo_event_log`에도 남긴다.
- 폴러는 인스턴스마다 돈다. 여러 인스턴스가 같은 cursor를 읽으면 같은 이벤트를 두 번 처리할 수 있으나 결과는 같다(멱등).
- 모르는 이벤트 종류는 경고만 하고 넘기지 않는다. `type`을 대문자와 밑줄만 남겨 `mailo_event_log`에 사유 `UNKNOWN_EVENT_TYPE`으로 기록하고, 행을 찾을 수 있으면 `NEEDS_CHECK`로 둔다. cursor는 그 이벤트를 지나가므로 이 표시가 유일한 단서다.
- 응답 헤더 `Mailo-Cursor-Gap: true`(cursor 뒤에서 이벤트가 삭제됐다는 신호, ADR-0011 결정 9)가 있으면 그 페이지의 이벤트를 처리한 뒤 `DELIVERED` 행을 모두 `NEEDS_CHECK`로 바꾼다.
- 410(`onGap=error`를 보냈을 때만 온다)을 받으면 cursor를 지우고 `DELIVERED` 행을 `NEEDS_CHECK`로 바꾼다. 다음 폴링은 `after` 없이 남은 이벤트부터 읽는다. 이 샘플은 `onGap=error`를 보내지 않는다.
- 200이 아닌 응답은 상태 코드를 로그에 남기고 이번 주기를 멈춘다. cursor는 바꾸지 않는다. 401은 `event_poll_failed http=401 action=fix_api_key`, 5xx·429는 warn, 모르는 4xx는 `action=check_contract`다.
- `occurredAt`을 해석하지 못해도 페이지 전체가 반복 실패하지 않도록 현재 시각으로 대신한다.

## 암호화와 서명(옵션)

- JWE(`relay.encryption.enabled=true`): `EnvelopeEncryptor`가 `{"subject","text"}`를 `RSA-OAEP-256` + `A256GCM`으로 암호화하고 protected header에 `kid`, `caller`를 넣는다. 요청 JSON은 `subject`·`text` 대신 `content`를 갖는다. 암호화는 outbox에 쓰는 시점(비즈니스 트랜잭션 안)에 한다. outbox에는 암호문만 남고 재시도는 같은 암호문을 보낸다. REST와 파일 채널 모두에서 쓴다.
- JWS(`relay.signature.enabled=true`, `relay.transport=FILE`): `RequestSigner`가 파일 내용(요청 JSON + `version` + `idempotencyKey`)을 flattened JWS로 만든다. protected header는 `alg=HS256`, `kid`, `caller`, `iat`(초 단위 숫자) 네 필드다. 전송 때마다 새 `iat`로 서명한다. **REST는 서명을 쓰지 않는다**(ADR-0008 결정 2). 서명 켜기는 `FILE` 전송에서만 의미가 있다.
- 파일 채널 쓰기는 `caller-onboarding.md` 5절의 순서를 따른다: `.<id>.json.tmp`에 쓰기, fsync, 0660, 같은 폴더 `rename`. 파일을 썼다는 것은 Mailo가 등록했다는 뜻이 아니다. 샘플은 파일을 쓴 행을 `DELIVERED`로 두고 이벤트 피드로 결과를 받는다.

## 실행 검증 결과 (2026-11-24)

`verify/run-e2e.sh` 한 번 실행. 판정은 스크립트의 `check`(기대값과 실제값 비교)다.

실행 조합별 결과(120 항목 통과, 실패 0). "SMTP 수신"은 로컬 SMTP 서버가 받은 메일 수, "Message-ID"는 그 수신 메일의 고유 Message-ID 수다.

| 시나리오                 | 조합                      | 관찰값                                                                                                                                                                                                                                                                                                                                                                                                                              | 판정 |
| ------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| S1 평문 REST 발송        | REST                      | 주문 201, 등록 202, outbox `SENT`, Mailo `mail_jobs` 1행 `SENT`, SMTP 수신 1통, Message-ID 1개, 본문 디코딩 일치                                                                                                                                                                                                                                                                                                                    | 통과 |
| S2 같은 outbox 행 재전송 | REST                      | 응답 200, outbox `SENT`(200의 Job 상태 반영), `mail_jobs` 1행 유지, SMTP 수신 1통 유지                                                                                                                                                                                                                                                                                                                                              | 통과 |
| S3 수신자 영구 거부(550) | REST                      | outbox `FAILED`, 사유 `PERMANENT_ERROR`, `mailo_event_log`에 `JOB_FAILED`와 `lastError.smtpCode` 550, SMTP 수신 0통. 서버가 더한 `outcomeUncertain`(RQ-048)은 샘플이 무시하고 이벤트 payload에만 남음(`JOB_FAILED` false, `JOB_SENT`에는 없음), `GET /jobs` 응답도 false                                                                                                                                                            | 통과 |
| S3a 확인 필요 행 확인    | REST                      | `NEEDS_CHECK`로 바꾼 `FAILED` 작업의 행이 `GET /jobs` 확인으로 `FAILED`·`PERMANENT_ERROR`가 되고, Mailo에 없는 Key(404)의 행은 `NEEDS_CHECK`로 남음                                                                                                                                                                                                                                                                                 | 통과 |
| S4 같은 Key에 다른 내용  | REST                      | 409, outbox `QUARANTINED`, 사유 `HTTP_409 idempotency-conflict`, SMTP 수신 1통 유지                                                                                                                                                                                                                                                                                                                                                 | 통과 |
| S5 잘못된 수신자 주소    | REST                      | 400, outbox `REJECTED`, 사유 `HTTP_400 validation-failed INVALID_FORMAT`, 시도 1회(재시도 없음)                                                                                                                                                                                                                                                                                                                                     | 통과 |
| S6 재고 부족 롤백        | REST                      | 주문 409, `mail_outbox` 행 수 변화 0, `orders` 0행, SMTP 수신 0통                                                                                                                                                                                                                                                                                                                                                                   | 통과 |
| S7 일시 오류(450)로 만료 | REST, Mailo 만료 TTL 15초 | outbox `EXPIRED`, `mailo_event_log`에 `JOB_EXPIRED`                                                                                                                                                                                                                                                                                                                                                                                 | 통과 |
| S8 Mailo 중단 중 주문    | REST                      | 중단 중 주문 201(3초 이내), `orders` 1행, outbox `PENDING`·사유 `NETWORK_ERROR`·시도 3회 이상, Mailo 재기동 뒤 `SENT`, SMTP 수신 1통, cursor 저장                                                                                                                                                                                                                                                                                   | 통과 |
| S9 JWE 발송              | REST + JWE                | 202, outbox에 본문 평문 0건·`content` 있음, `SENT`, SMTP 수신 1통(복호화된 제목·본문 일치), 같은 암호문 재전송 200·수신 1통 유지                                                                                                                                                                                                                                                                                                    | 통과 |
| S10 알 수 없는 `kid`     | REST + JWE                | 400 `KID_UNKNOWN`, outbox `REJECTED`                                                                                                                                                                                                                                                                                                                                                                                                | 통과 |
| S11 JWS 파일 발송        | FILE + JWS                | outbox `SENT`, `mail_jobs` 1행, SMTP 수신 1통, 수집 거부 0건, 새 `iat`로 재전송해도 `mail_jobs` 1행·수신 1통·거부 0건, inbox 잔여 파일 0                                                                                                                                                                                                                                                                                            | 통과 |
| S12 JWS + JWE 파일 발송  | FILE + JWS + JWE          | outbox `SENT`, SMTP 수신 1통, Message-ID 1개, 복호화된 본문 일치                                                                                                                                                                                                                                                                                                                                                                    | 통과 |
| S13 잘못된 JWS 비밀키    | FILE + JWS                | Mailo 거부 기록 1건, 이벤트 `INTAKE_REJECTED`(`idempotencyKey` null, `fileName`으로 행 식별), outbox `REJECTED`·`SIGNATURE_INVALID`, SMTP 수신 0통                                                                                                                                                                                                                                                                                  | 통과 |
| S14 잘못된 API 키        | REST                      | 401, outbox `REJECTED`, relay 중지 뒤 다음 행 시도 0회                                                                                                                                                                                                                                                                                                                                                                              | 통과 |
| S15 작업 취소            | REST                      | 차단기를 열어(DB 조작) `PENDING`으로 둔 작업을 `POST /jobs/{jobId}/cancel`로 취소: 200·`CANCELED`·`canceledBy` `CALLER`, 본문 삭제, 재요청 200(이벤트 1건), outbox `CANCELED`·사유 `CANCELED_BY_CALLER`, `mailo_event_log`에 `JOB_CANCELED`. 완료된 작업의 취소는 409 `job-not-cancelable`(`jobStatus` `SENT`), 없는 Key는 404                                                                                                      | 통과 |
| S15b Key로 취소          | REST                      | `POST /jobs/cancel?idempotencyKey=` 200, `NEEDS_CHECK`로 바꾼 행이 `GET /jobs` 확인으로 `CANCELED`·`CANCELED_BY_CALLER`, 같은 Key 재전송 200(취소된 작업, `mail_jobs` 1행), 차단기를 닫은 뒤에도 SMTP 수신 0통                                                                                                                                                                                                                      | 통과 |
| S16 이벤트 피드 공백     | REST                      | 종결 작업(S1·S3)의 종결 시각을 40일 전으로 당겨(DB 조작) Worker가 보존 삭제하게 한 뒤: `mail_event_purges`에 `JOB_SENT`·`JOB_FAILED` 표지, `GET /events?after=<0:0>`가 200과 `Mailo-Cursor-Gap: true`, 삭제되지 않은 종류의 `type` 필터와 `after` 없는 읽기에는 헤더 없음, `onGap=error`는 410 `cursor-expired`. 샘플 cursor를 0:0으로 되돌리면 앱이 `event_cursor_gap`을 로그로 남기고 등록됨 행을 확인 필요로 둠(410 처리는 없음) | 통과 |
| 로그 점검                | 전체                      | 샘플 앱 로그 7개에서 수신자 주소·본문·`Bearer` 0건, Mailo 로그에서 본문·수신자 주소 0건, 수신 메일 5통의 Message-ID가 모두 다름                                                                                                                                                                                                                                                                                                     | 통과 |

확인하지 못한 것: 앞의 "확인하지 않은 조합", Mailo가 모르는 이벤트 종류·`Mailo-Cursor-Gap` 헤더·410을 실제로 보내는 경우(서버가 아직 보내지 않아 단위 테스트의 대역으로만 확인했다), 모르는 `Job.status`를 돌려주는 서버(같은 이유), Mailo가 실제로 돌려주는 5xx·413·415 응답에 대한 relay 동작(`SendDecision` 단위 테스트로 판정만 확인했다), 실제 Gmail, 여러 relay 인스턴스의 동시 실행(`SKIP LOCKED` 경합), relay 프로세스를 전송 도중 강제 종료한 경우, 7일 `DEAD` 전이(코드는 있고 시각 경과는 재현하지 않았다), 이벤트 피드의 `hasMore` 연속 조회(실행 중 한 페이지에 모두 담겼다), 큰 본문.

### nimbus-jose-jwt와 jose의 상호 운용

| 조합                                                                                                               | 결과 | 관찰                                                                    |
| ------------------------------------------------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------- |
| nimbus JWE(RSA-OAEP-256 + A256GCM, `kid`·`caller`) -> Mailo `jose` 복호화, REST                                    | 통과 | 202, SMTP 수신 1통, 복호화된 제목·본문이 메일에 있음                    |
| 같은 JWE를 JWS 파일 안에 넣어 파일 채널로                                                                          | 통과 | SENT, SMTP 수신 1통                                                     |
| nimbus JWS(HS256, protected `kid`·`caller`·`iat`) -> Mailo `flattenedVerify`, 파일 채널(`signature.mode=required`) | 통과 | SENT, 수집 거부 0건                                                     |
| 다른 비밀키로 서명한 JWS                                                                                           | 거부 | `INTAKE_REJECTED` `SIGNATURE_INVALID`. 서명 검증이 실제로 비교하고 있다 |
| 알 수 없는 `kid`의 JWE                                                                                             | 거부 | 400 `KID_UNKNOWN`                                                       |

두 구현 사이에서 형식 해석 차이는 관찰되지 않았다. nimbus의 `customParam("caller")`, `customParam("iat", long)`는 Mailo가 요구하는 protected header 필드와 숫자 타입으로 직렬화됐다.

확인하지 않은 조합: `RSA-OAEP-256` 외 키 암호화, 다른 nimbus 버전, 키 교체(이전 `kid`) 중의 상호 운용, `HS256`이 아닌 JWS, UTF-8 외 문자 인코딩, 2 MiB 근처의 큰 본문.

## 알려진 한계

- **at-least-once.** relay가 202를 받은 뒤 결과를 쓰기 전에 죽으면 행은 `PENDING`으로 남고 같은 Key로 다시 전송된다. Mailo가 200으로 중복 등록을 막는다. 발송 자체의 중복(SMTP 수락 직후 장애)은 Mailo의 한계이고 이 샘플이 막지 못한다(RQ-013).
- **전송 중 행 잠금.** relay는 HTTP 호출 동안 행 잠금과 DB 커넥션 하나를 잡는다. 요청 타임아웃(기본 10초)이 상한이다. 처리량이 필요하면 점유 시각 컬럼으로 잠금과 전송을 분리한다.
- **상태 멱등.** 이벤트는 `PENDING`·`DELIVERED`·`NEEDS_CHECK` 행만 바꾼다. `QUARANTINED`·`REJECTED`·`DEAD`가 된 행에 나중에 도착한 `JOB_SENT`는 반영하지 않는다. 이 경우 Mailo는 이미 발송했는데 outbox가 `DEAD`일 수 있다(7일 넘게 Mailo에 도달하지 못한 뒤 되돌린 경우 등). `mailo_event_log`에는 `JOB_SENT`가 남지 않으므로(거부 수신자가 없으면) 사용처가 필요하면 Key 조회(`GET /jobs?idempotencyKey=`)로 대조한다.
- **파일 채널 등록 미확인.** `FILE` 전송은 파일 쓰기까지만 확인한다. 등록 확인은 이벤트 피드(`INTAKE_REJECTED`)와 Key 조회가 맡는다. 거부 이벤트 없이 파일이 사라지지 않는 경우(`unreadable` 등)는 샘플이 다루지 않는다.
- **401 처리.** 401은 행 하나를 `REJECTED`로 두고 relay를 프로세스가 재시작할 때까지 멈춘다. 이미 `REJECTED`가 된 행은 수동으로 `PENDING`으로 되돌려야 한다.
- **JWE 키 교체.** 암호화를 outbox 쓰기 시점에 하므로 행에는 그때의 `kid`가 고정된다. Mailo는 이전 개인키를 Key 보존 기간 이상 보관해야 한다(`key-management.md`).
- **이벤트 보존.** Mailo는 이벤트를 30일 보존한다. 폴러가 그보다 오래 멈추면 이벤트를 놓친다. 공백 헤더를 받는 서버에서는 `NEEDS_CHECK`로 확인한다(헤더를 아직 보내지 않는 서버에서는 신호가 없다).
- **취소 호출 없음.** 이 샘플은 `CANCELED`·`JOB_CANCELED`를 종결로 처리하지만 취소 API(`POST /jobs/{jobId}/cancel`)를 부르는 코드는 없다. 사용처가 필요할 때 `MailoClient`에 더한다. 검증 스크립트는 `curl`로 호출한다.
- **`NEEDS_CHECK` 해소.** 모르는 상태와 404는 자동으로 풀리지 않는다. 같은 행을 주기마다 다시 확인하고 경고를 남긴다.
- **스키마 관리.** 샘플은 `schema.sql`을 기동 때 실행한다. 운영 마이그레이션 도구는 포함하지 않는다.
- **인증·권한.** `POST /orders`에는 인증이 없다. 샘플의 흐름을 보이기 위한 엔드포인트다.
- **환경.** JDK 21, Linux, PostgreSQL 17, 로컬 SMTP에서만 실행했다. Windows·macOS, 다른 JDK 버전, PostgreSQL 13~16은 확인하지 않았다.
