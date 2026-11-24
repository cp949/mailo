# 문제 해결

증상별로 무엇을 보고 어떻게 해석하는지 적는다. 로그 이벤트 이름, 응답 필드, 코드 값은 2026-11-23 코드와 `docs/api/openapi.yaml`에서 가져왔다.
표기: "추정"은 확인하지 않은 해석이다. 아래 SQL은 읽기 전용이며 실행해 결과를 확인하지 않았다(스키마와 대조했다).

## 결론

- 발송이 멈췄으면 먼저 발송 정지를 확인한다. 호출처 키로 `GET /health/ready`를 호출해 `sendPaused`를(`scope`가 `all`·`account`·`caller`), 운영자 토큰으로 `sendControls`를 본다("발송 정지").
- 정지가 아니면 인증된 `GET /health/ready`의 `circuitBreaker`를 본다. `open`·`half_open`이면 SMTP 계정 단위 장애다. 차단기가 `closed`인데 쌓이면 운영자 토큰(`MAILO_OPS_TOKEN` 또는 관리 토큰)으로 호출해 `queue.oldestDueAgeSeconds`와 `worker.lastPollAgeSeconds`를 본다(`deployment.md` "헬스"). 둘 다 크면 점유 루프가 멈춘 것이다.
- 차단기가 `closed`인데 작업이 쌓이면 호출처 할당(`caller_quota_exceeded`), lease 회수(`LEASE_EXPIRED`), DB 오류(`claim_failed`)를 순서대로 본다.
- 파일이 입력 폴더에서 사라지지 않으면 `file_poll` 로그의 `unreadable`을 본다. 권한 문제다.
- 파일 거부는 이벤트의 `reasonCode`로 원인을 고른다. 원본은 삭제되므로 호출처가 보유한 원본과 `fileName`·`sha256`을 대조한다.
- 피드 지연은 단독 장애 신호가 아니다. 새 이벤트가 없어도 `lagSeconds`가 커진다.
- Prometheus로 보는 경우 `/metrics`의 읽는 순서는 "지표 해석"이다. 전역 값은 `max`, counter는 `rate`로 읽는다.

## 먼저 볼 것

```sh
# 인증된 준비 상태. 차단기와 피드 지연을 함께 본다
curl -s -H "Authorization: Bearer $KEY" http://<host>:3000/health/ready
# 로그(컨테이너 표준 출력). 모든 로그는 한 줄 JSON이고 ts·instance·level·event가 앞에 온다(deployment.md "로그")
docker compose logs --since 1h mailo | grep -E '"level":"(warn|error)"'
```

```sql
-- 호출처별 작업 상태 분포
SELECT caller_id, status, count(*) FROM mail_jobs GROUP BY 1, 2 ORDER BY 1, 2;
-- 최근 24시간 시도 결과 분포
SELECT classification, counted, count(*) FROM mail_attempts
 WHERE finished_at > now() - interval '24 hours' GROUP BY 1, 2 ORDER BY 1, 2;
```

| 증상 | 먼저 볼 곳 |
| ---- | ---------- |
| 작업이 `PENDING`·`RETRY_WAIT`에 머문다 | 차단기, 호출처 할당, `claim_failed` |
| `URGENT`·`HIGH`가 늦게 나가거나 `LOW`가 만료된다 | "등급별 적체" |
| 작업이 예상보다 일찍 또는 늦게 `EXPIRED`가 된다, `ttlSeconds`가 400이다 | "만료 시각" |
| 호출처가 취소했는데 메일이 나갔다, 취소 요청이 409다 | "작업 취소" |
| 실패한 작업의 메일이 이미 나갔는지 모르겠다, `outcomeUncertain`이 `true`다 | "결과 불명 실패" |
| 작업이 `SENDING`에 오래 머문다 | lease 만료(`lease_recovered`, `LEASE_EXPIRED`), 프로세스 재시작 |
| `failureReason`이 `OUTCOME_UNKNOWN`이다, 같은 메일이 두 번 갔다 | "결과 불명 실패"의 `OUTCOME_UNKNOWN`, `LEASE_EXPIRED` 시도, `drain_timeout`, `lease_lost` |
| 입력 폴더의 파일이 남는다 | `file_poll`의 `unreadable`·`deleteFailed`, `file_inbox_missing` |
| 이벤트가 안 온다 | 작업 상태, 긴 트랜잭션, cursor 저장 |
| 호출처가 오래 폴링하지 않았다, `Mailo-Cursor-Gap` 헤더나 410이 온다 | "이벤트 피드 공백" |
| 이벤트의 `recipients`가 비어 있고 `recipientsRedacted`가 `true`다, 수신자가 비워지지 않는다 | "이벤트 수신자 비움" |
| 등록이 400 `RECIPIENT_DOMAIN_NOT_ALLOWED`다, 파일이 `VALIDATION_FAILED`로 거부된다 | "수신 도메인 거부" |
| 운영 CLI가 0이 아닌 코드로 끝난다 | "운영 CLI 종료 코드" |
| `/health/ready`가 503 | DB 연결(`readiness_check_failed`) |
| Prometheus 타깃이 `down`이다, `/metrics`가 401·403이다, 지표 값이 이상하다, `mailo_metrics_collect_ok`가 0이다 | "지표 해석" |
| 기동하지 않는다 | `key-management.md`의 오류 표, `deployment.md`의 제약 표, "만료 시각"의 기동 오류 |

## 전역 차단기가 open일 때

의미: SMTP 계정 단위 장애(연결·TLS·인증 실패, 한도 초과)로 모든 인스턴스의 작업 점유가 멈춘 상태다(ADR-0007 결정 5). 등록과 조회는 정상이다. `/health/ready`는 차단기가 `open`이어도 200이다.

확인:

- `GET /health/ready`(유효한 Bearer): `circuitBreaker.state`(`closed`, `open`, `half_open`, `unknown`), `openUntil`(`open`일 때만 값), `lastReason`. 인증 없이는 `state`만 나온다.
- 로그: `{"ts":…,"instance":…,"level":"warn","event":"breaker_not_closed","state":...,"reason":...,"openUntil":...,"waitSeconds":...}`. 계정 상태 오류 시도를 기록한 직후 차단기가 `closed`가 아닐 때 한 번 남는다. 연속 실패가 임계값(기본 3) 아래라 아직 `closed`이면 이 로그는 없다. `reason`은 `AUTH`, `TLS`, `CONNECTION`, `DAILY_LIMIT`, `RATE_LIMIT`, `OTHER`다.
- DB(읽기): `SELECT state, open_until, probe_until, consecutive_failures, wait_seconds, last_reason FROM mail_circuit_breaker;`
- 작업 쪽: `GET /jobs/{jobId}`의 `lastError.category`가 `ACCOUNT`이고 차단기를 연 시도는 `attempts`가 늘지 않는다. 차단기가 `closed`로 남은 계정 상태 오류(연속 실패가 임계값 아래이거나 일부 메시지에만 나는 `OTHER` 거부)는 작업별 오류라서 `attempts`가 늘고 일반 backoff로 재시도하며, 최대 시도(8)에 닿으면 `FAILED`(`MAX_ATTEMPTS_EXCEEDED`)다(ADR-0007 구현 중 확정 8).

상태 해석:

| 상태 | 의미 |
| ---- | ---- |
| `closed` | 정상 점유. 마지막 실패 사유는 숨긴다 |
| `open` | `openUntil`까지 점유 없음. 그 뒤 대표 작업 한 건만 점유(`half_open`) |
| `half_open` | 대표 작업 한 건이 진행 중. `openUntil`은 `null`. 대표 작업이 계정 오류 없이 끝나면 `closed`, 계정 오류로 끝나면 대기를 2배로 늘려 다시 `open`. 메시지 오류(5xx 수신자 거부 등)로 끝나도 `closed`로 돌아간다 |
| `unknown` | DB에 연결할 수 없어 읽지 못했다. 응답은 503 |

`lastReason`별 조치와 대기 시간(기본값, 설정으로 변경):

| `lastReason` | 원인 | 초기 open 대기 | 조치 |
| ------------ | ---- | -------------- | ---- |
| `AUTH_FAILED` | SMTP 인증 실패, 앱 비밀번호·구성 오류 | 60초 | `MAILO_SMTP_USER`·`MAILO_SMTP_PASSWORD`를 확인하고 바꾼 뒤 재시작한다. 같은 실패가 계속되면 대기가 2배씩 늘어 30분까지 간다 |
| `TLS_FAILED` | STARTTLS 협상·인증서 검증 실패 | 60초 | 포트와 `MAILO_SMTP_SECURITY`를 확인한다. 사설 CA는 `NODE_EXTRA_CA_CERTS`로 준다. 인증서 검증을 끄는 설정은 없다 |
| `CONNECTION_FAILED` | 연결 거부·DNS 실패·연결 시간 초과 | 60초 | 호스트 이름, 포트, 방화벽, 송신 IP 허용(릴레이)을 확인한다 |
| `QUOTA_DAILY` | 계정 일일 한도 초과(예 `550 5.4.5`) | 1시간 고정 | 한도는 24시간 rolling이라 일부씩 풀린다. 1시간 뒤 대표 작업으로 확인한다. 호출처 할당(`sendQuota24h`)으로 대량 발송 호출처를 제한한다 |
| `QUOTA_BURST` | 순간 한도(`421`·`450` 계열) | 5분(30분까지 2배) | 기다린다. 자주 나면 동시 전송 수(`MAILO_WORKER_CONCURRENCY`)와 발송량을 점검한다 |
| `OTHER` | 위에 속하지 않는 계정 상태 오류 | 60초 | `mail_attempts.response_text`·`response_code`·`enhanced_code`를 본다(응답 텍스트는 주소가 `[address]`로 가려지고 500자로 잘린다) |

- 수동으로 `closed`로 되돌리는 기능은 코드에 없다. 원인을 고치면 `open_until` 뒤 대표 작업이 성공하면서 `closed`로 돌아온다. `mail_circuit_breaker`를 직접 고치는 것은 지원하는 절차가 아니다.
- 차단이 길어지면 대기 중인 작업이 만료 시각(기본 24시간)에 이르러 `EXPIRED`가 되고 `JOB_EXPIRED` 이벤트가 나간다. `failureReason`은 `EXPIRED`, `lastError.category`는 `ACCOUNT`일 수 있다.
- 같은 작업이 차단기를 3번 연 뒤에도 같은 응답을 받으면 그 작업만 `FAILED`(`ACCOUNT_ERROR_REPEATED`)가 된다. 특정 메시지가 계정 오류처럼 보이는 응답(예 `550 5.7.1` 정책 거부)을 받는 경우를 의심한다. 한도 사유(`QUOTA_DAILY`·`QUOTA_BURST`)는 이 판정에서 뺀다. 한도가 몇 시간 이어져도 작업은 `FAILED`가 되지 않고 `RETRY_WAIT`로 남다가 만료 시각(기본 24시간)에 `EXPIRED`가 된다(ADR-0007 구현 중 확정 8).
- 인증 값을 확인하지 않고 재시작을 반복하지 않는다. 잘못된 인증을 반복하면 계정이 잠길 수 있다(추정, ADR-0007).

## lease 만료

의미: 점유한 인스턴스가 `lease_until`(기본 120초)까지 결과를 기록하지 못했다. 다른 인스턴스가 작업을 회수해 `LEASE_EXPIRED` 시도를 기록하고 다시 점유한다. 이 시도는 최대 시도 횟수에 포함된다.

확인:

