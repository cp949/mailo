# 요청별 만료 시간은 상대값 ttlSeconds로 받고, 등록 때 DB 시각으로 만료 시각을 고정한다

## 상태

승인됨 (2026-11-23)

결정 1~7을 2026-11-23에 구현하고 자동 테스트로 검증했다. 결정 8의 롤링 배포·롤백은 실행하지 않았다. 요구사항은 RQ-039다. 구현 중 확정한 내용은 "구현 중 확정" 절에 모았다.

- ADR-0002 결정 7의 "요청별 지정은 미결정이다"를 이 ADR의 결정 1·2가 정한다. 만료 시각 계산 방식(등록 시각 + TTL, DB `now()`, 결정 10)은 바꾸지 않는다.
- ADR-0005 결정 3의 "요청별 정책 필드"로 `ttlSeconds`를 이 ADR의 결정 4가 추가한다. 형식 태그 `mailo-fp-v1`과 정규화 규칙은 바꾸지 않는다.
- ADR-0009 결정 4(`policy.priority`)와 같은 `policy` 맵을 쓴다. ADR-0009의 결정 문구는 바꾸지 않는다.

## 배경

현재 동작은 다음과 같다(2026-11-23, `apps/mailo/src/config/load-config.ts`·`queue/register.ts`·`queue/claim.ts`·`queue/complete.ts`·`queue/maintenance.ts` 기준).

- 만료 TTL은 전역 설정 `MAILO_JOB_EXPIRY_SECONDS` 하나다. 기본 86400, 범위 1~31536000이다.
- 등록 때 `expires_at = now() + make_interval(secs => TTL)`로 만료 시각을 고정한다(ADR-0002 결정 10).
- 만료 판정은 세 곳이다.
  - claim은 `expires_at > now()`인 행만 점유한다.
  - 결과 기록 때 다음 시도 시각이 만료 시각보다 뒤이거나 이미 만료 시각이 지났으면 바로 `EXPIRED`다(ADR-0003 결정 6).
  - 주기 sweep이 만료된 `PENDING`·`RETRY_WAIT`를 `EXPIRED`로 바꾼다. `SENDING`은 건드리지 않는다.
- 기동 검사는 기록 보존(`MAILO_RECORD_RETENTION_SECONDS`) ≥ 만료 TTL이다.

호출처마다 메일의 유효 기간이 다르다.

- 인증·확인 메일은 몇 분 뒤 쓸모가 없다. 24시간 동안 재시도하면 늦게 도착한 메일이 혼란을 준다.
- 대기 알림은 하루를 넘겨도 보내야 한다. 일일 한도(`550 5.4.5`, `DAILY_LIMIT`)로 차단기가 길게 열리면 24시간 TTL에서 `EXPIRED`가 된다.

## 결정

1. **요청 필드는 최상위 평문 정수 `ttlSeconds`다.**
   - REST와 파일 요청의 선택 필드다. 위치와 규칙은 `priority`(ADR-0009 결정 1)와 같다.
   - Mailo가 만료 판정에 쓰는 값이라 평문 필드다. JWE `content`의 복호화 평문에 있으면 기존 규칙대로 `UNKNOWN_FIELD`다.
   - 파일 JWS는 요청 JSON 전체를 서명하므로 `ttlSeconds`도 서명 대상이다.
   - 절대 시각 필드(예: `expiresAt`)는 받지 않는다. 호출처 시계에 의존하면 ADR-0002 결정 10과 맞지 않는다.
2. **만료 시각은 등록 때 DB `now() + ttlSeconds`로 `expires_at`에 고정한다.**
   - 생략하면 `MAILO_JOB_EXPIRY_SECONDS`를 쓴다. 기존 동작과 같다.
   - 같은 Key로 다시 요청해도 만료 시각은 바뀌지 않는다. relay 재시도가 만료를 늘리지 않게 하기 위해서다.
