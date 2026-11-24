# 개인정보 보존 현황

Mailo가 다루는 개인정보가 어디에 얼마나 남고 어떻게 지워지는지 한 곳에 적는다. 무엇이 Mailo 밖에 남는지도 적는다.
근거는 RQ-070, ADR-0015 결정 1, 코드(`queue/`, `events/`, `smtp/sender.ts`, `config/load-config.ts`, `file-channel/`), 마이그레이션 `0001`~`0016`, 기존 운영 문서다.
표기: "확인"은 2026-11-24에 코드나 마이그레이션을 읽어 확인한 것이다. "자동 검증"은 자동 테스트가 확인하는 것이고 테스트 파일 이름을 적는다. "가정"은 확인하지 못한 것이다. 이 문서의 명령과 SQL은 실행하지 않았다.

종결 때 비움(RQ-071, ADR-0015 결정 2)은 `feat/redact-on-terminal` 브랜치가 구현한다. 이 문서는 그 변경이 들어간 동작을 "종결 전이"로 적고, 들어가기 전 코드의 값을 "RQ-071 이전"으로 함께 적는다. 이벤트·시도의 수신자를 유예 뒤 비우는 것(RQ-072, ADR-0015 결정 3)은 구현 전이라 이 문서는 지금 값(보존 기간 끝까지 평문)을 적는다. 그 변경이 들어가면 같은 변경에서 이 문서의 표를 고친다.

## 결론

- Mailo의 DB에 남는 개인정보는 수신자 주소(`recipients`, 이벤트·시도의 수신자), 발신자(`from`·`replyTo`), 제목·본문(암호문)이다. 호출처가 정하는 `Idempotency-Key`와 파일 이름에도 호출처가 넣은 값이 들어갈 수 있다.
- 종결 전이가 본문·수신자·봉투를 비운다. 이벤트와 시도 기록의 수신자는 작업 행과 함께 보존 기간(기본 30일) 끝까지 평문으로 남는다.
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
| `mail_jobs.body_ciphertext` 외 본문 열 | 제목·text·html | 암호문 | 종결 전이까지. RQ-071 이전 코드는 종결 후 1일(`MAILO_BODY_RETENTION_SECONDS`). 취소는 취소 전이까지 | 종결 전이의 같은 `UPDATE`가 NULL로 바꾼다. 이전 버전이 종결한 행은 `deleteExpiredBodies`가 비운다 | 확인: `queue/complete.ts`, `queue/maintenance.ts`, `queue/cancel.ts`. 자동 검증: `queue/redact-on-terminal.integration-spec.ts` |
| `mail_jobs.recipients` | to·cc·bcc | 평문 jsonb | 종결 전이까지. RQ-071 이전 코드는 종결 후 30일 | 종결 전이의 같은 `UPDATE`가 `'{}'`로 바꾼다. 이전에는 행 삭제 | 같은 곳 |
| `mail_jobs.envelope` | `from`, `replyTo` | 평문 jsonb | 종결 전이까지. RQ-071 이전 코드는 종결 후 30일 | 같은 방식 | 같은 곳 |
| `mail_jobs.idempotency_key`, `fingerprint` | 호출처가 정한 Key, 요청 전체의 HMAC-SHA256 | 평문, 해시 | 종결 후 `MAILO_RECORD_RETENTION_SECONDS`(30일). 종결하지 않은 작업은 지우지 않는다 | `deleteExpiredRecords`가 행을 지운다 | 확인: `queue/maintenance.ts`, `0001`. 지문 키는 DB와 분리한다(ADR-0005 결정 3) |
| `mail_events.recipients`, `rejected_recipients` | 수신자, 거부된 수신자 | 평문 jsonb | 30일. 작업 행과 같이 지워진다 | 작업 삭제의 `ON DELETE CASCADE`. `INTAKE_REJECTED` 이벤트는 거부 기록과 같이 지워진다 | 확인: `0001`, `events/event-store.ts`. 이벤트에 본문·`from`·`replyTo`는 없다(`queue/redact-on-terminal.integration-spec.ts`) |
| `mail_attempts.rejected_recipients` | 일부 거부된 수신자 주소 | 평문 jsonb | 30일 | 작업 삭제의 CASCADE | 확인: `queue/complete.ts`(`SENT` 시도만 값이 있다) |
| `mail_attempts.response_text` | SMTP 응답 텍스트 | 평문. 주소 형태는 `[address]`로 바꾸고 500자로 자른다 | 30일 | 작업 삭제의 CASCADE | 확인: `smtp/sender.ts`의 `sanitizeResponseText`. 한계: 주소가 아닌 사용자 이름을 되풀이하는 응답은 가리지 못한다(ADR-0007 구현 중 확정 5) |
| `mail_intake_rejections` | 파일 이름, sha256, 파싱한 Key | 평문 | 기록 생성 후 30일 | `deleteExpiredRecords` | 확인: `0001`, `queue/maintenance.ts`. 거부된 파일의 본문은 기록하지 않는다(ADR-0006 결정 3) |
| `mail_ops_audit` | 관리 토큰 이름, 작업 ID. 주소·제목·본문 없음 | 평문 | 자동 삭제 없음 | 수동 `DELETE`. 절차와 위험도는 `db-maintenance.md` "감사 테이블" | 확인: `0008`, ADR-0012 결정 8. 토큰 이름 형식은 `[a-z][a-z0-9]{0,31}`(`deployment.md`) |
| `mail_send_controls`, `mail_circuit_breaker`, `mail_event_purges`, `schema_migrations` | 호출처·계정 ID, 토큰 이름, 사유 코드, 시각. 주소·제목·본문 없음 | 평문 | 정지는 재개 때 지운다. 나머지는 행이 남는다 | | 확인: `0001`, `0008`, `0009` 열 목록 |
| 로그(표준 출력 JSON) | 없다. `callerId`, `jobId`, 사유 코드 같은 식별자만 있다 | JSON 줄 | Mailo는 보존하지 않는다. 수집기·런타임의 몫이다 | 수집기 설정 | 자동 검증: `worker/worker.integration-spec.ts`, `http/rest-intake.integration-spec.ts`, `file-channel/poller.integration-spec.ts`(canary, RQ-027). 거부 파일 이름은 로그에 없다(ADR-0004 구현 중 확정 32) |
| `/metrics` | 없다. 라벨은 `caller_id`, `account_id`, 사유 같은 닫힌 집합이다 | Prometheus 텍스트 | 스크레이프 저장소의 몫이다 | | 확인: RQ-050, ADR-0012 결정 6 |
| Worker 프로세스 메모리 | 전송 중인 평문 | 메모리 | 전송이 끝날 때까지 | | 확인: ADR-0001 "암호화 범위와 한계" |

