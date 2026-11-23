# 운영 제어는 읽기·관리 토큰을 나눈 운영 REST와 DB 저장 정지·취소로 하고, 호출처 보호는 수신 도메인 허용 목록과 피드 공백 감지로 한다

## 상태

승인됨 (2026-11-24)

2026-11-23에 제안했고 2026-11-24에 사용자가 승인했다. 열린 질문이던 7건은 이 문서가 적은 권고대로 승인했다. 승인된 값은 "미결정·확인하지 않은 것"의 "승인된 결정" 절에 모았다. 입력은 `docs/requirements/roadmap.md`의 "단계 6"이다.

구현 상태(2026-11-24): 구현 묶음 A(작업 취소, 결정 4의 호출처 API와 결정 10의 `0006`·`0007`)와 묶음 B(결정 1 토큰 분리, 결정 2·3 발송 정지, 결정 4의 관리 취소 API, 결정 6 감사, 결정 7의 `/ops` REST, 결정 10의 `0008`)를 구현하고 자동 테스트로 검증했다. 요구사항은 RQ-040(호출처 작업 취소), RQ-041(취소 배포 호환성), RQ-042(운영 토큰과 `/ops` 인증), RQ-043(발송 정지), RQ-044(감사와 관리 취소)다. 구현 순서 1의 문서·샘플 반영(1.1~1.7)을 마쳤고 1.8(저장소 밖 호출처 확인)은 남았다. 구현 순서 2~4는 끝났다. 결정 5(`outcomeUncertain`), 결정 8(`allowedRecipientDomains`), 결정 9(피드 공백 신호), 결정 7의 CLI, 호출처 단위 일괄 취소, `0009`와 구현 순서 5~8은 시작하지 않았다. 구현 중 확정한 세부는 "구현 중 확정" 절이다. `docs/api/openapi.yaml`의 `ReadyResponse`는 `sendPaused`·`sendControls`를 더하고 `Problem`은 `forbidden`을 더했다(`additionalProperties: false`의 계약 변경).

검증 범위는 코드 읽기와 PostgreSQL 17.11(로컬 compose)의 임시 schema 확인이다(2026-11-23).

- 임시 schema에 `0001`~`0005`를 적용하고(`0005`는 `CREATE INDEX CONCURRENTLY`라 트랜잭션 밖에서 적용했다) 이 ADR의 SQL을 실행한 뒤 롤백했다. 임시 schema는 지웠다.
- 확인한 것: `mail_jobs_status_check`·`mail_jobs_terminal_state`·`mail_events_type_check`를 `DROP` 뒤 `NOT VALID`로 다시 추가하면 `CANCELED` 갱신과 `JOB_CANCELED` 삽입이 통과하고, `finished_at` 없는 `CANCELED`는 `mail_jobs_terminal_state`로 거부된다. 한 트랜잭션에서 `mail_jobs`와 `mail_events`에 `AccessExclusiveLock`을 잡는다. `VALIDATE CONSTRAINT`는 `ShareUpdateExclusiveLock`을 잡는다. 삭제 표지 갱신 SQL(결정 9)이 이벤트의 cascade 삭제 전에 표지를 올린다.
- 확인하지 않은 것: 동시 세션에서 쓰기가 실제로 막히지 않는지(잠금 수준만 봤다), 자동 테스트, 롤링 배포, 롤백.

승인으로 다음 관계가 생겼다. 승인된 ADR의 결정 문구는 바꾸지 않는다.

- ADR-0002 결정 7의 상태 표에 `CANCELED`와 두 전이(`PENDING → CANCELED`, `RETRY_WAIT → CANCELED`)를 더한다(결정 4). ADR-0002 "미확정"의 "`CANCELED` 상태" 항목을 해소한다.
- ADR-0006 결정 2는 이벤트 종류 네 개를 열거한다. 여기에 `JOB_CANCELED`를 더한다(결정 4).
- ADR-0006 결정 7은 cursor 형식과 반환 조건을 정한다. 보존 삭제로 생긴 공백은 다루지 않는다. 결정 9가 이 부분을 보완한다. 결정 7의 반환 조건 식은 바꾸지 않는다. 응답에 신호(헤더·410)가 늘어나므로 "변경 없음"이 아니라 보완이다.
- ADR-0006 결정 8의 보존 기간에 공백 감지를 보완한다(결정 9).
- ADR-0007 구현 중 확정 7의 "발송 중지는 호출처를 빼서 표현한다"는 큐에 남은 작업에는 맞지 않는다. 결정 3이 보완한다.
- ADR-0008 구현 중 확정 12(`allowedFrom`)와 대칭인 수신자 규칙을 더한다(결정 8).
- ADR-0009 결정 8의 "이미 `SENDING`인 작업을 중단하지 않는다"는 정지와 취소에도 같다(결정 2·4).
- RQ-014(상태), RQ-015(조회), RQ-017(이벤트·보존), RQ-028(레지스트리·인증), RQ-031(헬스)의 문구를 기능 구현 때 갱신한다. RQ-031의 "발송 정지를 `/health/ready`의 200/503에 반영하지 않는다"는 유지한다.
- 새 RQ 번호는 기능 구현 때 RQ-040 이후로 정한다. 이 ADR은 번호를 가정하지 않는다.

승인과 함께 ADR-0002와 ADR-0006의 상태 절에 보완 표기를 썼다(결정 문구는 고치지 않았다, AGENTS.md "문서와 요구사항 갱신").

## 배경

현재 동작이다(2026-11-23, 코드를 읽어 확인했다).

- 운영자가 할 수 있는 일은 `GET /health/ready`의 읽기 수치뿐이다. 발송을 멈추거나 작업을 취소하는 경로가 없다.
- 점유 모드는 차단기 행 하나로 정해진다(`queue/claim.ts`의 `claim`).
  - `closed`는 일반 점유다.
  - `open`은 `open_until` 전에는 점유하지 않고, 지나면 대표 작업 1건을 점유한다.
  - `half_open`은 `probe_until` 전에는 점유하지 않고, 지나면 대표 작업 1건을 점유한다.
- 호출처 제외는 `caller_id <> ALL(...)` 목록 하나다. 일반 점유와 대표 작업 점유가 같은 목록을 쓴다. 목록은 호출처별 24시간 할당을 넘긴 호출처로 `planQuotas`가 만든다.
- `planQuotas`는 레지스트리에서 할당(`sendQuota24h`)을 설정한 호출처 전부에 `pg_try_advisory_xact_lock`과 사용량 쿼리를 쓴다. 호출처가 어떤 상태인지는 보지 않는다.
- `queue/`와 `worker/`는 호출처 레지스트리를 읽지 않는다. `app.module.ts`가 레지스트리에서 할당 맵만 만들어 Worker에 준다. 그래서 레지스트리에서 호출처를 빼도 큐에 이미 있는 그 호출처의 작업은 계속 점유된다.
- 레지스트리는 기동 때 한 번 읽고, 모르는 필드가 있으면 기동하지 않는다(`callers/registry.ts`의 `ENTRY_FIELDS`).
- 운영 토큰은 `MAILO_OPS_TOKEN` 하나다(`config/load-config.ts`의 `loadOpsToken`). `callers/bearer-auth.ts`의 `checkBearer`가 호출처 API 키와 같은 Bearer 경로에서 이 토큰을 먼저 비교하고 `BearerResult`는 권한 구분 없는 `operator`다. 이 토큰은 `/health/ready`에서만 받는다. 업무 endpoint에서는 401이다.
- 상태 `CHECK`는 세 곳이다. `mail_jobs_status_check`, `mail_jobs_terminal_state`, `mail_events_type_check`다(`0001_queue_schema.sql`). 임시 schema에서 이름을 조회해 확인했다.
- 본문은 종결 뒤 `MAILO_BODY_RETENTION_SECONDS`(기본 86400) 지나면 지운다. 본문 암호화의 AAD는 작업 ID(`mail_jobs.id`)다(ADR-0008 결정 6·7).
  - 본문 컬럼은 `mail_jobs_body_state`가 세 컬럼(`body_ciphertext`·`body_nonce`·`body_key_version`)이 함께 NULL이거나 함께 값이 있을 때만 허용한다.
  - 본문 정리(`deleteExpiredBodies`)는 `body_ciphertext IS NOT NULL`인 종결 작업만 대상으로 한다. 이미 비운 행은 건드리지 않는다.
- 이벤트 cursor는 `(txid, id)`뿐이고 시각이 없다(`events/cursor.ts`). 이벤트는 작업·거부 기록을 지울 때 외래 키 `ON DELETE CASCADE`로 함께 지워진다(`queue/maintenance.ts`의 `deleteExpiredRecords`).
  - 삭제 대상은 `finished_at` 또는 `created_at` 조건에 맞는 행 중 `LIMIT`개이고 `ORDER BY`가 없다. 배치마다 어느 행이 지워지는지 정해져 있지 않다.
  - `MAINTENANCE_BATCH_SIZE`는 1000이다. 긴 트랜잭션은 xmin 기반 피드 cursor를 멈추므로 배치를 키우지 않는다(`queue/maintenance.ts` 머리 주석).
- `docs/api/openapi.yaml`의 `JobStatus`와 `EventType` enum은 닫혀 있다. 오류 `type`은 8종이다(`http/problem.ts`). 403·410 `type`이 없다.
- Java 샘플(`samples/spring-boot-relay`)이 모르는 값을 처리하는 방식이다. 읽어서 확인했고 실행하지 않았다.
  - `EventFeedPoller.apply`의 `default` 분기는 모르는 이벤트 종류에 경고만 남기고 넘어간다. 같은 페이지의 `nextCursor`는 저장하므로 cursor는 그 이벤트를 지나간다. 이 이벤트의 outbox 행은 바뀌지 않는다.
  - `RelayWorker.statusAfterRegistered`의 `default` 분기는 `SENT`·`FAILED`·`EXPIRED` 외의 `Job.status`를 `DELIVERED`로 처리한다. 모르는 상태뿐 아니라 `PENDING`·`SENDING`·`RETRY_WAIT`도 이 분기를 탄다.
  - `DELIVERED`는 "Mailo가 등록했다. 발송 완료가 아니다"라는 뜻이다(`OutboxStatus`). 그러므로 `default` 분기 자체가 모르는 상태를 성공으로 처리하는 것은 아니다.
  - 결함은 조합이다. 폴러가 모르는 이벤트 종류를 건너뛰고 cursor를 넘기며, 샘플에는 `GET /jobs` 호출이 없다. `CANCELED` 작업의 outbox 행은 `DELIVERED`에 영구히 남는다. `JOB_CANCELED`를 놓치면 다시 알 방법이 없다.
  - `MailoClient.getEvents`는 200이 아니면 `IOException`이다. `EventFeedPoller.poll`은 `IOException`을 경고로만 남기고 다음 주기에 같은 요청을 반복한다. 410이나 모르는 4xx를 받으면 피드가 같은 요청에서 영구히 멈춘다.
  - `EventFeedPoller`와 `MailoClient`는 응답을 `JsonNode`로 읽는다. 모르는 응답 필드는 무시된다. 다른 클래스는 확인하지 않았다.
  - `schema.sql`의 `mail_outbox.status` `CHECK`는 8개 값(`PENDING`, `DELIVERED`, `SENT`, `FAILED`, `EXPIRED`, `DEAD`, `REJECTED`, `QUARANTINED`)만 받는다.

