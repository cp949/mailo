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
- 2026-11-23 코드 리뷰 반영: 결정 12의 "새 점유를 멈춘다" 시점과 종료 순서는 구현 중 확정 6이 정한다. 구현 중 확정 5의 회수 시점 서술은 구현 중 확정 7이 정정한다. 결정 문구는 그대로 둔다.
- 2026-11-23 코드 리뷰 반영(2): DB 시간제한, 결과 기록 재시도, `pause()`의 대기 상한, 풀 크기 검사는 구현 중 확정 8이, `stop_grace_period` 검사는 구현 중 확정 9가 정한다(결정 6·12 보완). 구현 중 확정 6의 "검사하는 코드는 없다"는 구현 중 확정 9가 정정한다. 결정 문구는 그대로 둔다.
- 2026-11-24 ADR-0013 "2026-11-24 pause 경쟁 수정" 절: 구현 중 확정 6의 `pause()` 시점을 점유 호출 단위로 풀어 쓴다. `pause()` 때 이미 시작한 `claim` 호출은 끝까지 가고 호출 도중 등록된 작업을 읽을 수 있으며, 이 동작은 막지 않는다. 같은 라운드의 다음 계정 호출은 시작하지 않는다. 결정 문구는 그대로 둔다.
- 2026-11-24 마이그레이션 실행기: 구현 중 확정 8이 정한 advisory lock 대기 예외(`lock_timeout = 0`)는 `CREATE INDEX CONCURRENTLY` 마이그레이션과 교착할 수 있다. 현재 동작과 측정은 구현 중 확정 12가 적는다. 결정 문구는 그대로 둔다.
- 2026-11-23 ADR-0010 승인: 결정 7의 "요청별 지정은 미결정이다"는 ADR-0010 결정 1~3이 정한다(요청 `ttlSeconds`, 범위 60~`MAILO_JOB_EXPIRY_MAX_SECONDS`). 만료 시각을 등록 때 DB `now()`로 고정하는 방식(결정 7·10)은 그대로다. 결정 문구는 그대로 둔다.
- 2026-11-23 ADR-0009 승인: 구현 중 확정 2의 점유 부분 인덱스와 점유 순서는 ADR-0009가 이어받는다(우선순위 경로·대기 순서 경로, 새 부분 인덱스). 결정 4는 점유 순서를 고정하지 않았으므로 대체하는 결정은 없다. 결정 문구는 그대로 둔다.
- 2026-11-24 ADR-0011 승인: 결정 7의 상태 표에 `CANCELED`와 전이 두 줄(`PENDING → CANCELED`, `RETRY_WAIT → CANCELED`)이 추가된다(ADR-0011 결정 4). 결정 문구는 그대로 둔다. "미확정"의 `CANCELED` 상태 항목은 ADR-0011 결정 4가 정한다. 구현 상태: 구현 전(선행 작업만 완료).

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
   - 만료 시각은 등록 시각에 만료 TTL(설정)을 더해 계산한다. 요청별 지정은 미결정이다. [결정됨: ADR-0010. 요청 `ttlSeconds`, 생략하면 설정값.]
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
   - kill에서 두 번째 수신까지 100초(1회차)와 95초(2회차)였다. lease는 45초다. 회수는 주기 sweep(기본 60초)에서 하고 `LEASE_EXPIRED` 시도 뒤 재시도 백오프를 거치므로 lease 만료 직후가 아니다(코드 읽기 결과이며 시점별 로그로 분리해 확인하지 않았다). [정정됨: 구현 중 확정 7. 회수는 주기 sweep만이 아니고, 지연의 대부분은 재시도 백오프다.]
   - 결론은 at-least-once다. SMTP 서버가 이미 수락한 메시지도 응답을 받지 못하면 재발송된다. 같은 `Message-ID`가 완화 수단으로 동작하는지(받는 쪽이 중복으로 버리는지)는 실제 Gmail로 확인하지 않았다.
   - 이 검증으로 알게 된 설정 제약은 `docs/operations/deployment.md`의 `MAILO_SMTP_TIMEOUT_SECONDS` 행이다(lease 20초는 기동 거부).

