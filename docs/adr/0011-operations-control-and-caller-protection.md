# 운영 제어는 읽기·관리 토큰을 나눈 운영 REST와 DB 저장 정지·취소로 하고, 호출처 보호는 수신 도메인 허용 목록과 피드 공백 감지로 한다

## 상태

제안(미승인) (2026-11-23)

사용자가 승인하기 전까지 이 ADR의 결정은 확정이 아니다. 구현하지 않았고 이 변경에서 코드·샘플·API 문서를 바꾸지 않았다. 입력은 `docs/requirements/roadmap.md`의 "단계 6"이다.

검증 범위는 코드 읽기와 PostgreSQL 17.11(로컬 compose)의 임시 schema 확인이다. 임시 schema에는 `0001`~`0004`를 적용하고 이 ADR의 SQL을 실행한 뒤 롤백했다. 자동 테스트, 롤링 배포, 롤백은 실행하지 않았다.

승인되면 다음 관계가 생긴다. 승인된 ADR의 결정 문구는 바꾸지 않는다.

- ADR-0002 결정 7의 상태 표에 `CANCELED`를 더한다(결정 4). ADR-0002 "미확정"의 "`CANCELED` 상태" 항목을 해소한다.
- ADR-0006 결정 2의 이벤트 종류에 `JOB_CANCELED`를 더한다(결정 4). 결정 7의 cursor 형식은 바꾸지 않는다. 결정 8의 보존 기간에 공백 감지를 더한다(결정 9).
- ADR-0007 구현 중 확정 7의 "발송 중지는 호출처를 빼서 표현한다"는 큐에 남은 작업에는 맞지 않는다. 결정 3이 보완한다.
- ADR-0008 구현 중 확정 12(`allowedFrom`)와 대칭인 수신자 규칙을 더한다(결정 8).
- ADR-0009 결정 8의 "이미 `SENDING`인 작업을 중단하지 않는다"는 정지와 취소에도 같다(결정 2·4).
- RQ-014(상태), RQ-015(조회), RQ-017(이벤트·보존), RQ-028(레지스트리·인증), RQ-031(헬스)의 문구를 승인 뒤 갱신한다. RQ-031의 "발송 정지를 `/health/ready`의 200/503에 반영하지 않는다"는 유지한다.
- 새 RQ 번호는 승인 때 정한다. 이 ADR은 번호를 가정하지 않는다.

## 배경

현재 동작이다(2026-11-23, 코드를 읽어 확인했다).

- 운영자가 할 수 있는 일은 `GET /health/ready`의 읽기 수치뿐이다. 발송을 멈추거나 작업을 취소하는 경로가 없다.
- 점유 모드는 차단기 행 하나로 정해진다(`queue/claim.ts`의 `claim`).
  - `closed`는 일반 점유다.
  - `open`은 `open_until` 전에는 점유하지 않고, 지나면 대표 작업 1건을 점유한다.
  - `half_open`은 `probe_until` 전에는 점유하지 않고, 지나면 대표 작업 1건을 점유한다.