장애 때 운영자가 하고 싶은 일은 다음이다.

- SMTP 계정이나 정책 문제가 확인되기 전에 발송을 멈춘다.
- 오설정되거나 키가 유출된 호출처만 멈춘다.
- 잘못 등록된 작업을 나가기 전에 취소한다.
- 호출처 키가 유출돼도 임의 수신자로 대량 발송되지 않게 한다.
- 30일 넘게 폴링을 멈춘 호출처가 이벤트 유실을 알게 한다.

## 결정

1. **운영 토큰을 읽기 토큰과 관리 토큰으로 나눈다.**
   - 문제: 토큰이 하나라 단계 8의 `/metrics`를 같은 토큰으로 열면 정지·취소 권한 토큰이 Prometheus 설정에 놓인다. 감사 기록에 남길 토큰 식별 이름도 없다.
   - 읽기 토큰은 기존 `MAILO_OPS_TOKEN`이다. 이름과 동작을 바꾸지 않는다. 읽기 endpoint(`/health/ready`의 운영자 필드, `GET /ops/*`)만 열고, 단계 8의 `/metrics`도 이 토큰 대상이다.
   - 관리 토큰은 이름마다 하나다. 이름 목록 `MAILO_OPS_ADMIN_NAMES`(쉼표 구분, 이름은 `[a-z][a-z0-9]{0,31}`, 최대 8개)에 이름을 적고, 이름마다 `MAILO_OPS_ADMIN_TOKEN_<이름 대문자>`(`_FILE` 우선)로 값을 받는다. 예: 이름 `oncall`의 변수는 `MAILO_OPS_ADMIN_TOKEN_ONCALL`이다.
   - 관리 토큰은 읽기 권한을 포함한다. 관리 작업의 결과를 같은 토큰으로 확인하기 위해서다.
   - 값 규칙은 기존 운영 토큰과 같다. 공백 없는 32자 이상이다(`config/load-config.ts`의 `loadOpsToken`).
   - 기동 검사: 이름 목록에 있는 이름의 토큰이 없거나 규칙에 어긋나면 기동을 거부한다. 읽기 토큰과 관리 토큰들이 서로 같은 값이거나 호출처 API 키와 같으면 거부한다. 호출처 키 비교는 레지스트리의 `authenticate`를 쓴다.
   - `MAILO_OPS_ADMIN_NAMES`가 없으면 관리 기능은 꺼진다. 관리 endpoint는 어떤 토큰에도 401(자격 없음) 또는 403(읽기 토큰)이다.
   - 판정 결과: `BearerResult`에 `{ kind: "operator", role: "read" }`와 `{ kind: "operator", role: "admin", name }`을 둔다. 읽기 토큰으로 관리 endpoint를 부르면 403(`forbidden`)이다. 호출처 키와 모르는 값은 401이다.
   - 업무 endpoint(`/jobs`, `/events`)에서는 두 토큰 모두 401이다. 기존 동작(`BearerAuthGuard`가 운영자 토큰을 넘기지 않는다)을 유지한다.
   - 위치: 판정은 `callers/bearer-auth.ts`의 `checkBearer`와 가드가 맡는다. `http/`가 아니다. 호출처 API 키와 같은 Bearer 경로를 `callers`가 소유한다.
   - 토큰 값은 로그·감사·오류에 쓰지 않는다. 감사에는 이름만 쓴다(결정 6).
   - 근거:
     - 감사의 `actor`가 토큰 이름이어야 누가 했는지 남는다. "단일 토큰 + 고정 이름"은 `actor`가 의미 없어지고, 나중에 이름별로 바꾸면 환경 변수 계약이 바뀐다.
     - 변수 이름이 설정에서 정해지는 선례가 있다(`callers/registry.ts`의 `MAILO_JWS_SECRET_*`).
     - compose는 `env_file: .env`로 `MAILO_*`를 넘기므로 이름별 변수에 compose 설정을 따로 더하지 않는다. `_FILE`로 받는 값은 파일 마운트를 따로 연다.
   - 기존 관계: RQ-031의 운영자 토큰 문구는 "읽기 토큰"으로 해석한다. `/health/ready`의 운영자 응답은 읽기·관리 토큰 모두에 같다.

2. **발송 일시 정지는 DB에 저장하고 점유의 두 경로에서 판정한다.**
   - 문제: 장애 중 발송을 멈출 수단이 없다. 환경 변수나 레지스트리는 재시작이 필요하고 인스턴스마다 어긋난다. 차단기 행을 재사용하면 계정 장애와 섞인다(대안 표).
   - 테이블 `mail_send_controls`를 둔다. 행이 있으면 정지다. 키는 `(scope_type, scope_id)`다.
     - `scope_type`은 `all`, `account`, `caller`다. `all`의 `scope_id`는 빈 문자열이다.
     - 컬럼은 `paused_at`(DB `now()`)과 `paused_by`(토큰 이름)다. 자유 텍스트 컬럼은 없다.
     - `account` 범위의 키는 스키마에만 둔다. 단계 7에서 마이그레이션 없이 쓰게 하려는 것이다. 이 ADR의 REST는 `account`를 받지 않는다.
   - 점유 판정은 `claim` 트랜잭션 안에서 차단기 행을 읽은 뒤 `mail_send_controls`를 읽는다. 행을 잠그지 않는다.
     - `all` 행이 있으면 모드를 `none`으로 한다. 대표 작업(`half_open`·`open` 만료) 점유도 하지 않는다.
     - `caller` 행의 호출처는 `planQuotas`를 부르기 전에 할당 맵에서 뺀다. 정지된 호출처를 맵에 두면 `planQuotas`가 그 호출처에도 advisory lock과 사용량 쿼리를 쓴다. 정지된 호출처는 점유 대상이 아니므로 이 비용은 쓸모없다.
     - 뺀 호출처와, 할당을 설정하지 않은 정지 호출처는 `planQuotas`가 돌려준 `blocked`에 합친다. 일반 점유와 대표 작업 점유의 `caller_id <> ALL` 필터가 같은 목록을 쓴다. 할당 맵이 비어 `planQuotas`가 일찍 끝나는 경우(`NO_QUOTA`)에도 정지 호출처는 합친다.
     - 잠금 순서(작업 행 → `mail_circuit_breaker` 행)는 바뀌지 않는다. 정지 테이블은 잠그지 않는다.
   - 정지 중에도 lease 복구, 결과 기록, 만료 sweep, 본문·기록 삭제는 계속 돈다(ADR-0007 결정 6과 같은 이유). 등록(REST·파일)도 계속 받는다.
   - 이미 `SENDING`인 작업의 전송은 끝까지 간다(ADR-0009 결정 8). 정지 응답 직후에도 점유가 끝난 작업이 남는다. 정지 명령이 커밋되기 전에 `controls`를 읽은 `claim`이 있을 수 있기 때문이다. 최대 건수는 인스턴스 수 × `MAILO_WORKER_CONCURRENCY`다(코드 읽기에 따른 상한 추정, 측정하지 않았다). ADR-0007 구현 중 확정 11이 차단기에 대해 받아들인 한계와 같다.
   - 정지는 `/health/ready`의 200/503에 반영하지 않는다(RQ-031). 200/503은 DB 연결로만 정한다. 응답 본문에 요약을 두 곳에 더한다.
     - 운영자 응답: `sendControls: { allPaused: boolean, pausedCallerCount: number }`. 호출처 ID는 넣지 않는다(`deployment.md` "헬스"의 "`caller_id`는 어느 필드에도 없다" 유지).
     - 호출처 키 응답: `sendPaused: { paused: boolean, scope: "all" | "caller" | null }`. 그 호출처에 해당하는 정지만 요약한다. `all`과 `caller`가 함께 걸려 있으면 `all`이다. 정지가 없으면 `{ paused: false, scope: null }`이다. 호출처 ID, 운영자 이름, 시각은 넣지 않는다. `eventFeed`처럼 호출처 전용이라 운영자 응답에는 없다.
     - 인증 없는 응답은 바뀌지 않는다. DB 연결이 안 돼 503이면 두 필드 모두 없다.
     - `ReadyResponse` 스키마는 `additionalProperties: false`이므로 필드 추가는 계약 변경이다. 영향 범위 표(결정 4)에 올렸다.
     - 정지를 이벤트 피드로 알리지 않는다(대안 표). 피드는 종결 이벤트용이다. 비종결 이벤트를 넣으면 호출처가 모르는 이벤트 종류를 만나는 문제(구현 순서 1)가 다시 생긴다.
   - 로그: Worker는 정지 상태가 바뀐 것을 관찰할 때 한 번 남긴다. `send_paused`(warn)와 `send_resumed`(info)이고 필드는 `scope`와 `callerId`(범위가 `caller`일 때)뿐이다. 폴링마다 반복하지 않는다(`caller_quota_exceeded`와 같은 방식).
   - 정지 중에도 만료 시각은 흐른다. 긴 정지는 `EXPIRED`를 대량으로 만든다. 운영 문서에 경고를 쓴다. 재개하면 점유 가능한 작업이 한꺼번에 대상이 되고 동시 전송 수와 우선순위(ADR-0009)가 처리 순서를 정한다.
   - 비용: 정지 조회는 `claim`마다 쿼리 한 번이 늘어난다. 행 수는 정지한 범위 수다. 측정하지 않았다.
   - 근거: 정지는 장애 중에 쓰는 기능이라 인스턴스 전체에 즉시 같은 값이 보여야 한다. DB가 이미 전역 상태의 단일 출처다(차단기, ADR-0007 결정 5). 새 상시 서비스가 없다(RQ-029).
   - 기존 관계: ADR-0002 결정 4("전역 차단기가 `open`이면 점유하지 않는다")와 ADR-0007 결정 5는 그대로다. 정지는 차단기와 독립이다. 정지를 풀어도 차단기 상태는 바뀌지 않는다.
   - 경로: `GET /ops/pauses`(읽기), `PUT /ops/pauses/all`, `DELETE /ops/pauses/all`(관리). 멱등하다. 이미 정지(해제) 상태면 상태를 바꾸지 않고 `changed: false`로 200이다.

3. **호출처 단위 정지는 `caller` 범위 행으로 처리한다. 레지스트리에 `enabled` 필드를 만들지 않는다.**
   - 문제: 호출처를 레지스트리에서 빼도 큐의 작업은 계속 발송된다(배경). 그 호출처는 REST 인증을 잃어 조회와 이벤트도 못 읽는다. 키가 유출됐거나 오설정된 호출처를 안전하게 멈출 방법이 없다.
   - `PUT /ops/pauses/callers/{callerId}`, `DELETE /ops/pauses/callers/{callerId}`(관리). `GET /ops/pauses`가 전체 목록을 준다.
   - `callerId`는 레지스트리 ID 형식(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)이어야 한다. 형식이 틀리면 400이다.
   - 레지스트리에 있는지 확인하지 않는다. 이미 레지스트리에서 뺀 호출처의 남은 작업을 멈춰야 하기 때문이다. 응답에 `inRegistry: boolean`을 넣어 오타를 알아보게 한다.
   - 정지한 호출처의 등록은 계속 받는다. 작업은 `PENDING`에 쌓이고 `expiresAt`에 `EXPIRED`가 된다. 멈추려는 목적이 새 요청 거부가 아니라 발송 중단이어서다. 새 요청 자체를 막으려면 키를 폐기한다(`key-management.md`).
   - 레지스트리 `enabled` 필드는 만들지 않는다. 정적 설정은 재시작이 필요하고, 새 필드를 이전 버전이 읽으면 기동하지 못한다(`ENTRY_FIELDS`).
   - `sendQuota24h`에 0을 허용하는 방식도 쓰지 않는다. RQ-032가 0을 허용하지 않는다.
   - 기존 관계: ADR-0007 구현 중 확정 7과 `callers/registry.ts`의 "발송 중지는 호출처를 빼서 표현한다"는 레지스트리 제거가 큐의 남은 작업을 멈춘다는 뜻이면 틀렸다. `claim`이 레지스트리를 읽지 않기 때문이다. 이 결정이 정지 수단을 정한다. 구현 때 소스 주석을 고친다. ADR 문구는 바꾸지 않는다.

