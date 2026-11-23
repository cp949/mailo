# 발송 우선순위는 이름 등급 4개로 받고, 점유는 우선순위 경로와 대기 순서 경로를 claim마다 확률로 고른다

## 상태

승인됨 (2026-11-23)

결정 1~10을 2026-11-23에 구현하고 자동 테스트로 검증했다. 요구사항은 RQ-033~038이다. 구현 중 확정한 내용은 "구현 중 확정" 절에 모았다. "결과"의 "지연 변화는 측정하지 않았다"와 "미확정"의 첫째·둘째 항목은 구현 중 확정 1~3이 정한다.

- 이 ADR이 ADR-0002 구현 중 확정 2의 점유 부분 인덱스와 점유 순서를 이어받는다. ADR-0002 결정 4는 점유 순서를 결정 문구로 고정하지 않았으므로 대체하는 결정은 없다. 기존 인덱스 `mail_jobs_claim_idx`는 대기 순서 경로와 헬스 수치에 계속 쓴다(결정 9).
- 이 ADR의 결정 4가 ADR-0005 결정 3의 "요청별 정책 필드"로 `priority`를 추가한다. ADR-0005의 형식 태그 `mailo-fp-v1`과 정규화 규칙은 바꾸지 않는다.
- ADR-0007 구현 중 확정 3의 `half_open` 대표 작업 선택 규칙(직전에 차단기를 연 작업을 후순위로)은 첫 정렬 키로 유지한다(결정 7).

## 배경

일반 메일이 큐에 많이 쌓인 상황에서 급한 메일(인증 코드, 보안 알림 등)을 먼저 발송해야 한다.

현재 동작은 다음과 같다(2026-11-23, `apps/mailo/src/queue/claim.ts`·`queue/backlog.ts`·`envelope/request-schema.ts` 기준).

- 점유 후보는 `status IN ('PENDING','RETRY_WAIT') AND next_attempt_at <= now() AND expires_at > now()`다.
- 후보를 `ORDER BY next_attempt_at, id`로 골라 `LIMIT` 뒤 `FOR UPDATE SKIP LOCKED`로 잠근다.
- 한 번의 claim은 빈 슬롯 수(`concurrency - inFlight.size`)만큼 점유한다. `half_open` 대표 모드는 1건이다.
- 할당이 남은 호출처는 `row_number() OVER (PARTITION BY caller_id ORDER BY next_attempt_at, id)`로 순번을 매겨 잔여 건수까지만 점유한다.
- `half_open` 대표 선택은 `ORDER BY (j.id IS NOT DISTINCT FROM b.last_trip_job_id), j.next_attempt_at, j.id`이고 `LIMIT 1`이다.
- 점유 인덱스는 `mail_jobs_claim_idx (next_attempt_at, id) WHERE status IN ('PENDING','RETRY_WAIT')`다.
- 요청 스키마는 모르는 최상위 필드를 `UNKNOWN_FIELD`로 거부한다. 요청과 큐에 우선순위 필드가 없다.

우선순위만으로 정렬하면 높은 등급 유입이 이어지는 동안 낮은 등급이 점유되지 않는다. 대기 시간에 따른 승격은 적체가 길어지면 우선순위를 없앤다(검토한 대안 표).

## 결정

1. **우선순위는 이름 등급 4개 `LOW`·`NORMAL`·`HIGH`·`URGENT`로 받는다. 기본은 `NORMAL`이다.**
   - REST와 파일 요청의 최상위 선택 필드 `priority`다. 두 채널이 같은 규칙을 쓴다.
   - 값은 위 네 문자열뿐이고 대소문자를 구분한다. 생략하면 `NORMAL`이다.
   - `null`, 숫자, 빈 문자열, 그 밖의 문자열은 검증 오류다. REST는 400, 파일은 수집 거부다.
   - `priority`는 Mailo가 점유 순서에 쓰는 값이라 수신자처럼 평문 필드다. JWE `content`의 복호화 평문에 있으면 기존 규칙대로 `UNKNOWN_FIELD`다.
   - 파일 JWS는 요청 JSON 전체를 서명하므로 `priority`도 서명 대상이다.
