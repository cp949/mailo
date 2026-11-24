# DB 유지보수

Mailo의 PostgreSQL 테이블에서 팽창(죽은 행이 쌓여 파일이 커지는 것)과 VACUUM을 점검하는 방법, 보존·삭제 규칙과의 관계, 파티셔닝을 검토하기 시작할 조건을 적는다.
근거는 RQ-068, ADR-0014 결정 8, 코드(`queue/maintenance.ts`, `queue/claim.ts`, `queue/complete.ts`, `events/`)와 마이그레이션 `0001`~`0016`이다.
표기: "확인"은 2026-11-24에 코드를 읽거나 쿼리를 실행해 확인한 것이다. "가정"은 확인하지 못한 추정이다.

수치는 모두 로컬 단일 측정이다("로컬 측정"). 운영 크기(수백만 행)와 다중 인스턴스에서 측정하지 않았다. 측정하지 않은 임계값(죽은 행 비율 N% 등)은 쓰지 않는다.

## 결론

- 기본 autovacuum 설정으로 이 합성 부하의 죽은 행이 회수됐다. 삭제가 끝나고 약 60초 뒤 `n_dead_tup`이 0이 됐다(로컬 한 번).
- 회수된 공간은 파일에서 줄지 않고 다음 삽입이 다시 쓴다. 삭제 뒤 `mail_jobs` 파일 크기는 그대로였고 10만 건을 더 넣어도 늘지 않았다.
- `mail_jobs`의 갱신은 HOT 갱신이 되지 못한다. 640,732번 갱신 중 0번이다. 인덱스가 있는 열(`status`, `finished_at`, `body_ciphertext` 조건 등)이 바뀌기 때문이다.
- 오래 열린 트랜잭션은 읽기 전용이어도 VACUUM이 죽은 행을 지우지 못하게 한다. 이벤트 피드는 쓰기 트랜잭션만 막는다는 점이 다르다.
- `VACUUM FULL`은 점검 목록에 두지 않는다. 쓰려면 이 문서의 위험도를 먼저 읽는다.
- 파티셔닝은 구현하지 않는다. 시작 조건은 "파티셔닝 검토 시작 조건"이고 새 ADR이 먼저다.

## 테이블별 갱신·삭제 패턴

| 테이블 | 행을 바꾸는 동작 | 삭제 | 팽창 원인(확인) |
| ------ | ---------------- | ---- | --------------- |
| `mail_jobs` | 점유(`PENDING`·`RETRY_WAIT`에서 `SENDING`), 결과 기록(`SENT`·`RETRY_WAIT`·`FAILED`), lease 복구, 만료 sweep, 취소, 본문 삭제(`UPDATE`로 본문 열을 `NULL`). 재시도마다 점유·결과 기록이 반복된다 | 종결 후 `MAILO_RECORD_RETENTION_SECONDS`(기본 30일) 뒤 보존 삭제 | 작업 한 건당 갱신 3번 이상(점유, 결과 기록, 본문 삭제, 재시도마다 점유·결과 기록 추가). 측정에서 모두 HOT가 아니었다 |
| `mail_attempts` | 삽입만 | `mail_jobs` 삭제의 `ON DELETE CASCADE` | 보존 삭제 때 한꺼번에 죽은 행이 생긴다 |
| `mail_events` | 삽입만(종결 이벤트, 수집 거부) | `mail_jobs`·`mail_intake_rejections` 삭제의 `CASCADE` | 보존 삭제 때 한꺼번에 죽은 행이 생긴다 |
| `mail_intake_rejections` | 삽입만 | 생성 후 `MAILO_RECORD_RETENTION_SECONDS` 뒤 보존 삭제 | 보존 삭제 때 죽은 행 |
| `mail_circuit_breaker` | 계정당 한 행. 실패·상태 전이 때만 갱신한다(정상 결과마다 갱신하지 않는다, `recordAccountOk`) | 없음 | 행이 하나라 문제가 되지 않는다(가정, 측정하지 않았다) |
| `mail_event_purges` | 보존 삭제 배치마다 `UPSERT`. 행 수는 호출처 수 × 이벤트 종류 수가 상한이다 | 없음 | 측정에서 갱신 73번이 모두 HOT였다 |
| `mail_send_controls` | 운영자의 정지·재개 | 재개 때 행 삭제 | 행 수가 정지 범위 수다 |
| `mail_ops_audit` | 삽입만(관리 토큰의 정지·재개·취소) | 자동 삭제 없음(ADR-0012 결정 8) | "감사 테이블" 참고 |