| 신호 | 위치 | 의미 |
| ---- | ---- | ---- |
| `lease_recovered` (info, `count`) | 유지 루프 로그 | 이번 주기에 회수한 작업 수. 점유 경로(`claim`)가 먼저 회수하면 이 로그가 없다 |
| `LEASE_EXPIRED` | `mail_attempts.classification`, API의 `lastError.category` | 회수 기록. 시도 기록이 기준이다 |
| `lease_lost` (warn, `jobId`, `classification`) | Worker 로그 | 전송은 끝났지만 그 사이 lease가 회수돼 결과를 버렸다 |
| `send_aborted` (warn, `jobId`) | Worker 로그 | 종료 대기(drain) 시간 초과로 전송을 끊었다. 결과는 기록하지 않는다 |
| `drain_timeout` (warn, `inFlight`, `drainTimeoutMs`) | Worker 로그 | 종료 신호(`worker_paused`) 뒤 `lease − 10초` 안에 진행 중 전송이 끝나지 않았다. lease는 풀지 않고 회수에 맡긴다 |
| `complete_failed` (error, `jobId`, `attempt`, `retry`) | Worker 로그 | 전송 뒤 결과 기록이 DB 오류로 실패했다. lease 마감(점유 전 시각 + lease − 10초)까지 backoff(200ms에서 2배, 5초 상한)로 재시도하고, `retry`가 false이면 포기한 것이라 lease 회수가 이어받는다 |
| `pause_timeout` (warn, `drainTimeoutMs`) | Worker 로그 | 종료 신호 뒤 점유 호출이 drain 상한 안에 끝나지 않았다(DB 무응답). 기다리지 않고 종료를 계속한다 |
| `claim_after_drain_timeout` (warn, `count`) | Worker 로그 | drain 상한 뒤 늦게 돌아온 점유 결과를 처리하지 않았다. 그 작업은 lease 만료 뒤 회수된다 |

```sql
SELECT job_id, started_at, finished_at FROM mail_attempts
 WHERE classification = 'LEASE_EXPIRED' ORDER BY id DESC LIMIT 20;
```

원인과 조치:

- 프로세스가 죽었다(OOM, SIGKILL, 호스트 재시작). 재시작 이후 자동 복구된다. 반복되면 메모리 한도와 종료 로그를 본다.
- `stop_grace_period`가 lease보다 짧다. 재배포마다 진행 중 전송이 lease 회수 대상이 된다. `stop_grace_period`를 lease 이상으로 올린다(`deployment.md`).
- DB 지연으로 `complete_failed`가 반복된다. DB 상태와 풀 크기(`MAILO_DB_POOL_MAX`, 기동 때 `MAILO_WORKER_CONCURRENCY` + 4 이상으로 검사한다)를 본다. 오류가 `Query read timeout`이면 DB 응답이 `MAILO_DB_QUERY_TIMEOUT_MS`(기본 35초) 안에 오지 않은 것이다.
- 영향: SMTP 서버가 이미 수락한 메일이 재전송될 수 있다(RQ-013). 사용처는 같은 메일이 두 번 가는 것을 감수한다.
- 점유 후 복호화 실패 같은 Mailo 내부 오류는 lease 문제가 아니다. `job_internal_error`(error 수준, 필드 `jobId`, `error`, `attempt`)를 본다. 3번째 시도에서 `FAILED`가 된다. `error=BodyCipherError:UNKNOWN_KEY_VERSION`이면 DB 본문 키의 이전 버전이 없다(`key-management.md`).

## unreadable 파일

의미: Mailo가 읽기 권한이 없어 열지 못한 파일이다. 거부하지 않고 남겨 둔다. 권한 구성이 틀렸을 때 유효한 요청이 삭제되는 것을 막기 위해서다(ADR-0004 구현 중 확정 3).

신호: 폴링 요약 로그 `{"ts":…,"instance":…,"level":"info","event":"file_poll","callerId":...,"registered":...,"unreadable":N,...}`의 `unreadable`이 0보다 크다. 요약은 폴링에서 처리·정리·오류가 있었을 때만 남는다.

원인과 조치:

| 원인 | 조치 |
| ---- | ---- |
| 호출처가 파일을 mode `0600`으로 만들었다(`mkstemp`류, Java `createTempFile`) | 호출처가 `rename` 전에 `0660`으로 `chmod`한다. 이미 남은 파일은 소유자나 root가 `chmod 0660`하면 다음 폴링에서 수집된다(e2e로 확인) |
| 공용 그룹 + setgid 방식에서 호출처 umask가 `077` | 호출처 umask를 `027` 이하로 고정하거나 default ACL 방식으로 바꾼다 |
| default ACL이 폴더에 없다(재생성, 복원, 다른 파일시스템) | `getfacl <폴더>`로 default ACL을 확인하고 `scripts/volume/init-volume.sh`나 `nfs.md`의 `setfacl`로 다시 만든다. 기존 파일에는 소급되지 않는다 |
| NFSv4.1 클라이언트가 만든 파일 + umask 077 | 호출처 호스트를 `vers=4.2`로 mount한다(`nfs.md`) |
| Mailo UID가 ACL의 사용자와 다르다 | 폴더 ACL의 `user:<Mailo UID>`를 실제 Mailo UID(컨테이너 `user`)와 맞춘다 |

- 읽지 못하는 파일은 배치 슬롯을 쓰지 않는다. 한 폴링은 이름을 `batchPerCaller`의 100배(최대 100000)까지 모아 순회하므로 읽지 못하는 파일 뒤의 정상 파일도 처리된다. 읽지 못하는 파일이 이 한도(기본 10000개)를 넘으면 한도 밖 파일은 처리되지 않으므로 원인을 고친다. 폴링마다 읽지 못하는 파일을 다시 열어 보는 비용이 든다. 다른 호출처에는 영향이 없다(ADR-0004 구현 중 확정 8, 29).
- 삭제하지 못한 파일은 `file_delete_failed`(`callerId`, `code`)와 요약의 `deleteFailed`로 보인다. 등록·거부는 이미 커밋됐고 파일이 남아 다시 수집돼도 같은 Key·같은 `(caller_id, 파일 이름, sha256)`로 걸러진다. 폴더 쓰기 권한(Mailo 소유 폴더인지)을 확인한다.

파일 채널 관련 그 밖의 로그:

| 이벤트 | 수준 | 의미 |
| ------ | ---- | ---- |
| `file_channel_started` / `file_channel_stopped` | info | 폴러 시작·정지. 시작에 `callers`, `pollIntervalMs`, `batchPerCaller` |
| `file_channel_no_callers` | warn | `fileChannel: true`인 호출처가 없다 |
| `file_channel_disabled` | warn | 호출처에 `fileChannel: true`가 있는데 `MAILO_FILE_CHANNEL_ROOT`가 없다(`callers` 수) |
| `file_inbox_missing` / `file_inbox_found` | warn / info | 호출처 폴더가 없다(`code`: `ENOENT`·`ENOTDIR`) / 다시 생겼다. 폴더를 만드는 것은 운영자의 몫이다. 호출처당 한 번만 남는다 |
| `file_inbox_stale` | warn | NFS `ESTALE`로 이번 폴링에서 호출처를 건너뛰었다. 다음 간격에 다시 본다 |
| `file_dir_unsafe` / `file_dir_safe` | warn / info | `<root>`·`inbox`·호출처 폴더가 심볼릭 링크이거나 디렉터리가 아니라서 그 폴링에서 읽지 않는다(`dir`: `root`·`inbox`·`callerInbox`, `why`: `SYMLINK`·`NOT_DIRECTORY`·`ACCESS`). `ACCESS`는 경로를 통과할 권한이 없어 `lstat`이 `EACCES`·`EPERM`이라 종류를 확인하지 못한 경우다(NFS에서 속성 캐시 만료 직후 일시적으로 나온 적이 있다). 호출처 폴더는 `errors`로 세고 `<root>`·`inbox`는 폴링 전체를 건너뛴다 / 복구됐다. 상태가 바뀔 때 한 번만 남는다. 링크를 지우고 실제 디렉터리를 둔다. `ACCESS`가 한 번 나오고 `file_dir_safe`가 뒤따르면 일시적이다. 계속되면 Mailo 실행 계정의 `<root>`(`0755`)·`inbox`(`0711`) 통과 권한과 mount 상태를 확인한다(`namei -l <경로>`) |
| `file_channel_dir_permissive` | warn | 폴더 권한이 넓다(`o+w`, `<root>`·`inbox`는 `g+w`도). `mode`는 8진수. 수집은 막지 않는다. 폴더당 한 번 남는다. 호출처 폴더의 `g+w`는 default ACL 마스크 때문에 정상이라 경고하지 않는다 |
| `file_rejected` | info | 수집 거부 기록. `callerId`, `reasonCode`, `rejectionId`, `sizeBytes`, `sha256`(본문·파일 이름 없음). 파일 이름은 호출처가 정하므로 로그에 남기지 않는다. `rejectionId`로 `mail_intake_rejections.id`나 이벤트 피드의 `INTAKE_REJECTED`(`fileName` 포함)를 찾는다 |
| `file_temp_delete_failed` | warn | 오래된 임시 파일 삭제 실패(`error`) |
| `file_ingest_failed` | error | 한 파일 처리 중 오류(DB 오류 등, `error`). 같은 폴링에서 3번 연속이면 그 폴링을 접는다 |
| `file_nlink_zero_repeated` | warn | 같은 파일이 연속 3번 폴링에서 열린 뒤 `st_nlink`가 0이라 건너뛰어졌다(경로당 한 번). 다른 인스턴스와의 삭제 경쟁이면 다음 폴링에 파일이 없으므로 연속으로 나오지 않는다. 일부 FUSE·SMB가 살아 있는 파일의 `st_nlink`를 0으로 보고하면 이 파일은 영구히 수집되지 않는다. `stat -c %h <파일>`로 확인하고, 0이면 파일시스템 설정(마운트 옵션)을 바꾸거나 NFS·로컬 볼륨을 쓴다. 요약 `file_poll`의 `nlinkZero`가 매 폴링 0보다 크면 같은 증상이다 |
| `file_poll_failed`, `file_poll_crashed` | error | 폴링 단위 실패. 다음 간격에 다시 시도한다. `file_poll_failed`는 한 호출처의 폴더 목록을 읽지 못한 경우(권한 등)이고 다른 호출처 처리는 계속한다 |

요약 `file_poll`의 필드: `registered`, `duplicates`, `rejected`, `rejectedRepeats`, `gone`, `nlinkZero`, `unreadable`, `deleteFailed`, `tempDeleted`, `badNames`, `errors`, `capped`, `inboxMissing`. `capped`가 `true`면 배치 상한에 걸려 폴더에 처리하지 못한 파일이 남았을 수 있다. `badNames`는 UTF-8로 읽을 수 없는 이름의 파일 수다(수집하지 않는다).

## 수집 거부 사유 코드별 조치

거부된 파일은 원본이 삭제되고 `mail_intake_rejections`에 기록되며 호출처 이벤트 피드에 `INTAKE_REJECTED`가 나간다. 운영자는 원본을 볼 수 없다. `fileName`, `fileSize`, `sha256`을 호출처가 가진 원본과 대조한다.

```sql
SELECT id, caller_id, file_name, size_bytes, reason_code, created_at
  FROM mail_intake_rejections ORDER BY id DESC LIMIT 20;
```