- 호출처 제외는 `caller_id <> ALL(...)` 목록 하나다. 일반 점유와 대표 작업 점유가 같은 목록을 쓴다. 목록은 호출처별 24시간 할당을 넘긴 호출처로 `planQuotas`가 만든다.
- `queue/`와 `worker/`는 호출처 레지스트리를 읽지 않는다. `app.module.ts`가 레지스트리에서 할당 맵만 만들어 Worker에 준다. 그래서 레지스트리에서 호출처를 빼도 큐에 이미 있는 그 호출처의 작업은 계속 점유된다.
- 레지스트리는 기동 때 한 번 읽고, 모르는 필드가 있으면 기동하지 않는다(`callers/registry.ts`의 `ENTRY_FIELDS`).
- 운영 토큰은 `MAILO_OPS_TOKEN` 하나다(`config/load-config.ts`의 `loadOpsToken`). `callers/bearer-auth.ts`의 `checkBearer`가 호출처 API 키와 같은 Bearer 경로에서 이 토큰을 먼저 비교하고 `BearerResult`는 권한 구분 없는 `operator`다. 이 토큰은 `/health/ready`에서만 받는다. 업무 endpoint에서는 401이다.
- 상태 `CHECK`는 세 곳이다. `mail_jobs_status_check`, `mail_jobs_terminal_state`, `mail_events_type_check`다(`0001_queue_schema.sql`). 임시 schema에서 이름을 조회해 확인했다.
- 본문은 종결 뒤 `MAILO_BODY_RETENTION_SECONDS`(기본 86400) 지나면 지운다. 본문 암호화의 AAD는 작업 ID(`mail_jobs.id`)다(ADR-0008 결정 6·7).
- 이벤트 cursor는 `(txid, id)`뿐이고 시각이 없다(`events/cursor.ts`). 이벤트는 작업·거부 기록을 지울 때 외래 키 `ON DELETE CASCADE`로 함께 지워진다(`queue/maintenance.ts`의 `deleteExpiredRecords`).
- `docs/api/openapi.yaml`의 `JobStatus`와 `EventType` enum은 닫혀 있다. 오류 `type`은 8종이다(`http/problem.ts`). 403·410 `type`이 없다.
- Java 샘플은 모르는 값을 두 곳에서 잘못 처리한다.
  - `EventFeedPoller.apply`의 `default` 분기는 모르는 이벤트 종류를 경고만 하고 건너뛴다. 이 이벤트의 outbox 행은 종결되지 않는다.
  - `RelayWorker.statusAfterRegistered`의 `default` 분기는 모르는 `Job.status`를 `DELIVERED`로 처리한다.
  - `MailoClient.getEvents`는 200이 아니면 `IOException`이다. 410을 구분하지 않는다.

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
   - 값 규칙은 기존 운영 토큰과 같다. 공백 없는 32자 이상이다.
   - 기동 검사: 이름 목록에 있는 이름의 토큰이 없거나 규칙에 어긋나면 기동을 거부한다. 읽기 토큰과 관리 토큰들이 서로 같은 값이거나 호출처 API 키와 같으면 거부한다. 호출처 키 비교는 레지스트리의 `authenticate`를 쓴다.
   - `MAILO_OPS_ADMIN_NAMES`가 없으면 관리 기능은 꺼진다. 관리 endpoint는 어떤 토큰에도 401(자격 없음) 또는 403(읽기 토큰)이다.
   - 판정 결과: `BearerResult`에 `{ kind: "operator", role: "read" }`와 `{ kind: "operator", role: "admin", name }`을 둔다. 읽기 토큰으로 관리 endpoint를 부르면 403(`forbidden`)이다. 호출처 키와 모르는 값은 401이다.
   - 업무 endpoint(`/jobs`, `/events`)에서는 두 토큰 모두 401이다. 기존 동작(`BearerAuthGuard`가 운영자 토큰을 넘기지 않는다)을 유지한다.
   - 토큰 값은 로그·감사·오류에 쓰지 않는다. 감사에는 이름만 쓴다(결정 6).
   - 기존 관계: RQ-031의 운영자 토큰 문구는 "읽기 토큰"으로 해석한다. `/health/ready`의 운영자 응답은 읽기·관리 토큰 모두에 같다.

