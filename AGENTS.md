# Mailo

Gmail·Google Workspace SMTP로 이메일을 비동기 발송하는 단일 서비스. 전역 규칙은 `~/.claude/CLAUDE.md`를 따르고 여기서는 이 저장소 규칙만 적는다.

## 구조

- pnpm + turbo 모노레포. 앱은 `apps/mailo`(NestJS, TypeScript strict, ESM) 하나다.
- 패키지를 새로 나누지 않는다. 모듈 경계는 `apps/mailo/src/` 디렉터리로 둔다(RQ-029).
- 모듈: `intake`(REST), `queue`(claim·lease 복구·완료 기록·sweep·차단기 저장소·재시도 백오프 계산 `retry-policy.ts`), `worker`(점유·전송·기록 루프, 종료 drain, 설정→Worker·SMTP 옵션 조립), `smtp`(전송·단계 기준 분류), `crypto`(본문 암호화·지문), `envelope`(JWS 서명 검증·JWE 복호화, 수집 공용 파이프라인 `openRequest`·큐 등록 입력 변환 `toRegisterInput`·개인키 키링), `file-channel`(파일 채널 폴러, ADR-0004), `events`, `callers`(레지스트리·API 키), `health`, `config`, `db`(pg 풀·마이그레이션), `http`(problem+json 오류·요청 ID·본문 읽기 공통 처리), `logging`(JSON 로거·Nest 로거 어댑터, 다른 모듈에 의존하지 않는 leaf), `validation`(요청 입력 검증·`ValidationErrorItem`·발신 주소 허용 판정, config와 intake가 공유. envelope는 http에 의존하지 않고 이 타입을 쓴다).
- 각 모듈은 `index.ts`로만 공개한다. 다른 모듈은 `index.ts`를 통해서만 import한다.
- `samples/spring-boot-relay/`는 사용처용 Java 샘플(Gradle)이다. pnpm 워크스페이스, turbo, Mailo CI 대상이 아니고 Mailo 코드를 import하지 않는다. 검증은 `samples/spring-boot-relay/verify/run-e2e.sh`(Docker, JDK 21 필요, 자동 테스트 아님)다.
- 앱 조립은 `app.module.ts`·`app-lifecycle.ts`·`worker-port.ts`가 맡는다. 파일 폴러는 `file-channel/port.ts`의 `FILE_POLLER`로 같은 방식으로 연결한다. `main.ts`는 `createApp({ config, worker: {} })`로 실제 Worker를 켠다. 옵션 없이 만든 앱(테스트 기본값)은 발송하지 않는다.
- 본문 평문 형식은 `{"v":1,"subject","text","html"}` 하나다. `queue`↔`crypto` 연결은 `crypto/queue-adapters.ts` 한 곳이고 Worker·intake도 이 어댑터를 쓴다. 어댑터를 새로 만들지 않는다.
- DB는 PostgreSQL 13 이상(ADR-0006). ORM을 쓰지 않고 `pg`와 순수 SQL을 쓴다.
- Worker가 SMTP에 닿기 전에 낸 Mailo 내부 오류(복호화 실패, 잘못된 작업 데이터)는 `AttemptOutcome`에 `internal: true`를 붙인다. 큐는 이 결과로 차단기를 닫거나 열지 않는다(half_open 대표 작업이 내부 오류로 끝나도 closed로 돌아가면 안 된다).
- 큐 SQL 규칙: 시각은 DB `now()`만 쓴다(ADR-0002 결정 10). 잠금 순서는 작업 행 → `mail_circuit_breaker` 행으로 고정한다(claim·완료 경로 교착 방지). 차단기 저장소는 DB 소유라 `queue/circuit-breaker.ts`에 있고, 사유 분류는 `smtp`가 정해 `AttemptOutcome`으로 넘긴다.
- DB 시간제한: 앱 풀은 `statement_timeout`·`lock_timeout`·`idle_in_transaction_session_timeout`·`query_timeout`·keepAlive를 건다(`MAILO_DB_*_TIMEOUT_MS`). 마이그레이션 CLI는 `statement_timeout` 없이 `lock_timeout`만 건다. 트랜잭션은 `withTransaction`으로 열어 timeout 때 연결이 폐기되게 한다. 결과 기록은 lease 마감(단조 시계)까지 재시도하고 `MAILO_DB_POOL_MAX ≥ MAILO_WORKER_CONCURRENCY + 4`를 기동 때 검사한다.
- `/health/ready`의 200/503에 발송 정지를 반영하지 않는다. 운영자 토큰(`MAILO_OPS_TOKEN`)에만 `queue`·`worker`·`filePoller` 수치를 준다. 점유 루프가 죽으면 정상 종료 경로를 거쳐 종료 코드 70(`fatal-exit.ts`)이다.
- 스키마 변경은 `apps/mailo/migrations/NNNN_이름.sql`에 새 파일로 추가한다. 적용된 파일을 수정하지 않는다. 트랜잭션에서 못 쓰는 문장(`CREATE INDEX CONCURRENTLY`)은 파일 첫 줄에 `-- mailo:no-transaction`을 두고 문장 하나만 쓰며 멱등하게 쓴다(실패하면 기록되지 않아 다시 실행된다. 실행 뒤 현재 schema에 INVALID 인덱스가 있으면 실행기가 기록하지 않고 실패한다).
- 로그: 로거는 `createApp`에서 한 번 만들고(`logging/`), Worker·파일 폴러는 DI(`APP_LOGGER`)로, Nest·HTTP 계층은 어댑터로 받는다. 새 로거를 만들지 않는다. 모든 줄은 `{ts, instance, level, event, ...}` JSON이다. 필드에 요청 값을 넣지 않는다(예외는 `describeError`의 이름·코드만).
- 파일 채널(`file-channel`)은 `MAILO_FILE_CHANNEL_ROOT`가 있을 때만 켜진다(기본 꺼짐). 코드는 폴더를 만들거나 chmod하지 않는다(운영 문서의 몫, ADR-0004 결정 8). 호출처 폴더는 `<root>/inbox/<caller_id>/`이고 레지스트리에서 `fileChannel: true`인 호출처만 읽는다. 파일 열기는 `O_NOFOLLOW|O_NONBLOCK` + `fstat`이고 `lstat` 뒤 `open`을 쓰지 않는다. 원본 삭제는 등록·거부 기록의 DB 커밋 뒤에만 한다. 거부는 `recordIntakeRejection`(거부 기록과 `INTAKE_REJECTED` 이벤트 한 트랜잭션)으로 쓴다. NFS는 같은 호스트 loopback에서만 검증했다(`docs/operations/nfs.md`, ADR-0004 구현 중 확정 20~27). `ESTALE`은 Node가 `code`를 `ESTALE`로 주지 않으므로 `file-channel/errno.ts`의 `isStale`(errno 116)로 판별한다.
- 요청 수집(REST·파일)은 `envelope`의 `openRequest`를 거친다. 순서는 JWS 구조 파싱 → 서명 검증 → 스키마 검증 → 복호화 → 복호화한 제목·본문 검증 → 지문 계산이고 바꾸지 않는다(ADR-0008 결정 3). 서명 실패 시 복호화하지 않는다. 암호 형식은 직접 만들지 않고 `jose`(버전 고정)를 쓴다.
- 호출처 JWS 비밀키와 Mailo JWE 개인키는 설정 JSON에 값을 두지 않는다. JSON은 변수 이름(`secretVar`·`privateKeyVar`)만 갖고 값은 `<변수>_FILE`(우선)이나 `<변수>`로 받는다. 모듈은 `APP_ENV`로 같은 환경을 읽는다.
- 운영 의존성은 Mailo와 PostgreSQL뿐이다. 브로커·외부 메일 서버·새 상시 서비스를 추가하지 않는다(RQ-029). 예외는 개발용 opt-in compose profile(`mailpit`)뿐이고 기본 `docker compose up`에 넣지 않는다. 새 npm 의존성은 필요 이유를 변경 설명에 적는다.