| `reasonCode` | 원인 | 호출처 조치 |
| ------------ | ---- | ----------- |
| `MALFORMED` | JSON 구문 오류, JWS 구조 오류(필드·base64url·protected header 형식), `iat` 누락·비숫자. 심볼릭 링크·FIFO·하드링크 같은 일반 파일이 아닌 항목도 이 값이다. `rename` 뒤 덧쓴 부분 JSON도 해당한다 | 파일 형식을 고친다. 링크를 만들지 않는다. `rename` 뒤 덧쓰지 않는다 |
| `SIZE_EXCEEDED` | 원시 바이트가 상한(기본 2 MiB, `MAILO_FILE_MAX_BYTES`)을 넘었다. 이 기록의 `sha256`은 앞 `상한 + 1`바이트의 해시다 | 본문을 줄인다. JWS·JWE는 base64로 약 1.8배가 된다 |
| `SIGNATURE_INVALID` | `required`인데 서명이 없거나, `kid`·키가 맞지 않거나, `alg`가 `HS256`이 아니다(`none` 포함). 다른 호출처 키로 서명해도 같다 | `kid`가 `callers.json`의 `signature.keys`에 있는지, 호출처와 Mailo의 비밀키가 같은지 확인한다 |
| `DECRYPTION_FAILED` | JWE 복호화 실패, 알 수 없는 `kid`(코드는 `KID_UNKNOWN`이지만 이 값으로 합쳐 기록한다), `alg`·`enc` 불일치, 헤더·암호문 변조 | Mailo가 준 공개키·`kid`를 쓰는지 본다. 운영자는 `MAILO_ENVELOPE_KEYS_FILE`에 그 `kid`가 있는지 본다 |
| `IDEMPOTENCY_KEY_MISSING` | 파일에 `idempotencyKey`가 없다 | 필드를 넣는다 |
| `IDEMPOTENCY_KEY_INVALID` | Key가 1~128자, `[A-Za-z0-9._:-]` 형식이 아니다 | 형식에 맞는 Key를 쓴다 |
| `FINGERPRINT_MISMATCH` | 같은 `(호출처, Key)`가 이미 있는데 내용이 다르다 | Key를 재사용하는 호출처 버그다. 요청 단위로 고유한 Key를 쓴다. 이미 등록된 작업은 그대로다 |
| `VALIDATION_FAILED` | 허용 발신 주소가 아닌 `from`(`allowedFrom`·기본 발신 주소 확인), 수신자 형식·수, 제목 길이·CR/LF, 본문 크기, 정의되지 않은 필드, `ttlSeconds` 형식·범위, `version`이 1이 아님, `to` 없음, 평문과 `content` 혼용, 복호화한 제목·본문 검증 실패 | 파일을 계약(`docs/api/openapi.yaml`의 `SendRequest`)에 맞춘다. 위치는 이벤트에 없으므로 호출처가 필드를 점검한다 |
| `ATTACHMENTS_NOT_SUPPORTED` | `attachments` 필드가 있다 | 첨부는 지원하지 않는다. 필드를 뺀다 |
| `CALLER_MISMATCH` | JWS·JWE의 `caller`가 폴더 이름(`caller_id`)과 다르다 | `caller`를 호출처 `id`로 맞춘다. 파일을 다른 호출처 폴더에 넣지 않았는지도 본다 |
| `IAT_OUT_OF_RANGE` | JWS `iat`가 허용 기간(기본 7일)보다 오래됐거나 허용 오차(기본 5분)를 넘어 미래다 | 호출처 호스트 시계를 NTP로 맞춘다. 파일을 새로 서명해 다시 넣는다 |

- 고친 파일을 같은 이름으로 다시 넣어도 내용이 다르면 `sha256`이 달라 새 기록이 생긴다. 같은 이름·같은 내용을 다시 넣으면 새 거부 기록과 이벤트가 생기지 않고 원본만 삭제된다. 고치지 않은 같은 파일을 재투입하지 않는다.
- `idempotencyKey`는 파싱할 수 있고 형식을 지킨 경우에만 이벤트에 들어간다. 서명이 `required`인 호출처에서 서명을 확인하지 못한 파일은 Key 없이(`null`) 나온다. `fileName`으로 찾는다.

REST의 400 `validation-failed`는 `errors[]`에 `pointer`(또는 `parameter`)와 `code`를 준다. 코드: `REQUIRED`, `INVALID_FORMAT`, `TOO_LONG`, `TOO_MANY`, `TOO_LARGE`(복호화 뒤 1 MiB 초과), `CONTROL_CHARACTER`(제목·주소의 CR/LF), `UNKNOWN_FIELD`(`pointer`는 빈 문자열), `ATTACHMENTS_NOT_SUPPORTED`, `CONFLICTING_FIELDS`, `DECRYPTION_FAILED`, `KID_UNKNOWN`, `CALLER_MISMATCH`, `FROM_NOT_ALLOWED`(`pointer`는 `/from`, 요청의 `from`이 호출처의 허용 발신 주소가 아니다. `callers.json`의 `allowedFrom`을 확인한다), `RECIPIENT_DOMAIN_NOT_ALLOWED`(`pointer`는 `/to/0`·`/cc/1`·`/bcc/0`, 수신 도메인 허용 목록 위반. "수신 도메인 거부"), `OUT_OF_RANGE`(`pointer`는 `/ttlSeconds`, "만료 시각"). 복호화 관련 코드의 위치는 `/content`다. 409는 거부 기록이 아니라 응답이며 본문의 `jobId`가 먼저 등록된 작업이다.

## 피드 지연 해석

`/health/ready`의 `eventFeed`(인증된 호출처 자신의 값):

- `latestEventAt`: `GET /events`가 반환할 수 있는 최신 이벤트의 시각. 이벤트가 없으면 `null`.
- `lagSeconds`: 서버 현재 시각 − `latestEventAt`(초). 이벤트가 없으면 `null`.
- 새 이벤트가 없어도 `lagSeconds`는 커진다. 지연이 크다는 사실만으로 장애라고 판단하지 않는다.

판정 순서:

1. 호출처의 최근 작업을 `GET /jobs?idempotencyKey=`로 본다. 상태가 `PENDING`·`RETRY_WAIT`·`SENDING`이면 아직 종결 전이므로 이벤트가 없는 것이 정상이다. 원인은 발송 쪽(차단기, 호출처 할당, lease)이다.
2. 상태가 이미 `SENT`·`FAILED`·`EXPIRED`인데 이벤트가 안 보이면 피드가 지연된 것이다. 피드는 `txid`가 `pg_snapshot_xmin(pg_current_snapshot())`보다 작은 이벤트만 반환한다. DB 어디서든 열린 긴 트랜잭션이 있으면 그 트랜잭션이 끝날 때까지 새 이벤트가 숨는다. 이벤트는 유실되지 않는다(ADR-0006 결정 7).
3. 긴 트랜잭션을 찾는다.

```sql
SELECT pid, datname, usename, state, backend_xid, xact_start, now() - xact_start AS age
  FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY xact_start LIMIT 5;   -- backend_xid가 있는 세션이 피드를 붙잡는다
SELECT gid, prepared FROM pg_prepared_xacts;   -- 끝나지 않은 prepared transaction
```

- `idle in transaction`으로 오래 열린 쓰기 트랜잭션, 끝나지 않은 prepared transaction이 원인이 된다. 피드는 트랜잭션 ID를 받은 트랜잭션만 기다린다. 읽기 전용 트랜잭션(`pg_dump`가 쓰는 `REPEATABLE READ`·`READ ONLY` 포함)은 트랜잭션 ID가 없어 피드를 지연시키지 않았다(2026-11-23 PostgreSQL 17에서 읽기 전용 트랜잭션을 연 채 새 이벤트의 가시성을 확인했고, 쓰기 트랜잭션을 연 채일 때만 `pg_snapshot_xmin`이 그 ID에 묶였다. 실제 `pg_dump`는 실행하지 않았다). `pg_stat_activity`의 `backend_xid`가 있는 세션을 찾는다. 원인 세션을 끝내거나 작업이 끝나기를 기다린다.
- 호출처 쪽 원인도 본다. cursor를 저장하지 않아 같은 구간을 다시 읽거나, `type` 필터를 바꾸면서 같은 cursor를 쓰면 이벤트를 놓친 것처럼 보인다(cursor는 필터마다 따로 저장한다).
- 호출처가 30일 넘게 폴링하지 않으면 그 사이 이벤트가 삭제됐다. 이 경우는 작업 상태 조회로 보완한다(Key 보존도 종결 후 30일이다). 삭제는 아래 "이벤트 피드 공백"의 신호로 알려진다.

## 이벤트 피드 공백

근거: RQ-045, ADR-0011 결정 9.

신호: `GET /events`가 `after` 뒤에서 삭제된 이벤트를 발견하면 `event_cursor_gap`(warn, `callerId`만)이 응답마다 한 줄 남고, 응답은 헤더 `Mailo-Cursor-Gap: true`(200) 또는 `onGap=error` 요청에 410(`cursor-expired`)이다. 같은 호출처가 같은 cursor로 반복 폴링하면 줄이 반복된다. cursor 값은 로그에 없다.

1. 호출처 ID로 마지막 폴링 시각을 확인한다. 30일 넘게 멈췄다면 정상적인 신호다. 호출처가 `GET /jobs?idempotencyKey=`로 종결되지 않은 outbox 행을 확인하도록 안내한다(`caller-onboarding.md` "공백 신호").
2. 호출처가 계속 헤더를 받는다면 cursor가 삭제 지점을 아직 넘지 못한 것이다. `nextCursor`로 이어 읽으면 사라진다. 이어 읽지 않고 같은 `after`를 반복하면 계속 난다.
3. 표지는 DB `mail_event_purges`에 있다. 호출처·종류별로 삭제된 이벤트 중 가장 큰 위치(`purged_txid`, `purged_id`)다.

```sql
SELECT caller_id, type, purged_txid, purged_id, updated_at FROM mail_event_purges ORDER BY caller_id, type;
```

- 표지는 줄어들지 않고 행 수는 호출처 수 × 이벤트 종류 수(최대 5)가 상한이다. 삭제하지 않는다. 호출처를 레지스트리에서 뺀 뒤에도 남는다.
- 신호가 없다고 유실이 없는 것은 아니다. 공백 감지 도입(`0009`) 전 삭제분, `after` 없는 읽기, 롤링 중 구버전 인스턴스가 지운 이벤트는 표지에 없다. 헤더를 모르는 호출처는 신호를 받아도 알지 못한다.
- 오탐: 표지를 이벤트보다 먼저 읽으면 놓치므로 이벤트를 읽은 뒤 표지를 읽는다. 읽는 두 시점 사이에 삭제가 커밋되면 방금 읽은 이벤트가 삭제 직전 상태일 때도 신호가 난다(추론, 동시 실행으로 확인하지 않았다).

## 수신 도메인 거부

근거: RQ-046, ADR-0011 결정 8.

신호: REST는 400 `validation-failed`이고 `errors`에 `code: RECIPIENT_DOMAIN_NOT_ALLOWED`와 어긴 주소의 위치(`/to/0` 등)가 있다. 파일은 `VALIDATION_FAILED` 거부 기록이다. 로그·응답·거부 기록에 주소와 도메인 값은 없다.

1. 어느 호출처인지 본다(`http_request`의 `callerId`, 거부 기록의 `caller_id`).
2. 레지스트리 `callers.json`의 그 호출처 `allowedRecipientDomains`를 본다. 값이 없으면 이 코드가 나오지 않는다.
3. 호출처가 보내려던 도메인이 정당하면 소문자 ASCII 도메인(하위 도메인은 따로)으로 목록에 더하고 모든 인스턴스를 다시 시작한다. 레지스트리는 기동 때 한 번 읽는다. 주소를 서버에서 확인할 수 없으므로 호출처에게 어긴 위치(`/to/1` 등)로 찾게 한다.
4. 키 유출이나 스테이징 오설정으로 의도하지 않은 도메인이면 정상 동작이다. 요청은 등록되지 않았다.

- 이미 등록된 작업은 목록을 바꿔도 그대로 나간다. 이미 등록된 Key의 재전송은 목록과 무관하게 기존 작업(200)이나 409다.
- 수신자 하나라도 어기면 요청 전체가 거부된다. 나머지 수신자만 등록되지 않는다.
- 기동이 거부되면(`allowedRecipientDomains` 형식 오류) 오류 메시지의 `callers[i].allowedRecipientDomains[j]`와 사유(대문자, 비ASCII, 끝 점, 선행 점, 와일드카드, 중복, 도메인 형식)를 고친다. 값은 메시지에 없다. 이전 버전으로 롤백할 때는 이 필드를 먼저 빼야 한다.

## 운영 CLI 종료 코드

근거: RQ-047, ADR-0011 결정 7. 사용은 `deployment.md` "운영 CLI"다.

| 종료 코드 | 뜻 | 확인 |
| --------- | -- | ---- |
| 0 | 성공 | |
| 1 | 사용법·설정 오류 | 명령·옵션 이름, 변경 명령의 `--yes`, `MAILO_CLI_TOKEN_FILE`(읽지 못하면 errno 코드가 나온다)·`MAILO_CLI_TOKEN`, `MAILO_CLI_URL` 형식. 서버를 부르지 않았다 |
| 2 | HTTP 오류(또는 2xx인데 기대한 응답이 아님) | stderr의 `HTTP <상태>`. 401은 토큰 값·종류(호출처 키가 아닌지), 403은 읽기 토큰으로 변경 명령을 부른 경우, 404는 작업 ID, 409는 `job-not-cancelable`(`jobStatus`), 503은 DB·서버 상태. `queue stats`는 운영자 토큰이 아니면 `queue`가 없어 2다 |
| 3 | 연결 실패·시간 초과(15초) | stderr의 `ECONNREFUSED` 같은 errno 코드. `MAILO_CLI_URL`과 컨테이너 포트(3000), 서버 기동 여부 |

