# 개인정보 최소화는 종결 때 본문·수신자·봉투를 같은 UPDATE로 비우고 이벤트의 수신자를 유예 뒤 비우는 것으로, 결과 불명 정책은 요청별 opt-in `onUncertainOutcome`으로 정한다

## 상태

승인됨 (2026-11-24)

2026-11-24에 초안을 쓰고 같은 날 사용자가 결정 1~10의 권고안 전체를 승인했다. 열린 질문이던 8건도 모두 권고대로 승인했다. 확정한 답은 "구현 중 확정"의 2026-11-24 승인 절에 모았다. 입력은 `docs/requirements/roadmap.md`의 "단계 10. 개인정보 최소화와 결과 불명 정책"이다. 범위는 그 표의 두 항목(수신자 주소 보존 단축, 결과 불명 처리 opt-in)이고 넓히지 않았다.

구현 상태(2026-11-24): 묶음 A(문서, 결정 1, RQ-070)를 작성했다(문서 검토 남음). 묶음 B(결정 2, RQ-071)를 구현했다(미검증 항목 있음). 묶음 C(결정 3, RQ-072)를 구현했다(미검증 항목 있음). 묶음 D는 시작하지 않았다.

검증 범위는 코드·문서 읽기다(2026-11-24). 테스트, 스크립트, 쿼리, 측정을 실행하지 않았다. "배경"의 "확인한 사실"은 코드와 문서에서 읽은 것이고 그 밖의 것은 "미결정·확인하지 않은 것"에 모았다. 문서에는 줄 번호 대신 파일·함수 이름으로 근거를 적었다(`docs/agents/writing-styles.md`).

승인으로 다음 관계가 생겼다. 승인된 ADR의 결정 문구는 바꾸지 않고 상태 절에 대체 관계만 적는다.

- ADR-0008 결정 7의 "종결한 작업의 본문은 유예 기간(1일) 뒤 삭제한다"를 결정 2가 바꾼다. 종결 전이와 같은 UPDATE에서 비운다. 유예 설정은 이전 버전이 종결한 행의 안전망으로 남는다.
- ADR-0006 결정 2(이벤트에 수신자를 넣는다)와 ADR-0007 결정 7(`rejectedRecipients` 노출)은 결정 3이 유예 뒤 비운다. 이벤트 행 보존 30일(ADR-0006 결정 8)은 그대로다.
- ADR-0002 결정 7의 판정 순서에 결정 8이 단계 하나를 더한다(요청이 `fail`을 고른 경우의 결과 불명 종결).
- ADR-0001 결정 5(at-least-once)의 기본은 그대로다. 요청이 `fail`을 고르면 결과 불명 구간에서만 재발송하지 않는다(결정 6).
- ADR-0007 결정 3(DATA 단계 타임아웃은 `TRANSIENT`)은 `retry`(기본)에서 그대로다. `fail`은 같은 분류를 재시도하지 않는 종결로 바꾼다.
- ADR-0011 결정 5가 "기존 관계"로 남긴 단계 10의 `onUncertainOutcome`을 결정 6~9가 정한다. 그 결정의 `outcomeUncertain` 표시는 그대로다.
- ADR-0005 결정 3의 요청별 정책 필드(`policy`)에 `onUncertainOutcome`이 들어간다(ADR-0009·0010과 같은 방식).
- RQ-016(`rejectedRecipients`), RQ-017(실패 이벤트의 수신자), RQ-023(본문 삭제 시점), RQ-048(`outcomeUncertain`)의 문구는 구현 때 갱신한다. 새 RQ 번호는 "새 RQ 번호" 절이다.

## 배경

### 확인한 사실

모두 2026-11-24에 코드와 문서를 읽어 확인했다.

개인정보와 보존. Mailo가 다루는 개인정보는 수신자 주소, 발신자(`from`·`replyTo`), 제목·본문, 호출처가 정한 `Idempotency-Key`와 파일 이름, SMTP 응답 텍스트에 섞인 주소다. 시크릿(키, SMTP 비밀번호)은 RQ-027이 따로 다룬다.

| 위치 | 항목 | 형태 | 남는 기간 | 지우는 방법 |
| ---- | ---- | ---- | --------- | ----------- |
| `mail_jobs.body_ciphertext` | 제목·text·html | AES-256-GCM 암호문 | 종결 후 `MAILO_BODY_RETENTION_SECONDS`(기본 1일). 취소는 취소 UPDATE에서 즉시 비운다 | `deleteExpiredBodies`가 본문 열을 `UPDATE`로 NULL로 바꾼다. `cancelWithin`은 취소 전이와 같은 UPDATE에서 비운다 |
| `mail_jobs.recipients` | to·cc·bcc | 평문 jsonb | 종결 후 `MAILO_RECORD_RETENTION_SECONDS`(기본 30일) | `deleteExpiredRecords`가 행을 지운다 |
| `mail_jobs.envelope` | `from`, `replyTo` | 평문 jsonb | 30일 | 같은 행 삭제 |
| `mail_jobs.idempotency_key`, `fingerprint` | Key는 호출처가 정한 값. 지문은 HMAC-SHA256 | 평문, 해시 | 30일 | 같은 행 삭제. Mailo는 Key의 형식(`[A-Za-z0-9._:-]`, 1~128자)만 검사하고 내용은 모른다 |
| `mail_events.recipients`, `rejected_recipients` | 수신자, 거부된 수신자 | 평문 jsonb | 30일(ADR-0006 결정 8) | 작업 삭제의 `ON DELETE CASCADE` |
| `mail_attempts.rejected_recipients`, `response_text` | 거부된 수신자 주소, SMTP 응답 텍스트 | 평문. 응답 텍스트는 주소 형태를 `[address]`로 바꾸고 500자로 자른다(`sanitizeResponseText`) | 30일 | 같은 CASCADE. 주소가 아닌 사용자 이름을 되풀이하는 응답은 가리지 못한다(ADR-0007 구현 중 확정 5) |
| `mail_intake_rejections` | 파일 이름(호출처가 정함), sha256, 파싱한 Key | 평문 | 기록 생성 후 30일 | `deleteExpiredRecords` |
| `mail_ops_audit` | 관리 토큰 이름, 작업 ID. 주소·제목·본문 없음 | 평문 | 자동 삭제 없음(ADR-0012 결정 8) | 수동 `DELETE`(`db-maintenance.md` "감사 테이블") |
| 로그(표준 출력 JSON) | 수신자·제목·본문·Key 없음. `callerId`, `jobId` 같은 식별자만 있다 | JSON 줄 | Mailo는 보존하지 않는다. 수집기와 런타임의 몫이다 | canary 테스트가 확인한다(RQ-027) |
| `/metrics` | 라벨은 닫힌 집합(`caller_id`, `account_id`, 사유). 주소 없음 | 메모리 | 스크레이프 저장소의 몫 | |
| DB 백업·WAL | 위 행의 시점 사본 | 운영자 설정 | 운영자 정책 | Mailo가 지우지 못한다 |
| Worker 메모리 | 전송 중인 평문 | 프로세스 메모리 | 전송 동안 | |

- `mail_jobs.recipients`와 `envelope`를 읽는 코드는 `claim`(점유한 행), 결과 기록(`completeAttempt`의 `JOB_COLUMNS`), 만료 sweep, 취소뿐이다. 모두 종결 전 행이고, 종결 이벤트를 쓸 때 `recipients`를 이벤트로 복사한다. 종결한 행의 `recipients`·`envelope`를 읽는 경로는 찾지 못했다. `GET /jobs`의 `Job`에는 수신자 필드가 없다(`presentJob`, `rejectedRecipients`만 `SENT`일 때 있다).
- 종결 전이 UPDATE(`applyOutcome`, `sweepExpired`)는 본문 열을 건드리지 않는다. 취소(`cancelWithin`)만 같은 UPDATE에서 비운다(ADR-0011 결정 4: 나갈 수 없는 메일의 본문을 유예 기간 더 두지 않는다).
- 종결한 작업의 본문을 읽는 곳은 없다. 운영자 재시도 API가 없고(ADR-0011 결정 5) 암호문은 AAD가 작업 ID라 새 작업으로 복사할 수 없다(ADR-0008 결정 6).
- 보존 삭제는 시각 기준이라 백업에서 복구한 DB도 다음 정리 사이클이 보존 기간을 넘긴 행을 지운다(`deleteExpiredRecords`의 `finished_at <= now() - retention`, 코드 읽기, 실행하지 않았다).
- 보존 기간 설정의 관계: `MAILO_RECORD_RETENTION_SECONDS` ≥ `MAILO_BODY_RETENTION_SECONDS`, ≥ `MAILO_JOB_EXPIRY_MAX_SECONDS`, `MAILO_JWS_IAT_MAX_AGE_SECONDS` ≤ 보존 − 오차(`config/load-config.ts`). 작업 행·Key를 30일 두는 이유는 relay 재전달의 멱등성이다(ADR-0005 결정 7).

