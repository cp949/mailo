# 관측성은 읽기 토큰으로 여는 `GET /metrics`로 낸다. 전역 값은 DB를 읽는 gauge, 인스턴스 값은 메모리 counter로 나누고 직렬화는 새 의존성 없이 직접 쓴다

## 상태

승인됨 (2026-11-24)

2026-11-24에 제안했고 같은 날 사용자가 승인했다. 열린 질문이던 9건은 이 문서가 적은 권고대로 승인했다. 승인된 값은 "미결정·확인하지 않은 것"의 "승인된 결정" 절에 모았다. 입력은 `docs/requirements/roadmap.md`의 "단계 8. 관측성"이다.

구현 상태(2026-11-24): 구현 완료(미검증 항목 있음). 결정 1~9를 구현하고 자동 테스트로 검증했다. 요구사항은 RQ-049(`/metrics` 인증과 응답 형식), RQ-050(이름·분류·라벨·시크릿 규칙), RQ-051(전역 gauge와 DB 수집), RQ-052(인스턴스 counter·gauge)다. 마이그레이션은 없다. 구현 중 확정한 세부와 결정 7 구현 배치와 다른 점은 "구현 중 확정" 절이다. `docs/api/openapi.yaml`에 `/metrics`와 `metricsReadAuth`를 더했다. `ReadyResponse`는 바뀌지 않았다.

남은 미검증 항목은 다음과 같다. "미결정·확인하지 않은 것"의 "확인하지 않은 것"과 "구현 중 확정" 절이 자세히 적는다.

- 운영 크기(수백만 행)의 쿼리 비용, 다중 인스턴스·Prometheus 복제본 여러 개의 동시 스크레이프, 예비 연결 4개 가정의 충분성.
- 롤링 배포(구·신 혼용)와 롤백 실행. 구버전 404는 코드 읽기 결과다.
- 장시간 부하에서의 counter 정확도, 실제 Gmail 응답의 `stage`·`reason` 분포.

검증 범위는 코드 읽기와 PostgreSQL 17.11(로컬 compose)의 임시 schema 확인이다(2026-11-24).

- 임시 schema에 `0001`~`0004`, `0006`~`0009`를 적용하고 `0005`의 인덱스(`mail_jobs_priority_claim_idx`)를 일반 `CREATE INDEX`로 만들었다.
- 작업 30만 행(SENT 25만, PENDING 3만, RETRY_WAIT 2만 중 1만은 예약 시각 미래, SENDING 40), 감사 2만 행, 이벤트 10만 행, 시도 6만 행을 넣고 `VACUUM ANALYZE` 뒤 `EXPLAIN (ANALYZE, BUFFERS)`를 쿼리마다 1회 실행했다. 임시 schema는 지웠다.
- 확인하지 않은 것: 자동 테스트, 실제 Prometheus 스크레이프, `promtool` 검증, 운영 크기(수백만 행)의 비용, 다중 인스턴스 동시 스크레이프, 롤링 배포.

승인으로 다음 관계가 생겼다. 승인된 ADR의 결정 문구는 바꾸지 않는다.

- ADR-0011 결정 1은 "관리 토큰은 읽기 권한을 포함한다"고 정했다. `/metrics`는 이 규칙의 예외로 관리 토큰을 받지 않는다(결정 1). 승인과 함께 ADR-0011의 상태 절에 보완 표기를 썼다.
- ADR-0011 결정 6이 단계 8로 넘긴 "감사 테이블 행 수 감시 수단"을 결정 8이 정한다. 삭제 정책은 정하지 않는다.
- RQ-031의 "`/health/ready`의 200/503에 발송 정지를 반영하지 않는다"와 `/health/ready` 응답 계약은 바뀌지 않는다(결정 9).
- RQ-029(운영 의존성은 Mailo와 PostgreSQL뿐)는 유지한다. Prometheus는 Mailo가 필요로 하는 의존성이 아니라 `/metrics`를 읽는 쪽이다. 알림은 Mailo가 보내지 않는다(결정 7).
- `docs/requirements/mail-sending.md`의 미결정 항목 "비기능 요구(처리량 목표, 메트릭)" 중 메트릭을 닫는다. 처리량 목표는 닫지 않는다. 측정 뒤에 정한다.
- 새 RQ 번호는 기능 구현 때 RQ-049 이후로 정한다. 이 ADR은 번호를 가정하지 않는다.
- 2026-11-24 ADR-0013 승인: 구현 중 확정 13의 `createMetrics({ accountIds })`와 `account_id` 값은 ADR-0013 결정 5가 정한다(구현 묶음 C). 지표 이름과 라벨 이름은 바뀌지 않는다. 결정 문구는 그대로 둔다.

## 배경

현재 동작이다(2026-11-24, 코드를 읽어 확인했다).