- CLI는 토큰·URL·요청 값을 오류 출력에 쓰지 않는다. 오류 본문은 서버 problem+json이다.

## 등급별 적체

우선순위(RQ-033·035)가 기대대로 동작하는지 볼 때 쓴다. 점유 규칙: claim 호출마다 `MAILO_CLAIM_FIFO_RATIO`(기본 0.1)의 확률로 가장 오래 기다린 순서, 나머지는 `URGENT` → `HIGH` → `NORMAL` → `LOW` 순서로 고른다. 같은 등급은 오래 기다린 순서다.

순서대로 본다.

1. 운영자 토큰 `GET /health/ready`의 `queue.dueCountByPriority`·`queue.oldestDueAgeSecondsByPriority`로 어느 등급이 쌓였는지 본다(`deployment.md` "헬스").
   ```sh
   curl -s -H "Authorization: Bearer $MAILO_OPS_TOKEN" http://<host>:3000/health/ready
   ```
2. 차단기 `circuitBreaker.state`를 본다. `open`이면 `URGENT`도 점유하지 않는다. `half_open`이면 대표 작업 1건만 점유한다("전역 차단기가 open일 때").
3. 쌓인 등급의 작업이 할당을 넘긴 호출처의 것인지 본다(`caller_quota_exceeded`, "호출처 할당 초과"). 할당은 모든 등급을 합산하므로 `URGENT`도 할당을 넘기면 점유하지 않는다.
4. 슬롯 사용을 본다. `worker.inFlight`가 `MAILO_WORKER_CONCURRENCY`와 같은 상태가 이어지면 빈 슬롯이 없어 `URGENT`도 기다린다. 진행 중 전송은 끊지 않는다. 슬롯이 비면 Worker가 polling 대기에서 일찍 깨어날 수 있다. 점유 시점은 빈 슬롯과 다음 점유 실행에 따라 달라지며, 폴링 간격은 고정 지연 하한이 아니다. Worker가 빈 슬롯은 있으나 할 일이 없어 대기 중이면 새 `URGENT`는 다음 polling까지 기다린다. 이 대기는 `MAILO_WORKER_POLL_MS`(기본 1000ms)에 ±10% jitter를 더한 값이다(`worker/worker.ts` `pollDelay`). claim이 연속 실패하면 대기가 `pollMs × 2^n`(n 최대 10)으로 늘어난다.
5. 재시도 대기를 본다. `next_attempt_at`이 미래인 작업은 등급과 무관하게 점유하지 않는다. 헬스 수치에도 세지 않는다.
6. 인덱스가 유효한지 본다. `INVALID`이거나 없으면 우선순위 점유와 등급별 헬스 수치가 순차 읽기로 느려진다(정합성 문제는 없다). 검토 측정(2026-11-23, 대기 30만 건)에서 우선순위 claim이 0.08ms → 170ms(Seq Scan, 디스크 정렬), 등급별 헬스가 4.6 → 58ms였다. 적체가 더 크면 운영자 헬스의 적체 문장이 문 시간제한(2초)에 걸려 503이 될 수 있다(추정, 측정하지 않았다).

```sql
-- 등급별 상태 분포(10 LOW, 20 NORMAL, 30 HIGH, 40 URGENT)
SELECT priority, status, count(*) FROM mail_jobs
 WHERE status IN ('PENDING', 'RETRY_WAIT', 'SENDING') GROUP BY 1, 2 ORDER BY 1 DESC, 2;
-- 등급별 재시도 대기(아직 점유 대상이 아닌 작업)
SELECT priority, count(*), min(next_attempt_at) FROM mail_jobs
 WHERE status IN ('PENDING', 'RETRY_WAIT') AND next_attempt_at > now() GROUP BY 1 ORDER BY 1 DESC;
-- 계정 점유 인덱스 유효성. valid가 false이거나 행이 없으면 아래 복구를 한다(ADR-0013, 0012·0013)
SELECT c.relname, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname IN ('mail_jobs_account_priority_claim_idx', 'mail_jobs_account_claim_idx');
```

해석:

- `LOW`의 `oldestDueAgeSeconds`만 커지는 것은 정상 동작이다. 대기 순서 경로가 처리량의 일부(claim 호출의 약 10%)만 오래된 작업에 준다.
- 굶음의 한계: 유입이 처리량보다 많은 상태가 이어지면 낮은 등급 작업은 만료 시각(기본 24시간, `MAILO_JOB_EXPIRY_SECONDS`, 요청 `ttlSeconds`가 있으면 그 값)을 넘겨 `EXPIRED`가 될 수 있다. 조치는 처리량을 늘리거나(`MAILO_WORKER_CONCURRENCY`), 호출처가 등급을 용도대로 쓰게 하거나(`caller-onboarding.md` "우선순위"), `MAILO_CLAIM_FIFO_RATIO`를 올리는 것이다. 값을 바꾸면 재시작이 필요하다.
- 모든 작업이 `URGENT`이면 등급 효과가 없다. Mailo에는 호출처별 등급 제한이 없다(RQ-033). 등급별 상태 분포를 호출처별로 나눠 보려면 위 첫 SQL에 `caller_id`를 더한다.

인덱스 복구. 마이그레이션 실행기는 `-- mailo:no-transaction` 파일을 실행한 뒤 현재 schema에 `INVALID` 인덱스가 있으면 기록하지 않고 실패한다(fail-closed, `src/db/migrator.ts`). 오류 메시지에 인덱스 이름이 있다. `IF NOT EXISTS`가 `INVALID` 인덱스를 건너뛰고 적용으로 기록되는 것을 막기 위해서다. 이 실패는 앱 기동 실패(`migrate-cli` 종료)로 보인다.

1. 오류 메시지의 인덱스를 지운다. 계정 인덱스는 `mail_jobs_account_priority_claim_idx`(0012), `mail_jobs_account_claim_idx`(0013), `mail_attempts_account_quota_idx`(0014)다.
   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS mail_jobs_account_priority_claim_idx;
   ```
2. `CONCURRENTLY`가 실패한 원인을 없앤다(잠금 대기 `55P03`이면 긴 트랜잭션을 확인한다).
3. 마이그레이션을 다시 실행한다(컨테이너 재시작 또는 `pnpm --filter @cp949/mailo migrate`). 해당 파일(`0012`~`0014`)이 다시 실행돼 기록된다. `0015`·`0016`(레거시 인덱스 삭제)은 그 뒤에 실행된다.

수동으로 만든 인덱스가 위 조회에서 `valid = false`이면 같은 방법으로 지우고 다시 만든다.

```sql
CREATE INDEX CONCURRENTLY mail_jobs_account_priority_claim_idx
  ON mail_jobs (account_id, priority DESC, next_attempt_at, id) WHERE status IN ('PENDING', 'RETRY_WAIT');
```

```txt
위험도: 중간 (인덱스 재생성. 쓰기는 막지 않지만 큰 테이블에서 오래 걸린다)
롤백: 불필요. 인덱스가 없는 동안 계정 점유와 적체 건수가 느려질 뿐 동작은 같다
```

## 이벤트 수신자 비움

근거: RQ-072, ADR-0015 결정 3. 이벤트 생성 후 `MAILO_RECIPIENT_RETENTION_SECONDS`(기본 7일)가 지나면 `JOB_*` 이벤트의 수신자와 시도 기록의 거부 수신자를 비운다. 이벤트 행은 지우지 않는다.

해석:

- 이벤트에 `recipientsRedacted: true`가 있고 `recipients`가 빈 목록이면 정상이다. 유예가 지난 이벤트다. 호출처는 `Idempotency-Key`로 자기 기록과 맞춘다(`caller-onboarding.md`). 비운 값은 복원하지 못한다.
- `GET /jobs`의 `rejectedRecipients`도 유예 뒤 빈 목록이다. 시도 기록에서 읽기 때문이다.
- 이벤트 ID·순서·cursor는 비움 전과 같다. `Mailo-Cursor-Gap`은 비움 때문에 나지 않는다.

비워지지 않을 때. 순서대로 본다.

1. 유예 설정을 본다. `MAILO_RECIPIENT_RETENTION_SECONDS`가 `MAILO_RECORD_RETENTION_SECONDS`와 같으면 비움이 삭제와 같은 시점이라 끈 것과 같다(`deployment.md` "보존").
2. `db-maintenance.md` 쿼리 5로 `redact_due`와 `oldest_unredacted_age`를 본다. 마이그레이션 직후 백필이면 `redact_due`가 사이클당 2만 건씩 줄어든다.
3. 로그 `recipients_redacted_failed`(error)의 `error`를 본다. `statement_timeout`이면 DB 부하나 락을 본다(`deployment.md` "DB 시간제한과 장애 동작").
4. 다른 인스턴스가 같은 단계를 돌고 있으면 이 인스턴스는 건너뛴다. 로그에 `count`가 없는 것이 정상이다.
5. 작업 행을 오래 잡은 세션이 있으면 그 작업의 이벤트는 건너뛴다. 다음 사이클이 이어받는다.
6. 인덱스를 본다. 없거나 `INVALID`이면 비움이 순차 읽기로 느려진다(정합성 문제는 없다).

```sql
-- 비움 인덱스 유효성. valid가 false이거나 행이 없으면 아래 복구를 한다(0018)
SELECT c.relname, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname = 'mail_events_recipients_redact_idx';
```

## 이벤트 수신자 비움 인덱스

마이그레이션 `0018`(`CREATE INDEX CONCURRENTLY`)이 실패하면 앱이 뜨지 않고 오류 메시지에 `mail_events_recipients_redact_idx`가 있다. 실행기가 `INVALID` 인덱스를 보고 기록하지 않고 실패한 것이다("등급별 적체"의 인덱스 복구와 같은 동작이다).

1. 인덱스를 지운다.
   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS mail_events_recipients_redact_idx;
   ```
2. `CONCURRENTLY`가 실패한 원인을 없앤다(잠금 대기 `55P03`이면 긴 트랜잭션을 확인한다).
3. 마이그레이션을 다시 실행한다(컨테이너 재시작 또는 `pnpm --filter @cp949/mailo migrate`). `0018`이 다시 실행돼 기록된다. `0017`(컬럼 추가)은 앞서 적용돼 있다.

```txt
위험도: 낮음 (인덱스 재생성. 쓰기를 막지 않는다)
롤백: 불필요. 인덱스가 없는 동안 수신자 비움이 느려질 뿐 동작은 같다
```

## 만료 시각

근거: RQ-008·039, ADR-0002 결정 7, ADR-0010.

만료 시각(`expires_at`, 조회 응답 `expiresAt`)은 등록 때 DB 시각 + TTL로 고정된다. TTL은 요청 `ttlSeconds`이고 생략하면 `MAILO_JOB_EXPIRY_SECONDS`다. 같은 Key 재요청은 만료 시각을 바꾸지 않는다.

```sql
-- 작업별 적용된 TTL(초)과 만료 시각. ttl이 기본 TTL과 다르면 요청이 ttlSeconds를 지정한 것이다
SELECT id, caller_id, idempotency_key, status, failure_reason,
       EXTRACT(EPOCH FROM expires_at - created_at)::int AS ttl, expires_at, finished_at
  FROM mail_jobs WHERE caller_id = $1 AND status = 'EXPIRED'
 ORDER BY finished_at DESC LIMIT 20;
```

해석:

- 만료 시각 이후에는 새 시도를 시작하지 않는다. `PENDING`·`RETRY_WAIT`는 주기 sweep(`MAILO_MAINTENANCE_INTERVAL_SECONDS`, 기본 60초)이 `EXPIRED`로 바꾼다. 그래서 `finished_at`은 만료 시각보다 늦다. 차이는 보통 sweep 주기 이내다(추정, 측정하지 않았다).
- 시도 결과를 기록할 때 다음 재시도 시각이 만료 시각보다 뒤이면 기다리지 않고 바로 `EXPIRED`다. 짧은 `ttlSeconds`(예: 60)는 첫 시도의 일시 오류 뒤 재시도 없이 `EXPIRED`가 되는 것이 정상이다.
- 전송 중(`SENDING`)에 만료 시각이 지나도 그 시도는 끝까지 간다. 만료 시각 뒤의 `SENT`는 정상이다.
- 차단기 `open`이 TTL보다 길면 그동안의 작업은 `EXPIRED`가 된다. 긴 `ttlSeconds`는 나중에 보내게 할 뿐 차단 시간을 줄이지 않는다(`caller-onboarding.md` "요청별 만료 시간").