6. **종료 순서와 "새 점유를 멈춘다" 시점(결정 12, 2026-11-23 코드 리뷰, `src/app-lifecycle.ts`·`src/worker/worker.ts`·`src/app.ts`).** 결정 문구는 바꾸지 않는다. [보완됨: ADR-0013 "2026-11-24 pause 경쟁 수정". "새 점유를 멈춘다"는 `pause()` 때 이미 시작한 `claim` 호출을 멈추지 않는다. 그 호출이 `pause()` 뒤 등록된 작업을 읽는 것은 막지 않는다.]
   - 이전 구현은 HTTP 서버를 닫은 뒤에야 Worker를 멈췄다. 본문을 다 보내지 않는 요청이 서버 닫기를 붙잡으면 그동안 Worker가 새 작업을 계속 점유했고, drain 시계도 늦게 시작했다.
   - 종료 순서: SIGTERM → Worker `pause()`(새 점유 중지, 진행 중 전송과 주기 작업은 계속) → HTTP 서버 닫기와 파일 폴러 정지(진행 중 파일 완료)를 함께 진행 → Worker `stop()`(진행 중 전송 drain) → DB 풀 닫기. `pause()`는 Nest `beforeApplicationShutdown` 맨 앞에서 부른다. 결정 12와 RQ-025의 "종료 신호를 받으면 새 점유를 멈춘다"가 이제 코드와 같은 시점이다.
   - drain 상한(`lease - 10초`)은 `pause()` 시점부터 센다. HTTP 닫기에 걸린 시간도 상한에 포함되므로 SIGTERM 뒤 종료 시간의 상한은 drain 상한과 DB 풀 닫기 시간이다.
   - HTTP 서버 시간제한은 요청 수신 30초(`requestTimeout`), 헤더 수신 30초(`headersTimeout`)다. 설정 변수 없이 `src/app.module.ts`의 상수 `DEFAULT_HTTP_TIMEOUTS`다. Node는 `server.close()`를 부른 뒤 이 시간제한 점검을 멈춘다(실측: 닫기 뒤 느린 요청이 끝까지 남아 `app.close()`가 끝나지 않았다). 그래서 종료 훅이 유휴 연결을 닫고(`closeIdleConnections`) `requestTimeout`이 지나면 남은 연결을 끊는다(`closeAllConnections`).
   - drain 상한이 지나도 진행 중 작업의 lease를 풀지 않는다. 남은 전송을 끊고 결과를 기록하지 않으며, 다음 `claim`의 lease 만료 회수가 이어받는다(중복 발송 가능, RQ-013). 이 동작은 이전부터 같았고 이제 테스트가 고정한다(`worker.integration-spec.ts`).
   - `stop_grace_period`는 drain 상한 + 10초 이상이어야 한다. 기본값은 lease 120초, drain 상한 110초, `stop_grace_period` 150초이므로 충족한다(여유 40초).
   - drain 상한은 SMTP 시간제한(연결·greeting·소켓, 기본 10·10·30초)의 최장값과 HTTP `requestTimeout` 30초 중 긴 쪽보다 길어야 한다. 한 건 전체 마감(`totalMs`, 기본 90초)은 기동 검증이 `totalMs + 10초 ≤ lease`로 강제하므로 `totalMs ≤ lease − 10초`, 곧 drain 상한 이하다. 연결·greeting·소켓은 `totalMs` 안에 있다. HTTP 30초는 lease가 40초 이상이면 drain 상한 안에 들어간다. 그보다 짧은 lease에서는 HTTP 닫기가 drain 상한을 넘을 수 있지만 둘은 병행하므로 `stop_grace_period`를 넘기는 쪽은 더 긴 하나뿐이다. 이 관계는 기재만 하고, `stop_grace_period`를 검사하는 코드는 없다(`docs/operations/deployment.md`). [정정됨: 구현 중 확정 9. 이제 `MAILO_STOP_GRACE_PERIOD`가 설정된 경우 앱이 검사한다.]
   - 종료 중 SIGKILL(`stop_grace_period` 초과 포함)은 중복 발송 1회를 만들 수 있다. at-least-once 범위다(구현 중 확정 5).
   - 검증: `test/worker/worker.integration-spec.ts`, `test/http/lifecycle.integration-spec.ts`. 시간제한은 테스트에서 줄여 확인했고 컨테이너 SIGTERM은 이 변경 뒤 다시 실행하지 않았다. [정정됨: 같은 날 이 순서로 `scripts/container/verify-sigterm-file.sh`를 다시 실행해 종료 코드 0, 22건 등록 = 22건 처리, 재기동 뒤 1000건 `SENT`를 확인했다(`mail-sending.md` RQ-025 판정 근거).]
