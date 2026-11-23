# 문제 해결

증상별로 무엇을 보고 어떻게 해석하는지 적는다. 로그 이벤트 이름, 응답 필드, 코드 값은 2026-11-23 코드와 `docs/api/openapi.yaml`에서 가져왔다.
표기: "추정"은 확인하지 않은 해석이다. 아래 SQL은 읽기 전용이며 실행해 결과를 확인하지 않았다(스키마와 대조했다).

## 결론

- 발송이 멈췄으면 먼저 인증된 `GET /health/ready`의 `circuitBreaker`를 본다. `open`·`half_open`이면 SMTP 계정 단위 장애다. 차단기가 `closed`인데 쌓이면 운영자 토큰(`MAILO_OPS_TOKEN`)으로 호출해 `queue.oldestDueAgeSeconds`와 `worker.lastPollAgeSeconds`를 본다(`deployment.md` "헬스"). 둘 다 크면 점유 루프가 멈춘 것이다.
- 차단기가 `closed`인데 작업이 쌓이면 호출처 할당(`caller_quota_exceeded`), lease 회수(`LEASE_EXPIRED`), DB 오류(`claim_failed`)를 순서대로 본다.
- 파일이 입력 폴더에서 사라지지 않으면 `file_poll` 로그의 `unreadable`을 본다. 권한 문제다.
- 파일 거부는 이벤트의 `reasonCode`로 원인을 고른다. 원본은 삭제되므로 호출처가 보유한 원본과 `fileName`·`sha256`을 대조한다.
- 피드 지연은 단독 장애 신호가 아니다. 새 이벤트가 없어도 `lagSeconds`가 커진다.

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
| 작업이 `SENDING`에 오래 머문다 | lease 만료(`lease_recovered`, `LEASE_EXPIRED`), 프로세스 재시작 |
| 같은 메일이 두 번 갔다 | `LEASE_EXPIRED` 시도, `drain_timeout`, `lease_lost` |
| 입력 폴더의 파일이 남는다 | `file_poll`의 `unreadable`·`deleteFailed`, `file_inbox_missing` |
| 이벤트가 안 온다 | 작업 상태, 긴 트랜잭션, cursor 저장 |
| `/health/ready`가 503 | DB 연결(`readiness_check_failed`) |
| 기동하지 않는다 | `key-management.md`의 오류 표, `deployment.md`의 제약 표 |

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
| `VALIDATION_FAILED` | 허용 발신 주소가 아닌 `from`(`allowedFrom`·기본 발신 주소 확인), 수신자 형식·수, 제목 길이·CR/LF, 본문 크기, 정의되지 않은 필드, `version`이 1이 아님, `to` 없음, 평문과 `content` 혼용, 복호화한 제목·본문 검증 실패 | 파일을 계약(`docs/api/openapi.yaml`의 `SendRequest`)에 맞춘다. 위치는 이벤트에 없으므로 호출처가 필드를 점검한다 |
| `ATTACHMENTS_NOT_SUPPORTED` | `attachments` 필드가 있다 | 첨부는 지원하지 않는다. 필드를 뺀다 |
| `CALLER_MISMATCH` | JWS·JWE의 `caller`가 폴더 이름(`caller_id`)과 다르다 | `caller`를 호출처 `id`로 맞춘다. 파일을 다른 호출처 폴더에 넣지 않았는지도 본다 |
| `IAT_OUT_OF_RANGE` | JWS `iat`가 허용 기간(기본 7일)보다 오래됐거나 허용 오차(기본 5분)를 넘어 미래다 | 호출처 호스트 시계를 NTP로 맞춘다. 파일을 새로 서명해 다시 넣는다 |

- 고친 파일을 같은 이름으로 다시 넣어도 내용이 다르면 `sha256`이 달라 새 기록이 생긴다. 같은 이름·같은 내용을 다시 넣으면 새 거부 기록과 이벤트가 생기지 않고 원본만 삭제된다. 고치지 않은 같은 파일을 재투입하지 않는다.
- `idempotencyKey`는 파싱할 수 있고 형식을 지킨 경우에만 이벤트에 들어간다. 서명이 `required`인 호출처에서 서명을 확인하지 못한 파일은 Key 없이(`null`) 나온다. `fileName`으로 찾는다.