`ttlSeconds` 400:

- `INVALID_FORMAT`: 정수가 아니다(소수, 문자열 `"600"`, `null`). 호출처가 숫자를 문자열로 직렬화했는지 본다.
- `OUT_OF_RANGE`: 60 미만이거나 상한 `MAILO_JOB_EXPIRY_MAX_SECONDS`를 넘었다. 응답에는 상한 값이 없다. 운영자가 설정 값을 확인한다. 상한을 설정하지 않았으면 상한은 `MAILO_JOB_EXPIRY_SECONDS`와 같다.
- 롤링 배포 중 이전 버전 인스턴스가 받으면 `UNKNOWN_FIELD`(`pointer` 빈 문자열)다(`deployment.md` "요청별 만료 시간 도입 배포 순서").

기동 오류:

| 메시지 | 원인 | 조치 |
| ------ | ---- | ---- |
| `MAILO_RECORD_RETENTION_SECONDS는 MAILO_JOB_EXPIRY_MAX_SECONDS 이상이어야 한다(생략하면 MAILO_JOB_EXPIRY_SECONDS와 같다)` | 기록 보존이 요청 TTL 상한보다 짧다. 상한을 설정하지 않았으면 기본 TTL보다 짧다 | 보존 기간을 늘리거나 상한(또는 기본 TTL)을 줄인다 |
| `MAILO_JOB_EXPIRY_SECONDS는 MAILO_JOB_EXPIRY_MAX_SECONDS 이하여야 한다` | 기본 TTL이 상한보다 크다 | 상한을 기본 TTL 이상으로 올리거나 상한 변수를 지운다 |
| `MAILO_JOB_EXPIRY_MAX_SECONDS은 1 이상 31536000 이하의 정수여야 한다` | 범위 밖이거나 정수가 아니다 | 정수 초로 적는다 |

## 발송 정지

근거: RQ-043·044, ADR-0011 결정 2·3·6.

신호: 운영자가 정지하면 `ops_pause_set`(info, `actor`, `scope`, 호출처 정지면 `callerId`), Worker가 정지를 처음 관찰할 때 `send_paused`(warn, `scope`, `callerId`)가 한 번 남는다. 해제하면 `ops_pause_cleared`와 `send_resumed`(info)가 한 번씩 남는다. `send_*`는 정지 상태가 바뀐 것을 관찰할 때만 남고 폴링마다 반복하지 않는다. 인스턴스마다 한 줄씩 나온다.

확인:

- 호출처 키: `GET /health/ready`의 `sendPaused`(`{ paused, scope }`). `scope`가 `all`이면 전체 정지, `account`이면 그 호출처가 쓰는 SMTP 계정의 정지, `caller`이면 그 호출처만 정지다(우선순위 `all`, `account`, `caller`).
- 운영자·관리 토큰: `GET /health/ready`의 `sendControls`(`allPaused`, `pausedCallerCount`, `pausedAccountCount`)와 `GET /ops/pauses`(정지한 범위(`all`·`caller`·`account`), 시각, 토큰 이름). 계정별 정지 여부는 `GET /ops/accounts`의 `paused`다.
- 누가 언제 했는가: `GET /ops/audit` 또는 DB의 `SELECT at, actor, action, scope_type, scope_id, job_id FROM mail_ops_audit ORDER BY id DESC LIMIT 20;`

```sql
-- 현재 걸려 있는 정지(scope_type: all·caller·account)
SELECT scope_type, scope_id, paused_at, paused_by FROM mail_send_controls ORDER BY paused_at;
```

해석:

- 정지 중에는 해당 범위의 `PENDING`·`RETRY_WAIT` 작업이 쌓이고 `queue.oldestDueAgeSeconds`가 커진다. `worker.lastPollAgeSeconds`는 작다(점유 루프는 돈다). 차단기가 `closed`이고 `caller_quota_exceeded`가 없는데 이렇게 쌓이면 정지를 먼저 본다.
- 정지 중에도 작업의 `expiresAt`은 흐른다. 정지가 길면 `EXPIRED`(`JOB_EXPIRED`)가 대량으로 생긴다. 호출처 TTL(기본 24시간)보다 짧게 멈춘다.
- 정지 명령 직후에도 최대 인스턴스 수 × `MAILO_WORKER_CONCURRENCY`건이 점유를 마친 채 발송될 수 있다. 이미 `SENDING`인 전송은 끝까지 간다.
- 호출처 정지는 그 호출처만 멈춘다. 레지스트리에서 호출처를 빼도 큐에 있는 작업은 계속 나간다. 멈추려면 호출처 정지를 쓴다. 응답의 `inRegistry`가 `false`면 호출처 ID 오타일 수 있다(오타로 건 정지는 다른 호출처를 멈추지 않는다. `GET /ops/pauses`로 확인해 `DELETE`로 푼다).
- 정지를 풀어도 차단기 상태는 바뀌지 않는다. 정지 전에 `open`이었으면 해제 뒤에도 `open`이다.
- 롤링 배포 중에는 구버전 인스턴스가 정지를 읽지 않아 발송을 계속한다. 롤링 중에는 정지 명령을 쓰지 않는다(`deployment.md` "운영 토큰·정지 도입 배포 순서").
- 점유 쿼리 비용: 정지한 호출처가 대기 작업 대부분을 가진 경우 점유 쿼리가 대기 작업을 읽고 버린다. 호출처 할당 초과와 같은 동작이다. 10만 건 대기에서 한 호출처가 전부 정지됐을 때 점유 쿼리가 약 7~14ms였다(로컬 PostgreSQL 17 단일 측정). 정지가 길어지면 호출처 작업을 취소하거나 만료를 기다린다.

`/ops` 호출 오류:

| 응답 | 의미 |
| ---- | ---- |
| 401 `unauthorized` | 토큰이 없거나 틀렸다. 호출처 API 키는 `/ops`에서 401이다. 관리 토큰을 설정하지 않은 서버에서는 관리 토큰 값도 401이다 |
| 403 `forbidden` | 읽기 토큰으로 변경 endpoint를 불렀다. 관리 토큰을 쓴다 |
| 400 `validation-failed` | `callerId` 형식 오류(`parameter: callerId`), `jobId` 형식 오류, `limit`·`before` 오류. 값은 응답에 없다 |
| 503 | DB 오류. 정지·감사는 한 트랜잭션이라 둘 다 반영되지 않았다. 같은 요청을 다시 보내면 된다(멱등) |

기동 거부: 관리 토큰 설정이 잘못되면 `설정이 올바르지 않다:` 아래에 변수 이름과 사유가 나온다(`MAILO_OPS_ADMIN_NAMES`의 형식·개수, `MAILO_OPS_ADMIN_TOKEN_<이름>` 없음·규칙 위반, 토큰끼리 같은 값). 토큰이 호출처 API 키와 같으면 같은 형식으로 `호출처 API 키와 같은 값이다`가 나온다. 값은 출력하지 않는다. 해석은 `key-management.md` "운영 토큰".

## 결과 불명 실패

근거: RQ-048·073·074, ADR-0011 결정 5, ADR-0015 결정 5~10.

의미: `outcomeUncertain: true`는 SMTP 서버가 메일을 수락했는지 알 수 없는 시도가 한 건이라도 있었다는 뜻이다. 판정은 `mail_attempts`에서 한다. 새 컬럼은 없다.

| 시도 | 조건 | 뜻 |
| ---- | ---- | -- |
| `LEASE_EXPIRED` | `classification = 'LEASE_EXPIRED'` | lease 만료 회수는 전송 결과를 모른다("lease 만료") |
| DATA 단계 응답 없음 | `classification = 'TRANSIENT' AND stage = 'DATA' AND response_code IS NULL` | 타임아웃·연결 끊김이다. 서버가 수락했을 수 있다(ADR-0007 결정 3) |

`false`인 경우: 시도가 없다, SMTP 응답 코드가 있다(수신 거부 `550`, 일시 오류 `451` 등), DATA 이전 단계(`CONN`·`TLS`·`AUTH`·`MAIL_FROM`·`RCPT`)다, Mailo 내부 오류(`stage = 'WORKER'`)다.

```sql
-- 결과 불명 시도가 있는 작업. API의 outcomeUncertain과 같은 조건이다
SELECT j.id, j.caller_id, j.status, j.attempts, j.finished_at
  FROM mail_jobs j
 WHERE EXISTS (SELECT 1 FROM mail_attempts a
                WHERE a.job_id = j.id
                  AND (a.classification = 'LEASE_EXPIRED'
                       OR (a.classification = 'TRANSIENT' AND a.stage = 'DATA' AND a.response_code IS NULL)))
 ORDER BY j.created_at DESC LIMIT 20;
```

해석:

- 호출처 문의의 답: `GET /jobs/{jobId}`(호출처 키) 또는 `GET /ops/jobs/{jobId}`·`jobs show <jobId>`(운영 토큰)의 `outcomeUncertain`을 본다. `/ops` 응답에는 Key·수신자·본문·SMTP 응답 텍스트가 없다. 이벤트의 값과 작업 조회의 값은 같다.
- `true`가 많으면 SMTP 응답 지연이나 연결 끊김이 반복된 것이다. DATA 단계 타임아웃(`MAILO_SMTP_TIMEOUT_SECONDS`, 기본 30초)과 "lease 만료"의 원인 목록을 본다.
- 운영자가 대신 다시 보내는 방법은 없다. 호출처가 새 Key로 다시 제출한다(`caller-onboarding.md` "결과 불명 실패"). 본문은 종결 전이에서 지워지므로(RQ-071) 운영자가 복원할 수 없다.
- 한계: 서버가 응답했지만 Mailo가 받지 못한 경우처럼 위 두 조건 밖의 불명은 잡지 못한다. 시도 이력은 작업과 함께 보존 기간(기본 30일) 뒤에 지워져 조회가 404다.

### `OUTCOME_UNKNOWN` 종결

요청이 `onUncertainOutcome: fail`을 보냈으면 위 두 조건의 시도 뒤에 재시도하지 않고 `FAILED`·`failureReason: OUTCOME_UNKNOWN`으로 끝난다(ADR-0015 결정 7). 시도 횟수 소진과 만료보다 먼저 정해진다. 작업 행의 `on_uncertain`이 `fail`이다. 값은 등록 때 고정되고 바뀌지 않는다.

```sql
-- OUTCOME_UNKNOWN으로 끝난 작업과 불명을 만든 시도의 분류
SELECT j.id, j.caller_id, j.attempts, j.finished_at,
       (SELECT a.classification FROM mail_attempts a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS last_classification
  FROM mail_jobs j
 WHERE j.failure_reason = 'OUTCOME_UNKNOWN'
 ORDER BY j.finished_at DESC LIMIT 20;
```

| 관찰 | 원인 | 확인 |
| ---- | ---- | ---- |
| 마지막 시도가 `LEASE_EXPIRED`다 | 전송 중 프로세스가 죽었거나 결과 기록이 lease 안에 끝나지 않았다. 점유 직후 죽어 전송 전이었을 수도 있다 | `mailo_lease_recovered_total`, `drain_timeout`, `lease_lost`. 배포(종료)마다 늘면 `stop_grace_period`가 lease보다 짧은지 본다(`deployment.md` "종료와 stop_grace_period") |
| 마지막 시도가 `TRANSIENT`이고 `stage = 'DATA'`, 응답 코드 없음 | DATA 단계 타임아웃·연결 끊김이다 | `mailo_attempt_errors_total{stage="data",result="transient"}`, `MAILO_SMTP_TIMEOUT_SECONDS` |
| `mailo_jobs_outcome_unknown_total`이 갑자기 늘었다 | 위 두 원인 중 하나가 반복된다. 호출처·계정 라벨로 범위를 좁힌다 | `by (caller_id, account_id)`로 본다. 한 계정에 몰리면 SMTP 연결 문제, 전 계정이면 배포·프로세스 종료다 |

- 메일이 나갔는지는 Mailo가 알지 못한다. SMTP 서버의 보낸편지함·수신 로그로 확인하는 수단은 Mailo에 없다. 호출처가 확인한 뒤 새 `Idempotency-Key`로 다시 보낸다(`caller-onboarding.md` "결과 불명이면 재시도하지 않기").
- 운영자가 `on_uncertain`을 바꾸는 방법은 없다. 새 요청에서 `onUncertainOutcome`을 `retry`로 보내거나 생략한다.