3. **허용 범위는 정수 60 ≤ `ttlSeconds` ≤ `MAILO_JOB_EXPIRY_MAX_SECONDS`다.**
   - 새 설정 `MAILO_JOB_EXPIRY_MAX_SECONDS`의 기본값은 `MAILO_JOB_EXPIRY_SECONDS`의 실제 값이다. 설정하지 않으면 기본 TTL보다 긴 요청은 거부된다.
   - 상한의 최대값은 기존 만료 TTL 범위의 최대값 31536000을 따른다.
   - 기동 때 `MAILO_JOB_EXPIRY_SECONDS` ≤ `MAILO_JOB_EXPIRY_MAX_SECONDS`를 검사한다. 어기면 기동을 거부한다.
   - 하한 60은 요청 필드에만 적용한다. 운영자 기본값 `MAILO_JOB_EXPIRY_SECONDS`의 범위(1~31536000)는 그대로 둔다.
   - 범위 밖 값, 정수가 아닌 값, 문자열은 검증 오류다. REST는 400(위치 `/ttlSeconds`), 파일은 수집 거부다. 오류에 요청 값을 넣지 않는다(RQ-027).
   - 상한은 운영자가 큐 적체 기간을 통제하는 수단이다. 14일 같은 장기 대기를 허용할지는 운영자가 정한다.
4. **지문은 지정했을 때만 `policy.ttlSeconds`에 요청 값을 넣는다(ADR-0005 결정 3의 요청별 정책 필드).**
   - 생략한 요청은 `policy`에 키가 없다. 그래서 도입 전 지문과 바이트 단위로 같다. 형식 태그 `mailo-fp-v1`을 올리지 않는다.
   - 생략한 요청과 기본값을 명시한 요청은 다른 요청이다.
   - 같은 Key에 다른 `ttlSeconds`(생략 포함)를 보내면 지문이 달라진다. REST는 409, 파일은 지문 불일치 수집 거부다. 기존 작업은 바꾸지 않는다.
   - `priority`와 함께 쓰면 `policy` 키는 이름 순서로 정규화된다(`crypto/fingerprint.ts`의 `normalizePolicy`).
   - 도입 전 지문 값이 바뀌지 않음을 골든 테스트로 고정한다.
5. **만료는 "이 시각 이후 새 시도를 시작하지 않는다"이다.**
   - 만료 시각 이후에는 claim이 점유하지 않고, sweep이 `PENDING`·`RETRY_WAIT`를 `EXPIRED`로 바꾼다.
   - 전송 중(`SENDING`)에 만료 시각이 지나도 그 시도는 끝까지 간다. 성공하면 `SENT`다.
   - 그 시도가 재시도 대상 오류로 끝나면 재시도하지 않고 `EXPIRED`다.
   - 이 의미는 기존 동작(ADR-0002 결정 7, ADR-0003 결정 6)과 같다. 요청 TTL은 만료 시각만 바꾸고 판정 코드는 바꾸지 않는다.
6. **기동 검사의 기준을 "보존 ≥ 기본 TTL"에서 "보존 ≥ 상한"으로 바꾼다.**
   - `MAILO_RECORD_RETENTION_SECONDS` ≥ `MAILO_JOB_EXPIRY_MAX_SECONDS`를 검사한다. 상한 ≥ 기본 TTL이므로 기존 검사를 포함한다.
   - 요청이 상한까지 TTL을 늘릴 수 있기 때문이다. 보존이 그보다 짧으면 재시도 기간 안의 relay 재전달을 Key로 막지 못한다.
   - 보존은 종결 시각 기준이다. 종결 전 Key가 지워지지 않는다는 점은 바뀌지 않는다.
   - 상한을 생략한 기존 설정은 상한 = 기본 TTL이라 검사 결과가 기존과 같다.
7. **조회·이벤트 계약은 바꾸지 않는다.**
   - 작업 조회의 기존 `expiresAt`이 계산된 만료 시각을 그대로 보여 준다. 응답에 `ttlSeconds` 필드를 추가하지 않는다.
   - 이벤트 payload에 TTL을 넣지 않는다.
