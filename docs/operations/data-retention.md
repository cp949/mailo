# 개인정보 보존 현황

Mailo가 다루는 개인정보가 어디에 얼마나 남고 어떻게 지워지는지 한 곳에 적는다. 무엇이 Mailo 밖에 남는지도 적는다.
근거는 RQ-070, ADR-0015 결정 1, 코드(`queue/`, `events/`, `smtp/sender.ts`, `config/load-config.ts`, `file-channel/`), 마이그레이션 `0001`~`0018`, 기존 운영 문서다.
표기: "확인"은 2026-11-24에 코드나 마이그레이션을 읽어 확인한 것이다. "자동 검증"은 자동 테스트가 확인하는 것이고 테스트 파일 이름을 적는다. "가정"은 확인하지 못한 것이다. 이 문서의 명령과 SQL은 실행하지 않았다.

종결 때 비움(RQ-071, ADR-0015 결정 2)은 구현돼 있다. 이 문서는 그 코드(`queue/complete.ts`, `queue/maintenance.ts`, `queue/cancel.ts`)로 대조한 동작을 "종결 전이"로 적는다. 종결 전이가 비우는 것은 결과 기록, lease 회수, 만료 sweep, 취소로 끝나는 행이다. 재시도 대기(`RETRY_WAIT`)로 가는 시도는 아무것도 비우지 않는다. 이 변경 전에 종결한 행(이전 버전이 종결한 행과 배포 전에 이미 종결된 행)은 예외이고 아래 표가 따로 적는다. 이벤트·시도의 수신자는 유예(`MAILO_RECIPIENT_RETENTION_SECONDS`, 기본 7일) 뒤 유지보수 루프의 `recipients` 단계가 비운다(RQ-072, ADR-0015 결정 3). 이 문서는 그 코드(`queue/maintenance.ts`의 `redactEventRecipients`)로 대조한 동작을 적는다.

## 결론

- Mailo의 DB에 남는 개인정보는 수신자 주소(`recipients`, 이벤트·시도의 수신자), 발신자(`from`·`replyTo`), 제목·본문(암호문)이다. 호출처가 정하는 `Idempotency-Key`와 파일 이름에도 호출처가 넣은 값이 들어갈 수 있다.
- 종결 전이가 본문·수신자·봉투를 비운다. 이전 버전이 종결한 행과 배포 전에 이미 종결된 행은 예외다. 본문은 안전망이 비우지만 수신자·봉투는 보존 기간(기본 30일) 끝까지 남는다. 이벤트와 시도 기록의 수신자는 유예(기본 7일) 뒤 비워진다. 유예 안에서는 평문이다. 이벤트 행과 Key는 보존 기간(기본 30일) 끝까지 남는다.
- 로그와 지표에는 수신자·제목·본문·Key가 없다(RQ-027, canary 테스트).
- 로그 수집기, DB 백업, SMTP 서버, 호출처 저장소, 파일 채널 폴더는 Mailo 밖이다. Mailo는 그곳의 데이터를 지우지 못한다.

## Mailo가 다루는 개인정보

| 항목 | 들어오는 곳 | 비고 |
| ---- | ----------- | ---- |
| 수신자 주소(to·cc·bcc) | 요청 평문 필드 | 암호화 범위가 아니다(ADR-0001 결정 6). Mailo가 검증·중복 판단·라우팅에 쓴다 |
| 발신자(`from`·`replyTo`) | 요청 평문 필드 | `from`은 계정 주소나 호출처 `allowedFrom`이다. `replyTo`는 호출처가 정한다 |
| 제목·text·html | 요청 평문 필드나 JWE `content` | DB에서는 AES-256-GCM 암호문이다(ADR-0008 결정 6) |
| `Idempotency-Key` | 헤더나 파일 필드 | 호출처가 정한다. Mailo는 형식(1~128자, `[A-Za-z0-9._:-]`)만 검사하고 내용은 모른다(`0001`의 CHECK) |
| 파일 이름 | 파일 채널 | 호출처가 정한다. 수집 거부 때 `mail_intake_rejections.file_name`에 남고 호출처의 `INTAKE_REJECTED` 이벤트에도 나온다 |
| SMTP 응답 텍스트 | SMTP 서버 | 서버가 수신자 주소를 되풀이할 수 있다. 주소 형태는 가린다(아래 표) |