2. **DB는 등급을 `smallint` 순위로 저장한다.**
   - 순위는 `LOW` 10, `NORMAL` 20, `HIGH` 30, `URGENT` 40이다. 클수록 먼저 점유한다.
   - 간격을 10으로 둔다. 나중에 등급을 끼워 넣어도 기존 행을 바꾸지 않기 위해서다.
   - 컬럼은 `mail_jobs.priority smallint NOT NULL DEFAULT 20`이다. 도입 전 작업은 `NORMAL`로 읽힌다.
   - 허용 순위 CHECK는 `NOT VALID`로 추가한다(`0003_attempt_instance.sql`과 같은 방식).
   - 순위 숫자는 API 응답과 지문에 쓰지 않는다. 외부 계약은 등급 이름이다.
3. **인증된 모든 호출처가 모든 등급을 지정할 수 있다.**
   - 호출처별 허용 등급 필드와 등급별 할당을 두지 않는다.
   - 받아들인 위험: 호출처가 모든 요청을 `URGENT`로 보내면 등급의 효과가 줄어든다. Mailo에는 이를 막는 수단이 없다.
   - 완화는 호출처 연동 문서의 등급별 용도 기준이다. 예: `URGENT`는 인증 코드·보안 알림, `LOW`는 대량 안내.
   - 문제가 되면 호출처별 허용 등급을 새 ADR로 추가한다.
4. **우선순위는 지문의 기존 `policy` 입력에 넣는다(ADR-0005 결정 3의 요청별 정책 필드).**
   - `NORMAL`(생략 포함)이면 `policy`에 키를 넣지 않는다.
   - 그 밖의 등급이면 `policy.priority`에 등급 이름(`"LOW"`·`"HIGH"`·`"URGENT"`)을 넣는다.
   - DB 순위 숫자는 지문에 넣지 않는다. 순위 숫자를 다시 매겨도 지문이 바뀌지 않게 하기 위해서다.
   - 형식 태그 `mailo-fp-v1`을 올리지 않는다. 빈 `policy`와 생략한 `policy`는 같은 정규화 결과(`[]`)다(`crypto/fingerprint.ts`의 `normalizePolicy`). 그래서 생략·`NORMAL` 요청의 지문은 도입 전 지문과 같다.
   - 같은 Key에서 등급만 바뀌면 지문이 달라진다. REST는 409, 파일은 지문 불일치 수집 거부다. 기존 작업은 바꾸지 않는다.
   - 도입 전 지문 값이 바뀌지 않음을 골든 테스트(고정 입력과 고정 키로 계산한 기존 지문 값)로 고정한다.
5. **점유는 claim 호출마다 두 경로 중 하나를 고른다.**
   - 우선순위 경로(기본): `ORDER BY priority DESC, next_attempt_at, id`.
   - 대기 순서 경로: 우선순위를 무시한 `ORDER BY next_attempt_at, id`(도입 전 순서).
   - 대기 순서 경로를 고를 확률은 `MAILO_CLAIM_FIFO_RATIO`다. 범위는 0 이상 1 이하이고 기본 0.1(추정)이다. 범위 밖 값은 기동을 거부한다.
   - 0이면 항상 우선순위 경로다.
   - 경로는 애플리케이션 난수로 고른다. 테스트는 난수를 주입한다.
   - DB에 경로 상태를 두지 않는다. 그래서 여러 Worker가 조정 없이 같은 규칙으로 동작한다.
   - 대기 순서 경로는 가장 오래 기다린 작업에 몫을 준다. 그 작업이 `URGENT`여도 함께 뽑힌다. 어느 등급도 점유 기회가 0이 되지 않는다.
   - 후보 조건은 두 경로 모두 도입 전과 같다.
6. **대기 시간에 따른 승격은 하지 않는다.**
   - 정렬식에 `now()`를 쓰지 않는다. 굶음 완화는 결정 5의 대기 순서 경로가 맡는다.
7. **할당 순번과 `half_open` 대표 선택도 고른 경로의 정렬을 쓴다.**
   - 할당이 남은 호출처의 `row_number() OVER (PARTITION BY caller_id ORDER BY ...)`에 고른 경로의 정렬을 쓴다. 우선순위 경로에서 잔여 1건인 호출처에 `URGENT`·`NORMAL` 후보가 함께 있으면 `URGENT` 작업을 점유한다.
   - `half_open` 대표 선택은 첫 정렬 키(직전에 차단기를 연 작업을 후순위로)를 유지한다. 그다음 키로 고른 경로의 정렬을 쓴다. 대표 작업은 1건 그대로다.