- 수치를 보는 경로는 `GET /health/ready`뿐이다. 운영 토큰에만 `queue`·`worker`·`filePoller`·`sendControls`를 준다(`health/health.service.ts`의 `ready`). 호출처 키에는 자기 범위의 `eventFeed`·`sendPaused`만 준다.
- `queue` 수치는 `queue/backlog.ts`의 `getQueueBacklog`가 만든다. 값은 `dueCount`(점유 대상 작업 수), `truncated`, `oldestDueAgeSeconds`와 등급별 같은 값이다. `dueCount`는 `BACKLOG_COUNT_LIMIT`(10000)에서 멈추고 `truncated`가 이를 알린다. 쿼리는 `mail_jobs_claim_idx`·`mail_jobs_priority_claim_idx`를 상한까지만 읽는다.
- 상태별 건수(`PENDING`·`RETRY_WAIT`·`SENDING`)와 종결 건수를 내는 코드는 없다. 종결 건수를 DB로 세려면 `status`로 거를 인덱스가 없다(`migrations/0001_queue_schema.sql`의 인덱스는 `claim`·`expiry`·`lease`·`finished_at`·`body`이고, `0002`가 `SENDING`용 `mail_jobs_sending_caller_idx`를 더한다).
- 헬스 쿼리는 읽기 전용 트랜잭션 하나에서 돈다. `BEGIN READ ONLY`와 `SET LOCAL statement_timeout = 2000`을 걸고 전체 3초를 넘기면 그 연결을 풀에서 버린다(`health/health.service.ts`의 `withBoundedClient`). `getBreakerState`·`getQueueBacklog`·`getFeedLag`·`getSendControlsSummary`가 이 안에서 쓰이므로 행 잠금과 쓰기가 없다.
- `getFeedLag`(`events/event-store.ts`)의 `lagSeconds`는 현재 시각에서 호출처의 피드에 보이는 최신 이벤트 시각을 뺀 값이다. 이벤트가 없는 호출처에서는 시간이 지날수록 커진다. 소비자의 처리 지연이 아니다.
- 차단기 행은 `mail_circuit_breaker` 하나이고 키는 상수 `default`다(`config/load-config.ts`의 `breakerKey`). 사유는 `AccountErrorReason` 6개이고 헬스는 이를 `AUTH_FAILED`·`TLS_FAILED`·`CONNECTION_FAILED`·`QUOTA_DAILY`·`QUOTA_BURST`·`OTHER`로 바꿔 낸다(`LAST_REASON`).
- 호출처 할당 사용량은 `queue/claim.ts`의 `planQuotas`만 계산한다. 쿼리는 호출처마다 최근 24시간 시도를 `LIMIT 할당`까지 센다. 점유 트랜잭션 안에서 호출처별 `pg_try_advisory_xact_lock`을 잡는다. 레지스트리의 할당 상한은 호출처당 최대 1000만이다(`callers/registry.ts`의 `MAX_SEND_QUOTA`).
- 운영 토큰 판정은 `callers/bearer-auth.ts`의 `checkBearer`와 `createOpsTokenMatcher`가 한다. 결과는 `{ kind: "operator", role: "read" }` 또는 `{ ..., role: "admin", name }`이다. `/ops`는 라우트 매칭 전 미들웨어(`callers/ops-auth-middleware.ts`)가 인증한다. `/metrics`에는 이런 경로가 없다.
- 요청 로그는 `http/request-context.ts`가 응답마다 한 줄 남긴다. 경로가 `/health/`로 시작하면 debug, 그 밖은 info다.
- 로그에 있는 사건 중 지표로 옮길 만한 것은 `job_completed`(결과 기록 적용), `lease_recovered`, `sweep_expired`, `job_canceled`, `event_cursor_gap`, `file_poll`(요약), `caller_quota_exceeded`, `send_paused`다. `job_completed`는 호출처 ID를 담지 않는다. 호출처는 점유한 작업(`ClaimedJob.callerId`)과 `sweepExpired`의 `RETURNING caller_id`에는 있다.
- `sweepExpired`·`recoverExpiredLeases`는 처리한 건수(숫자)만 돌려준다. 호출처별·상태별 건수는 반환하지 않는다.
- 레지스트리에 호출처 수 상한은 없다. 호출처마다 키 2개, `allowedFrom` 20개, `allowedRecipientDomains` 50개 상한만 있다(`callers/registry.ts`). 호출처 ID 형식은 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`다.
- 의존성은 `nodemailer`·`pg`·`jose`·NestJS·`rxjs`·`reflect-metadata`이고 버전을 고정한다(`apps/mailo/package.json`). 메트릭 라이브러리는 없다.
- `docs/operations/deployment.md`는 다중 인스턴스 배포를 확인하지 않은 항목으로 적는다. Mailo는 TLS를 종단하지 않는다.

측정(2026-11-24, 위 "상태"의 임시 schema, 쿼리마다 1회, 모두 로컬 단일 측정이다).

| 쿼리 | 실행 시간 | 계획 |
| ---- | --------- | ---- |
| 기존 `getQueueBacklog`의 전체 값(상한 10001) | 0.80ms | `mail_jobs_claim_idx` 인덱스 전용 스캔, 91 buffers |
| 예약 건수(`next_attempt_at > now()`, 상한 10001) | 0.84ms | `mail_jobs_claim_idx` 인덱스 전용 스캔, 52 buffers |
| `SENDING` 건수 | 0.02ms | `mail_jobs_sending_caller_idx` 인덱스 전용 스캔 |
| `PENDING`만 상한 10001로 세기 | 1.1ms | `mail_jobs_expiry_idx` 스캔 뒤 `Filter: status`, 182 buffers |
| 같은 쿼리, `PENDING` 5건과 `RETRY_WAIT` 약 5만 건(트랜잭션 안에서 만든 분포, 통계는 갱신 전) | 4.4ms | `Rows Removed by Filter: 49995`. 읽는 양이 `RETRY_WAIT` 건수에 비례한다 |
| 호출처 5개, 할당 10000인 사용량 | 3.4ms | `mail_attempts_quota_idx` 인덱스 전용 스캔, 호출처당 10000행 |
| 호출처 20개의 최신 이벤트 시각(`LATERAL`) | 0.23ms | `mail_events_feed_idx` 역방향 스캔 |
| 감사 행 수(상한 100001, 2만 행) | 0.76ms | `Seq Scan` |
| 감사 가장 오래된 행 시각 | 0.23ms | `mail_ops_audit_pkey` 스캔 |

## 결정

1. **`GET /metrics`는 읽기 토큰(`MAILO_OPS_TOKEN`)만 받는다. 관리 토큰은 403이다.**
   - 문제: Prometheus 설정에는 토큰이 평문 파일로 놓인다. 관리 토큰이 거기 놓이면 정지·취소 권한이 모니터링 시스템에 퍼진다(ADR-0011 결정 1의 문제와 같다).
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 읽기 토큰만, 관리 토큰은 403 | 권고. 관리 토큰을 Prometheus에 둔 오설정이 403으로 바로 드러난다 |
     | B. 읽기·관리 토큰 모두 | ADR-0011 결정 1의 "관리는 읽기 포함"과 일관된다. 오설정을 막지 못한다. `/health/ready`처럼 두 토큰을 받는 선례는 있다 |
     | C. 인증 없음(공개) | 호출처 ID 라벨, 큐 규모, 차단기 사유, 정지 상태가 노출된다. 인증 없는 `/health/ready`는 `circuitBreaker.state` 하나만 낸다(RQ-031). 채택하지 않는다 |
     | D. `MAILO_METRICS_TOKEN`을 따로 둔다 | 변수와 키 교체 절차가 늘어난다. ADR-0011이 읽기 토큰을 감시용으로 이미 정했다 |
     | E. 별도 포트에서 연다 | 새 포트와 compose 변경이 필요하다. 인증은 여전히 필요하다 |

   - 결정 문구(A):
     - 판정은 `callers/bearer-auth.ts`에 `MetricsReadGuard`를 더해 한다. `checkBearer` 결과가 `operator`이고 `role: "read"`이면 통과한다.
     - `role: "admin"`이면 403(`urn:mailo:problem:forbidden`)이다. 호출처 API 키, 자격 없음, 모르는 값은 401이다.
     - `MAILO_OPS_TOKEN`이 없으면 어떤 값도 읽기 권한이 아니므로 `/metrics`는 401이다. endpoint는 항상 존재한다.
     - 토큰 값은 로그·응답에 쓰지 않는다.
   - 관계: ADR-0011 결정 1의 "관리 토큰은 읽기 권한을 포함한다"는 `/health/ready`와 `GET /ops/*`에는 그대로다. `/metrics`만 예외다. `docs/api/openapi.yaml`에 `metricsReadAuth` 스키마를 새로 둔다(`opsReadAuth`는 관리 토큰도 받는다고 적혀 있어 재사용하지 않는다).
   - 망 수준 제한은 별개로 권한다. Mailo는 TLS를 종단하지 않으므로 Prometheus는 같은 호스트·내부 망·TLS 프록시 뒤에서만 접근한다(`deployment.md`와 같은 전제).

2. **경로와 응답 형식은 다음과 같다.**
   - `GET /metrics`. `/ops` 아래에 두지 않는다. Prometheus 관례 경로이고 `/ops`는 JSON 운영 REST다.
   - 200, `Content-Type: text/plain; version=0.0.4; charset=utf-8`, `Cache-Control: no-store`.
   - 인증 오류 외에는 항상 200이다. DB 조회가 실패해도 200이고 전역 gauge 그룹을 응답에서 뺀 뒤 `mailo_metrics_collect_ok{group}`을 0으로 낸다(결정 5). 이유는 DB가 죽은 동안에도 인스턴스 counter와 `collect_ok=0` 신호가 수집돼야 하기 때문이다. `/health/ready`의 DB 장애 503과 목적이 다르다.
   - 요청 로그는 `/metrics`를 debug로 남긴다(`http/request-context.ts`의 `/health/` 판정에 `/metrics`를 더한다). 15초 간격 스크레이프가 인스턴스마다 info 줄을 만들지 않게 한다.
   - 응답 크기는 호출처 50개일 때 시리즈 1천 개 안팎이고 수십~백 KB로 추정한다(가정, 구현 전 계산이다).

3. **지표는 전역 gauge와 인스턴스 값으로 나누고 이름으로 구분한다.**
   - 문제: 큐 건수 같은 전역 값을 인스턴스마다 내면 `sum`으로 합칠 때 인스턴스 수만큼 곱해진다(로드맵 단계 8).
   - 분류와 이름 규칙:

     | 분류 | 종류 | 이름 규칙 | 합치는 법 |
     | ---- | ---- | --------- | --------- |
     | 전역 | gauge만 | `mailo_queue_`, `mailo_breaker_`, `mailo_send_paused`, `mailo_caller_`, `mailo_ops_audit_` 접두. DB(또는 설정)에서 정해지고 어느 인스턴스가 내도 같다 | `max by (...)`. `sum` 금지 |
     | 인스턴스 counter | counter만 | `mailo_*_total`. 이 프로세스가 한 일이다 | `sum by (...) (rate(...))` |
     | 인스턴스 gauge | gauge | `mailo_worker_`, `mailo_file_poller_`, `mailo_metrics_` 접두 | 인스턴스별로 본다 |
     | 프로세스 | counter·gauge | Prometheus 관례 이름 3개: `process_start_time_seconds`, `process_resident_memory_bytes`, `process_cpu_seconds_total` | 인스턴스별로 본다 |

   - 공통 규칙: Prometheus 관례를 따른다. 이름은 `^[a-z][a-z0-9_]*$`, 시간은 `_seconds`, counter는 `_total`로 끝나고 gauge는 `_total`로 끝나지 않는다. HELP 첫 단어는 "전역." 또는 "인스턴스."다.
   - 이름·종류·분류·라벨 이름·허용 값은 코드의 카탈로그(`metrics/catalog.ts`) 한 곳에 둔다. 단위 테스트가 위 규칙(전역은 gauge, counter는 인스턴스와 `_total`, 접두, 라벨 이름 허용 목록)을 카탈로그 전체에 검사한다.
   - `instance` 라벨은 앱이 붙이지 않는다. Prometheus의 타깃 라벨이 준다.
   - 스크레이프는 인스턴스마다 직접 한다. 로드 밸런서 하나를 타깃으로 두면 요청이 인스턴스를 번갈아 가므로 counter가 줄었다 늘며 `rate()`가 틀린다. 운영 문서에 쓴다(부록 A).

4. **지표 목록은 다음과 같다.** `account_id`는 단계 7 전에 상수 `default`다(결정 6). 값이 없는 경우는 표의 설명을 따른다.

   전역 gauge(DB 조회, 결정 5):

   | 이름 | 라벨 | 값 |
   | ---- | ---- | -- |
   | `mailo_queue_jobs` | `account_id`, `state`=`due`·`scheduled`·`sending` | 점유 가능(`due`), 재시도·예약 대기(`scheduled`, `next_attempt_at`이 미래), 점유 중(`sending`) 건수. `due`·`scheduled`는 10000에서 멈춘다 |
   | `mailo_queue_jobs_truncated` | `account_id`, `state`=`due`·`scheduled` | 1이면 해당 건수가 상한에 닿았다. `/health/ready`의 `dueCountTruncated`와 같은 뜻 |
   | `mailo_queue_oldest_due_age_seconds` | `account_id`, `priority`=`low`·`normal`·`high`·`urgent` | 그 등급에서 가장 오래 기다린 점유 가능 작업의 경과 초. 대기 작업이 없으면 0. 전체 값은 `max by (account_id)`다 |
   | `mailo_breaker_state` | `account_id`, `state`=`closed`·`open`·`half_open` | 현재 상태 시리즈만 1, 나머지 0. 행을 읽지 못하면 세 시리즈 모두 뺀다 |
   | `mailo_breaker_reason_info` | `account_id`, `reason` | 상태가 `closed`가 아니고 사유가 있을 때만 1인 시리즈 하나. `reason`은 헬스 `lastReason`과 같은 어휘다 |
   | `mailo_send_paused_all` | 없음 | 전체 정지 0/1 |
   | `mailo_send_paused_callers` | 없음 | 호출처 정지 개수. 레지스트리에 없는 호출처의 정지도 센다 |
   | `mailo_caller_paused` | `caller_id` | 레지스트리 호출처별 0/1 |
   | `mailo_caller_quota_limit` | `caller_id` | `sendQuota24h`. 설정한 호출처만. DB가 아니라 이 인스턴스의 레지스트리 값이다 |
   | `mailo_caller_quota_used` | `caller_id` | 최근 24시간 시도 수 + 점유 중 수. 쿼리가 `LIMIT 할당`으로 세므로 값은 한도에서 멈춘다. 설정한 호출처만 |
   | `mailo_caller_latest_event_age_seconds` | `caller_id` | 피드에 보이는 최신 이벤트의 경과 초. 이벤트가 없으면 시리즈를 뺀다. 소비 지연이 아니다(배경) |
   | `mailo_ops_audit_rows` | 없음 | 감사 행 수. 100000에서 멈춘다(결정 8) |
   | `mailo_ops_audit_rows_truncated` | 없음 | 1이면 상한에 닿았다 |
   | `mailo_ops_audit_oldest_age_seconds` | 없음 | 가장 오래된 감사 행의 경과 초. 행이 없으면 0 |

   인스턴스 counter(메모리, 재시작하면 0에서 다시 시작한다):

   | 이름 | 라벨 | 증가 시점 |
   | ---- | ---- | --------- |
   | `mailo_attempts_total` | `caller_id`, `account_id`, `result`=`sent`·`transient`·`permanent`·`account`·`internal` | 결과 기록이 적용됐을 때(`completeAttempt`의 `applied: true`). `internal`은 `AttemptOutcome.internal`이 true인 결과다. `LEASE_LOST`로 버린 결과는 세지 않는다 |
   | `mailo_attempt_errors_total` | `account_id`, `result`=`transient`·`permanent`·`account`·`internal`, `stage`=`conn`·`tls`·`auth`·`mail_from`·`rcpt`·`data`·`worker`·`unknown`, `reason`=`none`·`daily_limit`·`rate_limit`·`connection`·`tls`·`auth`·`other` | 실패 결과마다. `reason`은 `account`일 때만 `none`이 아니다. 응답 코드·텍스트는 라벨에 넣지 않는다 |
   | `mailo_jobs_finished_total` | `caller_id`, `account_id`, `status`=`sent`·`failed`·`expired`·`canceled` | 이 인스턴스가 커밋한 종결 전이마다. 결과 기록, 만료 sweep, lease 복구, 취소 네 경로다. 멱등으로 끝난 반복 취소는 세지 않는다 |
   | `mailo_claim_polls_total` | `result`=`claimed`·`empty`·`error` | 점유 루프의 `claim` 호출마다 |
   | `mailo_claimed_jobs_total` | `caller_id`, `account_id` | 점유한 작업 수 |
   | `mailo_lease_recovered_total` | `account_id` | lease 만료로 회수한 작업 수. 중복 발송 가능성의 신호다(RQ-013) |
   | `mailo_file_channel_files_total` | `caller_id`, `result`=`registered`·`duplicate`·`rejected`·`unreadable`·`delete_failed` | 파일 폴링 요약(`PollSummary`)의 같은 이름 필드 |
   | `mailo_event_cursor_gap_total` | `caller_id` | `event_cursor_gap` 로그와 같은 시점(ADR-0011 구현 중 확정 25) |
   | `mailo_metrics_dropped_samples_total` | 없음 | 시리즈 상한 때문에 버린 증가(결정 6) |

   인스턴스 gauge:

   | 이름 | 라벨 | 값 |
   | ---- | ---- | -- |
   | `mailo_worker_state` | `state`=`disabled`·`idle`·`running`·`paused`·`stopping`·`stopped` | 현재 상태만 1(원핫) |
   | `mailo_worker_in_flight_jobs` | 없음 | 진행 중 전송 수. Worker가 꺼져 있으면 시리즈를 뺀다 |
   | `mailo_worker_last_poll_age_seconds` | 없음 | 점유 루프가 마지막으로 돈 뒤 경과 초. 아직 안 돌았으면 시리즈를 뺀다 |
   | `mailo_worker_claim_failure_streak` | 없음 | 연속 점유 실패 수 |
   | `mailo_worker_poll_loop_crashed` | 없음 | 0/1. 1이면 프로세스가 종료 코드 70으로 끝나는 중이다 |
   | `mailo_file_poller_enabled` | 없음 | 0/1 |
   | `mailo_file_poller_running` | 없음 | 0/1. 꺼져 있으면 0 |
   | `mailo_file_poller_callers` | 없음 | 폴링 대상 호출처 수 |
   | `mailo_file_poller_last_poll_age_seconds` | 없음 | 마지막 폴링 뒤 경과 초. 없으면 시리즈를 뺀다 |
   | `mailo_file_poller_last_poll_ok` | 없음 | 마지막 폴링 성공 0/1. 없으면 시리즈를 뺀다 |
   | `mailo_metrics_collect_ok` | `group`=`queue`·`breaker`·`controls`·`quota`·`feed`·`audit` | 이 인스턴스의 마지막 DB 수집에서 그룹이 성공했으면 1 |
   | `mailo_metrics_snapshot_age_seconds` | 없음 | 캐시된 DB 수집의 경과 초(결정 5) |

   - 종결 건수를 DB로 세지 않는 이유: 종결 상태별 `count(*)`를 받쳐 줄 인덱스가 없어 `mail_jobs` 전체를 읽는다. 종결 건수는 인스턴스 counter(`mailo_jobs_finished_total`)가 맡는다. counter는 커밋 뒤에 증가하므로 커밋과 증가 사이에 프로세스가 죽으면 그 한 건을 놓친다.
   - 큐 깊이를 `PENDING`·`RETRY_WAIT`로 나누지 않고 `due`·`scheduled`·`sending`으로 나누는 이유: `PENDING`만 상한까지 세는 쿼리는 `RETRY_WAIT` 건수에 비례해 읽는다(배경의 측정). 두 상태를 나누려면 `status` 인덱스를 새 마이그레이션으로 더해야 한다. `PENDING`은 `queue/register.ts`가 `next_attempt_at`을 넣지 않아 컬럼 기본값 `now()`(`0001_queue_schema.sql`)라 `due`다. `next_attempt_at`을 바꾸는 쿼리는 `queue/complete.ts`의 결과 기록 전이뿐이고 이 전이의 대상은 `RETRY_WAIT`다. 그래서 `scheduled`는 재시도 대기와 같다(코드 읽기).
   - 로드맵이 적은 "이벤트 피드 지연"은 `mailo_caller_latest_event_age_seconds`로 내되 이름에서 지연이라는 말을 쓰지 않는다. "lease 회수 횟수"는 `mailo_lease_recovered_total`, "SMTP 오류 분류별 건수"는 `mailo_attempt_errors_total`이다. "평균 발송 처리 시간"은 히스토그램이 필요해 이 ADR에서 정하지 않는다(미결정).

5. **전역 gauge는 읽기 전용 쿼리를 TTL 캐시와 단일 비행으로 부른다.**
   - 문제: 스크레이프 간격마다 인스턴스 수 × Prometheus 복제본 수만큼 DB 조회가 생긴다. 사람이 `curl`을 반복하거나 스크레이프 설정이 겹치면 더 늘어난다. 조회가 풀 연결을 오래 잡으면 점유·결과 기록이 막힌다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 스크레이프마다 직접 조회 | 가장 단순하다. 스크레이프 수에 DB 부하가 비례한다 |
     | B. TTL 캐시 + 단일 비행 | 권고. 인스턴스당 조회가 TTL마다 최대 1회이고 풀 연결은 최대 1개다 |
     | C. 백그라운드 타이머가 주기 수집 | 부하가 스크레이프와 무관하게 일정하다. 스크레이프가 없어도 조회하고 종료 순서(drain)에 타이머가 하나 더 들어간다 |
     | D. 한 인스턴스만 수집(리더) | 선출이 필요하다. RQ-029의 단순함과 맞지 않는다 |
     | E. 외부 exporter가 DB를 직접 조회 | 새 상시 서비스와 DB 계정이 필요하다(RQ-029) |

   - 결정 문구(B):
     - 모든 전역 gauge는 DB 상태와 DB `now()`로만 계산한다. 인스턴스 시각·메모리 값을 섞지 않는다(ADR-0002 결정 10). 예외는 `mailo_caller_quota_limit`(레지스트리 값)과 `account_id` 라벨(상수)이다. 같은 설정이면 어느 인스턴스가 내도 같다.
     - 캐시 TTL은 환경 변수 `MAILO_METRICS_CACHE_SECONDS`(정수, 기본 5, 1~60)다. 기본값 5는 추정이다. TTL이 지난 첫 스크레이프가 수집을 시작하고, 수집 중 들어온 스크레이프는 같은 결과를 기다린다(단일 비행). 수집이 실패해도 결과(그룹별 성공 여부)를 TTL 동안 재사용한다. 실패 뒤 재시도 폭주를 막기 위해서다.
     - 두 인스턴스의 값은 TTL만큼 어긋날 수 있다. 알림 규칙의 `for:`는 TTL보다 길게 쓴다.
     - 수집은 풀 연결 1개로 순차 실행한다. 그룹은 `queue`(`getQueueBacklog`, 예약 건수, `SENDING` 건수), `breaker`, `controls`(정지 목록), `quota`, `feed`(호출처별 최신 이벤트), `audit`이다.
     - 모든 그룹은 `BEGIN READ ONLY` 트랜잭션이고 `SET LOCAL statement_timeout = 2000`을 건다(헬스와 같은 값). 쓰기, 행 잠금, advisory lock이 없다. 점유·완료 경로의 잠금 순서(작업 행 → 차단기 행)에 끼지 않는다.
     - 수집 전체 상한은 5초다. 이 시간이 지나면 새 그룹을 시작하지 않고 쿼리를 보낸 연결은 풀에서 버린다(`withBoundedClient`와 같은 처리). Prometheus 기본 `scrape_timeout`(10초)보다 짧다.
     - 그룹 하나가 실패하면 그 그룹의 시리즈만 응답에서 빼고 `mailo_metrics_collect_ok{group}`을 0으로 낸다. 로그 `metrics_collect_failed`(warn)는 `group`과 `describeError`의 이름·코드만 담고, 같은 그룹이 연속 실패하는 동안 TTL마다 반복하지 않고 상태가 바뀔 때만 남긴다.
     - 연결 한 개를 쓰므로 풀 검사(`MAILO_DB_POOL_MAX ≥ MAILO_WORKER_CONCURRENCY + 4`)는 바꾸지 않는다. 이 예비분 4개는 추정이고 헬스·HTTP·파일 폴러와 나눈다(`config/load-config.ts`의 `POOL_RESERVE_CONNECTIONS`). `/metrics`가 더하는 연결은 최대 1개다. 부하에서 이 가정이 맞는지는 확인하지 않았다.
   - 쿼리 비용(위 측정): `queue` 그룹 약 1.7ms, `quota` 그룹은 호출처 5개·한도 10000에서 3.4ms, `feed` 0.23ms, `audit` 약 1ms다. 모두 로컬 단일 측정이고 합이 한 자릿수 ms다. `quota`는 `호출처 수 × 한도`에 비례하므로 한도가 큰 호출처(최대 1000만)가 있으면 이 그룹이 가장 먼저 늘어난다. 같은 쿼리가 점유 때마다 이미 돈다(`planQuotas`).
   - `quota` 그룹은 `planQuotas`의 사용량 SQL을 읽기 전용으로 재사용한다. advisory lock은 잡지 않는다(`queue/claim.ts`에서 사용량 SQL을 상수로 빼 두 곳이 같은 문장을 쓴다).
   - `scheduled`·`sending` 건수, 호출처별 최신 이벤트, 감사 통계는 새 읽기 함수다(`queue/backlog.ts`, `events/event-store.ts`, `ops/audit.ts`에 둔다). 마이그레이션은 없다.

6. **라벨은 `caller_id`, `account_id`, `reason`과 닫힌 열거 라벨만 쓴다. 시리즈 수에 상한을 둔다.**
   - 허용 라벨 이름 목록(코드의 `ALLOWED_LABELS`): `caller_id`, `account_id`, `reason`, `state`, `priority`, `result`, `stage`, `status`, `group`. 앞의 셋이 요청된 라벨이다. 나머지 여섯은 값이 코드의 닫힌 집합이다. 카탈로그 밖의 라벨 이름을 등록하면 기동 때 던진다.
   - 쓰지 않는 라벨: 수신자·발신 주소, 제목·본문, `Idempotency-Key`, 작업 ID, 요청 ID, lease 토큰, SMTP 응답 코드·텍스트, SMTP 사용자 주소, 파일 이름, 토큰·API 키, 오류 메시지(RQ-027, ADR-0007 구현 중 확정 5).
   - 값 검증은 기록 시점에 한다.
     - `caller_id`: 형식(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)과 기동 때 읽은 레지스트리의 ID 집합에 있어야 한다. 아니면 `unregistered` 하나로 모은다. 레지스트리에서 뺀 호출처의 작업이 큐에 남아 있을 수 있다. 이 값은 가짜 호출처 ID로 시리즈를 늘리는 경로를 막는다.
     - `account_id`: 단계 7 전에는 상수 `default`다(`breakerKey`). 단계 7 뒤에는 레지스트리의 계정 ID(불투명 이름)다. SMTP 사용자 주소는 쓰지 않는다. 로드맵의 `account="default"` 표기는 이 ADR이 `account_id`로 정한다. `mail_jobs.account_id`(단계 7)와 같은 이름이다.
     - 닫힌 열거(`result`, `stage`, `status`, `reason` 등)는 코드의 허용 값 표로 바꾼다. 표에 없는 입력(예: 모르는 `stage`)은 `unknown`(`reason`은 `other`)으로 센다. 원문을 라벨에 쓰지 않는다.
     - 라벨 값 이스케이프는 `\\`, `\"`, 줄바꿈 `\n`이다. 검증을 통과한 값에는 이 문자가 없으므로 이스케이프는 이중 방어다.
   - 카디널리티: 호출처 수를 C라 하면 호출처 라벨 시리즈는 counter 약 12C(`attempts` 5, `finished` 4, `claimed` 1, `file_channel_files` 5 중 실제 발생한 값, `cursor_gap` 1)와 gauge 약 5C(`paused`, `quota_limit`, `quota_used`, `latest_event_age`)다. C=50이면 인스턴스당 수백 시리즈다(가정, 값은 발생한 조합만 생긴다). counter는 처음 증가할 때 생긴다.
   - 시리즈 상한: 지표 하나당 시리즈 2000개(추정, 설정하지 않는다). 넘으면 새 시리즈를 만들지 않고 `mailo_metrics_dropped_samples_total`을 올리며 `metrics_series_limit`(warn, 지표 이름만)을 한 번 남긴다.
   - RQ-027 검증: 본문·제목·수신자·Key·SMTP 응답 텍스트·API 키·토큰에 canary 문자열을 넣고 `/metrics` 전체 응답에서 검색한다. 라벨 이름 허용 목록과 이름 규칙은 단위 테스트가 카탈로그에서 검사한다.

7. **직렬화는 새 npm 의존성 없이 직접 쓴다. 알림 전송은 이 결정의 범위 밖이다.**
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 수동 텍스트 직렬화 | 권고. v1의 종류는 counter와 gauge뿐이다. 라벨 검증·시리즈 상한은 어느 쪽이든 직접 써야 한다 |
     | B. `prom-client` | 형식과 히스토그램을 맡긴다. 직접 의존성이 2개 늘고(`npm view prom-client@15.1.3`의 `dependencies`: `tdigest`, `@opentelemetry/api`) 전이 의존성은 확인하지 않았다. 라벨 값 검증과 시리즈 상한은 제공하지 않는다. 기본 프로세스 지표 수집이 있어 이름이 `nodejs_*`로 늘어난다 |

   - 권고 이유:
     - `AGENTS.md`는 새 npm 의존성에 필요 이유를 요구한다. v1에는 `prom-client`에만 있는 기능이 필요하지 않다. 히스토그램·요약이 없다.
     - RQ-029가 금지하는 것은 상시 서비스이고 npm 패키지는 해당하지 않는다. 그러므로 이유는 RQ-029가 아니라 위 첫째와 공급망 표면이다.
     - 라벨 값 검증·시리즈 상한·`account_id` 규칙은 어느 쪽이든 Mailo가 쓴다.
   - 위험: 텍스트 형식의 오류가 Prometheus의 수집 실패로 드러난다. 직렬화기는 단위 테스트로 형식(HELP·TYPE 줄, 이스케이프, 값 표기, 끝 개행)을 고정하고, 구현 때 `promtool check metrics`로 한 번 수동 확인한다.
   - 전환 조건: 히스토그램(발송 소요 시간)이나 약 50개를 넘는 지표 종류가 필요해지면 새 ADR로 `prom-client`를 다시 검토한다.
   - 구현 배치:
     - `src/metrics/`(새 모듈)는 다른 모듈에 의존하지 않는 leaf다(`logging/`과 같다). 카탈로그, counter 저장소(라벨 검증·상한 포함), 텍스트 직렬화기, `APP_METRICS` 주입 토큰, 아무것도 하지 않는 기본 구현을 둔다. `createApp`이 인스턴스 하나를 만들어 Worker·파일 폴러·REST 계층에 `APP_LOGGER`처럼 준다. 주입하지 않으면 증가는 무시된다(옵션 없는 앱은 지금처럼 발송하지 않는다).
     - 엔드포인트와 DB 수집기는 `health/`에 둔다(`health/metrics.controller.ts`, `health/metrics-collector.ts`). `health`가 이미 `queue`·`events`·`file-channel`·`worker-port`를 읽는다. `metrics`가 `queue`를 import하면 `queue`·`worker`가 `metrics`를 import하는 방향과 순환하므로 `metrics/`는 leaf로 둔다.
     - `withBoundedClient`는 `health/` 안의 공용 파일로 뺀다.
     - counter 증가는 Worker(`attempts`, `finished`, `claim`, `lease`), 파일 폴러(`file_channel`), REST 계층(`cursor_gap`, 취소의 `finished`)이 한다. `queue/`는 `metrics`를 import하지 않는다. 대신 종결 전이를 만드는 네 경로(`completeAttempt`, `sweepExpired`, `recoverExpiredLeases`, 취소)가 호출처·상태별 건수를 돌려준다. `sweepExpired`·`recoverExpiredLeases`의 반환 형식이 숫자에서 건수 맵으로 넓어진다.
   - 범위 밖: 알림 전송(메일·메신저·webhook), 대시보드 파일, push gateway, OpenTelemetry, 호출처별 HTTP 요청 지표, 발송 소요 시간 히스토그램. 알림 규칙은 예시로만 문서에 둔다(부록 B, RQ-029).

8. **감사 테이블 행 수는 지표로 낸다. 삭제 정책은 이 ADR에서 정하지 않는다.**
   - ADR-0011 결정 6은 자동 삭제 없이 행 수를 감시하고 감시 수단을 단계 8에서 정하기로 했다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 지표 `mailo_ops_audit_rows`·`_truncated`·`_oldest_age_seconds` | 권고. 상한(100000)까지만 읽어 비용이 막힌다(측정: 2만 행에서 0.76ms, 가장 오래된 행 0.23ms). 기존 알림 경로로 감시한다 |
     | B. `GET /ops/audit`의 `nextBefore` 페이지 수로 센다 | 행 수를 얻으려 전체를 순회한다 |
     | C. 운영 문서의 SQL만 | 사람이 실행해야 한다. 감시가 되지 않는다 |
     | D. 이 ADR에서 삭제 정책까지 정한다 | 감사 보존 기간은 운영 정책이고 근거 수치가 없다. 새 결정으로 분리한다 |

   - 결정 문구(A): `ops/audit.ts`에 `getAuditStats(db)`를 둔다. 행 수는 `SELECT count(*) FROM (SELECT 1 FROM mail_ops_audit LIMIT 100001)`이고 가장 오래된 행은 `ORDER BY id LIMIT 1`이다. 행 수가 100001이면 `_truncated`를 1로 내고 값은 100000으로 자른다. 알림 임계값은 운영 경험 뒤에 정한다. 부록의 값은 예시다.
   - 다른 테이블: `mail_event_purges`는 행 수 상한이 호출처 수 × 이벤트 종류 수로 정해져 있어 감시하지 않는다(ADR-0011 구현 중 확정 22). `mail_jobs`·`mail_events`는 보존 삭제가 한정하고, 테이블 크기·팽창은 DB 쪽 도구와 단계 9의 DB 유지보수 안내가 맡는다. 이 ADR의 범위 밖이다.

9. **마이그레이션 없이 낸다. 호환성은 다음과 같다.**
   - 마이그레이션: 없다. 새 쿼리는 기존 인덱스(`mail_jobs_claim_idx`, `mail_jobs_sending_caller_idx`, `mail_attempts_quota_idx`, `mail_events_feed_idx`, `mail_ops_audit_pkey`)를 쓴다. 인덱스 신선도(`VACUUM`)에 따라 인덱스 전용 스캔의 힙 접근이 늘 수 있고 읽는 양은 상한이 막는다.
   - 구버전 공존: 구버전 인스턴스는 `/metrics`가 없어 404(problem+json)다. 롤링 배포 중에는 구버전 타깃이 `up == 0`이다. 모든 인스턴스를 새 버전으로 바꾼 뒤 스크레이프 타깃에 추가한다. 구버전은 `MAILO_METRICS_CACHE_SECONDS`를 읽지 않는다.
   - 롤백: 스크레이프를 끄면 된다. 저장된 상태가 없다.
   - `/health/ready`: 응답 필드, 200/503 판정, 인증, 쿼리는 바꾸지 않는다. `openapi.yaml`의 `ReadyResponse`는 그대로다. `/metrics`의 `mailo_queue_jobs{state="due"}`와 헬스의 `queue.dueCount`는 같은 `getQueueBacklog`에서 나오므로 같은 데이터에서 같은 값이어야 한다(테스트로 고정).
   - 새 환경 변수 하나(`MAILO_METRICS_CACHE_SECONDS`), 새 로그 이벤트 둘(`metrics_collect_failed`, `metrics_series_limit`), 새 endpoint 하나, 새 오류 `type`은 없다(`forbidden`을 재사용한다).
   - 문서 갱신 대상(구현 변경과 같은 변경에서, AGENTS.md "문서와 요구사항 갱신"):

     | 문서 | 내용 |
     | ---- | ---- |
     | `docs/api/openapi.yaml` | `/metrics` 경로, `metricsReadAuth`, 200 `text/plain`, 401·403 |
     | `docs/operations/deployment.md` | `MAILO_METRICS_CACHE_SECONDS`, 스크레이프 절(인스턴스별 타깃, 토큰 전달, 간격), 새 로그 이벤트 |
     | `docs/operations/key-management.md` | 읽기 토큰이 Prometheus에 놓이는 위치, 관리 토큰은 403이라는 점, 토큰 교체 때 Prometheus 설정 갱신 |
     | `docs/operations/troubleshooting.md` | 지표 해석(전역은 `max`, counter는 `rate`), `collect_ok=0`, 적체·차단기·정지 알림 대응 |
     | `docs/requirements/mail-sending.md`·`README.md` | 새 RQ(승인 때 번호), 미결정 항목 "비기능 요구"의 메트릭 해소, ADR 목록 |
     | `docs/requirements/roadmap.md` | 단계 8 상태와 결과 요약 |
     | `AGENTS.md` | 모듈 목록에 `metrics`(leaf)와 `/metrics` 인증 위치, `.env.example` |

## 구현 순서

이 ADR이 승인된 뒤의 순서다. 소스를 바꾸는 단계마다 관련 문서를 같은 변경에서 갱신한다.

1. 새 RQ를 정한다(수용 조건: 인증 행렬, 전역·인스턴스 규칙, 라벨 규칙과 RQ-027, 캐시·timeout, 헬스 불변).
2. `metrics/` leaf: 카탈로그, counter 저장소(라벨 검증·시리즈 상한), 텍스트 직렬화기, 토큰, 기본 구현. 단위 테스트만으로 끝낸다.
3. 인증: `MetricsReadGuard`와 `/metrics` 라우트(빈 응답), 인증 행렬 통합 테스트. `request-context.ts`의 로그 레벨.
4. 전역 gauge 수집기: 새 읽기 함수(`scheduled`·`sending` 건수, 호출처별 최신 이벤트, 감사 통계, 읽기 전용 사용량), `withBoundedClient` 공용화, 캐시·단일 비행·그룹 실패 처리.
5. 인스턴스 값: Worker·파일 폴러·REST 계층 증가 지점, 종결 전이 네 경로의 건수 반환, 인스턴스 gauge(`worker`·`file_poller`·`process_*`).
6. 문서·`openapi.yaml`·`.env.example` 갱신, 부록의 스크레이프·알림 예시를 `docs/operations/`로 옮긴다.
7. 수동 확인: 실제 Prometheus 스크레이프, `promtool check metrics`와 `check rules`, 큰 데이터의 `EXPLAIN`(검증 계획).

## 검증 계획

실행하지 않았다. 구현 때 쓸 계획이다. 단계는 `docs/agents/testing.md`를 따른다.

- 단위(L0): 직렬화기(HELP·TYPE 줄, 이스케이프, 값 표기, 끝 개행, 같은 이름 시리즈 중복 없음), 카탈로그 규칙(전역은 gauge, counter는 인스턴스와 `_total`, 접두, 라벨 이름 허용 목록), 라벨 검증(`unregistered`, `unknown`, 시리즈 상한과 `dropped_samples`), 기본 구현의 무동작.
- 통합(L1, PostgreSQL):
  - 인증 행렬: 헤더 없음 401, 모르는 값 401, 호출처 키 401, 관리 토큰 403, 읽기 토큰 200, `MAILO_OPS_TOKEN` 없음 401.
  - 전역 gauge: 심은 행과 값 대조(`due`·`scheduled`·`sending`, 10001행에서 `truncated`, 가장 오래된 나이, 차단기 세 상태와 사유, 전체·호출처 정지와 레지스트리 밖 정지, 할당 포화, 최신 이벤트 나이, 감사 통계).
  - `/health/ready`의 `queue.dueCount`와 `mailo_queue_jobs{state="due"}`가 같은 데이터에서 같고 `/health/ready` 응답이 바뀌지 않는다(기존 테스트).
  - 같은 DB를 쓰는 앱 인스턴스 둘의 전역 gauge가 같다.
  - 캐시: 동시 스크레이프 N건이 수집 1회를 만든다(풀 호출 횟수를 세는 래퍼). TTL 뒤에는 새로 수집한다.
  - 실패: 한 그룹의 쿼리를 `statement_timeout`으로 실패시키면 HTTP 200, 그 그룹만 빠지고 `collect_ok{group}`이 0이다. 연결을 얻지 못하면 모든 그룹이 0이다.
  - RQ-027: canary 문자열을 본문·제목·수신자·Key·SMTP 응답 텍스트·API 키·토큰에 넣고 `/metrics` 응답에서 검색한다.
- e2e: 실제 Worker와 가짜 SMTP에서 `sent`·`transient`·`permanent`·`account` 결과와 `finished`·`claimed` 증가, `lease_recovered`, 취소, 파일 채널 처리 수를 확인한다.
- 수동(L3 아님, 자동 테스트가 아니다): 100만 행 이상의 `EXPIRED`·`RETRY_WAIT` 분포에서 쿼리별 `EXPLAIN`, 실제 Prometheus 스크레이프와 `promtool check metrics`·`check rules`, 인스턴스 둘의 compose 스크레이프.

## 구현 중 확정 (2026-11-24)

구현하면서 ADR 문구와 달라지거나 문구가 정하지 않은 부분을 확정했다. 결정 문구는 고치지 않았다.

1. **종결 전이 경로의 반환 형식을 넓히지 않고 커밋 뒤 관찰자 콜백으로 알린다(결정 7 구현 배치와 다르다).** 결정 7은 `sweepExpired`·`recoverExpiredLeases`의 반환 형식이 숫자에서 건수 맵으로 넓어진다고 적었다. 구현은 반환값(숫자)을 그대로 두고 선택 인자로 콜백을 받는다. 이유는 두 함수의 반환 숫자를 단언하는 기존 테스트(약 15곳)와 `drainBatches`의 배치 크기 판정을 바꾸지 않기 위해서다. 콜백은 트랜잭션이 커밋된 뒤 한 번 부르고 롤백되면 부르지 않으며 던져도 삼킨다(`queue/transitions.ts`의 `notifyTransitions`). 호출처와 전이 뒤 상태(`JobTransition`)만 넘기고 작업 ID·수신자는 넘기지 않는다.
   - `sweepExpired(pool, batchSize, onTransitions?)`, `recoverExpiredLeases(pool, deps, limit, { exclusive?, onRecovered? })`, `ClaimOptions.onLeaseRecovered`(점유 앞단 복구).
   - 결과 기록(`completeAttempt`)은 반환 형식을 바꾸지 않았다. Worker가 이미 `ClaimedJob.callerId`와 결과의 `status`를 갖는다.
   - 취소 결과 `{ kind: "canceled", jobId }`에는 `callerId`를 더했다. 관리 토큰 취소는 호출처 범위가 없어 작업의 호출처를 알아야 한다. 기존 테스트 단언 두 곳이 새 필드를 포함하도록 바뀌었다(`queue/cancel.integration-spec.ts`).
   - `queue/`는 `metrics/`를 import하지 않는다(결정 7). 이 방향은 그대로다.
2. **`APP_METRICS`는 `createApp`이 아니라 `app.module.ts`의 전역 모듈이 만든다(결정 7 구현 배치와 다르다).** 호출처 ID 집합이 레지스트리에서 오는데 레지스트리는 Nest 프로바이더(`CALLER_REGISTRY`)라 `createApp`이 만들 때는 읽을 수 없다. `AppMetricsModule`(전역, `app.module.ts`의 비공개 클래스)이 `CALLER_REGISTRY`로 `createMetrics`를 부르고 `onSeriesLimit`을 앱 로거(`metrics_series_limit`, warn, `metric` 필드)에 연결한다. Worker·파일 폴러 팩토리, `IntakeService`, `OpsService`가 주입받는다. 주입하지 않은 객체 생성(테스트)은 `noopMetrics`다.
3. **`/metrics` 인증은 가드 외에 라우트 앞 미들웨어가 먼저 한다(결정 1이 가드만 적었다).** `/metrics`에는 경로 파라미터가 없어 디코딩 순서 문제가 직접 생기지 않지만 `app.use("/metrics", ...)`가 `/metrics/%` 같은 하위 경로도 인증 뒤에 처리하게 한다(ADR-0011 구현 중 확정 20과 같은 방식). 가드는 같은 판정을 한 번 더 한다. 미들웨어가 거절한 요청은 `req.route`가 없어 요청 로그의 `route`가 `-`이고 info로 남는다. debug로 내리는 대상은 라우트에 닿은 `/metrics` 요청이다. 거절된 스크레이프(오설정)는 info로 보여야 하므로 이 차이를 그대로 둔다.
4. **관리 토큰만 설정된 구성에서 관리 토큰은 403이다.** 결정 1은 "`MAILO_OPS_TOKEN`이 없으면 어떤 값도 읽기 권한이 아니므로 401"이라고 적었다. 구현은 호출처 키·모르는 값·자격 없음을 401, 판정이 `admin`인 토큰을 403으로 하므로 읽기 토큰이 없어도 관리 토큰은 403이다. 오설정이 403으로 드러난다는 결정 1의 목적과 같다. `MAILO_OPS_TOKEN`도 관리 토큰도 없는 구성은 모든 값이 401이다.
5. **수집기의 실패 처리와 로그.**
   - 그룹마다 한 트랜잭션이다(`BEGIN READ ONLY`, `SET LOCAL statement_timeout = 2000`, `COMMIT`). 쿼리가 실패하면 `ROLLBACK`으로 닫고 같은 연결로 다음 그룹을 이어 한다. `ROLLBACK`도 실패하거나 전체 5초를 넘기면 연결을 풀에서 버리고 끝나지 않은 그룹을 모두 실패로 센다. 전체 상한 뒤에는 새 그룹을 시작하지 않는다.
   - `metrics_collect_failed`는 그룹이 성공에서 실패로 바뀔 때만 남긴다. 복구 로그는 새 이벤트가 되므로 만들지 않았다. 필드는 `group`과 `error`(`describeError`의 이름·코드)뿐이다.
   - 캐시는 단조 시계(`performance.now()`)를 쓴다. 전역 gauge 값은 DB `now()`로만 계산하므로 인스턴스 시각이 값에 섞이지 않는다.
   - `withBoundedClient`는 `health/bounded-client.ts`로 옮기고 연결 단위 `withBoundedConnection`과 트랜잭션 단위 `runReadOnly`로 나눴다. 헬스의 동작(3초·2초, 연결 폐기)은 바뀌지 않았다. 차단기 사유 변환(`LAST_REASON`)은 `health/breaker-reason.ts`로 옮겨 헬스와 지표가 같은 어휘를 쓴다.
6. **값 표기.** 가장 오래 기다린 나이와 감사 나이는 정수 초이고 대기·행이 없으면 0이다(헬스는 없으면 null이다. 지표는 시리즈를 비우지 않고 0으로 낸다). `mailo_metrics_snapshot_age_seconds`는 0.1초 단위, `process_start_time_seconds`는 0.001초 단위로 프로세스 시작 때 한 번 계산해 고정한 값이다(스크레이프마다 다시 계산하면 반올림 때문에 1ms씩 흔들려 "바뀌면 재시작"이 깨진다), `process_cpu_seconds_total`은 사용자+시스템 CPU(초)다. 파일 채널이 꺼져 있으면 `mailo_file_poller_enabled`·`running`·`callers`는 0이고 마지막 폴링 시리즈는 없다.
7. **파일 채널 counter의 `result`.** `registered`·`duplicate`·`rejected`·`unreadable`·`delete_failed`만 센다. 같은 거부의 반복(`rejected_repeat`)과 다른 인스턴스가 먼저 지운 파일(`gone`)은 세지 않는다. 한 파일이 등록되고 원본 삭제만 실패하면 `registered`와 `delete_failed`를 모두 올린다.
8. **`claimed_jobs`와 drain.** 점유(`claim`)가 커밋됐으면 drain 시간 초과 뒤 늦게 돌아와 버린 점유도 `mailo_claimed_jobs_total`에 센다. 그 작업은 lease 복구가 다시 다룬다. 이 경우 `attempts_total`은 오르지 않는다.
9. **로그 이벤트 둘.** `metrics_collect_failed`(warn, `group`·`error`), `metrics_series_limit`(warn, `metric`). 호출처 라벨이 레지스트리 ID로 막혀 있고 지표 하나는 호출처당 최대 5시리즈(`attempts_total`, `file_channel_files_total`)라서 시리즈 상한(2000)은 호출처가 약 400개를 넘어야 닿는다.
10. **쿼리 비용 측정(2026-11-24, PostgreSQL 17.11 로컬 compose, 임시 schema, 쿼리마다 `EXPLAIN (ANALYZE, BUFFERS)` 1회, `VACUUM ANALYZE` 뒤).** 아래는 구현한 SQL이다. 두 규모를 쟀다. 큰 쪽은 작업 약 150만 행(`SENT` 125만, `PENDING` 15만, `RETRY_WAIT` 10만 중 5만은 예약 시각 미래, `SENDING` 40), 감사 10만 행, 이벤트 50만 행, 시도 30만 행이다.

    | 쿼리 | 작은 규모(작업 30만 행) | 큰 규모 | 계획 |
    | ---- | ----------------------- | ------- | ---- |
    | `getQueueBacklog`(전체와 등급별, 헬스와 같은 문장) | 8.7ms | 10.1ms | `mail_jobs_claim_idx`·`mail_jobs_priority_claim_idx` 인덱스 전용 스캔, 상한 10001행 |
    | `getQueueDepth`의 `scheduled`와 `sending` | 1.3ms | 1.3ms | `mail_jobs_claim_idx` 인덱스 전용 스캔(`next_attempt_at > now()`, 10001행에서 멈춤), `mail_jobs_sending_caller_idx` 인덱스 전용 스캔 |
    | `getCallerQuotaUsage`(호출처 5개, 한도 10000) | 1.8ms | 6.3ms | `mail_attempts_quota_idx` 인덱스 전용 스캔, 호출처당 최대 한도만큼 |
    | `getFeedLagsForCallers`(호출처 20개) | 0.2ms | 0.3ms | `mail_events_feed_idx` 역방향 스캔, 호출처당 1행 |
    | `getAuditStats`(감사 2만 행 / 10만 행) | 2.0ms | 10.7ms | 행 수는 `Seq Scan`(상한 100001행에서 멈춤), 가장 오래된 행은 `mail_ops_audit_pkey` 1행 |
    | `readSendControls`, `getBreakerState` | 0.01ms 미만 | 0.02ms 미만 | 행 수가 정지 범위 수·1행 |

    - 전 쿼리가 `Heap Fetches: 0`이다(`VACUUM` 직후 값이다. autovacuum이 늦은 운영에서는 힙 접근이 늘 수 있다).
    - 합이 한 자릿수에서 20ms 안팎이고 TTL마다 최대 1회다. 감사 행 수 쿼리는 상한(10만 행)에서 가장 비싸다(10.7ms, `Seq Scan`). 상한 앞에서 멈추므로 행이 더 늘어도 비용은 같다.
    - 한계: 로컬 단일 실행이고 데이터가 메모리에 있는 `shared hit`뿐이다. 수백만 행·디스크 읽기·동시 쓰기 부하는 확인하지 않았다. 한도가 큰 호출처(최대 1000만)의 `quota` 그룹 비용도 확인하지 않았다.
11. **실행한 확인(2026-11-24, 자동 테스트가 아니다).**
    - 컨테이너(`scripts/container/verify-metrics.sh`, `read_only` 루트, `NODE_ENV` 기본): 읽기 토큰 200, 관리 토큰 403, 무토큰·호출처 키 401, `Content-Type: text/plain; version=0.0.4; charset=utf-8`. 메일 5통 발송 뒤 `attempts(sent)`·`finished(sent)` 5, `due` 0, `closed` 1, `collect_ok`가 모두 1, 시리즈 48개. 토큰·API 키·수신자·제목이 응답과 컨테이너 로그에 없었다. `promtool check metrics`(`prom/prometheus:v2.55.1`)가 지적 없이 통과했다.
    - `promtool check rules`: 부록 B의 규칙 12개가 문법 검사를 통과했다(`prom/prometheus:v2.55.1`).
    - 실제 Prometheus(`v2.55.1`, 같은 compose 네트워크, 부록 A와 같은 `authorization.credentials_file`, 간격만 5초): 읽기 토큰 타깃은 `up`이고 `mailo_queue_jobs`·`mailo_attempts_total{result="sent"}`(3)·`max by (account_id)`·`mailo_breaker_state`를 질의할 수 있었다. 관리 토큰을 쓴 타깃은 `server returned HTTP status 403 Forbidden`으로 `down`이었다. 부록 B의 규칙 12개가 모두 평가 상태 `ok`였고 알림은 발화하지 않았다. 토큰 파일의 끝 개행은 `credentials_file`이 허용했다(결정 7 "확인하지 않은 것"의 해당 항목을 해소한다).
    - 위 확인은 한 번씩이다. 알림 규칙의 임계값과 `for:`는 여전히 추정이고 부하에서 확인하지 않았다.
12. **ADR 문서 정정.** 부록 B의 코드 블록을 닫는 줄이 빠져 있어 추가했다. 내용은 그대로다.
13. **단계 7과의 관계.** `account_id`는 모든 시리즈에서 `default`다. 단계 7이 계정을 늘리면 `createMetrics({ accountIds })`와 수집기의 `account` 상수를 계정 목록으로 바꾼다. 지표 이름과 라벨 이름은 바뀌지 않는다.
14. **요구사항 번호.** 새 RQ는 RQ-049~052다. 8단계 구현 상태는 `docs/requirements/mail-sending.md`가 소유한다.

15. **알림 규칙이 쓰는 counter는 시작할 때 0으로 미리 낸다(결정 4의 "counter는 처음 증가할 때 생긴다"와 다르다).** 시리즈가 처음 생기는 순간의 증가는 Prometheus `increase()`·`rate()`가 놓친다. 프로세스당 첫 lease 회수나 첫 실패 종결이 알림(`MailoLeaseRecovered`, `MailoFailedRatioHigh`)에 잡히지 않는 문제다. `metrics/catalog.ts`의 `seed: true` 지표를 `createMetrics`가 라벨 조합마다 0으로 만든다.
    - 대상: `mailo_claim_polls_total`(3개), `mailo_lease_recovered_total`(`account_id=default` 1개), 레지스트리 호출처마다 `mailo_attempts_total`(5개)·`mailo_jobs_finished_total`(4개)·`mailo_claimed_jobs_total`(1개)·`mailo_event_cursor_gap_total`(1개). 호출처 ID는 기동 때 읽은 레지스트리 값이라 알 수 있다.
    - 카디널리티: 지표당 시리즈 상한 2000 안이다. 호출처당 최대 5개(`attempts`)이므로 호출처 400개까지 모두 미리 낸다. 호출처가 더 많으면 앞에서부터 상한까지만 미리 내고 나머지는 처음 증가할 때 생긴다. 미리 내기는 `dropped_samples`를 올리지 않는다. 호출처 50개일 때 미리 내는 시리즈는 약 560개다(계산: 호출처당 11개 + 4개).
    - 미리 내지 않는 것: `caller_id="unregistered"`(레지스트리에서 뺀 호출처의 작업), `mailo_file_channel_files_total`(호출처가 파일 채널을 쓰는지 leaf가 모른다), `mailo_attempt_errors_total`(`stage`·`reason`의 가능하지 않은 조합이 많다). 이 시리즈의 첫 증가는 `increase()`가 놓친다. 부록 B의 규칙은 이 시리즈에만 생기는 증가를 보지 않는다. `MailoFailedRatioHigh`가 `unregistered` 호출처의 첫 종결 하나를 놓칠 수 있다.
    - 부수 효과: `MailoNoProgress`의 `sum(rate(mailo_attempts_total[10m])) == 0`이 시도가 한 번도 없는 인스턴스에서도 참이다(미리 낸 0 시리즈가 있다). 기동 직후 `due`가 있고 정지·차단이 없는데 15분 동안 시도가 없으면 발화한다. 의도한 동작이다.
    - Prometheus가 인스턴스를 처음 스크레이프하기 전의 증가는 이 방법으로도 보이지 않는다.
16. **`mailo_caller_quota_used`는 한도를 넘을 수 있다(결정 4의 "값은 한도에서 멈춘다"와 다르다).** 사용량 쿼리는 시도 쪽을 `LIMIT 할당`으로 세어 한도에서 멈추지만 점유 중(`SENDING`) 수를 더한다. 시도가 한도에 닿은 호출처에 점유 중 작업이 있으면 사용량이 한도보다 크다. 지표 의미는 바꾸지 않았다(`claim`과 같은 문장). HELP·문서·알림 설명이 "한도를 넘을 수 있고 사용량/한도가 1을 넘을 수 있다"로 바뀌었다. `MailoCallerQuotaNearLimit`(`>= 0.9`)은 1을 넘는 값도 조건에 든다. 한도 2에서 시도 2건과 점유 중 1건이면 사용량 3이다(`http/metrics-gauges.integration-spec.ts`).
17. **`/metrics` 인증과 `MAILO_OPS_TOKEN` 없음 정정.** `docs/api/openapi.yaml`의 `/metrics` 설명이 "`MAILO_OPS_TOKEN`이 없으면 어떤 값도 401"이라고만 적었으나 코드는 구현 중 확정 4와 같다(관리 토큰만 설정된 서버에서 관리 토큰은 403). openapi.yaml과 `deployment.md`를 고쳤다.

## 검토한 대안

| 결정 | 대안 | 채택하지 않은 이유 |
| ---- | ---- | ------------------ |
| 1 | 읽기·관리 토큰 모두 허용 | 관리 토큰이 Prometheus 설정에 놓이는 오설정을 막지 못한다. 권고하지 않지만 승인 쟁점이다 |
| 1 | 인증 없음 | 호출처 ID·큐 규모·차단기 사유가 인증 없이 노출된다 |
| 1 | 전용 토큰 `MAILO_METRICS_TOKEN` | 변수와 교체 절차가 늘고 읽기 토큰과 역할이 겹친다 |
| 2 | `/ops/metrics` | `/ops`는 JSON 운영 REST이고 인증 미들웨어가 메서드로 권한을 가른다. Prometheus 관례 경로를 따른다 |
| 2 | DB 장애 때 503 | 인스턴스 counter와 `collect_ok=0` 신호가 사라진다. 스크레이프 `up`이 0이 되어 원인(앱 죽음 대 DB 장애)을 가르지 못한다 |
| 3 | 모든 지표에 `instance` 라벨을 앱이 붙임 | Prometheus 타깃 라벨과 중복되고 `honor_labels` 설정에 따라 덮어쓴다 |
| 4 | 큐 깊이를 `PENDING`·`RETRY_WAIT`·`SENDING`으로 | 앞의 둘을 나누려면 `RETRY_WAIT` 건수에 비례해 읽는다. `status` 인덱스를 새 마이그레이션으로 더하는 선택지가 남는다 |
| 4 | 종결 건수를 DB `count(*)`로 | 종결 상태를 받치는 인덱스가 없어 전체 스캔이다 |
| 4 | 라벨에 SMTP 응답 코드 | 값이 서버 응답에 달려 있어 닫히지 않는다. `stage`와 `reason`으로 충분하다 |
| 5 | 스크레이프마다 직접 조회 | 스크레이프 수에 DB 부하가 비례하고 폭주를 막는 장치가 없다 |
| 5 | 백그라운드 타이머 | 스크레이프 없이도 쿼리하고 종료 순서에 타이머가 더해진다. 캐시로 같은 상한을 얻는다 |
| 5 | 리더 인스턴스만 수집 | 선출이 필요하다 |
| 5 | `postgres_exporter` 등 외부 exporter | 새 상시 서비스와 DB 계정이 필요하다(RQ-029) |
| 6 | `caller_id`를 레지스트리 검사 없이 DB 값 그대로 | 레지스트리에서 뺀 호출처와 비정상 값이 시리즈를 늘린다 |
| 6 | 라벨에 호출처별 우선순위·작업 상태 조합을 모두 둔다 | 호출처 × 등급 × 상태의 시리즈가 호출처 수에 곱으로 늘어난다 |
| 7 | `prom-client` | 이유가 약하다(결정 7). 히스토그램이 필요해지면 다시 검토한다 |
| 8 | 감사 삭제 정책을 이 ADR에서 정한다 | 보존 기간은 운영 정책이고 근거 수치가 없다 |

## 결과

- 운영자는 읽기 토큰 하나로 큐 적체, 차단기, 정지, 할당, 시도·종결 결과를 Prometheus로 본다. 관리 토큰은 `/metrics`에서 거부된다.
- 전역 값은 `max`, 인스턴스 값은 `rate`로 읽는다는 규칙이 이름과 HELP에 있다. 로드 밸런서 뒤 스크레이프는 지원하지 않는다.
- DB 조회는 인스턴스당 TTL(기본 5초)마다 최대 1회, 풀 연결 최대 1개다. 한 번의 비용은 로컬 측정에서 한 자릿수 ms였다.
- DB가 죽어도 `/metrics`는 200이고 그룹별 `collect_ok`가 0이 된다. 인스턴스 counter는 계속 나온다.
- 새 npm 의존성, 새 상시 서비스, 마이그레이션, `/health/ready` 계약 변경이 없다.
- 종결 전이를 만드는 네 경로의 반환 형식이 건수 맵으로 넓어지고 `metrics/` leaf 모듈이 늘어난다.
- 감사 행 수를 감시할 수 있다. 삭제 정책은 남은 결정이다.
- 이 ADR의 비용, 동작, 알림 예시는 구현·실행하지 않았다.

## 미결정·확인하지 않은 것

### 승인된 결정(2026-11-24)

열린 질문이던 9건이다. 사용자가 권고대로 승인했다. 결정 본문과 같은 값이다.

1. 관리 토큰의 `/metrics` 거부(403). ADR-0011 결정 1의 "관리는 읽기 포함"에서 이 endpoint만 예외다. 두 토큰 모두 허용하는 대안은 기각한다(결정 1).
2. 요청된 세 라벨(`caller_id`, `account_id`, `reason`) 외에 값이 닫힌 열거 라벨(`state`, `priority`, `result`, `stage`, `status`, `group`)을 허용한다(결정 6).
3. 직렬화는 수동으로 하고 `prom-client`를 도입하지 않는다(결정 7).
4. 환경 변수 `MAILO_METRICS_CACHE_SECONDS`(정수, 기본 5, 1~60)를 새로 둔다. 기본값 5는 추정이다(결정 5).
5. 큐 깊이는 `due`·`scheduled`·`sending`으로 나누고 `PENDING`·`RETRY_WAIT`로 나누지 않는다. `status` 인덱스 마이그레이션은 만들지 않는다(결정 4).
6. 라벨 이름은 `account_id`다. 로드맵 단계 8의 `account="default"` 표기를 이에 맞췄다(결정 6).
7. 감사 행 수를 지표로 낸다. 삭제 정책은 새 결정으로 남긴다(결정 8).
8. "이벤트 피드 지연"은 최신 이벤트의 경과 초(`mailo_caller_latest_event_age_seconds`)로 낸다. 소비자 처리 지연은 이 값으로 알 수 없다(결정 4).
9. `process_*` 3개를 낸다(`process_start_time_seconds`로 재시작을 감지한다, 결정 3·4).

### 확인하지 않은 것

- 실제 Prometheus 스크레이프, `promtool check metrics`·`check rules`를 실행하지 않았다. 부록의 설정과 PromQL은 문법과 동작을 확인하지 않은 예시다. Prometheus의 `credentials_file`이 토큰 파일 끝 개행을 허용하는지도 확인하지 않았다.
- Prometheus 텍스트 형식 규칙(HELP·TYPE 줄, 이스케이프, `Content-Type` 버전 값)은 알려진 규칙으로 적었고 이 변경에서 공식 문서를 다시 대조하지 않았다.
- 운영 크기(수백만 행)의 쿼리 비용을 측정하지 않았다. 측정은 로컬 단일 실행이고 데이터가 메모리에 있는 `shared hit`뿐이다. 인덱스 전용 스캔의 `Heap Fetches 0`은 `VACUUM` 직후 값이다. autovacuum이 늦은 운영에서는 힙 접근이 늘 수 있다.
- 한도가 큰 호출처(최대 1000만)의 `quota` 그룹 비용, 인스턴스 여러 개와 Prometheus 복제본 여러 개가 동시에 스크레이프할 때의 풀 점유, 예비 연결 4개 가정의 충분성을 확인하지 않았다.
- `sweepExpired`·`recoverExpiredLeases`·`completeAttempt`·취소의 반환 형식을 넓힐 때 기존 테스트에 미치는 범위를 조사하지 않았다.
- `prom-client`의 전이 의존성, ESM 호환, 라이선스를 확인하지 않았다. 직접 의존성 두 개는 `npm view prom-client@15.1.3`의 결과다.
- 구·신 혼용 롤링 배포와 다중 인스턴스 배포를 실행하지 않았다. 구버전 인스턴스의 `/metrics` 404는 코드 읽기 결과다.
- 이벤트 피드의 가시성 지연(오래 열린 트랜잭션이 `xmin`을 붙잡는 경우)을 직접 재는 지표는 만들지 않았다. 필요하면 새 결정이다.
- 발송 소요 시간 히스토그램과 HTTP 요청 지표는 정하지 않았다. 처리량 목표도 정하지 않았다.
- 감사 행 수의 알림 임계값은 운영 경험이 없어 정하지 않았다. 감사 행은 운영자 조작 건수라 작다고 추정한다(ADR-0011 결정 6의 추정, 측정하지 않았다).

## 부록 A. Prometheus 스크레이프 설정 예시

실행해 확인하지 않은 예시다. 구현 뒤 `docs/operations/deployment.md`로 옮기고 확인한 결과로 고친다.

```yaml
scrape_configs:
  - job_name: mailo
    metrics_path: /metrics
    scrape_interval: 15s
    scrape_timeout: 10s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/mailo-ops-read-token
    # 인스턴스마다 타깃을 둔다. 로드 밸런서 주소 하나를 쓰지 않는다.
    static_configs:
      - targets:
          - mailo-1.internal:3000
          - mailo-2.internal:3000
```

- 토큰 파일에는 `MAILO_OPS_TOKEN`의 값(읽기 토큰)을 둔다. 관리 토큰을 넣으면 `/metrics`가 403을 준다.
- Mailo는 TLS를 종단하지 않는다. 같은 호스트, 내부 망, TLS 프록시 뒤 중 하나로 접근한다.

## 부록 B. 권장 알림 규칙 예시

실행해 확인하지 않은 예시다. 임계값은 모두 추정이다. 전역 gauge는 `max by`로, counter는 `sum`과 `rate`·`increase`로 쓴다. `for:`는 캐시 TTL(기본 5초)보다 충분히 길다.

```yaml
groups:
  - name: mailo
    rules:
      - alert: MailoInstanceDown
        expr: up{job="mailo"} == 0
        for: 2m

      - alert: MailoBreakerNotClosed
        expr: max by (account_id) (mailo_breaker_state{state=~"open|half_open"}) == 1
        for: 10m

      - alert: MailoQueueBacklogAge
        expr: max by (account_id) (mailo_queue_oldest_due_age_seconds) > 600
        for: 10m

      - alert: MailoQueueTruncated
        expr: max(mailo_queue_jobs_truncated{state="due"}) == 1
        for: 15m

      - alert: MailoNoProgress
        expr: |
          max(mailo_queue_jobs{state="due"}) > 0
          and sum(rate(mailo_attempts_total[10m])) == 0
          and max(mailo_send_paused_all) == 0
          and max(mailo_breaker_state{state="closed"}) == 1
        for: 15m

      - alert: MailoFailedRatioHigh
        expr: |
          sum(increase(mailo_jobs_finished_total{status="failed"}[15m]))
            / clamp_min(sum(increase(mailo_jobs_finished_total{status=~"sent|failed"}[15m])), 1) > 0.2
          and sum(increase(mailo_jobs_finished_total{status="failed"}[15m])) >= 10
        for: 5m

      - alert: MailoSendPausedLong
        expr: max(mailo_send_paused_all) == 1 or max(mailo_send_paused_callers) > 0
        for: 30m   # 정지 중에도 TTL이 흘러 EXPIRED가 쌓인다

      - alert: MailoWorkerStalled
        expr: mailo_worker_last_poll_age_seconds > 60 or mailo_worker_poll_loop_crashed == 1
        for: 2m

      - alert: MailoMetricsCollectFailing
        expr: mailo_metrics_collect_ok == 0
        for: 5m

      - alert: MailoCallerQuotaNearLimit
        expr: |
          max by (caller_id) (mailo_caller_quota_used)
            / max by (caller_id) (mailo_caller_quota_limit) >= 0.9
        for: 10m

      - alert: MailoLeaseRecovered
        expr: sum(increase(mailo_lease_recovered_total[15m])) > 0   # 중복 발송 가능성 신호(RQ-013)

      - alert: MailoAuditRowsHigh
        expr: max(mailo_ops_audit_rows) > 50000   # 임계값은 근거 없는 예시
        for: 1h
```