결과 불명. 현재 처리는 다음과 같다.

- 불명이 생기는 경로는 둘이다.
  - DATA 단계의 타임아웃·연결 끊김. `TRANSIENT_DATA_TRANSPORT_FAULT` 규칙(`smtp/classify.ts`)이 `TRANSIENT`로 분류한다. `StageTracker`(`smtp/sender.ts`)의 DATA 단계는 `DATA` 명령의 354 응답을 기다리는 구간과 본문 전송 뒤 최종 응답을 기다리는 구간을 모두 포함한다.
  - lease 만료 회수. `recoverExpiredLeases`가 `LEASE_EXPIRED` 시도를 기록한다. 원인은 프로세스 사망, drain 상한을 넘긴 종료, 결과 기록 실패다.
- 두 경로 모두 시도 횟수에 포함하고 `retryOrFinish`로 재시도 대기(`RETRY_WAIT`)나 소진 `FAILED`, 만료 `EXPIRED`가 된다. 재시도는 같은 `Message-ID`를 쓴다(ADR-0007 결정 8). Gmail이 같은 `Message-ID`를 중복으로 버리는지는 확인하지 못했다.
- 컨테이너에서 SIGKILL 뒤 같은 `Message-ID`로 2통이 도착한 것을 관찰했다(ADR-0002 구현 중 확정 5, `scripts/container/verify-sigkill-duplicate.sh`, 로컬 가짜 SMTP).
- 차단기: `LEASE_EXPIRED`와 내부 오류는 차단기를 건드리지 않고, 일반 `TRANSIENT`는 `recordAccountOk`를 부른다(`applyOutcome`).
- 호출처는 불명 여부를 표시로만 안다. `outcomeUncertain`은 `mail_attempts`에서 도출하고(`queue/read.ts`의 `UNCERTAIN_ATTEMPT`) 종결 이벤트(`JOB_FAILED`·`JOB_EXPIRED`)와 `Job`에 있다(RQ-048). 이벤트는 종결 때만 오므로 재시도 중인 불명은 `GET /jobs`로만 본다.
- 재발송을 막는 요청 단위 수단이 없다. 호출처는 "중복이 손실보다 나쁜 메일"에도 같은 정책을 받는다.

### 가정

- 불명 구간의 재발송 빈도는 측정하지 않았다. 실제 Gmail에서 DATA 단계 타임아웃이 얼마나 나는지 모른다.
- 호출처에 "중복보다 손실이 낫다"는 메일(일회용 인증 코드, 결제 영수증 같은 것)이 여럿 있다고 가정한다. 이 가정이 틀리면 결정 6~10은 구현 비용 대비 쓸모가 작다.
- 이벤트를 30일보다 훨씬 짧은 기간 안에 읽는 호출처가 대부분이라고 가정한다(권장 폴링 간격 30초, ADR-0006 결정 8). 측정하지 않았다.

## 결정

결정 문구는 선택지의 권고를 따랐고 승인됐다. 승인 뒤에는 바꾸지 않는다.

1. **개인정보 보존 현황을 운영 문서 한 곳(`docs/operations/data-retention.md`, 새 문서)에 표로 확정하고, 호출처에게 Key와 파일 이름에 개인정보를 넣지 말라고 안내한다. 코드는 바꾸지 않는다.**
   - 문제: 보존 규칙이 여러 ADR(0005, 0006, 0007, 0008, 0011)과 설정 변수에 흩어져 있어 "어디에 얼마나 남는가"를 한 번에 답하지 못한다. Key와 파일 이름은 호출처가 정하므로 Mailo가 내용을 통제하지 못한다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 현황 표와 호출처 안내를 문서로 둔다 | 권고. 비용이 작고 결정 2~4가 바뀌면 표만 고친다 |
     | B. A + Key에 `@`가 있으면 거부하는 검증 | Key 형식(`[A-Za-z0-9._:-]`)이 `@`를 이미 거부한다. 주소 외 개인정보(이름, 전화번호 조각)는 규칙으로 잡지 못한다 |
     | C. 문서화하지 않는다 | 결정 2~4의 운영 영향(백업, 로그 수집기)이 전달되지 않는다 |

   - 결정 문구(A):
     - 문서는 "배경"의 표를 현재 동작으로 옮기고, 로그 수집기·백업·SMTP 서버·호출처 저장소는 Mailo 밖이라 Mailo가 지우지 못한다고 쓴다.
     - 백업 보존 기간은 운영자가 정한다. 복구본은 정리 사이클이 보존 기간을 넘긴 행을 다시 지운다.
     - 호출처 안내는 `caller-onboarding.md`에 쓴다. Key는 outbox 행 ID처럼 요청 단위 고유 값으로 하고(ADR-0005 결정 8) 사람을 식별하는 값을 넣지 않는다. 파일 이름도 같다.
   - 위험: 문서는 동작을 바꾸지 않는다. 표가 코드와 어긋나면 틀린 안내가 된다. 구현 묶음마다 표를 같은 변경에서 고친다.

2. **종결 전이(`SENT`·`FAILED`·`EXPIRED`)의 같은 UPDATE에서 본문 열과 `body_deleted_at`을 채우고 `recipients`와 `envelope`를 비운다. 취소는 이미 본문을 비우므로 수신자·봉투만 더한다.**
   - 문제: 종결한 작업의 본문·수신자·발신자는 읽는 코드가 없는데 본문은 1일, 수신자·봉투는 30일 남는다. 본문 삭제는 추가 `UPDATE`와 TOAST 죽은 행을 만든다(`db-maintenance.md` 측정: 본문 삭제 단계의 갱신 200,000건, TOAST 죽은 행 400,000건, 로컬 한 번).
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 현재 유지(본문 1일, 수신자·봉투 30일) | 노출 기간이 가장 길다. 종결 후 읽는 코드가 없는 데이터를 남긴다 |
     | B. `MAILO_BODY_RETENTION_SECONDS` 기본값만 줄인다(예: 1시간) | 코드 변경이 없다. 수신자·봉투는 그대로이고 추가 `UPDATE`가 남는다 |
     | C. 종결 UPDATE에서 즉시 비운다 | 권고. 노출 기간이 0이 되고 본문 삭제용 `UPDATE`가 사라진다. 취소 경로의 선례(ADR-0011 결정 4)와 같다. 쿼리 변경 지점이 넷이다(결과 기록·lease 복구는 `applyOutcome` 하나, 만료 sweep, 취소) |
     | D. 키를 폐기해 본문을 한꺼번에 못 읽게 한다 | 키는 `key_version` 단위라 그 버전의 비종결 작업까지 못 읽는다. 수신자는 평문이라 효과가 없다 |

   - 결정 문구(C):
     - `applyOutcome`의 종결 UPDATE와 `sweepExpired`의 UPDATE에서 `body_ciphertext`, `body_nonce`, `body_key_version`을 NULL, `body_deleted_at`을 `now()`, `recipients`와 `envelope`를 `'{}'`로 바꾼다. 한 SQL 문장이라 부분 상태가 없다. `mail_jobs_body_state` CHECK는 본문 세 열이 함께 NULL인 경우를 허용한다.
     - 종결 이벤트의 수신자는 갱신 전 값을 쓴다. PostgreSQL의 `RETURNING`은 갱신 뒤 값을 주므로 같은 트랜잭션에서 갱신 전 값을 먼저 읽거나 CTE로 잡아야 한다(PostgreSQL 동작 지식, 실행하지 않았다. 구현 때 통합 테스트로 확인한다).
     - `MAILO_BODY_RETENTION_SECONDS`와 `deleteExpiredBodies`는 남긴다. 이 변경 전 버전이 종결했거나 롤링 중 구버전이 종결한 행을 비우는 안전망이다. 기본값은 바꾸지 않는다.
     - 행, Key, 지문은 남긴다(ADR-0005 결정 7). 마이그레이션은 없다.
   - 위험: 결과 기록 UPDATE는 점유·완료 경로의 핵심 SQL이다. 잠금 순서(작업 행 → 차단기 행)는 바뀌지 않는다. 종결 직후 DB 복구나 디버깅에서 본문·수신자를 볼 수 없다. 이는 의도한 결과이고 ADR-0011 결정 5가 운영자 재발송을 이미 배제했다. 구버전과의 충돌은 없다. 구버전의 본문 정리는 `body_ciphertext IS NOT NULL`인 행만 대상으로 하므로 비운 행을 건드리지 않는다.