- 종결한 작업의 `recipients`·`envelope`를 읽는 코드 경로는 찾지 못했다. 읽는 곳은 `claim`, 결과 기록, 만료 sweep, 취소이고 모두 종결 전 행이다(확인, 코드 읽기). 종결 이벤트를 쓸 때 `recipients`를 이벤트로 복사한다.
- `GET /jobs`의 `Job` 응답에는 수신자 필드가 없다. `rejectedRecipients`만 `SENT`일 때 있다. 이벤트 응답에는 `recipients`가 있다(`intake/presenters.ts`).
- `/ops/jobs/{jobId}`와 CLI는 수신자·Key·본문·SMTP 응답 텍스트를 내지 않는다(ADR-0011 결정 7, RQ-048의 canary 테스트).
- 작업 행·Key를 30일 두는 이유는 호출처 relay 재전달의 멱등성이다(ADR-0005 결정 7). 이 기간은 개인정보 때문에 줄이지 않기로 했다(ADR-0015 결정 4).

## 설정과 기동 검사

| 변수 | 기본값 | 뜻 |
| ---- | ------ | -- |
| `MAILO_BODY_RETENTION_SECONDS` | 86400 | 종결 전이가 비우지 못한 행(이전 버전이 종결한 행)의 본문 삭제 유예. RQ-071 이전 코드는 모든 종결 행의 유예 |
| `MAILO_RECORD_RETENTION_SECONDS` | 2592000 | 종결 후 작업 행·시도·이벤트·Key 보존. 거부 기록은 생성 후 |
| `MAILO_MAINTENANCE_INTERVAL_SECONDS` | 60 | 정리 단계의 실행 간격(`db-maintenance.md`) |

- 기동 검사: `MAILO_RECORD_RETENTION_SECONDS` ≥ `MAILO_BODY_RETENTION_SECONDS`, ≥ `MAILO_JOB_EXPIRY_MAX_SECONDS`. 서명 허용 기간(`MAILO_JWS_IAT_MAX_AGE_SECONDS`)은 보존에서 오차를 뺀 값 이하여야 한다. 어기면 기동을 거부한다(`config/load-config.ts`).
- 정리는 배치 1000건, 한 사이클 최대 20배치다. 종결 작업이 이보다 빠르게 쌓이면 지연된다(`db-maintenance.md` "보존·삭제 규칙과의 관계").

## Mailo 밖에 남는 것

Mailo는 아래 데이터를 지우지 못한다. 보존 기간은 각 운영 주체가 정한다.