7. **lease 회수 경로 정정(구현 중 확정 5, 2026-11-23 코드 리뷰).** 구현 중 확정 5의 "회수는 주기 sweep(기본 60초)에서 한다"는 부정확하다. 회수는 두 곳에서 일어난다.
   - `claim()` 앞단의 `recoverExpiredLeases`(`src/queue/claim.ts`). 점유 폴링마다 실행하므로 폴링 간격(기본 1초)으로 돈다.
   - 유지보수 루프(`MAILO_MAINTENANCE_INTERVAL_SECONDS`, 기본 60초). 점유가 멈춘 상태(차단기 `open` 등)에서도 회수가 돌게 한다.
   - 관찰한 100초와 95초의 대부분은 `LEASE_EXPIRED` 시도 뒤의 재시도 백오프(첫 재시도 기본 60초 ±20%)이고 회수 지연이 아니다(코드 읽기 결과이며 시점별 로그로 분리해 확인하지 않았다).
8. **DB 시간제한, 결과 기록 재시도, `pause()` 대기 상한, 풀 크기(결정 6·9·12 보완, 2026-11-23 코드 리뷰, `src/db/`·`src/worker/worker.ts`·`src/config/load-config.ts`).** 결정 문구는 바꾸지 않는다.
   - **문제.** 연결이 RST 없이 끊기면 `claim`·`completeAttempt`가 응답을 기다리며 멈춘다. `pause()`가 이 호출을 기다리므로 SIGTERM 뒤 종료가 `stop_grace_period`를 넘겨 SIGKILL이 되고 진행 중 전송이 재발송된다. 멈춘 트랜잭션은 차단기 행 잠금과 xmin을 잡아 이벤트 피드도 멈춘다. 이전에는 시간제한이 없었다. 결과 기록 재시도는 3회(200ms, 800ms)였고 풀 크기와 동시 전송 수의 관계를 검사하지 않았다.
   - **시간제한(추정 기본값, 환경 변수로 변경).** 앱 풀 연결에 `statement_timeout` 30초, `lock_timeout` 10초, `idle_in_transaction_session_timeout` 60초를 시작 매개변수로, pg `query_timeout` 35초와 keepAlive(첫 탐침 10초)를 건다. `query_timeout`은 `statement_timeout`보다 길어야 한다. 서버가 먼저 취소해 연결이 살아남게 하기 위해서다. 서버가 응답하지 않는 단절은 `query_timeout`이 끊는다. keepalive만으로는 감지에 수 분이 걸릴 수 있어(Linux 기본 75초 × 9회, 미측정) 실제 상한은 `query_timeout`이다.
   - pg는 `query_timeout`이 지나도 연결을 닫지 않는다. `withTransaction`은 이 오류나 ROLLBACK 실패 때 연결을 풀에 돌려주지 않고 버린다(`pool.query`는 pg-pool이 버린다). 응답 없는 연결에 ROLLBACK을 보내면 같은 시간만큼 더 기다리기 때문이다.
   - 마이그레이션 CLI는 `statement_timeout` 없이 `lock_timeout` 10초만 건다. 인스턴스 사이의 advisory lock 대기는 `lock_timeout = 0`으로 예외를 둔다. 정리 쿼리는 500건 배치라 30초 안에 끝난다고 가정했다(미측정). [정정됨: 구현 중 확정 10. 배치는 1,000건이다.] [보완됨: 구현 중 확정 12. 이 대기는 `CREATE INDEX CONCURRENTLY`와 교착할 수 있다.]
   - **`pause()` 상한.** 진행 중인 점유 호출을 drain 상한과 `Promise.race`로 묶는다. 상한이 지나면 `pause_timeout` 경고를 남기고 넘어간다. 그 뒤 늦게 돌아온 점유는 처리하지 않는다(`claim_after_drain_timeout`). 점유 호출이 끝나지 않았으면 `stop()`도 미완료(`drained: false`)로 보고 전송 취소 신호를 올린다. DB 풀 닫기는 5초까지만 기다린다.
   - **결과 기록 재시도.** [보완됨: 구현 중 확정 11. 마지막 시도의 최악 시간을 마감 판정에 더한다.] lease 마감(점유 호출 전 단조 시각 + lease − 10초, lease가 20초 이하이면 여유를 lease의 절반으로)까지 200ms에서 시작해 2배씩 늘리는 backoff(간격 5초 상한, ±20%)로 재시도한다. 첫 시도는 항상 한다. 마감이 지났거나 종료로 전송을 끊었으면 포기하고 lease 회수에 맡긴다. 시각은 단조 시계이고 작업 시각은 계속 DB `now()`다(결정 10).
   - **풀 크기.** 기동 때 `MAILO_DB_POOL_MAX` ≥ `MAILO_WORKER_CONCURRENCY` + 4를 검사한다. 4는 점유, 주기 작업, HTTP·헬스·파일 폴러 몫의 추정이다. 기본값(풀 10, 동시 4)은 통과한다.
   - 검증: `test/db/pool-timeout.integration-spec.ts`, `test/worker/worker-resilience.integration-spec.ts`, `test/config/load-config.spec.ts`. 한계: 실제 RST 없는 네트워크 단절은 재현하지 않았다.