- 행이 약 2 KB를 넘으면 큰 열은 TOAST 테이블(`pg_toast.*`)에 저장된다(PostgreSQL 문서 지식). 측정에서 본문(`body_ciphertext`) 약 2 KiB가 TOAST로 갔고 행당 약 2.7 KB를 썼다. 본문 삭제 `UPDATE`는 TOAST 쪽에도 죽은 행을 만든다(측정: TOAST 죽은 행 400,000건). VACUUM은 `mail_jobs`를 정리할 때 TOAST도 함께 정리한다.
- 보존 삭제는 `mail_jobs`를 지우고 `mail_attempts`·`mail_events`는 `CASCADE`로 지운다. 한 배치는 1000건이고 한 트랜잭션이다(`MAINTENANCE_BATCH_SIZE`).
- 시각은 DB `now()` 기준이다. 정리 단계(`sweep`, `lease`, `bodies`, `records`)마다 advisory lock이 있어 인스턴스가 여럿이어도 같은 단계는 한 번에 한 인스턴스가 돈다(확인).

## 점검 쿼리

아래 쿼리는 Mailo 테이블이 있는 schema에 접속한 세션에서 쓴다(`current_schema()`). 읽기 전용이다. 모두 임시 schema에서 실행해 동작을 확인했다("로컬 측정"). 쿼리 텍스트(`pg_stat_activity.query`)는 요청 값이 섞일 수 있는 자리라 뺐다.

### 1. 표별 죽은 행과 autovacuum 실행

```sql
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       n_tup_upd, n_tup_hot_upd, autovacuum_count, last_autovacuum, last_autoanalyze
  FROM pg_stat_user_tables
 WHERE schemaname = current_schema() AND relname LIKE 'mail\_%'
 ORDER BY n_dead_tup DESC;
```

- `n_dead_tup`은 통계 수집기의 추정값이다. 정확한 개수가 아니다.
- 삭제 직후에는 값이 크고 autovacuum 뒤에 줄어드는 것이 정상이다(측정: 보존 삭제 직후 `mail_jobs` 229,770, 약 60초 뒤 0).
- `last_autovacuum`이 비어 있거나 오래됐는데 `n_dead_tup`이 계속 커지면 "판단 순서"로 간다.
- `n_tup_hot_upd / n_tup_upd`는 `mail_jobs`에서 0에 가깝다. 이 비율이 낮은 것은 이상이 아니다.

### 2. 표·인덱스·TOAST 크기

```sql
SELECT c.relname,
       pg_size_pretty(pg_relation_size(c.oid)) AS heap,
       pg_size_pretty(coalesce(pg_relation_size(nullif(c.reltoastrelid, 0)), 0)) AS toast,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total
  FROM pg_class c
 WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'mail\_%'
 ORDER BY pg_total_relation_size(c.oid) DESC;
```

```sql
-- mail_jobs의 인덱스 크기와 사용 횟수(통계를 재설정한 뒤부터)
SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size
  FROM pg_stat_user_indexes
 WHERE schemaname = current_schema() AND relname = 'mail_jobs'
 ORDER BY pg_relation_size(indexrelid) DESC;
```