인증 정보와 키(SMTP 비밀번호, API 키 평문, 암호화 키)는 이 문서의 대상이 아니다. 로그·이벤트·거부 기록에 남기지 않는다(RQ-027). 키 처리는 `key-management.md`다.

## 보존 현황

기본값은 `MAILO_BODY_RETENTION_SECONDS` 1일, `MAILO_RECORD_RETENTION_SECONDS` 30일이다(`config/load-config.ts`). 종결은 `SENT`·`FAILED`·`EXPIRED`·`CANCELED`다.

| 위치 | 개인정보 | 형태 | 남는 기간 | 지우는 방법 | 근거 |
| ---- | -------- | ---- | --------- | ----------- | ---- |
| `mail_jobs.body_ciphertext` 외 본문 열 | 제목·text·html | 암호문 | 종결 전이까지(재시도 대기 중에는 남는다). 이전 버전·배포 전 종결 행은 종결 후 1일(`MAILO_BODY_RETENTION_SECONDS`) | 종결 전이의 같은 `UPDATE`가 NULL로 바꾼다(취소 포함). 이전 버전·배포 전 종결 행은 안전망 `deleteExpiredBodies`가 본문 세 열만 비운다 | 확인: `queue/complete.ts`, `queue/maintenance.ts`, `queue/cancel.ts`. 자동 검증: `queue/redact-on-terminal.integration-spec.ts` |
| `mail_jobs.recipients` | to·cc·bcc | 평문 jsonb | 종결 전이까지(재시도 대기 중에는 남는다). 이전 버전·배포 전 종결 행은 종결 후 30일(`MAILO_RECORD_RETENTION_SECONDS`)까지 남는다 | 종결 전이의 같은 `UPDATE`가 `'{}'`로 바꾼다. 이전 버전·배포 전 종결 행은 안전망이 비우지 않으므로 행 삭제까지 남고, 앞당기려면 `db-maintenance.md` "배포 전 종결 행의 수신자·봉투 비우기"의 SQL을 쓴다 | 같은 곳. 자동 검증: `queue/redact-on-terminal.integration-spec.ts`(경로별 비움, 재시도 대기는 유지), `queue/cancel.integration-spec.ts`(`claim`에 진 취소는 유지), `queue/maintenance.integration-spec.ts`(이전 버전이 종결한 행의 본문 정리) |
| `mail_jobs.envelope` | `from`, `replyTo` | 평문 jsonb | 위 `recipients`와 같다 | 같은 방식 | 같은 곳. `from`·`replyTo` canary가 로그·시도 기록·이벤트·작업 행·REST 응답에 없다(`worker/worker.integration-spec.ts`, `http/rest-redacted-terminal.integration-spec.ts`) |
| `mail_jobs.idempotency_key`, `fingerprint` | 호출처가 정한 Key, 요청 전체의 HMAC-SHA256 | 평문, 해시 | 종결 후 `MAILO_RECORD_RETENTION_SECONDS`(30일). 종결하지 않은 작업은 지우지 않는다 | `deleteExpiredRecords`가 행을 지운다 | 확인: `queue/maintenance.ts`, `0001`. 지문 키는 DB와 분리한다(ADR-0005 결정 3) |
| `mail_events.recipients`, `rejected_recipients` | 수신자, 거부된 수신자 | 평문 jsonb | 이벤트 생성 후 유예 `MAILO_RECIPIENT_RETENTION_SECONDS`(기본 7일)까지. 유예 뒤 `recipients`는 `'{}'`, `rejected_recipients`는 NULL이다 | 유지보수 루프의 `recipients` 단계(`redactEventRecipients`)가 `JOB_*` 이벤트를 비우고 `recipients_redacted_at`에 시각을 쓴다. 이벤트 행은 지우지 않는다. 비운 값은 복원하지 못한다 | 확인: `queue/maintenance.ts`, `0017`, `0018`. 자동 검증: `queue/redact-event-recipients.integration-spec.ts`, `http/rest-recipients-redacted.integration-spec.ts`, `worker/worker.integration-spec.ts`(주기 실행·로그). 이벤트에 본문·`from`·`replyTo`는 없다(`queue/redact-on-terminal.integration-spec.ts`) |
| `mail_events.idempotency_key` | 호출처가 정한 Key(`INTAKE_REJECTED` 이벤트는 파싱한 Key만) | 평문 | 30일. 작업 행과 같이 지워진다 | 작업 삭제의 `ON DELETE CASCADE`. `INTAKE_REJECTED` 이벤트는 거부 기록과 같이 지워진다 | 확인: `0001`, `events/event-store.ts`. `INTAKE_REJECTED`는 수신자가 없어 비움 대상이 아니다 |
| `mail_attempts.rejected_recipients` | 일부 거부된 수신자 주소 | 평문 jsonb | 해당 작업 이벤트의 유예(기본 7일)까지. 유예 뒤 NULL이다 | 같은 `recipients` 단계가 같은 문장에서 비운다. 시도 행과 나머지 열(응답 코드, 마스킹한 응답 텍스트)은 남는다 | 확인: `queue/complete.ts`(`SENT` 시도만 값이 있다), `queue/maintenance.ts`. 자동 검증: `queue/redact-event-recipients.integration-spec.ts` |
| `mail_attempts.response_text` | SMTP 응답 텍스트 | 평문. 주소 형태는 `[address]`로 바꾸고 500자로 자른다 | 30일 | 작업 삭제의 CASCADE | 확인: `smtp/sender.ts`의 `sanitizeResponseText`. 한계: 주소가 아닌 사용자 이름을 되풀이하는 응답은 가리지 못한다(ADR-0007 구현 중 확정 5) |
| `mail_intake_rejections` | 파일 이름, sha256, 파싱한 Key | 평문 | 기록 생성 후 30일 | `deleteExpiredRecords` | 확인: `0001`, `queue/maintenance.ts`. 거부된 파일의 본문은 기록하지 않는다(ADR-0006 결정 3) |
| `mail_ops_audit` | 관리 토큰 이름, 작업 ID. 주소·제목·본문 없음 | 평문 | 자동 삭제 없음 | 수동 `DELETE`. 절차와 위험도는 `db-maintenance.md` "감사 테이블" | 확인: `0008`, ADR-0012 결정 8. 토큰 이름 형식은 `[a-z][a-z0-9]{0,31}`(`deployment.md`) |
| `mail_send_controls` | 호출처·계정 ID(`scope_id`), 관리 토큰 이름(`paused_by`). 주소·제목·본문 없음 | 평문 | 재개 때 행을 지운다 | | 확인: `0008` 열 목록 |
| `mail_circuit_breaker` | 계정 ID(`breaker_key`), 작업 UUID(`probe_job_id`, `last_trip_job_id`), 사유 코드(`last_reason`), 시각. 주소·제목·본문 없음 | 평문 | 계정마다 행이 남는다 | | 확인: `0001` 열 목록. 이후 마이그레이션은 이 테이블의 열을 바꾸지 않았다 |
| `mail_event_purges` | 호출처 ID, 이벤트 종류, 삭제한 이벤트의 위치(`purged_txid`, `purged_id`). 주소·제목·본문 없음 | 평문 | 행이 남는다(상한은 호출처 수 × 이벤트 종류 수) | | 확인: `0009` |
| `schema_migrations` | 적용한 마이그레이션 파일 이름과 적용 기록. 주소·제목·본문 없음 | 평문 | 행이 남는다 | | 확인: `db/migrator.ts` 주석(열 이름은 확인하지 않았다) |
| 로그(표준 출력 JSON) | 없다. `callerId`, `jobId`, 사유 코드 같은 식별자만 있다 | JSON 줄 | Mailo는 보존하지 않는다. 수집기·런타임의 몫이다 | 수집기 설정 | 자동 검증: `worker/worker.integration-spec.ts`, `http/rest-intake.integration-spec.ts`, `file-channel/poller.integration-spec.ts`(canary, RQ-027). 거부 파일 이름은 로그에 없다(ADR-0004 구현 중 확정 32) |
| `/metrics` | 없다. 라벨은 `caller_id`, `account_id`, 사유 같은 닫힌 집합이다 | Prometheus 텍스트 | 스크레이프 저장소의 몫이다 | | 확인: RQ-050, ADR-0012 결정 6 |
| Worker 프로세스 메모리 | 전송 중인 평문 | 메모리 | 전송이 끝날 때까지 | | 확인: ADR-0001 "암호화 범위와 한계" |

