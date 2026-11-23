# 발송 큐는 Mailo 전용 PostgreSQL에 두고, 작업 점유는 SKIP LOCKED와 lease로 처리한다

## 상태

승인됨 (2026-11-23)

1단계에서 결정 1~12를 구현했다. 구현 중 확정한 내용은 "구현 중 확정" 절에 있다.
검증 범위는 PostgreSQL 통합 테스트와 로컬 SMTP 서버 대상 Worker 테스트다. 실제 Gmail 서버 대상 검증은 하지 않았다.

2026-11-23 리뷰 반영으로 결정 4~7을 보강했고 결정 9~12를 추가했다.
ADR-0005(Key 필수와 지문)와 ADR-0007(계정 상태 오류와 차단기) 승인(2026-11-23)으로 결정 3과 결정 7이 일부 바뀐다.
원문은 유지하고 해당 문장에 "대체됨" 표기를 붙인다.

- 결정 3의 충돌 시 처리: ADR-0005 결정 4가 대체한다.
- 결정 7의 시도 횟수 계산과 판정 순서: 계정 상태 오류에 한해 ADR-0007 결정 2가 대체한다.
- 결정 7의 주기 sweep: ADR-0007 결정 6이 차단기 `open` 중에도 멈추지 않도록 보강한다.

## 배경

요구사항 RQ-011~012, RQ-018~020이 큐의 영속성과 동시성 규칙을 정한다.

- 요청은 큐에 영속 저장돼야 한다.
- 같은 `Idempotency-Key`는 동시 요청에서도 중복 등록되지 않아야 한다.
- 여러 Worker가 같은 작업을 중복으로 가져가면 안 된다.
- 처리 중 프로세스가 종료되면 작업을 복구해야 한다.

ADR-0001에 따라 Mailo DB는 Mailo만 접근하는 내부 저장소다.
RQ-029는 구현과 운영 구조를 단순하게 유지하고 외부 의존성을 줄이도록 요구한다.

## 결정

1. **큐 저장소는 Mailo 전용 PostgreSQL이다.**
   - 별도 메시지 브로커를 두지 않는다.
2. **발송 작업, 시도 이력, 부속 기록을 테이블 다섯 개로 저장한다.**
   - `mail_jobs`: 작업 한 건당 한 행.
   - `mail_attempts`: 시도 한 건당 한 행.
   - `mail_events`: 종결 이벤트(ADR-0006 결정 2가 정의한다).
   - `mail_circuit_breaker`: 전역 차단기 상태(ADR-0007 결정 5가 정의한다).
   - `mail_intake_rejections`: 파일 수집 거부 기록(ADR-0006 결정 3이 정의한다).
   - `mail_jobs`에는 계정 상태 오류 횟수를 세는 정수 컬럼 `account_trips`가 있다(ADR-0007 결정 4).
3. **요청 등록은 unique 제약으로 멱등하게 처리한다.**
   - `(caller_id, idempotency_key)`에 unique 제약을 둔다.
   - `INSERT ... ON CONFLICT DO NOTHING`으로 등록하고, 충돌하면 기존 작업을 조회해 반환한다. 대체됨: ADR-0005 결정 4. 충돌하면 지문을 비교해 같으면 기존 작업을 반환하고 다르면 거부한다.
   - REST와 파일 채널이 같은 등록 경로를 쓴다.
   - `caller_id`는 REST에서는 인증된 호출자, 파일에서는 입력 폴더에서 얻는다.
   - Key 필수 여부와 같은 Key에 다른 내용이 올 때의 처리는 ADR-0005 결정 1·3·4가 정한다.
4. **Worker는 `FOR UPDATE SKIP LOCKED`로 작업을 점유한다.**
   - 대상은 `status IN ('PENDING', 'RETRY_WAIT')`이고 `next_attempt_at <= now()`인 행이다.
   - 점유할 때 같은 문장에서 `status`를 `SENDING`으로 바꾸고, 점유마다 새로 만든 `lease_token`(UUID)과 `lease_until`을 기록한다.
   - 전역 차단기가 `open`이면 Worker는 작업을 점유하지 않는다(ADR-0007 결정 5).
5. **`SENDING` 작업은 lease로 복구한다.**
   - `lease_until`이 지난 `SENDING` 작업은 Worker가 죽은 것으로 본다.
   - 점유 쿼리 앞단의 복구 단계가 이 작업을 처리한다. 별도 복구 sweeper를 두지 않는다.
   - 복구 단계는 `LEASE_EXPIRED` 시도를 기록하고 결정 7의 판정 순서로 전이한다. 같은 트랜잭션에서 처리한다.
   - 이 복구는 SMTP 수락 직후 장애에서 중복 발송을 일으킬 수 있다. RQ-013과 RQ-020이 이를 인정한다.