9. **`stop_grace_period` 검사와 compose 변수(결정 12 보완, 구현 중 확정 6 정정, 2026-11-23 코드 리뷰, `src/config/load-config.ts`·`docker-compose.yml`).** 결정 문구는 바꾸지 않는다.
   - compose의 `stop_grace_period`는 `${MAILO_STOP_GRACE_PERIOD:-150s}`이고 같은 값이 앱의 환경 변수 `MAILO_STOP_GRACE_PERIOD`로 전달된다. 앱은 이 변수가 있을 때만 `max(1초, lease − 10초) + 10초` 이상인지 검사하고 어긋나면 기동을 거부한다. 앱이 오케스트레이터 설정을 알 수 없는 환경이 있어 변수가 없으면 검사하지 않는다. 표기는 compose와 같은 기간(`150s`, `2m30s`, `1h`)이다.
   - 검증: `test/config/load-config.spec.ts`(경계값, 형식 오류, lease 변경), `test/config/compose-consistency.spec.ts`(compose 기본값과 `.env.example` lease의 관계). compose는 텍스트 패턴으로 검사한다. `docker compose config`로 기본값 `2m30s`와 `MAILO_STOP_GRACE_PERIOD=3m` 재정의가 `stop_grace_period`에 반영됨을 수동 확인했고, 실행 중 컨테이너의 `StopTimeout`은 확인하지 않았다.

10. **정리 작업 배타 실행과 기본값 단일 출처(결정 7, 구현 중 확정 3·8 보완, 2026-11-23 코드 리뷰, `src/queue/maintenance.ts`, `src/worker/options.ts`).** 결정 문구는 바꾸지 않는다.
    - **정리 잠금.** 만료 sweep, lease 회수(유지보수 루프 호출), 본문 삭제, 보존 삭제는 배치마다 짧은 트랜잭션을 열고 첫 문장으로 `pg_try_advisory_xact_lock(7364223, 단계)`를 시도한다(sweep 1, lease 2, bodies 3, records 4). 못 잡으면 다른 인스턴스가 그 단계를 도는 중이므로 기다리지 않고 0건으로 건너뛴다. 트랜잭션 수준 잠금이라 커밋·롤백·연결 폐기 때 풀린다. 정리 전체를 한 트랜잭션에 묶지 않는다. 삭제로 xid를 받은 트랜잭션이 길어지면 `xmin`이 붙들려 이벤트 피드 cursor가 멈추고 `statement_timeout`(30초)·`idle_in_transaction`(60초)에도 걸리기 쉽기 때문이다.
    - **효과와 한계.** 같은 단계를 인스턴스 둘이 동시에 도는 일은 없어진다. 배치 사이에는 다른 인스턴스가 끼어들 수 있고 정합성은 기존 `FOR UPDATE SKIP LOCKED`가 지킨다. 한 인스턴스가 한 주기를 끝낸 직후 다른 인스턴스가 같은 단계를 한 번 더 도는 것은 막지 않는다(비어 있으면 인덱스 조회 한 번이다). 배치 상한은 한 트랜잭션이 1초 안팎에 끝나도록 1,000건(`MAINTENANCE_BATCH_SIZE`, 추정, 이전 500)으로 했다. 위 구현 중 확정 8의 "정리 쿼리는 500건 배치라 30초 안에 끝난다"는 이 값으로 바뀌었고 소요 시간은 측정하지 않았다.
    - **점유 앞단의 lease 복구는 잠금 없이 유지한다.** `claim` 안의 `recoverExpiredLeases`는 그대로다(결정 5: 점유가 먼저 회수한다). 복구가 다른 인스턴스의 정리 잠금에 막혀 지연되면 정체와 중복 발송으로 이어질 수 있어서다. 유지보수 루프의 호출만 `exclusive: true`로 잠금을 쓴다.
    - **기본값 단일 출처.** `defaultWorkerOptions`가 만든 기본값(점검 30초, 정리 10분)과 `loadConfig`의 기본값(60초)이 달랐다. 문서(구현 중 확정 3, `deployment.md`)는 60초다. 이제 기본값은 `loadConfig`가 읽는 값(`defaultWorkerConfig`)이 정하고 `defaultWorkerOptions`는 그것을 `workerOptionsFromConfig`로 바꾼 값이다. 점검·정리 주기 기본값이 테스트 기본값에서 60초로 바뀌었다(운영 값은 변하지 않았다). 설정의 타입은 `WorkerConfig`, Worker가 쓰는 옵션은 `WorkerOptions`로 이름을 나눴다. 계정 오류 사유 타입은 큐의 `AccountErrorReason` 하나다. 큐 모듈의 `defaultRetryPolicy`·`defaultBreakerConfig`는 큐 테스트용으로 남기고 `loadConfig` 기본값과 같다는 것을 단위 테스트로 고정했다(`test/worker/worker.spec.ts`).
    - 검증: `test/queue/maintenance.integration-spec.ts`(다른 연결이 잠금을 쥐면 0건, 풀리면 처리, 단계별 독립, 점유 앞단 복구는 영향 없음).