- 같은 쿼리를 주기적으로(예: 하루 한 번) 기록해 추세를 본다. 한 시점의 크기만으로는 팽창과 정상 보존 데이터를 구분하지 못한다.
- 삭제 뒤 `heap`이 줄지 않는 것은 정상이다. VACUUM은 파일 끝의 빈 페이지만 돌려주고 나머지는 재사용 공간으로 둔다(측정).

### 3. VACUUM 기준선을 잡은 세션

```sql
SELECT pid, usename, state, now() - xact_start AS xact_age, backend_xid, backend_xmin,
       age(backend_xmin) AS xmin_age, wait_event_type
  FROM pg_stat_activity
 WHERE (backend_xid IS NOT NULL OR backend_xmin IS NOT NULL) AND pid <> pg_backend_pid()
 ORDER BY age(backend_xmin) DESC NULLS LAST LIMIT 10;
SELECT gid, prepared, owner FROM pg_prepared_xacts;                       -- 끝나지 않은 prepared transaction
SELECT slot_name, active, xmin, catalog_xmin FROM pg_replication_slots;  -- 복제 슬롯
```

- `backend_xmin`이 있는 세션은 스냅샷을 쥐고 있다. `xmin_age`가 크고 `xact_age`가 긴 세션이 원인 후보다.
- `backend_xid`가 있는 세션은 쓰기 트랜잭션이다. 이 세션은 이벤트 피드도 함께 붙잡는다(`troubleshooting.md` "이벤트 피드").
- 읽기 전용 트랜잭션(`pg_dump`, `REPEATABLE READ`)은 `backend_xid`가 없어 피드를 지연시키지 않지만 `backend_xmin`을 쥐어 VACUUM을 막는다(측정: "열린 트랜잭션").

### 4. 보존 삭제가 따라가는지

```sql
-- 가장 오래된 종결 작업의 나이. MAILO_RECORD_RETENTION_SECONDS(기본 30일)보다 크게 길면 삭제가 밀린 것이다.
SELECT now() - min(finished_at) AS oldest_finished_age FROM mail_jobs WHERE finished_at IS NOT NULL;
-- 지금 지울 수 있는 행 수. 값은 보존 기간(초)을 직접 넣는다.
SELECT count(*) AS retention_due FROM mail_jobs
 WHERE finished_at IS NOT NULL AND finished_at <= now() - make_interval(secs => 2592000);
-- 본문을 아직 비우지 못한 종결 작업 수(유예 기본 1일).
SELECT count(*) AS body_due FROM mail_jobs
 WHERE finished_at IS NOT NULL AND body_ciphertext IS NOT NULL
   AND finished_at <= now() - make_interval(secs => 86400);
```

- 세 쿼리는 인덱스 전용 스캔이고 0.1ms 미만이었다(로컬, 약 14만 행, 두 개수 쿼리는 대상이 0건일 때). 대상이 많으면 개수 쿼리는 그만큼 읽는다.
- 보존 삭제가 한 번도 돌지 않으면 `retention_due`는 쌓인 만큼 커진다. 삭제가 정상이면 값이 0 근처에서 움직인다.
- 로그 이벤트 `bodies_deleted`, `records_deleted`(info, `count`)와 `bodies_deleted_failed`, `records_deleted_failed`(error)로 정리 실행을 본다(확인, `worker/worker.ts`의 `drainBatches`).

## 판단 순서