8. **기존 발송 정책은 등급과 무관하게 유지한다.**
   - 모든 등급이 재시도 backoff와 `next_attempt_at`을 지킨다.
   - 영구 오류, 최대 시도 횟수, 만료, lease 복구, 결과 기록 계약은 그대로다. 재시도·복구 뒤에도 등록한 등급을 보존한다.
   - `sendQuota24h`는 모든 등급의 합산 사용량에 적용한다(RQ-032).
   - 차단기 `open`에서는 `URGENT` 작업도 점유하지 않는다(ADR-0007 결정 5).
   - `FOR UPDATE SKIP LOCKED`, lease 토큰, 작업 행 → 차단기 행 잠금 순서는 그대로다.
   - 이미 `SENDING`인 작업의 전송을 중단하거나 점유를 빼앗지 않는다.
9. **우선순위 경로용 부분 인덱스를 새로 둔다.**
   - `(priority DESC, next_attempt_at, id) WHERE status IN ('PENDING','RETRY_WAIT')`다.
   - `CREATE INDEX CONCURRENTLY`로 만들고, 첫 줄이 `-- mailo:no-transaction`인 별도 마이그레이션 파일에 문장 하나만 둔다.
   - 대기 순서 경로와 기존 헬스 수치는 기존 `mail_jobs_claim_idx`를 쓴다.
   - 성능 기준: 점유 쿼리 지연이 같은 데이터·조건·장비에서 기존 측정값(ADR-0007 구현 중 확정 10, 대기 1만 건 1.4 ms, 10만 건 11.8 ms)의 2배 이내다. 넘으면 인덱스·쿼리 설계를 다시 검토한다.
10. **배포와 롤백은 요청 스키마 호환성을 기준으로 순서를 정한다.**
    1. 마이그레이션(컬럼, CHECK, 인덱스)을 적용한다.
    2. 모든 Mailo 인스턴스를 새 버전으로 바꾼다.
    3. 호출처가 `priority` 전송을 시작한다.
    - 구 버전은 `priority`를 `UNKNOWN_FIELD`로 거부한다. 롤링 배포 중(구·신 인스턴스 혼용)에는 호출처가 `priority`를 보내지 않는다.
    - 구 Worker가 섞여 있으면 그 Worker의 점유 순서만 도입 전과 같다. 정합성 문제는 없다.
    - 롤백 전에 호출처의 `priority` 전송을 먼저 끊는다. 끊지 않으면 REST는 400, 파일은 수집 거부가 된다.
    - 롤백해도 `priority` 컬럼과 인덱스는 남긴다. 구 버전은 이 컬럼을 읽지 않는다.

## 구현 중 확정 (2026-11-23)

결정 문구는 바꾸지 않는다. 아래는 구현에서 정한 세부와 측정 결과다.

1. **점유 SQL 형태(결정 5·7, `src/queue/claim.ts`).**
   - 경로는 `ClaimOrder`(`priority`·`fifo`)다. SQL에 넣는 정렬은 `ORDER_BY` 표의 고정 조각뿐이다. 표에 없는 값은 SQL을 만들기 전에 예외다.
   - normal 모드의 `picked` CTE와 `ranked`의 `row_number()`가 같은 조각을 쓴다. `half_open` 대표 선택은 `(j.id IS NOT DISTINCT FROM b.last_trip_job_id)` 뒤에 별칭 `j`판 조각을 붙인다.
   - `claim`에 경로를 주지 않으면 우선순위 경로다.
   - Worker는 claim 호출마다 `claimRandom() < MAILO_CLAIM_FIFO_RATIO`이면 대기 순서 경로를 쓴다. 경로 난수(`WorkerDeps.claimRandom`)는 재시도 jitter 난수(`random`)와 나눴다. 테스트가 하나만 고정해도 다른 쪽 결과가 바뀌지 않게 하기 위해서다.
   - 검증: `test/queue/claim-priority.integration-spec.ts`, `test/worker/worker-priority.integration-spec.ts`.
2. **등급별 헬스 수치(RQ-037, `src/queue/backlog.ts`).**
   - 등급 순위 배열을 `unnest`하고 등급마다 `LEFT JOIN LATERAL (... priority = g.rank ORDER BY next_attempt_at LIMIT 10001)`로 센다. 등급마다 상한과 비용이 따로 막힌다. `mail_jobs_priority_claim_idx`를 쓴다.
   - 전체 값(`dueCount`·`dueCountTruncated`·`oldestDueAgeSeconds`)과 등급별 값을 `UNION ALL` 한 문장으로 읽는다. 헬스의 문 시간제한(`statement_timeout` 2초) 하나 안에 끝나게 하기 위해서다. 전체 값의 쿼리와 의미는 도입 전과 같다.
   - 등급별 응답 필드는 `dueCountByPriority`·`oldestDueAgeSecondsByPriority`에 `dueCountTruncatedByPriority`를 더했다. 기존 `dueCountTruncated` 관례를 따른 것이다. 상한 10000에 걸린 값과 정확히 10000건을 구분하려는 것이다.
   - 검증: `test/http/health-ops.integration-spec.ts`(등급별 값, 토큰 없는 응답의 비노출, 등급별 상한, 한 문장).