11. **결과 기록 재시도의 마지막 시도 한계, DB 시간제한과 lease의 관계, 시도 기록의 instance(구현 중 확정 8 보완, 2026-11-23 2차 코드 리뷰, `src/worker/worker.ts`·`src/config/load-config.ts`·`migrations/0003_attempt_instance.sql`).** 결정 문구는 바꾸지 않는다.
    - **문제.** 구현 중 확정 8의 기록 재시도는 "다음 시도 시작 < 마감(lease − 10초)"만 봤다. 시도 하나는 연결 대기(기본 5초) 뒤 응답 없는 쿼리를 `query_timeout`(기본 35초)까지 기다릴 수 있어서, 마감 직전에 시작한 시도가 lease를 넘기면 다른 인스턴스가 회수해 다시 발송할 수 있다(`lease_token` 때문에 이중 기록은 없다). `MAILO_DB_QUERY_TIMEOUT_MS`는 최대 3,600,000ms까지 받았고 lease와의 관계를 검사하지 않았다.
    - **재시도 조건.** `다음 시도 시작 + recordAttemptMaxMs < 마감`이다. `recordAttemptMaxMs = 연결 대기 + query_timeout`(`toWorkerOptions`가 설정에서 만든다, 기본 40초). 기록 트랜잭션에 `SET LOCAL statement_timeout`을 두는 안은 택하지 않았다. 문장마다 걸리는 값이라 트랜잭션 전체 시간을 묶지 못하고, 서버 응답이 없는 단절은 서버 쪽 설정이 막지 못한다.
    - **기동 검사.** `MAILO_DB_CONNECT_TIMEOUT_MS + MAILO_DB_QUERY_TIMEOUT_MS < MAILO_LEASE_SECONDS × 1000 − 10000`이 아니면 기동을 거부한다. 기본값(40초)은 lease 120초에서 통과하고 lease 50초 이하에서는 거부된다.
    - **한계.** 한 트랜잭션의 여러 문장이 각각 `query_timeout` 가까이 걸리는 경우(느리지만 응답은 오는 DB)는 총 시간이 이 합을 넘을 수 있다. 응답 없는 연결은 첫 문장에서 걸리고 `withTransaction`이 그 연결을 버리므로 단절에는 이 계산이 맞다. 둘 다 실제 단절로 재현하지 않았고 가상 시계로 재시도 시작 시각의 상한만 확인했다(`worker-resilience.integration-spec.ts`).
    - **시도 기록의 instance.** `mail_attempts.instance`(NULL 허용, 128자 이하 CHECK, `NOT VALID`)를 `0003`으로 추가했다. 결과를 기록하는 Worker가 로그의 `instance`(`MAILO_INSTANCE_ID`, 없으면 호스트 이름)와 같은 값을 쓴다. 로그의 `jobId`로 시도 행을 찾고 `instance`로 기록한 인스턴스를 확인한다. `mail_jobs`에는 `lease_owner`를 두지 않는다. 점유 상태는 `lease_token`만으로 다루고, lease 회수로 쓴 `LEASE_EXPIRED` 시도는 점유한 인스턴스를 알 수 없어 NULL이다. NULL 허용 컬럼 추가라 테이블을 다시 쓰지 않는다(PostgreSQL 11 이상). REST 응답에는 노출하지 않는다. 검증: `claim-complete.integration-spec.ts`, `worker.integration-spec.ts`.