6. **상태 변경은 조건부 UPDATE로 한다.**
   - `WHERE id = ? AND status = 'SENDING' AND lease_token = ?` 조건을 건다.
   - Worker ID가 아니라 점유마다 새로 만든 토큰을 쓴다.
   - 같은 Worker가 lease를 잃은 뒤 같은 작업을 다시 점유해도, 이전 시도의 늦은 결과가 조건을 통과하지 못한다.
7. **작업 상태 전이는 아래 표와 판정 순서를 따른다.**

| 현재         | 다음         | 조건                                                    |
| ------------ | ------------ | ------------------------------------------------------- |
| `PENDING`    | `SENDING`    | Worker가 점유                                           |
| `PENDING`    | `EXPIRED`    | 점유 전에 만료 시각 도달                                |
| `SENDING`    | `SENT`       | SMTP 서버가 수락                                        |
| `SENDING`    | `RETRY_WAIT` | 시도가 실패했고 아래 판정 순서의 1~3에 해당하지 않음    |
| `SENDING`    | `FAILED`     | 판정 순서의 1 또는 2, 또는 계정 상태 오류의 `account_trips` 예외(아래) |
| `SENDING`    | `EXPIRED`    | 판정 순서의 3                                           |
| `RETRY_WAIT` | `SENDING`    | Worker가 점유                                           |
| `RETRY_WAIT` | `EXPIRED`    | 대기 중 만료 시각 도달                                  |

   - 시도가 실패로 끝났을 때(lease 만료 포함) 다음 순서로 판정한다. 먼저 맞는 조건을 적용한다.
     1. 영구 오류이면 `FAILED`.
     2. 최대 시도 횟수를 소진했으면 `FAILED`.
     3. 만료 시각이 지났으면 `EXPIRED`.
     4. 그 밖에는 `RETRY_WAIT`.
   - 대체됨(일부): 계정 상태 오류(ADR-0007 결정 1)는 판정 순서의 1·2를 건너뛰고 3·4만 적용한다(ADR-0007 결정 2). `open_until`이 `expires_at`보다 뒤이면 ADR-0003 결정 6에 따라 즉시 `EXPIRED`로 전이한다.
   - 예외: 같은 작업이 차단기를 3회 연 뒤에도 같은 응답을 받으면 `PERMANENT`로 보고 `FAILED`로 전이한다(ADR-0007 결정 4, 3회는 추정). 이 경우 판정 순서의 1을 적용한다.
   - 종결 상태는 `SENT`, `FAILED`, `EXPIRED`다. 종결 상태에서는 전이하지 않는다.
   - `FAILED`는 영구 오류 또는 시도 횟수 초과로 중단한 경우다.
   - `EXPIRED`는 만료 시각 도달로 중단한 경우다.
   - 진행 중인 시도는 만료 시각을 지나도 중단하지 않고 결과를 기다린다.
   - 최대 시도 횟수는 첫 시도를 포함한다. `LEASE_EXPIRED` 시도도 횟수에 포함한다. 대체됨(일부): 계정 상태 오류 시도는 횟수에 포함하지 않는다(ADR-0007 결정 2).
   - 만료 시각은 등록 시각에 만료 TTL(설정)을 더해 계산한다. 요청별 지정은 미결정이다.
   - 만료 판정은 점유 쿼리 시점에 한다. 상태 조회 정확도를 위해 `PENDING`·`RETRY_WAIT` 중 만료된 행을 `EXPIRED`로 바꾸는 주기 sweep을 둔다. sweep은 전역 차단기가 `open`이어도 멈추지 않는다(ADR-0007 결정 6). sweep의 `EXPIRED` 전이는 종결 이벤트를 같은 트랜잭션에서 `mail_events`에 쓴다(ADR-0006 결정 2).
8. **본문은 암호화한 컬럼에 저장한다.**
   - RQ-023을 따른다.
9. **SMTP 전송은 점유 트랜잭션 밖에서 한다.**
   - 점유 트랜잭션을 커밋한 뒤 전송하고, 결과는 별도 트랜잭션으로 기록한다.
   - 트랜잭션을 열어 둔 채 전송하면 lease가 의미를 잃고 커넥션 풀이 고갈된다.
10. **lease와 만료 시각은 DB의 `now()` 기준으로 계산한다.**
    - 앱 서버 시계를 쓰지 않는다.