## 작업 취소

근거: RQ-040·041, ADR-0011 결정 4.

신호: `job_canceled`(info, `jobId`, `callerId`, `canceledBy`)는 호출처가 작업을 취소한 요청마다 한 번 남는다. 운영자가 관리 토큰으로 취소하면(`POST /ops/jobs/{jobId}/cancel`) `ops_job_canceled`(info, `actor`, `jobId`)가 남고 감사 기록(`CANCEL_JOB`)이 같은 트랜잭션에 쓰인다. 이미 취소된 작업에 다시 요청한 경우는 둘 다 남지 않는다. `Idempotency-Key`와 수신자는 로그에 없다.

```sql
-- 취소한 작업과 사유. failure_reason은 CANCELED_BY_CALLER 또는 CANCELED_BY_OPERATOR다
SELECT id, caller_id, idempotency_key, attempts, failure_reason, finished_at, body_deleted_at
  FROM mail_jobs WHERE status = 'CANCELED' ORDER BY finished_at DESC LIMIT 20;
-- 취소 이벤트(호출처 피드). 작업 1건당 정확히 1건이다
SELECT e.id, e.caller_id, e.job_id, e.failure_reason, e.created_at
  FROM mail_events e WHERE e.type = 'JOB_CANCELED' ORDER BY e.id DESC LIMIT 20;
```

해석:

- 취소는 `PENDING`·`RETRY_WAIT`만 바꾼다. 취소 요청이 점유(`SENDING`)보다 늦으면 409 `job-not-cancelable`이고 `jobStatus`가 `SENDING`이다. 이 경우 메일은 나갈 수 있다. 결과는 `SENT`·`FAILED` 이벤트로 확인한다. 취소와 점유는 작업 행 잠금으로 직렬화되므로 한 작업이 취소되면서 동시에 발송되는 경우는 없다.
- 취소된 작업은 점유·만료 sweep·본문 정리 대상이 아니다. 본문은 취소 때 바로 지워지고(`body_deleted_at`) 행·Key·지문은 종결 후 보존 기간(기본 30일)까지 남는다.
- 취소 이벤트가 피드에 없으면 호출처의 cursor와 `type` 필터를 먼저 본다. `type` 필터를 쓰는 호출처는 `JOB_CANCELED`를 필터에 넣었는지 확인한다. 필터가 없으면 모든 종류가 온다.
- 호출처가 `CANCELED`·`JOB_CANCELED`를 모르는 값으로 만나 outbox 행이 종결되지 않으면 사용처의 모르는 값 처리 문제다(`docs/api/README.md` "호출처가 모르는 값을 만났을 때"). 같은 Key의 `GET /jobs?idempotencyKey=`로 `status`를 확인한다.
- 같은 Key로 다시 보냈는데 메일이 나가지 않는다: 그 Key의 작업이 `CANCELED`다. 같은 내용 재전송은 200과 `CANCELED` 작업을 돌려준다. 새 Key로 다시 보낸다.
- 운영자가 취소했는지는 `failure_reason = 'CANCELED_BY_OPERATOR'`와 `mail_ops_audit`(`action = 'CANCEL_JOB'`, `job_id`)로 확인한다. 호출처 응답과 피드에는 `canceledBy: OPERATOR`만 있고 운영자 이름은 없다.
- 롤링 배포 중에는 구버전 인스턴스가 `CANCELED`를 그대로 내보내고 `GET /events?type=JOB_CANCELED`를 400으로 거부한다(`deployment.md` "작업 취소 도입 배포 순서").

이벤트 쓰기 실패 등 DB 오류로 취소 요청이 503이면 전이도 롤백되어 `PENDING`·`RETRY_WAIT` 그대로다. 같은 요청을 다시 보내면 된다.

## SMTP 계정 구성

근거: RQ-053·054·056, ADR-0013. 계정 형식과 배포 순서는 `deployment.md` "SMTP 계정"이다. 로그에는 계정 ID와 호출처 ID, 건수만 싣고 host·user·from·비밀번호는 싣지 않는다.

| 증상·로그 | 의미 | 조치 |
| --------- | ---- | ---- |
| 기동 실패 `MAILO_SMTP_SECRET_<이름> 또는 …_FILE이 필요하다(accounts[i].auth.secretVar)` | 계정 파일이 가리키는 비밀 변수가 없다 | 변수나 `_FILE`을 준다. 변수 이름은 파일의 `secretVar`와 같아야 한다 |
| 기동 실패 `accounts[i].id가 …`, `알 수 없는 필드`, `host·port·user` | 계정 파일 형식 오류. 위치(`accounts[i]`)와 사유만 나온다 | 위치의 항목을 `deployment.md` "SMTP 계정"의 필드 표에 맞춘다 |
| 기동 실패 `MAILO_SMTP_<변수>은 MAILO_SMTP_ACCOUNTS_FILE이 있고 MAILO_SMTP_HOST가 없을 때 쓸 수 없다` | 계정 파일로 `default`를 정의하는데 `MAILO_SMTP_*` 잔여 변수가 남았다 | 변수를 지우거나 `MAILO_SMTP_HOST`를 주어 `default`를 환경 변수로 정의한다 |
| 기동 실패 `callers[i].accountId가 구성에 없는 SMTP 계정을 가리킨다` | 레지스트리가 모르는 계정을 지정했다 | 계정 파일에 계정을 넣거나 `accountId`를 고친다. 계정 파일 배포가 이 인스턴스에 끝났는지 본다 |
| 기동 실패 `callers[i].accountId를 생략하면 default 계정을 쓰는데 구성에 default 계정이 없다` | `default` 계정이 없는데 `accountId`를 생략한 호출처가 있다 | 그 호출처에 `accountId`를 지정하거나 `default` 계정을 정의한다 |
| `account_orphan_jobs`(warn, `accountId`, `count`) | 구성에 없는 계정의 비종결 작업이 DB에 있다. 점유되지 않고 만료 시각에 `EXPIRED`가 된다 | 계정을 구성에 되돌리면 다시 발송된다. 의도한 제거면 기다리거나 취소한다. 다른 계정으로 옮기지 않는다 |
| `account_unused`(info, `accountId`) | 어느 호출처도 쓰지 않는 계정 | 의도한 것인지 확인한다. 거부하지 않는다 |
| `allowed_from_other_account`(warn, `callerId`) | 그 호출처의 `allowedFrom`이 다른 계정의 `from`과 같다 | 의도한 별칭 공유인지 확인한다. 거부하지 않는다 |
| `account_quota_exceeded`(warn, `accountId`, `limit`) | 그 계정의 24시간 `sendQuota24h`에 닿아 그 계정의 점유가 멈췄다. 다른 계정은 계속 발송한다. 상태가 바뀔 때만 한 줄 남는다 | 한도 수치와 시도 수를 본다(아래 SQL). 24시간 안에 시도가 빠지면 `account_quota_recovered`(info)가 남고 다시 발송한다. 한도를 올리려면 파일을 고치고 재시작한다 |
| `claim_failed`(error, `accountId`, `error`, `streak`) | 그 계정의 점유 쿼리가 실패했다. 그 계정만 지수 백오프(상한 30초)하고 다른 계정은 계속 점유한다 | `accountId`가 있는 줄만 본다. 같은 `accountId`가 계속되면 그 계정의 차단기 행이 없는지(`mail_circuit_breaker`) 본다. 모든 계정에서 나오면 DB 연결 문제다("DB 연결 문제") |
| `send_paused`·`send_resumed`(`scope: "account"`, `accountId`) | `mail_send_controls`에 `account` 범위 행이 생기거나 사라졌다. 그 계정의 점유가 멈추거나 재개된다 | `PUT`·`DELETE /ops/pauses/accounts/{accountId}`나 CLI `pause|resume --account`로 건 정지다. 누가 언제 걸었는지는 `GET /ops/pauses`·`GET /ops/audit`(`scope.type: account`)로 본다. 직접 SQL로 넣은 행일 수도 있다. 아래 SQL로 확인한다 |
| 기동 실패 `invalid worker option (field=accounts)` | 구성한 계정 수가 `MAILO_WORKER_CONCURRENCY`보다 많다 | 계정을 줄이거나 `MAILO_WORKER_CONCURRENCY`를 올린다. 계정마다 슬롯 하나를 보장하는 조건이다 |
| 기동 실패 `invalid worker option (field=accountConcurrency)`·`accountQuota`·`accountQuota.retention` | 계정의 `concurrency`가 1~`MAILO_WORKER_CONCURRENCY`가 아니거나, `sendQuota24h`가 양의 정수가 아니거나, 계정 할당이 있는데 시도 기록 보존이 24시간 미만이다 | 계정 파일의 값을 고치거나 `MAILO_RECORD_RETENTION_SECONDS`를 24시간 이상으로 둔다 |
| `job_internal_error`(error)가 계속된다 | 작업이 고정한 계정의 발송기가 없는 등 Mailo 내부 오류. 차단기를 건드리지 않고 같은 작업이 3번째 시도에서 `FAILED`가 된다 | 정상 경로에서는 일어나지 않는다. 계정 구성과 `mail_jobs.account_id`를 확인한다 |
| `account_orphan_check_failed`(warn, `error`) | 기동 때 구성 밖 계정 작업을 세는 쿼리가 실패했다 | 기동은 막지 않는다. DB 연결을 본다 |

- 작업의 계정 확인(읽기): `SELECT account_id, status, count(*) FROM mail_jobs GROUP BY 1, 2 ORDER BY 1, 2;`
- 계정별 차단기 행(읽기): `SELECT breaker_key, state, open_until, last_reason FROM mail_circuit_breaker ORDER BY 1;`. 행 키가 계정 ID다. 구성에 있는 계정의 행은 기동 때 만든다. 구성에서 빠진 계정의 행은 지우지 않는다.
- 계정별 차단기 상태는 `GET /ops/accounts`(CLI `accounts list`)와 `/metrics`의 `mailo_breaker_state{account_id}`가 낸다. `/health/ready`의 `circuitBreaker`는 인증 없음·운영자 토큰에서 가장 나쁜 계정의 상태이고 호출처 키에서 그 호출처 계정의 상태다. 어느 계정이 막혔는지는 `GET /ops/accounts`로 먼저 본다. 위 SQL은 API가 안 될 때의 대안이다.
- `GET /ops/accounts`가 503이면 구성한 계정의 차단기 행이 없는 것이다(`mail_circuit_breaker`). `/health/ready`도 같은 이유로 503이 되고 `checks.database: DOWN`으로 보일 수 있다(원인은 DB 연결이 아니라 차단기 행이다. `readiness_check_failed` 로그의 `name`으로 가른다). Worker 기동이 행을 만든다. 행이 없으면 그 계정의 점유도 실패한다(`claim_failed`).
- 계정 정지 행(읽기): `SELECT scope_id, paused_at, paused_by FROM mail_send_controls WHERE scope_type = 'account';`
- 계정의 24시간 사용량(읽기, 한도 판정과 같은 조건): `SELECT count(*) FROM mail_attempts WHERE account_id = '<ID>' AND counted AND stage IS DISTINCT FROM 'WORKER' AND finished_at > now() - interval '24 hours';` 점유 중(`SENDING`)인 작업 수가 더해진다.
- 한 계정이 느려질 때: 그 계정은 인스턴스당 슬롯 `cap_a`(계정의 `concurrency`, 없으면 `max(1, C − (N − 1))`)까지만 쥔다. 다른 계정은 남은 슬롯으로 계속 발송한다. 처리량이 모자라면 `MAILO_WORKER_CONCURRENCY`를 올리거나 계정에 `concurrency`를 준다.

## 호출처 할당 초과

신호: `caller_quota_exceeded`(warn, `callerId`, `limit`)는 할당을 넘긴 호출처가 새로 생겼을 때 한 번, `caller_quota_recovered`(info, `callerId`)는 풀렸을 때 한 번 남는다. 폴링마다 반복되지 않는다.