3. **점유 쿼리 성능(결정 9의 기준).**
   - 측정 조건은 ADR-0007 구현 중 확정 10과 같다. 할당 초과 호출처의 대기 N건이 다른 호출처 100건보다 앞에 있고, 다른 호출처 4건을 점유하는 `src/queue/claim.ts` normal 모드 문장을 `EXPLAIN (ANALYZE, BUFFERS)`로 재고 롤백한다.
   - 환경: PostgreSQL 17.11(로컬 compose), 본문 2 KiB, 캐시 warm(측정 schema 하나만 두고 첫 실행을 버림), 30회 중앙값. 기존 쿼리는 같은 날 같은 장비에서 다시 쟀다(ADR-0007의 1.4 ms·11.8 ms는 다른 시점 값이다).
   - 등급 혼합은 네 등급을 고르게 섞었다. 최악은 초과 호출처의 작업이 모두 `URGENT`이고 다른 호출처가 `NORMAL`이라 우선순위 경로가 N건을 모두 읽고 버리는 경우다.

     | 쿼리 | 1만 건 | 10만 건 | 인덱스 | 버린 행(10만 건) |
     | ---- | ------ | ------- | ------ | ---------------- |
     | 기존(재측정) | 0.99 ms | 9.09 ms | `mail_jobs_claim_idx` | 100,000 |
     | 우선순위 경로, 등급 혼합 | 0.43 ms | 3.52 ms | `mail_jobs_priority_claim_idx` | 25,000 |
     | 우선순위 경로, 최악 | 1.06 ms | 9.86 ms | `mail_jobs_priority_claim_idx` | 100,000 |
     | 대기 순서 경로(등급 혼합·최악) | 1.02~1.11 ms | 9.41~9.46 ms | `mail_jobs_claim_idx` | 100,000 |

   - 결과: 기존 재측정 대비 최대 1.08배(우선순위 경로 최악, 10만 건)다. 기준(2배 이내)을 넘지 않아 인덱스·쿼리를 바꾸지 않는다. 두 경로 모두 추가 정렬 노드 없이 인덱스 순서로 읽는다.
   - 측정하지 않은 것: 캐시가 차가운 상태, 쓰기 부하 중 측정, 측정 스크립트의 저장소 보관(수동 측정이다).
4. **INVALID 인덱스에서 마이그레이션을 실패시킨다(결정 9, `src/db/migrator.ts`).**
   - 원인: `CREATE INDEX CONCURRENTLY`가 실패하면 INVALID 인덱스가 남는다. 다음 실행의 `IF NOT EXISTS`는 그 인덱스를 건너뛰고 성공해 적용으로 기록됐다.
   - 영향(검토 측정, 대기 30만 건): 우선순위 claim이 0.08 ms에서 170 ms(Seq Scan, 디스크 정렬), 등급별 헬스가 4.6 ms에서 58 ms가 됐다.
   - 구현: `-- mailo:no-transaction` 파일을 실행한 뒤 기록 전에 현재 schema의 `pg_index.indisvalid = false` 인덱스를 조회한다. 있으면 기록하지 않고 인덱스 이름을 담은 오류로 실패한다(fail-closed). 운영자가 `DROP INDEX CONCURRENTLY` 뒤 다시 실행한다(`docs/operations/troubleshooting.md` "등급별 적체").
   - 검증: `test/db/migrator.integration-spec.ts`(INVALID 인덱스가 남은 재실행은 실패하고 기록하지 않음, 지운 뒤 재실행은 적용).
5. **등급 변환(결정 2).**
   - 등급 이름과 순위의 대응은 `src/queue/priority.ts` 한 곳에 있다.
   - DB에서 정의되지 않은 순위를 읽으면 다른 등급으로 바꾸지 않고 예외다. CHECK가 새 행을 막고 기존 행은 모두 DEFAULT 20이라 정상 경로에서는 생기지 않는다.
   - 큐 등록 입력(`RegisterInput.priority`)을 생략하면 `NORMAL` 순위로 저장한다.