4. **작업 취소는 `PENDING`·`RETRY_WAIT`만 `CANCELED`로 바꾼다. 취소 요청은 멱등하고 종결 이벤트 `JOB_CANCELED`를 남긴다.**
   - 문제: 잘못 등록되거나 더는 필요 없는 메일을 나가기 전에 막을 수단이 없다. 파일 채널 호출처는 작업 ID를 모른다.
   - 상태: `CANCELED`는 종결 상태다. `PENDING → CANCELED`, `RETRY_WAIT → CANCELED`만 허용한다. `SENDING`은 취소하지 않는다(ADR-0009 결정 8과 같은 이유로 진행 중 전송을 중단하지 않는다).
   - 호출처 API:
     - `POST /jobs/{jobId}/cancel`: 호출처 키로 자기 작업을 취소한다.
     - `POST /jobs/cancel?idempotencyKey=<key>`: Key로 취소한다. 파일 채널 호출처가 쓴다(ADR-0006 결정 1과 같은 이유). 요청 본문은 없다.
     - 다른 호출처의 작업과 없는 작업은 구분하지 않고 404다.
   - 관리 API: `POST /ops/jobs/{jobId}/cancel`(관리 토큰). 모든 호출처의 작업을 취소하고 감사에 남긴다(결정 6).
   - 응답과 오류:
     - 취소했거나 이미 `CANCELED`이면 200과 `Job`이다. 이미 `CANCELED`이면 이벤트와 감사를 새로 쓰지 않는다(멱등).
     - `SENDING`, `SENT`, `FAILED`, `EXPIRED`이면 409이고 `type`은 `job-not-cancelable`이다. 응답에 현재 `status`만 넣는다.
   - 전이 쿼리: 작업 행을 `status IN ('PENDING','RETRY_WAIT')` 조건으로 갱신하고 같은 트랜잭션에서 이벤트를 쓴다. 이 경로는 작업 행만 잠그고 `mail_circuit_breaker`를 건드리지 않는다. 잠금 순서를 어기지 않는다. `claim`이 행을 잡고 있으면 UPDATE는 그 트랜잭션이 끝나기를 기다린 뒤 `SENDING`이어서 갱신하지 않고 409가 된다. 반대로 취소가 행을 잡고 있으면 `claim`의 `SKIP LOCKED`가 그 행을 건너뛴다.
   - 저장:
     - `finished_at = now()`를 쓴다. `mail_jobs_terminal_state`는 종결 상태와 `finished_at`을 함께 요구한다.
     - `failure_reason`에 `CANCELED_BY_CALLER` 또는 `CANCELED_BY_OPERATOR`를 쓴다. 컬럼에 `CHECK`가 없어 마이그레이션이 필요 없다. 이름이 `failure_reason`이어도 API의 `failureReason`으로는 내보내지 않는다.
     - 본문 컬럼은 취소 때 바로 비운다(`body_ciphertext`·`body_nonce`·`body_key_version`을 NULL, `body_deleted_at = now()`). 나갈 수 없는 메일의 본문을 유예 기간(기본 1일) 더 두지 않는다. 행, Key, 지문은 남긴다(ADR-0005 결정 7).
     - 구버전과 충돌하지 않는다. `mail_jobs_body_state`는 세 본문 컬럼이 함께 NULL인 경우를 허용한다. 구버전의 본문 정리는 `body_ciphertext IS NOT NULL`인 행만 대상으로 하므로 비운 행을 다시 건드리지 않는다.
     - 작업 행은 종결 후 보존 기간(기본 30일) 뒤 지운다. Key도 그동안 유지된다.
   - Key 계약: 취소된 작업의 Key로 같은 내용을 다시 보내면 200과 `CANCELED` 작업이 온다. 다른 내용이면 409다(RQ-034). 다시 보내려면 새 Key를 쓴다.
   - 이벤트: `JOB_CANCELED`를 작업 호출처의 피드에 쓴다. 호출처가 직접 취소해도 쓴다. outbox를 이벤트로 닫는 호출처가 취소를 알아야 하기 때문이다. 필드는 다른 종결 이벤트와 같고 `canceledBy`(`CALLER`·`OPERATOR`)를 더한다. 운영자 이름은 넣지 않는다.
   - `Job` 응답: `canceledAt`, `canceledBy`(`CALLER`·`OPERATOR`·`null`)를 더한다. `sentAt`·`failedAt`·`failureReason`은 `CANCELED`에서 `null`이다.
   - 호출처 단위 일괄 취소(정지한 호출처의 대기 작업 전체)는 이 ADR의 범위 밖이다. 새 결정에서 다음 조건을 지킨다.
     - 관리 토큰 전용이다.
     - 정지된 호출처의 작업만 대상으로 한다.
     - 1000건 배치로 나눠 실행한다. 긴 트랜잭션은 xmin 기반 이벤트 피드를 멈춘다(`queue/maintenance.ts` 머리 주석).
     - 감사 기록은 1행으로 쓰고 건수를 담는다.
   - 영향 범위(구현 때 함께 바꾼다):

     | 대상 | 변경 |
     | ---- | ---- |
     | 마이그레이션 | 결정 10의 `0006`(`mail_jobs` CHECK 2개)과 `0007`(`mail_events` CHECK 1개) |
     | `queue/types.ts`·`read.ts` | `JobStatus`에 `CANCELED`. `TERMINAL_STATUSES`에 추가 |
     | `events` | `JobEventType`에 `JOB_CANCELED`. `intake/query-params.ts`의 `EVENT_TYPES`와 `presentEvent` |
     | `docs/api/openapi.yaml` | `JobStatus`·`EventType` enum, `Job`·`Event` 스키마(`additionalProperties: false`), 새 endpoint, 오류 `type`(결정 7·9) |
     | `docs/api/openapi.yaml`의 `ReadyResponse` | 호출처 키 응답에 `sendPaused`, 운영자 응답에 `sendControls`(결정 2). `additionalProperties: false`라 계약 변경이다 |
     | `docs/api/openapi.yaml`의 검증 오류 코드 enum | `RECIPIENT_DOMAIN_NOT_ALLOWED` 추가(결정 8). enum이 닫혀 있다. 코드 쪽은 `validation/error-item.ts`의 `ValidationErrorCode`다 |
     | `docs/api/openapi.yaml`의 `GET /events` | 쿼리 파라미터 `onGap`, 응답 헤더 `Mailo-Cursor-Gap`, 410 응답(결정 9) |
     | `docs/api/README.md` | 오류 `type` 개수, 상태·이벤트 목록, relay 지침(취소된 Key) |
     | Java 샘플 | "구현 순서"의 선행 조건 |
     | `docs/operations/` | `caller-onboarding.md`(취소 API·Key), `troubleshooting.md`(취소 확인), `deployment.md`(토큰 변수) |

   - 구버전 인스턴스의 동작(코드를 읽어 확인했다, 실행하지 않았다): 구버전의 `presentJob`은 모르는 `status` 문자열을 그대로 내보낸다. `sentAt`·`failedAt`·`failureReason`은 `null`이다. 구버전의 `presentEvent`는 `JOB_CANCELED`를 실패 이벤트 분기로 처리해 `failureReason`에 `CANCELED_BY_CALLER` 같은 저장 값을 그대로 낸다. `canceledBy`는 없다. 구버전의 `GET /events?type=JOB_CANCELED`는 400이다. 구버전은 `CANCELED` 행을 점유·만료·결과 기록 대상으로 읽지 않는다. 롤링 중 문제는 서버가 아니라 모르는 값을 처리하지 못하는 호출처다. 선행 조건이 이를 다룬다.
   - 근거: `CANCELED`를 `FAILED`나 `EXPIRED`로 쓰면 호출처가 "실패했다"와 "취소했다"를 구분하지 못한다. 별도 상태와 이벤트가 필요하다.
   - 기존 관계: ADR-0002 결정 7의 판정 순서(시도 실패 때의 순서)는 바뀌지 않는다. 취소는 시도 결과가 아니다.

5. **실패 작업의 운영자 재시도 API는 만들지 않는다. 작업 조회와 실패·만료 이벤트에 `outcomeUncertain`을 표시한다.**
   - 문제: 호출처는 outbox 행이 실패로 닫혔는데 메일은 이미 나간 경우를 구분하지 못한다. 운영자가 재시도하면 호출처가 Key로 결과를 매칭하지 못한다.
   - 운영자 재시도를 만들지 않는 이유:
     - 호출처는 Key로 결과를 매칭한다. 운영자가 만든 작업의 Key는 호출처 outbox와 맞지 않는다(ADR-0005 결정 8).
     - 본문은 종결 뒤 기본 1일에 지워진다(ADR-0008 결정 7).
     - 본문 암호화의 AAD가 작업 ID라서 암호문을 새 작업으로 복사할 수 없다(`0001_queue_schema.sql`의 `id` 주석, ADR-0008 결정 6). 새 작업에 쓰려면 복호화한 뒤 다시 암호화해야 한다.
   - 호출처가 새 Key로 다시 제출한다. 실패한 작업의 재전송 책임은 호출처다.
   - `outcomeUncertain`은 SMTP 서버가 메일을 수락했는지 알 수 없는 시도가 한 건이라도 있었으면 `true`다. 판정은 `mail_attempts`에서 한다.
     - `classification = 'LEASE_EXPIRED'`인 시도. lease 만료 회수는 전송 결과를 모른다.
     - `classification = 'TRANSIENT'`이고 `stage = 'DATA'`이고 `response_code IS NULL`인 시도. `DATA` 단계의 타임아웃·연결 끊김이다(`smtp/classify.ts`의 `TRANSIENT_DATA_TRANSPORT_FAULT`, ADR-0007 결정 3).
   - 표시 위치: `Job.outcomeUncertain`(모든 상태)과 `JOB_FAILED`·`JOB_EXPIRED` 이벤트의 `outcomeUncertain`이다. 의미는 "FAILED·EXPIRED이면 메일이 이미 나갔을 수 있고, SENT이면 더 일찍 나갔을 수 있다"이다. 조회는 `mail_attempts_job_idx`를 쓰는 `EXISTS`다. 이벤트는 `findLastErrors`와 같은 일괄 조회로 읽는다.
   - 한계: 서버가 응답을 줬지만 Mailo가 받지 못한 경우처럼 위 두 조건에 없는 불명 경우는 잡지 못한다. 시도 이력이 지워지는 보존 기간(30일) 뒤에는 조회 자체가 404다.
   - 기존 관계: 단계 10의 `onUncertainOutcome`(결과 불명 처리 opt-in)은 이 결정과 독립이다. 이 결정은 표시만 하고 재시도 정책은 바꾸지 않는다(ADR-0001 결정 5, ADR-0007 결정 3 유지).