1. 쿼리 1로 죽은 행이 쌓이는 표를 찾는다. `autovacuum_count`가 늘고 있고 `n_dead_tup`이 내려오면 정상이다.
2. 죽은 행이 줄지 않으면 쿼리 3으로 오래 열린 트랜잭션, prepared transaction, 복제 슬롯을 찾는다. 이것이 VACUUM이 지우지 못하는 가장 흔한 원인이다(PostgreSQL 문서 지식이고, 읽기 전용 트랜잭션과 쓰기 트랜잭션은 측정으로 확인했다).
3. 세션이 있으면 그 세션의 주인에게 종료를 요청한다. 방치된 `idle in transaction` 세션은 `idle_in_transaction_session_timeout`이 앱 풀에서는 60초로 끊는다(`deployment.md` "DB 시간제한과 장애 동작"). 앱 밖 세션(분석, 수동 접속)에는 적용되지 않는다.
4. 세션이 없는데 autovacuum이 돌지 않으면 DB 운영자에게 `autovacuum` 설정과 로그를 확인시킨다. 매개변수 조정은 DB 운영자의 몫이다.
5. 보존 삭제가 밀리면(쿼리 4) `records_deleted_failed` 로그와 정리 단계의 advisory lock, `statement_timeout`(`deployment.md` "DB 시간제한과 장애 동작")을 본다.
6. 위를 해소해도 파일 크기가 줄지 않는 것은 정상이다. 디스크를 OS에 돌려줘야 하면 "하지 않는 것"의 위험도를 읽고 DB 운영자가 정한다.

## 대응

- 수동 VACUUM: 해당 표에서만 실행한다. 읽기·쓰기를 막지 않고 파일 크기를 줄이지 않는다.

```sql
VACUUM (VERBOSE) mail_jobs;   -- 출력의 "dead but not yet removable"이 0이 아니면 기준선을 쥔 세션이 있다
```

- autovacuum 매개변수(`autovacuum_vacuum_scale_factor`, `autovacuum_naptime`, 표별 저장 매개변수)는 서버 문서를 따른다. 이 문서는 값을 권고하지 않는다. 기본값(`autovacuum_vacuum_scale_factor` 0.2, `autovacuum_naptime` 60초)에서 이 합성 부하는 회수됐다. 운영 크기에서 기본값이 맞는지는 측정하지 않았다.
- 마이그레이션이 `ACCESS EXCLUSIVE` 잠금을 잡는 동안(`deployment.md` "기동 순서와 마이그레이션")에는 VACUUM이 대기할 수 있다. 마이그레이션 시각과 겹치지 않게 수동 VACUUM을 잡는다(가정).

## 하지 않는 것

- `VACUUM FULL`을 점검 절차로 쓰지 않는다. 표를 새 파일로 다시 쓰며 `ACCESS EXCLUSIVE` 잠금을 잡아 그동안 Mailo의 점유·등록·조회가 모두 막힌다(PostgreSQL 문서 지식이고 이 저장소에서 실행하지 않았다). 임시로 표 크기만큼의 디스크도 더 필요하다. 쓰려면 정지(`deployment.md` "발송 정지와 운영 REST")와 점검 시간을 먼저 잡는다.

```txt
위험도: 높음 (ACCESS EXCLUSIVE 잠금으로 해당 표를 쓰는 모든 요청이 대기하고 statement_timeout·lock_timeout으로 실패한다)
롤백: 실행 중에는 취소할 수 있고 취소하면 원래 파일이 남는다. 완료된 뒤에는 되돌릴 대상이 없다
```

- `mail_jobs` 행을 수동으로 지우지 않는다. `Idempotency-Key` 중복 방지가 사라져 호출처의 재시도가 같은 메일을 다시 발송할 수 있다. 보존 삭제가 지우게 둔다.
- `pg_terminate_backend`로 Mailo 앱 세션을 끊지 않는다. 진행 중인 전송의 결과 기록이 실패해 lease 회수 때 중복 발송이 생길 수 있다(가정, 결과 기록 실패 경로는 `deployment.md` "DB 시간제한과 장애 동작"이다).

## 보존·삭제 규칙과의 관계

