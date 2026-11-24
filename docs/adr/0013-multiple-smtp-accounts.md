# 다중 SMTP 계정은 호출처가 계정 하나를 지정하고, 작업이 등록 때 계정을 고정하며, 점유·차단기·할당·정지를 계정 단위로 나눈다

## 상태

승인됨 (2026-11-24)

2026-11-24에 제안했고 같은 날 사용자가 승인했다. 열린 질문이던 11건은 이 문서가 적은 권고대로 승인했다. 승인된 값은 "미결정·확인하지 않은 것"의 "승인된 결정" 절에 모았다. 입력은 `docs/requirements/roadmap.md`의 "단계 7. 다중 SMTP 계정"이다.

구현 상태(2026-11-24): 묶음 A(계정 모델), 묶음 B(계정 단위 점유), 묶음 C(운영 표면) 구현 완료(미검증 항목 있음). 묶음 D(호출처 동시 상한)는 미착수다.

- 묶음 A의 범위: 결정 1(계정 파일·`default` 출처·기동 검증), 결정 2(호출처 `accountId`, 등록 때 계정 고정, 구성 밖 계정의 작업), 결정 3 나의 차단기 키(계정 ID)와 기동 때 행 생성, 결정 4의 `0010`·`0011`, 결정 6(발신 주소 허용 집합). 요구사항은 RQ-053~056이다.
- 묶음 A에서 구현하지 않은 것: 결정 3의 가·다·라·마·바·사·아(계정별 `claim`, 계정 정지, 24시간 할당, 슬롯 배분, 건수 쿼리), 결정 4의 `0012`~`0016`(인덱스 교체), 결정 5 전체. `default`가 아닌 계정은 묶음 B가 끝나기 전까지 앱이 기동을 거부한다(구현 중 확정 2026-11-24 리뷰 반영).
- 묶음 B의 범위(2026-11-24 구현): 결정 3의 가·나·다·라·바·사·아(계정별 `claim`, 계정별 차단기 모드와 대표 작업, 계정 정지의 점유 적용, 24시간 할당, 슬롯 배분과 기동 검사, 건수 쿼리의 계정별 합), 결정 4의 `0012`~`0016`, 로그. 묶음 A의 비`default` 계정 기동 거부는 제거했다. 요구사항은 RQ-057~059다.
- 묶음 B에서 구현하지 않은 것: 계정 정지를 쓰고 지우는 REST·CLI·감사와 `GET /ops/accounts`, `/metrics`·`/health/ready`의 계정 표면(결정 5 전체, 묶음 C가 구현), 호출처 동시 상한(결정 3 마, 묶음 D). 계정 정지는 `mail_send_controls`의 `account` 범위 행을 점유가 읽는 데까지다.
- 묶음 C의 범위(2026-11-24 구현): 결정 5 전체(`GET /ops/accounts`, `PUT`·`DELETE /ops/pauses/accounts/{accountId}`와 감사, `GET /ops/pauses`의 `account` 항목, `OpsJob.accountId`, CLI `accounts list`·`--account`, `/metrics`의 `account_id` 라벨·시드·새 지표, `/health/ready`의 `circuitBreaker`·`sendPaused.scope`·`sendControls`). 요구사항은 RQ-060~063이다. 마이그레이션이 없다.
- 구현하면서 정한 내용은 "구현 중 확정" 절에 모았다. 남은 미검증 항목은 RQ-053~056의 수용 조건과 이 문서의 "확인하지 않은 것"을 따른다.

검증 범위는 코드 읽기와 PostgreSQL 17.11(로컬 compose)의 임시 schema 측정이다(2026-11-24).

- 임시 schema에 `0001`~`0009`를 적용하고 `0005`의 인덱스(`mail_jobs_priority_claim_idx`)를 일반 `CREATE INDEX`로 만들었다.
- 작업 150만 행(SENT 125만, PENDING 15만, RETRY_WAIT 10만 중 5만은 예약 시각 미래, SENDING 40), 시도 약 42만 행을 넣었다. 계정은 `a1`~`a5` 다섯 개이고 호출처는 20개다. `a1`은 닫힌 계정으로 가정해 점유 가능 대기 10만 건을 모든 다른 작업보다 앞(더 오래된 `next_attempt_at`)에 두었다. `a2`에는 최근 24시간 시도 약 12만 건을 넣었다.
- `VACUUM ANALYZE` 뒤 `EXPLAIN (ANALYZE, BUFFERS)`를 쿼리마다 2~3회 실행했다. 표의 값은 마지막 값이거나 범위다. 임시 schema는 지웠다.
- 확인하지 않은 것: 자동 테스트, 실제 Gmail·Workspace 계정, 운영 크기(수백만 행), 다중 인스턴스 동시 부하, 롤링 배포와 롤백 실행. 측정은 WSL2 로컬 단일 실행이고 동시 부하가 없다.

승인으로 다음 관계가 생겼다. 승인된 ADR의 결정 문구는 바꾸지 않는다.

- ADR-0002 결정 4·5의 점유와 lease 복구는 그대로이고, 점유 호출 단위가 계정 하나로 좁아진다(결정 3).
- ADR-0007 결정 5는 차단기 행을 "SMTP 구성 하나당 한 행"으로 정했다. 이 ADR은 행 키를 계정 ID로 정한다. 스키마는 바뀌지 않는다(결정 3).
- ADR-0007 구현 중 확정 7의 한계("호출처 할당의 합이 계정 한도를 넘지 않는다는 보장이 없다")는 결정 3의 계정 단위 24시간 할당이 보완한다.
- ADR-0007 구현 중 확정 10의 재검토 조건(대안으로 적은 `LATERAL`)은 측정 결과 채택하지 않는다(결정 3).
- ADR-0007 결정 8의 `Message-ID` 도메인은 작업이 고정한 계정의 주소 도메인이다(결정 2).
- ADR-0008 구현 중 확정 12(`allowedFrom`)의 기본 발신 주소는 `MAILO_SMTP_FROM`에서 호출처 계정의 `from`으로 바뀐다(결정 6).
- ADR-0009 결정 9의 우선순위 점유 인덱스는 계정 단위 인덱스로 대체된다(결정 4). 결정 10의 "코드 먼저, 레지스트리 나중" 순서를 따른다(결정 2).
- ADR-0011 결정 2의 `account` 범위 행과 구현 중 확정 13을 결정 3·5가 쓴다. `mail_send_controls`와 `mail_ops_audit`의 CHECK는 이미 `account`를 허용하므로 마이그레이션이 없다(결정 4).
- ADR-0012 구현 중 확정 13(`createMetrics({ accountIds })`)을 결정 5가 정한다. 지표 이름과 라벨 이름은 바뀌지 않는다.
- RQ-028(레지스트리), RQ-031(헬스), RQ-032(할당), RQ-049~052(지표)의 문구는 구현 때 갱신한다. 새 RQ 번호는 기능 구현 때 RQ-053 이후로 정한다. 이 ADR은 번호를 가정하지 않는다.
- `docs/requirements/mail-sending.md`의 미결정 항목 "차단기 키 구성"은 결정 3이 닫는다. "계정 전체 발송 속도 제어"는 24시간 할당(결정 3)만 닫고 초·분 단위 제어는 범위 밖으로 남는다.

## 배경

현재 동작이다(2026-11-24, 코드를 읽어 확인했다).

- SMTP 설정은 `MAILO_SMTP_*` 하나다. `config/load-config.ts`의 `loadSmtp`가 `SmtpConfig` 하나를 만든다. Worker는 발송기(`MailSender`) 하나와 기본 발신 주소(`defaultFrom`) 하나를 받는다(`worker/runner.ts`의 `toSenderConfig`, `createWorkerRunner`).
- 발송기는 작업마다 `createTransport`로 연결을 만들고 `close()`한다(`smtp/sender.ts`의 `createSmtpSender`). 연결 풀이나 계정별 상태가 없다. `Message-ID` 도메인은 `accountAddress`(= `smtp.defaultFrom`)다.
- 차단기 행은 `mail_circuit_breaker` 하나이고 기본키는 `breaker_key`다. `0001`이 `default` 행을 넣는다. 키는 상수 `"default"`다(`config/load-config.ts`, `queue/retry-policy.ts`). 앱은 기동 때 이 테이블에 쓰지 않는다. `claim`은 행이 없으면 예외를 던진다.
- `completeAttempt`와 `applyOutcome`은 `deps.breaker.breakerKey`로 차단기를 갱신한다. `LEASE_EXPIRED`와 내부 오류(`internal: true`)는 차단기를 건드리지 않는다(`queue/complete.ts`). 한 완료 트랜잭션은 차단기 행 하나만 갱신한다.
- `claim` 한 번은 모드 하나(`none`·`normal`·`probe`)를 쓴다. 제외는 `caller_id <> ALL(blocked)` 필터다. 점유 인덱스 `mail_jobs_claim_idx (next_attempt_at, id)`와 `mail_jobs_priority_claim_idx (priority DESC, next_attempt_at, id)`는 `status IN ('PENDING','RETRY_WAIT')` 부분 인덱스이고 `caller_id`·계정 열이 없다.
- 호출처 할당은 `planQuotas`가 호출처마다 `pg_try_advisory_xact_lock(7364222, hashtext(caller_id))`를 잡고 `CALLER_QUOTA_USAGE_SQL`로 읽는다. 시도 행의 호출처는 `mail_attempts.caller_id`(`0002`)다.
- `mail_send_controls`의 `scope_type` CHECK는 `account`를 허용한다. `readSendControls`·`listPauses`·`getCallerPauseSummary`는 `all`과 `caller`만 다룬다. `mail_ops_audit`의 `scope_type` CHECK도 `account`를 허용하고 `mail_ops_audit_shape`는 `account` 범위의 `PAUSE`·`RESUME`을 통과시킨다(`0008`).
- 레지스트리는 모르는 필드를 거부한다(`callers/registry.ts`의 `ENTRY_FIELDS`, 최상위는 `callers`뿐). 비밀은 `secretVar` 이름만 두고 값은 `EnvReader.secret`이 `<변수>_FILE`을 먼저, 없으면 `<변수>`로 읽는다.
- 발신 주소 허용 집합은 `isSenderAllowed(from, defaultFrom, allowedFrom)`이 판정한다. `defaultFrom`은 `IntakeService`·파일 채널 `ingest`·`app.module.ts`가 `config.smtp.defaultFrom`으로 넘긴다. `from`을 생략한 요청(null)은 항상 허용되고 Worker가 `defaultFrom`으로 채운다(`worker/worker.ts`). 요청 본문의 모르는 필드는 `UNKNOWN_FIELD`로 거부된다(`envelope/request-schema.ts`).
- 등록 SQL은 컬럼을 열거한다(`queue/register.ts`). `src/`에 `SELECT *`와 `RETURNING *`는 없다.
- `/metrics`의 `account_id` 값은 상수 `DEFAULT_ACCOUNT_ID`다(`metrics/catalog.ts`). 값이 0인 시리즈를 미리 만드는 `seed`는 라벨 값의 곱집합을 만들고 지표 하나의 시리즈 상한은 2000이다(`metrics/store.ts`의 `seedZeroSeries`).
- 인증 없는 `/health/ready`는 `circuitBreaker.state` 하나를 낸다. 인증하면 `openUntil`·`lastReason`을 더한다(`health/health.service.ts`).
- `MAILO_WORKER_CONCURRENCY`는 기본 4(1~100), `MAILO_WORKER_POLL_MS`는 기본 1000이다. `MAILO_DB_POOL_MAX`는 동시성 + 4 이상이어야 한다.
- SMTP 비밀번호 교체는 시크릿을 바꾸고 재시작하는 절차다(`docs/operations/key-management.md`의 "기타 시크릿").

측정(2026-11-24, 위 "상태"의 임시 schema). 계획이 `shared_buffers`에 없는 페이지를 읽는 값(`read`)이 섞여 있다.