3. **이벤트와 시도의 수신자 주소는 `MAILO_RECIPIENT_RETENTION_SECONDS`(가칭, 기본 7일) 뒤 비운다. 이벤트에는 `recipientsRedacted`를 내고, 비운 값은 빈 목록이다.**
   - 문제: 결정 2 뒤에도 `mail_events.recipients`, `mail_events.rejected_recipients`, `mail_attempts.rejected_recipients`가 30일 평문으로 남는다. 이벤트는 호출처가 읽어 가는 전달물이고, 호출처는 이미 Key로 자기 outbox의 수신자를 안다. 30일 동안 Mailo DB에도 둘 이유가 약하다.
   - 선택지(비우는 모양):

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 목록을 비우고 `recipientsRedacted: true`를 낸다 | 권고. 남는 개인정보가 없다. 호출처는 Key로 자기 기록과 맞춘다 |
     | B. 목록 대신 건수만 남긴다(`to`·`cc`·`bcc` 개수) | 호출처 계약에 건수 필드를 더해야 한다. 쓰는 곳이 없다 |
     | C. 주소를 지문 키에서 파생한 HMAC으로 바꾼다 | 주소를 알면 같은 값을 계산해 대조할 수 있다. 키와 후보 목록이 있으면 되돌려 확인된다. 파생 키의 교체·분실 절차가 늘고 운영자 읽기(`/ops`)는 수신자를 내지 않으므로(ADR-0011 결정 7) 조회 수요가 없다 |
     | D. 이벤트 행을 7일 뒤 지운다 | 이벤트 피드 보존 30일과 공백 감지(ADR-0006 결정 8, ADR-0011 결정 9)를 깬다 |

   - 선택지(유예 기본값):

     | 값 | 판단 |
     | -- | ---- |
     | 1일 | 노출이 가장 짧다. 하루 넘게 폴링이 멈춘 호출처는 빈 수신자를 받는다 |
     | 7일 | 권고. relay 최대 재시도 기간(7일 이하, ADR-0005 결정 7)과 JWS 허용 기간(기본 7일)과 같다. 호출처가 일주일 안에 따라잡는다고 보는 값이다(추정) |
     | 30일(= 보존 기간) | 현재와 같다. 끄는 값이다 |

   - 결정 문구(A, 7일):
     - 새 정리 단계 `recipients`를 추가한다(`MaintenanceStep`, advisory lock 키 5). 대상은 `JOB_SENT`·`JOB_FAILED`·`JOB_EXPIRED`·`JOB_CANCELED` 이벤트 중 `created_at`이 유예를 넘긴 것이다. `INTAKE_REJECTED`는 수신자가 없다.
     - 한 트랜잭션에서 이벤트의 `recipients`를 `'{}'`로, `rejected_recipients`를 NULL로 바꾸고 `recipients_redacted_at = now()`를 쓴다. 같은 트랜잭션에서 그 이벤트 작업의 `mail_attempts.rejected_recipients`를 NULL로 바꾼다(`mail_attempts_job_idx`).
     - 배치는 1000건이다(`MAINTENANCE_BATCH_SIZE`). 보존 삭제와 같은 사이클 상한을 쓴다.
     - 설정 범위는 60 이상 `MAILO_RECORD_RETENTION_SECONDS` 이하다. 기동 때 검사하고 어기면 거부한다. 값이 보존 기간과 같으면 비움이 삭제와 같은 시점이라 끄는 것과 같다.
     - 이벤트 응답에 `recipientsRedacted`(불리언)를 `JOB_*` 종류에 항상 낸다. 비우면 `true`이고 `recipients`는 `to`·`cc`·`bcc` 빈 배열, `rejectedRecipients`는 빈 배열이다. `Job.rejectedRecipients`는 비운 뒤 빈 배열이다. `Job`에는 새 필드를 더하지 않는다.
     - 비운 이벤트가 같은 cursor로 다시 와도 피드 순서와 공백 감지는 바뀌지 않는다. 행은 지우지 않는다.
   - 위험: 호출처 계약 변경이다(`openapi.yaml`의 이벤트 스키마, 모르는 필드는 무시한다는 규칙으로 처리한다). 이벤트의 `recipients`를 상태 판단에 쓰는 호출처가 있으면 유예 뒤에 빈 값을 받는다. 저장소 밖 호출처는 확인하지 못했다. 이벤트 행이 처음으로 `UPDATE`된다. 갱신 열이 부분 인덱스 조건에 들어가 HOT 갱신이 안 될 가능성이 있다(PostgreSQL 동작 지식, 미검증). 종결 작업당 쓰기가 한 번 늘고, 배포 직후에는 보존 기간 안의 기존 이벤트(최대 30일치)가 한꺼번에 비움 대상이 된다. 비용은 측정하지 않았다. 비운 값은 복원하지 못한다.

4. **작업 행·Key·지문의 보존 기간(30일)은 줄이지 않는다.**
   - 문제: 개인정보 최소화를 이유로 `MAILO_RECORD_RETENTION_SECONDS`를 줄이자는 안이 나올 수 있다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 30일 유지 | 권고. 결정 2·3 뒤 작업 행에 남는 것은 Key, HMAC 지문, 시각, 상태, 호출처·계정 ID다. 주소·제목·본문이 없다. 이 기간은 relay 재전달 멱등성(ADR-0005 결정 7)이 정한다 |
     | B. 기본값을 줄인다(예: 14일) | 호출처의 최대 재시도 기간(7일 이하)과 JWS 허용 기간의 여유가 줄고 얻는 것이 없다 |

   - 결정 문구(A): 기본값과 검사 규칙(`MAILO_RECORD_RETENTION_SECONDS` ≥ 본문 유예, ≥ 요청 TTL 상한)을 그대로 둔다. 운영자가 줄이는 것은 기존대로 허용한다.
   - 위험: 지문(HMAC-SHA256)은 키와 후보 입력이 있으면 대조할 수 있다. 지문 키는 DB와 분리해 보관한다(ADR-0005 결정 3). 이 한계는 바뀌지 않는다.

5. **결과 불명의 범위는 현재 두 조건(`LEASE_EXPIRED`, DATA 단계 응답 없는 `TRANSIENT`)을 단일 정의로 고정한다. 범위를 좁히지 않는다.**
   - 문제: 요청이 `fail`을 고르면 이 정의가 "재발송하지 않을 시도"의 기준이 된다. 정의가 넓으면 보내지 않은 메일을 종결하고(손실), 좁으면 보낸 메일을 재발송한다(중복).
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 현재 두 조건을 유지하고 `outcomeUncertain`과 정책이 같은 정의를 쓴다 | 권고. 한 정의라 표시와 정책이 어긋나지 않는다. 이미 RQ-048이 통합 테스트로 확인했다 |
     | B. DATA 단계를 354 대기와 본문 뒤 최종 응답 대기로 나눠 앞쪽은 불명에서 뺀다 | `StageTracker`가 이미 두 구간을 추적하지만 `stage` 값 `DATA`와 지표 라벨(`stage="data"`)이 바뀐다. nodemailer 오류가 두 구간을 구분해 주는지 확인하지 않았다 |
     | C. 전송 시작 표지(DB 쓰기)를 점유 직후 남겨 `LEASE_EXPIRED`가 전송 전인지 구분한다 | 시도마다 쓰기가 늘고 점유와 전송 사이 구간이 밀리초라 얻는 것이 작다 |

   - 결정 문구(A): 불명 시도는 `classification = 'LEASE_EXPIRED'`이거나 (`TRANSIENT`이고 `stage = 'DATA'`이고 응답 코드 없음)이다. 구현은 `UNCERTAIN_ATTEMPT`(SQL)와 같은 조건을 `applyOutcome`에서 쓰는 함수 하나로 두고 두 곳이 같은 조건임을 테스트가 확인한다.
   - 위험: `LEASE_EXPIRED`는 점유 직후 프로세스가 죽어 전송 전이었던 경우도 포함한다. `fail`이면 보내지 않은 메일이 종결될 수 있다(손실 쪽). 이 한계는 호출처 문서에 쓴다. 서버가 응답했는데 Mailo가 받지 못한 경우처럼 두 조건 밖의 불명은 정책 대상이 아니다(RQ-048 한계와 같다).