8. **배포 순서는 ADR-0009 결정 10과 같은 방식이다.**
   - 마이그레이션은 필요 없다. `expires_at` 컬럼이 이미 있다(`0001_queue_schema.sql`).
   1. 모든 Mailo 인스턴스를 새 버전으로 바꾼다. 상한을 늘리려면 이때 `MAILO_JOB_EXPIRY_MAX_SECONDS`를 함께 설정한다.
   2. 호출처가 `ttlSeconds` 전송을 시작한다.
   - 구 버전은 `ttlSeconds`를 `UNKNOWN_FIELD`로 거부한다. 롤링 배포 중(구·신 인스턴스 혼용)에는 호출처가 `ttlSeconds`를 보내지 않는다.
   - 롤백 전에 호출처의 `ttlSeconds` 전송을 먼저 끊는다. 끊지 않으면 REST는 400, 파일은 수집 거부가 된다.

## 구현 중 확정 (2026-11-23)

결정 문구는 바꾸지 않는다. 아래는 구현에서 정한 세부다.

1. **검증 오류 코드(결정 3, `src/envelope/request-schema.ts`).**
   - 정수가 아닌 값(소수, 문자열, `null`, boolean, 배열, 객체)은 `INVALID_FORMAT`이다.
   - 범위 밖 정수는 새 코드 `OUT_OF_RANGE`다. 호출처가 형식 오류와 범위 오류를 구분하게 하려는 것이다. 응답에는 상한 값도 넣지 않는다.
   - JSON `60.0`은 파싱 뒤 60이라 정수로 받는다.
   - 하한은 `MIN_TTL_SECONDS`(60) 상수, 상한은 `OpenRequestDeps.maxTtlSeconds`다. REST와 파일 채널이 같은 `openRequest`를 거친다.
2. **상한 설정의 범위(결정 3, `src/config/load-config.ts`).**
   - `MAILO_JOB_EXPIRY_MAX_SECONDS`의 허용 범위는 1~31536000이다. 최소값을 60이 아니라 1로 둔다. 기본 TTL이 60 미만인 기존 설정(예: 샘플 e2e의 15초)이 기본값(상한 = 기본 TTL)으로 기동을 거부되지 않게 하기 위해서다.
   - 상한이 60 미만이면 `ttlSeconds`를 지정한 요청은 모두 `OUT_OF_RANGE`다.
3. **등록 입력(결정 2, `src/envelope/register-input.ts`).**
   - `toRegisterInput`은 `ttlSeconds ?? defaultExpiresInSeconds`를 `RegisterInput.expiresInSeconds`로 넘긴다. 큐 등록(`queue/register.ts`)과 SQL은 바꾸지 않았다.
   - 같은 Key의 기존 행이 있으면 `ON CONFLICT DO NOTHING`이라 만료 시각을 다시 계산하지 않는다.
4. **만료 판정 위치(결정 5, 코드 확인).**
   - Worker는 claim 뒤 전송 전에 만료를 다시 보지 않는다. 판정 시점은 claim의 `expires_at > now()`다.
   - `sweepExpired`의 대상은 `PENDING`·`RETRY_WAIT`뿐이다(`queue/maintenance.ts`).
   - `completeAttempt`는 `SENT`를 만료와 무관하게 기록한다. 재시도 대상 결과는 `db_now >= expires_at`이거나 다음 시도가 만료 시각보다 뒤이면 `EXPIRED`다(`queue/complete.ts`의 `retryOrFinish`·`afterExpiry`).
5. **짧은 TTL과 재시도(결정 3·5).**
   - 기본 재시도 간격(`MAILO_RETRY_BASE_SECONDS` 60초, jitter ±20%)에서 `ttlSeconds` 60인 작업이 첫 시도에서 일시 오류를 받으면 대부분 재시도 없이 `EXPIRED`다. 다음 시도 시각이 만료 시각보다 뒤이기 때문이다.
   - 재시도 기회가 필요하면 TTL을 재시도 간격보다 충분히 길게 잡는다(`docs/operations/caller-onboarding.md` "요청별 만료 시간").