2. **발송 일시 정지는 DB에 저장하고 점유의 두 경로에서 판정한다.**
   - 문제: 장애 중 발송을 멈출 수단이 없다. 환경 변수나 레지스트리는 재시작이 필요하고 인스턴스마다 어긋난다. 차단기 행을 재사용하면 계정 장애와 섞인다(대안 표).
   - 테이블 `mail_send_controls`를 둔다. 행이 있으면 정지다. 키는 `(scope_type, scope_id)`다.
     - `scope_type`은 `all`, `account`, `caller`다. `all`의 `scope_id`는 빈 문자열이다.
     - 컬럼은 `paused_at`(DB `now()`)과 `paused_by`(토큰 이름)다. 자유 텍스트 컬럼은 없다.
     - `account` 범위의 키는 스키마에만 둔다. 단계 7에서 마이그레이션 없이 쓰게 하려는 것이다. 이 ADR의 REST는 `account`를 받지 않는다.
   - 점유 판정은 `claim` 트랜잭션 안에서 차단기 행을 읽은 뒤 `mail_send_controls`를 읽는다. 행을 잠그지 않는다.
     - `all` 행이 있으면 모드를 `none`으로 한다. 대표 작업(`half_open`·`open` 만료) 점유도 하지 않는다.
     - `caller` 행의 호출처는 할당 초과 목록(`quota.blocked`)에 합친다. 일반 점유와 대표 작업 점유의 `caller_id <> ALL` 필터가 같이 쓴다.
     - 잠금 순서(작업 행 → `mail_circuit_breaker` 행)는 바뀌지 않는다. 정지 테이블은 잠그지 않는다.
   - 정지 중에도 lease 복구, 결과 기록, 만료 sweep, 본문·기록 삭제는 계속 돈다(ADR-0007 결정 6과 같은 이유). 등록(REST·파일)도 계속 받는다.
   - 이미 `SENDING`인 작업의 전송은 끝까지 간다(ADR-0009 결정 8). 정지 응답 직후에도 점유가 끝난 작업이 남는다. 정지 명령이 커밋되기 전에 `controls`를 읽은 `claim`이 있을 수 있기 때문이다. 최대 건수는 인스턴스 수 × `MAILO_WORKER_CONCURRENCY`다(코드 읽기에 따른 상한 추정, 측정하지 않았다). ADR-0007 구현 중 확정 11이 차단기에 대해 받아들인 한계와 같다.
   - 정지는 `/health/ready`의 200/503에 반영하지 않는다(RQ-031). 운영자 응답에만 요약을 더한다. `sendControls: { allPaused: boolean, pausedCallerCount: number }`다. 호출처 ID는 이 응답에 넣지 않는다(`deployment.md` "헬스"의 "`caller_id`는 어느 필드에도 없다" 유지). 인증 없는 응답과 호출처 키 응답은 바뀌지 않는다.
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
     - 작업 행은 종결 후 보존 기간(기본 30일) 뒤 지운다. Key도 그동안 유지된다.
   - Key 계약: 취소된 작업의 Key로 같은 내용을 다시 보내면 200과 `CANCELED` 작업이 온다. 다른 내용이면 409다(RQ-034). 다시 보내려면 새 Key를 쓴다.
   - 이벤트: `JOB_CANCELED`를 작업 호출처의 피드에 쓴다. 호출처가 직접 취소해도 쓴다. outbox를 이벤트로 닫는 호출처가 취소를 알아야 하기 때문이다. 필드는 다른 종결 이벤트와 같고 `canceledBy`(`CALLER`·`OPERATOR`)를 더한다. 운영자 이름은 넣지 않는다.
   - `Job` 응답: `canceledAt`, `canceledBy`(`CALLER`·`OPERATOR`·`null`)를 더한다. `sentAt`·`failedAt`·`failureReason`은 `CANCELED`에서 `null`이다.
   - 영향 범위(구현 때 함께 바꾼다):

     | 대상 | 변경 |
     | ---- | ---- |
     | 마이그레이션 | 결정 10의 `0006`. CHECK 3개 교체 |
     | `queue/types.ts`·`read.ts` | `JobStatus`에 `CANCELED`. `TERMINAL_STATUSES`에 추가 |
     | `events` | `JobEventType`에 `JOB_CANCELED`. `intake/query-params.ts`의 `EVENT_TYPES`와 `presentEvent` |
     | `docs/api/openapi.yaml` | `JobStatus`·`EventType` enum, `Job`·`Event` 스키마, 새 endpoint, 오류 `type`(결정 7·9) |
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
   - 감사는 상태 변경과 같은 트랜잭션에 쓴다. 상태를 바꾼 요청만 기록한다. `changed: false`인 멱등 재요청과 401·403 시도는 기록하지 않는다.
   - 호출처가 키로 직접 취소한 것은 감사 대상이 아니다. 관리 작업이 아니고 작업 행의 `failure_reason`과 `JOB_CANCELED` 이벤트가 남는다.
   - 읽기: `GET /ops/audit?limit=<1~200, 기본 50>&before=<id>`(읽기 토큰). 최근 순서다. 응답은 `{ entries, nextBefore }`다.
   - 로그: 관리 작업마다 `ops_pause_set`, `ops_pause_cleared`, `ops_job_canceled`(info)를 남긴다. 필드는 `actor`, `scope`(또는 `jobId`)뿐이다.
   - 보존: 자동 삭제를 두지 않는다. 행 수는 운영자 조작 건수라 작다고 추정한다(미측정). 늘어나면 삭제 정책을 새 결정으로 정한다.
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
   - 공통 응답은 JSON이다. 오류는 `application/problem+json`이다(기존 형식). 새 오류 `type`은 `forbidden`(403), `job-not-cancelable`(409), `cursor-expired`(410, 결정 9)이다. 오류 본문에 요청 값을 넣지 않는다.
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
   - 필드: 도메인 문자열 배열이다. 소문자 ASCII 도메인(기존 `checkAddress`의 도메인 라벨 규칙), 1~50개다. 생략하면 제한이 없다. 빈 배열은 기동을 거부한다(`sendQuota24h`의 0 금지와 같은 이유로, 모두 거부하려면 정지나 키 폐기를 쓴다).
   - 판정: `to`·`cc`·`bcc`의 모든 주소에서 `@` 뒤를 소문자로 바꿔 목록과 정확히 비교한다. 하위 도메인은 따로 적는다. 와일드카드는 없다. `replyTo`는 수신자가 아니라 제한하지 않는다.
   - 하나라도 어기면 요청 전체를 거부한다. REST는 400 `validation-failed`이고 `errors`에 어긴 주소의 위치(`/to/0`, `/cc/1` 등)와 `code: RECIPIENT_DOMAIN_NOT_ALLOWED`를 넣는다. 주소와 도메인 값은 응답·로그에 넣지 않는다(RQ-027). 파일 채널은 `VALIDATION_FAILED` 수집 거부다. 사유 코드를 새로 만들지 않는다.
   - 검사 위치와 순서는 `allowedFrom`과 같다. 새 작업이 될 때만 거부하고, 이미 등록된 Key의 재전송은 기존 작업(200)이나 409를 그대로 돌려준다(`denyNew`). 수신자는 평문 필드라 평문·암호화 모드 모두 같게 적용한다(RQ-022).
   - 지문 범위에 넣지 않는다. 요청 내용이 아니라 호출처 정책이다.
   - 레지스트리는 기동 때 한 번 읽는다. 변경은 재시작 뒤 반영된다(RQ-032 한계와 같다). 마이그레이션은 없다.
   - 한계: 허용 도메인 안의 대량 발송은 막지 못한다. 도메인의 MX 등 실제 수신 가능 여부는 보지 않는다.
   - 기존 관계: RQ-028의 레지스트리 항목에 필드를 더한다. ADR-0008 구현 중 확정 12의 `allowedFrom`과 대칭이다. ADR-0006 결정 3의 거부 사유 `VALIDATION_FAILED`를 그대로 쓴다.