6. **요청에 선택 필드 `onUncertainOutcome`(`retry` 또는 `fail`)을 둔다. 생략하면 `retry`(현재 동작)이다. `fail`이면 결과 불명 시도 뒤 재시도하지 않고 종결한다.**
   - 문제: 같은 호출처의 메일도 종류에 따라 중복과 손실의 비용이 다르다. 현재는 모든 요청이 불명 뒤 재시도(at-least-once)다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 현재 유지(표시만) | 호출처는 중복을 막을 수 없다. 종결 뒤에야 `outcomeUncertain`을 안다 |
     | B. 요청별 opt-in 필드 | 권고. 메일 종류별로 고른다. 우선순위(ADR-0009), TTL(ADR-0010)과 같은 방식이라 검증·지문·배포 순서를 재사용한다 |
     | C. 호출처 레지스트리의 기본값 | 같은 호출처의 메일 종류가 섞이면 맞지 않는다. 작업이 등록 때 값을 고정해야 해서 B와 저장 방식이 같다 |
     | D. 전역 설정 | 모든 호출처의 보장을 한꺼번에 바꾼다. 하위 호환을 깬다 |
     | E. 불명 뒤 재시도 횟수 상한(`maxUncertainRetries`) | 값이 하나 더 늘고 0이 `fail`과 같다. 요구가 나올 때까지 보류한다 |

   - 결정 문구(B):
     - 위치는 `priority`·`ttlSeconds`와 같은 최상위 평문 필드다. Mailo가 판정에 쓰므로 평문이다. JWE `content`의 복호화 평문에 있으면 기존 규칙대로 `UNKNOWN_FIELD`다. 파일 JWS는 요청 JSON 전체를 서명하므로 이 필드도 서명 대상이다.
     - 허용 값은 문자열 `retry`, `fail`이다(대소문자 구분). 그 밖의 값은 검증 오류다. REST는 400(위치 `/onUncertainOutcome`), 파일은 수집 거부다. 오류에 요청 값을 넣지 않는다(RQ-027).
     - 지문은 지정했을 때만 `policy.onUncertainOutcome`에 값을 넣는다(ADR-0010 결정 4와 같다). 생략과 `retry` 명시는 다른 요청이다. 형식 태그 `mailo-fp-v1`을 올리지 않는다. 같은 Key에 다른 값을 보내면 REST는 409, 파일은 지문 불일치 거부다.
     - 호출처 레지스트리 기본값은 만들지 않는다.
   - 위험: `fail`을 쓴 요청은 불명 구간에서 메일이 나갔는데도 종결되거나 나가지 않았는데도 종결될 수 있다(결정 5). 정확히 한 번을 보장하지 않는다. 호출처는 종결 뒤 새 Key로 다시 보낼지 판단한다.

7. **`fail`로 종결한 작업은 `FAILED`이고 `failureReason`은 `OUTCOME_UNKNOWN`, `outcomeUncertain`은 `true`다. 새 상태를 만들지 않는다.**
   - 문제: 호출처가 이 종결을 다른 실패와 구분해야 하고, 호출처 상태 기계가 깨지면 안 된다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. `FAILED` + 새 사유 `OUTCOME_UNKNOWN` | 권고. 종결 상태 집합이 그대로라 `FAILED`를 종결로 처리하는 호출처가 깨지지 않는다. 사유 값 하나가 늘 뿐이고 모르는 값을 무시·성공 처리하지 않는다는 규칙이 이미 있다(`docs/api/README.md`) |
     | B. 새 상태 `UNKNOWN` | 호출처와 샘플의 상태 처리를 모두 고쳐야 한다. `CANCELED` 때 겪은 선행 조건(ADR-0011 결정 4)이 다시 필요하다 |
     | C. `EXPIRED` | 만료 의미(시간 도달)와 다르다 |
     | D. 새 이벤트 종류 | 같은 상태 변경에 이벤트 두 종류가 생긴다. 종결 이벤트는 `JOB_FAILED` 하나로 충분하다 |

   - 결정 문구(A): DB `failure_reason`에 `OUTCOME_UNKNOWN`을 쓰고(컬럼에 CHECK가 없다), 응답 이름도 `OUTCOME_UNKNOWN`이다(`FAILURE_REASON` 변환표는 모르는 값을 그대로 낸다). `lastError`는 불명을 만든 시도의 분류(`LEASE_EXPIRED` 또는 `TRANSIENT`와 코드 없음)다. `JOB_FAILED` 이벤트를 같은 트랜잭션에서 쓴다.
   - 위험: `openapi.yaml`의 `FailureReason` enum은 닫혀 있다(`additionalProperties: false`의 `Job`). 값 추가는 호출처 계약 변경이다. Java 샘플은 `failureReason`을 문자열로 읽는다(`EventFeedPoller`, `NeedsCheckResolver`, 읽기만 했다). 저장소 밖 호출처는 확인하지 못했다.

8. **`fail`의 판정은 `applyOutcome`의 `TRANSIENT`·`LEASE_EXPIRED` 분기에서 `retryOrFinish`보다 먼저 한다. 만료·소진과 겹쳐도 `OUTCOME_UNKNOWN`이 우선한다.**
   - 문제: ADR-0002 결정 7의 판정 순서(영구 오류 → 소진 → 만료 → 재시도)에 새 판정을 어디에 둘지 정해야 한다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. `retryOrFinish` 앞(만료·소진보다 먼저) | 권고. 불명이면서 마지막 시도였던 작업도 `OUTCOME_UNKNOWN`으로 남아 호출처가 메일이 나갔을 수 있음을 사유로 안다 |
     | B. `retryOrFinish` 뒤(재시도로 갈 때만) | 소진·만료로 끝난 작업은 `outcomeUncertain`으로만 알린다. 사유가 일관되지 않다 |

   - 결정 문구(A):
     - 조건: 작업의 `on_uncertain`이 `fail`이고 결과 분류가 불명(결정 5)이다. 영구 오류, 계정 상태 오류, 내부 오류, `SENT`는 해당하지 않는다.
     - 동작: `target = FAILED`, `failureReason = OUTCOME_UNKNOWN`. 시도는 기존 규칙대로 횟수에 넣는다(`LEASE_EXPIRED`와 `TRANSIENT`는 포함). 차단기는 기존 분기 그대로다(`LEASE_EXPIRED`는 건드리지 않고 `TRANSIENT`는 `recordAccountOk`).
     - 적용 경로는 결과 기록(`completeAttempt`)과 lease 회수(`recoverExpiredLeases`) 둘이고 둘 다 `applyOutcome`을 거치므로 한 곳에서 판정한다.
     - 종결 UPDATE는 결정 2와 같은 문장에서 본문·수신자를 비운다.
     - `retry`(기본)는 코드 경로가 현재와 같다.
   - 위험: 종료(배포) 때 drain 상한을 넘긴 전송은 lease 회수로 `LEASE_EXPIRED`가 되고 `fail` 작업은 종결한다. `stop_grace_period`와 lease 규칙(ADR-0002 결정 12, 기동 검사)을 지키지 않으면 `fail` 요청의 손실이 배포마다 생긴다. 이 판정은 큐 SQL·판정 순서 변경이라 직접 작업이 아니다.