6. **관리 작업은 DB에 감사 기록을 남긴다. 항목은 토큰 이름, 동작, 범위, 대상 ID, 시각뿐이다.**
   - 문제: 누가 언제 발송을 멈추거나 작업을 취소했는지 남지 않는다. 호출처 등록·키 교체는 파일 설정이라 저장소 이력이 감사 기록이지만 정지·취소는 DB 상태다.
   - 테이블 `mail_ops_audit`: `id`(identity), `at`(DB `now()`), `actor`(관리 토큰 이름, 1~32자), `action`(`PAUSE`·`RESUME`·`CANCEL_JOB`), `scope_type`·`scope_id`(정지·재개), `job_id`(취소, 외래 키 없음).
     - `job_id`에 외래 키를 두지 않는다. 작업 행이 보존 기간 뒤 지워져도 기록이 남는다.
     - `CHECK`가 동작별 필드 조합을 강제한다. 자유 텍스트 컬럼(사유, 메모)을 만들지 않는다. 로그에 요청 값을 쓰지 않는 원칙(RQ-027)과 같은 이유다.
   - 감사는 상태 변경과 같은 트랜잭션에 쓴다. 상태를 바꾼 요청만 기록한다. `changed: false`인 멱등 재요청은 기록하지 않는다.
   - 401·403 시도는 감사하지 않는다. 요청 로그(`http_request`)가 `route`와 `status`를 남긴다(`http/request-context.ts`). 토큰 이름은 인증에 실패하면 알 수 없다.
   - 호출처가 키로 직접 취소한 것은 감사 대상이 아니다. 관리 작업이 아니고 작업 행의 `failure_reason`과 `JOB_CANCELED` 이벤트가 남는다.
   - 읽기: `GET /ops/audit?limit=<1~200, 기본 50>&before=<id>`(읽기 토큰). 최근 순서다. 응답은 `{ entries, nextBefore }`다.
   - 로그: 관리 작업마다 `ops_pause_set`, `ops_pause_cleared`, `ops_job_canceled`(info)를 남긴다. 필드는 `actor`, `scope`(또는 `jobId`)뿐이다.
   - 보존: DB 테이블이고 자동 삭제를 두지 않는다. 행 수를 감시하고, 삭제 정책은 새 결정으로 정한다. 행 수는 운영자 조작 건수라 작다고 추정한다(미측정). 감시 수단(지표 또는 DB 조회)은 단계 8에서 정한다.
   - 대안: 로그만 쓰는 방식은 로그 보존이 인프라에 달려 있어 채택하지 않는다.

7. **운영 REST를 `/ops` 아래 두고, CLI는 읽기 명령을 먼저 낸다.**
   - 경로와 권한은 다음과 같다.

     | 경로 | 권한 | 동작 |
     | ---- | ---- | ---- |
     | `GET /ops/pauses` | 읽기 | 정지 목록 |
     | `PUT`·`DELETE /ops/pauses/all` | 관리 | 전체 정지·재개 |
     | `PUT`·`DELETE /ops/pauses/callers/{callerId}` | 관리 | 호출처 정지·재개 |
     | `GET /ops/jobs/{jobId}` | 읽기 | 작업 조회(모든 호출처) |
     | `POST /ops/jobs/{jobId}/cancel` | 관리 | 작업 취소 |
     | `GET /ops/audit` | 읽기 | 감사 목록 |

   - 응답 모양:
     - `PUT`·`DELETE /ops/pauses/...`: `{ "scope": { "type": "all" | "caller", "id"?: string }, "paused": boolean, "changed": boolean, "pausedAt"?: string, "pausedBy"?: string, "inRegistry"?: boolean }`. `pausedAt`·`pausedBy`는 정지 상태일 때만, `inRegistry`는 `caller` 범위일 때만 있다.
     - `GET /ops/pauses`: `{ "pauses": [{ "scope": {...}, "pausedAt": string, "pausedBy": string }] }`.
     - 취소: 호출처 API는 `Job`, 관리 API는 `GET /ops/jobs/{jobId}`와 같은 모양이다.
     - `GET /ops/audit`: `{ "entries": [{ "id": string, "at": string, "actor": string, "action": string, "scope"?: {...}, "jobId"?: string }], "nextBefore": string | null }`. `id`는 `eventId`처럼 문자열이다.
   - `GET /ops/jobs/{jobId}`는 `Job`에서 `idempotencyKey`를 뺀 필드에 `callerId`를 더한다. 수신자와 본문은 없다. 운영자 읽기에 호출처의 Key 값을 주지 않는다.
   - 공통 응답은 JSON이다. 오류는 `application/problem+json`이다(기존 형식). 새 오류 `type`은 `forbidden`(403), `job-not-cancelable`(409), `cursor-expired`(410, 결정 9의 `onGap=error` 요청에만)이다. 오류 본문에 요청 값을 넣지 않는다.
   - `/ops/*` 경로 파라미터의 퍼센트 디코딩 오류는 `problem.filter.ts`가 `/jobs/` 접두사만 `validation-failed`로 바꾼다. `/ops/` 경로도 같게 처리한다.
   - CLI: 같은 이미지에서 `node dist/cli.js`로 실행한다. 상주 프로세스가 없다. 운영 REST를 호출한다. 새 npm 의존성 없이 Node의 `fetch`를 쓴다.
     - 읽기 명령(1차): `status`(`/health/ready`와 `/ops/pauses`), `queue stats`(`/health/ready`의 `queue`), `jobs show <jobId>`(`/ops/jobs/{jobId}`), `audit list`(`/ops/audit`).
     - 변경 명령(2차): `pause`, `resume`, `jobs cancel`. 운영 REST가 구현·검증된 뒤에 낸다. `--yes` 없이는 실행하지 않는다.
     - 연결: `MAILO_CLI_URL`(기본 `http://127.0.0.1:<MAILO_PORT>`)로 호출한다. 토큰은 `MAILO_CLI_TOKEN_FILE`(우선) 또는 `MAILO_CLI_TOKEN`으로 받는다. 서버의 `MAILO_OPS_*` 변수를 읽지 않는다. 명령줄 인자로 받지 않는다(프로세스 목록에 보인다).
     - 출력은 서버 응답 JSON 그대로다. 종료 코드는 성공 0, 사용법 오류 1, HTTP 오류 2, 연결 실패 3이다(추정, 구현에서 확정한다).
   - 근거: 읽기 명령은 위험이 없어 먼저 낸다. 변경 명령은 REST의 권한·감사가 검증돼야 안전하다.
   - 기존 관계: RQ-031은 헬스 응답만 정했다. `/ops/*`는 새 표면이다. 모든 `/ops/*`는 호출처 키로 401이다.

8. **호출처별 수신 도메인 허용 목록 `allowedRecipientDomains`를 레지스트리에 둔다.**
   - 문제: API 키 유출이나 스테이징 오설정 때 임의 수신자에게 대량 발송된다.
   - 필드: 도메인 문자열 배열이다. 1~50개이고 생략하면 제한이 없다. 빈 배열은 기동을 거부한다(`sendQuota24h`의 0 금지와 같은 이유로, 모두 거부하려면 정지나 키 폐기를 쓴다).
   - 값 형식은 정확 일치, 소문자, ASCII(A-label)뿐이다. 국제화 도메인은 A-label(`xn--`)로 적는다.
   - 기동 검사: 레지스트리 값을 접수 검증과 같은 규칙으로 검사한다. 규칙은 `validation/mail-request.ts`의 `checkAddress`가 쓰는 도메인 규칙이다. 라벨은 ASCII 영숫자와 `-`이고 라벨 수는 2 이상이며 마지막 라벨은 숫자뿐일 수 없다. 이 규칙을 도메인 단독으로 검사하는 함수를 `validation`의 `index.ts`로 공개해 `callers`가 쓴다.
     - 다음은 기동을 거부한다: 대문자 포함, 비ASCII(U-label), 끝 점, `*`, 선행 `.`, 목록 안의 중복, 빈 배열, 51개 이상.
     - 선행 `.`를 거부하는 것은 하위 도메인 문법을 나중에 넣을 자리를 남기기 위해서다. 지금은 문법이 없다.
     - 오류 메시지는 항목 위치(`callers[i].allowedRecipientDomains[j]`)와 사유 코드만 담고 값은 담지 않는다(RQ-027).
   - 판정: `to`·`cc`·`bcc`의 모든 주소에서 `@` 뒤를 소문자로 바꿔 목록과 정확히 비교한다. 하위 도메인은 따로 적는다. 와일드카드는 없다. `replyTo`는 수신자가 아니라 제한하지 않는다.
   - 하나라도 어기면 요청 전체를 거부한다. REST는 400 `validation-failed`이고 `errors`에 어긴 주소의 위치(`/to/0`, `/cc/1` 등)와 `code: RECIPIENT_DOMAIN_NOT_ALLOWED`를 넣는다. 주소와 도메인 값은 응답·로그에 넣지 않는다(RQ-027).
     - 이 `code`는 `validation/error-item.ts`의 `ValidationErrorCode`에 더한다. openapi.yaml의 검증 오류 코드 enum이 닫혀 있으므로 같은 변경에서 enum과 설명을 갱신한다(결정 4의 영향 범위 표).
     - 파일 채널은 `VALIDATION_FAILED` 수집 거부다. 거부 사유 코드는 새로 만들지 않는다.
   - 검사 위치와 순서는 `allowedFrom`과 같다. 새 작업이 될 때만 거부하고, 이미 등록된 Key의 재전송은 기존 작업(200)이나 409를 그대로 돌려준다(`denyNew`). 수신자는 평문 필드라 평문·암호화 모드 모두 같게 적용한다(RQ-022).
   - 지문 범위에 넣지 않는다. 요청 내용이 아니라 호출처 정책이다.
   - 레지스트리는 기동 때 한 번 읽는다. 변경은 재시작 뒤 반영된다(RQ-032 한계와 같다). 마이그레이션은 없다.
   - 한계: 허용 도메인 안의 대량 발송은 막지 못한다. 도메인의 MX 등 실제 수신 가능 여부는 보지 않는다.
   - 기존 관계: RQ-028의 레지스트리 항목에 필드를 더한다. ADR-0008 구현 중 확정 12의 `allowedFrom`과 대칭이다. ADR-0006 결정 3의 거부 사유 `VALIDATION_FAILED`를 그대로 쓴다.