11. **heartbeat는 두지 않는다.**
    - 작업 한 건에 점유가 한 번이므로 lease는 연결, greeting, 소켓 타임아웃의 합에 여유를 더한 값으로 정한다.
    - SMTP 라이브러리 타임아웃은 기본값에 의존하지 않고 명시한다.
12. **종료 신호를 받으면 새 점유를 멈추고 진행 중인 전송을 기다린다.**
    - 컨테이너의 `stop_grace_period`는 lease 이상으로 설정한다(RQ-025).
    - Docker 기본 stop 대기가 10초로 알려져 있어 SMTP 타임아웃보다 짧을 수 있다. 일반 지식이며 검증하지 않았다.
    - 그대로 두면 재배포마다 lease 복구가 일어나 중복 발송 위험이 생긴다.

## 구현 중 확정 (2026-11-23)

1단계 구현 중 확정한 내용이다. 위 결정을 보완한다.

1. **`mail_jobs` 컬럼 보완(결정 2).**
   - `recipients`(jsonb): 수신자 `{to, cc, bcc}`. 종결 이벤트가 복사한다. 평문이다(RQ-022).
   - `envelope`(jsonb): 복호화 없이 필요한 평문 발송 필드 `{from, replyTo}`. 큐는 내용을 해석하지 않는다.
   - `last_account_response`: 직전 계정 상태 오류의 응답 코드와 enhanced status code(ADR-0007 구현 중 확정 3).
   - `leased_at`: 현재 점유 시작 시각. `mail_attempts.started_at`에 쓴다.
   - 마이그레이션은 `apps/mailo/migrations/0001_queue_schema.sql`이다.
2. **점유 쿼리와 부분 인덱스(결정 4, 미확정 해소).**
   - 점유 쿼리는 만료된 행(`expires_at <= now()`)을 점유하지 않는다. 만료 전이는 sweep이 맡는다.
   - `(next_attempt_at, id) WHERE status IN ('PENDING','RETRY_WAIT')` 부분 인덱스를 둔다. 만료·lease·보존 삭제용 부분 인덱스도 있다. `LISTEN/NOTIFY`는 쓰지 않는다. 폴링이다.
   - `half_open`이면 한 번에 1건만 점유한다. 그 밖에는 설정한 한도(`MAILO_WORKER_CONCURRENCY` 기본 4에서 진행 중 건수를 뺀 값)만큼 점유한다.
3. **수치(결정 11, 미확정 해소). 모두 추정이며 설정으로 바꾼다.**
   - lease 120초(`MAILO_LEASE_SECONDS`), 폴링 간격 1초(`MAILO_WORKER_POLL_MS`, ±10% 흩뿌림), 동시 전송 4건(`MAILO_WORKER_CONCURRENCY`).
   - SMTP 타임아웃: 설정으로 받는 값은 소켓 무응답 `MAILO_SMTP_TIMEOUT_SECONDS`(기본 30초) 하나다. 연결·greeting·DNS는 이 값과 10초 중 작은 값(기본 10초)이고, 발송 한 건 전체 마감은 소켓 값의 3배와 `lease - 10초` 중 작은 값(기본 90초)이다. `totalMs + 여유 10초`와 `연결·greeting·소켓 합 + 여유 10초`가 lease 이내여야 하며 기동 시 검증한다(`src/worker/runner.ts`).
   - 종료 대기(`drainTimeoutMs`)는 lease보다 10초 짧게 둔다. `docker-compose.yml`의 `stop_grace_period`는 150초다.
   - 만료 sweep, lease 회수, 본문 삭제, 보존 삭제는 같은 주기(`MAILO_MAINTENANCE_INTERVAL_SECONDS`, 기본 60초)로 돈다.
4. **Mailo 내부 오류(독성 작업) 처리(결정 7 보완).** 판정 순서 1~4 전에 SMTP 단계가 없는 내부 오류를 `poisonMaxAttempts`(기본 3)번째 시도에서 `FAILED`로 만든다. 자세한 내용과 한계는 ADR-0007 "구현 중 확정" 6이다.