9. **작업은 등록 때 `on_uncertain`을 고정한다. 마이그레이션은 컬럼 하나이고 배포는 모든 인스턴스를 바꾼 뒤 호출처가 필드를 보내기 시작한다.**
   - 문제: 전송 때 요청을 다시 볼 수 없다(본문은 암호문, 요청 필드는 저장하지 않는다). 값을 작업 행에 둬야 한다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. `mail_jobs.on_uncertain text NOT NULL DEFAULT 'retry'` + `CHECK (on_uncertain IN ('retry','fail')) NOT VALID` | 권고. `priority`(`0004`)·`account_id`(`0010`)와 같은 방식이다. 상수 DEFAULT 컬럼 추가는 PostgreSQL 11 이상에서 테이블을 다시 쓰지 않는다(문서 기준, 미측정) |
     | B. `envelope` jsonb에 넣는다 | 결정 2가 종결 때 `envelope`를 비우므로 값이 사라진다. 판정 열을 jsonb 안에 숨긴다 |

   - 결정 문구(A):
     - 마이그레이션 번호는 승인 때 구현 순서에 맞춰 정한다(현재 마지막 `0016`). 결정 3의 마이그레이션(컬럼과 부분 인덱스)이 먼저면 이 컬럼은 그 다음 번호다.
     - 등록 SQL(`register.ts`)의 열거에 `on_uncertain`을 더한다. 구버전은 컬럼을 열거해 읽고 쓰므로 새 컬럼을 무시한다. 구버전 INSERT는 DEFAULT `retry`가 된다.
     - 배포 순서: (1) 마이그레이션 적용, (2) 모든 Mailo 인스턴스를 새 버전으로 교체, (3) 호출처가 `onUncertainOutcome` 전송을 시작한다. 구버전은 이 필드를 `UNKNOWN_FIELD`로 거부한다. 롤링 중에 구버전 Worker가 `fail` 작업의 결과를 기록하면 `retry`처럼 재시도한다. 그래서 (3)은 (2)가 끝난 뒤다.
     - 롤백 전에 호출처가 전송을 먼저 끊는다. 끊지 않으면 REST는 400, 파일은 수집 거부다. 컬럼은 남긴다.
   - 위험: 롤백 뒤에도 `OUTCOME_UNKNOWN`으로 종결한 작업은 `FAILED`로 남고 구버전이 사유 문자열을 그대로 낸다(`FAILURE_REASON[stored] ?? stored`). `ALTER TABLE ... ADD COLUMN`의 짧은 `ACCESS EXCLUSIVE` 잠금 대기는 측정하지 않았다(`0010`·`0011`과 같은 미검증).

10. **호출처 계약과 안내를 함께 바꾼다. `FailureReason`에 `OUTCOME_UNKNOWN`을 더하고, 요청 스키마에 `onUncertainOutcome`을 더하며, 사용 기준 표를 문서에 둔다. 신규 지표는 선택으로 둔다.**
    - 문제: 필드를 아는 호출처만 쓸 수 있고, 어떤 메일에 `fail`을 쓸지는 호출처가 판단한다.
    - 결정 문구:
      - `openapi.yaml`의 요청 스키마(REST·파일 공통 최상위 필드)와 `FailureReason`을 고친다. `docs/api/README.md` "결과 불명 실패", `caller-onboarding.md` "결과 불명 실패", `troubleshooting.md`의 결과 불명 절과 SQL(`failure_reason = 'OUTCOME_UNKNOWN'`)을 같은 변경에서 갱신한다.
      - 사용 기준 표를 `caller-onboarding.md`에 둔다.

        | 메일의 성격 | 권고 |
        | ----------- | ---- |
        | 같은 코드·링크가 두 번 가면 혼란이나 보안 문제가 되는 메일(일회용 인증 코드) | `fail`. 종결 뒤 사용자가 다시 요청하게 한다 |
        | 두 번 가면 신뢰가 깨지는 확인 메일(결제 영수증) | `fail`과 호출처의 사후 확인을 함께 쓴다 |
        | 늦게 가도 한 번은 가야 하는 메일(공지, 알림) | `retry`(기본) |

      - 호출처 문서에 `fail`의 한계를 쓴다. 보내지 않은 메일이 종결될 수 있고(결정 5), 메일이 나갔는데 `OUTCOME_UNKNOWN`이 올 수 있다. 정확히 한 번은 보장하지 않는다.
      - 지표 `mailo_jobs_finished_total{status="failed"}`는 사유를 구분하지 않는다. 선택으로 인스턴스 counter `mailo_jobs_outcome_unknown_total`(라벨 `caller_id`, `account_id`)을 더하면 `OUTCOME_UNKNOWN` 급증에 알림을 걸 수 있다. 승인 때 포함 여부를 정한다.
    - 위험: 새 필드와 enum 값은 계약 변경이다. 모르는 값을 처리하지 못하는 호출처는 구현 전에 확인한다(ADR-0011 선행 조건과 같은 방식). 정책 필드를 보내는 호출처가 없으면 `OUTCOME_UNKNOWN`은 나오지 않는다. 기존 호출처에는 영향이 없다.

## 구현 순서

이 ADR이 승인된 뒤의 순서다. 작업 방식은 `AGENTS.md`의 "작업 실행"을 따른다.

- 결정 2·8·9는 큐 SQL·판정 순서·마이그레이션을 바꾸므로 직접 작업이 아니다. 결정 3은 새 정리 단계와 계약을 바꾼다. 결정 1·10의 문서는 코드와 같은 변경에서 갱신한다.
- 묶음 B·D가 같은 파일(`queue/complete.ts`)을 바꾸므로 순차로 한다. 로드맵 단계 하나이고 DELTA가 5개 안팎이라 `rubber-workflow`를 권고한다. 묶음 A·B·C(개인정보)와 D(결과 불명)를 LEG 둘로 묶을 수 있다.
- `docs/agents/rubber-workflow.md`, `qq-workflow.md`, `workflow-shared.md`, `verification.md`는 이 브랜치(`dev` 분기)에 없다. 시작 전에 해당 브랜치에서 가져오거나 `AGENTS.md`의 링크를 확인한다.

| 묶음 | 내용 | 마이그레이션 | 독립 리뷰 지점 |
| ---- | ---- | ------------ | -------------- |
| A. 문서 | 결정 1: `data-retention.md`, 호출처 Key·파일 이름 안내, `operations/README.md` 링크. 이후 묶음의 표 갱신은 각 묶음이 한다 | 없음 | 표가 코드와 같은지, 로그·백업 한계 표기 |
| B. 종결 때 비움 | 결정 2: `applyOutcome`·`sweepExpired`·`cancelWithin`의 UPDATE, 이벤트용 수신자 갱신 전 값 읽기, `MAILO_BODY_RETENTION_SECONDS` 의미 갱신, RQ-023 문구 | 없음 | `RETURNING` 갱신 전·후 값, 잠금 순서, 종결 직후 canary, 롤링 중 구버전 종결 행 |
| C. 이벤트 수신자 비움 | 결정 3: 정리 단계 `recipients`, 설정과 기동 검사, 이벤트 `recipientsRedacted`, `openapi.yaml`, RQ-016·017 문구 | 컬럼 하나, 부분 인덱스 하나(`CREATE INDEX CONCURRENTLY`, 별도 파일 `-- mailo:no-transaction`) | 비운 값이 피드 순서·공백 감지에 영향을 주는지, 비용 측정, 계약 변경 |
| D. 결과 불명 opt-in | 결정 5~10: `onUncertainOutcome` 검증·지문·등록, `on_uncertain` 컬럼, `applyOutcome` 판정, `OUTCOME_UNKNOWN`, 계약·문서, 지표(선택), RQ-048 문구 | 컬럼 하나 | 판정 순서, lease 회수 경로, 롤링 중 구버전, 지문 골든 테스트, 샘플 영향 |

순서는 A → B → C이고 D는 B 뒤에 시작한다(`complete.ts` 충돌). C와 D는 서로 독립이다.