9. **이벤트 피드는 cursor가 보존 범위 밖일 수 있으면 410으로 알린다. 판정은 호출처별 삭제 표지로 한다.**
   - 문제: 30일 넘게 폴링을 멈춘 호출처는 그 사이 삭제된 이벤트를 알지 못한다(ADR-0006 "결과").
   - cursor만으로는 판정할 수 없다. cursor는 `(txid, id)`뿐이고 시각이 없다. 이벤트 행은 삭제되면 사라져서 cursor가 가리키는 행의 시각을 읽을 수 없다. 남은 가장 오래된 이벤트와 비교하는 방식은 이벤트가 드문 호출처에서 정상 cursor를 만료로 오판한다(cursor는 마지막으로 받은 이벤트 위치에 머문다).
   - 삭제 표지 테이블 `mail_event_purges(caller_id PK, purged_txid xid8, purged_id bigint, updated_at)`를 둔다. 호출처별로 삭제된 이벤트 중 `(txid, id)` 순서가 가장 큰 위치를 담는다.
   - 기록: `deleteExpiredRecords`가 작업·거부 기록을 지우는 같은 트랜잭션에서, 지울 대상의 이벤트 중 호출처별 최대 `(txid, id)`를 구해 표지에 올린다. 표지는 줄어들지 않는다(`ON CONFLICT ... DO UPDATE ... WHERE 기존 < 새 값`).
   - 판정: `after`가 있을 때만 검사한다. 호출처의 표지가 cursor보다 크면(`(purged_txid, purged_id) > (cursor.txid, cursor.id)`) 410이다. `listEvents`와 같은 튜플 비교다.
     - 삭제된 이벤트가 모두 cursor 이하이면 호출처는 이미 그것들을 지나왔다. 이 경우는 410이 아니다(누락이 없다).
     - 표지가 cursor보다 크면 cursor 뒤에서 삭제된 이벤트가 있다. 누락이다.
   - 응답: 410, `type`은 `cursor-expired`다. 본문은 고정 문구이고 요청 값을 넣지 않는다. 호출처는 `after` 없이 다시 읽어 남은 이벤트부터 받고, 아직 종결되지 않은 outbox 행은 `GET /jobs?idempotencyKey=`로 확인한다. 30일이 지나 404인 Key는 호출처가 정한다.
   - 로그: `event_cursor_expired`(warn)에 `callerId`만 담는다.
   - cursor 형식과 반환 조건은 바꾸지 않는다(ADR-0006 결정 7).
   - 판정 방향: 누락이 없는데 410을 내는 오탐은 있을 수 있다. 호출처가 `type` 필터로 읽을 때 다른 종류의 삭제된 이벤트가 표지를 올린 경우다. 누락이 있는데 410을 내지 않는 미탐은 이 방식에서 생기지 않는다(삭제된 이벤트가 모두 표지 이하이기 때문이다). 단 아래 한계 세 가지는 예외다.
   - 한계:
     - 이 변경 전에 이미 삭제된 이벤트는 표지에 없다. 마이그레이션 전 삭제분은 판정하지 못한다.
     - `after` 없이 읽는 호출처(이벤트를 한 번도 받지 못해 cursor가 `null`인 호출처)는 판정하지 못한다.
     - 롤링 중 구버전 인스턴스가 지운 이벤트는 표지에 오르지 않는다.
   - 검사 비용은 호출처 키 기본키 조회 한 번이다. 측정하지 않았다.
   - 근거: 호출처는 이벤트를 놓쳤다는 사실을 알아야 outbox 행이 영원히 종결되지 않는 것을 막을 수 있다.
   - 기존 관계: ADR-0006 결정 8의 30일 보존과 결정 7의 cursor는 그대로다. "호출처가 30일 넘게 폴링하지 않으면 놓칠 수 있다"는 한계를 부분적으로 해소한다(위 한계 제외).