- 사용량 = 최근 24시간의 "할당에 드는 시도" + 현재 `SENDING` 작업 수다. 할당에 드는 시도는 시도 횟수에 포함되는(`counted`) 시도 중 Mailo 내부 오류(`stage = 'WORKER'`)를 뺀 것이다. 차단기를 연 계정 상태 오류 시도(`ACCOUNT`, `counted = false`)는 들지 않고, 차단기가 `closed`로 남은 계정 상태 오류 시도(`counted = true`)와 `TRANSIENT`·`PERMANENT`·`LEASE_EXPIRED`는 든다.
- 초과한 호출처의 작업은 점유되지 않고 `PENDING`·`RETRY_WAIT`에 머문다. 상태, 시도 횟수, `next_attempt_at`은 바뀌지 않는다. 다른 호출처에는 영향이 없다.
- 가장 오래된 시도가 24시간을 넘기면 한 건씩 풀린다. 그 전에 만료 시각(기본 24시간)에 이르면 `EXPIRED`가 된다. 할당이 처리량보다 작으면 만료가 쌓인다.
- 조치: `callers.json`의 `sendQuota24h`를 늘리거나, 호출처의 발송량을 줄이거나, 만료 TTL(`MAILO_JOB_EXPIRY_SECONDS`, 요청별로는 `ttlSeconds`와 상한 `MAILO_JOB_EXPIRY_MAX_SECONDS`)을 조정한다. 설정 값을 바꾸면 재시작이 필요하다.

## 기동 시 비밀값 해석 실패

`X_REF`(외부 시크릿 소스, `deployment.md` "외부 시크릿 소스(`X_REF`)")를 쓰는 배포에서 인스턴스가 뜨지 않을 때 본다. 종료 코드는 1이다. 앱은 `startup_failed` 로그의 `message`, 마이그레이션 CLI는 표준 오류에 줄마다 `비밀값 해석 실패: <변수>(<방식>): <종류>`를 낸다. 실패한 변수는 모두 모아 한 번에 나온다. 값, 참조 문자열(저장소의 비밀 ID), 어댑터 오류 메시지는 어디에도 나오지 않는다.

- 확인: `docker compose logs --no-log-prefix mailo | jq -c 'select(.event=="startup_failed") | .message'`.
- 방식은 `env+ref`·`file+ref`·`env+file+ref`(충돌), `ref`, `ref:<scheme>`(등록된 어댑터의 scheme)다.

| 종류 | 뜻 | 조치 |
| ---- | -- | ---- |
| `conflict` | `X_REF`와 `X` 또는 `X_FILE`이 함께 비어 있지 않다. 방식이 어느 것과 겹쳤는지 알려 준다 | 하나만 남긴다. `.env`에 남은 평문 값이면 지우거나 compose `environment:`에서 `X: ""`로 비운다 |
| `empty` | 어댑터가 빈 문자열을 돌려줬다 | 저장소의 값을 확인한다 |
| `invalid-ref` | `X_REF`가 `<scheme>://<참조>` 형식이 아니다(`//` 뒤가 비었거나 scheme에 대문자 등) | 형식을 고친다. 평문 비밀을 `_REF`에 넣지 않았는지 본다 |
| `reserved-scheme` | scheme이 `file`이다 | 파일은 `X_FILE`로 지정한다 |
| `unknown-scheme` | 그 scheme의 어댑터가 `MAILO_SECRET_ADAPTERS`에 없다(어댑터를 지정하지 않은 경우 포함) | 어댑터가 든 이미지를 쓰고 `MAILO_SECRET_ADAPTERS`를 지정한다. scheme 오타도 본다 |
| `unknown-name` | 이름이 `MAILO_`로 시작하고 `_REF`로 끝나는데 `X_REF`를 받는 변수가 아니다(오타, `MAILO_CLI_TOKEN_REF`), 또는 변수 이름이 `_FILE`·`_REF`로 끝난다. 변수 칸에 `_REF`가 붙은 이름이 나온다 | 이름을 고친다. 받는 변수 목록은 `deployment.md`다 |
| `timeout` | 어댑터가 `MAILO_SECRET_RESOLVE_TIMEOUT_MS`(기본 10초) 안에 끝나지 않았다 | 저장소 접근 경로(네트워크, DNS, 엔드포인트)를 본다. 필요하면 제한 시간을 늘린다(최대 60000). 코어는 재시도하지 않는다 |
| `adapter-error` | 어댑터가 닫힌 코드 없이 실패했다 | 어댑터가 로그를 남기는지 본다. 어댑터는 값과 참조를 로그에 쓰지 않아야 한다 |
| `adapter-error:not-found` | 저장소에 그 비밀이나 키가 없다 | 참조의 이름·키 오타와 저장소의 비밀을 확인한다 |
| `adapter-error:access-denied` | 저장소가 거부했다 | 인스턴스의 저장소 접근 자격 증명과 권한(정책, 키 권한)을 확인한다 |
| `adapter-error:throttled` | 저장소가 요청을 제한했다 | 잠시 뒤 재시작한다. 인스턴스를 한꺼번에 다시 시작하지 않는다 |
| `adapter-error:unavailable` | 저장소에 닿지 못하거나 저장소 오류다 | 네트워크와 저장소 상태를 확인한다. 이미 실행 중인 인스턴스는 영향이 없다(기동 때 한 번만 읽는다) |
| `adapter-error:invalid-value` | 어댑터가 값을 받을 수 없다고 판정했다(예: JSON 키 없음, 형식) | 저장소 값의 형식과 참조의 키 지정을 확인한다 |

닫힌 코드는 진단 힌트다. 어댑터가 분류를 잘못 붙이면 원인을 잘못 읽을 수 있다.

AWS 어댑터(`aws-sm`, 변형 이미지 `-aws`)가 코드를 붙이는 기준은 `deployment.md` "AWS 변형 이미지(`-aws`)"의 오류 코드 줄이다. 이 어댑터 고유의 확인 사항:

- `adapter-error:invalid-value`의 원인이 `AWS_REGION` 없음일 수 있다. 변형 이미지의 컨테이너 환경에 `AWS_REGION`이 있는지 본다.
- `adapter-error:access-denied`는 정책 거부 외에 자격 증명을 얻지 못한 경우(SDK 기본 체인 실패)도 포함한다. 컨테이너에 `AWS_ACCESS_KEY_ID` 같은 변수나 플랫폼 역할이 있는지 본다.
- `adapter-error`(코드 없음)는 어댑터가 분류하지 못한 오류다. SDK 오류 메시지는 코어와 어댑터 모두 로그에 싣지 않는다.

- `비밀값 어댑터 로드 실패: <패키지>: <종류>`는 해석 전에 나는 오류다. 종류: `invalid-specifier`(경로·URL·대문자·하위 경로 등 bare 패키지 이름이 아님. 줄에 `<n>번째 항목`으로 나온다), `not-found`(이미지에 패키지가 없다), `import-failed`(패키지를 불러오다 실패했거나, 모듈 로드가 `MAILO_SECRET_RESOLVE_TIMEOUT_MS` 안에 끝나지 않았다. 최상위 await가 끝나지 않는 어댑터가 원인일 수 있다), `invalid-export`(기본 export가 `scheme`·`resolve`를 가진 객체가 아니다), `reserved-scheme`(`file`), `duplicate-scheme`(두 어댑터가 같은 scheme). 이 오류가 나면 해석은 시도하지 않는다.
- `MAILO_SECRET_RESOLVE_TIMEOUT_MS은 100 이상 60000 이하의 정수여야 한다`는 설정 값 오류다.
- 값 끝에 개행이 붙어 있으면 그대로 쓰인다(`_FILE`은 끝 개행 한 개를 제거하지만 `X_REF`는 어댑터가 준 값을 자르지 않는다). 증상은 해석이 아니라 소비자 쪽에서 나온다: SMTP·계정 비밀번호는 `AUTH` 사유의 차단기 `open`, DB 비밀번호는 접속 실패(SQLSTATE `28P01`)다. 키 변수(32바이트 키)와 운영 토큰은 소비자가 앞뒤 공백을 무시하므로 영향이 없다. 저장소의 값을 개행 없이 다시 저장한다.
- 새 인스턴스가 저장소 장애로 뜨지 못하는 동안 이미 실행 중인 인스턴스는 계속 동작한다. 재시작이 필요한 변경(비밀 교체)은 저장소가 복구된 뒤 한다.
- 로그에서 값이 보이면 보고한다. 어댑터가 오류 메시지나 자체 로그에 값을 쓴 경우다. 코어는 어댑터 오류 메시지를 읽지 않는다.

## DB 연결 문제

- `GET /health/ready`가 503이고 `checks.database`가 `DOWN`, `circuitBreaker.state`가 `unknown`이다. 로그에 `{"event":"readiness_check_failed","name":<오류 클래스>,"code":<pg 오류 코드>}`가 남는다(접속 정보는 남기지 않는다).
- REST 등록·조회는 503(`service-unavailable`)이다. 사용처는 같은 Key로 재시도한다(ADR-0005 결정 5).
- Worker는 `claim_failed`(error, `error`, `streak`)를 남기고 간격을 늘려(최대 30초) 다시 시도한다. DB가 돌아오면 자동 재개된다.
- 풀의 유휴 연결 오류는 `{"event":"db_idle_client_error","name":...,"code":...}`로 남는다.
- DB 시간제한 오류: SQLSTATE `57014`(`statement_timeout`), `55P03`(`lock_timeout`), `25P03`(`idle_in_transaction_session_timeout`으로 연결이 끊김), 메시지 `Query read timeout`(`query_timeout`). 값은 `MAILO_DB_*_TIMEOUT_MS`이고 기본값과 조정 기준은 `deployment.md` "DB 시간제한과 장애 동작"이다.
- 점유 루프가 예외로 죽으면 `poll_loop_crashed`(error) 뒤 `worker_fatal`(error, 필드 `reason=poll_loop_crashed`, `exitCode=70`)이 표준 출력에 한 줄 JSON으로 남고, 종료 순서(pause → drain → 풀 닫기)를 거쳐 종료 코드 70으로 끝난다. 컨테이너는 재시작한다. 반복되면 `poll_loop_crashed`의 `error` 이름을 본다.
- 파일 채널은 파일과 무관한 오류(`file_ingest_failed`)가 3번 연속이면 그 폴링을 접고 다음 간격에 다시 시도한다. 폴더 목록 읽기 실패(`file_poll_failed`)는 이 횟수에 세지 않는다(ADR-0004 구현 중 확정 29).

## 유지 작업 로그

Worker가 `MAILO_MAINTENANCE_INTERVAL_SECONDS`(기본 60초)마다 돌리는 작업이다. 처리량이 있을 때만 info로 남는다(`count`).

| 이벤트 | 의미 |
| ------ | ---- |
| `sweep_expired` | 만료 시각을 넘긴 `PENDING`·`RETRY_WAIT` 작업을 `EXPIRED`로 바꾸고 `JOB_EXPIRED` 이벤트를 썼다 |
| `lease_recovered` | lease가 지난 `SENDING` 작업을 회수했다 |

- 인스턴스가 여럿이면 각 단계(`sweep_expired`, `lease_recovered`, 본문 삭제 `bodies_deleted`, 보존 삭제 `records_deleted`, 수신자 비움 `recipients_redacted`)는 배치마다 DB advisory lock을 잡은 인스턴스만 돌린다. 못 잡은 인스턴스는 기다리지 않고 건너뛰므로 로그에 `count`가 없다. 배치는 최대 1,000건이다(ADR-0002 구현 중 확정 10).
| `bodies_deleted` | 종결 후 유예가 지났는데 본문이 남은 작업(이전 버전이 종결한 행)의 본문을 비웠다. 종결 전이가 본문을 바로 비우므로(RQ-071) 새 버전만 쓰면 `count`가 없다 |
| `records_deleted` | 보존 기간이 지난 작업 행(시도·이벤트 포함)과 거부 기록을 삭제했다 |
| `recipients_redacted` | 유예(`MAILO_RECIPIENT_RETENTION_SECONDS`)가 지난 `JOB_*` 이벤트의 수신자와 그 작업의 시도 기록 거부 수신자를 비웠다(`count`는 이벤트 수). 로그에 주소는 없다(RQ-072, RQ-027) |
| `<이름>_failed`(error) | 위 작업의 실패. `error`에 오류 이름 |