```txt
묶음 A
위험도: 낮음 (문서)
롤백: 문서를 이전 커밋으로 되돌린다

묶음 B
위험도: 중간 (점유·완료 경로의 핵심 UPDATE, 마이그레이션 없음)
롤백: 이전 버전으로 교체한다. 이미 비운 종결 행의 본문·수신자·봉투는 복원하지 못한다(읽는 코드가 없는 종결 행이다)

묶음 C
위험도: 중간 (이벤트 행 첫 UPDATE, 호출처 계약 변경, 마이그레이션 2개)
롤백: 코드는 이전 버전으로 교체할 수 있다. 컬럼과 인덱스는 구버전이 무시하므로 남긴다. 이미 비운 이벤트·시도의 수신자는 복원하지 못한다(백업 복원만 가능)

묶음 D
위험도: 높음 (판정 순서와 큐 SQL, 지문 policy, 호출처 계약)
롤백: 호출처가 필드 전송을 먼저 끊고 이전 버전으로 교체한다. 컬럼은 남긴다. OUTCOME_UNKNOWN으로 종결한 작업은 FAILED로 남는다
```

## 검증 계획

구현 때 다음을 확인한다. 이 ADR은 아무것도 실행하지 않았다.

- 묶음 B(PostgreSQL 통합): 결과 기록·lease 회수·만료 sweep·취소 직후 행의 `body_*`, `recipients`, `envelope` canary가 비어 있다. 이벤트의 `recipients`는 갱신 전 값이다. 구버전이 종결한 행(본문 있음)을 `deleteExpiredBodies`가 여전히 비운다.
- 묶음 C: 유예가 지난 이벤트만 비워지고 지나지 않은 이벤트는 그대로다. 시도의 `rejected_recipients`가 함께 비워진다. 비운 이벤트가 같은 cursor 위치로 읽히고 `recipientsRedacted`가 `true`다. 공백 감지(`Mailo-Cursor-Gap`)가 바뀌지 않는다. 설정이 보존 기간을 넘으면 기동을 거부한다.
- 묶음 D: `retry`는 현재 판정과 같다(회귀 테스트). `fail`이고 `LEASE_EXPIRED`, DATA 단계 응답 없는 `TRANSIENT`면 `FAILED`·`OUTCOME_UNKNOWN`·`outcomeUncertain: true`다. `fail`이어도 `550` 응답, DATA 이전 단계 오류, 내부 오류는 기존 판정이다. 만료·소진과 겹쳐도 `OUTCOME_UNKNOWN`이다. 지문: 도입 전 지문이 바이트 단위로 같다(골든), 같은 Key에 다른 값은 409. 파일 채널의 거부 사유.
- 실제 Worker와 가짜 SMTP: DATA 뒤 연결 끊김(`dropAfterData`, `test/e2e/mail-flow.integration-spec.ts`)에서 `fail`이면 재발송 없이 종결하고 SMTP가 받은 메일이 한 통이다.
- 시크릿(RQ-027): 위 경로의 로그·이벤트·응답에 본문·주소 canary가 없다.
- 측정(묶음 C): 로컬 임시 schema에서 이벤트 20만 건의 비움 배치 시간과 죽은 행, HOT 비율을 한 번 잰다. 운영 크기는 확인하지 않았다고 적는다.
- 문서: 금지 표기 검사(`docs/agents/writing-styles.md` "검증"), 새 링크의 존재 확인.

## 검토한 대안

| 결정 | 대안 | 채택하지 않은 이유 |
| ---- | ---- | ------------------ |
| 1 | Key에 개인정보 패턴을 거부하는 검증 | 형식이 이미 `@`를 막는다. 이름·전화번호 조각은 규칙으로 잡지 못한다 |
| 2 | 본문 유예 기본값만 단축 | 수신자·봉투가 남고 추가 `UPDATE`가 남는다 |
| 2 | 키 폐기로 본문 일괄 무효화 | `key_version` 단위라 비종결 작업까지 읽지 못한다. 수신자는 평문이라 효과가 없다 |
| 3 | 건수만 남김 | 쓰는 곳이 없고 계약 필드가 늘어난다 |
| 3 | 수신자 HMAC | 키 파생과 분실·교체 절차가 늘고 조회 수요가 없다. 후보 주소가 있으면 되돌려 확인된다 |
| 3 | 이벤트 행을 7일 뒤 삭제 | 피드 보존 30일과 공백 감지를 깬다 |
| 4 | 작업 행 보존 단축 | relay 재전달 멱등성이 줄고 남은 값에 주소·본문이 없다 |
| 5 | DATA 하위 단계 분리 | `stage` 값과 지표 라벨이 바뀐다. nodemailer 오류의 구간 구분을 확인하지 않았다 |
| 5 | 전송 시작 표지 | 시도마다 쓰기 한 번이 늘고 구분 구간이 밀리초다 |
| 6 | 호출처 기본값, 전역 설정 | 메일 종류별로 안 맞거나 하위 호환을 깬다 |
| 6 | 불명 뒤 재시도 횟수 상한 | 값이 늘고 0이 `fail`과 같다. 요구가 나올 때까지 보류 |
| 7 | 새 상태 `UNKNOWN`, `EXPIRED`로 종결 | 호출처 상태 기계를 깨거나 만료 의미와 다르다 |
| 8 | `retryOrFinish` 뒤에 판정 | 소진·만료로 끝난 작업의 사유가 일관되지 않는다 |
| 9 | `envelope`에 정책 저장 | 결정 2가 `envelope`를 비운다 |
| 전체 | 재시도 중 불명 이벤트(`JOB_ATTEMPT_UNCERTAIN`) | 이벤트는 종결만 낸다(ADR-0006 결정 2). 재시도 중 불명은 `GET /jobs`로 본다 |

## 결과

- 종결한 작업의 본문·수신자·봉투가 종결 UPDATE에서 사라진다. 이벤트·시도의 수신자는 유예(기본 7일) 뒤 사라진다. 구현이 끝나면 작업 행에 남는 것은 Key, 지문, 상태, 시각, 호출처·계정 ID다.
- 본문 삭제용 `UPDATE`가 새 종결 행에서는 사라진다. 이벤트 행의 `UPDATE`가 새로 생긴다. 쓰기량 변화는 측정하지 않았다.
- 호출처는 요청마다 중복과 손실 중 하나를 고를 수 있다. `fail`은 정확히 한 번이 아니다. 불명 구간에서만 재발송을 막는다.
- 호출처 계약이 바뀐다. 이벤트의 `recipientsRedacted`, 요청의 `onUncertainOutcome`, `FailureReason`의 `OUTCOME_UNKNOWN`이다. 필드를 쓰지 않는 호출처에는 영향이 없다. 이벤트의 수신자를 유예 뒤에도 기대하는 호출처는 영향을 받는다.
- 로그 수집기, DB 백업, 호출처 저장소의 개인정보는 Mailo가 지우지 못한다. 운영 문서가 그 경계를 쓴다.
- 새 npm 의존성이 없다. 마이그레이션은 컬럼 둘과 부분 인덱스 하나다.
- 이 ADR의 모든 동작은 구현하지 않았다.

## 새 RQ 번호

마지막 RQ는 RQ-069다. 승인 때 아래 번호로 정했다.

| 후보 | 내용 | 묶음 |
| ---- | ---- | ---- |
| RQ-070 | 개인정보 보존 현황 문서와 호출처 Key·파일 이름 안내 | A |
| RQ-071 | 종결 때 본문·수신자·봉투 즉시 비움 | B |
| RQ-072 | 이벤트·시도 수신자의 유예 뒤 비움과 `recipientsRedacted` | C |
| RQ-073 | 요청 필드 `onUncertainOutcome`과 지문·등록 고정 | D |
| RQ-074 | 결과 불명 `fail` 종결(`OUTCOME_UNKNOWN`)과 계약 변경 | D |

갱신할 기존 RQ: RQ-016, RQ-017, RQ-023, RQ-048. RQ-013(SMTP 중복 전송 한계)은 요청별 선택지를 가리키는 문장을 더한다.

## 하지 않는 것