9. **이벤트 피드는 cursor 뒤에서 이벤트가 삭제됐으면 응답 헤더 `Mailo-Cursor-Gap: true`로 알린다. 호출처가 요청하면 410으로 알린다. 판정은 호출처·이벤트 종류별 삭제 표지로 한다.**
   - 문제: 30일 넘게 폴링을 멈춘 호출처는 그 사이 삭제된 이벤트를 알지 못한다(ADR-0006 "결과").
   - cursor만으로는 판정할 수 없다. cursor는 `(txid, id)`뿐이고 시각이 없다. 이벤트 행은 삭제되면 사라져서 cursor가 가리키는 행의 시각을 읽을 수 없다.
   - 남은 이벤트와 비교하는 방식(남은 가장 오래된 위치 > cursor, 또는 id 비교)을 쓰지 않는다.
     - 이벤트가 드문 호출처는 cursor가 가리키는 행이 지워져도 cursor 뒤에서 지워진 이벤트가 없을 수 있다. 이 경우 비교는 공백이 없는데 있다고 판정한다.
     - 정렬 키가 `(txid, id)`이고 `id`는 전역 identity다. 한 호출처의 `id`는 원래 띄엄띄엄이고 롤백된 INSERT도 번호를 쓴다. `id` 차이를 누락 건수로 읽을 수 없다.
   - 삭제 표지 테이블 `mail_event_purges(caller_id, type, purged_txid xid8, purged_id bigint, updated_at)`를 둔다. 키는 `(caller_id, type)`이다. 삭제된 이벤트 중 `(txid, id)` 순서가 가장 큰 위치를 호출처·종류별로 담는다. `type`에는 `CHECK`를 두지 않는다. 값은 `mail_events.type`에서 복사한다(종류가 늘 때 갱신할 목록을 하나로 유지한다).
   - 기록: `deleteExpiredRecords`가 작업·거부 기록을 지우는 같은 트랜잭션에서 표지를 올린다.
     - 이벤트는 외래 키 `ON DELETE CASCADE`로 지워지므로 `DELETE ... RETURNING`에 나오지 않는다. 그래서 표지 값은 `DELETE` 전에 구한다. 지울 행 ID를 고르고(`FOR UPDATE SKIP LOCKED`) 그 ID에 이벤트를 조인해 `(caller_id, type)`별로 `ORDER BY txid DESC, id DESC`의 첫 행(`DISTINCT ON`)을 표지에 올린 뒤 `DELETE`한다. 작업 삭제와 거부 기록 삭제에 각각 한다.
     - 표지는 줄어들지 않는다(`ON CONFLICT ... DO UPDATE ... WHERE (기존 txid, 기존 id) < (새 txid, 새 id)`).
     - 쿼리는 임시 schema에서 실행해 확인했다(상태 절 "검증 범위").
     - 표지 쓰기는 `events` 모듈이 소유한다. `queue`의 보존 삭제가 `events`의 `index.ts`가 내는 함수를 같은 트랜잭션 연결로 부른다.
   - 판정: `after`가 있을 때만 검사한다. 요청한 종류(`type` 필터가 없으면 모든 종류)의 표지 중 하나라도 cursor보다 크면(`(purged_txid, purged_id) > (cursor.txid, cursor.id)`, `listEvents`와 같은 튜플 비교) 공백이다.
     - 표지가 cursor 이하이면 삭제된 이벤트를 호출처가 이미 지나왔다. 누락이 없다.
     - 표지가 cursor보다 크면 그 종류의 이벤트가 cursor 뒤에서 삭제됐다. 호출처는 그 이벤트를 받은 적이 없으므로 누락이다.
     - 종류를 키에 넣으므로 `type` 필터로 읽는 호출처가 다른 종류의 삭제 때문에 공백으로 판정되지 않는다.
     - 조회 순서는 이벤트를 읽은 뒤 표지를 읽는다. 반대로 하면 삭제가 두 조회 사이에 커밋될 때 누락을 놓친다(추론, 동시 실행으로 확인하지 않았다). 이 순서는 이미 읽은 이벤트가 삭제 직전 상태일 때 공백이라는 신호를 더 내는 쪽(오탐)으로만 틀린다.
   - 응답 기본값은 200이고 응답 헤더 `Mailo-Cursor-Gap: true`를 붙인다. 이벤트 본문 형식은 바꾸지 않는다.
     - 헤더는 표지가 cursor보다 큰 동안 매 응답에 붙는다. 호출처가 `nextCursor`로 이어서 읽으면 cursor가 표지를 넘을 때 사라진다.
     - 410은 opt-in이다. 쿼리 파라미터 `onGap=error`를 보내면 공백일 때 410, `type`은 `cursor-expired`다. 본문은 고정 문구이고 요청 값을 넣지 않는다.
     - 기본을 410으로 하지 않는 이유: Java 샘플은 200이 아닌 응답을 `IOException`으로 보고 경고만 남긴 뒤 다음 주기에 같은 요청을 반복한다(배경). 410을 모르는 호출처는 피드가 영구히 멈춘다. 지금의 일부 유실보다 나쁘다.
     - 헤더로 하는 이유: `EventPage` 스키마가 `additionalProperties: false`이므로 본문 필드를 더하면 계약이 바뀐다. 헤더는 모르는 호출처가 무시한다.
     - opt-in을 쿼리 파라미터로 하는 이유: 410을 처리할 수 있는지는 호출처 코드가 안다. 레지스트리 필드는 재시작이 필요하고 이전 버전이 새 필드를 거부해 기동하지 못한다(`ENTRY_FIELDS`). `parseEventsQuery`는 모르는 쿼리 파라미터를 무시하므로 `onGap`을 아는 호출처가 구버전 서버에 보내도 안전하다. 읽고 판단한 결과이고 실행하지 않았다.
   - 호출처의 복구:
     - 헤더를 받으면 응답의 이벤트는 정상 처리하고, 종결되지 않은 outbox 행은 `GET /jobs?idempotencyKey=`로 확인한다. 30일이 지나 404인 Key는 호출처가 정한다.
     - 410을 받으면 `after` 없이 다시 읽어 남은 이벤트부터 받고 같은 확인을 한다. 같은 `after`로 `onGap` 없이 다시 읽어도 된다.
   - 복구 중 재발:
     - 삭제는 `finished_at` 기준 배치 `LIMIT`이고 정렬이 없다. 호출처가 복구하려고 읽는 동안에도 아직 읽지 않은 오래된 이벤트가 더 지워질 수 있다.
     - `after` 없는 읽기는 판정하지 못한다. 복구 읽기를 `after` 없이 하면 이 재발은 신호가 없다.
     - 같은 `after`로 이어 읽으면 표지가 cursor를 넘을 때까지 헤더가 붙으므로 재발도 신호가 난다.
     - 구간은 짧다. 복구 읽기는 `hasMore`가 false가 될 때까지이고 폴링 한 주기 안에 끝난다고 추정한다(측정하지 않았다). 복구 뒤에 `GET /jobs` 확인으로 한 번 더 점검한다.
   - 로그: `event_cursor_gap`(warn)에 `callerId`만 담는다. 헤더든 410이든 공백으로 판정한 응답마다 한 줄이다.
   - cursor 형식과 반환 조건(`txid < xmin`, `(txid, id) > cursor`)은 바꾸지 않는다. 공백 신호가 응답에 늘어나므로 ADR-0006 결정 7을 "보완"하는 것이다(상태 절).
   - 판정 방향: 표지가 (호출처, 종류)별 최대 위치이므로 cursor보다 큰 표지는 cursor 뒤에서 지워진 그 종류 이벤트가 있다는 뜻이다. 오탐은 위 조회 순서 경우뿐이다. 미탐은 아래 한계 세 가지다.
   - 한계:
     - 이 변경 전에 이미 삭제된 이벤트는 표지에 없다. 마이그레이션 전 삭제분은 판정하지 못한다.
     - `after` 없이 읽는 호출처(이벤트를 한 번도 받지 못해 cursor가 `null`인 호출처, 복구 읽기)는 판정하지 못한다.
     - 롤링 중 구버전 인스턴스가 지운 이벤트는 표지에 오르지 않는다.
     - 헤더를 모르는 호출처는 지금처럼 공백을 알지 못한다.
   - 검사 비용은 호출처 키 기본키 조회다. `type` 필터가 없으면 종류 수(최대 5)만큼의 행이다. 측정하지 않았다.
   - 근거: 호출처는 이벤트를 놓쳤다는 사실을 알아야 outbox 행이 영원히 종결되지 않는 것을 막을 수 있다.
   - 기존 관계: ADR-0006 결정 8의 30일 보존은 그대로다. "호출처가 30일 넘게 폴링하지 않으면 놓칠 수 있다"는 한계를 부분적으로 해소한다(위 한계 제외).