- 종결한 작업의 `recipients`·`envelope`를 읽는 코드 경로는 찾지 못했다. 읽는 곳은 `claim`, 결과 기록, 만료 sweep, 취소이고 모두 종결 전 행이다(확인, 코드 읽기). 종결 이벤트를 쓸 때 `recipients`를 이벤트로 복사한다.
- `GET /jobs`의 `Job` 응답에는 수신자 필드가 없다. `rejectedRecipients`만 `SENT`일 때 있고 유예 뒤에는 빈 목록이다(시도 기록에서 읽는다). 이벤트 응답에는 `recipients`가 있고 유예 뒤에는 빈 목록과 `recipientsRedacted: true`다(`intake/presenters.ts`).
- `/ops/jobs/{jobId}`와 CLI는 수신자·Key·본문·SMTP 응답 텍스트를 내지 않는다(ADR-0011 결정 7, RQ-048의 canary 테스트).
- 작업 행·Key를 30일 두는 이유는 호출처 relay 재전달의 멱등성이다(ADR-0005 결정 7). 이 기간은 개인정보 때문에 줄이지 않기로 했다(ADR-0015 결정 4).

## 설정과 기동 검사

| 변수 | 기본값 | 뜻 |
| ---- | ------ | -- |
| `MAILO_BODY_RETENTION_SECONDS` | 86400 | 종결 전이가 비우지 못한 행(이전 버전이 종결한 행, 배포 전 종결 행)의 본문 삭제 유예. 본문 세 열만 비운다. 수신자·봉투는 이 설정과 무관하다 |
| `MAILO_RECORD_RETENTION_SECONDS` | 2592000 | 종결 후 작업 행·시도·이벤트·Key 보존. 거부 기록은 생성 후 |
| `MAILO_RECIPIENT_RETENTION_SECONDS` | 604800 (7일, 추정) | 이벤트·시도의 수신자를 비우기까지의 유예(이벤트 생성 후). 60 이상 `MAILO_RECORD_RETENTION_SECONDS` 이하. 보존 기간과 같으면 비움이 삭제와 같은 시점이라 끄는 것과 같다 |
| `MAILO_MAINTENANCE_INTERVAL_SECONDS` | 60 | 정리 루프 한 바퀴의 간격이다. 한 바퀴에서 만료 sweep, lease 회수, 본문 삭제, 보존 삭제, 수신자 비움을 순서대로 돈다(`worker/worker.ts`의 `runMaintenanceLoop`, `worker/options.ts`). lease 회수는 점유 때마다도 한다(`db-maintenance.md`) |