| 항목 | 이유 | 재검토 조건 |
| ---- | ---- | ----------- |
| 수신자 HMAC·가명 저장 | 조회 수요가 없고 키 절차가 늘어난다 | 운영자나 호출처가 "이 주소로 간 작업"을 Mailo에서 조회해야 한다 |
| 특정 주소의 즉시 삭제 API | 호출처 요구가 없고 Key로 작업을 찾는 구조와 맞지 않는다 | 호출처 둘 이상이 삭제 요청 처리를 Mailo에 요구한다 |
| 작업 행·Key 보존 단축 | relay 재전달 멱등성이 정한다(결정 4) | 호출처 최대 재시도 기간이 7일보다 짧아진다 |
| 감사 테이블 자동 삭제 | 개인정보가 없다. ADR-0012 결정 8이 정하지 않기로 했다 | 행 수 지표가 운영상 문제를 낸다 |
| 로그·백업 보존을 Mailo 코드로 관리 | 수집기와 DB 운영의 몫이다 | |
| SMTP 수락 여부를 Mailo가 확인하는 수단(보낸편지함 조회 등) | 새 외부 의존이고 RQ-029와 맞지 않는다 | |
| 호출처 기본값·전역 `fail` | 결정 6의 이유 | 같은 호출처의 모든 메일이 같은 정책이라는 요구가 둘 이상 나온다 |
| 재시도 중 불명 이벤트 | 이벤트는 종결만 낸다 | 호출처가 `GET /jobs` 폴링으로 해결하지 못한다 |
| DATA 하위 단계 분리, 전송 시작 표지 | 결정 5의 이유 | 실제 Gmail에서 불명 오탐이 문제로 측정된다 |
| 운영자 재시도 API | ADR-0011 결정 5가 유지된다 | 로드맵 "보류하는 항목"을 따른다 |

## 미결정·확인하지 않은 것

### 사용자가 판단한 질문(승인됨)

2026-11-24에 사용자가 모두 권고대로 승인했다. 확정한 답은 "구현 중 확정"에 있다.

1. 이벤트·시도 수신자 비움의 유예 기본값(결정 3). 권고 7일. 대안은 1일(더 짧음)과 30일(끔).
2. 비운 수신자의 표현(결정 3). 권고 빈 목록과 `recipientsRedacted`. 대안은 건수 유지.
3. 종결 UPDATE에서 즉시 비움(결정 2, 권고 C)과 유예 기본값만 단축(B) 중 선택.
4. `onUncertainOutcome`을 요청별 필드로만 두는지(결정 6, 권고) 호출처 기본값도 둘지.
5. `fail` 종결 표현(결정 7). 권고 `FAILED` + `OUTCOME_UNKNOWN`. 대안은 새 상태.
6. `OUTCOME_UNKNOWN`을 만료·소진보다 우선하는지(결정 8, 권고 A).
7. 신규 지표 `mailo_jobs_outcome_unknown_total` 포함 여부(결정 10, 권고 포함).
8. 작업 방식(구현 순서). 권고 `rubber-workflow`, LEG 둘.

### 확인하지 않은 것

- 실제 Gmail·Workspace에서 DATA 단계 타임아웃·연결 끊김의 빈도, 같은 `Message-ID`의 중복 제거 여부.
- nodemailer 오류가 DATA 명령 응답 대기와 본문 뒤 최종 응답 대기를 구분하는지(결정 5의 선택지 B).
- 결정 3의 `UPDATE` 비용: 운영 크기(수백만 행), 다중 인스턴스, 마이그레이션 직후 30일치 백필, HOT 갱신 여부. 로컬 측정도 하지 않았다.
- `RETURNING`의 갱신 후 값 동작, 상수 DEFAULT 컬럼 추가가 테이블을 다시 쓰지 않는 것, `ADD COLUMN`의 잠금 대기. PostgreSQL 문서 지식이고 서버로 확인하지 않았다.
- 저장소 밖 호출처가 이벤트의 `recipients`를 유예 뒤에도 기대하는지, 모르는 `failureReason` 값과 새 필드를 처리하는지. Java 샘플은 `failureReason`을 문자열로 읽는 것만 확인했다.
- 롤링 배포 중 구·신 인스턴스 혼용과 롤백 실행.
- `response_text`(30일, 주소 형태만 가림)에 사용자 이름이 섞이는 빈도. 이 ADR은 `response_text`를 비우지 않는다. 운영 진단에 쓰는 값이라서다. 비우려면 별도 결정이 필요하다.
- 백업에서 복구한 DB의 정리 사이클 동작은 코드 읽기 결과이고 실행하지 않았다.
- `docs/agents/rubber-workflow.md` 등 작업 방식 문서는 이 브랜치에 없다. 읽지 못했다.

## 구현 중 확정

### 2026-11-24 승인

결정 문구는 바꾸지 않는다. "미결정·확인하지 않은 것"의 질문 8건에 대한 확정 답이다. 모두 권고와 같다.

| 질문 | 확정 | 관련 결정 |
| ---- | ---- | --------- |
| 1. 수신자 비움 유예 기본값 | 7일(추정). 설정은 `MAILO_RECIPIENT_RETENTION_SECONDS`(가칭) | 3 |
| 2. 비운 수신자의 표현 | 빈 목록과 `recipientsRedacted`. 건수는 남기지 않는다 | 3 |
| 3. 본문 비움 방식 | 종결 UPDATE에서 즉시 비운다. 유예 기본값 단축만 하는 안은 택하지 않는다 | 2 |
| 4. `onUncertainOutcome` 지정 단위 | 요청별 필드만 둔다. 호출처 기본값은 만들지 않는다 | 6 |
| 5. `fail` 종결 표현 | `FAILED` + `failureReason: OUTCOME_UNKNOWN`. 새 상태는 만들지 않는다 | 7 |
| 6. 판정 순서 | `OUTCOME_UNKNOWN`이 만료·소진보다 우선한다 | 8 |
| 7. 신규 지표 | `mailo_jobs_outcome_unknown_total`을 포함한다 | 10 |
| 8. 작업 방식 | `rubber-workflow`, LEG 둘(개인정보 A·B·C, 결과 불명 D) | 구현 순서 |

- 이번 구현 범위는 묶음 A와 B다. 묶음 C·D는 별도 지시 전에 시작하지 않는다.
- 묶음 A(문서)와 B(종결 때 비움)는 이 승인 뒤에 따로 구현했다. 결과는 아래 묶음별 절이다.

### 2026-11-24 묶음 B(결정 2)

결정 문구는 바꾸지 않는다. 코드는 `queue/complete.ts`, `queue/maintenance.ts`, `queue/cancel.ts`다.

- 종결 UPDATE 세 곳이 본문 세 열, `body_deleted_at`, `recipients`(`'{}'`), `envelope`(`'{}'`)를 같은 문장에서 비운다. 결과 기록과 lease 회수는 둘 다 `applyOutcome`을 거쳐 UPDATE가 한 곳이고, `terminal`이 참일 때만 비운다(`RETRY_WAIT`은 그대로).
- 이벤트용 수신자는 결과 기록·lease 회수가 잠그며 읽은 `job.recipients`다. 만료 sweep은 잠근 CTE `due`에서 비우기 전 값을 읽어 `RETURNING due.recipients`로 쓴다. 취소는 잠근 CTE `target`을 쓰고 UPDATE에도 상태 조건(`PENDING`·`RETRY_WAIT`)을 둔다. 잠금을 기다린 뒤 `claim`이 먼저 `SENDING`으로 바꿨으면 갱신하지 않고 기존 `not_cancelable` 분기로 간다(기존 통합 테스트가 통과했다).
- 마이그레이션이 없다. `recipients`는 `NOT NULL`이라 NULL 대신 `'{}'`를 쓴다. `mail_jobs_body_state` CHECK는 본문 세 열이 함께 NULL인 경우를 허용한다.
- `MAILO_BODY_RETENTION_SECONDS`와 `deleteExpiredBodies`는 그대로다. 대상은 이전 버전이 종결한 행뿐이다. 기본값, 기동 검사, 로그 이벤트 이름(`bodies_deleted`)은 바뀌지 않았다.
- 설계에서 ADR과 어긋난 점은 없다. 쓰기량 변화(종결 UPDATE의 열 6개 추가, 본문 삭제용 UPDATE 제거)와 롤링 배포는 측정·실행하지 않았다.

### 2026-11-24 묶음 B 리뷰 반영

결정 문구는 바꾸지 않는다.