10. **배포와 롤백은 마이그레이션 → 모든 인스턴스 교체 → 기능 켜기 순서이고, 마이그레이션은 되돌리지 않는다.**
    - 마이그레이션은 새 파일로 추가한다(`apps/mailo/migrations/`). 적용된 파일은 수정하지 않는다. 테이블마다 파일을 나눈다.
      - `0006_job_canceled_status.sql`: `mail_jobs`의 `mail_jobs_status_check`, `mail_jobs_terminal_state`를 교체한다. 각 `DROP CONSTRAINT` 뒤 같은 이름으로 `ADD CONSTRAINT ... NOT VALID`다. `mail_jobs`만 잠근다.
      - `0007_event_type_canceled.sql`: `mail_events`의 `mail_events_type_check`를 같은 방식으로 교체한다. `mail_events`만 잠근다.
      - `0008_ops_controls.sql`: `mail_send_controls`, `mail_ops_audit`를 만든다. 기존 테이블을 잠그지 않는다.
      - `0009_event_purges.sql`: `mail_event_purges`를 만든다. 기존 테이블을 잠그지 않는다.
      - `-- mailo:no-transaction`이 필요한 문장은 없다. `CREATE INDEX CONCURRENTLY`를 쓰지 않는다.
    - `0006`·`0007`의 `NOT VALID`는 `0003`·`0004`와 방식이 다르다.
      - `0003`·`0004`는 새 컬럼에 새 `CHECK`를 `NOT VALID`로 추가했다. 기존 행에는 값이 없거나 `DEFAULT`뿐이라 어긋나는 행이 없었다.
      - `0006`·`0007`은 검증된 `CHECK`를 `DROP`한 뒤 같은 이름으로 `NOT VALID`로 다시 추가한다. 제약이 미검증(`convalidated = false`) 상태로 남는다. 임시 schema에서 확인했다. `0004`가 추가한 `mail_jobs_priority_rank`도 같은 상태다.
      - 기존 행은 옛 `CHECK`가 이미 검증했고 새 조건은 옛 조건에 `CANCELED`·`JOB_CANCELED`를 더한 것이다. 기존 행은 모두 새 조건을 만족한다. 그래서 `VALIDATE CONSTRAINT`가 새로 알려 주는 것이 없다.
    - `VALIDATE CONSTRAINT`를 이 마이그레이션에서 하지 않는 이유는 검증이 새로 알려 주는 것이 없기 때문이다(위). 스캔 비용은 이유가 아니다.
      - `VALIDATE CONSTRAINT`는 `ShareUpdateExclusiveLock`을 잡는다. 임시 schema에서 `pg_locks`로 확인했다. 이 잠금은 읽기·쓰기를 막지 않는다(PostgreSQL 문서로 알고 있는 내용이다. 동시 세션으로 확인하지 않았다).
      - 스캔 비용은 `mail_jobs` 크기에 비례한다. 측정하지 않았다.
      - 미검증 제약이 거슬리면 운영자가 별도 파일로 나중에 `VALIDATE`할 수 있다. 이 ADR은 그 파일을 정하지 않는다.
    - 확인 범위: `0001`~`0005`를 적용한 임시 schema에서 세 `CHECK` 교체와 `CANCELED`·`JOB_CANCELED` 삽입·갱신을 확인하고 롤백했다. 실제 운영 크기의 테이블이나 동시 쓰기는 확인하지 않았다.
    - 잠금 대기: `ALTER TABLE ... DROP/ADD CONSTRAINT`는 테이블에 `ACCESS EXCLUSIVE`를 잡는다. 임시 schema에서 `pg_locks`로 확인했다. 한 트랜잭션에서 `mail_jobs`와 `mail_events`를 바꾸면 두 테이블 모두에 이 잠금이 걸린다.
      - 이미 도는 긴 쿼리나 트랜잭션이 있으면 `ACCESS EXCLUSIVE` 요청이 기다리고, 그 뒤에 온 앱 쿼리도 이 요청 뒤에 줄을 선다(PostgreSQL 잠금 큐 규칙에서의 추론, 실행해 확인하지 않았다).
      - 두 테이블을 한 파일에서 바꾸면 첫 테이블의 잠금을 쥔 채 두 번째 테이블의 잠금을 기다릴 수 있다. 그동안 첫 테이블의 앱 쿼리가 모두 줄을 선다.
      - 마이그레이션의 `lock_timeout` 기본값은 10초다(`db/migrator.ts`). 풀에 `lock_timeout`이 이미 있으면 그 값을 쓴다. 시간이 지나면 그 파일만 롤백되고 실행기가 실패한다. 다시 실행하면 된다.
      - 그래서 테이블마다 파일을 나눈다. 잠금 대기가 파일마다 따로이고 한 파일이 기다리는 동안 다른 테이블은 막히지 않는다.
      - 점유 쿼리는 짧아 대기가 길지 않을 것으로 추정한다. 측정하지 않았다.
    - 배포 순서:
      1. 선행 조건(아래 "구현 순서")이 끝나 있어야 한다.
      2. 마이그레이션 `0006`~`0009`를 적용한다. 구버전은 새 테이블과 새 상태 허용을 쓰지 않으므로 영향이 없다.
      3. 모든 인스턴스를 새 버전으로 바꾼다.
      4. 관리 토큰(`MAILO_OPS_ADMIN_NAMES`와 토큰 변수)을 설정하고 인스턴스를 다시 시작한다. 환경 변수는 기동 때 읽는다.
      5. 호출처 레지스트리에 `allowedRecipientDomains`를 넣고 인스턴스를 다시 시작한다. 모든 인스턴스가 새 버전이 된 뒤에만 한다. 구버전은 새 필드를 `ENTRY_FIELDS`에서 거부해 기동하지 못한다. 순서는 "코드 먼저, 레지스트리 나중"이다(ADR-0009 결정 10과 같다).
      6. 호출처가 취소 API를 쓰기 시작한다.
    - 롤링 중(구·신 혼용) 제약:
      - 구버전 인스턴스는 정지를 읽지 않는다. 롤링 중에는 정지 명령을 쓰지 않는다. 쓰면 구버전 인스턴스가 계속 발송한다.
      - 구버전 인스턴스는 삭제 표지를 쓰지 않는다. 그 사이 지운 이벤트는 공백 감지에서 빠진다.
    - 롤백 순서: 이 순서를 지킨다.
      1. 호출처의 취소 API 사용을 먼저 멈춘다.
      2. 정지를 모두 푼다. 구버전은 정지를 무시하므로 정지가 남은 채 롤백하면 발송이 조용히 재개된다.
      3. 레지스트리에서 `allowedRecipientDomains`를 뺀다. 남기면 구버전이 기동하지 못한다.
      4. 이전 버전으로 인스턴스를 바꾼다.
    - 마이그레이션은 되돌리지 않는다. `CANCELED` 행과 `JOB_CANCELED` 이벤트가 남으면 옛 `CHECK`를 복원하지 못한다. 롤백해도 새 테이블·상태는 남긴다. 구버전은 이를 읽지 않고, `CANCELED` 작업의 상태는 그대로 내보낸다(결정 4).
    - 롤백으로 `CANCELED` 상태가 구버전에 보이는 동안 호출처가 모르는 값을 처리하는지는 호출처 책임이다. 선행 조건이 이 부분을 다룬다.

## 구현 순서

이 ADR 승인(2026-11-24) 뒤의 순서다. 단계마다 관련 문서를 같은 변경에서 갱신한다(AGENTS.md "문서와 요구사항 갱신").

1. **선행 조건: 취소 전에 호출처와 샘플이 모르는 값과 모르는 필드를 처리하게 한다.** 이 단계가 끝나기 전에는 취소 기능을 배포 대상에 넣지 않는다. 운영자 취소(`/ops/jobs/{jobId}/cancel`)는 호출처가 바라지 않은 `CANCELED`를 만들 수 있으므로 관리 토큰 설정(배포 순서 4)을 이 단계 뒤로 미룬다. 이 단계는 이 ADR의 구현 범위가 아니다.
   1. `docs/api/README.md`와 `docs/api/openapi.yaml`에 "모르는 값" 규칙을 쓴다. 규칙은 다음 세 가지다.
      - 모르는 이벤트 종류와 모르는 `Job.status`를 무시하거나 성공으로 처리하지 않는다. 비종결 상태(`PENDING`·`SENDING`·`RETRY_WAIT`)를 완료로 처리하지 않는 것도 포함한다.
      - 해당 작업을 종결되지 않은 상태로 방치하지 않는다. 작업 ID나 Key로 `GET /jobs`를 조회해 상태를 확인하고, 확인할 때까지 "확인 필요"로 표시해 알린다.
      - 모르는 응답 필드는 무시한다. OpenAPI의 `Job`·`Event`·`EventPage`·`ReadyResponse`가 `additionalProperties: false`이고 이 ADR이 `canceledAt`·`canceledBy`·`outcomeUncertain`·`sendPaused` 같은 필드를 더한다.
   2. `samples/spring-boot-relay/src/main/java/sample/relay/events/EventFeedPoller.java`의 `apply`: `default` 분기의 경고만 하는 처리를 위 규칙대로 고친다. 모르는 종류를 `record`로 남기고 outbox 행이 있으면 "확인 필요"로 표시한다.
   3. `samples/spring-boot-relay/src/main/java/sample/relay/relay/RelayWorker.java`의 `statusAfterRegistered`: `default` 분기가 모르는 상태와 `PENDING`·`SENDING`·`RETRY_WAIT`를 한꺼번에 `DELIVERED`로 처리한다. 비종결 상태 세 개를 명시적으로 `DELIVERED`로 두고, 그 밖의 모르는 상태는 "확인 필요"로 처리하게 한다.
   4. `samples/spring-boot-relay/src/main/java/sample/relay/mailo/MailoClient.java`: `getEvents`가 410(`onGap=error`를 보낸 경우)과 `Mailo-Cursor-Gap` 헤더를 읽어 결정 9의 복구 절차를 따르게 한다. 200이 아닌 응답이 `IOException`으로 같은 요청을 반복하는 동작도 함께 고친다.
   5. `MailoClient`에 `GET /jobs?idempotencyKey=`와 `GET /jobs/{jobId}` 호출을 추가한다. 지금 샘플에는 `GET /jobs` 호출이 없어 위 규칙의 "확인"을 할 수 없다.
   6. `samples/spring-boot-relay/src/main/resources/schema.sql`: `mail_outbox.status`의 `CHECK`에 새 상태를 추가한다("확인 필요", 취소). `CHECK`가 8개 값만 받는다. 새 값을 쓰면 갱신이 실패한다.
   7. 샘플이 `JOB_CANCELED`와 `CANCELED`를 알게 하는 변경(종결 상태 추가)은 규칙을 먼저 넣은 뒤에 한다.
   8. 실제 호출처의 코드는 이 저장소에 없다. 호출처마다 같은 규칙 준수를 확인한다(확인하지 않았다).
2. 마이그레이션 `0006`·`0007` + `queue`·`events` 타입에 `CANCELED`·`JOB_CANCELED`를 더한다. 읽기 모델과 presenters는 새 값을 처리하고, 호출처 취소 API와 이벤트를 구현한다.
3. 토큰 분리(`BearerResult`, 읽기·관리 가드, 기동 검사)와 `/ops` 읽기 endpoint.
4. `0008`, 정지 판정(`claim`의 두 경로와 `planQuotas` 전 정지 호출처 제외), 정지·재개 REST, 감사 기록, 관리 취소.
5. `outcomeUncertain` 표시.
6. `allowedRecipientDomains`(레지스트리 기동 검사, REST·파일 검사, 새 검증 코드 `RECIPIENT_DOMAIN_NOT_ALLOWED`).
7. `0009`, 삭제 표지 기록, `after` 검사, 헤더 `Mailo-Cursor-Gap`과 `onGap=error`의 410.
8. CLI 읽기 명령. 변경 명령은 3·4의 REST를 검증한 뒤 낸다.
9. 문서와 요구사항: 승인 뒤 RQ를 추가하고 `docs/operations/`의 `deployment.md`(변수·헬스·롤링 순서), `key-management.md`(관리 토큰), `caller-onboarding.md`, `troubleshooting.md`(로그 이벤트 이름 `send_paused`, `send_resumed`, `ops_pause_set`, `ops_pause_cleared`, `ops_job_canceled`, `event_cursor_gap`, `job_canceled`)를 고친다. 모듈 목록(`AGENTS.md`)에 `ops`를 더한다. `docker-compose.yml`과 `.env.example`에 새 변수를 더한다.

모듈 경계: 정지 테이블과 취소 SQL은 `mail_jobs`를 소유한 `queue`에 둔다. 감사 테이블과 REST는 새 모듈 `ops`가 소유한다. 삭제 표지 테이블은 `events`가 소유하고 `queue`의 보존 삭제가 `events`의 `index.ts`를 통해 부른다. 새 npm 의존성은 없다.

검증 계획(구현 때): 정지가 일반 점유와 대표 작업 점유를 모두 막는지, 호출처 정지가 다른 호출처를 막지 않는지, 정지 호출처가 `planQuotas` 계산(advisory lock·사용량 쿼리)에서 빠지는지, 호출처 키 `/health/ready`의 `sendPaused`가 자기 범위만 보이는지, 취소와 `claim`의 경합, `CHECK` 교체 뒤 새 상태 허용과 옛 행 보존, 표지 판정의 누락·오탐 경계(`type` 필터, cursor 이하 표지, 이벤트가 드문 호출처, 표지 갱신과 cascade 삭제의 같은 트랜잭션), 헤더 기본값과 `onGap=error`의 410, `allowedRecipientDomains` 기동 거부 사례(대문자·U-label·끝 점·`*`·선행 `.`·중복·빈 배열), 감사 기록에 자유 텍스트와 토큰이 없는지(canary 문자열 검색), 호출처 키로 `/ops`가 401인지, 읽기 토큰의 관리 endpoint가 403인지를 PostgreSQL 통합 테스트로 확인한다.

## 구현 중 확정 (2026-11-24)

결정 문구는 바꾸지 않는다. 1~8은 구현 묶음 A(작업 취소), 9~18은 구현 묶음 B(토큰 분리·발송 정지·감사·`/ops`)에서 정한 세부다.