## 검토한 대안

| 대안                                         | 채택하지 않은 이유                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 300초 대기 뒤 긴급 등급으로 승격             | 적체가 300초보다 길면 밀린 일반 작업이 모두 긴급과 같은 등급이 된다. 같은 등급은 `next_attempt_at` 순이므로 새 긴급 작업이 오래된 일반 작업 뒤에 서서 우선순위가 사라진다 |
| 숫자 `priority` API(예: 0~100)               | 호출처끼리 더 큰 값을 쓰는 경쟁이 생긴다. 같은 숫자가 호출처마다 다른 뜻이 된다                                                                                          |
| boolean `urgent`                             | 등급이 둘뿐이다. 등급을 늘리려면 요청 계약을 다시 바꿔야 한다                                                                                                            |
| 호출처별 `allowUrgent` 권한(기본 거부)       | 모든 호출처에 모든 등급을 허용하기로 했다. 남용 위험은 결정 3이 받아들인 위험으로 적는다                                                                                |
| 지문 형식 태그를 `mailo-fp-v2`로 올려 재정의 | 기존 작업의 지문을 다시 계산해야 한다. 종결 1일 뒤 본문을 지운 작업은 평문이 없어 다시 계산할 수 없다(ADR-0008 결정 7)                                                   |

## 결과

- 급한 메일은 다음 점유에서 먼저 선택된다. 적체 길이와 무관하다.
- `URGENT`도 즉시 전송을 뜻하지 않는다. 점유 지연의 하한은 "빈 슬롯이 생길 때까지 + Worker 폴링 간격"이다. 대기 순서 경로에 걸린 claim 동안에는 더 늦어질 수 있다.
- 여러 Worker의 전역 SMTP 전송 시작 순서·완료 순서는 보장하지 않는다. 각 점유 시점에 잠금 없이 고를 수 있는 후보가 기준이다.
- 비율은 claim 호출 수 기준이다. 한 번의 claim이 빈 슬롯 수만큼 여러 건을 점유하므로 작업 건수 기준 비율은 정확히 `MAILO_CLAIM_FIFO_RATIO`가 아니다.
- 굶음의 한계: 대기 순서 경로는 처리량의 일부(기본 약 10%, 추정)만 오래된 작업에 준다. 유입이 처리량보다 많은 상태가 이어지면 낮은 등급 작업은 만료 시각(기본 TTL 24시간)을 넘겨 `EXPIRED`가 될 수 있다. 이 한계는 호출처 연동 문서와 운영 문서에 적는다.
- SMTP 중복 전송 가능성은 기존 at-least-once 계약과 같다. `URGENT`는 수신함 도착이나 정확히 한 번 발송을 보장하지 않는다.
- 요청 계약에 선택 필드 하나가 늘어난다. 기존 호출처는 요청을 바꾸지 않고 쓴다.
- `mail_jobs`에 `smallint` 컬럼 하나와 부분 인덱스 하나가 늘어난다. 상수 DEFAULT 컬럼 추가는 PostgreSQL 11 이상에서 테이블을 다시 쓰지 않는다(PostgreSQL 문서 기준, 미측정).
- 점유 쿼리의 지연 변화는 측정하지 않았다. 결정 9의 기준으로 구현 뒤 측정한다.

## 미확정

- 우선순위 경로·대기 순서 경로의 점유 SQL 형태와 기존 `ranked` CTE·`half_open` 쿼리의 수정 범위. 구현에서 정한다.
- 등급별 헬스 수치(`dueCountByPriority`·`oldestDueAgeSecondsByPriority`)의 쿼리 형태. 등급마다 기존 상한(10001)을 지키는 방식은 구현에서 정한다(RQ-037).
- `MAILO_CLAIM_FIFO_RATIO` 기본값 0.1의 적정성. 실제 부하로 측정하지 않았다.
- 등록 뒤 우선순위를 바꾸는 API. 이번 범위에 포함하지 않는다.

## 출처

- [PostgreSQL `ALTER TABLE`](https://www.postgresql.org/docs/current/sql-altertable.html): 상수 DEFAULT 컬럼 추가와 `NOT VALID` CHECK.
- [PostgreSQL `CREATE INDEX`](https://www.postgresql.org/docs/current/sql-createindex.html): `CONCURRENTLY`의 트랜잭션 제약.