10. **배포와 롤백은 마이그레이션 → 모든 인스턴스 교체 → 기능 켜기 순서이고, 마이그레이션은 되돌리지 않는다.**
    - 마이그레이션은 새 파일로 추가한다(`apps/mailo/migrations/`). 적용된 파일은 수정하지 않는다.
      - `0006_job_canceled.sql`: `mail_jobs_status_check`, `mail_jobs_terminal_state`, `mail_events_type_check`를 `NOT VALID`로 교체한다. 각 `DROP CONSTRAINT` 뒤 같은 이름으로 `ADD CONSTRAINT ... NOT VALID`다. 세 문장 모두 한 트랜잭션이다.
      - `0007_ops_controls.sql`: `mail_send_controls`, `mail_ops_audit`를 만든다.
      - `0008_event_purges.sql`: `mail_event_purges`를 만든다.
    - 교체는 `0003`·`0004`의 `NOT VALID` 방식을 따른다. 기존 행은 모두 새 조건을 만족하므로 `VALIDATE CONSTRAINT`를 하지 않는다. 새 조건은 옛 조건에 `CANCELED`·`JOB_CANCELED`를 더한 것이다. 임시 schema에서 확인한 내용은 다음과 같다. `CANCELED` + `finished_at` 있음은 통과하고 `CANCELED` + `finished_at` 없음은 `mail_jobs_terminal_state`로 거부됐다. `JOB_CANCELED` 이벤트 삽입이 통과했다. 정지·감사 테이블의 `CHECK`가 의도한 조합만 받았다. 표지 갱신 쿼리의 튜플 비교가 의도대로 동작했다.
    - `ALTER TABLE`은 `mail_jobs`·`mail_events`에 짧게 `ACCESS EXCLUSIVE`를 잡는다. 마이그레이션 CLI는 `lock_timeout`을 걸어 실행한다(AGENTS.md). 점유 쿼리는 짧아 대기가 길지 않을 것으로 추정한다. 측정하지 않았다.
    - 배포 순서:
      1. 선행 조건(아래 "구현 순서")이 끝나 있어야 한다.
      2. 마이그레이션 `0006`~`0008`을 적용한다. 구버전은 새 테이블과 새 상태 허용을 쓰지 않으므로 영향이 없다.
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

이 ADR이 승인된 뒤의 순서다. 단계마다 관련 문서를 같은 변경에서 갱신한다(AGENTS.md "문서와 요구사항 갱신").

1. **선행 조건: 취소 전에 호출처와 샘플이 모르는 값을 처리하게 한다.** 이 단계가 끝나기 전에는 취소 기능을 배포 대상에 넣지 않는다. 운영자 취소(`/ops/jobs/{jobId}/cancel`)는 호출처가 바라지 않은 `CANCELED`를 만들 수 있으므로 관리 토큰 설정(배포 순서 4)을 이 단계 뒤로 미룬다.
   1. `docs/api/README.md`와 `docs/api/openapi.yaml`에 "모르는 이벤트 종류와 상태" 규칙을 쓴다. 규칙은 다음 두 가지다.
      - 모르는 이벤트 종류와 모르는 `Job.status`를 무시하거나 성공으로 처리하지 않는다.
      - 해당 작업을 종결되지 않은 상태로 방치하지 않는다. 작업 ID나 Key로 `GET /jobs`를 조회해 상태를 확인하고, 확인할 때까지 "확인 필요"로 표시해 알린다.
   2. `samples/spring-boot-relay/src/main/java/sample/relay/events/EventFeedPoller.java`의 `apply`: `default` 분기의 경고만 하는 처리를 위 규칙대로 고친다. 모르는 종류를 `record`로 남기고 outbox 행이 있으면 "확인 필요"로 표시한다.
   3. `samples/spring-boot-relay/src/main/java/sample/relay/relay/RelayWorker.java`의 `statusAfterRegistered`: 모르는 상태를 `DELIVERED`로 처리하는 `default` 분기를 같은 규칙으로 고친다.
   4. `samples/spring-boot-relay/src/main/java/sample/relay/mailo/MailoClient.java`의 `getEvents`: 410을 `IOException`과 구분한다. 결정 9의 복구 절차를 따르게 한다.
   5. 샘플이 `JOB_CANCELED`와 `CANCELED`를 알게 하는 변경(종결 상태 추가)은 규칙을 먼저 넣은 뒤에 한다.
   6. 실제 호출처의 코드는 이 저장소에 없다. 호출처마다 같은 규칙 준수를 확인한다(확인하지 않았다).