1. **409 응답의 현재 상태 필드 이름(결정 4, `src/http/problem.ts`).** 결정 4는 "응답에 현재 `status`만 넣는다"고 적었다. RFC 9457의 `status`는 HTTP 상태 코드(409)이고 같은 이름으로 작업 상태를 넣으면 덮어쓴다. 작업의 현재 상태는 `jobStatus` 필드로 낸다. `type`은 `urn:mailo:problem:job-not-cancelable`이다. 오류 본문에 요청 값을 넣지 않는 규칙은 같다.
2. **이벤트의 취소 주체 저장(결정 4, `queue/cancel.ts`).** `mail_events`에 새 컬럼을 두지 않는다. 이벤트의 `failure_reason`에 작업과 같은 값(`CANCELED_BY_CALLER`·`CANCELED_BY_OPERATOR`)을 쓰고, 응답의 `canceledBy`는 이 값에서 만든다(`intake/presenters.ts`의 `canceledByOf`). 모르는 값은 `null`이다. 이 저장 값이 구버전 인스턴스에서는 실패형 이벤트의 `failureReason`으로 그대로 나간다(결정 4의 구버전 동작과 같다).
3. **`JOB_CANCELED` 이벤트의 필드(결정 4).** `jobId`, `idempotencyKey`, `attempts`, `recipients`에 `canceledBy`를 더한다. `failureReason`·`lastError`·`rejectedRecipients`는 내지 않는다. 취소는 실패가 아니고 `lastError`를 읽는 일괄 조회(`findLastErrors`)의 대상도 아니다.
4. **취소 전이 쿼리(결정 4, `queue/cancel.ts`의 `cancelJob`).** 한 트랜잭션에서 `UPDATE ... WHERE status IN ('PENDING','RETRY_WAIT') RETURNING`으로 전이하고 이벤트를 쓴다. 갱신 행이 없으면 같은 트랜잭션에서 현재 상태를 읽어 `already_canceled`·`not_cancelable`·`not_found`를 가른다. `claim`이 잠근 행은 UPDATE가 기다리고, 커밋 뒤 `SENDING`이어서 갱신하지 않는다. 이 동작을 `test/queue/cancel.integration-spec.ts`가 잠금을 직접 쥐고 확인한다. 취소는 `mail_circuit_breaker`를 읽거나 쓰지 않는다.
5. **마이그레이션 검증(결정 10).** `0006`·`0007` 적용 뒤 세 제약 모두 `convalidated = false`이고 이름이 같다는 것을 `test/db/job-constraints.integration-spec.ts`가 확인한다. `CANCELED`와 `finished_at`의 짝(`mail_jobs_terminal_state`)과 `JOB_CANCELED` 삽입도 같은 파일이 확인한다. 임시 schema 확인(상태 절)과 달리 자동 테스트다. 동시 쓰기 중의 잠금 대기는 여전히 확인하지 않았다.
6. **호출처 경로의 라우트 구성(결정 4).** `POST /jobs/cancel`(Key)과 `POST /jobs/:jobId/cancel`(작업 ID)은 세그먼트 수가 달라 겹치지 않는다. 요청 본문은 읽지 않는다. 경로 파라미터의 퍼센트 디코딩 오류는 기존 `/jobs/` 접두사 처리로 `validation-failed`다(`http/problem.filter.ts`).
7. **로그(결정 4, 구현 순서 9).** `job_canceled`(info)는 `jobId`, `callerId`, `canceledBy`만 담고 이미 취소된 작업의 재요청에는 남기지 않는다. 관리 토큰 경로의 `ops_job_canceled`는 이 묶음에 없다.
8. **검증.** PostgreSQL 통합: `test/queue/cancel.integration-spec.ts`, `test/http/rest-cancel.integration-spec.ts`, `test/db/job-constraints.integration-spec.ts`, `test/e2e/mail-flow.integration-spec.ts`(취소 뒤 Worker가 발송하지 않음). 샘플: Gradle 단위 테스트와 `samples/spring-boot-relay/verify/run-e2e.sh`의 S15·S15b(스크립트 검증, 자동 테스트 아님).
9. **관리 로그의 필드(결정 6, `ops/ops.service.ts`).** 결정 6은 `ops_pause_set`·`ops_pause_cleared`의 필드를 `actor`와 `scope`뿐이라고 적었다. 호출처 정지는 어느 호출처인지 알아야 하므로 `scope`를 `all`·`caller` 값으로 두고 `callerId`를 함께 낸다(Worker의 `send_paused`와 같은 모양이다). `ops_job_canceled`는 `actor`, `jobId`다. 상태를 바꾼 요청에만 남기고 멱등 재요청에는 남기지 않는다. 호출처 ID는 형식 검사를 통과한 식별자다.
10. **호출처 키와의 비교 위치(결정 1, `callers/callers.module.ts`).** 결정 1의 "호출처 API 키와 같으면 거부"는 `CALLER_REGISTRY` provider가 레지스트리를 읽은 직후 `authenticate`로 한다. `loadConfig`는 레지스트리를 모르기 때문이다. 어기면 `ConfigError`(변수 이름만 담는다)로 기동하지 않는다. 이름 목록에 없는 이름의 `MAILO_OPS_ADMIN_TOKEN_*` 변수는 읽지 않고 거부하지도 않는다.
11. **정지 읽기 시점(결정 2, `queue/claim.ts`).** `claim`은 차단기 행을 읽은 직후, 모드를 정하기 전에 `mail_send_controls`를 읽는다. 차단기가 닫혀 점유하지 않는 호출에서도 읽는다. Worker가 정지 상태 변화를 로그로 남기려면 모든 호출에서 관찰해야 하기 때문이다. 전체 정지면 `planQuotas`를 부르지 않는다. 읽은 상태는 `onSendControls` 콜백으로 Worker에 알린다.
12. **정지 행 쓰기(결정 2, `queue/send-controls.ts`).** `INSERT ... ON CONFLICT (scope_type, scope_id) DO UPDATE SET scope_type = EXCLUDED.scope_type RETURNING ..., (xmax = 0)`로 쓴다. 이미 정지면 같은 값을 다시 써 행을 잠그고 처음 시각·이름을 돌려주며 `changed: false`다. 동시에 `DELETE`가 와도 항상 한 행을 돌려받는다. 해제는 `DELETE`의 `rowCount`로 `changed`를 정한다.
13. **`account` 범위 행(결정 2).** 테이블은 `account`를 허용하지만 `GET /ops/pauses`는 `all`·`caller`만 내고 `claim`도 `account` 행을 읽지 않는다. 단계 7이 이 행을 쓰게 될 때 두 곳을 함께 바꾼다.
14. **`/ops` 응답 헤더와 오류(결정 7).** 모든 `/ops` 성공 응답에 `Cache-Control: no-store`를 둔다. 결정 7에 없는 추가다. `callerId` 형식 오류는 `PUT`·`DELETE` 모두 400(`parameter: callerId`, `INVALID_FORMAT`)이고 경로의 잘못된 퍼센트 인코딩은 `/ops/jobs/`·`/ops/pauses/callers/` 접두사에서만 `validation-failed`다(`http/problem.filter.ts`). `GET /ops/audit`의 `limit`(1~200)·`before`(양의 int64) 오류는 `parameter`와 `INVALID_FORMAT`뿐이다. 같은 이름을 반복하면 오류다.
15. **감사 쪽 나눔(결정 6).** `nextBefore`는 `limit`건을 넘게 있을 때만 마지막 항목의 `id`다. 정확히 `limit`건이 남았으면 `null`이다. 한 건 더 읽어 판정한다. `at`은 DB `now()`(트랜잭션 시작 시각)다. 항목의 `scope`는 `PauseScope`와 같은 모양이고 `jobId`는 취소 항목에만 있다.
16. **관리 취소의 입력(결정 4, `queue/cancel.ts`).** `cancelJobAsOperator(client, { jobId })`가 호출처 범위를 푼 입력이다. 호출처 경로의 `cancelJob(pool, CancelTarget)`은 `callerId`가 필수라 호출처 키 경로에서 범위가 풀릴 수 없다. 두 함수가 같은 SQL 본문(`cancelWithin`)을 쓴다. 관리 경로는 호출자가 연 트랜잭션의 연결을 받아 감사를 같은 트랜잭션에 쓴다. 새로 취소했을 때만 감사와 `ops_job_canceled`를 쓴다.
17. **`ReadyResponse`의 필드(결정 2).** 영향 범위 표대로 운영자 응답에 `sendControls`, 호출처 키 응답에 `sendPaused`를 더했다. 기존 통합 테스트(`rest-intake.integration-spec.ts`의 호출처 키 `ready` 응답 동등 비교)에 `sendPaused: { paused: false, scope: null }`을 더했다. 필드가 계약에 새로 생겼기 때문이고 다른 값은 바꾸지 않았다.
18. **점유 쿼리 비용 측정(결정 2의 "비용").** 결정 2는 정지 조회 비용을 측정하지 않았다고 적었다. 로컬 PostgreSQL 17의 임시 schema에서 대기 10만 건으로 `EXPLAIN (ANALYZE, BUFFERS)`를 한 번씩 실행했다. 정지 조회는 `Seq Scan` 1행, 실행 0.009ms다. 정지가 없으면 점유 쿼리 계획이 바뀌지 않는다(인덱스 스캔, 실행 0.03ms). 정지 호출처 4개를 `caller_id <> ALL`로 빼도 같은 계획이다(실행 0.07ms). 정지한 호출처가 대기 작업 전부를 가지면 `mail_jobs` 전체를 읽는다(순서 인덱스를 못 쓰고 `Seq Scan`과 `Sort`, 실행 7.4ms와 13.8ms 두 사례). ADR-0007 구현 중 확정 10의 할당 초과와 같은 동작이다. 다중 인스턴스와 운영 크기는 측정하지 않았다.

## 검토한 대안