6. **검증.**
   - 단위: `test/envelope/open-request.spec.ts` "openRequest: 요청별 만료 시간", `test/config/load-config.spec.ts` "요청별 만료 상한".
   - PostgreSQL 통합: `test/http/rest-ttl.integration-spec.ts`(REST), `test/file-channel/poller.integration-spec.ts` "요청별 만료 시간"(파일), `test/e2e/job-ttl.integration-spec.ts`(claim·sweep·차단기·재시도 대기·전송 중 만료·Worker).

## 검토한 대안

| 대안                                       | 채택하지 않은 이유                                                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 절대 시각 필드 `expiresAt`                 | 호출처 시계에 의존한다. 시계 오차가 만료 시각에 그대로 들어간다. ADR-0002 결정 10(시각은 DB `now()`)과 맞지 않는다                                          |
| `ttlSeconds`를 지문에서 제외               | ADR-0005 결정 3("스키마에 필드가 추가되면 지문 범위에도 넣는다")을 바꾸는 새 결정이 필요하다. 같은 Key에 다른 TTL을 보낸 요청이 오류 없이 기존 작업으로 처리되어 호출처가 의도한 만료가 적용되지 않았음을 알 수 없다 |
| 기본값을 명시한 요청을 생략과 같은 지문으로 | 지문이 운영 설정에 의존한다. 기본 TTL을 바꾸면 기본값을 명시했던 요청의 재전송이 409가 된다. 생략 요청의 만료는 설정에 따라 바뀌므로 같은 요청으로 볼 수 없다 |
| 같은 Key 재요청 때 만료 시각을 다시 계산   | relay 재시도마다 만료가 늘어 만료가 사실상 사라진다                                                                                                          |
| 상한 없이 하한만 두기                      | 운영자가 큐 적체 기간을 통제할 수단이 없다. 모든 요청이 1년 TTL을 쓰면 대기 작업과 보존 기간이 함께 커진다                                                   |
| 보존 검사를 "보존 ≥ 기본 TTL"로 유지        | 상한까지 TTL을 늘린 요청은 재시도 기간이 보존보다 길어질 수 있다. 그 기간 안의 relay 재전달을 Key로 막지 못한다                                            |

## 결과

- 짧은 TTL 요청은 만료 시각 뒤 새 시도를 하지 않는다. 이미 시작한 전송은 끝까지 가므로 만료 시각 직후 도착하는 메일은 있을 수 있다(at-least-once, RQ-013).
- 긴 TTL은 한도 차단이 길어져도 메일이 결국 나가게 할 뿐, 한도로 생긴 지연을 없애지 않는다. 한도 차단이 하루를 넘는 것은 발송량과 계정 한도의 문제다.
- 상한을 늘리면 대기 작업이 남을 수 있는 기간이 늘어난다. 점유 쿼리 측정(ADR-0007 구현 중 확정 10, ADR-0009 구현 중 확정 3)은 기본 TTL 24시간 상황의 대기 건수를 가정했다. 더 긴 상한에서의 대기 건수와 점유 지연은 측정하지 않았다.
- 요청 계약에 선택 필드 하나와 검증 코드 하나(`OUT_OF_RANGE`)가 늘어난다. 기존 호출처는 요청을 바꾸지 않고 쓴다.
- 마이그레이션이 없다. 롤백해도 이미 등록된 작업의 `expires_at`은 그대로 쓰인다. 구 버전도 판정에 이 컬럼을 쓴다.

## 미확정

- 하한 60의 적정성. 실제 점유 지연 분포로 측정하지 않았다.
- 요청별 재시도 횟수·간격. 이번 범위에 포함하지 않는다(요구사항 미결정 항목 "메시지별 정책").
- 예약 발송(not-before). 이번 범위에 포함하지 않는다.