2. 마이그레이션 `0006` + `queue`·`events` 타입에 `CANCELED`·`JOB_CANCELED`를 더한다. 읽기 모델과 presenters는 새 값을 처리하고, 호출처 취소 API와 이벤트를 구현한다.
3. 토큰 분리(`BearerResult`, 읽기·관리 가드, 기동 검사)와 `/ops` 읽기 endpoint.
4. `0007`, 정지 판정(`claim`의 두 경로), 정지·재개 REST, 감사 기록, 관리 취소.
5. `outcomeUncertain` 표시.
6. `allowedRecipientDomains`(레지스트리, REST·파일 검사).
7. `0008`, 삭제 표지 기록, `after` 검사와 410.
8. CLI 읽기 명령. 변경 명령은 3·4의 REST를 검증한 뒤 낸다.
9. 문서와 요구사항: 승인 뒤 RQ를 추가하고 `docs/operations/`의 `deployment.md`(변수·헬스·롤링 순서), `key-management.md`(관리 토큰), `caller-onboarding.md`, `troubleshooting.md`(로그 이벤트 이름 `send_paused`, `send_resumed`, `ops_pause_set`, `ops_pause_cleared`, `ops_job_canceled`, `event_cursor_expired`, `job_canceled`)를 고친다. 모듈 목록(`AGENTS.md`)에 `ops`를 더한다. `docker-compose.yml`과 `.env.example`에 새 변수를 더한다.

모듈 경계: 정지 테이블과 취소 SQL은 `mail_jobs`를 소유한 `queue`에 둔다. 감사 테이블과 REST는 새 모듈 `ops`가 소유한다. 삭제 표지 테이블은 `events`가 소유하고 `queue`의 보존 삭제가 `events`의 `index.ts`를 통해 부른다. 새 npm 의존성은 없다.

검증 계획(구현 때): 정지가 일반 점유와 대표 작업 점유를 모두 막는지, 호출처 정지가 다른 호출처를 막지 않는지, 취소와 `claim`의 경합, `CHECK` 교체 뒤 새 상태 허용과 옛 행 보존, 표지 판정의 누락·오탐 경계, 감사 기록에 자유 텍스트와 토큰이 없는지(canary 문자열 검색), 호출처 키로 `/ops`가 401인지, 읽기 토큰의 관리 endpoint가 403인지를 PostgreSQL 통합 테스트로 확인한다.

## 검토한 대안