12. **마이그레이션 실행기의 advisory lock 대기와 `CREATE INDEX CONCURRENTLY` 교착(구현 중 확정 8 보완, 2026-11-24, `src/db/migrator.ts`).** 결정 문구는 바꾸지 않는다.
    - **현재 동작.** 실행기는 `lock_timeout = 0`을 건 뒤 autocommit 단일 문장 `SELECT pg_advisory_lock(7364221001)`로 다른 인스턴스의 마이그레이션이 끝나기를 기다린다. 트랜잭션으로 실행하는 파일만 있으면 이 직렬화로 충분하다.
    - **문제.** `-- mailo:no-transaction` 파일(`CREATE INDEX CONCURRENTLY`, 이하 CIC)을 한 `migrate-cli`가 실행하는 동안 다른 `migrate-cli`가 위 락을 기다리면 `40P01`(`deadlock detected`)이 난다. 원인은 CIC가 같은 database의 기존 트랜잭션이 끝나기를 기다리는 것으로 추정한다. 대기하는 세션이 그 대기 대상이라는 점은 별도로 확인하지 않았다.
    - **결과.** 대기하던 쪽이 희생되면 그 `migrate-cli`만 종료 코드 1로 끝나고 다시 실행하면 통과한다. CIC 쪽이 희생되면 `INVALID` 인덱스가 남고 두 `migrate-cli`가 모두 실패한다. 이 경우 ADR-0009 구현 중 확정 4의 fail-closed 검사가 `INVALID` 인덱스 이름으로 막는다.
    - **측정(2026-11-24, 로컬 compose `postgres:17-alpine`, `migrate-cli` 둘을 겹쳐 실행).** 빈 DB와 작은 테이블에서 5회 모두 교착했고 대기하던 쪽이 약 1.1초 만에 희생됐다. `mail_jobs` 360만 행에서 CIC 쪽이 희생된 경우 5건 모두 `INVALID` 인덱스가 남았다. `migrate-cli` 하나만 실행했을 때는 교착이 없었다. 다른 버전, 운영 크기, 쓰기 부하 중은 측정하지 않았다.
    - **앱 쪽.** worker·intake 트랜잭션은 `pg_try_advisory_xact_lock`만 쓰고 락을 기다리지 않아 이 순환에 들어가지 않는다. CIC는 그 트랜잭션이 끝나기를 기다릴 뿐이다.
    - **오래 열린 스냅샷.** `pg_dump` 같은 긴 읽기 트랜잭션이 있으면 CIC는 `lock_timeout`(10초) 뒤 `55P03`으로 실패하고 `INVALID` 인덱스가 남을 수 있다. 측정(같은 환경): `REPEATABLE READ` 스냅샷을 20초 유지하면 CIC가 10초 뒤 실패했다.
    - **운영.** 새 CIC 마이그레이션이 들어 있는 배포는 마이그레이션을 한 번에 하나만 실행하고 그 뒤 앱을 시작한다(`docker-compose.migrate-once.yml`). 절차와 복구는 `docs/operations/deployment.md` "동시 실행 교착"과 `docs/operations/troubleshooting.md` "마이그레이션 동시 실행과 INVALID 인덱스"다.
    - **범위.** 실행기 코드는 바뀌지 않았다. 결정 6의 시간제한 구성과 위 대기 예외는 그대로다. 실행기를 바꾸려면 새 결정이 필요하다.

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
- 만료 TTL 기본값은 24시간으로 정했다(RQ-008, 추정값). 요청별 지정 여부는 미결정이다. [결정됨: ADR-0010, RQ-039.]
- 결정됨: 폴링 간격, 점유 수, 부분 인덱스, 주기 sweep 간격은 구현 중 확정 2·3이 정했다. `LISTEN/NOTIFY`는 쓰지 않는다.
- `CANCELED` 상태. 관리 기능(수동 재시도·취소) 결정과 함께 정한다.
- 결정됨: 종결 작업의 본문 삭제와 이력 보존 기간은 ADR-0008 결정 7이 정했다. 본문은 종결 후 1일, `mail_attempts`와 작업 행은 종결 후 30일이다(ADR-0005 결정 7).
- 결정됨: ORM을 쓰지 않고 `pg`와 순수 SQL을 쓴다. 마이그레이션은 `migrations/NNNN_이름.sql`을 파일명 순서로 적용하는 자체 실행기(`src/db/migrator.ts`)다.