REST의 400 `validation-failed`는 `errors[]`에 `pointer`(또는 `parameter`)와 `code`를 준다. 코드: `REQUIRED`, `INVALID_FORMAT`, `TOO_LONG`, `TOO_MANY`, `TOO_LARGE`(복호화 뒤 1 MiB 초과), `CONTROL_CHARACTER`(제목·주소의 CR/LF), `UNKNOWN_FIELD`(`pointer`는 빈 문자열), `ATTACHMENTS_NOT_SUPPORTED`, `CONFLICTING_FIELDS`, `DECRYPTION_FAILED`, `KID_UNKNOWN`, `CALLER_MISMATCH`, `FROM_NOT_ALLOWED`(`pointer`는 `/from`, 요청의 `from`이 호출처의 허용 발신 주소가 아니다. `callers.json`의 `allowedFrom`을 확인한다). 복호화 관련 코드의 위치는 `/content`다. 409는 거부 기록이 아니라 응답이며 본문의 `jobId`가 먼저 등록된 작업이다.

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
- 호출처가 30일 넘게 폴링하지 않으면 그 사이 이벤트가 삭제됐다. 이 경우는 작업 상태 조회로 보완한다(Key 보존도 종결 후 30일이다).

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
-- 우선순위 점유 인덱스 유효성. valid가 false이거나 행이 없으면 아래 복구를 한다
SELECT c.relname, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname = 'mail_jobs_priority_claim_idx';
```

해석:

- `LOW`의 `oldestDueAgeSeconds`만 커지는 것은 정상 동작이다. 대기 순서 경로가 처리량의 일부(claim 호출의 약 10%)만 오래된 작업에 준다.
- 굶음의 한계: 유입이 처리량보다 많은 상태가 이어지면 낮은 등급 작업은 만료 시각(기본 24시간, `MAILO_JOB_EXPIRY_SECONDS`)을 넘겨 `EXPIRED`가 될 수 있다. 조치는 처리량을 늘리거나(`MAILO_WORKER_CONCURRENCY`), 호출처가 등급을 용도대로 쓰게 하거나(`caller-onboarding.md` "우선순위"), `MAILO_CLAIM_FIFO_RATIO`를 올리는 것이다. 값을 바꾸면 재시작이 필요하다.
- 모든 작업이 `URGENT`이면 등급 효과가 없다. Mailo에는 호출처별 등급 제한이 없다(RQ-033). 등급별 상태 분포를 호출처별로 나눠 보려면 위 첫 SQL에 `caller_id`를 더한다.

인덱스 복구. 마이그레이션 실행기는 `-- mailo:no-transaction` 파일을 실행한 뒤 현재 schema에 `INVALID` 인덱스가 있으면 기록하지 않고 실패한다(fail-closed, `src/db/migrator.ts`). 오류 메시지에 인덱스 이름이 있다. `IF NOT EXISTS`가 `INVALID` 인덱스를 건너뛰고 적용으로 기록되는 것을 막기 위해서다. 이 실패는 앱 기동 실패(`migrate-cli` 종료)로 보인다.

1. 오류 메시지의 인덱스를 지운다.
   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS mail_jobs_priority_claim_idx;
   ```
2. `CONCURRENTLY`가 실패한 원인을 없앤다(잠금 대기 `55P03`이면 긴 트랜잭션을 확인한다).
3. 마이그레이션을 다시 실행한다(컨테이너 재시작 또는 `pnpm --filter @cp949/mailo migrate`). `0005`가 다시 실행돼 기록된다.

수동으로 만든 인덱스가 위 조회에서 `valid = false`이면 같은 방법으로 지우고 다시 만든다.