- 기동 검사: `MAILO_RECORD_RETENTION_SECONDS` ≥ `MAILO_BODY_RETENTION_SECONDS`, ≥ `MAILO_JOB_EXPIRY_MAX_SECONDS`. `MAILO_RECIPIENT_RETENTION_SECONDS`는 60 이상 `MAILO_RECORD_RETENTION_SECONDS` 이하다. 이 변수를 주지 않았고 `MAILO_RECORD_RETENTION_SECONDS`가 7일보다 짧으면 기본값을 그 보존 기간으로 줄여 기동한다(비움이 삭제와 같은 시점). 명시한 값이 보존 기간을 넘으면 기동을 거부한다. 서명 허용 기간(`MAILO_JWS_IAT_MAX_AGE_SECONDS`)은 보존에서 오차를 뺀 값 이하여야 한다. 어기면 기동을 거부한다(`config/load-config.ts`).
- 정리는 배치 1000건, 한 사이클 최대 20배치다. 종결 작업이 이보다 빠르게 쌓이면 지연된다(`db-maintenance.md` "보존·삭제 규칙과의 관계"). 수신자 비움도 같은 상한이다.
- 이 변경을 처음 배포하면 마이그레이션 `0017`·`0018` 뒤 보존 기간 안의 기존 이벤트(최대 30일치) 중 유예가 지난 것이 모두 비움 대상이다. 사이클당 2만 건씩 따라간다(기본값). 진행은 `db-maintenance.md` "점검 쿼리"의 쿼리 5로 본다.