| 위치 | 남는 것 | 운영 안내 |
| ---- | ------- | --------- |
| 로그 수집기·컨테이너 런타임 | Mailo 로그(식별자와 사유 코드만 있다) | 수집기의 보존 설정을 따른다. 로그에 수신자·본문이 없다는 점은 canary 테스트가 확인한다(RQ-027) |
| DB 백업·WAL | 위 표의 모든 행의 시점 사본(수신자 평문, 본문 암호문) | 백업 보존 기간은 운영자가 정한다. 백업을 복원하면 정리 단계가 보존 기간을 넘긴 행을 다음 사이클에 다시 지운다(확인, 코드 읽기, 실행하지 않았다). 복원 절차는 `deployment.md` "백업과 복구" |
| 호출처 저장소(outbox) | 호출처가 보낸 요청 전체 | 호출처의 몫이다 |
| 파일 채널 폴더, NAS 백업 | 수집 전 요청 파일. 수집한 원본은 등록·거부 기록의 DB 커밋 뒤 삭제한다(ADR-0004). JWE로 암호화하지 않은 파일은 NAS·백업에 평문으로 남을 수 있다 | `caller-onboarding.md`의 JWE 선택 기준 |
| SMTP 서버(Gmail·Workspace) | 발송한 메일 | Mailo 범위 밖이다 |
| 프록시·APM | 요청 본문·헤더 | Mailo 앞단의 설정이다. 요청 본문과 `Idempotency-Key` 헤더를 기록하지 않게 설정한다(가정, 이 저장소의 구성이 아니다) |

## 호출처 안내

- `Idempotency-Key`는 요청 단위의 고유 값(outbox 행 ID)으로 하고 사람을 식별하는 값(이메일 주소, 이름, 전화번호, 주민등록번호 조각)을 넣지 않는다. Key는 작업 행과 이벤트에 평문으로 30일 남는다.
- 파일 이름도 같다. outbox 행 ID로 정한다. 수집 거부 때 파일 이름이 거부 기록에 남고 이벤트로 호출처에 돌아간다.
- Mailo는 Key와 파일 이름의 내용을 검사하지 못한다. 형식만 검사한다. 호출처의 규칙이다.

## 위험 작업

보존 기간을 줄이거나 행을 직접 지우는 작업이다. 개인정보를 줄이려는 목적으로도 아래를 따른다.

`MAILO_RECORD_RETENTION_SECONDS`를 줄이고 재시작한다.

- 다음 정리 사이클부터 새 값보다 오래된 종결 작업이 지워진다. 그 Key의 중복 방지가 사라져 호출처의 재전달이 새 요청으로 등록된다.
- 기동 검사(위)를 지켜야 한다. 호출처의 최대 재시도 기간(7일 이하, ADR-0005 결정 7)보다 짧게 줄이지 않는다.

```txt
위험도: 높음 (작업 행·Key·시도·이벤트가 영구 삭제되고 중복 방지가 사라진다)
롤백: 값을 되돌려도 지워진 행은 복원되지 않는다. 삭제 전에 받아 둔 pg_dump 백업으로만 복원한다
```

`mail_jobs` 행을 수동으로 지우거나 수신자 열을 직접 고친다.

- 하지 않는다. Key 중복 방지가 사라진다(`db-maintenance.md`). 보존 삭제가 지우게 둔다.
- 개인정보를 이유로 특정 행을 지워야 하면 먼저 `pg_dump`를 받고 호출처와 해당 Key의 재전달 위험을 확인한다.

```txt
위험도: 높음 (Key 중복 방지가 사라지고 호출처의 재시도가 같은 메일을 다시 발송할 수 있다)
롤백: 삭제 전에 받아 둔 pg_dump 백업을 복원한다. 백업이 없으면 되돌리지 못한다
```

`mail_ops_audit` 삭제는 `db-maintenance.md` "감사 테이블"의 위험도·롤백을 따른다.

## 확인하지 않은 것

- RQ-071이 병합되기 전 코드와 병합된 뒤 코드의 차이는 코드 읽기와 `queue/redact-on-terminal.integration-spec.ts`로 확인했다. 병합 뒤 이 문서를 다시 대조하지 않았다.
- 정리 사이클이 백업 복원본의 오래된 행을 지우는 동작은 코드 읽기 결과이고 실행하지 않았다.
- 로그 수집기, 프록시, APM이 요청 값을 남기는지는 이 저장소 밖이라 확인하지 못했다.
- `response_text`에 사용자 이름이 섞이는 빈도. 주소 형태만 가린다.
- 운영 크기와 다중 인스턴스에서의 정리 지연(`db-maintenance.md`와 같은 한계).
- 호출처가 Key·파일 이름에 개인정보를 넣는지는 Mailo가 검사하지 못한다.
- 법적 요건(보존 의무, 삭제 요청 대응)에 맞는지는 판단하지 않았다.