- 삭제 순서: 종결 후 본문 유예(`MAILO_BODY_RETENTION_SECONDS`, 기본 1일)가 지나면 본문 열을 비운다(`UPDATE`). 종결 후 `MAILO_RECORD_RETENTION_SECONDS`(기본 30일)가 지나면 작업 행과 시도·이벤트를 지운다(`DELETE`).
- 두 단계 모두 `MAILO_MAINTENANCE_INTERVAL_SECONDS`(기본 60초)마다 돌고 한 번에 최대 20배치 × 1000건이다(`MAX_BATCHES_PER_CYCLE`, `SWEEP_BATCH`). 기본값에서 한 인스턴스의 한 단계 처리 상한은 분당 2만 건이다(코드에서 계산한 값). 같은 단계는 한 번에 한 배치만 돌지만(advisory lock) 인스턴스가 여럿일 때의 합산 상한은 확인하지 않았다. 종결 작업이 이보다 오래 빠르게 쌓이면 삭제가 따라가지 못한다.
- 측정에서 1000건 배치는 본문 삭제 약 28ms, 보존 삭제(시도·이벤트 CASCADE 포함) 약 35ms였다(로컬, 단독 실행). 처리 상한은 시간이 아니라 사이클당 20배치 상한이 정한다.
- 본문 삭제는 `UPDATE`라 새 행 버전과 TOAST 죽은 행을 만든다. 팽창은 본문이 저장되는 동안(종결 후 1일)과 삭제 직후에 가장 크다.
- 보존 삭제는 한 번에 많은 죽은 행을 만든다(측정: 10만 작업에서 `mail_jobs` 99,770 + `mail_attempts` 109,769 + `mail_events` 99,770). 배치 크기를 키우지 않는다. 1000건 단위는 트랜잭션이 길어져 이벤트 피드 cursor(`xmin`)를 멈추지 않게 정한 값이다(`maintenance.ts`).

## 감사 테이블

`mail_ops_audit`은 자동 삭제가 없다(ADR-0012 결정 8). 삭제 자동화는 하지 않는다.

- 행 수는 지표 `mailo_ops_audit_rows`(100000에서 멈추고 `mailo_ops_audit_rows_truncated`가 1이 된다)와 `mailo_ops_audit_oldest_age_seconds`로 본다(`deployment.md` "전역 gauge").
- 크기 측정: 10만 행에서 heap 7.66 MB, 인덱스 2.26 MB, 합계 9.95 MB(약 100바이트/행)였다(로컬 한 번). 행 수 쿼리는 8.0ms(`Seq Scan`)였다.
- 크기가 문제가 되는 규모가 아니다. 삭제 판단은 보관 정책이 정한다. 이 문서는 기준 수치를 정하지 않는다.
- 지표가 상한(100000)에 닿으면 그 뒤의 증가를 알 수 없다. 정책에 맞는 보관 기간이 지난 행을 그 전에 지운다.

```sql
-- 보관 기간(예: 365일)이 지난 감사 행을 지운다. 먼저 건수를 본다.
SELECT count(*) FROM mail_ops_audit WHERE at < now() - interval '365 days';
DELETE FROM mail_ops_audit WHERE at < now() - interval '365 days';
```

```txt
위험도: 중간 (감사 기록을 영구 삭제한다)
롤백: 삭제 전에 pg_dump -t mail_ops_audit로 백업한 파일을 복원한다. 백업이 없으면 되돌리지 못한다
```

- 10만 행 삭제는 0.06초였고 죽은 행 100,000건이 남았다. autovacuum이 정리했다(로컬 한 번).

## 파티셔닝 검토 시작 조건

구현하지 않는다. 파티셔닝은 스키마와 마이그레이션 변경이므로 새 ADR이 먼저다. 검토를 시작하는 신호는 다음과 같다.

1. 쿼리 4의 `oldest_finished_age`가 보존 기간보다 계속 크고 `retention_due`가 늘어난다. 한 인스턴스의 정리 상한(분당 2만 건)을 종결 작업 유입이 넘는 상황이다.
2. 위가 `MAILO_MAINTENANCE_INTERVAL_SECONDS`를 줄여도 해소되지 않고 `mail_jobs`의 `total` 크기가 계속 늘어난다.
3. 삭제 배치가 `statement_timeout`(기본 30초)에 걸려 `records_deleted_failed`가 반복된다.