## 명령어

| 목적          | 명령                                                                                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 설치          | `pnpm install`                                                                                                                                                                                                                               |
| 빌드          | `pnpm build`                                                                                                                                                                                                                                 |
| 타입 검사     | `pnpm typecheck`                                                                                                                                                                                                                             |
| 린트          | `pnpm lint`                                                                                                                                                                                                                                  |
| 포맷          | `pnpm format` / `pnpm format:check`                                                                                                                                                                                                          |
| 단위 테스트   | `pnpm test` (`test/**/*.spec.ts`)                                                                                                                                                                                                            |
| 통합 테스트   | `docker compose up -d postgres` 뒤 `pnpm test:integration` (`test/**/*.integration-spec.ts`, e2e는 `test/e2e/`)                                                                                                                              |
| NFS 테스트    | `apps/mailo/scripts/nfs/run.sh`(환경 준비·실행·정리, 비밀번호 없는 sudo 필요). 환경이 있으면 `pnpm test:nfs` (`test/nfs/*.nfs-spec.ts`, `pnpm test:integration`에 포함되지 않음)                                                             |
| 마이그레이션  | `pnpm --filter @cp949/mailo migrate` (`MAILO_DATABASE_URL` 필요)                                                                                                                                                                             |
| 컨테이너 실행 | `.env.example`을 `.env`로 복사하고 키를 바꾼 뒤(공개 샘플 키·DB 비밀번호는 `NODE_ENV`가 development·test가 아니면 기동 거부, 로컬 시험은 `NODE_ENV=development`. compose는 `POSTGRES_PASSWORD`가 없으면 중단) `docker compose up -d --build` |
| CI            | `.github/workflows/ci.yml`. 잡 구성·로컬 재현은 `docs/operations/ci.md`. 워크플로를 바꾸면 이 문서와 함께 갱신한다. 액션은 SHA로 고정한다                                                                                                    |