## Mailo 밖에 남는 것

Mailo는 아래 데이터를 지우지 못한다. 보존 기간은 각 운영 주체가 정한다.

| 위치 | 남는 것 | 운영 안내 |
| ---- | ------- | --------- |
| 로그 수집기·컨테이너 런타임 | Mailo 로그(식별자와 사유 코드만 있다) | 수집기의 보존 설정을 따른다. 로그에 수신자·본문이 없다는 점은 canary 테스트가 확인한다(RQ-027) |
| DB 백업·WAL | 위 표의 모든 행의 시점 사본(수신자 평문, 본문 암호문) | 백업 보존 기간은 운영자가 정한다. 백업을 복원하면 정리 단계가 보존 기간을 넘긴 행을 다음 사이클에 다시 지운다(확인, 코드 읽기, 실행하지 않았다). 복원 절차는 `deployment.md` "백업과 복구" |
| 호출처 저장소(outbox) | 호출처가 보낸 요청 전체 | 호출처의 몫이다 |
| 파일 채널 폴더, NAS 백업 | 수집 전 요청 파일. 수집한 원본은 등록·거부 기록의 DB 커밋 뒤 삭제한다(ADR-0004). 읽지 못한 파일(`unreadable`)은 거부하지 않고 폴더에 남기고, 삭제에 실패한 원본(`file_delete_failed`)도 남는다. JWE로 암호화하지 않은 파일은 NAS·백업에 평문으로 남을 수 있다 | 남은 파일은 `troubleshooting.md` "unreadable 파일"의 조치를 따른다. JWE 선택은 `caller-onboarding.md` "1. 등록 전에 정할 것" 표의 "본문 암호화(JWE)" 행이다 |
| SMTP 서버(Gmail·Workspace) | 발송한 메일 | Mailo 범위 밖이다 |
| PostgreSQL 서버 로그 | 제약 위반 오류의 `DETAIL`에 행 값이 들어갈 수 있다(예: unique 위반의 `Key (caller_id, idempotency_key)=(…)`). 느린 쿼리 로그에 쿼리 텍스트가 남을 수 있다 | DB 서버 설정(`log_min_error_statement`, `log_statement` 등)과 보존은 DB 운영자의 몫이다. Mailo 앱 로그와 다른 경로다(PostgreSQL 일반 지식, 확인하지 않았다) |
| 프록시·APM | 요청 본문·헤더 | Mailo 앞단의 설정이다. 요청 본문과 `Idempotency-Key` 헤더를 기록하지 않게 설정한다(가정, 이 저장소의 구성이 아니다) |

## 호출처 안내

- `Idempotency-Key`는 요청 단위의 고유 값(outbox 행 ID)으로 하고 사람을 식별하는 값(이메일 주소, 이름, 전화번호, 주민등록번호 조각)을 넣지 않는다. Key는 작업 행과 이벤트에 평문으로 30일 남는다.
- 파일 이름도 같다. outbox 행 ID로 정한다. 수집 거부 때 파일 이름이 거부 기록에 남고 이벤트로 호출처에 돌아간다.
- Mailo는 Key와 파일 이름의 내용을 검사하지 못한다. 형식만 검사한다. 호출처의 규칙이다.

## 위험 작업

보존 기간을 줄이거나 행을 직접 지우는 작업이다. 개인정보를 줄이려는 목적으로도 아래를 따른다.

### 개인정보 삭제 요청

Mailo는 수신자나 사람 단위로 데이터를 찾아 지우는 기능을 제공하지 않는다. 지원하지 않는다. 현재 할 수 있는 것은 다음이다.