5. **SIGKILL 뒤 재발송 관찰(결정 5·12, 2026-11-23).** 실제 컨테이너에서 관찰한 사실만 적는다. 재현은 `scripts/container/verify-sigkill-duplicate.sh`(compose 프로젝트 `mailo-verify`, Mailo·PostgreSQL 17·로컬 가짜 SMTP, `MAILO_LEASE_SECONDS=45`, `MAILO_SMTP_TIMEOUT_SECONDS=10`)다.
   - 가짜 SMTP가 DATA를 모두 받아 기록한 직후 최종 250 응답을 90초 미룬다. 그 사이(수신 2초 뒤) `docker kill -s KILL`을 보냈다. 컨테이너는 `exited exit=137`이고 DB의 작업은 `SENDING`, `attempts=0`, lease 잔여 약 42초였다.
   - `docker compose start mailo` 뒤 같은 작업이 다시 발송됐다. SMTP는 같은 `Message-ID`로 2통을 받았다(1통째는 지연 응답 중에 기록됐다). 작업은 `SENT`, `attempts=2`, REST 조회 `SENT`였다.
   - kill에서 두 번째 수신까지 100초(1회차)와 95초(2회차)였다. lease는 45초다. 회수는 주기 sweep(기본 60초)에서 하고 `LEASE_EXPIRED` 시도 뒤 재시도 백오프를 거치므로 lease 만료 직후가 아니다(코드 읽기 결과이며 시점별 로그로 분리해 확인하지 않았다).
   - 결론은 at-least-once다. SMTP 서버가 이미 수락한 메시지도 응답을 받지 못하면 재발송된다. 같은 `Message-ID`가 완화 수단으로 동작하는지(받는 쪽이 중복으로 버리는지)는 실제 Gmail로 확인하지 않았다.
   - 이 검증으로 알게 된 설정 제약은 `docs/operations/deployment.md`의 `MAILO_SMTP_TIMEOUT_SECONDS` 행이다(lease 20초는 기동 거부).

## 검토한 대안

| 대안                      | 채택하지 않은 이유                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| 파일 기반 큐              | NFS의 원자적 생성·잠금, 장애 복구, `Idempotency-Key` 영속 관리를 직접 구현해야 한다      |
| Redis, BullMQ 등 브로커   | 외부 의존성이 늘고 `Idempotency-Key`와 이력의 영속 보관을 따로 설계해야 한다             |
| SQLite                    | 여러 Worker 인스턴스의 동시 쓰기가 제한된다. 이 항목은 이 세션에서 검증하지 않았다       |
| pg-boss, graphile-worker  | 같은 `SKIP LOCKED` 방식이다. 상태 모델, Key 지문, 시도 이력과 맞추는 비용이 직접 구현보다 클 것으로 본다. 추정이다 |

## 결과

- 큐, 멱등 키, 이력이 한 저장소에 있어 같은 트랜잭션으로 갱신할 수 있다.
- 운영 의존성은 Mailo 앱과 PostgreSQL 두 가지다.
- PostgreSQL이 중단되면 Mailo도 등록과 발송을 처리하지 못한다.
- 폴링 방식이므로 새 작업의 처리 지연은 폴링 간격에 좌우된다.
- 이 ADR의 SQL 동작은 통합 테스트로 확인했다. 동시 `claim` 12건이 작업 60건을 중복 없이 나눠 가지는지(`SKIP LOCKED`), 늦게 도착한 이전 점유의 결과가 거부되는지(`lease_token`), 만료 sweep과 보존 삭제가 동작하는지를 확인했다. 실제 운영 부하와 다중 인스턴스 장시간 동작은 확인하지 않았다.

## 미확정

- 결정됨: `Idempotency-Key`의 보존 기간, 유일성 범위, 같은 Key에 다른 내용이 올 때의 처리는 ADR-0005 결정 2~4, 7이 정했다. 보존 기본값은 작업 종결 후 30일이다.
- 결정됨: lease 시간과 SMTP 타임아웃 값은 구현 중 확정 3이 정했다(추정). 실제 SIGKILL 재발송은 구현 중 확정 5에서 관찰했다.
- 만료 TTL 기본값은 24시간으로 정했다(RQ-008, 추정값). 요청별 지정 여부는 미결정이다.
- 결정됨: 폴링 간격, 점유 수, 부분 인덱스, 주기 sweep 간격은 구현 중 확정 2·3이 정했다. `LISTEN/NOTIFY`는 쓰지 않는다.
- `CANCELED` 상태. 관리 기능(수동 재시도·취소) 결정과 함께 정한다.
- 결정됨: 종결 작업의 본문 삭제와 이력 보존 기간은 ADR-0008 결정 7이 정했다. 본문은 종결 후 1일, `mail_attempts`와 작업 행은 종결 후 30일이다(ADR-0005 결정 7).
- 결정됨: ORM을 쓰지 않고 `pg`와 순수 SQL을 쓴다. 마이그레이션은 `migrations/NNNN_이름.sql`을 파일명 순서로 적용하는 자체 실행기(`src/db/migrator.ts`)다.