| 번호 | 쿼리(모두 `LIMIT 4 FOR UPDATE SKIP LOCKED`, 롤백) | 인덱스 상태 | 실행 시간 | 계획 요점 |
| ---- | --------------------------------------------------- | ----------- | --------- | --------- |
| M1 | 현행 우선순위 경로, 제외 없음 | 현행 | 0.07ms | `mail_jobs_priority_claim_idx` |
| M2 | 현행 방식으로 `a1`의 호출처 4개를 `caller_id <> ALL`로 제외, 우선순위 경로. 대기가 모두 등급 20 | 현행 | 60.2, 45.9, 42.2ms(3회) | 같은 인덱스, `Rows Removed by Filter: 100000` |
| M3 | M2의 대기 순서(`fifo`) 경로 | 현행 | 37.8, 39.5ms | `mail_jobs_claim_idx`, 100000건 버림 |
| M4 | 계정 조건 `account_id = 'a2'`만 추가 | 현행(새 인덱스 없음) | 우선순위 53.7, 27.3, 20.1ms. 대기 순서 21.2, 21.6ms | 레거시 인덱스, 100009건 버림 |
| M5 | M4와 같음 | 새 인덱스 2개와 레거시가 함께 있음 | 우선순위 26.4, 25.1, 25.1ms. 대기 순서 31.2, 25.7ms | 계획이 레거시 인덱스를 고른다. 비용 추정은 레거시 64.29, 새 인덱스 69.62 |
| M6 | M4와 같음 | 새 인덱스 2개만 있음(레거시 삭제) | 우선순위 0.059ms, 대기 순서 0.059ms. `a2` 안 호출처 2개 제외 0.027ms | 새 인덱스를 쓴다. 버린 행 0~3건 |
| M7 | 한 트랜잭션에서 `a2`~`a5`를 `LATERAL`로 계정당 4건 | 레거시 공존 / 레거시 삭제 | 114.1, 120.5ms / 405.4, 406.2ms | 공존이면 레거시 인덱스(100010건 버림 ×4). 삭제 뒤에는 `mail_jobs_expiry_idx` 스캔과 `Sort`(2.5만 행 ×4) |
| M8 | 구버전 점유 쿼리(계정 조건 없음, 대기 25만 건) | 레거시 삭제 | 우선순위 145.8, 126.1ms. 대기 순서 107.0ms | `mail_jobs_expiry_idx`로 20만 행을 읽고 `external merge` 정렬 9.4MB |
| M9 | 계정별 점유 가능 건수와 가장 오래된 시각(상한 10001) | 새 인덱스 | `a2` 2.8, 1.8ms. `a1` 3.7ms. 등급 지정 2.2ms. 없는 등급 0.06ms | `mail_jobs_account_claim_idx` 또는 등급 인덱스 |
| M10 | 현행 전역 건수(`getQueueBacklog`의 첫 부분) | 레거시 삭제 / 레거시 있음 | 50.8ms / 4.6ms | 삭제 뒤에는 `mail_jobs_expiry_idx` 병렬 스캔 |
| M11 | 계정 24시간 사용량 `a2`(시도 한도 10만 / 1만 + `SENDING` 수) | 새 인덱스 | 10.4ms / 1.0ms | `mail_attempts_account_quota_idx` 인덱스 전용 스캔. `SENDING` 수는 `mail_jobs_lease_idx`로 0.02ms |

쓰기·DDL 측정이다.

| 항목 | 값 |
| ---- | -- |
| `ALTER TABLE mail_jobs ADD COLUMN account_id text NOT NULL DEFAULT 'default', ADD CONSTRAINT ... CHECK (...) NOT VALID`(150만 행) | 1.2ms. `pg_class.relfilenode` 불변(표 재작성 없음). 제약 `convalidated = false` |
| 같은 문장, `mail_attempts`(30만 행) | 0.56ms. `relfilenode` 불변 |
| `CREATE INDEX CONCURRENTLY`(동시 쓰기 없음) | `mail_jobs` 두 인덱스 328ms·292ms(14MB·12MB), `mail_attempts` 170ms(9.3MB). 레거시 두 인덱스는 12MB·10MB |
| 20만 행 `INSERT`(본문 1KiB, 3회 평균) | 인덱스 현행 2.18초, 레거시와 새 인덱스 공존 2.70초, 새 인덱스만 2.51초. 행당 약 +1.5~2.6µs |

해석이다.

- M2·M3은 현행 방식(`caller_id <> ALL`)을 계정 차단에 쓰면 닫힌 계정의 대기 10만 건을 매 poll 읽고 버린다는 로드맵의 우려를 확인한다. ADR-0007 구현 중 확정 10은 같은 형태를 10만 건에서 11.8ms로 쟀다. 이번 값은 행 크기와 캐시 조건이 달라 3~5배 크다. 같은 환경에서 비교한 값만 근거로 쓴다.
- 계정 단위 인덱스만 있으면 같은 점유가 0.06ms다(M6, 약 700배 차이). 새 인덱스를 추가만 하면 계획이 레거시 인덱스를 고른다(M5). 새 인덱스를 확실히 쓰게 하려면 레거시 인덱스를 지워야 한다(결정 4).
- `LATERAL` 한 트랜잭션은 매개변수 계정에서 계획이 흔들려 레거시 공존 때 114~121ms, 삭제 뒤 405ms였다(M7). 상수 계정 쿼리(`$1`을 바인드해 값으로 계획하는 쿼리)는 M6처럼 안정적이다. 채택하지 않는다.
- 레거시 인덱스를 지우면 구버전 인스턴스의 점유가 대기 건수에 비례하는 비용이 된다(M8, 25만 건에서 약 110~150ms). 정확성은 영향받지 않는다.
- 전역 건수 쿼리도 레거시 인덱스에 기대고 있어서(M10) 계정별 쿼리 합으로 바꿔야 한다(M9).

## 결정