- 해당 데이터가 보존 기간(기본 30일)이 끝나 지워질 때까지 기다린다. 이벤트·시도의 수신자는 유예(기본 7일) 뒤 비워지고, 이벤트 행은 작업 행과 같이 지워진다.
- 보존 기간을 줄이는 방법은 전체 데이터에 적용되고 아래 위험이 있다. 한 사람의 요청 때문에 쓰지 않는다.
- 로그 수집기, 백업, 호출처 저장소의 사본은 각 운영 주체가 지운다("Mailo 밖에 남는 것").
- 수동 `DELETE`는 아래 이유로 권하지 않는다. 꼭 필요하면 아래 "수동 삭제"의 위험을 먼저 확인한다.

### 보존 기간 단축

`MAILO_RECORD_RETENTION_SECONDS`를 줄이고 재시작한다.

- 다음 정리 사이클부터 새 값보다 오래된 종결 작업이 지워진다. 그 Key의 중복 방지가 사라져 호출처의 재전달이 새 요청으로 등록된다.
- 이벤트 수신자 유예(`MAILO_RECIPIENT_RETENTION_SECONDS`)가 새 보존 기간보다 길면 기동을 거부한다. 먼저 유예를 줄인다. 값을 줄이면 이미 비운 이벤트는 그대로이고 다음 사이클부터 새 유예가 적용된다.
- 이벤트도 작업 행과 함께 앞당겨 지워진다. 호출처의 cursor가 지워진 이벤트보다 오래됐으면 피드가 `Mailo-Cursor-Gap`(200)이나 410(`onGap=error`)으로 공백을 알린다(RQ-045). 호출처가 새 보존 기간보다 오래 폴링을 멈추면 이벤트를 놓친다. 호출처의 처리는 `caller-onboarding.md` "공백 신호 `Mailo-Cursor-Gap`"이고 운영자의 확인은 `troubleshooting.md` "이벤트 피드 공백"이다.
- 한 정리 사이클은 한 단계에서 최대 20배치 × 1000건만 지운다(`db-maintenance.md` "보존·삭제 규칙과의 관계"). 줄인 직후 지울 행이 많으면 여러 사이클에 나뉘어 지워지고, 사이클마다 죽은 행과 WAL이 한꺼번에 생긴다(`db-maintenance.md` 측정과 "점검 쿼리 4"로 따라간다).
- 기동 검사(위)를 지켜야 한다. 호출처의 최대 재시도 기간(7일 이하, ADR-0005 결정 7)보다 짧게 줄이지 않는다.

```txt
위험도: 높음 (작업 행·Key·시도·이벤트가 영구 삭제되고 중복 방지가 사라지며 호출처가 이벤트를 놓칠 수 있다)
롤백: 값을 되돌려도 지워진 행은 복원되지 않는다. 복원은 삭제 전에 받아 둔 pg_dump 백업으로만 한다(아래 "덤프와 복원")
```

### 수동 삭제

`mail_jobs` 행을 수동으로 지우거나 수신자 열을 직접 고친다.

- 하지 않는다. Key 중복 방지가 사라진다(`db-maintenance.md`). 보존 삭제가 지우게 둔다.
- 예외는 `db-maintenance.md` "배포 전 종결 행의 수신자·봉투 비우기"의 배치 SQL이다. 행을 지우지 않고 종결 행의 `recipients`·`envelope`만 비우므로 Key와 이벤트에 영향이 없다.
- `DELETE FROM mail_jobs`는 `mail_events`를 `ON DELETE CASCADE`로 함께 지운다. 그런데 이 경로는 삭제 표지(`mail_event_purges`)를 올리지 않는다. 앱의 보존 삭제는 같은 트랜잭션에서 표지를 올린다(`queue/maintenance.ts`의 `deleteByIds`가 부르는 `recordPurgedJobEvents`, `0009` 머리 주석). 표지가 없으면 호출처의 피드는 `Mailo-Cursor-Gap`이나 410 없이 이벤트를 조용히 잃는다(RQ-045).
- `mail_events`나 `mail_intake_rejections`를 직접 지울 때도 같다.
- 호출처와 해당 Key의 재전달 위험을 먼저 확인한다.