그 밖의 Worker 로그: `smtp_plaintext_enabled`(warn, `accountId`, `auth`, `message`, 평문(`security=none`) 계정마다 기동 때 한 번. 인증 정보와 본문이 평문으로 나간다. `deployment.md` "평문 SMTP 모드"), `worker_started`, `worker_paused`(`inFlight`, 종료 신호 직후 새 점유 중지), `worker_stopping`, `worker_stopped`(`drained`), `job_completed`(`jobId`, `status`, `classification`, `probe`), `poll_loop_crashed`, `maintenance_loop_crashed`.

## 지표 해석

근거: RQ-049~052, ADR-0012. 지표 목록과 스크레이프 설정은 `deployment.md` "지표"다. 아래 PromQL은 `promtool`의 문법 검사를 통과한 규칙(`deployment.md` "알림 규칙 예시")의 조건을 풀어 쓴 것이다. 임계값은 추정이다.

읽는 규칙:

- 전역 gauge(`mailo_queue_`, `mailo_breaker_`, `mailo_send_paused`, `mailo_caller_`, `mailo_ops_audit_`)는 어느 인스턴스가 내도 같은 DB 값이다. 인스턴스가 여럿이면 `max by (...)`로 읽는다. `sum`은 인스턴스 수만큼 곱해진다. 인스턴스 사이에 최대 `MAILO_METRICS_CACHE_SECONDS`(기본 5초)만큼 어긋날 수 있다.
- counter(`*_total`)는 이 프로세스가 한 일이다. `sum by (...) (rate(...))`나 `increase`로 읽는다. 알림이 쓰는 counter는 시작할 때 0으로 미리 나오므로 첫 증가도 센다. 미리 내지 못하는 시리즈(`unregistered`, 파일 채널, `attempt_errors`)의 첫 증가는 놓친다(`deployment.md` "인스턴스 counter와 gauge"). 재시작하면 0에서 다시 시작한다(`process_start_time_seconds`가 바뀐다).
- 타깃은 인스턴스마다 둔다. 로드 밸런서 하나를 타깃으로 두면 counter가 줄었다 늘어 `rate`가 틀린다.

증상별:

| 증상 | 원인 후보 | 확인 |
| ---- | --------- | ---- |
| 타깃이 `down`이고 오류가 `HTTP status 403 Forbidden` | Prometheus 설정에 관리 토큰이 있다 | 토큰 파일을 읽기 토큰(`MAILO_OPS_TOKEN`)으로 바꾼다. 관리 토큰은 `/metrics`에서 403이다 |
| 타깃이 `down`이고 오류가 `HTTP status 401 Unauthorized` | 토큰이 틀렸거나 호출처 API 키다, 또는 서버에 `MAILO_OPS_TOKEN`이 없다 | 서버 환경 변수와 토큰 파일. 호출처 키는 401이다 |
| 타깃이 `down`이고 오류가 `404` | 구버전 인스턴스다. 롤링 배포 중이다 | 모든 인스턴스를 새 버전으로 바꾼 뒤 타깃에 추가한다 |
| 타깃이 `down`이고 연결 오류 | 인스턴스가 죽었거나 주소·포트·방화벽 문제다 | `/health/live`. 기본 compose는 `127.0.0.1`만 연다 |
| `mailo_metrics_collect_ok{group}`이 0 | 그 그룹의 DB 읽기가 실패했다(시간 초과, 연결, 권한). 응답에는 그 그룹의 전역 지표가 없다 | 로그의 `metrics_collect_failed`(`group`, `error`). 같은 그룹이 연속 실패하는 동안 로그는 한 번이다. 모든 그룹이 0이면 DB 연결 문제다("DB 연결 문제"). 인스턴스 값은 계속 나온다 |
| `mailo_queue_oldest_due_age_seconds`가 커진다 | 점유가 안 되거나 느리다 | 차단기(`mailo_breaker_state`), 정지(`mailo_send_paused_all`·`mailo_caller_paused`), 할당(`mailo_caller_quota_used` / `_limit`), Worker(`mailo_worker_last_poll_age_seconds`, `mailo_worker_state`). `LOW`만 커지면 우선순위 경로의 정상 동작일 수 있다("등급별 적체") |
| `mailo_queue_jobs{state="due"}`가 있는데 `mailo_attempts_total`이 늘지 않는다 | 차단기 `open`, 발송 정지, 할당 초과, Worker 정지 중 하나다 | 위 표와 같다. `MailoNoProgress` 규칙이 이 조합이다 |
| `mailo_queue_jobs_truncated`가 1 | 상한(10000)에 닿았다. 실제로는 더 많다 | 건수는 10000에서 멈춘다. `mailo_queue_oldest_due_age_seconds`로 적체 정도를 본다 |
| `mailo_breaker_state{state="open"}`가 1 | SMTP 계정 단위 장애다 | `mailo_breaker_reason_info`의 `reason`(`QUOTA_DAILY`, `AUTH_FAILED` 등)과 "전역 차단기가 open일 때" |
| `mailo_attempt_errors_total`의 `result="account"`가 늘고 `reason`이 `daily_limit` | 일일 한도에 닿았다 | "전역 차단기가 open일 때" |
| `mailo_attempt_errors_total`의 `stage="data"`가 늘고 `result="transient"` | DATA 단계 일시 오류·타임아웃이다. 타임아웃이면 결과 불명일 수 있다 | "결과 불명 실패" |
| `mailo_attempt_errors_total`의 `result="internal"`이 늘고 `stage="worker"` | Mailo 내부 오류(복호화 실패, 잘못된 작업 데이터)다. SMTP에 닿지 않았고 차단기는 바뀌지 않는다 | `job_internal_error` 로그의 `error`(이름·코드만). 키 설정(`key-management.md`)을 확인한다 |
| `mailo_lease_recovered_total`이 늘었다 | 전송 중 프로세스가 죽었거나 결과 기록이 lease 안에 끝나지 않았다. 같은 메일이 두 번 갈 수 있다(RQ-013) | "lease 만료" |
| `mailo_jobs_finished_total{status="failed"}` 비율이 높다 | 영구 오류, 시도 소진, `OUTCOME_UNKNOWN`이다 | `result="permanent"`의 `stage`, 이벤트의 `failureReason`, `mailo_jobs_outcome_unknown_total`. 호출처별로 `by (caller_id)`를 본다 |
| `mailo_jobs_outcome_unknown_total`이 늘었다 | `onUncertainOutcome: fail` 요청이 결과 불명으로 끝났다. 메일이 나갔을 수도 있다 | "결과 불명 실패"의 `OUTCOME_UNKNOWN` 종결 |
| `mailo_jobs_finished_total{status="expired"}`가 늘고 정지·할당이 걸려 있다 | 정지 중에도 TTL이 흘러 `EXPIRED`가 쌓인다 | "발송 정지", "호출처 할당 초과" |
| `mailo_caller_latest_event_age_seconds`가 크다 | 그 호출처의 새 종결 이벤트가 오래 없었다. 소비자의 처리 지연이 아니다 | "피드 지연 해석" |
| `mailo_event_cursor_gap_total`이 늘었다 | 호출처가 보존 기간(기본 30일)보다 오래 폴링하지 않았다 | "이벤트 피드 공백" |
| `mailo_ops_audit_rows`가 커진다 | 감사 행이 쌓인다. 자동 삭제가 없다 | `GET /ops/audit`로 누가 무엇을 했는지 본다. 삭제 정책은 정하지 않았다 |
| `mailo_metrics_dropped_samples_total`이 0이 아니다 | 지표 값 검증 실패나 시리즈 상한(지표당 2000)이다 | 로그의 `metrics_series_limit`(`metric`). 정상이면 0이다. 코드 결함의 신호일 수 있다 |
| `mailo_file_poller_last_poll_ok`가 0 | 마지막 파일 폴링에 오류가 있었다 | `file_poll_failed`·`file_ingest_failed`, "unreadable 파일" |
| `caller_id="unregistered"` 시리즈가 있다 | 레지스트리에서 뺀 호출처의 작업이 큐에 남아 처리됐다 | 레지스트리와 큐의 `caller_id`를 대조한다. 가짜 호출처 ID로 시리즈를 늘릴 수 없게 한 묶음이다 |

- 같은 지표를 인스턴스마다 보고 싶으면 인스턴스 값(`mailo_worker_`, `process_*`, counter)을 쓴다. 전역 gauge를 인스턴스별로 비교하면 TTL 어긋남만 보인다.
- 값의 해석에서 확인하지 않은 것은 `deployment.md`의 "검증하지 않은 것"이다. 알림이 발화하는 조건과 임계값은 부하에서 확인하지 않았다.

## 검증하지 않은 것

- "발송 정지"의 SQL은 스키마와 대조했고 통합 테스트(`test/queue/send-controls.integration-spec.ts`, `test/http/ops.integration-spec.ts`)가 동작을 확인한다. 점유 쿼리 비용 수치는 로컬 단일 측정이고 다중 인스턴스·운영 크기에서는 측정하지 않았다.
- "결과 불명 실패"의 판정은 통합 테스트(`test/queue/outcome-uncertain.integration-spec.ts`, `test/http/rest-outcome-uncertain.integration-spec.ts`, `test/e2e/mail-flow.integration-spec.ts`)가 확인한다. 위 SQL은 같은 조건이고 운영 환경에서 실행해 확인하지 않았다. 서버가 응답했지만 Mailo가 받지 못한 경우는 재현하지 않았다.
- "작업 취소"의 SQL은 스키마와 대조했고 실행해 결과를 확인하지 않았다. 취소 동작 자체는 통합 테스트(`test/queue/cancel.integration-spec.ts`, `test/http/rest-cancel.integration-spec.ts`)가 확인한다.
- 위 신호와 SQL을 운영 환경에서 실행해 결과를 확인하지 않았다. "등급별 적체"의 SQL은 로컬 PostgreSQL 17의 테스트 schema에서 실행해 문법과 결과 열을 확인했다(2026-11-23). 로그 이벤트 이름과 필드는 코드와 통합 테스트(차단기, 할당, 파일 폴러)로 확인했다. `breaker_not_closed`는 `worker/worker.integration-spec.ts`가 단언한다.
- "이벤트 피드 공백"의 SQL은 통합 테스트(`test/events/event-purges.integration-spec.ts`, `test/http/rest-event-gap.integration-spec.ts`)가 동작을 확인한다. 30일이 실제로 지난 경우는 DB 시각을 당겨 만든 테스트 데이터로만 확인했다.
- "수신 도메인 거부"와 "운영 CLI 종료 코드"는 통합 테스트(`test/http/rest-recipient-domains.integration-spec.ts`, `test/file-channel/recipient-domains.integration-spec.ts`, `test/cli/`)가 확인한다. 운영 환경 로그·거부 기록은 확인하지 않았다.
- 실제 Gmail의 응답 코드·텍스트로 `lastReason` 분류를 대조하지 않았다(ADR-0007 구현 중 확정 2).
- "지표 해석"은 지표 이름과 라벨을 코드의 카탈로그와 대조했고 `/metrics` 통합 테스트(`test/http/metrics-*.integration-spec.ts`, `test/e2e/metrics-counters.integration-spec.ts`)가 값을 확인한다. 위 증상 표의 원인 후보와 조치는 부하나 실제 장애에서 확인하지 않았다.
- "기동 시 비밀값 해석 실패"의 종류별 메시지는 단위·통합 테스트(`test/secrets/`, `test/e2e/secret-sources.integration-spec.ts`, `test/e2e/secret-startup.integration-spec.ts`)가 가짜 어댑터로 확인한다. 닫힌 코드의 뜻은 어댑터가 정한다. 실제 저장소(AWS Secrets Manager 등)의 오류가 어떤 코드로 오는지는 확인하지 않았다.
- 긴 트랜잭션의 원인 목록(`pg_dump`, prepared transaction)은 일반 지식이며 Mailo 피드로 재현하지 않았다.
- "SMTP 계정 구성"의 기동 오류와 로그 이벤트는 단위·통합 테스트(`test/config/smtp-accounts.spec.ts`, `test/callers/account-id.spec.ts`, `test/e2e/multi-account.integration-spec.ts`, `test/worker/account-startup.spec.ts`)가 확인한다. 운영 환경에서 실행하지 않았고 실제 Gmail·Workspace 계정 둘 이상으로 확인하지 않았다.