- 통합 테스트는 실제 PostgreSQL을 쓴다. 접속 URL은 `MAILO_TEST_DATABASE_URL`이고 기본값은 compose 개발 값이다. 서버가 없으면 skip하지 않고 실패한다.
- 테스트 파일마다 `test/support/database.ts`의 전용 schema를 쓴다.

## 문서와 요구사항 갱신

- 요구사항 `docs/requirements/mail-sending.md`와 결정 `docs/adr/`는 `docs/`에 있다. 구현 변경과 같은 변경에서 해당 RQ의 진행 상태와 수용 조건 체크를 갱신한다.
- `[x]`는 코드와 자동 검증으로 수용 조건을 확인한 항목에만 쓴다.
- 승인된 ADR의 결정 문구는 고치지 않는다. 결정을 바꾸면 새 ADR을 추가하고 이전 ADR의 상태 절에 대체 관계를 적는다.
- 허용하는 ADR 수정: 상태 절의 대체·구현 상태 표기, 결정 옆의 "대체됨" 표기, 날짜를 단 "구현 중 확정" 절 추가. 결정 문구 자체는 바꾸지 않고 확정 내용은 이 절들에만 쓴다.
- 구현이 ADR·RQ와 충돌하면 코드를 문서에 맞추거나, 문서 변경안을 사용자에게 제시한다. 둘 중 하나를 조용히 어긋나게 두지 않는다.
- 요구사항 ID(`RQ-NNN`)와 ADR 번호를 코드 주석과 테스트 제목에서 참조한다.
- 환경 변수, 로그 이벤트 이름, 레지스트리 필드, 키 변수 이름, 마운트 경로를 바꾸면 같은 변경에서 `docs/operations/`의 해당 문서(`deployment.md`, `key-management.md`, `caller-onboarding.md`, `troubleshooting.md`)를 갱신한다.

## 시크릿과 로그