```txt
위험도: 높음 (Key 중복 방지가 사라지고 호출처의 재시도가 같은 메일을 다시 발송할 수 있다. 호출처 피드가 공백 신호 없이 이벤트를 잃는다)
롤백: 삭제 전에 받아 둔 pg_dump 백업을 복원한다. 백업이 없으면 되돌리지 못한다
```

`mail_ops_audit` 삭제는 `db-maintenance.md` "감사 테이블"의 위험도·롤백을 따른다.

### 덤프와 복원

- 삭제 전 `pg_dump`는 지우려는 평문의 복사본을 만든다. 목적에 따라 롤백 수단을 나눈다.
  - 보존 기간 단축처럼 운영 변경의 실수를 되돌리려는 경우: 전체 덤프를 받고 암호화해 보관하며 접근을 통제한다. 변경이 문제없음을 확인한 뒤 정한 기한 안에 덤프를 파기한다.
  - 개인정보를 지우려는 목적의 수동 삭제: 덤프가 지우려는 값을 그대로 남기므로 삭제 목적을 해친다. 롤백 불가를 받아들이고 덤프를 받지 않거나, 받는다면 위와 같은 보관 기한과 파기를 먼저 정한다.
- 백업에서 복원하면 수동으로 지우거나 비운 데이터가 되살아난다. 복원 뒤 정리 단계가 지우는 것은 보존 기간을 넘긴 작업 행과 거부 기록뿐이고 사이클당 상한(20배치 × 1000건)까지만 지운다. 보존 기간 안의 행을 수동으로 지운 것과 `mail_ops_audit`에서 지운 행은 자동으로 다시 지워지지 않는다(`mail_ops_audit`은 자동 삭제가 없다).
- 수동 삭제를 했다면 대상(작업 ID, 호출처, 기준, 실행일, 실행자)을 주소 없이 기록해 둔다. 백업을 복원한 뒤에는 같은 삭제를 다시 한다.

## 확인하지 않은 것

- 종결 전이가 비우는 동작은 `queue/complete.ts`·`queue/maintenance.ts`·`queue/cancel.ts`를 읽고 위 통합 테스트로 확인했다. 롤링 배포(구·신 인스턴스 혼용)에서 구버전이 종결하는 행의 실제 잔존은 실행하지 않았다.
- `db-maintenance.md`의 백필 SQL은 임시 schema에서 한 번 실행했다. 운영 크기에서의 소요 시간은 확인하지 않았다.
- 정리 사이클이 백업 복원본의 오래된 행을 지우는 동작은 코드 읽기 결과이고 실행하지 않았다.
- 수동 `DELETE`가 표지를 올리지 않아 피드 공백 신호가 없다는 점은 코드·마이그레이션 읽기 결과이고 실행해 확인하지 않았다.
- PostgreSQL 서버 로그의 `DETAIL`과 쿼리 텍스트 기록은 PostgreSQL 일반 지식이다. 이 저장소의 compose 설정으로 확인하지 않았다.
- 로그 수집기, 프록시, APM이 요청 값을 남기는지는 이 저장소 밖이라 확인하지 못했다.
- `response_text`에 사용자 이름이 섞이는 빈도. 주소 형태만 가린다.
- 운영 크기와 다중 인스턴스에서의 정리 지연(`db-maintenance.md`와 같은 한계).
- 이벤트 수신자 비움의 비용은 로컬 PostgreSQL 17.11 임시 schema에서 이벤트 20만 건으로 한 번 쟀다(`db-maintenance.md` "로컬 측정"). 운영 크기, 다중 인스턴스, 롤링 배포는 확인하지 않았다.
- 비운 이벤트의 수신자를 유예 뒤에도 기대하는 저장소 밖 호출처가 있는지는 확인하지 못했다. 백업(`pg_dump`)은 비우기 전 값을 담고 있을 수 있다.
- 호출처가 Key·파일 이름에 개인정보를 넣는지는 Mailo가 검사하지 못한다.
- 법적 요건(보존 의무, 삭제 요청 대응)에 맞는지는 판단하지 않았다.