1. **계정은 `MAILO_SMTP_ACCOUNTS_FILE`의 JSON과 기존 `MAILO_SMTP_*`로 정의한다. `default` 계정의 출처는 둘 중 정확히 하나다.**
   - 문제: 계정을 여러 개 받는 설정 형식과 기존 단일 계정 배포의 호환을 정해야 한다. 비밀은 파일에 두지 않는다(RQ-027).
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 환경 변수만(`MAILO_SMTP_<ID>_HOST` 등 계정마다 변수 묶음) | 변수가 계정 수에 곱해지고 검증이 어렵다. 호출처 레지스트리와 형식이 다르다 |
     | B. 파일만. `MAILO_SMTP_*`는 제거 | 단일 계정 배포가 업그레이드 때 설정을 모두 옮겨야 한다. 호환이 깨진다 |
     | C. `MAILO_SMTP_*`는 `default` 고정, 파일은 추가 계정만 | 호환은 쉽다. `default`를 파일로 옮길 수 없고 `default`에 계정 한도를 줄 수 없다 |
     | D. `default`의 출처를 환경 변수 또는 파일 중 하나로 한다. 둘 다면 기동 거부 | 권고. 단일 계정 배포는 변경 없이 동작한다. 나중에 `default`를 파일로 옮길 수 있다 |

   - 결정 문구(D):
     - 파일 형식은 호출처 레지스트리와 같은 방식이다. 값은 JSON에 두지 않고 변수 이름만 둔다.

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
             "timeoutSeconds": 30,
             "sendQuota24h": 400,
             "concurrency": 2
           }
         ]
       }
       ```

     - 필드 규칙이다. 모르는 필드와 최상위의 `accounts` 밖 필드는 기동을 거부한다.

       | 필드 | 필수 | 규칙 |
       | ---- | ---- | ---- |
       | `id` | 필수 | 계정 ID. 아래 형식 |
       | `host` | 필수 | 호스트 이름. `loadSmtp`의 `HOSTNAME` 검사와 같다 |
       | `port` | 선택 | 1~65535. 기본은 `security`가 `tls`면 465, 아니면 587 |
       | `security` | 선택 | `starttls`·`tls`·`none`. 기본 `starttls` |
       | `auth` | 선택 | `user`와 `secretVar` 쌍. 생략하면 인증 없는 릴레이다. `user`는 주소가 아닌 값도 받는다(현행 `MAILO_SMTP_USER`와 같다) |
       | `from` | 조건부 | 주소 하나(`checkAddress`). 생략하면 `auth.user`를 쓴다. 둘 다 없으면 거부한다 |
       | `timeoutSeconds` | 선택 | 1~3600이고 `MAILO_LEASE_SECONDS` 미만. 생략하면 `MAILO_SMTP_TIMEOUT_SECONDS`(기본 30) |
       | `sendQuota24h` | 선택 | 계정 24시간 할당. 1~10000000. 생략하면 무제한(결정 3) |
       | `concurrency` | 선택 | 이 인스턴스가 이 계정에 동시에 쓰는 슬롯 상한. 1~`MAILO_WORKER_CONCURRENCY`. 생략하면 결정 3의 식 |

     - 계정 ID 형식은 `^[a-z0-9][a-z0-9_-]{0,31}$`(1~32자)이고 `unregistered`는 예약어다(지표의 구성 밖 계정 값, 결정 5). 이유는 다음과 같다.
       - `@`와 `.`가 없어 SMTP 사용자 주소를 ID로 쓸 수 없다. 로그·지표 라벨·감사에 주소가 들어가지 않게 하는 구조적 장치다(RQ-027).
       - 소문자만 받아 대소문자 구분 때문의 중복 ID와 `mail_send_controls.scope_id`(64자 이하) 불일치를 막는다.
       - 호출처 ID 형식(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)보다 좁다. 운영자 설정 이름이고 라벨 길이를 줄이기 위해서다.
     - `secretVar`는 `^MAILO_SMTP_SECRET_[A-Z0-9_]{1,40}$`이고 `_FILE`로 끝나는 이름은 거부한다. 값은 `<변수>_FILE`(우선) 또는 `<변수>`로 받는다. 같은 변수를 두 계정이 쓰면 거부한다.
     - 같은 `(host, port, user)`를 가진 계정이 둘이면 거부한다. 같은 메일박스를 차단기 둘과 할당 둘로 쪼개는 오설정이기 때문이다.
     - `default`의 출처:

       | 상태 | 동작 |
       | ---- | ---- |
       | 파일 없음 | 현행과 같다. `MAILO_SMTP_*`가 `default` 하나를 정의하고 `MAILO_SMTP_HOST`가 필수다 |
       | 파일 있음, `MAILO_SMTP_HOST` 있음 | `default`는 환경 변수 정의다. 파일에 `id: "default"`가 있으면 기동을 거부한다 |
       | 파일 있음, `MAILO_SMTP_HOST` 없음 | `default`는 파일에 있으면 그것, 없으면 `default` 계정이 없다. 이때 `MAILO_SMTP_USER` 같은 다른 `MAILO_SMTP_*`가 있으면 오설정으로 거부한다 |
       | 파일 없음, `MAILO_SMTP_HOST` 없음 | 기동을 거부한다(현행) |

       환경 변수로 정의한 `default`는 `sendQuota24h`·`concurrency`를 받지 않는다(무제한, 결정 3의 식). 필요하면 `default`를 파일로 옮긴다. 이때 비밀 변수 이름을 `MAILO_SMTP_SECRET_*`로 바꿔 시크릿 파일 이름을 맞춘다.
     - 기동 검증은 `loadConfig` 안에서 다음을 한다. 오류 메시지에는 위치(`accounts[2].auth.secretVar`)와 고정 사유만 담고 host·user·값은 담지 않는다.
       1. 구조·모르는 필드·ID 형식·중복·예약어.
       2. host·port·security·timeout은 `loadSmtp`와 같은 규칙이다. 계정마다 `toSenderConfig`의 `checkSmtpTimeouts`를 통과해야 한다(ADR-0002 결정 11).
       3. 비밀 변수가 있는지, `from` 형식, 비밀 변수 중복, `(host, port, user)` 중복.
       4. 계정 수는 20개 이하다(추정). 계정 수 N이 `MAILO_WORKER_CONCURRENCY` 이하여야 한다(결정 3의 슬롯 보장).
       5. 어느 호출처도 참조하지 않는 계정은 허용한다. 기동 로그 `account_unused`(info, `accountId`)를 남긴다.
       6. `security: "none"`인 계정마다 `smtp_plaintext_enabled`(warn)에 `accountId`를 더한다(RQ-005).
     - 변경은 재시작 뒤 반영된다. 핫 리로드는 없다(레지스트리와 같다).
   - 위치: 로더는 `config/`에 둔다(`smtp-accounts.ts`). 새 모듈을 만들지 않는다. `callers`는 계정 ID 집합을 받아 참조를 검사하고, `smtp/`는 계정마다 만든 `SmtpSenderConfig`만 받아 바뀌지 않는다. 새 npm 의존성은 없다.
   - 근거: 호출처 레지스트리가 이미 검증한 `secretVar`·`_FILE` 방식을 재사용한다(RQ-028). `default`를 환경 변수로 유지하면 단일 계정 배포는 파일도 비밀 이름도 바꾸지 않는다.

2. **호출처는 레지스트리의 `accountId`로 계정 하나를 지정하고, 작업은 등록 때 `mail_jobs.account_id`로 고정한다. 계정 변경·재라우팅·failover는 없다.**
   - 문제: 호출처와 계정을 잇고, 설정이 바뀌어도 이미 등록한 작업이 검증받은 발신 주소와 다른 계정으로 나가지 않게 해야 한다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 등록 때 계정을 고정하고 이후 읽지 않는다 | 권고 |
     | B. 전송 때 호출처→계정 매핑을 읽는다 | 매핑이 바뀌면 검증한 `From`과 다른 계정으로 나간다. claim과 결과 기록이 다른 차단기 행을 갱신할 수 있다. 재시도 사이에 `Message-ID` 도메인이 바뀐다 |
     | C. 요청이 계정을 고른다 | 호출처가 계정을 알게 되고 발신 주소 정책이 우회된다(결정 6). 채택하지 않는다 |

   - 결정 문구(A):
     - 레지스트리 호출처 항목에 선택 필드 `accountId`를 둔다. 생략하면 `default`다. 계정 ID 형식을 따르고, 구성에 없는 ID면 기동을 거부한다. `default` 계정이 없는데 `accountId`를 생략한 호출처가 있어도 거부한다.
     - `IntakeService`와 파일 채널 `ingest`가 레지스트리에서 호출처의 계정을 찾아 `toRegisterInput`의 입력 `accountId`로 넘기고, `register`의 `INSERT`가 `mail_jobs.account_id`에 쓴다. 두 채널 모두 같은 변환을 쓴다(`envelope/register-input.ts`).
     - 어떤 SQL도 `account_id`를 `UPDATE`하지 않는다. 단위 테스트가 `src/`의 SQL 문자열에서 `account_id =`가 `SET` 절에 오지 않음을 검사한다.
     - 같은 Key의 재전송은 기존 작업의 계정을 그대로 둔다. 지문은 계정을 포함하지 않는다. 계정은 요청 내용이 아니고, 매핑이 바뀐 뒤의 재전송이 409가 되면 안 된다.
     - 계정이 열려 있거나 한도가 남아 있어도 다른 계정으로 보내지 않는다. SMTP 계정 자동 전환은 로드맵 "받지 않는 항목"이다.
     - 계정이 구성에서 빠진 뒤 남은 작업은 점유되지 않고 만료 sweep이 `EXPIRED`로 만든다(`JOB_EXPIRED` 이벤트). 다른 계정으로 옮기지 않는다. 기동 때 구성 밖 계정의 비종결 작업이 있으면 `account_orphan_jobs`(warn, `accountId`, 건수)를 남긴다.
     - Worker가 점유한 작업의 계정 발송기가 없으면 `internal: true`로 끝낸다(차단기를 건드리지 않고 독성 작업 규칙을 따른다, ADR-0007 구현 중 확정 6). `claim`이 구성한 계정만 점유하므로 정상 경로에서는 일어나지 않는다.
   - 배포 순서(마이그레이션은 결정 4):
     1. 마이그레이션 `0010`~`0016`을 적용한다.
     2. 모든 인스턴스를 새 버전으로 바꾼다. 새 버전은 `default`만으로 현행과 같다. 이 단계가 끝나기 전에 비`default` 계정의 작업이 생기면 안 된다. 구버전 `claim`은 `account_id`를 보지 않아 그 작업을 `default` SMTP로 보낸다.
     3. 계정 파일(`MAILO_SMTP_ACCOUNTS_FILE`)과 비밀 변수를 모든 인스턴스에 배포하고 재시작한다. 호출처 레지스트리는 아직 그대로다.
     4. 레지스트리에 `accountId`를 넣고 재시작한다. 모든 인스턴스가 3을 마친 뒤에만 한다. 구버전은 `accountId`를 `ENTRY_FIELDS`에서 거부해 기동하지 못하고, 새 버전도 계정 파일이 없으면 모르는 ID로 기동하지 못한다. 순서는 "코드 먼저, 레지스트리 나중"이다(ADR-0009 결정 10, ADR-0011 결정 10).
     5. 호출처별 전환은 레지스트리 항목 단위로 새 요청에만 적용된다.
   - 롤백 순서:
     1. 레지스트리에서 `accountId`를 빼고 재시작한다. 새 작업은 `default`다.
     2. 비`default` 계정의 비종결 작업이 0이 될 때까지 기다리거나 취소·만료시킨다. 확인 SQL은 `SELECT count(*) FROM mail_jobs WHERE account_id <> 'default' AND status IN ('PENDING','RETRY_WAIT','SENDING')`다.
     3. 구버전은 `account` 범위 정지를 읽지 않는다. 계정 정지에 기대어 롤백하지 않는다(ADR-0011 결정 10과 같은 이유).
     4. 이전 버전으로 바꾸고 레거시 인덱스를 다시 만든다(결정 4의 SQL).
   - 근거: 로드맵 7단계의 고정 근거와 같다. 코드 읽기로 확인한 사실은 `Message-ID` 도메인이 `accountAddress`에서 오고 차단기 키가 `deps.breaker.breakerKey`에서 온다는 것이다.

3. **점유·차단기·정지·할당은 계정 단위로 나누고, `claim`은 계정마다 호출한다. Worker가 슬롯을 계정에 나눈다.**
   - 문제: 계정이 여럿이면 닫힌 계정의 대기 작업을 매 poll 읽고 버리는 비용이 커지고(M2·M3), 한 계정의 장애나 느림이 다른 계정의 슬롯을 차지한다.
   - 선택지(점유 단위):

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 계정마다 `claim`을 호출한다. 계정 조건과 새 인덱스를 쓴다 | 권고. 쿼리 계획이 상수 계정이라 안정적이다(M6). 트랜잭션당 차단기 행이 하나라 잠금 순서가 그대로다. 한 계정의 오류가 다른 계정을 막지 않는다. 비용은 poll당 호출 수가 N배다 |
     | B. 한 트랜잭션에서 `LATERAL`로 계정들을 한꺼번에 점유한다 | 호출 수는 1이다. 매개변수 계정에서 계획이 흔들린다(M7, 114~405ms). 한 트랜잭션이 차단기 행 여럿을 갱신해 교착 방지 규칙이 늘어난다. 채택하지 않는다 |
     | C. 계정마다 별도 poll 루프와 동시성 | 루프 수와 DB 연결이 N배다. 전체 동시성 상한이 계정 수에 곱해진다. 채택하지 않는다 |

   - 결정 문구(A):
     - **가. 점유 호출.** `claim(pool, { accountId, ... })`가 한 계정만 다룬다. 호출은 지금처럼 차단기 행 읽기 → 정지 읽기 → 모드 결정 → (모드가 `none`이면 종료) → 할당 판정 → 작업 쿼리 순서다. 닫혔거나 정지한 계정은 작업 쿼리를 하지 않는다(쿼리 둘). lease 복구는 poll 라운드마다 한 번만 한다(첫 호출 앞). 계정마다 반복하지 않는다. 작업 쿼리에 `account_id = $n` 조건을 더하고 정렬은 지금과 같다(ADR-0009 결정 5).
     - **나. 차단기.** `mail_circuit_breaker`의 키를 계정 ID로 쓴다. 테이블·컬럼·CHECK는 바뀌지 않는다. `default` 행은 `0001`이 넣는다. 다른 계정의 행은 앱이 기동 때 `INSERT ... ON CONFLICT (breaker_key) DO NOTHING`으로 만든다. 실패하면 그 인스턴스의 Worker를 시작하지 않는다(fail-closed). 구성에서 빠진 계정의 행은 지우지 않는다. 임계값·대기 시간·`maxAccountTrips`는 모든 계정이 공유하는 `MAILO_BREAKER_*` 값이다. 계정별 값은 만들지 않는다. `completeAttempt`는 `JOB_COLUMNS`에 `account_id`를 더해 작업 행에서 차단기 키를 정한다(`BreakerConfig.breakerKey`를 호출마다 계정 ID로 바꾼다). 대표 작업(`half_open`)·`last_trip_job_id`·`probe_job_id`는 계정 행마다 독립이다. 한 계정의 대표 작업은 그 계정의 작업만 고른다.
     - **다. 정지.** `readSendControls`가 `account` 범위 행도 읽고 `SendControls`에 `pausedAccountIds`를 더한다. 정지한 계정은 모드가 `none`이다(대표 작업 포함). 정지는 차단기와 독립이다. 정지를 풀어도 차단기 상태는 바뀌지 않는다(ADR-0011 결정 2). Worker는 상태가 바뀔 때 `send_paused`·`send_resumed`를 `scope: "account"`와 `accountId`로 한 번 남긴다.
     - **라. 계정 24시간 할당.** `sendQuota24h`가 있는 계정은 호출처 할당(RQ-032)과 같은 정의로 센다. 사용량은 그 계정의 최근 24시간 "할당에 드는 시도"(`counted`이고 `stage`가 `WORKER`가 아님, `mail_attempts.account_id`)와 `SENDING` 수다. 점유 전에 `pg_try_advisory_xact_lock`을 잡는다. 키 클래스는 호출처와 다른 상수(`ACCOUNT_QUOTA_LOCK_CLASS`)이고 값은 `hashtext(account_id)`다. 못 잡으면 이번 점유를 건너뛴다. 남은 건수가 0 이하면 모드를 `none`으로 하고 호출처 할당 계산을 건너뛴다. 남았으면 점유 건수 상한을 `min(남은 건수, 호출처 할당 남은 건수)`로 줄인다. 계정 전체 한도의 수치는 확인하지 못했다. 운영자가 설정한다. 단위는 메시지 시도 수이고 수신자 수로 가중하지 않는다.
     - **마. 호출처 동시 상한(선택, 구현 묶음 D).** 레지스트리에 선택 필드 `maxConcurrentSends`(1~1000, 생략하면 무제한)를 둔다. 남은 슬롯은 `상한 − 그 호출처의 SENDING 수`(`mail_jobs_sending_caller_idx`)이고 호출처 advisory lock 안에서 계산한다. 호출처 할당과 같은 방식으로 `min`을 취한다. 호출처 락은 할당이나 상한이 있는 호출처에만 잡는다.
     - **바. Worker의 슬롯 배분.**
       - 전체 상한은 `MAILO_WORKER_CONCURRENCY`(C)다. Worker는 계정별 진행 중 건수를 센다.
       - 계정별 상한 `cap_a`는 계정의 `concurrency`다. 생략하면 `max(1, C − (N − 1))`이다(N은 구성한 계정 수). 다른 계정마다 슬롯을 하나 남기는 값이다. N이 C보다 크면 기동을 거부한다(결정 1).
       - poll 라운드마다 계정 순서의 시작점을 무작위로 돌린다. 각 계정에 `limit = min(cap_a − 진행 중, 남은 전체 슬롯)`으로 `claim`을 호출하고 점유한 만큼 남은 슬롯을 줄인다. `limit`이 0이면 호출하지 않는다.
       - 한 계정의 `claim` 오류는 그 계정에서만 지수 백오프하고 다른 계정은 계속한다. 로그 `claim_failed`에 `accountId`를 더한다.
       - 한 라운드에서 하나라도 점유했으면 바로 다음 라운드를 돌고, 모두 비면 `pollMs`를 기다린다(현행과 같은 방식).
       - 상한은 인스턴스별이다. 계정 하나가 쓰는 전체 동시 전송 수는 인스턴스 수 × `cap_a` 이하다. 계정 단위 전역 동시성 상한은 만들지 않는다.
       - 비용: N=1이면 쿼리 수가 현행과 같다. N개이면 poll당 `claim` 트랜잭션이 N개다. 계정 하나당 정상 경로의 쿼리는 차단기 읽기, 정지 읽기, (할당 설정 시 잠금·사용량), 작업 쿼리 순서다.
       - 한계: 다른 계정이 한가해도 `cap_a`를 넘지 못한다. C=4, N=2이면 한 계정은 3슬롯이다. 처리량이 필요하면 `MAILO_WORKER_CONCURRENCY`를 올리거나 `concurrency`를 지정한다.
     - **사. 잠금 순서.** 작업 행 → `mail_circuit_breaker` 행 순서는 그대로다(`claim`과 완료 경로의 교착 방지, ADR-0007 구현 중 확정 11). `claim`과 `completeAttempt`는 트랜잭션당 차단기 행을 하나만 갱신한다. advisory lock은 `try`뿐이라 기다리지 않는다. 정지·할당 테이블은 잠그지 않는다. 새 규칙: 한 트랜잭션이 차단기 행을 둘 이상 갱신하는 경로를 만들지 않는다. 만들어야 하면 `breaker_key` 오름차순으로 갱신한다.
     - **아. 건수 쿼리.** 대기 건수·가장 오래된 시각은 계정마다 상수 계정 쿼리로 읽고 합산한다(M9). `/health/ready`의 `queue.dueCount`는 계정별 값(각각 10000에서 멈춤)의 합이고 `dueCountTruncated`는 어느 한 계정이라도 잘렸는지다. N=1이면 현행과 같다. N>1이면 `dueCount`가 10000을 넘을 수 있다.
   - 근거: 측정 M2~M7. 호출 수 N배의 비용은 계정당 쿼리 2~5개이고 닫힌 계정은 2개다. 작업 쿼리는 0.06ms 안팎이다(M6). N=20이어도 poll당 호출 수십 개 규모이며 DB 시간은 현행 단일 계정 poll의 N배 미만으로 추정한다(운영 크기·다중 인스턴스는 측정하지 않았다).

4. **마이그레이션은 컬럼 두 개와 인덱스 세 개를 더하고 레거시 점유 인덱스 둘을 지운다. 백필은 없다.**
   - 문제: `mail_jobs`는 보존 30일의 큰 테이블이다. 컬럼 추가가 표를 다시 쓰거나 오래 잠그면 안 된다. 구버전이 컬럼 없이 쓰는 행도 받아야 한다.
   - 파일(번호는 `0010`부터, 적용된 파일은 수정하지 않는다):

     | 파일 | 내용 | 잠금·비용 |
     | ---- | ---- | --------- |
     | `0010_job_account_id.sql` | `ALTER TABLE mail_jobs ADD COLUMN account_id text NOT NULL DEFAULT 'default', ADD CONSTRAINT mail_jobs_account_id_format CHECK (account_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$') NOT VALID` | `ACCESS EXCLUSIVE`를 잡지만 1.2ms(150만 행). 표를 다시 쓰지 않는다 |
     | `0011_attempt_account_id.sql` | `mail_attempts`에 같은 방식으로 `account_id`와 `mail_attempts_account_id_format` | 0.56ms(30만 행) |
     | `0012_account_priority_claim_idx.sql` | `-- mailo:no-transaction`. `CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_jobs_account_priority_claim_idx ON mail_jobs (account_id, priority DESC, next_attempt_at, id) WHERE status IN ('PENDING','RETRY_WAIT')` | 쓰기를 막지 않는다. 328ms(150만 행, 동시 쓰기 없음) |
     | `0013_account_claim_idx.sql` | 같은 방식. `mail_jobs_account_claim_idx (account_id, next_attempt_at, id)` 같은 부분 조건 | 292ms |
     | `0014_attempt_account_quota_idx.sql` | 같은 방식. `mail_attempts_account_quota_idx (account_id, finished_at) WHERE counted AND stage IS DISTINCT FROM 'WORKER'` | 170ms |
     | `0015_drop_legacy_priority_claim_idx.sql` | `-- mailo:no-transaction`. `DROP INDEX CONCURRENTLY IF EXISTS mail_jobs_priority_claim_idx` | 문장 하나 |
     | `0016_drop_legacy_claim_idx.sql` | 같은 방식. `DROP INDEX CONCURRENTLY IF EXISTS mail_jobs_claim_idx` | 문장 하나 |

   - 컬럼 규칙:
     - `DEFAULT 'default'`는 영구히 둔다. 구버전 인스턴스의 `INSERT`가 컬럼 없이 써도 `default`가 된다. 새 코드는 항상 `account_id`를 명시해 쓴다. 단위 테스트가 `register`와 시도 기록 `INSERT`의 컬럼 목록을 검사한다.
     - 백필은 없다. 상수 `DEFAULT`는 기존 행을 읽을 때 `default`로 보인다(`relfilenode` 불변 확인). `CHECK ... NOT VALID`는 기존 행을 훑지 않는다. 기존 행이 모두 `default`라 형식을 만족하므로 `VALIDATE CONSTRAINT`가 새로 알려 주는 것이 없다(0003·0004와 같다).
     - `mail_attempts.account_id`는 호출처 할당의 `caller_id`(0002)와 같은 이유로 조인 없이 세기 위한 복사다. 시도 행은 작업 행의 `account_id`를 복사해 쓴다.
     - 구버전은 컬럼을 열거해 읽고 쓰므로 새 컬럼을 무시한다(`SELECT *`가 없음을 코드로 확인했다).
   - 레거시 인덱스를 지우는 이유: 새 인덱스와 함께 두면 계획이 레거시 인덱스를 고른다(M5, 25~31ms 대 0.06ms). 새 인덱스를 확실히 쓰게 하려면 지워야 한다. 지우면 인덱스 수가 현행과 같아져 공존보다 쓰기 비용이 줄어든다(20만 행 삽입 평균: 공존 2.70초, 새 인덱스만 2.51초, 현행 2.18초).
   - 선택지(레거시 삭제 시점):

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 같은 릴리스의 마지막 두 파일(`0015`·`0016`) | 권고. 롤링 중 구버전 점유가 대기 건수에 비례해 느려진다(M8, 25만 건에서 약 110~150ms, 건수가 작으면 무시할 수준). 정확성은 영향받지 않는다. 롤백 때 인덱스를 다시 만들면 된다 |
     | B. 다음 릴리스로 미루고 둘째 계정은 지운 뒤에만 켠다 | 구버전 영향이 없다. 릴리스가 둘이 되고 "둘째 계정을 켜기 전 삭제됐는지" 확인(기동 검사나 운영 절차)이 필요하다 |

   - 위험도와 롤백:

     ```txt
     위험도: 중간 (0010·0011은 ACCESS EXCLUSIVE 대기, 0015·0016은 구버전 점유 성능)
     롤백: 마이그레이션은 되돌리지 않는다. 컬럼과 새 인덱스는 구버전이 무시한다.
           코드를 되돌릴 때 레거시 인덱스를 다시 만든다(아래 SQL). 2026-11-24 측정에서 150만 행 인덱스 생성은 0.3초였다.
     ```

     ```sql
     CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_jobs_claim_idx ON mail_jobs (next_attempt_at, id) WHERE status IN ('PENDING','RETRY_WAIT');
     CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_jobs_priority_claim_idx ON mail_jobs (priority DESC, next_attempt_at, id) WHERE status IN ('PENDING','RETRY_WAIT');
     ```

   - 잠금 대기: `ADD COLUMN`은 `mail_jobs`에 `ACCESS EXCLUSIVE`를 잡는다. 오래 도는 트랜잭션이 있으면 요청이 기다리고 뒤의 앱 쿼리도 줄을 선다. 이 위험은 ADR-0011 결정 10과 같고 `lock_timeout`(마이그레이션 기본 10초)이 한계다. 테이블마다 파일을 나눠 대기가 겹치지 않게 한다. 동시 세션에서 확인하지 않았다.
   - 다른 스키마 변경은 없다. `mail_circuit_breaker`는 키를 계정 ID로 쓸 뿐이다. `mail_send_controls`와 `mail_ops_audit`의 CHECK는 이미 `account`를 허용한다(`0008`). 감사의 `action`도 `PAUSE`·`RESUME`으로 충분해 CHECK 변경 마이그레이션이 없다. 수동 차단기 초기화 같은 새 동작이 필요해지면 그때 새 결정으로 `action` CHECK를 바꾼다.
   - 구버전이 `account_id` 없이 쓰는 경우: 결정 2의 순서를 지키면 비`default` 작업이 없는 구간에서만 구버전이 돈다. 구버전이 쓴 행은 `default`다.

5. **관측은 `/metrics`에 계정 ID를 라벨로 켜고, `/health/ready`의 공개 응답에는 계정을 드러내지 않으며, 운영자 표면(`/ops`·CLI)에 계정 조회와 정지를 더한다.**
   - `/metrics`:
     - `account_id` 값은 구성한 계정 ID와 `unregistered`(구성 밖 계정의 작업이 만료 sweep으로 종결되는 경우)다. 라벨 값은 닫힌 집합이다.
     - `createMetrics({ accountIds })`와 수집기의 상수 `DEFAULT_ACCOUNT_ID`를 구성한 계정 목록으로 바꾼다. 지표 이름과 라벨 이름은 바뀌지 않는다(ADR-0012 구현 중 확정 13).
     - `seed`는 `caller_id`와 `account_id`의 곱집합이 아니라 레지스트리의 (호출처, 그 호출처의 계정) 쌍으로 만든다. 곱집합이면 호출처 50개와 계정 20개에서 `mailo_attempts_total`이 5000시리즈가 되어 상한 2000에 닿아 시드가 잘린다. 쌍으로 만들면 호출처당 5시리즈다.
     - 새 지표다. 모두 전역 gauge 규칙(`max`로 합친다)을 따른다.

       | 이름 | 라벨 | 값 |
       | ---- | ---- | -- |
       | `mailo_account_paused` | `account_id` | 구성한 계정별 정지 0/1 |
       | `mailo_account_quota_limit` | `account_id` | `sendQuota24h`. 설정한 계정만 |
       | `mailo_account_quota_used` | `account_id` | 사용량. 한도를 넘을 수 있다(`mailo_caller_quota_used`와 같은 정의) |
       | `mailo_send_paused_accounts` | 없음 | 계정 정지 개수. 구성 밖 계정의 정지도 센다 |

       인스턴스 gauge `mailo_worker_in_flight`(`account_id`)를 더한다. 계정마다 진행 중 전송 수다.
     - 시리즈 수는 계정마다 고정분이 약 18개다(큐 건수 3, 잘림 2, 가장 오래된 나이 4, 차단기 상태 3, 사유 1, 할당 2, 정지 1, lease 회수 1, 진행 중 1). N=20이면 약 360개다. 호출처별 시리즈는 계정 수와 무관하다. `mailo_attempt_errors_total{account_id,result,stage,reason}`은 이론상 계정당 최대 224개라 N=20이면 상한 2000을 넘을 수 있다. 실제 조합은 이보다 훨씬 적다고 추정한다(측정하지 않았다). 넘으면 기존 `metrics_series_limit` 경고가 알린다.
     - 큐 지표는 계정별 쿼리 합이다(결정 3 아). 스크레이프당 쿼리는 계정당 1(상태별 건수)+4(등급별) 안팎이다. TTL 캐시와 단일 비행(ADR-0012 결정 5)은 그대로다.
   - `/health/ready`:
     - 인증 없음: `circuitBreaker.state`는 모든 계정 중 가장 나쁜 상태(`open` > `half_open` > `closed`)다. 계정 수와 ID는 없다. 현행도 전역 차단기 상태를 공개한다.
     - 호출처 키: `circuitBreaker`는 그 호출처 계정의 `state`·`openUntil`·`lastReason`이다. 필드 모양은 같다. 계정 ID는 없다. 호출처가 자기 메일이 막혔는지 알 수 있다.
     - 운영자 토큰: `circuitBreaker`는 가장 나쁜 상태이고 계정별 상태는 `GET /ops/accounts`가 낸다. `sendControls`에 `pausedAccountCount`를 더한다. `queue`는 결정 3 아의 합이다.
     - 호출처 키 `sendPaused.scope`에 값 `account`를 더한다. 그 호출처의 계정이 정지일 때만이고 `all`이 우선, 다음 `account`, 다음 `caller`다. ADR-0011 결정 2의 요약 규칙을 따른다.
     - 200/503에 계정 상태·정지를 반영하지 않는다(RQ-031).
   - `/ops`와 CLI:
     - `GET /ops/accounts`(읽기 토큰). `{ accounts: [{ accountId, breaker: { state, openUntil, lastReason }, paused, sendQuota24h: { limit, used } | null, queue: { dueCount, dueCountTruncated, oldestDueAgeSeconds } }] }`다. host·user·`from`은 담지 않는다. `lastReason`은 헬스와 같은 어휘다.
     - `PUT`·`DELETE /ops/pauses/accounts/{accountId}`(관리 토큰). 응답은 호출처 정지와 같은 모양이고 `inRegistry` 대신 `inConfig`를 쓴다. ID 형식이 틀리면 400(`parameter: accountId`, `INVALID_FORMAT`)이다. 구성에 없는 ID도 받는다(구성에서 뺀 계정의 정지 행을 정리할 수 있게 한다).
     - `GET /ops/pauses`는 `{ type: "account", id }` 항목을 더한다.
     - 감사는 기존 `PAUSE`·`RESUME`에 `scope_type: "account"`로 쓴다. 로그 `ops_pause_set`·`ops_pause_cleared`는 `scope: "account"`와 `accountId`를 더한다.
     - `GET /ops/jobs/{jobId}`의 `OpsJob`에 `accountId`를 더한다. 호출처 `Job`에는 더하지 않는다(결정 6).
     - CLI: `accounts list`(읽기), `pause --account <id>`·`resume --account <id>`(`--yes` 필요, 기존 변경 명령과 같다). `queue stats`는 서버 응답 그대로다.
   - 문서·계약 갱신(구현 때, 같은 변경에서): `docs/api/openapi.yaml`(`ReadyResponse`·`sendPaused.scope`·`OpsJob`·`/ops/accounts`·`/ops/pauses/accounts/{accountId}`), `docs/operations/deployment.md`(환경 변수·롤링 순서·헬스·지표), `key-management.md`, `caller-onboarding.md`, `troubleshooting.md`, `.env.example`, `docker-compose.yml`(계정 파일 읽기 전용 마운트), `AGENTS.md`(모듈 설명).
   - 키 로테이션(`key-management.md`에 쓸 내용): 계정 SMTP 비밀번호는 계정마다 `MAILO_SMTP_SECRET_*` 변수다.
     1. 계정에서 새 앱 비밀번호를 만든다. 이전 값은 아직 유효하게 둔다. Google 계정이 앱 비밀번호를 여럿 허용하는지는 확인하지 않았다.
     2. 시크릿 파일을 새 값으로 바꾼다.
     3. 인스턴스를 롤링 재시작한다. 재시작 중 인스턴스마다 이전·새 값이 섞이지만 둘 다 유효하다.
     4. 모든 인스턴스가 바뀐 뒤 이전 앱 비밀번호를 폐기한다.
     잘못된 값은 그 계정만 `AUTH`로 차단기를 연다. 다른 계정은 계속 발송한다. 계정 ID를 바꾸려면 새 계정을 만들고 호출처를 옮긴다. 새 차단기 행과 새 지표 시리즈가 생긴다.

6. **SMTP 비밀·주소는 계정 설정 안에 머물고, 호출처는 계정 ID를 알지도 고르지도 못한다. 발신 주소 허용 집합의 기본 주소는 호출처 계정의 `from`이다.**
   - 비밀·주소 노출 경로:

     | 경로 | 규칙 |
     | ---- | ---- |
     | 계정 파일 | 비밀번호 값 없음. 변수 이름만 둔다. `user`·`from` 주소는 있다(현행 `MAILO_SMTP_USER`와 같은 민감도). 파일은 읽기 전용으로 마운트한다 |
     | 설정 객체·로그 | 비밀번호는 `Secret`으로 감싼다. 로그와 오류에는 계정 ID, 위치, 고정 사유 코드만 쓴다. host·user·`from`은 쓰지 않는다 |
     | 기동 오류 | `ConfigError`처럼 변수 이름과 위치만 담는다 |
     | `/metrics` | `account_id`(불투명 ID)뿐이다. host·user·`from`은 라벨 값에도 HELP에도 없다 |
     | `/health/ready` | 인증 없음은 계정 수·ID가 없다. 호출처 키는 자기 계정의 상태 필드뿐이다. 운영자 응답에는 계정 ID가 없고 `GET /ops/accounts`가 낸다 |
     | `/ops/*`·CLI·감사 | 계정 ID, 상태, 건수. host·user·`from`은 없다 |
     | 호출처 응답(`Job`·`Event`·`INTAKE_REJECTED`·검증 오류) | 계정 필드가 없다. 오류 본문에 주소를 넣지 않는 규칙이 그대로다(RQ-027) |
     | SMTP 응답 텍스트 | 기존 마스킹(ADR-0007 구현 중 확정 5)을 계정 구분 없이 적용한다. 응답이 계정 주소를 담으면 이메일 형태 마스킹이 가린다 |
     | `Message-ID` | 작업 계정 `from`의 도메인이다. 수신자가 받는 메일 헤더에 있고 현행과 같은 노출이다 |

   - 호출처는 계정을 고르지 못한다. 요청 스키마에는 계정 필드가 없고 모르는 필드는 `UNKNOWN_FIELD`로 거부된다. 계정은 레지스트리(운영자 파일)에서만 정해진다. 호출처가 자기 계정의 차단기 상태를 `/health/ready`로 볼 수 있지만 계정 ID는 모른다.
   - 발신 주소 허용 규칙: 호출처의 허용 집합은 `{호출처 계정의 from} ∪ 호출처의 allowedFrom`이다. `from`을 생략한 요청은 계정의 `from`으로 채워진다.
     - `allowedFrom`은 호출처 단위로 둔다(ADR-0008 구현 중 확정 12 그대로). 선택지는 계정 단위 `sendAs` 목록이다. Gmail에서 `allowedFrom` 주소가 send-as 별칭이어야 `From`이 유지되는지 확인하지 못했다(미결정 항목). 확인 전에 계정에 목록을 두면 기동 검증이 근거 없는 규칙이 된다. 보류한다.
     - `validation/`의 `isSenderAllowed`·`checkRequestPolicy`는 바꾸지 않는다. 입력 `defaultFrom`을 `IntakeService`·파일 채널 `ingest`가 호출처 계정의 `from`으로 넘기고, Worker가 `envelope.from ?? 작업 계정의 from`으로 채운다.
     - 기동 때 호출처 `allowedFrom`이 다른 계정의 `from`과 같은 주소를 담으면 `allowed_from_other_account`(warn, `callerId`)를 남긴다. 거부하지 않는다. 별칭을 계정이 공유할 수 있다.
     - 이미 등록된 Key는 정책 변경 뒤에도 기존 작업(200)이나 409를 그대로 돌려준다(ADR-0011 구현 중 확정 27). 호출처의 계정을 바꾼 뒤에도 같다.
   - 근거: 호출처에게 계정 ID를 숨기면 계정 구성이 호출처 사이로 새지 않는다. 계정 단위 허용 목록은 Gmail 동작을 확인한 뒤 새 결정으로 더할 수 있다.

## 구현 순서

이 ADR이 승인된 뒤의 순서다. 작업 방식은 `AGENTS.md`의 "작업 실행"을 따른다. 마이그레이션·큐 SQL·잠금 순서·시크릿 노출 경로를 바꾸므로 직접 작업이 아니다. 탐색 결과에 따라 DELTA가 늘 수 있는 로드맵 단계라 `rubber-workflow`를 권고한다. DELTA는 5개 이상으로 예상되어 LEG 3개(A, B, C+D)로 묶는다.

| 묶음 | 내용 | 독립 리뷰 지점 |
| ---- | ---- | -------------- |
| A. 계정 모델(동작 변화 없음) | 계정 로더·기동 검증(결정 1), 레지스트리 `accountId`(결정 2), `0010`·`0011`, `register`·시도 기록이 `account_id`를 씀, `ClaimedJob.accountId`, `completeAttempt`가 작업 행의 계정으로 차단기 키를 정함, 기동 때 차단기 행 생성, 발신 주소 허용 집합을 계정 `from` 기준으로 변경, 계정별 발송기 조립(점유는 `default`만) | 스키마와 구버전 `INSERT` 호환, 설정 거부 사례, 시크릿 노출 경로(canary), 지문·멱등 불변 |
| B. 계정 단위 점유 | `0012`~`0016`, `claim(accountId)`, Worker 슬롯 배분, 계정 정지(점유 판정), 계정 24시간 할당, 건수 쿼리의 계정별 합, 로그 | 잠금 순서, SQL과 `EXPLAIN`, 다중 인스턴스 경합, 한 계정 장애 때 다른 계정 처리, 레거시 인덱스 삭제 영향 |
| C. 운영 표면 | `/metrics` 라벨·시드·새 지표, `/health/ready` 변경, `GET /ops/accounts`, 계정 정지 REST·CLI, `OpsJob.accountId`, 문서·`openapi.yaml`·`.env.example`·compose | 계약 변경(`additionalProperties: false`), 시리즈 수, 인증 행렬 |
| D. 호출처 동시 상한(선택) | `maxConcurrentSends`(결정 3 마) | 호출처 락과 계정 락의 `try` 순서, 상한 계산 경계 |

- 순서는 A → B → C → D다. B가 끝나기 전에는 둘째 계정을 켜지 않는다. 둘째 계정은 레거시 인덱스 삭제(`0015`·`0016`) 뒤에만 켠다.
- 새 RQ는 A 착수 전에 정한다. 수용 조건은 구현 중 확정에서 갱신한다.

## 검증 계획

구현 때 다음을 확인한다. 이 ADR은 아무것도 실행하지 않았다(상태 절의 측정 제외).

- 단위: 계정 로더 거부 사례(ID 형식·중복·예약어, `secretVar` 형식과 `_FILE`, `default` 출처 4상태, 같은 `(host, port, user)`, N>20, N>C, 모르는 `accountId`), 레지스트리 `accountId`, 슬롯 배분(순수 함수로 분리해 라운드 순서·`cap_a`·남은 슬롯), `account_id`를 `SET`하는 SQL이 없음, `INSERT` 컬럼 목록.
- PostgreSQL 통합:
  - 계정 차단기 격리: A가 `open`이어도 B는 점유한다. A의 `half_open` 대표 작업은 A의 작업만 고른다. 내부 오류 대표 작업은 A를 닫지 않는다(`internal: true`).
  - 계정 정지: 정지한 계정만 점유가 멈춘다. 호출처 정지·전체 정지와 합쳐진다.
  - 계정 24시간 할당: 인스턴스 12개 동시 점유에서 초과 0건(`test/queue/caller-quota.integration-spec.ts`와 같은 방식). 호출처 할당과 겹칠 때 `min`.
  - 한 계정 SMTP가 응답하지 않는 동안 다른 계정이 계속 발송한다(가짜 SMTP 둘, 한쪽 무응답). `cap_a`가 슬롯을 남기는지.
  - 구성 밖 계정의 작업이 점유되지 않고 `EXPIRED`가 된다. `account_orphan_jobs` 로그.
  - 마이그레이션: 컬럼·기본값·`NOT VALID` 제약·인덱스 존재(`test/db/job-constraints.integration-spec.ts` 방식), 컬럼 없이 쓴 `INSERT`가 `default`가 됨.
  - 계정마다 호출 수: N=1에서 `claim`의 쿼리 수가 현행과 같다(쿼리 수 단언).
- e2e: 가짜 SMTP 둘에서 계정별 인증, `MAIL FROM`, `Message-ID` 도메인이 작업 계정 것인지. 호출처 `Job`·`Event` 응답에 계정 필드가 없다(키 목록 단언).
- 시크릿: 계정 비밀번호·`user`·`host`에 canary를 넣고 로그, `/metrics`, `/health/ready`(인증 없음·호출처 키·읽기 토큰·관리 토큰), `/ops/*`, 오류 응답, 감사에서 검색한다(RQ-027).
- 지표: 호출처 50개 × 계정 20개에서 `seed` 시리즈가 지표별 상한 안이다. `/metrics`의 `account_id` 값이 구성 집합과 `unregistered`뿐이다.
- 수동(스크립트): 큰 데이터의 `EXPLAIN`. 이 ADR의 측정 SQL을 `apps/mailo/scripts/` 아래에 둘지 구현 때 정한다. 계획이 새 인덱스를 쓰는지는 데이터가 작으면 자동 테스트로 고정하지 못한다. 컨테이너: 읽기 전용 루트에서 계정 파일 마운트와 `_FILE` 비밀 읽기.

## 검토한 대안

| 결정 | 대안 | 채택하지 않은 이유 |
| ---- | ---- | ------------------ |
| 1 | 계정마다 `MAILO_SMTP_<ID>_*` 환경 변수 | 변수 수가 계정에 곱해지고 형식이 레지스트리와 다르다 |
| 1 | `MAILO_SMTP_*`를 없애고 파일만 | 단일 계정 배포의 업그레이드가 설정 전체 이전을 요구한다 |
| 1 | 계정 ID에 SMTP 사용자 주소를 허용 | 로그·지표·감사에 주소가 들어간다(RQ-027) |
| 2 | 전송 때 호출처→계정 매핑을 읽는다 | 매핑 변경이 검증한 `From`과 다른 계정으로 나가게 하고 차단기 행이 어긋난다 |
| 2 | 요청이 계정을 고른다 | 계정 구성이 호출처에 노출되고 발신 주소 정책이 우회된다 |
| 2 | 계정 장애 때 다른 계정으로 전환(failover) | 발송 한도 우회이고 발신 주소 인증 문제가 생긴다. 로드맵 "받지 않는 항목"이다 |
| 2 | 구성에서 빠진 계정의 작업을 `default`로 옮김 | 검증한 `From`과 다른 계정으로 나간다 |
| 3 | 한 트랜잭션 `LATERAL` 다계정 점유 | 매개변수 계정에서 계획이 흔들렸다(M7, 114~405ms). 차단기 행 여럿 갱신으로 교착 규칙이 늘어난다 |
| 3 | 계정마다 Worker 루프와 동시성 | 전체 동시성과 DB 연결이 계정 수에 곱해진다 |
| 3 | 계정 조건만 더하고 기존 인덱스 유지(M4) | 닫힌 계정의 대기 10만 건을 매 poll 읽고 버린다(20~54ms) |
| 3 | 새 인덱스를 더하고 레거시 유지(M5) | 계획이 레거시 인덱스를 고른다(25~31ms) |
| 3 | 슬롯 배분 없이 공유 풀과 라운드 로빈만 | 한 계정이 전송 대기(SMTP 무응답)로 모든 슬롯을 쥐면 다른 계정이 마감(lease·전송 마감)까지 기다린다 |
| 3 | 초·분 단위 토큰 버킷 | 한도 수치를 확인하지 못했다. 로드맵이 만들지 않기로 했다 |
| 3 | 계정별 차단기 임계값·대기 시간 | 값의 근거가 없다(모두 추정). 계정 공통 값으로 시작한다 |
| 4 | 새 컬럼에 `DEFAULT` 없이 백필 | 150만 행 이상의 갱신과 잠금이 필요하다. 상수 `DEFAULT`는 표를 다시 쓰지 않는다 |
| 4 | `mail_circuit_breaker`에 `account_id` 컬럼을 더함 | `breaker_key`가 이미 키다. 스키마 변경이 필요 없다 |
| 5 | 공개 `/health/ready`에 계정 목록 | 계정 구성이 노출된다. 로드맵이 금지했다 |
| 5 | 감사 `action`에 계정 전용 동작 | `PAUSE`·`RESUME`에 `scope_type: "account"`로 충분하다. CHECK 변경이 필요 없다 |
| 6 | 계정 단위 `sendAs`(허용 발신 주소 목록) | Gmail의 send-as 동작을 확인하지 못했다 |
| 6 | `allowedFrom`을 계정으로 이동 | 호출처마다 허용 주소가 다른 지금의 규칙(ADR-0008 구현 중 확정 12)이 깨진다 |

## 결과

- 호출처는 레지스트리의 `accountId`로 SMTP 계정 하나를 쓴다. 작업은 등록 때 계정을 고정하고 변경되지 않는다. 계정 전환은 새 요청에만 적용된다.
- 계정마다 차단기·정지·24시간 할당이 독립이다. 한 계정이 닫혀도 다른 계정은 계속 발송한다. 닫힌 계정의 대기 작업을 매 poll 읽지 않는다(M2·M6).
- 한 계정의 SMTP 무응답이 모든 슬롯을 쥐지 못한다. 대가는 계정 하나가 쓰는 슬롯의 상한이다.
- 계정 수에 비례해 poll당 `claim` 트랜잭션이 늘어난다. N=1이면 현행과 같다.
- 마이그레이션 파일이 7개(`0010`~`0016`) 늘고 `mail_jobs`·`mail_attempts` 컬럼이 하나씩 늘며, 점유 인덱스 둘이 계정 단위 인덱스 둘로 바뀐다. 새 npm 의존성과 새 상시 서비스는 없다(RQ-029).
- 계약이 바뀐다: `ReadyResponse`(`sendControls.pausedAccountCount`, `sendPaused.scope`의 값 `account`, 호출처 키의 `circuitBreaker` 의미), `OpsJob.accountId`, `queue.dueCount` 합산 의미(N>1), 새 `/ops` endpoint 둘, 새 지표.
- 계정 구성에서 빠진 계정의 작업은 재라우팅되지 않고 만료된다.
- 롤링 배포에서 구버전이 도는 동안 비`default` 작업이 없어야 한다. 순서를 어기면 그 작업이 `default` 계정의 SMTP로 나간다.
- 이 ADR의 비용과 동작은 구현하지 않았다. 측정은 로컬 단일 실행이다.

## 미결정·확인하지 않은 것

### 승인된 결정(2026-11-24)

열린 질문이던 11건이다. 사용자가 권고대로 승인했다. 결정 본문과 같은 값이다.

1. `default` 계정의 출처는 환경 변수 또는 파일 중 하나이고 둘 다면 기동을 거부한다. 환경 변수 `default`는 계정 한도·`concurrency`를 받지 않는다(결정 1).
2. 계정 ID 형식은 소문자 1~32자이고 `unregistered`는 예약어다. 계정 수 상한은 20(추정)이다(결정 1).
3. 점유 단위는 계정별 `claim` 호출이다. `LATERAL` 한 트랜잭션은 채택하지 않는다. poll당 호출이 N배가 된다(결정 3).
4. 슬롯 배분은 인스턴스별 상한이다. 기본 `cap_a = max(1, C − (N − 1))`이고 N > C이면 기동을 거부한다(결정 3 바).
5. 레거시 점유 인덱스 삭제는 같은 릴리스의 마지막 마이그레이션(`0015`·`0016`)에 둔다. 다음 릴리스로 미루고 둘째 계정을 삭제 뒤에만 켜는 대안은 채택하지 않는다(결정 4).
6. 계정 24시간 할당은 이 ADR에 포함한다. 호출처 동시 상한 `maxConcurrentSends`는 구현 묶음 D로 분리한 선택 항목이다(결정 3 라·마).
7. 계약 변경을 받는다. 공개 `circuitBreaker.state`는 가장 나쁜 상태이고 호출처 키에서는 자기 계정 상태다. `sendPaused.scope`에 `account`를 더한다. `queue.dueCount`는 합산이다. `OpsJob.accountId`를 더한다(결정 5).
8. 새 운영자 표면을 만든다. `GET /ops/accounts`, `PUT`·`DELETE /ops/pauses/accounts/{accountId}`, CLI 명령이다(결정 5).
9. 구성에서 빠진 계정의 작업은 재라우팅 없이 만료시킨다(결정 2).
10. `allowedFrom`은 호출처 단위로 두고 계정 `sendAs`는 보류한다(결정 6).
11. 차단기 임계값은 모든 계정이 공유한다(결정 3 나).

### 확인하지 않은 것

- 실제 Gmail·Workspace 다중 계정: 계정별 한도 수치와 수신자 수 가중 여부, 앱 비밀번호 복수 발급, 같은 IP에서의 동시 연결 한도, send-as 별칭에서 `From`이 유지되는지(로드맵의 선행 확인 항목)를 확인하지 않았다.
- 운영 크기(수백만 행)와 다중 인스턴스(4개 이상)에서의 poll 비용 합계와 풀 점유. 측정은 150만 행 단일 실행이다. N개 계정의 `claim` 호출 합계는 계정 하나의 쿼리 시간에 N을 곱해 추정한 값이고 실행하지 않았다.
- 계획 안정성: 통계가 바뀌거나 autovacuum이 늦을 때 계획이 `mail_jobs_expiry_idx`(M7·M10에서 보인 대안)를 고르지 않는지. 측정한 계획은 `VACUUM ANALYZE` 직후다.
- `CREATE INDEX CONCURRENTLY`와 `DROP INDEX CONCURRENTLY`가 동시 쓰기 부하에서 걸리는 시간, `ADD COLUMN`의 `ACCESS EXCLUSIVE` 대기(잠금 수준과 시간만 봤다).
- 레거시 인덱스를 지운 뒤 구버전 점유 성능은 한 쿼리(M8) 측정이다. 롤링 배포와 롤백을 실행하지 않았다.
- 슬롯 기본식, 계정 수 상한 20, 새 지표의 시리즈 수는 설계 값이거나 계산한 값이다. 실제 조합 수는 확인하지 않았다.
- 새 인덱스 쓰기 비용은 20만 행 `INSERT` 3회 평균 한 번의 측정이다. 갱신(상태 전이)의 비용은 재지 않았다.
- `ACCOUNT_QUOTA_LOCK_CLASS`의 값은 구현 때 정한다. 마이그레이터와 호출처 할당의 advisory lock 키 공간과 겹치지 않아야 한다.
- 호출처가 `/health/ready`의 `circuitBreaker`·`sendPaused.scope` 의미 변경과 새 값 `account`를 어떻게 처리하는지 확인하지 않았다. 저장소 안 Java 샘플도 확인하지 않았다.
- `docs/agents/rubber-workflow.md` 등 작업 방식 문서는 이 ADR을 쓴 `dev` 기준 작업 트리에 없다. 구현 착수 때 해당 문서의 기준을 다시 확인한다.

## 구현 중 확정

### 2026-11-24 묶음 A

결정 문구는 바꾸지 않는다. 구현하면서 정한 값과 결정의 해석을 적는다.

1. **묶음 A의 점유 범위.** 구현 순서 표는 "점유는 `default`만"이라 적었다. 구현은 한 번의 `claim`이 구성한 모든 계정의 작업을 점유하게 했다(`ClaimOptions.accountIds`). 작업이 자기 계정의 SMTP로 나가는 것을 둘째 계정의 정지·한도 없이 검증하려는 선택이다.
   - 모드(closed·open·half_open)는 `deps.breaker.breakerKey`(`default`) 차단기 행 하나가 정한다. half_open 대표 작업은 차단기 계정의 작업(`j.account_id = b.breaker_key`)만 고른다. 다른 계정의 작업이 `default` 차단기를 닫거나 열지 못하게 한다.
   - 한계: `default`가 아닌 계정의 차단기는 완료 경로가 갱신하지만 점유를 막지 못한다. 계정별 정지·할당·슬롯 상한도 없다. 한 계정의 장애가 다른 계정의 슬롯을 쥘 수 있다. 그래서 둘째 계정은 묶음 B 뒤에만 켠다. (이 경고와 운영 규칙은 아래 "리뷰 반영"의 기동 거부로 바뀌었다.)
   - `default` 계정이 없는 구성(파일에만 계정이 있음)에서는 `default` 차단기 행이 닫힌 채로 남아 모드가 항상 normal이다.
   - 묶음 B가 `claim(accountId)`로 바꾸면 `accountIds` 옵션과 이 한계가 사라진다.
2. **한도 필드.** `sendQuota24h`·`concurrency`는 묶음 A에서 범위를 검증만 한다. 값을 쓰지 않는다는 사실을 기동 때 `account_limits_not_enforced`(warn, `accountId`)로 알린다. 한도를 설정했는데 조용히 무시하는 일을 막으려는 것이다. 거부하지 않은 이유는 묶음 B 전후로 파일 형식이 같아야 해서다.
3. **`(host, port, user)` 중복 검사.** 인증 계정만 검사한다. 인증 없는 릴레이는 `user`가 없어 같은 릴레이에 `from`만 다른 계정을 둘 수 있다. 환경 변수로 정의한 `default`도 비교 대상이다. 비교는 대소문자를 무시한다.
4. **설정 객체.** `AppConfig.smtp`(`SmtpConfig`)를 `AppConfig.smtpAccounts`(`SmtpAccount[]`)로 바꿨다. 계정의 기본 발신 주소 필드 이름은 `from`이다(이전 `defaultFrom`). 환경 변수 계정은 목록 맨 앞의 `id: "default"`다. 계정 목록은 비어 있지 않다. 계정 파일은 `loadConfig` 안에서 동기로 읽는다.
5. **`MAILO_SMTP_TIMEOUT_SECONDS`.** `default` 출처가 파일일 때도 `MAILO_SMTP_*` 잔여 변수 검사에서 뺐다. 계정 파일에서 `timeoutSeconds`를 생략한 계정의 기본값이기 때문이다.
6. **계정 비밀번호 읽기 실패.** 호출처 JWS 키와 같은 규칙이다. `<변수>_FILE`이 있으면 파일을 읽지 못해도 `<변수>`로 돌아가지 않고 errno 코드만 담아 거부한다.
7. **차단기 행 생성 위치.** `createWorkerRunner`가 돌려주는 `start()`가 `ensureBreakerRows`(`INSERT ... ON CONFLICT DO NOTHING`, 계정 ID 오름차순)를 하고, 실패하면 Worker를 시작하지 않으며 앱 기동도 실패한다. Worker를 켜지 않은 앱(테스트 기본값)은 행을 만들지 않는다. `completeAttempt`는 작업 행의 `account_id`로 차단기 키를 정하고(`BreakerConfig.breakerKey`를 작업마다 덮어쓴다) 행이 없으면 `getBreakerState`·`recordAccountFailure`가 던진다.
8. **구성 밖 계정 작업의 기동 점검.** `countOrphanAccountJobs`가 `PENDING`·`RETRY_WAIT`·`SENDING` 중 구성 밖 계정의 건수를 계정별로 센다. 계정 인덱스가 없어(묶음 B의 `0012`) 대기 건수에 비례한다. 기동 한 번뿐이다. 쿼리가 실패하면 기동을 막지 않고 `account_orphan_check_failed`(warn, `error` 이름)를 남긴다.
9. **지표.** 묶음 A는 지표를 바꾸지 않는다. `account_id` 라벨 값은 상수 `default`이므로 `default`가 아닌 계정의 작업도 `default`로 센다. 묶음 C가 `createMetrics({ accountIds })`로 바꿀 때까지의 한계다.
10. **Worker 조립.** `WorkerDeps`는 `accounts`(계정 ID → `{ sender, from }`)를 받는다. 기존 단일 계정 형태(`sender`+`defaultFrom`)는 `default` 계정 하나로 계속 받는다. 둘을 함께 주면 던진다. `toSenderConfig(config, trustedCa, accountId = "default")`가 계정별 발송기 설정을 만든다. 주입한 `sender`는 모든 계정에 쓰인다(테스트용).
11. **로그 이벤트.** 새 이벤트는 `account_unused`(info), `allowed_from_other_account`·`account_limits_not_enforced`·`account_orphan_jobs`·`account_orphan_check_failed`(warn)이다. `smtp_plaintext_enabled`에 `accountId` 필드가 붙는다. 모두 계정 ID·호출처 ID·건수만 싣는다.
12. **마이그레이션.** 구현 순서 표의 대응대로 `0010`·`0011`이 묶음 A다. 두 파일 모두 트랜잭션 실행이다. `mail_attempts.account_id`는 묶음 B의 24시간 할당이 쓰지만 시도 기록이 묶음 A부터 값을 복사해 쓰도록 같이 넣었다.
13. **검증하지 않은 것(묶음 A).** 읽기 전용 루트 컨테이너의 계정 파일 마운트와 `_FILE` 비밀 읽기, 롤링 배포·롤백, 동시 쓰기 부하의 `ACCESS EXCLUSIVE` 대기, 실제 Gmail·Workspace 계정 둘, 계정 발송기가 없는 점유 작업의 `internal` 종료(`claim`이 구성 계정만 점유해 자동 시험으로 만들 수 없다). 검증 계획의 "N=1에서 `claim`의 쿼리 수가 현행과 같다" 단언은 `claim`이 계정별로 나뉘는 묶음 B에서 한다.

### 2026-11-24 묶음 A 리뷰 반영

결정 문구는 바꾸지 않는다. 위 "묶음 A" 항목 1·11을 이 절이 정리한다.

1. **비default 계정의 기동 거부.** 앱(`createApp`, `main.ts` 경로)은 구성에 `default`가 아닌 계정이 있으면 `ConfigError`로 기동을 거부한다. 메시지에는 계정 ID만 싣는다. 묶음 B 전까지만 유지하고 B에서 거부와 `allowNonDefaultAccounts` 옵션을 함께 지운다.
   - 이유: 묶음 A의 한 번의 `claim`은 차단기 모드를 `default` 행 하나로 정한다. 비`default` 계정의 차단기는 `open`에서 닫히지 않는다. 계정 상태 오류의 재시도 시각(`resume = openUntil`)이 과거로 `next_attempt_at`에 기록되면 같은 작업을 즉시 다시 점유해 SMTP를 연속으로 부를 수 있다.
   - 계정 파일 로더와 호출처 `accountId` 검증은 바꾸지 않는다. 로더는 비`default` 계정을 파싱·검증하고, `claim({ accountIds })`를 직접 지정하는 통합·e2e 테스트와 `account-report`의 점검 로그는 그대로 동작한다. 기동 거부만 앱 경계에 있다. `default`만 구성(환경 변수 또는 파일)한 배포는 기존대로 기동한다.
   - 테스트 전용 옵션 `AppModuleOptions.allowNonDefaultAccounts`(기본 거부)로 e2e가 거부를 우회한다. `main.ts`가 이 옵션을 쓰지 않는다는 점은 정적 검사로 고정했다.
2. **구현 순서 표와의 정리.** 표의 "계정별 발송기 조립(점유는 `default`만)"과 항목 1 첫 문단("한 번의 `claim`이 모든 계정을 점유")은 어긋나 보였다. 앱 경로에서는 위 거부 때문에 구성에 `default`만 남으므로 사실상 표와 같다. 항목 1이 말한 모든 계정의 점유는 `claim({ accountIds })`를 직접 지정하는 테스트에서만 일어난다.
3. **경고 정리.** `accounts_not_isolated`는 계정이 둘 이상일 때만 나오므로 앱 경로에서 도달할 수 없어 제거했다. `account_limits_not_enforced`는 `default`를 파일로 정의하고 `sendQuota24h`·`concurrency`를 줄 수 있어 도달 가능하므로 유지한다. 둘 다 로더 단위 테스트와 무관한 로그다(로더는 값을 검증만 한다).
4. **`(host, port, user)` 비교.** `auth.user`의 앞뒤 공백을 지우고 비교한다(공백만 다른 user는 같은 메일박스로 거부).
5. **`smtp_plaintext_enabled`.** `message` 문구는 묶음 A 이전과 같다. 계정 구분은 `accountId` 필드가 한다.
6. **같은 `from`.** 서로 다른 계정이 같은 `from`을 가져도 코드는 막지 않는다. 그 주소는 두 계정을 쓰는 호출처 모두의 허용 집합에 들어간다(`deployment.md`에 한 줄).
7. **차단기 동작의 검증.** 비`default` 계정의 `open` 이후 점유·재시도 시각 동작은 현재 성립하지 않으므로 통과 테스트로 굳히지 않았다. RQ-054의 미완 항목으로 B에서 검증한다.

### 2026-11-24 묶음 B

결정 문구는 바꾸지 않는다. 구현하면서 정한 값과 결정의 해석을 적는다. 구현 순서 표와 어긋난 곳은 항목 2에 모았다.

1. **`claim` 인터페이스.** `claim(pool, { accountId, ... })`가 계정 하나를 다룬다. `accountId`를 생략하면 `deps.breaker.breakerKey`(기본 `default`)다. 앱의 Worker는 계정마다 명시한다. 묶음 A의 `accountIds` 옵션은 사라졌다. 새 옵션은 `recoverLeases`(기본 true, lease 복구를 이 호출에서 할지), `accountQuota`(계정 24시간 할당), `onAccountQuota`(한도에 닿으면 `{ limit }`, 한도 안이면 `null`이고 락을 못 잡아 건너뛴 호출에는 부르지 않는다)다. 작업 쿼리는 `account_id = $n`이고 대표 작업 쿼리의 `j.account_id = b.breaker_key`는 그대로다. 호출 순서는 차단기 행 읽기 → 정지 읽기 → 모드 → (none이면 종료) → 계정 할당 → 호출처 할당 → 작업 쿼리다.
2. **구현 순서·결정 문구와 어긋난 곳.**
   - 결정 3 바는 "한 라운드에서 하나라도 점유했으면 바로 다음 라운드를 돈다"고 적었다. 구현은 "요청한 `limit`만큼 가득 점유한 계정이 하나라도 있으면" 바로 다음 라운드를 돈다. 하나라도 점유했다는 조건이면 계정이 하나일 때도 점유 뒤마다 빈 `claim`이 한 번 더 나가 N=1의 호출 수가 현행과 달라진다. 가득 점유했다는 조건은 N=1에서 현행(`claimed.length >= free`)과 같다.
   - 결정 3 바의 "계정의 `claim` 오류는 그 계정에서만 지수 백오프"를 계정별 끝 시각(`claimBackoffUntil`)으로 구현했다. 그 시각 전에는 그 계정의 `claim`을 부르지 않는다. 호출한 계정이 모두 실패한 라운드는 연속 실패 횟수로 쉰다(N=1의 이전 동작). `WorkerStatus.claimFailureStreak`은 계정별 연속 실패 횟수의 최댓값이다. `mailo_claim_polls_total`은 라운드가 아니라 `claim` 호출마다 센다(N=1이면 같다).
   - 결정 3 라는 "점유 건수 상한을 `min(남은 건수, 호출처 할당 남은 건수)`"로 줄인다고 적었다. 구현은 `limit = min(limit, 계정 남은 건수)`로 줄이고 호출처 할당은 기존대로 호출처마다 SQL에서 자른다. 결과는 같다.
   - `account` 범위 정지를 쓰고 지우는 함수(`setPause`·`clearPause`)와 `SendScope`는 넓히지 않았다. REST·CLI·감사가 묶음 C이고, 넓히면 `ops/`의 `scope.type === "all" ? ... : caller` 분기가 계정을 호출처로 잘못 다루기 때문이다. 점유가 읽는 `readSendControls`만 `pausedAccountIds`를 더했다. `listPauses`·`getCallerPauseSummary`·`getSendControlsSummary`는 `account` 행을 내지 않는다(묶음 C).
3. **재시도 시각.** `completeAttempt`의 재개 시각은 차단기가 open이고 `open_until`이 DB `now()`보다 미래일 때만 `open_until`이다. 그 밖(half_open의 늦은 실패, `open_until`이 이미 지난 open에서 늦게 도착한 실패)은 사유별 초기 대기 뒤다. 묶음 A는 지난 `open_until`을 그대로 `next_attempt_at`에 써서 같은 작업을 곧바로 다시 점유할 수 있었다. 이 경로는 default 계정에도 있었다. 계정별 `claim`에서는 open 뒤 점유가 대표 작업(probe)이라 연속 호출 루프는 생기지 않지만 같은 규칙으로 막았다. 재현·검증은 `queue/account-claim.integration-spec.ts`다.
4. **슬롯 배분.** 순수 함수는 `worker/slots.ts`(`accountSlotCap`, `claimLimit`, `rotateFrom`)에 있고 상태는 Worker가 가진다. 계정이 둘 이상일 때만 `claimRandom`으로 시작점을 뽑는다(계정 하나에서는 난수를 뽑지 않아 기존 테스트의 난수 열이 바뀌지 않는다). 계정별 진행 중 건수는 `track`에서 센다. 기동 검사: 계정 수 N이 `MAILO_WORKER_CONCURRENCY`(C)보다 크면 `createWorker`가 `WorkerOptionsError("accounts")`로 거부한다(설정 로더가 이미 같은 조건을 거부한다). 계정의 `concurrency`가 1~C가 아니면 `accountConcurrency`, `sendQuota24h`가 양의 정수가 아니면 `accountQuota`, 계정 할당이 있는데 시도 기록 보존이 24시간 미만이면 `accountQuota.retention`이다(호출처 할당의 `callerQuotas.retention`과 같다).
5. **계정 24시간 할당.** 사용량 쿼리는 `queue/quota-usage.ts`의 `ACCOUNT_QUOTA_USAGE_SQL`이다(`mail_attempts_account_quota_idx` 인덱스 전용 스캔과 `mail_jobs_lease_idx`의 `SENDING` 수). 락 클래스 상수 `ACCOUNT_QUOTA_LOCK_CLASS`는 7364224다(호출처 할당 7364222, 정리 7364223, 마이그레이터 1-인자 형식과 겹치지 않는다). "미결정·확인하지 않은 것"의 이 항목을 닫는다. 새 로그는 `account_quota_exceeded`(warn, `accountId`, `limit`)·`account_quota_recovered`(info, `accountId`)이고 상태가 바뀔 때만 남긴다. `send_paused`·`send_resumed`는 `scope: "account"`와 `accountId`를 싣는다. `claim_failed`에는 `accountId`가 붙는다. `worker_started`에는 `accounts`(계정 수)가 붙는다. `account_limits_not_enforced`는 없앴다. 모두 계정 ID·한도 수치만 싣는다.
6. **건수 쿼리.** `getQueueBacklog(db, accountIds)`와 `getQueueDepth(db, accountIds)`는 구성한 계정마다 상수 계정 쿼리를 보내 합친다(문장 수: `getQueueBacklog`는 계정 N개면 N문장이고 N=1이면 이전과 같은 1문장이다. `getQueueDepth`는 `scheduled` N문장에 전체 `sending` 수를 첫 계정의 문장에 함께 담아 2N문장이고 N=1이면 이전과 같은 2문장이다). 구성 밖 계정의 작업은 점유되지 않아 세지 않는다. 합친 값은 응답 계약(`openapi.yaml`의 `maximum: 10000`)을 지키려고 같은 상한 10000으로 자르고, 합이 상한을 넘거나 어느 한 계정이 상한에 닿았으면 `truncated`가 true다("상한 이상"이라는 포화 의미는 그대로다). 이는 결정 3 아의 "N>1이면 `dueCount`가 10000을 넘을 수 있다"를 이 확정으로 대체한다. 결정 문구는 고치지 않는다. 계약(`ReadyResponse`)은 바뀌지 않는다. 인자는 필수다(생략을 허용하면 계정을 빠뜨린 호출이 조용히 0을 낸다). 호출 쪽은 `health/health.service.ts`와 `health/metrics-collector.ts`가 `config.smtpAccounts`의 ID를 넘긴다.
7. **구성 밖 계정 점검.** `countOrphanAccountJobs`는 `account_id <> ALL(...)` 조건이 인덱스를 못 써서 테이블 전체를 읽었다. 구현은 계정 부분 인덱스의 `account_id`를 재귀 CTE로 건너뛰며(loose index scan) 대기 중인 계정 ID를 모은 뒤 구성 밖 계정만 센다. `SENDING`은 부분 인덱스에 없어 `mail_jobs_lease_idx`로 읽는다.
8. **마이그레이션과 EXPLAIN.** `0012`~`0016`은 결정 4의 표와 같다. 파일 다섯 개는 모두 첫 줄 `-- mailo:no-transaction`, 문장 하나, 멱등이다. 로컬 단일 측정(PostgreSQL 17.11, compose, 임시 schema, 작업 74.5만 행: `SENT` 50만, `PENDING` 12.5만(`a1` 12만이 가장 오래됨), `RETRY_WAIT` 12만(6만은 미래), `SENDING` 40, 구성 밖 계정 5천, 시도 25만 행, 일반 `VACUUM ANALYZE` 뒤, 레거시 인덱스 삭제 상태, `EXPLAIN (ANALYZE, BUFFERS)` 한 번씩)은 다음과 같다. 계획은 모두 새 인덱스를 쓴다.

   | 쿼리 | 실행 시간 | 계획 요점 |
   | ---- | --------- | --------- |
   | 우선순위 점유, 계정 `a2`, 호출처 2개 제외, `LIMIT 4` | 0.103ms | `mail_jobs_account_priority_claim_idx`, 읽은 행 4건 |
   | 대기 순서 점유, 대기 12만 건 계정 `a1` | 0.052ms | `mail_jobs_account_claim_idx` |
   | 점유 쿼리, 구성 밖 계정 조건 | 0.033ms | 계정 인덱스, 행 0 |
   | 적체 전체 값(상한 10001), `a2` | 0.735ms | `mail_jobs_account_claim_idx` 인덱스 전용 스캔, 64 buffers |
   | 적체 등급별 값(`LATERAL`), `a2` | 1.210ms | `mail_jobs_account_priority_claim_idx` 인덱스 전용 스캔 |
   | 예약 건수(상한 10001), `a2` | 0.673ms | `mail_jobs_account_claim_idx` 인덱스 전용 스캔 |
   | 계정 24시간 사용량, `a2`, 한도 10만 | 2.313ms | `mail_attempts_account_quota_idx` 인덱스 전용 스캔(5.0만 행) + `mail_jobs_lease_idx` |
   | 구성 밖 계정 건수, 이전 쿼리(`<> ALL`) | 34.961ms | `mail_jobs` 병렬 순차 스캔, 16300 buffers(테이블 크기에 비례) |
   | 구성 밖 계정 건수, 새 쿼리 | 21.0~21.4ms(JIT 켜짐, 컴파일 약 20ms), 0.6ms(`jit = off`) | 인덱스 건너뛰기 계정 수만큼(8번), 69 buffers. 재귀 CTE의 비용 추정이 `jit_above_cost`를 넘어 JIT가 켜졌다. 기동 때 한 번뿐이라 그대로 둔다 |

   인덱스 크기는 `mail_jobs_account_priority_claim_idx`·`mail_jobs_account_claim_idx` 각 12MB, `mail_attempts_account_quota_idx` 1.9MB였다. 이 측정은 단일 실행이고 동시 쓰기 부하·운영 크기·통계가 오래된 상태는 없다. 통합 테스트는 작은 데이터에서 `enable_seqscan = off`로 새 인덱스를 "쓸 수 있는지"만 고정한다(계획 선택 자체는 자동 테스트로 고정하지 못한다).
9. **N=1 문장 수.** 계정이 하나일 때 `claim` 한 번의 문장 수(BEGIN·COMMIT과 lease 복구 포함)는 묶음 A와 같다. closed 8, 호출처 할당 하나 10, open 대기 7, 전체 정지 7, 대표 작업 10이다. 이 값을 묶음 A의 `claim`으로 먼저 측정한 뒤 테스트(`queue/claim-query-count.integration-spec.ts`)로 고정하고 변경 뒤에도 같음을 확인했다. Worker의 라운드 단위 호출 수(lease 복구는 라운드마다 한 번)는 `worker/worker-accounts.integration-spec.ts`가 본다.
10. **묶음 A 기동 거부 제거.** `assertDefaultAccountOnly`와 테스트 전용 옵션 `allowNonDefaultAccounts`를 지웠다. 제거 조건인 계정별 격리는 통합 테스트로 확인했다(계정 A의 차단기 open이 B의 점유를 막지 않고 반대도 같음, 비`default` 계정의 open → half_open → closed 전이, 계정 정지·할당·슬롯 격리, 앱 단위 e2e). 이 변경으로 바뀐 기존 테스트는 `e2e/multi-account.integration-spec.ts`의 "묶음 B 전의 방어"(기동 거부 단언)가 "비default 계정 구성의 기동"(기동 성공 단언)으로, `worker/account-startup.spec.ts`의 `account_limits_not_enforced` 경고 단언이 "남기지 않는다" 단언으로, `queue/claim-priority.integration-spec.ts`의 레거시 인덱스 존재 단언이 새 인덱스 존재 단언으로 바뀐 것이다. 모두 묶음 B가 없앤 동작을 단언하던 테스트다.
11. **검증하지 않은 것(묶음 B).** 롤링 배포(구·신 혼용)와 롤백 실행, 레거시 인덱스 삭제 뒤 구버전 점유 성능(결정 4의 M8, 한 쿼리 측정만 있다), `CREATE INDEX CONCURRENTLY`·`DROP INDEX CONCURRENTLY`의 동시 쓰기 부하 아래 시간, 다중 인스턴스(4개 이상) 동시 부하의 poll 비용과 풀 점유, 계획 안정성(통계가 오래된 상태), 실제 Gmail·Workspace 계정 둘의 한도·동시 연결, 대표 작업 쿼리(`ORDER BY (j.id IS NOT DISTINCT FROM b.last_trip_job_id), ...`)는 정렬 첫 키가 식이라 계정 인덱스의 순서를 쓰지 못한다. 로컬 단일 측정(위와 같은 데이터, 대기 12만 건 계정 `a1`)에서 64.6ms였고 `mail_jobs_expiry_idx`로 대기 행을 읽어 정렬했다(외부 병합 5.3MB). 계정 대기 건수에 비례하고 open 대기가 끝날 때 한 번 나가는 쿼리이며 묶음 B는 이 쿼리를 바꾸지 않았다(묶음 A 이전에도 같은 형태였고 전체 대기에 비례했다). 대기 건수가 큰 계정에서 문제가 되면 후속 변경으로 다룬다. 계정 정지를 쓰는 표면이 없어 운영자가 계정을 정지하는 실제 경로는 묶음 C 전에는 직접 SQL뿐이다.

### 2026-11-24 묶음 C

결정 문구는 바꾸지 않는다. 구현하면서 정한 값과 결정의 해석을 적는다. 구현 순서 표·결정 5와 어긋난 곳은 없다. 표의 "`.env.example`·compose" 갱신은 새 환경 변수와 마운트가 없어 바꿀 것이 없었다.

1. **`GET /ops/accounts`의 대상.** 이 인스턴스가 구성한 계정만 구성 순서(`default`, 파일 순서)로 낸다. 결정 5는 구성 밖 계정의 표시를 정하지 않았다. 구성에서 빠진 계정은 점유되지 않는 작업이 남을 뿐이라 목록에 내지 않고, 그 계정의 정지 행은 `GET /ops/pauses`가 낸다(정리용 `DELETE`가 구성 밖 ID를 받는다). 구성한 계정의 차단기 행이 없으면 `getBreakerStates`가 던져 503이다(`claim`이 같은 이유로 실패하는 것과 같은 fail-closed). 항목마다 따로 읽으므로 한 시점의 스냅샷이 아니다. 계정당 쿼리는 적체 1(+사용량 1)이고 차단기·정지는 전체를 한 번 읽는다.
2. **정지 범위 타입.** `SendScope`에 `account`를 더했다. 묶음 B가 넓히지 않은 이유(`scope.type === "all" ? ... : caller` 분기가 계정을 호출처로 오인)는 모든 분기를 `all`·`caller`·`account`로 나열해(컴파일러가 빠진 분기를 잡는다) 없앴다. `getCallerPauseSummary`는 호출처의 계정 ID를 필수 인자로 받는다. 우선순위는 `all`, `account`, `caller`다. 경로 퍼센트 디코딩 실패의 파라미터 이름(`problem.filter.ts`)에 `/ops/pauses/accounts/`를 더했다. 이를 빠뜨리면 404가 되어 `callerId`와 다르게 동작한다. 계정 ID 검증은 서버가 `isAccountId`, CLI가 같은 정규식의 복사본이고 `unregistered`는 둘 다 거부한다(테스트가 같은 판정을 고정한다).
3. **`/health/ready`의 최악 상태.** 인증 없음·운영자 토큰은 모든 구성 계정의 차단기를 한 문장으로 읽어 `open` > `half_open` > `closed` 중 가장 나쁜 하나를 고른다. 같은 상태이면 계정 ID 오름차순 첫 계정이다(인스턴스마다 같은 값을 내려는 선택이고 결정 5는 정하지 않았다). 운영자·인증된 응답의 `openUntil`·`lastReason`은 그 계정의 값이다. 호출처 키는 자기 계정 하나만 읽는다. 계정 ID는 어디에도 쓰지 않는다. `lastReason` 어휘 함수는 `/ops`와 헬스가 같이 쓰도록 `health/`에서 `queue/breaker-view.ts`로 옮겼다(헬스의 기존 import 경로는 재수출로 유지).
4. **지표.** `account_id`가 구성 밖이면 증가를 버리지 않고 `unregistered`로 센다(결정 5의 "구성 밖 계정의 작업이 만료 sweep으로 종결되는 경우"). `createMetrics({ accountIds, callerAccounts })`로 시드를 (호출처, 계정) 쌍으로 만든다. 계정 ID를 쓰는 곳은 `JobTransition.accountId`·취소 결과 `accountId`·`ClaimedJob.accountId`이고 호출처 응답에는 없다. 큐 지표는 계정별 `getAccountQueueDepths`(계정당 2문장, `sending`도 그 계정의 점유 중 수)를 쓴다. 묶음 B의 `getQueueDepth`(전체 `sending`·구성 계정의 `scheduled` 합)는 테스트가 쓰는 집계 함수로 남고 지표 수집은 쓰지 않는다. 새 인스턴스 gauge는 결정 표의 이름 `mailo_worker_in_flight`(`account_id`)를 따랐다. 기존 `mailo_worker_in_flight_jobs`(전체 값)는 이름을 바꾸지 않고 유지한다(ADR-0012 "지표 이름은 바뀌지 않는다"). `WorkerStatus.inFlightByAccount`가 구성한 모든 계정의 키를 가진다(0 포함). 계정 사용량 쿼리(`ACCOUNT_QUOTA_USAGE_SQL`)는 `quota` 그룹에서 계정마다 한 번 실행한다. 그룹이 실패하면 `accountQuota`도 응답에서 뺀다.
5. **호출처 계약 변경.** 호출처에 보이는 변경: `circuitBreaker`(호출처 키는 자기 계정, 인증 없음은 최악 상태), `sendPaused.scope`의 값 `account`. 운영자에게만 보이는 변경: `sendControls.pausedAccountCount`, `OpsJob.accountId`, 새 endpoint 둘, 새 지표. 단일 계정 배포는 계정 정지를 쓰지 않는 한 호출처 값이 이전과 같다(`default` 계정을 정지하면 호출처 키가 `sendPaused.scope: account`를 받는다). 롤링 배포 중에는 구버전 인스턴스가 이전 의미의 `circuitBreaker`를 내고 계정 정지를 읽지 않으므로 둘째 계정을 켜기 전에 모든 인스턴스를 새 버전으로 바꾼다(결정 2의 순서). `openapi.yaml`·`deployment.md`·`caller-onboarding.md`·`troubleshooting.md`·`AGENTS.md`를 같은 변경에서 갱신했다. 저장소 안 Java 샘플은 `/health/live`만 쓰므로 영향이 없다(코드 읽기, `run-e2e.sh`는 실행하지 않았다).
6. **알림 규칙.** `MailoNoProgress`를 계정별(`on (account_id)`)로 바꾸고 `MailoAccountQuotaNearLimit`을 더했으며 `MailoSendPausedLong`에 계정 정지를 포함했다. `promtool check rules`로 문법만 확인했고 평가는 실행하지 않았다.
7. **정지 행 관리.** 정지 행은 구성에 없는 ID도 받으므로 쌓일 수 있고 `GET /ops/pauses`는 쪽 나누기 없이 전부 낸다. 결정 5가 허용한 범위라 코드를 바꾸지 않았다(정지는 운영자 수동 조작이라 행 수가 작다고 추정, 측정하지 않았다). 정리는 `DELETE`로 한다.
8. **검증하지 않은 것(묶음 C).** 저장소 밖 호출처의 `circuitBreaker` 새 의미·`sendPaused.scope` 새 값 처리, 롤링 배포 중 구·신 혼용, 계정 20개 규모의 시리즈 수(`mailo_attempt_errors_total`의 실제 조합 수)와 `/metrics` 스크레이프의 계정당 쿼리 비용(약 6개), 실제 Prometheus의 알림 평가, 읽기 전용 컨테이너에서 새 CLI 명령, 다중 계정 컨테이너, 실제 Gmail·Workspace. 컨테이너 스크립트는 단일 계정(`default`) 구성에서만 실행했다.

### 2026-11-24 pause 경쟁 수정

결정 문구는 바꾸지 않는다. v0.4.0 CI의 `worker.integration-spec.ts` 실패(종료 신호 뒤에 등록한 작업이 SENT)를 조사해 정한 내용이다. ADR-0002 결정 12·구현 중 확정 6의 "새 점유를 멈춘다" 시점을 점유 호출 단위로 풀어 쓴다.

1. **pause 시점의 의미.** `pause()` 때 이미 시작한 `claim` 호출은 끝까지 가고, 그 호출이 점유한 작업은 처리한다(점유한 작업을 버리면 lease 만료까지 지연되므로). 호출 도중에 등록된 작업을 그 호출이 읽을 수 있다. 이 동작은 ADR-0013 묶음 B 이전(v0.3.0)에도 같았다. 로컬 재현: 묶음 B 이전 소스 300회 중 2회(부하 시 1회), 묶음 B 소스 100회 중 1회가 같은 단언에서 실패했다.
2. **묶음 B가 만든 결함.** 라운드가 계정마다 `claim`을 부르므로, 앞 계정의 호출 도중에 `pause()`가 오면 같은 라운드의 다음 계정 호출이 pause 뒤에 새로 시작했다. 이제 계정 호출 전에 pause를 확인해 라운드를 멈춘다(`worker/worker.ts`). 계정이 하나일 때는 영향이 없다.
3. **테스트.** 종료 신호 테스트는 `stop()`이 부른 `pause()`가 끝난 뒤(점유 루프 종료 뒤)에 늦은 작업을 등록한다. 단언은 약화하지 않았다. `worker-accounts.integration-spec.ts`에 점유 호출 도중 `pause()`를 거는 결정적 테스트 둘(다음 계정 호출 없음, 진행 중 호출이 점유한 작업은 끝까지 발송)을 더했다.
4. **검증하지 않은 것.** 점유 호출 도중에 등록된 작업을 pause 뒤에는 읽지 않게 하는 방법(호출 취소·점유 해제)은 구현하지 않았다. 점유 해제는 작업 행 잠금 경로를 새로 만들기 때문이다.