- 메일 본문, 제목, 수신자 주소, SMTP 인증 정보, API 키 평문, 암호화 키를 로그·오류 메시지·이벤트·거부 기록에 남기지 않는다(RQ-027).
- 검증 오류와 복호화 실패에는 원문을 넣지 않고 식별자(작업 ID, `caller_id`)와 사유 코드만 쓴다.
- 이 규칙을 검증하는 테스트는 본문·비밀번호에 canary 문자열을 넣고 로그에서 검색한다.
- `.env`는 추적하지 않는다. `.env.example`과 테스트 픽스처의 시크릿은 가짜 값만 쓴다.
- 이미지에 SMTP 인증 정보와 키를 넣지 않는다(RQ-025).

## 컨테이너

- `docker-compose.yml`의 `stop_grace_period`는 `${MAILO_STOP_GRACE_PERIOD:-150s}`이고 lease(`MAILO_LEASE_SECONDS`) 이상이어야 한다(ADR-0002 결정 12). lease 값을 바꾸면 이 변수도 바꾼다. 앱이 같은 변수를 읽어 어긋나면 기동을 거부한다(변수가 있을 때만).
- 컨테이너는 non-root(`node`)로 실행하고 `read_only: true`(쓰기는 `/tmp` tmpfs와 파일 채널 마운트뿐), `cap_drop: [ALL]`, `no-new-privileges`를 쓴다. 이미지의 `/repo`는 root 소유이고 `chown`하지 않는다. `Dockerfile`의 base 이미지는 digest로 고정하고 `packageManager`는 sha512 해시를 가진다(갱신 절차는 `Dockerfile` 머리 주석). 앱이 쓸 경로를 새로 만들면 그 경로만 마운트·tmpfs로 연다.
- compose는 DB 접속을 `MAILO_DB_*` 분리 변수로 준다(앱이 URL 인코딩해 조립). `MAILO_DATABASE_URL`과 `MAILO_DB_HOST`를 함께 주면 기동을 거부한다. 컨테이너 종료·중복 발송 검증은 `scripts/container/`(Docker 필요, 자동 테스트 아님)다.
- 종료 순서는 Worker `pause()`(새 점유 중지, 진행 중 전송 계속) → HTTP 서버 닫기·파일 폴러 정지(진행 중 파일 완료) → Worker drain(`lease - 10초` 상한, `pause()` 시점부터 센다) → DB 풀 닫기다. `stop_grace_period`는 drain 상한 + 10초 이상이어야 한다. HTTP 요청·헤더 수신 시간제한은 30초이고 종료 때 이 시간이 지나면 남은 연결을 끊는다. drain 상한이 지나도 lease는 풀지 않는다(다음 claim이 만료로 회수).
- 로컬 SMTP 서버 대상 검증은 STARTTLS 인증서가 필요하다. 컨테이너에는 `NODE_EXTRA_CA_CERTS`로 CA를 주고, 호스트는 IP로 지정한다(`/etc/hosts`에만 있는 이름은 nodemailer 조회에서 실패했다).

## 브랜치

- 작업 브랜치는 `dev`다. 새 작업 브랜치는 `dev`에서 분기한다. `dev`→`main` 병합과 push는 사용자가 지시한다.

## Agent skills

### Issue tracker

이슈는 GitHub Issues(`cp949/mailo`)에 두고 `gh` CLI를 쓴다. 등록 기준, 쓰기 승인, 작업 완료 시 자동 종료 절차는 `docs/agents/issue-tracker.md`.

### Triage labels

표준 5개 역할(`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`)을 라벨 이름 그대로 쓴다. 다섯 라벨 모두 저장소에 있다. `docs/agents/triage-labels.md`.

### Domain docs

single-context. 용어 기준은 `docs/requirements/mail-sending.md`의 "용어와 진행 상태" 절이고 `CONTEXT.md`는 없다. `docs/agents/domain.md`.

### 문서·주석 작성

소스·테스트 주석과 `docs/` 문서를 새로 쓰거나 고칠 때 `docs/agents/writing-styles.md`를 따른다.

### 테스트와 검증

테스트 작성 규칙, 검증 단계(L0~L3), 변경 영역별로 돌릴 컨테이너·NFS·샘플 검증은 `docs/agents/testing.md`.