| 결정 | 대안 | 채택하지 않은 이유 |
| ---- | ---- | ------------------ |
| 1 | 토큰 하나 유지, 경로로만 구분 | `/metrics`를 같은 토큰으로 열면 정지·취소 권한 토큰이 Prometheus 설정에 놓인다 |
| 1 | 토큰에 권한을 담는 서명 토큰(JWT) | 새 형식과 키 관리가 늘어난다. 운영 의존성을 늘리지 않는 원칙(RQ-029)과 맞지 않는다 |
| 1 | 관리 토큰 하나(`MAILO_OPS_ADMIN_TOKEN`), 감사 이름은 고정값 | 감사의 `actor`가 의미 없어진다. 나중에 이름별로 바꾸면 환경 변수 계약이 바뀐다 |
| 1 | 운영 REST 없이 DB에 직접 SQL | 권한 분리와 감사 기록이 없다. 운영자마다 DB 쓰기 계정이 필요하다 |
| 2 | 환경 변수 `MAILO_SEND_PAUSED` | 재시작이 필요하고 인스턴스마다 값이 어긋난다 |
| 2 | 차단기 행을 `open`으로 두고 `open_until`을 먼 시각으로 | 정지가 계정 장애로 보인다(공개 `/health/ready`의 `circuitBreaker.state`). `last_reason` 의미가 오염되고 만료 뒤 대표 작업 경로가 정지를 푼다 |
| 2 | 인스턴스를 내린다 | 등록과 조회까지 멈춘다. 호출처 relay가 503을 받는다 |
| 2 | 정지를 이벤트 피드로 호출처에 알림 | 피드는 종결 이벤트용이다. 비종결 이벤트를 넣으면 호출처가 모르는 이벤트 종류를 만나는 문제가 다시 생긴다 |
| 2 | 정지를 `/health/ready` 200/503에 반영 | RQ-031 결정과 충돌한다. 오탐이면 오케스트레이터가 정상 인스턴스를 재시작한다 |
| 3 | 레지스트리 `enabled: false` | 재시작이 필요하고 새 필드를 이전 버전이 거부한다. 빼는 방식과 달리 큐의 작업은 계속 발송된다 |
| 3 | 레지스트리에서 호출처를 뺀다 | 큐에 남은 작업이 계속 발송되고 호출처가 조회·이벤트를 읽지 못한다 |
| 3 | 호출처 정지 때 새 요청 등록도 거부 | 호출처 outbox가 쌓이고 오류 처리가 늘어난다. 새 요청 차단은 키 폐기가 맡는다 |
| 4 | `CANCELED` 대신 `FAILED`·`EXPIRED`에 사유를 두기 | 호출처가 실패와 취소를 구분하지 못한다. 이벤트 종류도 같아 재시도 판단이 섞인다 |
| 4 | `SENDING`도 취소 | 전송 중단은 결과 기록과 lease 계약(ADR-0002 결정 6, 9)을 바꾼다. SMTP 수락 여부가 더 불명해진다 |
| 4 | `DELETE /jobs/{jobId}` | 삭제처럼 보이지만 행·Key·이벤트는 남는다 |
| 4 | 취소 때 본문을 기존 유예 기간 동안 유지 | 나갈 수 없는 메일의 본문이 불필요하게 남는다 |
| 4 | 호출처 단위 일괄 취소 | 이번 범위에 포함하지 않는다. 새 결정에서 지킬 조건은 결정 4에 있다 |
| 5 | 운영자 재시도 API | 호출처가 Key로 매칭하지 못하고 본문이 지워졌으며 AAD 때문에 암호문을 복사하지 못한다 |
| 5 | `onUncertainOutcome`으로 지금 정책 변경 | 승인된 결정(ADR-0001 결정 5, ADR-0007 결정 3)을 바꾼다. 단계 10의 별도 ADR이 먼저다 |
| 6 | 운영자 사유를 자유 텍스트로 받기 | 로그와 응답에 요청 값이 들어갈 길이 된다(RQ-027). 주소·본문이 섞일 수 있다 |
| 6 | 감사를 로그에만 | 로그 보존이 인프라에 달려 있다. DB가 단일 출처다 |
| 7 | 운영 웹 UI | 로드맵이 보류했다. CLI와 REST로 시작한다 |
| 7 | CLI가 DB에 직접 접속 | 새 권한과 비밀이 필요하다. 권한 분리와 감사를 우회한다 |
| 8 | 와일드카드 `*.example.com` | 이번에는 정확한 일치만 둔다. 필요하면 하위 도메인을 따로 적는다. 선행 `.`와 `*`를 기동 때 거부해 하위 도메인 문법을 나중에 넣을 자리를 남긴다 |
| 8 | 대문자·U-label·끝 점을 정규화해 받기 | 접수 검증과 규칙이 갈라진다. 기동 때 거부해 레지스트리 오타를 바로 알게 한다 |
| 8 | 도메인 외 수신자 개별 목록 | 호출처가 수신자를 아는 업무가 아니면 관리 부담이 크다. 도메인이 단위다 |
| 8 | 등록 단계에 호출처별 한도와 429 | ADR-0005 결정 5, ADR-0007 결정 10이 등록 응답에 429를 쓰지 않기로 했다 |
| 9 | 이벤트가 있는 가장 오래된 위치와 cursor 비교, 또는 `id` 비교 | 이벤트가 드문 호출처는 cursor 행이 지워져도 공백이 없을 수 있다. 정렬 키가 `(txid, id)`이고 `id`는 전역 identity라 호출처별로 띄엄띄엄이며 롤백된 INSERT도 번호를 쓴다 |
| 9 | cursor에 발급 시각을 넣는다 | cursor 형식을 바꾼다. 옛 cursor에는 시각이 없어 판정하지 못한다. ADR-0006 결정 7을 바꾸는 새 결정이 필요하다 |
| 9 | 전역 삭제 표지 한 행 | 이벤트가 드문 호출처의 정상 cursor가 항상 표지보다 작아 공백 신호가 반복된다 |
| 9 | 표지 키를 `caller_id`만 | `type` 필터로 읽는 호출처가 다른 종류의 삭제 때문에 공백으로 판정된다 |
| 9 | 공백 응답 기본값을 410 | 410을 모르는 호출처(Java 샘플)는 `IOException`으로 같은 요청을 반복해 피드가 영구히 멈춘다. 지금의 일부 유실보다 나쁘다 |
| 9 | 공백을 본문 필드로 알림 | `EventPage`가 `additionalProperties: false`라 계약이 바뀐다. 헤더는 모르는 호출처가 무시한다 |
| 9 | 410 opt-in을 레지스트리 필드로 | 재시작이 필요하고 이전 버전이 새 필드를 거부한다. 410 처리 능력은 호출처 코드가 안다 |
| 9 | 보존 기간을 시각으로만 비교(`now() - 30일`) | cursor에서 시각을 알 수 없다 |
| 10 | 새 `CHECK`를 검증하며 추가(`VALIDATE`) | 기존 행이 이미 옛 `CHECK`를 통과했고 새 조건은 그 상위 집합이라 새로 알려 주는 것이 없다. `VALIDATE`는 쓰기를 막지 않는 잠금이지만(미확인) 스캔 비용이 든다 |
| 10 | `mail_jobs`·`mail_events` `CHECK` 교체를 한 파일(한 트랜잭션)에 | 두 테이블에 `ACCESS EXCLUSIVE`를 한 파일이 끝날 때까지 쥔다. 잠금 대기 중 앱 쿼리가 줄을 선다 |

## 결과

- 운영자는 읽기 토큰(감시)과 관리 토큰(정지·취소)을 따로 쓴다. 관리 토큰마다 이름이 감사에 남는다.
- 발송 정지·재개와 호출처 정지가 재시작 없이 DB로 즉시 적용된다. 정지 응답 직후 이미 점유한 작업은 전송된다.
- 취소된 작업은 `CANCELED`와 `JOB_CANCELED`로 호출처에 알려진다. 호출처가 모르는 값을 처리하지 못하면 outbox 행이 종결되지 않는다. 선행 조건이 이를 막는다.
- 실패한 작업의 메일이 이미 나갔을 가능성을 `outcomeUncertain`으로 볼 수 있다. 재시도는 호출처가 새 Key로 한다. 중복 발송 위험은 호출처가 판단한다.
- 수신 도메인 허용 목록은 호출처 키 유출의 피해 범위를 도메인으로 줄인다. 허용 도메인 안의 대량 발송은 막지 못한다.
- 30일 넘게 폴링을 멈춘 호출처는 이벤트 공백을 응답 헤더 `Mailo-Cursor-Gap`으로 안다. `onGap=error`를 보내면 410이다. 헤더를 모르는 호출처는 지금처럼 알지 못한다. 이 변경 전 삭제분과 cursor가 없는 호출처는 제외다.
- 새 테이블이 3개, 마이그레이션 파일이 4개(`0006`~`0009`), 새 상태 값 1개, 새 이벤트 종류 1개, 새 오류 `type` 3개, 새 검증 코드 1개, 새 쿼리 파라미터 1개(`onGap`), 새 응답 헤더 1개, `ReadyResponse` 필드 2개, 새 환경 변수가 늘어난다. 새 npm 의존성과 새 상시 서비스는 없다(RQ-029).
- 롤백해도 마이그레이션과 `CANCELED` 행은 남는다. 정지를 먼저 풀지 않으면 롤백 뒤 발송이 재개된다.
- 이 ADR의 비용과 동작은 구현·측정하지 않았다. 정지 판정 쿼리, `ACCESS EXCLUSIVE` 대기, 표지 갱신의 비용이 해당한다.

## 미결정·확인하지 않은 것

### 승인된 결정(2026-11-24)

열린 질문이던 7건이다. 사용자가 권고대로 승인했다. 결정 본문과 같은 값이다.

- 관리 토큰: 이름별 토큰(`MAILO_OPS_ADMIN_NAMES` + `MAILO_OPS_ADMIN_TOKEN_<이름>`). 단일 토큰과 고정 이름은 기각한다(결정 1).
- 정지 통지: 이벤트 피드에 넣지 않는다. 호출처 키 `/health/ready`의 `sendPaused`로 자기 범위 요약만 준다(결정 2).
- 호출처 일괄 취소: 범위 밖이다. 새 결정에서 지킬 조건은 결정 4에 적었다.
- 감사 보존: DB 테이블, 자동 삭제 없음. 행 수를 감시하고 삭제 정책은 새 결정으로 정한다. 감시 수단은 단계 8에서 정한다. 401·403은 감사하지 않는다(결정 6).
- 취소 때 본문 즉시 삭제를 유지한다(결정 4).
- `allowedRecipientDomains`: 정확 일치, 소문자, ASCII(A-label)뿐이다. 기동 때 검사해 어긋나면 거부한다(결정 8).
- 공백 응답: 기본은 200과 `Mailo-Cursor-Gap: true`이고 410은 `onGap=error`일 때만이다. 쿼리 파라미터로 한다(결정 9).

### 확인하지 않은 것

- 코드로 확인하지 않은 것(결정 근거의 추정): 정지 응답 직후 점유 중인 작업의 최대 건수(인스턴스 수 × `MAILO_WORKER_CONCURRENCY`)는 코드 읽기에서 나온 상한이고 실행해 확인하지 않았다.
- 이벤트 피드 공백 감지: 표지 갱신 SQL은 임시 schema에서 확인했다. 30일 경과, 동시 삭제·조회, 복구 중 재발은 실행하지 않았다(DB 시각을 당겨 확인하는 테스트는 구현 때 한다). 한계는 결정 9에 적었다.
- `VALIDATE CONSTRAINT`가 동시 쓰기를 막지 않는지는 잠금 수준만 확인했다. 잠금 큐에서 앱 쿼리가 줄을 서는 동작은 PostgreSQL 규칙에서 추론했고 실행하지 않았다.
- 롤링 배포(구·신 혼용)와 롤백을 실행하지 않았다. 구버전의 `CANCELED`·`JOB_CANCELED` 처리는 코드 읽기 결과다.
- 이 저장소 밖의 호출처가 모르는 상태·이벤트·필드와 410을 어떻게 처리하는지 확인하지 않았다. Java 샘플의 `EventFeedPoller`·`RelayWorker`·`MailoClient`·`schema.sql`만 읽었다.
- CLI의 토큰 전달 방식(`MAILO_CLI_TOKEN_FILE`·`MAILO_CLI_TOKEN`)과 컨테이너 안 실행(`docker compose exec`)을 실행해 확인하지 않았다. 읽기 전용 루트 파일 시스템(AGENTS.md)에서 `node dist/cli.js`는 쓰기가 없다고 추정한다.
- 정지 판정(`claim`마다 쿼리 1회), `ALTER TABLE`의 `ACCESS EXCLUSIVE` 대기, 삭제 표지 갱신(1000건 배치)의 비용을 측정하지 않았다.
- `/metrics`(단계 8)의 권한은 읽기 토큰으로 정했으나 endpoint와 지표는 이 ADR의 범위가 아니다.
- 단계 7(다중 SMTP 계정)에서 `account` 범위 정지의 REST와 점유 판정을 정한다. 이 ADR은 스키마 키만 정했다.