| 결정 | 대안 | 채택하지 않은 이유 |
| ---- | ---- | ------------------ |
| 1 | 토큰 하나 유지, 경로로만 구분 | `/metrics`를 같은 토큰으로 열면 정지·취소 권한 토큰이 Prometheus 설정에 놓인다 |
| 1 | 토큰에 권한을 담는 서명 토큰(JWT) | 새 형식과 키 관리가 늘어난다. 운영 의존성을 늘리지 않는 원칙(RQ-029)과 맞지 않는다 |
| 1 | 관리 토큰 하나, 감사 이름은 고정값 | 누가 했는지 구분할 수 없다. 대안은 미결정 절의 질문이다 |
| 1 | 운영 REST 없이 DB에 직접 SQL | 권한 분리와 감사 기록이 없다. 운영자마다 DB 쓰기 계정이 필요하다 |
| 2 | 환경 변수 `MAILO_SEND_PAUSED` | 재시작이 필요하고 인스턴스마다 값이 어긋난다 |
| 2 | 차단기 행을 `open`으로 두고 `open_until`을 먼 시각으로 | 정지가 계정 장애로 보인다(공개 `/health/ready`의 `circuitBreaker.state`). `last_reason` 의미가 오염되고 만료 뒤 대표 작업 경로가 정지를 푼다 |
| 2 | 인스턴스를 내린다 | 등록과 조회까지 멈춘다. 호출처 relay가 503을 받는다 |
| 2 | 정지를 `/health/ready` 200/503에 반영 | RQ-031 결정과 충돌한다. 오탐이면 오케스트레이터가 정상 인스턴스를 재시작한다 |
| 3 | 레지스트리 `enabled: false` | 재시작이 필요하고 새 필드를 이전 버전이 거부한다. 빼는 방식과 달리 큐의 작업은 계속 발송된다 |
| 3 | 레지스트리에서 호출처를 뺀다 | 큐에 남은 작업이 계속 발송되고 호출처가 조회·이벤트를 읽지 못한다 |
| 3 | 호출처 정지 때 새 요청 등록도 거부 | 호출처 outbox가 쌓이고 오류 처리가 늘어난다. 새 요청 차단은 키 폐기가 맡는다 |
| 4 | `CANCELED` 대신 `FAILED`·`EXPIRED`에 사유를 두기 | 호출처가 실패와 취소를 구분하지 못한다. 이벤트 종류도 같아 재시도 판단이 섞인다 |
| 4 | `SENDING`도 취소 | 전송 중단은 결과 기록과 lease 계약(ADR-0002 결정 6, 9)을 바꾼다. SMTP 수락 여부가 더 불명해진다 |
| 4 | `DELETE /jobs/{jobId}` | 삭제처럼 보이지만 행·Key·이벤트는 남는다 |
| 4 | 취소 때 본문을 기존 유예 기간 동안 유지 | 나갈 수 없는 메일의 본문이 불필요하게 남는다 |
| 4 | 호출처 단위 일괄 취소 | 이번 범위에 포함하지 않는다. 필요하면 새 결정으로 정한다 |
| 5 | 운영자 재시도 API | 호출처가 Key로 매칭하지 못하고 본문이 지워졌으며 AAD 때문에 암호문을 복사하지 못한다 |
| 5 | `onUncertainOutcome`으로 지금 정책 변경 | 승인된 결정(ADR-0001 결정 5, ADR-0007 결정 3)을 바꾼다. 단계 10의 별도 ADR이 먼저다 |
| 6 | 운영자 사유를 자유 텍스트로 받기 | 로그와 응답에 요청 값이 들어갈 길이 된다(RQ-027). 주소·본문이 섞일 수 있다 |
| 6 | 감사를 로그에만 | 로그 보존이 인프라에 달려 있다. DB가 단일 출처다 |
| 7 | 운영 웹 UI | 로드맵이 보류했다. CLI와 REST로 시작한다 |
| 7 | CLI가 DB에 직접 접속 | 새 권한과 비밀이 필요하다. 권한 분리와 감사를 우회한다 |
| 8 | 와일드카드 `*.example.com` | 이번에는 정확한 일치만 둔다. 필요하면 하위 도메인을 따로 적는다 |
| 8 | 도메인 외 수신자 개별 목록 | 호출처가 수신자를 아는 업무가 아니면 관리 부담이 크다. 도메인이 단위다 |
| 8 | 등록 단계에 호출처별 한도와 429 | ADR-0005 결정 5, ADR-0007 결정 10이 등록 응답에 429를 쓰지 않기로 했다 |
| 9 | 이벤트가 있는 가장 오래된 위치와 cursor 비교 | 이벤트가 드문 호출처의 정상 cursor를 만료로 오판한다 |
| 9 | cursor에 발급 시각을 넣는다 | cursor 형식을 바꾼다. 옛 cursor에는 시각이 없어 판정하지 못한다. ADR-0006 결정 7을 바꾸는 새 결정이 필요하다 |
| 9 | 전역 삭제 표지 한 행 | 이벤트가 드문 호출처의 정상 cursor가 항상 표지보다 작아 410이 반복된다 |
| 9 | 보존 기간을 시각으로만 비교(`now() - 30일`) | cursor에서 시각을 알 수 없다 |
| 10 | 새 `CHECK`를 검증하며 추가(`VALIDATE`) | 전체 테이블 스캔이다. `0003`·`0004` 선례처럼 `NOT VALID`로 둔다 |

## 결과