- 안전망 `deleteExpiredBodies`는 본문 세 열만 비운다. 이전 버전이 종결한 행과 배포 전에 이미 종결된 행의 `recipients`·`envelope`는 보존 삭제(`MAILO_RECORD_RETENTION_SECONDS`)까지 남는다. 결정 2는 "종결 전이의 같은 UPDATE"만 정했으므로 충돌하지 않는다. 앞당겨 비우는 선택 절차(배치 SQL, 위험도·롤백)를 `docs/operations/db-maintenance.md`에 두었다. 안전망 자체를 수신자·봉투까지 넓히는 코드 변경은 하지 않았다.
- 테스트를 더했다: 취소가 `claim`에 졌을 때 값 유지, `ACCOUNT_REPEATED`·계정 오류 `EXPIRED`·`internal: true` 종결의 비움, `from`·`replyTo` canary가 로그·응답·이벤트·시도 기록·작업 행에 없음.
- 같은 종류의 오래된 서술("본문은 종결 후 1일 지워진다")을 `.env.example`, `docs/operations/`, `mail-sending.md`, `roadmap.md`에서 이전 버전이 종결한 행 한정으로 고쳤다.

### 2026-11-24 묶음 A(결정 1)

결정 문구는 바꾸지 않는다. 문서만 바꿨고 코드·마이그레이션은 없다.

- `docs/operations/data-retention.md`(새 문서)에 개인정보 항목 정의, 위치별 보존 현황 표, 보존 설정과 기동 검사, Mailo 밖에 남는 것, 호출처 안내, 위험 작업(개인정보 삭제 요청은 지원하지 않음, 보존 기간 단축, 수동 삭제, 덤프와 복원)을 썼다. 표의 근거는 코드·마이그레이션 읽기와 기존 통합 테스트다. 이 문서는 실행하지 않은 것을 "확인하지 않은 것"에 적었다.
- `caller-onboarding.md`에 Key와 파일 이름에 사람을 식별하는 값을 넣지 말라는 안내를 더했다. `operations/README.md`, `deployment.md` "백업과 복구", `db-maintenance.md`가 새 문서를 가리킨다.
- 표는 묶음 B(종결 때 비움)가 들어간 코드(`queue/complete.ts`, `queue/maintenance.ts`, `queue/cancel.ts`)로 대조했다. 이전 버전이 종결한 행과 배포 전에 이미 종결된 행은 수신자·봉투가 보존 삭제까지 30일 남는다고 적고 `db-maintenance.md`의 백필 절과 연결했다. 이벤트·시도 수신자의 유예 뒤 비움(묶음 C)이 들어가면 같은 변경에서 표를 고친다.

### 2026-11-24 묶음 C(결정 3)

결정 문구는 바꾸지 않는다. 코드는 `queue/maintenance.ts`(`redactEventRecipients`), `worker/worker.ts`(정리 루프), `events/event-store.ts`·`intake/presenters.ts`(응답), `config/load-config.ts`(설정), 마이그레이션 `0017`·`0018`이다.

- 마이그레이션: `0017_event_recipients_redacted_at.sql`은 `mail_events.recipients_redacted_at timestamptz`(NULL 허용, 기본값 없음)를 `ADD COLUMN IF NOT EXISTS`로 더한다. `0018_event_recipients_redact_idx.sql`(`-- mailo:no-transaction`, 문장 하나, `IF NOT EXISTS`)은 `mail_events_recipients_redact_idx ON mail_events (created_at, id) WHERE type IN ('JOB_SENT','JOB_FAILED','JOB_EXPIRED','JOB_CANCELED') AND recipients_redacted_at IS NULL`을 만든다. 비운 이벤트는 인덱스에서 빠진다. 비움 쿼리의 조건은 이 정의와 글자 그대로 같다. 번호는 결정 9가 말한 "결정 3의 마이그레이션이 먼저"에 따라 `0017`·`0018`이고 결과 불명 컬럼은 그 뒤 번호다.
- 설정 이름은 `MAILO_RECIPIENT_RETENTION_SECONDS`로 확정했다(가칭 해제). 기본 7일, 범위 60 이상 `MAILO_RECORD_RETENTION_SECONDS` 이하, 기동 때 검사한다. 한 가지를 정했다. 이 변수를 주지 않았고 `MAILO_RECORD_RETENTION_SECONDS`가 7일보다 짧으면 기본값을 보존 기간으로 줄인다. 그렇지 않으면 이 변수를 모르는 기존 설정(예: 보존 1일)이 업그레이드만으로 기동을 거부한다. 명시한 값은 줄이지 않고 범위 밖이면 거부한다. 결정 문구의 검사 규칙과 충돌하지 않는다.
- 비움은 한 SQL 문장(CTE 셋)이다. 대상 선택, `mail_events` 갱신(`recipients = '{}'`, `rejected_recipients = NULL`, `recipients_redacted_at = now()`), 같은 작업의 `mail_attempts.rejected_recipients` NULL 갱신이 한 트랜잭션이다. 시도 행의 나머지 열(응답 코드, 마스킹한 응답 텍스트)은 남긴다. 오래된 이벤트부터(`created_at`, `id`) 처리하고 멱등이다(`recipients_redacted_at IS NULL`).
- 잠금: 정리 단계 `recipients`(advisory lock 키 5) 뒤에 이벤트의 작업 행을 `FOR KEY SHARE OF j SKIP LOCKED`로 잡는다. 결정 3은 잠금을 정하지 않았다. 이 잠금이 없으면 비움(이벤트 → 시도 순으로 행 잠금)과 보존 삭제의 cascade(시도 → 이벤트 순)가 같은 작업에서 교착한다. 작업 400건·배치 100건으로 겹쳐 돌렸을 때 3번 모두 `deadlock detected`였다(PostgreSQL 17.11). 보존 삭제도 작업 행을 `FOR UPDATE SKIP LOCKED`로 먼저 잡으므로 두 단계가 같은 작업을 겹쳐 잡지 못한다. 차단기 행은 건드리지 않아 잠금 순서(작업 행 → 차단기 행)는 그대로다.
- 단계 순서: 정리 루프의 정리 블록에서 본문 삭제, 보존 삭제 뒤에 돈다. 보존 삭제가 지울 행을 먼저 지워 비움이 그 행을 건드리는 낭비를 줄인다. 한 단계 처리 상한은 보존 삭제와 같다(배치 1000건, 사이클당 20배치). 로그 이벤트는 `recipients_redacted`(info, `count`)와 `recipients_redacted_failed`(error)이고 주소는 없다.
- 피드: 비움은 `id`·`txid`·`created_at`을 바꾸지 않고 삭제 표지(`mail_event_purges`)를 쓰지 않는다. 같은 cursor로 읽으면 같은 이벤트가 같은 순서로 오고 공백 감지는 바뀌지 않는다.
- 응답: `JOB_SENT`·`JOB_FAILED`·`JOB_EXPIRED`·`JOB_CANCELED`에 `recipientsRedacted`를 항상 낸다. 비운 이벤트의 `recipients`는 `to`·`cc`·`bcc` 빈 배열이고 `rejectedRecipients`는 빈 배열이다. `Job.rejectedRecipients`는 시도 기록에서 읽으므로 비운 뒤 빈 배열이고 `Job`에 새 필드는 없다. `INTAKE_REJECTED`에는 이 필드가 없다. `openapi.yaml`, `docs/api/README.md`, `caller-onboarding.md`를 같은 변경에서 고쳤다.
- 측정(로컬 PostgreSQL 17.11 임시 schema, 이벤트·시도 20만 건, 한 번): 비움 201배치 9.3초, 배치 중앙값 37ms, 최대 1.9초. `mail_events` 갱신은 HOT 0%(갱신 열이 부분 인덱스 조건에 들어간다는 결정 3의 예상과 같다), `mail_attempts`는 97.8%였다. 값과 한계는 `docs/operations/db-maintenance.md` "수신자 비움 측정"이다.
- 설계에서 ADR과 어긋난 점은 없다. 실행하지 않은 것: 롤링 배포(구·신 인스턴스 혼용)와 롤백, 운영 크기·다중 인스턴스에서의 백필 비용, `ADD COLUMN` 잠금 대기, 저장소 밖 호출처가 유예 뒤 빈 수신자와 `recipientsRedacted`를 처리하는지.