```sql
CREATE INDEX CONCURRENTLY mail_jobs_priority_claim_idx
  ON mail_jobs (priority DESC, next_attempt_at, id) WHERE status IN ('PENDING', 'RETRY_WAIT');
```

```txt
위험도: 중간 (인덱스 재생성. 쓰기는 막지 않지만 큰 테이블에서 오래 걸린다)
롤백: 불필요. 인덱스가 없는 동안 우선순위 점유가 느려질 뿐 동작은 같다
```

## 호출처 할당 초과

신호: `caller_quota_exceeded`(warn, `callerId`, `limit`)는 할당을 넘긴 호출처가 새로 생겼을 때 한 번, `caller_quota_recovered`(info, `callerId`)는 풀렸을 때 한 번 남는다. 폴링마다 반복되지 않는다.

- 사용량 = 최근 24시간의 "할당에 드는 시도" + 현재 `SENDING` 작업 수다. 할당에 드는 시도는 시도 횟수에 포함되는(`counted`) 시도 중 Mailo 내부 오류(`stage = 'WORKER'`)를 뺀 것이다. 차단기를 연 계정 상태 오류 시도(`ACCOUNT`, `counted = false`)는 들지 않고, 차단기가 `closed`로 남은 계정 상태 오류 시도(`counted = true`)와 `TRANSIENT`·`PERMANENT`·`LEASE_EXPIRED`는 든다.
- 초과한 호출처의 작업은 점유되지 않고 `PENDING`·`RETRY_WAIT`에 머문다. 상태, 시도 횟수, `next_attempt_at`은 바뀌지 않는다. 다른 호출처에는 영향이 없다.
- 가장 오래된 시도가 24시간을 넘기면 한 건씩 풀린다. 그 전에 만료 시각(기본 24시간)에 이르면 `EXPIRED`가 된다. 할당이 처리량보다 작으면 만료가 쌓인다.
- 조치: `callers.json`의 `sendQuota24h`를 늘리거나, 호출처의 발송량을 줄이거나, 만료 TTL(`MAILO_JOB_EXPIRY_SECONDS`)을 조정한다. 값을 바꾸면 재시작이 필요하다.

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

- 인스턴스가 여럿이면 각 단계(`sweep_expired`, `lease_recovered`, 본문 삭제 `bodies_deleted`, 보존 삭제 `records_deleted`)는 배치마다 DB advisory lock을 잡은 인스턴스만 돌린다. 못 잡은 인스턴스는 기다리지 않고 건너뛰므로 로그에 `count`가 없다. 배치는 최대 1,000건이다(ADR-0002 구현 중 확정 10).
| `bodies_deleted` | 종결 후 유예가 지난 작업의 본문을 비웠다 |
| `records_deleted` | 보존 기간이 지난 작업 행(시도·이벤트 포함)과 거부 기록을 삭제했다 |
| `<이름>_failed`(error) | 위 작업의 실패. `error`에 오류 이름 |

그 밖의 Worker 로그: `worker_started`, `worker_paused`(`inFlight`, 종료 신호 직후 새 점유 중지), `worker_stopping`, `worker_stopped`(`drained`), `job_completed`(`jobId`, `status`, `classification`, `probe`), `poll_loop_crashed`, `maintenance_loop_crashed`.

## 검증하지 않은 것

- 위 신호와 SQL을 운영 환경에서 실행해 결과를 확인하지 않았다. "등급별 적체"의 SQL은 로컬 PostgreSQL 17의 테스트 schema에서 실행해 문법과 결과 열을 확인했다(2026-11-23). 로그 이벤트 이름과 필드는 코드와 통합 테스트(차단기, 할당, 파일 폴러)로 확인했다. `breaker_not_closed`는 `worker/worker.integration-spec.ts`가 단언한다.
- 실제 Gmail의 응답 코드·텍스트로 `lastReason` 분류를 대조하지 않았다(ADR-0007 구현 중 확정 2).
- 긴 트랜잭션의 원인 목록(`pg_dump`, prepared transaction)은 일반 지식이며 Mailo 피드로 재현하지 않았다.