- 운영자는 읽기 토큰(감시)과 관리 토큰(정지·취소)을 따로 쓴다. 관리 토큰마다 이름이 감사에 남는다.
- 발송 정지·재개와 호출처 정지가 재시작 없이 DB로 즉시 적용된다. 정지 응답 직후 이미 점유한 작업은 전송된다.
- 취소된 작업은 `CANCELED`와 `JOB_CANCELED`로 호출처에 알려진다. 호출처가 모르는 값을 처리하지 못하면 outbox 행이 종결되지 않는다. 선행 조건이 이를 막는다.
- 실패한 작업의 메일이 이미 나갔을 가능성을 `outcomeUncertain`으로 볼 수 있다. 재시도는 호출처가 새 Key로 한다. 중복 발송 위험은 호출처가 판단한다.
- 수신 도메인 허용 목록은 호출처 키 유출의 피해 범위를 도메인으로 줄인다. 허용 도메인 안의 대량 발송은 막지 못한다.
- 30일 넘게 폴링을 멈춘 호출처는 이벤트 공백을 410으로 안다. 이 변경 전 삭제분과 cursor가 없는 호출처는 제외다.
- 새 테이블이 3개, 새 상태 값 1개, 새 이벤트 종류 1개, 새 오류 `type` 3개, 새 환경 변수가 늘어난다. 새 npm 의존성과 새 상시 서비스는 없다(RQ-029).
- 롤백해도 마이그레이션과 `CANCELED` 행은 남는다. 정지를 먼저 풀지 않으면 롤백 뒤 발송이 재개된다.
- 이 ADR의 비용과 동작은 구현·측정하지 않았다. 정지 판정 쿼리, `ACCESS EXCLUSIVE` 대기, 표지 갱신의 비용이 해당한다.

## 미결정·확인하지 않은 것

- 코드로 확인하지 않은 것(결정 근거의 추정): 정지 응답 직후 점유 중인 작업의 최대 건수(인스턴스 수 × `MAILO_WORKER_CONCURRENCY`)는 코드 읽기에서 나온 상한이고 실행해 확인하지 않았다.
- 관리 토큰을 이름 목록 방식으로 정했다. 운영자가 1명이면 단일 토큰(`MAILO_OPS_ADMIN_TOKEN`)이 단순하다. 이름이 필요 없다고 판단하면 `actor`를 고정값으로 두는 대안으로 바꾼다. 사용자 판단이 필요하다.
- 호출처에 정지 사실을 알릴지 정하지 않았다. 이 ADR은 호출처 응답에 정지를 드러내지 않는다. 정지된 호출처의 작업은 `PENDING`으로 보이다가 `EXPIRED`가 된다.
- 호출처 단위 일괄 취소(정지한 호출처의 대기 작업 전체)는 범위에 넣지 않았다. 필요하면 새 결정이다.
- 감사 기록 보존 기간은 정하지 않았다(자동 삭제 없음).
- `allowedRecipientDomains`의 하위 도메인 규칙(정확 일치만)과 국제화 도메인(IDN)을 정하지 않았다. 기존 주소 검증은 ASCII 도메인 라벨만 받는다.
- 이벤트 피드 공백 감지의 한계: 마이그레이션 전 삭제분, `after` 없는 호출처, 롤링 중 구버전의 삭제, `type` 필터로 인한 오탐이 있다. 실제 30일 경과로 확인하지 않았다(DB 시각을 당겨 확인하는 테스트는 구현 때 한다).
- 롤링 배포(구·신 혼용)와 롤백을 실행하지 않았다. 구버전의 `CANCELED`·`JOB_CANCELED` 처리는 코드 읽기 결과다.
- 이 저장소 밖의 호출처가 모르는 상태·이벤트를 어떻게 처리하는지 확인하지 않았다. Java 샘플만 읽었다.
- CLI의 토큰 전달 방식(`MAILO_CLI_TOKEN_FILE`·`MAILO_CLI_TOKEN`)과 컨테이너 안 실행(`docker compose exec`)을 실행해 확인하지 않았다. 읽기 전용 루트 파일 시스템(AGENTS.md)에서 `node dist/cli.js`는 쓰기가 없다고 추정한다.
- 정지 판정(`claim`마다 쿼리 1회), `ALTER TABLE`의 `ACCESS EXCLUSIVE` 대기, 삭제 표지 갱신(1000건 배치)의 비용을 측정하지 않았다.
- `/metrics`(단계 8)의 권한은 읽기 토큰으로 정했으나 endpoint와 지표는 이 ADR의 범위가 아니다.
- 단계 7(다중 SMTP 계정)에서 `account` 범위 정지의 REST와 점유 판정을 정한다. 이 ADR은 스키마 키만 정했다.