파티셔닝 제약(PostgreSQL 문서 지식이다. 이 저장소의 서버 17.11로 확인하지 않았다).

- `mail_jobs`는 `UNIQUE (caller_id, idempotency_key)`와 `id` 기본키를 갖는다. 파티션 키(시간 기준)가 유니크·기본키 제약에 들어가야 하므로 Key 유일성의 의미가 바뀐다.
- `mail_attempts`·`mail_events`는 `mail_jobs(id)`를 `ON DELETE CASCADE`로 참조한다. 파티션을 통째로 버리는 방식은 작업 보존 기간(종결 시각 기준)과 맞지 않는다.
- 이벤트 피드 cursor는 `txid`와 `pg_snapshot_xmin`에 의존한다(ADR-0006 결정 7).

## 로컬 측정

목적: 점검 쿼리가 동작하는지, 기본 autovacuum이 이 테이블 구성에서 죽은 행을 회수하는지, 회수한 공간이 재사용되는지 한 번 확인한다. 운영 크기가 아니다.

환경(2026-11-24):

- PostgreSQL 17.11(`postgres:17-alpine`, 로컬 compose), WSL2 호스트, 단독 실행. 다른 세션이 쥔 스냅샷이 없음을 확인하고 시작했다.
- 서버 설정은 기본값이다: `autovacuum` on, `autovacuum_naptime` 60초, `autovacuum_vacuum_scale_factor` 0.2, `autovacuum_vacuum_threshold` 50, `shared_buffers` 128MB.
- 임시 schema 하나에 마이그레이션 `0001`~`0016`을 적용했고, 끝난 뒤 그 schema만 `DROP SCHEMA`로 지웠다. 운영 DB·실제 데이터·시크릿은 쓰지 않았다.

방법:

1. 작업 20만 건 삽입. 본문은 압축되지 않는 약 2 KiB 의사 난수(암호문 대용)이고 수신자는 1명이다.
2. 점유·결과 기록: 1000건 배치 230회. 앱의 `claim`·`completeAttempt`와 같은 갱신 열이고 시도 행과 이벤트 행을 함께 넣는다. 약 10%는 `RETRY_WAIT`을 거쳐 두 번째 시도에서 `SENT`가 된다.
3. 본문 삭제: `deleteExpiredBodies`와 같은 SQL, 1000건 배치 210회.
4. 보존 삭제: `deleteExpiredRecords`와 같은 형태(삭제 표지 갱신 포함), 1000건 배치 110회. 종결 시각은 DB 시각을 당겨 절반을 31일 전, 절반을 2일 전으로 넣었다.
5. 삭제가 끝난 뒤 7분 동안 10초 간격으로 `pg_stat_user_tables`를 기록했다. 이어 같은 형태의 작업 10만 건을 더 넣어 공간 재사용을 봤다.
6. 감사 테이블에 10만 행을 넣고 삭제했다.
7. autovacuum을 끈 표에서 작업 2만 건을 지우고 `VACUUM (VERBOSE)`을 (a) 열린 트랜잭션이 없을 때 (b) 읽기 전용 `REPEATABLE READ` 트랜잭션이 열려 있을 때 (c) 쓰기 트랜잭션(트랜잭션 ID 할당)이 열려 있을 때 실행했다. 시험 뒤 autovacuum 설정을 되돌렸다.

결과:

| 단계 | 관찰 |
| ---- | ---- |
| 작업 20만 건 삽입 | `mail_jobs` heap 51.2 MB, 인덱스 52.8 MB, TOAST 546 MB |
| 점유·결과 기록 | `mail_jobs` 갱신 440,732건, HOT 0건. 죽은 행이 첫 autovacuum 전에 389,000건까지 쌓였다. heap 63.6 MB, 인덱스 69.6 MB. 시도 행 220,366건·이벤트 행 20만 건 삽입 |
| 본문 삭제 | 갱신 200,000건 추가(누적 640,732건, HOT 0건). heap 107.4 MB로 +43.8 MB. TOAST 죽은 행 400,000건 |
| 보존 삭제(작업 99,770건과 CASCADE) | 죽은 행 `mail_jobs` 229,770(본문 삭제 단계의 미회수 130,000건 포함), `mail_attempts` 109,769, `mail_events` 99,770(삭제 직후 값) |
| autovacuum | 삭제가 끝난 약 60초 뒤 세 표 모두 `n_dead_tup` 0. 이후 측정 종료까지 약 6분간 0 유지. `mail_jobs`는 총 2회, `mail_event_purges`는 1회 실행 |
| 크기 | heap 107.4 MB 그대로(파일이 줄지 않음). TOAST는 546 MB에서 0으로 줄었다(모든 청크가 죽어 파일 끝이 잘림). 인덱스 71.2 MB |
| 재사용 | 작업 10만 건 추가 삽입 뒤 heap 107.4 MB 그대로, 인덱스 77.7 MB, TOAST 273 MB(새 본문) |
| 열린 트랜잭션 (a)(b)(c) | (a) `20000 removed`. (b) `0 removed, 20000 are dead but not yet removable`, 트랜잭션 종료 뒤 `20000 removed`. (c) (b)와 같고 `backend_xid`가 보였다 |
| 감사 테이블 10만 행 | heap 7.66 MB, 인덱스 2.26 MB, 합계 9.95 MB. 행 수 쿼리 8.0ms. 삭제 0.06초, 이후 autovacuum이 죽은 행 100,000건을 정리 |
| 점검 쿼리 | 위 쿼리를 모두 실행했고 의도한 값을 냈다. 열린 트랜잭션 쿼리는 (b)·(c)에서 해당 세션 한 행을 보였다 |

한계:

- 로컬에서 한 번 실행했다. 반복 측정과 분산을 보지 않았다.
- 작업 20만 행, 종결 후 보존 삭제 10만 행이다. 운영 크기(수백만 행)의 autovacuum 소요, 인덱스 팽창, 디스크 읽기 비용을 확인하지 않았다.
- 점유·삭제·autovacuum 외 동시 부하가 없고 데이터가 메모리에 있다. 쓰기 부하 중 삭제, 여러 인스턴스의 동시 정리를 확인하지 않았다.
- 상태 전이는 앱 코드가 아니라 같은 열을 바꾸는 SQL로 만들었다. 앱 프로세스(Worker)를 띄워 측정하지 않았다.
- 본문 크기와 전이 횟수가 단순하다(본문 한 크기, 호출처 5개, 계정 1개). 실제 본문이 압축되면 TOAST 크기가 다르다.
- `n_dead_tup`은 추정값이고 10초 간격 표본이다. 표본 사이의 최댓값은 놓쳤을 수 있다.
- 실제 `pg_dump`, 복제, prepared transaction을 만들어 보지 않았다. 쿼리 3의 `pg_prepared_xacts`와 `pg_replication_slots`는 빈 결과로 실행만 확인했다.

## 검증하지 않은 것

- 운영 크기(수백만 행)와 다중 인스턴스에서의 팽창, autovacuum 지연, 보존 삭제 소요.
- 실제 `pg_dump` 실행 중의 VACUUM 지연(읽기 전용 `REPEATABLE READ` 트랜잭션으로 대신했다).
- `VACUUM FULL`의 잠금과 실행 시간(실행하지 않았다).
- 파티셔닝 제약(PostgreSQL 문서 지식).
- autovacuum 매개변수를 바꿨을 때의 효과.
- 위 SQL의 실제 PostgreSQL 13~16 동작. 17.11에서만 실행했다. 쿼리가 쓰는 뷰와 함수(`pg_stat_user_tables`, `pg_stat_activity.backend_xmin`, `regnamespace`)는 13 이상에 있다고 알고 있지만 확인하지 않았다(가정).
