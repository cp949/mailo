# Mailo 이메일 발송 요구사항

## 목적과 범위

Mailo는 Gmail·Google Workspace SMTP로 이메일을 비동기 발송하는 경량 독립 서비스다.
이 문서는 Mailo의 요구사항과 수용 조건을 정의한다.

| 담당       | 범위                                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| Mailo      | 발송 요청 수집, 영속 큐, SMTP 발송, 재시도, 중복 등록 방지, 상태 추적, 알림 |
| 사용처     | 비즈니스 트랜잭션, 발송 요청의 원자성(outbox + relay), 최종 사용자 인증·권한 |

핵심 목표는 다음 다섯 가지다.

1. 안정적인 이메일 발송
2. 자동 재시도 및 만료 처리
3. `Idempotency-Key` 기반 중복 요청 방지
4. 영속적인 큐와 장애 복구
5. 발송 상태 추적 및 최종 실패 알림

범위 밖:

- Postfix 등 외부 메일 서버 사용.
- 수신자 구간의 종단 간 암호화(S/MIME, PGP).
- SMTP 수락 이후의 반송(Bounce) 추적. 별도 기능으로 검토한다.

근거 문서:

- [ADR-0001](../adr/0001-no-shared-db-and-input-channels.md): 구현 형태, DB 비공유, 입력 채널, 보장 범위, 암호화.
- [ADR-0002](../adr/0002-postgres-queue-and-job-state-model.md): 큐 저장소, 작업 점유, lease 복구, 상태 전이.
- [ADR-0003](../adr/0003-retry-and-error-classification.md): 오류 분류, backoff, 만료 처리, 시도 기록. 결정 1~4·7은 ADR-0007이 대체한다.
- [ADR-0004](../adr/0004-file-channel-design.md): 파일 채널 폴더 구조, 쓰기·수집 절차, 접근 통제, 서명. `rejected/`는 ADR-0006이, HMAC 서명은 ADR-0008이 대체한다.
- [ADR-0005](../adr/0005-idempotency-key-contract.md): Key 필수화, 내용 지문, REST 응답 계약, Key 보존. ADR-0002 결정 3의 충돌 처리를 대체한다.
- [ADR-0006](../adr/0006-job-lookup-event-feed-and-intake-rejections.md): 작업 조회, 종결 이벤트 피드, 수집 거부 기록.
- [ADR-0007](../adr/0007-smtp-stage-classification-and-circuit-breaker.md): SMTP 단계 기준 분류, 전역 차단기.
- [ADR-0008](../adr/0008-jwe-jws-envelope-and-db-encryption.md): JWE·JWS 형식, DB 본문 암호화, 본문 삭제.

ADR-0001~0008은 모두 승인됐다(2026-11-23).

## 용어와 진행 상태

| 용어            | 의미                                                              |
| --------------- | ----------------------------------------------------------------- |
| 사용처          | Mailo에 발송을 요청하는 호출 서버. 예: Spring Boot 애플리케이션   |
| 발송 작업       | 발송 요청 한 건. 고유 ID를 가진다                                 |
| 입력 채널       | 사용처가 발송 요청을 전달하는 경로. REST, 파일                    |
| `Idempotency-Key` | 같은 발송 요청의 중복 등록을 막는 사용처 지정 키                |
| outbox + relay  | 사용처 DB에 요청을 쓴 뒤 커밋 후 Mailo로 전달하는 사용처 쪽 패턴  |
| 봉투 암호화     | 본문을 일회용 키로 암호화하고 그 키를 Mailo 공개키로 암호화하는 방식 |
| 이벤트 피드     | 사용처가 `GET /events`로 종결 이벤트와 수집 거부를 pull하는 방식 |
| 전역 차단기     | SMTP 계정 단위 장애 때 모든 Worker의 점유를 멈추는 DB 행 하나의 상태 |

상태 판정:

- 진행 상태는 `미착수`·`진행 중`·`검증 완료`·`보류`로 구분한다.
- `[x]`는 코드와 자동 검증으로 수용 조건을 확인한 항목이다.
- `[ ]`는 갭 또는 필요한 검증이 남은 항목이다.
- 요구사항이나 구현이 바뀌면 같은 변경에서 RQ 상태를 갱신한다.
- `RQ-NNN`은 요구사항 ID다.
- 진행 상태 옆의 `(N단계)`는 구현 단계다. 아래 구현 단계 절을 따른다.
- 수치 기본값은 별도 표시가 없으면 설계 시점의 추정이며 설정으로 바꿀 수 있다. 측정·검증 뒤 갱신한다.
- `검증 완료`는 해당 RQ의 수용 조건이 모두 `[x]`일 때만 쓴다. 일부 조건이 2단계·3단계 구현이나 문서에 걸려 있으면 `진행 중`이다.
- 판정 근거의 테스트 경로는 `apps/mailo/test/` 기준이다. `*.spec.ts`는 단위 테스트, `*.integration-spec.ts`는 PostgreSQL 통합 테스트다.
- 검증 수치(2026-11-23 코드 리뷰 1묶음 반영 뒤): `pnpm test` 단위 449건(25개 파일), `pnpm test:integration` 통합 242건(18개 파일), 실패 0건. 이 묶음 뒤 `scripts/container/verify-sigterm-file.sh`·`verify-sigkill-duplicate.sh`를 각 1회 실행해 기대와 일치했다(`POSTGRES_PASSWORD` 필수화·`MAILO_STOP_GRACE_PERIOD` 반영 compose). `pnpm test:nfs`·`scripts/volume/`은 이 묶음에서 실행하지 않았다.
- 직전 수치(2026-11-23 최종 마무리 실행 결과): `pnpm test` 단위 407건(23개 파일), `pnpm test:integration` 통합 222건(15개 파일, 파일 채널 `file-channel/poller.integration-spec.ts`, `e2e/file-flow.integration-spec.ts`, 호출처 할당 테스트 포함), `pnpm test:nfs`는 NFS 환경이 정리돼 이번에 실행하지 않았다(직전 3단계 마무리 실행 31건, NFSv4.1·4.2 기본값 각각, 실패 0건). 볼륨 스크립트(`scripts/volume/`, a~g)는 CI 워크플로 작성 뒤 2026-11-23에 7개 실행(acl·group 포함)을 모두 다시 실행해 기대와 다름 0건이었다. 컨테이너 스크립트 `scripts/container/`(SIGKILL 중복 발송, SIGTERM 파일 처리)도 같은 날 종료 순서(pause 선행)·compose 기본값 변경 뒤 각 1회 실행해 기대와 일치했다. 단위·통합 실패는 0건이다.
- 수치 이력: 1단계 마무리 뒤 단위 274건·통합 116건(종단 `e2e/mail-flow.integration-spec.ts` 7건 포함), 파일 채널 폴러 구현 뒤 단위 370건·통합 199건. 1단계 마무리 때 쓰지 않던 `smtp/backoff.ts`와 그 테스트를 지워 단위가 이전 보고(287건)보다 13건 줄었다.
- 모든 SMTP 검증은 로컬 `smtp-server` 대상이다. 실제 Gmail·Workspace SMTP와 실제 NAS 제품은 확인하지 않았다. NFS는 같은 호스트 loopback에서 `pnpm test:nfs`로 확인했다(ADR-0004 구현 중 확정 20~27, `docs/operations/nfs.md`). 이 테스트와 `scripts/volume/` 스크립트는 `pnpm test`·`pnpm test:integration`에 포함되지 않는다. GitHub Actions 워크플로(`.github/workflows/ci.yml`, `docs/operations/ci.md`)에 연결하는 코드를 작성했으나 GitHub에서 실행해 본 적이 없다.
- 2026-11-23 3단계 마무리에서 RQ-003·004·013·016·021·022·024·028·032와 문서 정합을 갱신했다(운영 문서 `docs/operations/`).

## 구현 단계

| 단계 | 범위 |
| ---- | ---- |
| 1단계 | REST 등록·조회·이벤트 피드, 큐·Worker, ADR-0005·0007 규칙, DB 본문 암호화(ADR-0008 결정 6·7), 호출처별 API 키 인증 |
| 2단계 | 파일 채널(같은 호스트 볼륨), JWS, JWE, 호출처별 발송 할당(RQ-032) |
| 3단계 | NAS/NFS 통합 테스트, 사용처 연동 문서와 운영 문서 |

- 이유: Key, 오류 분류, 차단기를 파일시스템 변수 없이 먼저 검증한다. JWE는 선택 기능이다.
- NAS/NFS 수용 조건과 문서 수용 조건은 해당 RQ의 구현 단계와 무관하게 3단계에 확인한다.

1단계 구현 상태(2026-11-23 갱신):

- 구현·테스트 완료: REST 등록·조회·이벤트 피드·헬스, 큐(점유·lease·sweep·보존 삭제), Worker, SMTP 분류, 전역 차단기, DB 본문 암호화, 호출처별 API 키.
- 피드 지연 메트릭(RQ-017): 인증된 `/health/ready`의 `eventFeed` 필드로 구현했다. 로그·외부 메트릭 시스템으로는 내보내지 않는다.
- 미실행 검증: 컨테이너 재생성(RQ-026), 실제 Gmail·Workspace SMTP(RQ-005·009). 컨테이너 기동·SIGTERM·SIGKILL은 `scripts/container/`로 2026-11-23에 실행했다(RQ-013·018·020·025).
- 앱 전체 경로를 잇는 종단 테스트(`e2e/mail-flow.integration-spec.ts`) 7건은 위 통합 테스트 실행에서 통과했다.
- 미검증 목록: 실제 Gmail·Workspace SMTP, 실제 NAS 제품(NFS loopback만 확인), 2단계·3단계 RQ. SIGKILL로 인한 실제 중복 발송은 2026-11-23 컨테이너에서 관찰했다(RQ-013).

2단계 구현 상태(2026-11-23 갱신, 봉투 모듈):

- 구현·테스트 완료: `envelope`(JWS 검증, JWE 복호화, `openRequest` 파이프라인, 개인키 키링), REST JWE(`content`), 호출처 JWS 비밀키 참조, `iat` 기간의 기동 검증(RQ-022·024의 REST·검증 함수 부분).
- 미구현: 없음. 파일 채널 폴러는 아래 "2단계 구현 상태(파일 채널)"에서 구현했다.
- 이 변경 직후 `pnpm test` 단위 351건, `pnpm test:integration` 148건 통과, 실패 0건. `format:check`, `typecheck`, `lint`도 통과했다. 같은 시점에 다른 작업(RQ-032)의 테스트가 포함된 수치다.

2단계 구현 상태(2026-11-23 갱신, 파일 채널 폴러):

- 구현·테스트 완료: `file-channel`(폴링 수집기, 읽기 안전 장치, 거부 기록, 임시 파일 정리, 호출처별 배치 상한, 앱 수명 주기 연결). 설정은 `MAILO_FILE_CHANNEL_ROOT`가 있을 때만 켜진다.
- 확인한 환경: WSL2 로컬 파일시스템의 임시 디렉터리와 PostgreSQL 17. 같은 호스트 Docker named volume(ext4)은 2026-11-23 3단계에서 `scripts/volume/`으로 확인했다(ADR-0004 구현 중 확정 13~19). bind mount는 확인하지 않았다. NFS(같은 호스트 loopback, NFSv4.1·4.2, `root_squash`, non-root UID)는 2026-11-23 3단계에서 `apps/mailo/scripts/nfs/`·`pnpm test:nfs`로 확인했다(ADR-0004 구현 중 확정 20~27).
- 확인하지 않은 것: 실제 NAS 제품, 서버 재시작·failover, bind mount·rootless Docker의 권한 모델, 실제 SIGTERM을 받은 프로세스의 종료.
- 구현 세부와 추정과 다른 점은 ADR-0004 "구현 중 확정"에 있다.

3단계 구현 상태(2026-11-23 갱신):

- 구현·검증 완료: NAS/NFS loopback 통합 테스트(`pnpm test:nfs` 31건, NFSv4.1·4.2 각각), 같은 호스트 Docker named volume 권한·e2e 스크립트(`scripts/volume/` 7항목 a~g), `ESTALE` 처리 수정(`file-channel/errno.ts`), 호출처별 발송 할당(RQ-032).
- 문서: 운영 문서 `docs/operations/`(README, deployment, key-management, caller-onboarding, troubleshooting, nfs), 사용처 연동 지침(`caller-onboarding.md`의 outbox + relay, 이벤트 피드 소비, Key 조회 404 처리).
- 권한 문구: 사용자 위임 결정으로 ADR-0004 결정 8과 RQ-024에 "default ACL 권장, 공용 그룹 + setgid는 대안" 보완 표기를 달았다(ADR-0004 구현 중 확정 28).
- 미검증 목록: 실제 Gmail·Workspace SMTP, 실제 NAS 제품(서버 재시작·failover, NFSv3·4.0·Kerberos 포함), GitHub 호스티드 러너(워크플로는 작성만 했고 실행하지 않았다), bind mount·rootless Docker, 호스트 외 환경. Java 사용처 샘플(`samples/spring-boot-relay/`)은 컴파일하고 이 저장소의 Mailo와 실행해 확인했다(RQ-021·022, 확인한 범위는 각 RQ의 판정 근거). SIGKILL 중복 발송과 컨테이너 SIGTERM은 로컬 Docker에서 관찰했다.

## 1. 입력 채널과 경계

### RQ-001 REST 입력 채널

- [x] **진행 상태:** 검증 완료 (1단계)

**요구사항:**

- 사용처는 REST API로 발송 요청을 등록할 수 있어야 한다.
- 요청에 `Idempotency-Key` 헤더를 반드시 지정해야 한다.
- 등록 응답은 발송 작업 ID를 반환해야 한다.
- 응답 코드는 ADR-0005 결정 5를 따른다. 새 작업 등록은 202, 같은 Key와 같은 내용은 200, 같은 Key와 다른 내용은 409다. Key 누락과 검증 오류는 400, 인증 실패는 401, 요청 크기 초과는 413, Mailo 내부 오류는 503이다.

**수용 조건:**

- [x] 수신자·제목·본문을 포함한 요청이 등록되고 발송 작업 ID가 반환된다(202).
- [x] `Idempotency-Key`가 없는 요청은 등록되지 않고 400으로 거부된다.
- [x] 필수 값이 없거나 형식이 잘못된 요청은 등록되지 않고 400으로 거부된다.
- [x] 호출자 자격이 없는 요청은 401로 거부된다.
- [x] 크기 상한을 넘은 요청은 413으로 거부된다.
- [x] DB 장애 때 503으로 응답하고 작업이 반쯤 등록된 상태가 남지 않는다. (503은 테스트로 확인했다. 반쯤 등록된 상태는 등록이 단일 `INSERT` 문이라 구조상 생기지 않으며 중간 실패 주입 테스트는 없다.)

**판정 근거:**

- `http/rest-intake.integration-spec.ts`: 202·`Location`, Key 누락 400, 검증 오류 400, 인증 실패 401, 원시 크기 초과 413(chunked 포함), DB 연결 불가 503.
- 부분 등록 상태는 등록이 단일 `INSERT` 문(`queue/register.ts`)이라 생기지 않는다. 중간 실패 주입 테스트는 없다.
- 2026-11-23 문서 정합: 상태가 `검증 완료`인데 수용 조건 체크가 `[ ]`로 남아 있던 불일치를 위 근거에 맞춰 `[x]`로 고쳤다. 새 검증은 하지 않았다.

### RQ-002 파일 입력 채널

- [ ] **진행 상태:** 진행 중 (2단계, 같은 호스트 로컬 파일시스템과 Docker named volume을 확인. NFS는 loopback에서 확인, 실제 NAS 미확인)

**요구사항:**

- 사용처는 지정한 폴더에 발송 요청을 파일로 저장해 등록할 수 있어야 한다.
- Mailo는 폴더를 주기적으로 확인해 파일을 큐에 등록해야 한다.
- 일부만 쓰인 파일을 수집하지 않아야 한다.
- 수집을 거부한 파일은 거부 기록과 `INTAKE_REJECTED` 이벤트를 남기고 원본을 삭제하며, 무한 재처리하지 않아야 한다(ADR-0006).
- 첨부파일은 지원하지 않는다. `attachments` 필드가 있는 파일은 수집 거부한다.

**수용 조건:**

- [x] 점(`.`)으로 시작하는 임시 이름으로 쓴 뒤 같은 폴더 안에서 `*.json`으로 rename한 파일만 수집된다.
- [x] `Idempotency-Key`가 없는 파일은 등록되지 않고 거부 기록과 `INTAKE_REJECTED` 이벤트가 남는다.
- [x] 심볼릭 링크와 등록되지 않은 호출처 폴더의 파일은 수집되지 않는다. 원시 크기 상한(RQ-030)을 넘은 파일은 수집 거부한다.
- [ ] 같은 호스트 볼륨(2단계)과 NAS/NFS 폴더(3단계) 모두에서 수집된다. (같은 호스트 Docker named volume은 확인했다: 실제 Mailo 컨테이너 e2e 15개 확인, 두 방식 모두 통과, 임시 이름·rename 가시성 포함. `scripts/volume/verify-e2e.sh`이고 jest 통합 테스트에는 없다. CI 워크플로 `container` 잡에 연결했으나 GitHub에서 실행하지 않았다. bind mount와 실제 NAS는 확인하지 않았다. NFS loopback(NFSv4.1·4.2)은 `pnpm test:nfs`로 확인했다: 호출처 UID가 NFS에 rename한 파일을 별개 NFS 클라이언트의 Mailo가 수집·삭제하고, 기존 폴더 rename 가시성은 mount 옵션과 무관하게 7~13 ms, 새 폴더는 기본 mount 옵션에서 31초라 `lookupcache=pos`를 권장한다. `nfs` 잡(수동·주 1회, 선택)을 작성했으나 GitHub에서 실행하지 않았다.)
- [x] 수집한 파일은 큐 등록 후 입력 폴더에서 사라진다.
- [x] 큐 등록 후 파일 정리 전에 Mailo가 종료돼 같은 파일이 다시 수집돼도 중복 등록되지 않는다.
- [x] 형식이 잘못된 파일은 거부 기록과 `INTAKE_REJECTED` 이벤트를 남기고 원본이 삭제되며 재처리되지 않는다.
- [x] 거부 기록은 `(caller_id, 파일 이름, sha256)`으로 멱등하게 써진다. 기록 커밋 후 원본 삭제 전에 Mailo가 종료돼도 같은 거부가 두 번 기록되지 않는다.
- [x] 같은 Key에 다른 내용인 파일은 수집 거부로 처리된다.
- [x] 본문에 canary 문자열을 넣은 형식 오류 파일을 수집시킨 뒤, 로그와 거부 기록에서 canary가 검색되지 않는다.

**판정 근거:**

- `file-channel/poller.integration-spec.ts`(실제 PostgreSQL + 임시 디렉터리): 정상 JSON(서명 none)·JWS·JWE 수집과 삭제, 점 임시 파일·비json(`.txt`, `.json.tmp`, `.JSON`) 무시, 일부만 쓴 임시 이름 파일은 rename 전에 수집하지 않음, 등록되지 않은 폴더와 `fileChannel: false` 호출처 폴더 무시, FIFO(`mkfifo`)가 폴러를 멈추지 않음, 심볼릭 링크·하드링크는 읽지 않고 거부하며 대상 파일은 그대로, 크기 상한 정확히 일치는 수집·1바이트 초과는 `SIZE_EXCEEDED`, rename 뒤 덧쓴 파일의 크기 초과, 사유별 거부 기록과 이벤트(형식 오류·Key 누락·Key 형식·`attachments`·입력 검증·CR/LF·서명 없음·서명 불일치·`iat`), 같은 Key의 다른 내용은 `FINGERPRINT_MISMATCH`, 등록 직후 삭제 전 종료(`beforeDelete` 훅이 던짐)와 재수집의 중복 걸러내기, 거부 기록 커밋 직후 종료와 재수집의 멱등, 같은 이름·같은 내용 재투입은 기록 1건, 두 폴러 동시 수집(30건, 건마다 1건 등록), 삭제 직전 파일 교체 시 새 파일을 지우지 않음.
- 같은 파일의 canary 테스트: 형식 오류·검증 실패·서명 불일치·크기 초과·심볼릭 링크·JWE 변조·JWE `caller` 불일치 파일의 본문 canary가 로그, 거부 기록, 이벤트, 작업 행, 이벤트 피드에 없다.
- `file-channel/poller.integration-spec.ts`(코드 리뷰 반영, ADR-0004 구현 중 확정 29·30): 읽을 수 없는 호출처 폴더 3곳 뒤의 호출처 수집, 읽을 수 없는 파일이 배치 상한을 채워도 뒤 정상 파일 수집, 상한보다 많은 임시 점 파일 정리, `link` 게시 파일이 `unlink` 전에 폴링되면 거부됨(재현).
- `file-channel/read-file.spec.ts`: open 플래그·`fstat` 판정·상한 + 1바이트 읽기와 sha256 정책, 연 뒤 지워진 파일(`nlink` 0)은 하드링크가 아니라 `gone`(ADR-0004 구현 중 확정 31, 두 폴러 동시 수집 테스트가 CI에서 간헐 실패하던 결함).
- `e2e/file-flow.integration-spec.ts`: 파일 → 폴러 → Worker → 로컬 smtp-server → `GET /jobs?idempotencyKey=`·`GET /events`(`JOB_SENT`), 거부 파일의 `INTAKE_REJECTED`와 Key 조회 404, REST와 파일의 같은 Key는 한 작업, 앱 종료 때 폴러 정지, root가 없으면 기동 실패.
- 구현 세부와 추정과 다른 점: ADR-0004 "구현 중 확정".
- Docker named volume(2026-11-23, `scripts/volume/verify-e2e.sh`, `verify-atomic-rename.sh`): Mailo(UID 1000)·호출처 B(10002)·C(10003)가 볼륨 하나를 공유한 상태에서 파일 → 폴링 → 발송 → 삭제 e2e를 default ACL·공용 그룹 두 방식으로 각 15개 확인해 모두 통과했다. 같은 요청은 1회만 발송, 점(.) 임시 이름 파일은 rename 전 수집되지 않고 rename 뒤 수집된다. rename 원자성은 4 MiB × 100건에서 부분 파일 0건이다. 호출처가 mode 0600으로 만든 파일은 Mailo가 읽지 못해 남고 `unreadable`로 기록되며 chmod 0660 뒤 수집된다(ADR-0004 구현 중 확정 16).
- NFS loopback(2026-11-23, `test/nfs/file-channel.nfs-spec.ts`, `pnpm test:nfs` 31건, NFSv4.1·4.2 기본값 각각 통과): 호출처 UID → `w` 클라이언트 rename → Mailo(`m1`) 수집·삭제. mount 옵션 6종의 기존 폴더 가시성 7~13 ms, 새 호출처 폴더 가시성(기본값 31.3초, `acdirmin=acdirmax=3` 3.0초, `lookupcache=pos` 9 ms), `close` 전 `rename`에서도 전체 내용을 읽음(ADR-0004 결정 3의 추정과 다름), rename 뒤 덧쓰기는 부분 노출, 2 MiB × 16건 rename 원자성(부분 0건), 심볼릭 링크·FIFO·하드링크 처리, `ESTALE`(수정 전 40회 중 8회 던짐, 수정 후 0회), 서로 다른 NFS 클라이언트의 두 폴러 동시 수집(60건, 중복 0, 오류 0).
- 미확인: 실제 NAS 제품, 서버 재시작·failover, NFSv3·4.0·Kerberos, bind mount, rootless Docker, GitHub 호스티드 러너(워크플로 작성만 함).

**제한:**

- 파일 채널은 DB 트랜잭션과의 원자성을 제공하지 않는다.
- 사용처가 커밋 전에 쓰면 롤백된 건의 메일이 발송될 수 있다.
- 사용처가 커밋 후에 쓰면 쓰기 전 장애로 요청이 유실될 수 있다.
- 사용처에는 커밋 후 쓰기를 권한다.

### RQ-003 DB 비공유

- [ ] **진행 상태:** 진행 중 (1단계, 설정·계정 조건의 자동 검증이 없다)

**요구사항:**

- Mailo와 사용처는 DB를 공유하지 않아야 한다.
- 사용처가 Mailo DB에 접속하지 않아야 한다.
- Mailo가 사용처 DB에 접속하지 않아야 한다.
- 입력 채널은 REST와 파일로 한정한다.

**수용 조건:**

- [ ] Mailo 설정에 사용처 DB 접속 정보가 없다.
- [ ] 사용처용 Mailo DB 계정과 접속 경로를 제공하지 않는다.
- [x] 사용처 문서에 DB 접속이 아닌 REST·파일 연동 방법이 기술돼 있다. (`docs/operations/caller-onboarding.md`, 2026-11-23. 문서 작성과 계약·코드 대조다.)

**판정 근거:**

- 구현: DB 접속 설정은 `MAILO_DATABASE_URL` 하나이고 사용처 DB 항목이 없다(`config/load-config.ts` 읽기). 자동 검증은 없다.
- 파일 채널 폴러(2026-11-23)는 DB 설정을 늘리지 않는다. Mailo 자신의 풀만 쓰고 `MAILO_FILE_*` 설정에 사용처 DB 정보가 없다. 입력 채널은 REST와 파일 둘뿐이다. 자동 검증은 없다(설정 읽기).
- compose는 PostgreSQL을 `127.0.0.1`에만 노출한다(`docker-compose.yml`). 사용처용 DB 계정을 만들지 않는다. 자동 검증은 없다.
- 문서 조건: `docs/operations/caller-onboarding.md`가 REST·파일 연동과 outbox + relay를 기술한다. 사용처 DB 접속 방법은 없다. 나머지 두 조건은 자동 검증이 없어 `[ ]`로 둔다.

### RQ-004 보장 범위

- [x] **진행 상태:** 검증 완료 (1단계, 3단계 문서로 마무리)

**요구사항:**

- Mailo는 멱등한 요청 등록과 at-least-once 발송을 보장한다.
- Mailo는 사용처 비즈니스 트랜잭션과의 원자성을 보장하지 않는다.
- 원자성이 필요한 사용처는 자기 DB에 outbox를 두고 relay로 Mailo에 전달한다.

**수용 조건:**

- [x] 같은 `Idempotency-Key`로 relay가 재호출해도 발송 작업이 하나만 생긴다.
- [x] 사용처 문서에 outbox + relay 사용 방법과 파일 채널의 유실 가능 구간이 기술돼 있다. (`docs/operations/caller-onboarding.md` 7절)
- [x] 사용처 문서에 relay 규칙이 기술돼 있다. (같은 문서 6·7절, `docs/api/README.md`의 "호출처 relay 재시도 지침")
  - 네트워크 오류와 `5xx`는 같은 Key로 재시도한다.
  - `4xx`는 재시도하지 않는다. 409는 영구 실패로 기록하고 운영 알림을 낸다.
  - relay 최대 재시도 기간은 7일 이하다. Key 보존 기간(RQ-011)보다 짧아야 하기 때문이다.

**판정 근거:**

- `queue/register.integration-spec.ts`, `http/rest-intake.integration-spec.ts`: 같은 Key 재호출이 작업 하나로 수렴한다(20건 동시 포함).
- 문서 조건 둘: `docs/operations/caller-onboarding.md`가 relay 규칙(네트워크 오류·5xx 재시도, 4xx 비재시도, 409 영구 실패와 알림, 재시도 7일 이하)과 파일 채널 유실 구간을 기술한다. 문서 작성과 계약 대조다. 2026-11-23에 Spring Boot relay 샘플(`samples/spring-boot-relay/`)을 Mailo와 실행해 규칙대로 동작함을 확인했다: 202·200은 완료 표시(같은 outbox 행 재전송은 200, `mail_jobs` 1행, 수신 1통), 네트워크 오류는 같은 Key로 backoff 재시도, 400은 재시도 없이 표시, 409는 격리, 401은 relay 중지. 샘플은 409·4xx 상태를 `QUARANTINED`·`REJECTED`로 나눠 둬서 문서 예시 스키마의 `FAILED`와 이름이 다르다.
- 첫 조건의 `[ ]`는 근거가 있는데 체크가 빠져 있던 것을 2026-11-23 문서 정합에서 `[x]`로 고쳤다.

## 2. 발송

### RQ-005 SMTP 발송

- [ ] **진행 상태:** 진행 중 (1단계)

**요구사항:**

- Mailo는 Gmail과 Google Workspace SMTP로 직접 발송해야 한다.
- 개발 환경은 Gmail 개인 계정을 쓴다.
  - 서버는 `smtp.gmail.com`이다.
  - STARTTLS를 지원한다.
  - Google 앱 비밀번호 등으로 인증한다.
- 운영 환경은 Google Workspace 계정을 쓴다.
  - Workspace SMTP Relay 또는 인증 SMTP를 쓴다.
- 환경 설정으로 SMTP 서버를 전환할 수 있어야 한다.
- 기본 연결은 587 포트와 STARTTLS 필수다. 465 포트 implicit TLS는 설정으로 선택한다.
- 인증서 검증을 끄지 않는다. TLS 1.2 이상만 허용한다. 평문 연결은 금지한다.
- SMTP 라이브러리는 nodemailer다(10.6.1). 구현이 쓰는 옵션은 587에서 `secure: false`와 `requireTLS: true`, 465에서 `secure: true`, `tls.minVersion: "TLSv1.2"`다. `rejectUnauthorized`는 지정하지 않아 인증서 검증이 켜져 있다. 로컬 SMTP 서버 대상 테스트로 확인했고 실제 Gmail 서버로는 확인하지 않았다.

**수용 조건:**

- [ ] 설정 변경만으로 개발·운영 SMTP 서버가 전환된다. (설정 읽기와 발송기 조립은 확인했다. 실제 Gmail·Workspace 서버 전환은 확인하지 않았다.)
- [x] 기본 설정에서 587 포트의 STARTTLS 연결로 발송된다.
- [x] 설정으로 465 포트 implicit TLS 연결을 선택하면 그 연결로 발송된다.
- [x] 인증서 검증을 끄는 설정이 없다. TLS 1.2 미만 연결은 실패한다.
- [x] TLS를 쓸 수 없는 서버에는 평문으로 발송하지 않고 실패한다.
- [x] SMTP 인증 정보는 설정 파일 평문이 아닌 환경 변수 또는 시크릿으로 받을 수 있다.

**판정 근거:**

- `smtp/sender.spec.ts`: STARTTLS 발송, implicit TLS 발송, STARTTLS 설정으로 implicit 포트 접속 실패. 로컬 `smtp-server` 3.21.7 대상이다.
- `smtp/nodemailer-errors.spec.ts`: STARTTLS 미지원 서버에 평문 발송하지 않음, 신뢰하지 않는 인증서 실패, TLS 1.1 서버 협상 실패, implicit TLS 설정으로 평문 서버 접속 실패.
- `config/load-config.spec.ts`: SMTP 사용자·비밀번호 쌍 검증, 시크릿 `_FILE`이 환경 변수보다 우선(키링 테스트), 오류에 값이 남지 않음.
- 앱 전체 경로(등록, Worker, SMTP)의 종단 테스트 `e2e/mail-flow.integration-spec.ts` 7건은 1단계 마무리 통합 테스트 실행에서 통과했다.
- 한계: 실제 Gmail·Workspace SMTP는 확인하지 않았다.

### RQ-006 메일 내용

- [x] **진행 상태:** 검증 완료 (1단계)

**요구사항:**

- 수신자, 제목, 본문을 지정할 수 있어야 한다.
- HTML 본문과 일반 텍스트 본문을 지원해야 한다.
- 발송 요청마다 고유 ID를 부여해야 한다.

**수용 조건:**

- [x] HTML 본문과 텍스트 본문이 각각 발송된다.
- [x] 한글 제목과 본문이 깨지지 않고 발송된다.
- [x] 서로 다른 요청은 서로 다른 ID를 받는다.

**판정 근거:**

- `smtp/sender.spec.ts`: 한글 제목·text, HTML만 있는 본문, `bcc`·`replyTo` 처리. 로컬 SMTP 서버 대상이다.
- `queue/register.integration-spec.ts`: 등록마다 UUID를 새로 만들고 호출처가 달라도 각각 신규로 등록한다.

### RQ-007 비동기 분리

- [x] **진행 상태:** 검증 완료 (1단계)

**요구사항:**

- 발송 요청 등록과 실제 SMTP 전송은 분리해야 한다.
- 등록 응답은 SMTP 전송 완료를 기다리지 않아야 한다.

**수용 조건:**

- [x] SMTP 서버가 응답하지 않아도 등록 요청은 정상 응답한다.

**판정 근거:**

- `http/rest-intake.integration-spec.ts`: SMTP 서버와 Worker 없이(`NoopWorkerRunner`) 등록이 202로 끝난다. 등록 경로는 SMTP 모듈을 호출하지 않는다.
- 한계: SMTP 서버가 연결은 받고 응답하지 않는 상황을 등록과 동시에 만든 테스트는 없다.

## 3. 재시도

### RQ-008 재시도 설정

- [x] **진행 상태:** 검증 완료 (1단계)

**요구사항:**

- 발송 실패 시 자동으로 재시도해야 한다.
- 다음 항목을 설정할 수 있어야 한다.
  - 최대 시도 횟수.
  - 실패 후 다음 시도까지의 대기 시간.
  - 재시도 정책. 고정 간격 또는 exponential backoff 등.
  - 재시도 만료 시각. 이 시각 이후에는 발송을 포기한다.
- 기본값은 exponential backoff다. 모두 설정으로 바꿀 수 있고, 수치는 추정이다.
  - 기준 1분, 배수 2, 상한 1시간, jitter ±20% 균등.
  - 최대 시도 8회(첫 시도 포함).
  - 만료 TTL 24시간.
- 기본값에서 대기 합은 약 2시간(1+2+4+8+16+32+60분)이다. 메시지 오류는 TTL 전에 횟수가 먼저 소진된다. 계정 상태 오류는 횟수를 쓰지 않으므로 긴 장애는 TTL에서 끝난다.

**수용 조건:**

- [x] 고정 간격과 exponential backoff 정책이 각각 설정대로 동작한다.
- [x] 설정하지 않으면 위 기본값이 적용된다.
- [x] 만료 시각 이후에는 재시도하지 않는다.

**판정 근거:**

- `queue/retry-policy.spec.ts`: exponential 1·2·4분 상한 1시간(상한 뒤 jitter 포함), jitter ±20%, fixed 간격, 기본값. Worker가 쓰는 구현은 `queue/retry-policy.ts` 하나다.
- `config/load-config.spec.ts`: 설정이 없으면 8회·60초·배수 2·상한 1시간·jitter 20%·lease 120초.
- `queue/claim-complete.integration-spec.ts`: 만료된 `PENDING`은 점유하지 않고, 다음 시도가 만료 시각 뒤이면 즉시 `EXPIRED`다. `worker/worker.integration-spec.ts`: 4xx 뒤 60초·120초 간격으로 재시도.

### RQ-009 오류 분류

- [x] **진행 상태:** 검증 완료 (1단계)

**요구사항:**

- 오류를 SMTP 단계로 나눈다(ADR-0007).
  - 계정 상태 오류: 연결, TLS, 인증 단계의 실패와 한도 초과.
  - 메시지 오류: `MAIL FROM`, `RCPT`, `DATA` 단계의 응답.
- 메시지 오류는 일시적인 오류와 영구적인 오류를 구분해야 한다.
- 재시도할 수 없는 오류는 즉시 최종 실패로 처리해야 한다.
- 차단기를 연(또는 이미 `open`·`half_open`인) 계정 상태 오류는 작업의 시도 횟수에 포함하지 않는다.
- 차단기를 열지 못한 계정 상태 오류(실패 시점에 차단기가 `closed`였고 `closed`로 남음, 예: 일부 메시지에만 나는 `OTHER` 정책 거부)는 작업별 오류다. 시도 횟수에 포함하고 일반 backoff로 재시도하며, 최대 시도(8)에 닿으면 `FAILED`(`MAX_ATTEMPTS_EXCEEDED`)다(ADR-0007 구현 중 확정 8).
- 계정 상태 오류는 전역 차단기로 처리한다. 차단 중에는 Worker가 작업을 점유하지 않는다.
  - 연속 실패 3회에서 `open`이 된다. 한도 초과는 즉시 `open`이다.
  - open 대기는 사유별 초기값에서 시작해 대표 작업이 실패할 때마다 2배씩 늘어난다. 상한은 `max(30분, 해당 사유의 초기값)`이다.
  - 일일 한도(`550 5.4.5` 등)는 open 1시간 뒤 `half_open`이다. 24시간 rolling이라 일부씩 회복되기 때문이다. 초기값이 상한보다 크므로 1시간 고정이다.
  - 순간 한도(`421`·`450`)는 open 5분에서 30분까지다.
  - 그 밖의 계정 오류(연결·TLS·인증)는 1분에서 30분까지다.
  - `half_open`에서는 대표 작업 한 건만 점유한다. 대표 작업이 계정 상태 오류 없이 끝나면 `closed`로 돌아간다. 메시지 오류로 끝나도 계정은 정상으로 본다.
- `MAIL FROM` 이후 단계의 계정 상태 오류는 작업별 `account_trips`로 센다. 같은 작업이 차단기를 3회 연 뒤에도 같은 응답을 받으면 그 작업을 `FAILED`로 전이한다. 구현은 실패 사유 `ACCOUNT_REPEATED`(REST `failureReason`은 `ACCOUNT_ERROR_REPEATED`)로 기록하고 시도 분류는 `ACCOUNT` 그대로다(`PERMANENT` 분류가 아니다). 이 판정이면 차단기를 다시 열지 않는다. 대표 작업이면 `closed`로 닫고 아니면 차단기를 바꾸지 않는다(ADR-0007 구현 중 확정 9).
  - 한도 사유(일일·순간 한도)는 `account_trips`와 이 판정에서 뺀다. 한도는 계정 전체의 상태이므로 이 사유의 작업은 만료 시각까지 `RETRY_WAIT`로 남고, 재개 시각이 만료 시각을 넘으면 `EXPIRED`다(ADR-0007 구현 중 확정 8).
- 전원이 거부되면 하나라도 `4xx`일 때 `TRANSIENT`, 모두 `5xx`일 때 `PERMANENT`다. 거부 응답에 계정 상태 오류(예: 일일 한도)가 섞이면 계정 상태 오류가 우선한다(구현 중 확정). 일부만 수락되면 `SENT`로 처리하고 `4xx`로 거부된 수신자는 재시도하지 않는다.
- `550 5.7.1`은 응답 텍스트로 가른다. 스팸·정책 거부는 메시지 오류 `PERMANENT`, relay 자격·구성은 계정 상태 오류이고 구분할 수 없으면 계정 상태 오류다. `450 4.2.1` 중 수신자 쪽 속도 제한은 `TRANSIENT`다. `421`의 `4.7.x`는 순간 한도, 그 밖의 `421`은 일반 계정 상태 오류다(추정). 세부는 ADR-0007 "구현 중 확정" 2다.
- Mailo 내부 오류(복호화 실패 등)는 SMTP 단계가 없다. 3번째 시도에서 `FAILED`가 되고 차단기를 갱신하지 않는다(ADR-0007 "구현 중 확정" 6).
- 차단기를 연 계정 상태 오류가 작업을 `FAILED`로 만드는 경우는 위 `account_trips` 예외(한도 사유 제외)뿐이다(ADR-0007 결정 2·4). 차단기가 `closed`로 남은 계정 상태 오류는 최대 시도로도 `FAILED`가 된다.
- 위 수치(3회, 1분, 30분, 1시간, 5분)는 추정이다. 설정으로 바꾼다.

**수용 조건:**

- [x] 영구 오류 응답을 받은 작업은 재시도 없이 `FAILED`가 된다.
- [x] 일시 오류 응답을 받은 작업은 재시도 대기 상태가 된다.
- [x] 분류 기준이 문서에 기술돼 있다. 기준은 ADR-0007(분류)과 ADR-0003 결정 5·6·8(유지분)이다.
- [x] 차단기를 연 연결·TLS·인증·한도 오류는 시도 횟수에 포함하지 않고, 작업을 `FAILED`로 만들지 않는다. 단, 한도 사유가 아닌 오류로 같은 작업이 차단기를 3회 연 뒤에도 같은 응답을 받으면 `FAILED`가 된다(ADR-0007 결정 4, 구현 중 확정 8).
- [x] 한도 사유(일일·순간 한도)는 같은 작업이 `account_trips` 3회를 넘어도 `FAILED`가 되지 않고 만료 시각까지 `RETRY_WAIT`를 유지한다.
- [x] 차단기가 `closed`로 남은 계정 상태 오류(`OTHER` 정책 거부 등)는 시도 횟수에 포함하고 일반 backoff로 재시도하며 최대 시도에서 `FAILED`가 된다. 차단기가 `open`일 때 도착한 같은 오류는 시도 횟수를 늘리지 않는다.
- [x] 한도 초과처럼 `5xx`이지만 시간이 지나면 풀리는 응답은 재시도 대기 상태가 된다.
- [x] 연속 계정 상태 오류가 임계값에 이르면 차단기가 `open`이 되고 Worker가 작업을 점유하지 않는다.
- [x] 인스턴스가 여럿이어도 차단기 상태와 연속 실패 수를 공유한다. 연속 실패 수의 증가와 초기화는 `UPDATE ... RETURNING` 한 문장으로 한다.
- [x] `half_open`을 점유한 인스턴스가 죽어도 `probe_until`이 지나면 다른 인스턴스가 이어받는다.
- [x] 대표 작업이 메시지 오류로 끝나면 차단기가 `closed`로 돌아간다.
- [x] 한도 사유가 아닌 오류로 같은 작업이 차단기를 3회 연 뒤에도 같은 응답을 받으면 `FAILED`가 된다.
- [x] 차단 중 만료 시각에 이른 작업은 주기 sweep이 `EXPIRED`로 전이한다. sweep은 `open`이어도 멈추지 않는다.
- [x] 전원 거부와 일부 수락이 위 규칙대로 처리된다.

**판정 근거:**

- `smtp/classify.spec.ts`, `smtp/nodemailer-errors.spec.ts`: 단계별(MAIL FROM·RCPT·DATA·연결·TLS·인증) 분류, 한도 응답, `550 5.7.1` 분기, 전원 거부와 일부 수락. 응답은 로컬 SMTP 서버가 만든 것이다.
- `queue/circuit-breaker.integration-spec.ts`: 3회 `open`, 일일 한도 즉시 `open`과 1시간 고정, 순간 한도 5분에서 30분까지 2배, 대표 1건 점유와 경쟁, `probe_until` 인계, 메시지 오류 뒤 `closed`, `account_trips` 3회 뒤 `FAILED`(한도 사유 제외, 응답이 다르면 승격 없음), 한도 사유는 `account_trips` 3회를 넘어도 `RETRY_WAIT` 유지와 만료 시각 뒤 `EXPIRED`, 차단기 closed의 `OTHER` 거부는 시도 횟수 증가와 최대 시도 `FAILED`·`open`에서는 증가 없음, 내부 오류는 차단기 불변, 재개 시각이 만료 뒤이면 `EXPIRED`.
- `worker/worker.integration-spec.ts`: 5xx `FAILED`, 4xx `RETRY_WAIT`, 일일 한도 `open`(`account_trips` 증가 없음), 인증 실패 3회 `open`(차단기를 열기 전 2건은 시도 횟수에 포함), `half_open` 대표 성공 뒤 `closed`, 차단 중 sweep.
- 한계: 응답 코드·텍스트 매핑 일부는 추정이다(ADR-0007 "구현 중 확정" 2). 실제 Gmail 응답으로 대조하지 않았다.

### RQ-010 재시도 중단과 시도 기록

- [x] **진행 상태:** 검증 완료 (1단계)

**요구사항:**

- 최대 시도 횟수를 넘으면 재시도를 중단해야 한다.
- 만료 시각에 도달하면 재시도를 중단해야 한다.
- 각 시도의 결과와 오류 정보를 기록해야 한다.

**수용 조건:**

- [x] 시도 횟수 초과 시 `FAILED`가 된다.
- [x] 만료 시각 도달 시 `EXPIRED`가 된다.
- [x] 시도마다 결과와 오류 정보가 조회된다.

**판정 근거:**

- `queue/claim-complete.integration-spec.ts`: 최대 시도 소진 뒤 `FAILED`(`ATTEMPTS_EXHAUSTED`), 만료 `EXPIRED`. `worker/worker.integration-spec.ts`: 시도마다 `mail_attempts`에 분류·단계·응답 코드가 남는다.
- 조회 범위: REST는 마지막 오류(`lastError`)만 노출한다. 시도 이력 전체의 조회는 미결정 항목(관리 기능)이다.

## 4. 중복 방지

### RQ-011 요청 중복 등록 방지

- [x] **진행 상태:** 검증 완료 (1단계, 2단계 파일 채널 연결로 마무리)

**요구사항:**

- 발송 요청에 `Idempotency-Key`를 반드시 지정해야 한다.
- Key는 1~128자이고 허용 문자는 `[A-Za-z0-9._:-]`다(추정 기본값).
- Key의 유일성 범위는 `(caller_id, idempotency_key)`다.
- 같은 Key의 요청은 중복 등록하지 않아야 한다.
- 같은 Key로 재요청하면 기존 발송 작업을 식별할 수 있어야 한다.
- 같은 Key에 다른 내용이 오면 거부해야 한다. 내용 동일 여부는 지문으로 판정한다(ADR-0005 결정 3).
  - 지문은 복호화 이후 발송 결과에 영향을 주는 모든 요청 필드의 평문으로 계산한다. 수신자(to·cc·bcc), from·replyTo, 제목, text, html, 요청별 정책 필드가 해당한다.
  - 봉투 암호화 요청도 평문이 같으면 같은 내용이다.
  - 지문 키를 교체해도 정상 재시도가 409가 되지 않는다.
- 채널(REST, 파일)과 무관하게 같은 규칙을 적용해야 한다.
- Key 행은 작업 종결 후 30일 보존한다(추정 기본값). 종결되지 않은 작업의 Key는 삭제하지 않는다.

**수용 조건:**

- [x] 같은 Key로 두 번 요청하면 발송 작업이 하나만 생긴다.
- [x] 두 번째 요청의 응답이 기존 작업을 식별할 수 있다.
- [x] REST로 등록한 Key를 파일로 재요청해도 중복 등록되지 않는다. (`e2e/file-flow.integration-spec.ts`)
- [x] Key 길이나 허용 문자를 벗어난 요청은 거부된다.
- [x] 같은 Key에 다른 내용을 보내면 REST는 409로 응답한다. 두 번째 메일이 오류 없이 사라지지 않는다.
- [x] 같은 Key에 다른 내용인 파일은 수집 거부로 처리된다. (`FINGERPRINT_MISMATCH`, `file-channel/poller.integration-spec.ts`)
- [x] 수신자 중 CC나 발신자만 다른 요청은 다른 내용으로 판정된다.
- [x] 지문 키 교체 뒤에도 이전 지문 키로 등록한 작업의 정상 재시도가 같은 내용으로 판정된다.
- [x] 보존 기간이 지나 삭제된 Key로 다시 요청하면 새 요청으로 등록된다.

**판정 근거:**

- `queue/register.integration-spec.ts`: 동시 20건에서 신규 1건, 지문 불일치 거부와 기존 작업 불변, 지문 키 교체 뒤 재시도, 호출처별 Key 범위.
- `http/rest-intake.integration-spec.ts`: 200·기존 작업, 409와 먼저 등록된 `jobId`, Key 형식·길이 400, 두 번째 API 키로 같은 작업 반환. `crypto/fingerprint.spec.ts`: 지문 정규화와 키 버전. `queue/maintenance.integration-spec.ts`: 삭제된 Key가 새 요청으로 등록된다.
- 파일 채널 조건 둘: `file-channel/poller.integration-spec.ts`(같은 Key의 다른 내용은 `FINGERPRINT_MISMATCH` 거부 기록과 이벤트, 먼저 등록된 작업은 그대로, 같은 Key·같은 내용의 두 파일은 작업 1건, 등록 직후 종료 뒤 재수집은 같은 Key로 걸러짐, 두 폴러 동시 수집), `e2e/file-flow.integration-spec.ts`(REST로 등록한 Key를 파일로 다시 넣으면 작업 1건).

### RQ-012 동시성과 영속성

- [ ] **진행 상태:** 진행 중 (1단계)

**요구사항:**

- 여러 사용처 인스턴스가 동시에 같은 Key로 요청해도 중복 등록되지 않아야 한다.
- 중복 방지 정보는 프로세스 재시작 후에도 유지돼야 한다.

**수용 조건:**

- [x] 같은 Key의 동시 요청 N건에서 발송 작업이 하나만 생긴다.
- [ ] Mailo 재시작 후 같은 Key로 재요청해도 중복 등록되지 않는다. (Key는 DB의 unique 제약이라 프로세스 상태와 무관하다. 재시작을 재현한 테스트는 없다.)

**판정 근거:**

- `queue/register.integration-spec.ts`: 같은 Key 동시 요청 20건에서 신규 등록은 1건이다.

### RQ-013 SMTP 중복 전송 한계

- [x] **진행 상태:** 검증 완료 (1단계, 3단계 문서로 마무리)

**요구사항:**

- SMTP는 exactly-once 전달을 보장하지 않는다.
- SMTP 서버가 메일을 수락한 직후 장애가 나면 재시도로 같은 메일이 다시 발송될 수 있다.
- 요청 중복 방지와 SMTP 전송 중복 방지는 구분해서 설계하고 문서화해야 한다.

**수용 조건:**

- [x] 중복 발송이 가능한 상황과 완화 수단이 설계 문서에 기술돼 있다.
- [x] 사용처 문서에 at-least-once 한계가 기술돼 있다. (`docs/operations/caller-onboarding.md` 7절 "한계", `docs/api/README.md`)

**판정 근거:**

- 문서: ADR-0002 결정 5, ADR-0007 결정 3·8, 이 RQ. `worker/worker.integration-spec.ts`는 lease 만료 회수 뒤 같은 작업이 다시 발송됨을 확인한다.
- 실제 SIGKILL(2026-11-23, `scripts/container/verify-sigkill-duplicate.sh`, ADR-0002 구현 중 확정 5): 가짜 SMTP가 DATA 수락 뒤 응답을 지연하는 동안 `docker kill -s KILL`로 Mailo 컨테이너를 죽이고(exit 137) 다시 띄웠다. lease 만료 뒤 같은 `Message-ID`로 2통이 SMTP에 도착했고 작업은 `SENT`, `attempts=2`였다(2회 실행 모두). 로컬 가짜 SMTP 기준이며 Gmail이 같은 `Message-ID`를 중복으로 버리는지는 확인하지 않았다.

## 5. 상태 관리

### RQ-014 상태 모델

- [x] **진행 상태:** 검증 완료 (1단계)

**요구사항:**

- 발송 작업은 다음 상태를 가진다.

| 상태         | 설명                          |
| ------------ | ----------------------------- |
| `PENDING`    | 발송 대기                     |
| `SENDING`    | 발송 진행 중                  |
| `RETRY_WAIT` | 실패 후 재시도 대기           |
| `SENT`       | SMTP 서버가 메일을 수락함     |
| `FAILED`     | 재시도 불가능 또는 최종 실패  |
| `EXPIRED`    | 발송 만료 시각 초과           |

**수용 조건:**

- [x] 상태 전이 규칙이 설계 문서에 기술돼 있다.
- [x] 허용되지 않는 전이는 거부된다.

**판정 근거:**

- 문서: ADR-0002 결정 7. 마이그레이션 `CHECK`가 상태 값과 lease·종결 시각 일관성을 강제한다.
- `queue/claim-complete.integration-spec.ts`: `lease_token`이 다른 결과 거부, 회수 뒤 다시 점유된 작업에 이전 점유의 늦은 결과 거부. 전이 UPDATE는 `status = 'SENDING'`을 조건으로 건다.

### RQ-015 상태 조회

- [x] **진행 상태:** 검증 완료 (1단계, 2단계 파일 채널 연결로 마무리)

**요구사항:**

- 사용처는 발송 작업 ID로 상태를 조회할 수 있어야 한다(`GET /jobs/{jobId}`).
- 사용처는 `Idempotency-Key`로도 조회할 수 있어야 한다(`GET /jobs?idempotencyKey=<key>`). 파일 채널 호출처는 작업 ID를 받지 못하므로 이 조회를 쓴다.
- 호출처는 자기 작업만 조회할 수 있다. `caller_id`는 REST 인증 정보에서 얻는다.
- Key 조회는 등록된 작업만 반환한다. 수집 거부와 지문 불일치는 작업 조회에 나오지 않고 이벤트 피드의 `INTAKE_REJECTED`로만 확인한다.
- 조회 결과에 다음 정보를 포함해야 한다.
  - 발송 시도 횟수.
  - 마지막 오류 정보.
  - 최종 발송 성공 시각.
  - 최종 실패 시각과 실패 원인.
  - 거부된 수신자(`rejectedRecipients`). 일부 수신자만 거부된 경우에 해당한다.

**수용 조건:**

- [x] 성공한 작업은 성공 시각을 반환한다.
- [x] 실패한 작업은 실패 시각, 실패 원인, 시도 횟수를 반환한다.
- [x] 존재하지 않는 ID는 404로 응답한다.
- [x] Key로 조회하면 같은 작업이 반환된다. 등록되지 않은 Key와 보존 기간이 지나 삭제된 Key는 404다.
- [x] 다른 호출처의 작업은 ID로도 Key로도 조회되지 않는다.
- [x] 수집 거부된 파일의 Key는 Key 조회에서 404이고, 이벤트 피드에서 같은 Key의 `INTAKE_REJECTED`가 확인된다. (`e2e/file-flow.integration-spec.ts`: 입력 검증 실패 파일. 거부 기록에 Key를 남기는 규칙은 ADR-0004 "구현 중 확정" 6, 서명을 확인하지 못한 파일은 Key 없이 파일 이름·sha256으로 식별한다. 이벤트 저장소는 `events/events.integration-spec.ts`로도 확인했다.)

**판정 근거:**

- `http/rest-intake.integration-spec.ts`: ID·Key 조회, 다른 호출처의 작업 404(없는 작업과 같은 응답), `SENT`·`FAILED` 작업의 시각·실패 원인(계약 이름)·마지막 오류·거부 수신자, jobId·Key 형식 오류 400, 인증 없이 401.
- 보존 기간이 지난 Key의 404는 `queue/maintenance.integration-spec.ts`의 삭제와 조회 대상 부재로 성립한다. 조회 호출까지 이어 검증한 테스트는 없다.

### RQ-016 `SENT` 의미

- [x] **진행 상태:** 검증 완료 (1단계, 3단계 문서로 마무리)

**요구사항:**

- `SENT`는 SMTP 서버가 메일을 수락했다는 의미로 쓴다.
- `SENT`는 수신자 받은편지함 도착을 의미하지 않는다.
- 일부 수신자만 거부돼도 `SENT`일 수 있다. 거부된 수신자는 `rejectedRecipients`로 상태 조회와 `JOB_SENT` 이벤트에 포함한다.

**수용 조건:**

- [x] 상태 조회 응답 문서와 사용처 문서에 `SENT`의 의미와 일부 수신자 거부 가능성이 기술돼 있다. (응답 문서는 `docs/api/openapi.yaml`·`README.md`, 사용처 문서는 `docs/operations/caller-onboarding.md` 7절이다.)
- [x] 일부 수신자만 거부되면 작업이 `SENT`가 되고, `4xx`로 거부된 수신자는 재시도되지 않으며, 상태 조회와 `JOB_SENT` 이벤트에 `rejectedRecipients`가 있다.

**판정 근거:**

- `worker/worker.integration-spec.ts`, `smtp/nodemailer-errors.spec.ts`, `queue/claim-complete.integration-spec.ts`: 일부 거부는 `SENT`, `4xx` 거부도 재시도하지 않음, 시도 기록과 이벤트에 거부 수신자 기록.
- `http/rest-intake.integration-spec.ts`: 상태 조회와 이벤트 응답에 `rejectedRecipients`.

## 6. 실패 알림

### RQ-017 최종 실패 인지

- [x] **진행 상태:** 검증 완료 (1단계)

**요구사항:**

- 최종 실패한 작업을 사용처가 인지할 수 있어야 한다.
- 로그 기록만으로 끝나서는 안 된다.
- 실패 작업 ID, 수신자, 실패 원인, 시도 횟수를 확인할 수 있어야 한다.
- 알림 방식은 이벤트 피드 pull이다(ADR-0006). webhook과 실패 파일 쓰기는 제공하지 않는다.
  - `GET /events?after=<cursor>&type=<종류>&limit=<개수>`로 조회한다.
  - 이벤트 종류는 `JOB_SENT`, `JOB_FAILED`, `JOB_EXPIRED`, `INTAKE_REJECTED`다.
  - 호출처는 자기 이벤트만 읽는다. 같은 이벤트가 다시 올 수 있으므로 이벤트 ID로 멱등하게 처리한다.
  - cursor는 `(txid, id)`를 base64url로 감싼 불투명 문자열이다(ADR-0006 결정 7). 피드는 `txid`가 `pg_snapshot_xmin(pg_current_snapshot())`보다 작은 이벤트만 반환한다. DB 어디서든 긴 트랜잭션이 있으면 피드가 멈추지만 이벤트는 유실되지 않는다. PostgreSQL 13 이상이 필요하다.
  - 이벤트와 거부 기록은 30일 보존한다(추정 기본값, ADR-0006 결정 8). 권장 폴링 간격은 30초다(추정).
  - 피드 지연(현재 시각 − 최신 반환 이벤트 시각)을 메트릭으로 둔다. 인증된 `GET /health/ready`의 `eventFeed.lagSeconds`(`latestEventAt`과 함께)로 노출한다. 새 이벤트가 없어도 값이 커지므로 단독 장애 신호가 아니다.

**수용 조건:**

- [x] 최종 실패 작업의 필수 정보(작업 ID, 수신자, 실패 원인, 시도 횟수)를 이벤트 피드에서 확인할 수 있다.
- [x] 종결 이벤트는 작업의 종결 전이와 같은 트랜잭션에서 써진다. 주기 sweep의 `EXPIRED` 전이도 같다. 수집 거부 이벤트는 거부 기록과 같은 트랜잭션에서 써진다.
- [x] 동시 트랜잭션의 커밋 순서가 `id` 순서와 달라도 cursor 기반 조회가 이벤트를 건너뛰지 않는다.
- [x] 호출처는 다른 호출처의 이벤트를 읽을 수 없다.
- [x] 피드 지연 메트릭이 노출된다. (인증된 `/health/ready`의 `eventFeed`. 호출처 자신의 이벤트만 반영한다.)
- [x] compose의 PostgreSQL 이미지가 13 이상이다.

**판정 근거:**

- `events/events.integration-spec.ts`: 미커밋 트랜잭션 때문에 커밋 순서가 뒤바뀐 이벤트를 건너뛰지 않음, 한 트랜잭션의 `id`가 99에서 100으로 넘어가는 이벤트를 limit 2·3·5로 끝까지 읽어도 빠짐·중복이 없음(정렬이 문자열 순이면 건너뛴다), 호출처 격리와 `type` 필터, 잘못된 cursor 거부, 수집 거부의 멱등 기록과 이벤트.
- `queue/maintenance.integration-spec.ts`: sweep의 `EXPIRED` 전이와 이벤트가 같은 트랜잭션이라 이벤트 쓰기 실패 시 전이도 롤백. `queue/claim-complete.integration-spec.ts`, `queue/circuit-breaker.integration-spec.ts`: 종결 전이와 이벤트.
- `events/events.integration-spec.ts`: 피드 지연 계산(이벤트 없음 null, 최신 반환 이벤트 기준, 다른 호출처 제외, 피드에 보이지 않는 미커밋 이벤트 제외). `http/rest-intake.integration-spec.ts`: `/health/ready`의 `eventFeed`(호출처별, 인증 없음은 생략). cursor 페이지 이어 읽기와 `hasMore`, 호출처 격리, 이벤트 모양. `db/migrator.integration-spec.ts`: 서버 버전 13 이상. `docker-compose.yml`은 `postgres:17-alpine`이다.
- 피드 지연 메트릭은 인증된 `/health/ready`의 `eventFeed`로 구현했다. 로그·외부 메트릭 시스템으로는 내보내지 않는다. 해석은 `docs/operations/troubleshooting.md`의 "피드 지연 해석"이다.

## 7. 큐와 영속성

### RQ-018 영속 큐

- [ ] **진행 상태:** 진행 중 (1단계)

**요구사항:**

- 발송 요청은 큐에 저장해야 한다.
- 발송은 백그라운드에서 처리해야 한다.
- 장애 후에도 대기 중이던 작업이 유실되지 않아야 한다.

**수용 조건:**

- [ ] 대기 중 작업이 있는 상태에서 Mailo를 재시작해도 작업이 남아 있고 이어서 처리된다. (큐는 PostgreSQL에 있고 lease 회수 테스트가 있다. 자동 테스트에는 프로세스 재시작을 재현한 것이 없다. `e2e/mail-flow.integration-spec.ts`의 재기동 시나리오는 실제 프로세스 재시작이 아니다. 2026-11-23 `scripts/container/`로 컨테이너를 SIGKILL·SIGTERM으로 죽였다 다시 띄웠을 때 `SENDING` 작업(SIGKILL)과 남은 파일(SIGTERM)이 유실 없이 이어서 처리됨을 관찰했다. 스크립트는 jest 자동 테스트에 포함되지 않고 CI `container` 잡에 연결했으나 GitHub에서 실행하지 않았다. `PENDING` 상태 작업이 있는 채로 재시작하는 경우는 따로 만들지 않아 `[ ]`로 둔다.)

**판정 근거:**

- `worker/worker.integration-spec.ts`: 점유한 Worker가 죽은 경우 lease 만료 뒤 다른 Worker가 회수해 재발송한다.

### RQ-019 Worker 중복 점유 방지

- [x] **진행 상태:** 검증 완료 (1단계)

**요구사항:**

- 여러 Worker가 동시에 처리해도 하나의 작업을 중복으로 가져가지 않아야 한다.

**수용 조건:**

- [x] Worker 여러 개를 동시에 실행해도 한 작업이 한 번에 하나의 Worker에만 할당된다.

**판정 근거:**

- `queue/claim-complete.integration-spec.ts`: 동시 `claim` 12건이 작업 60건을 중복 없이 나눠 가진다(`SKIP LOCKED`). `worker/worker.integration-spec.ts`: Worker 2개가 같은 큐를 처리해도 작업마다 한 번만 발송한다.

### RQ-020 처리 중단 복구

- [x] **진행 상태:** 검증 완료 (1단계)

**요구사항:**

- 처리 중 프로세스가 종료되면 해당 작업을 복구할 수 있어야 한다.
- 복구 과정에서 중복 발송이 발생할 수 있음을 인정하고 RQ-013에 따라 문서화한다.

**수용 조건:**

- [x] `SENDING` 상태에서 프로세스를 종료하면 작업이 재처리 대상으로 돌아온다.

**판정 근거:**

- `worker/worker.integration-spec.ts`: 프로세스 종료를 lease 만료로 재현해 다른 Worker가 회수하고 `LEASE_EXPIRED` 시도가 남는다.
- 실제 프로세스 kill(2026-11-23, `scripts/container/verify-sigkill-duplicate.sh`): 컨테이너를 `docker kill -s KILL`로 죽인 뒤 재기동하자 `SENDING`이던 작업이 lease 만료 뒤 회수돼 다시 발송됐다(`attempts=2`, `SENT`). 종료 순서·compose 기본값 변경 뒤 같은 날 다시 실행해 같은 결과를 얻었다(kill 뒤 101초에 같은 `Message-ID` 2통). 이 스크립트는 관찰만 기록하므로 CI에서 통과는 "끝까지 실행됨"이다. 자동 테스트에는 없고 CI `container` 잡에 연결했으나 GitHub에서 실행하지 않았다.

## 8. 트랜잭션

### RQ-021 비즈니스 트랜잭션과의 분리

- [x] **진행 상태:** 검증 완료 (3단계, 2026-11-23 Spring Boot 샘플을 컴파일하고 로컬 Mailo와 실행해 확인했다)

**요구사항:**

- 발송 실패가 사용처 비즈니스 DB 트랜잭션을 롤백시켜서는 안 된다.
- REST 호출 성공 여부로 비즈니스 트랜잭션의 커밋·롤백을 결정하는 구조를 피한다.
- 비즈니스 처리와 실제 이메일 전송은 분리한다.

**수용 조건:**

- [x] 사용처 연동 문서가 커밋 후 전송과 outbox + relay를 구분해 기술한다. (`docs/operations/caller-onboarding.md` 7절 표)
  - outbox + relay는 요청 유실이 없다.
  - 커밋 후 전송은 전송 전 장애 시 요청이 유실될 수 있다.
- [x] Mailo가 중단된 상태에서도 사용처 비즈니스 트랜잭션이 영향을 받지 않는 연동 예시가 있다. (`samples/spring-boot-relay/`. 2026-11-23 JDK 21·Gradle 8.14.3으로 컴파일하고 `verify/run-e2e.sh`로 이 저장소의 Mailo와 실행했다. 시나리오 S8: Mailo 프로세스를 내린 상태에서 주문이 201로 커밋됐고, outbox가 `PENDING`으로 backoff 재시도하다가 Mailo 재기동 뒤 `SENT`가 됐다.)

**판정 근거:**

- 샘플 실행(2026-11-23, `samples/spring-boot-relay/verify/run-e2e.sh` 76항목 통과, 실패 0): 주문·재고 차감·outbox를 한 `@Transactional`에 쓰고, 재고 부족 시 주문과 outbox가 함께 롤백됐다(메일 0통, S6). Mailo 중단 중 주문은 201이고 outbox는 `PENDING`과 `NETWORK_ERROR`로 재시도했다(S8). 이벤트 피드로 `SENT`·`FAILED`·`EXPIRED`·`INTAKE_REJECTED`를 사용처 쪽에 반영했다(S1·S3·S7·S13). 결과 표와 한계는 `samples/spring-boot-relay/README.md`다.
- 범위: 로컬 PostgreSQL 17, 로컬 SMTP 서버, JDK 21. 이 검증은 jest나 Mailo CI에 없다(Java 빌드 환경 분리). 여러 relay 인스턴스의 `SKIP LOCKED` 경합, 전송 도중 relay 강제 종료, 7일 `DEAD` 전이의 시각 경과는 재현하지 않았다.

## 9. 보안

### RQ-022 선택적 봉투 암호화

- [x] **진행 상태:** 검증 완료 (2단계, 3단계 문서로 마무리. 2026-11-23 코드 리뷰로 `signature.mode=none`의 한계를 문서에 추가했다)

**요구사항:**

- 사용처는 요청 본문을 봉투 암호화해 보낼 수 있어야 한다. 사용 여부는 사용처가 선택한다.
- 파일·REST 채널이 같은 암호화 형식을 쓴다.
- 형식은 JWE(RFC 7516)다(ADR-0008 결정 1).
  - 키 암호화 `alg`는 `RSA-OAEP-256`이고 RSA 3072비트로 고정한다.
  - 콘텐츠 암호화 `enc`는 `A256GCM`이다.
  - 호출처는 Mailo 공개키만 가진다. 한 호출처의 키 유출이 다른 호출처 파일 노출로 이어지지 않는다.
  - protected header에 `kid`와 `caller`를 넣는다. Mailo는 `caller`가 요청의 `caller_id`와 같은지 확인한다.
  - 이전 개인키는 교체 시각부터 Key 보존 기간 이상 보관한다. 이전 `kid`로 암호화한 REST 요청이 relay 재시도 기간 동안 사용처 outbox에 남을 수 있기 때문이다.
- 암호화 범위는 본문(text·html)과 제목이다.
- 수신자와 `Idempotency-Key`는 평문이다.
- Mailo는 수집 시 복호화한다. 복호화 뒤에 제목·본문 입력 검증(RQ-030)과 지문 계산을 한다.

**수용 조건:**

- [x] 암호화한 요청과 암호화하지 않은 요청이 모두 정상 발송된다. (REST는 Worker로 SMTP 발송까지 확인했다. 파일 채널의 JWE 파일은 jest에서 복호화·등록까지 확인했고, 2026-11-23 Spring Boot 샘플(nimbus-jose-jwt)이 JWS+JWE 파일을 써서 SMTP 수신까지 확인했다.)
- [x] 암호화한 파일을 열어도 본문과 제목을 읽을 수 없다. (JWE 파일의 바이트에 제목·본문이 없고, 등록 뒤 DB에도 평문이 없다. 파일 채널 통합 테스트.)
- [x] 복호화에 실패한 요청의 오류 기록과 로그에서 canary 문자열이 검색되지 않는다. (REST 응답과 로그, 파일 채널의 거부 기록·이벤트·로그. 파일은 변조한 JWE와 `caller`가 다른 JWE로 확인했다.)
- [x] `caller`가 요청의 `caller_id`와 다른 JWE는 거부된다.
- [x] 키 교체 뒤 이전 `kid`로 암호화한 요청이 Key 보존 기간 안에서는 복호화된다. (키링에 이전 키가 남아 있는 한 복호화된다. 보존 기간 전 삭제는 설정 검증이 막는다.)
- [x] `signature.mode=none`의 한계(수신자 바꿔치기, 기밀성 위험)와 `required` 권장이 운영 문서에 기술돼 있다. (`docs/operations/caller-onboarding.md`, 문서 작성이며 코드 동작은 바꾸지 않았다.)
- [x] 알고리즘, 키 식별자 형식, 키 교체 절차가 문서에 기술돼 있다. (알고리즘과 `kid` 형식은 ADR-0008 "구현 중 확정"과 `docs/operations/key-management.md`, 키 교체·이전 키 보관·삭제 절차는 `key-management.md`다. 문서 작성과 코드 대조이고 교체 절차를 운영 환경에서 실행하지 않았다.)

**판정 근거:**

- `envelope/open-request.spec.ts`: 정상 JWE, 알 수 없는 `kid`, 보호 헤더 변조(AAD), `caller` 불일치, 암호문·태그·IV 변조, 잘못된 `alg`·`enc`, 키 교체 중 이전 `kid`, 암호화한 제목의 CR/LF 거부, 복호화 뒤 크기·형식 검증, 평문 모드와 JWE 모드의 지문 일치, 파이프라인 순서(서명 실패 시 복호화 호출 없음, 복호화 실패 시 지문 계산 없음), 실패 결과에 canary 없음.
- `envelope/key-file.spec.ts`: RSA 3072 강제, 시크릿 파일 우선, 이전 키를 Key 보존 기간 전에 지우면 기동 거부.
- `envelope/rest-envelope.integration-spec.ts`: 실제 HTTP와 PostgreSQL로 JWE 왕복(202, DB에 평문 없음), 같은 Key의 평문·JWE 재요청 200과 내용 변경 409, 400 코드(`KID_UNKNOWN`·`DECRYPTION_FAILED`·`CALLER_MISMATCH`·`CONTROL_CHARACTER`), 응답·로그에 canary와 암호문 없음, Worker로 JWE 요청과 평문 요청이 SMTP로 나감.
- `file-channel/poller.integration-spec.ts`: JWE 파일 수집, `caller` 불일치(`CALLER_MISMATCH`), 알 수 없는 `kid`(`DECRYPTION_FAILED`로 기록), 암호화한 제목의 CR/LF 거부, 변조한 JWE의 거부와 canary 부재.
- 한계 문구(`signature.mode=none`, DB AAD 범위)는 문서 항목이다. 코드 동작은 바꾸지 않았고 이를 단언하는 자동 테스트는 없다. 서명 `required`가 수신자 변경을 거부한다는 서술은 서명이 `payload` 전체를 덮는다는 JWS 성질에 근거한다. 잘못된 서명의 거부는 `file-channel/poller.integration-spec.ts`가 확인하지만, 수신자만 바꾼 서명 파일을 거부하는 전용 테스트는 없다.
- nimbus-jose-jwt 10.10 상호 운용(2026-11-23, `samples/spring-boot-relay/verify/run-e2e.sh`): 확인한 조합은 JWE `RSA-OAEP-256`+`A256GCM`(RSA 3072, protected `kid`·`caller`)을 REST `content`로 보낸 것(202, SMTP 수신, 복호화된 제목·본문 일치)과 파일 채널로 보낸 것, JWS flattened `HS256`(protected `kid`·`caller`·`iat` 숫자)을 파일 채널로 보낸 것(`signature.mode=required`, SENT, 수집 거부 0건)이다. 다른 비밀키 서명은 `SIGNATURE_INVALID`, 알 수 없는 `kid`는 400 `KID_UNKNOWN`으로 거부됐다. 두 구현 사이의 형식 해석 차이는 관찰되지 않았다.
- 미확인: 다른 nimbus 버전, `RSA-OAEP-256` 외 알고리즘, 키 교체 중 이전 `kid`의 상호 운용, 2 MiB 근처 큰 본문, JWE 개인키 유출 때의 대응 절차(미결정, `key-management.md`).

**한계:**

- Mailo는 SMTP 전송 시점에 본문을 평문으로 복호화한다.
- Mailo 호스트나 메모리가 침해되면 보호되지 않는다.
- 막는 대상은 파일 폴더, 백업, NAS, DB 덤프를 통한 유출이다.
- `signature.mode=none` 호출처는 inbox 쓰기 권한자의 수신자 바꿔치기를 막지 못한다. 쓰기 권한자는 `none`에서 본문을 새로 만들어 보낼 수도 있고, 이 변조로 새로 생기는 위험은 기밀성뿐이다(탈취한 JWE 본문을 다른 수신자에게 보내 열람). JWE 본문 유출을 막아야 하면 `signature.mode=required`를 사용한다(ADR-0008 구현 중 확정 9).
- DB 본문 AES-GCM의 AAD는 `job_id`뿐이라 DB 쓰기 권한자의 `recipients` 변경은 막지 못한다(ADR-0008 구현 중 확정 10, RQ-023).

### RQ-023 DB 본문 암호화

- [x] **진행 상태:** 검증 완료 (1단계)

**요구사항:**

- Mailo는 DB에 저장하는 본문을 항상 암호화해야 한다.
- 사용처의 봉투 암호화 사용 여부와 무관하다.
- 형식은 AES-256-GCM이다(ADR-0008 결정 6).
  - 암호화 범위는 제목, text, html이다.
  - 행마다 `key_version`을 저장한다. AAD는 `job_id`이고, `job_id`는 INSERT 전에 앱에서 생성한 UUID다.
  - nonce는 암호화마다 96비트 난수를 새로 쓴다.
  - DB 키를 교체하면 이전 키는 그 `key_version`을 가진 행의 본문이 모두 삭제될 때까지 보관한다.
  - 키 보관은 시크릿 파일 마운트가 기본이고 환경 변수도 허용한다.
- 종결한 작업의 본문은 종결 후 1일 뒤 삭제한다(추정 기본값). 본문 컬럼만 비우고 행과 Key는 유지한다.

**수용 조건:**

- [x] DB 덤프에서 본문이 평문으로 읽히지 않는다.
- [x] 암호화 키가 소스·이미지에 포함되지 않고 외부 설정으로 주입된다.
- [x] 행 사이에 암호문을 바꿔치면 복호화가 실패한다.
- [x] 키 교체 뒤에도 이전 `key_version` 행의 본문이 복호화된다.
- [x] 종결 후 유예 기간이 지난 작업의 본문 컬럼이 비워지고 행과 Key는 남는다.

**판정 근거:**

- `crypto/body-cipher.spec.ts`: AES-256-GCM 왕복, 96비트 nonce, 다른 `job_id`(AAD)와 변조한 암호문의 복호화 실패, 키 교체 뒤 이전 버전 복호화.
- `http/rest-intake.integration-spec.ts`, `queue/register.integration-spec.ts`, `worker/worker.integration-spec.ts`: DB 컬럼에 본문 평문이 없다(canary). `config/load-config.spec.ts`: 키를 환경 변수·시크릿 파일로 받고 현재·이전 버전을 함께 읽는다.
- `queue/maintenance.integration-spec.ts`: 종결 후 유예가 지난 작업만 본문 컬럼을 비우고 행과 Key는 남긴다.
- 한계: AAD가 `job_id`뿐이라 DB 쓰기 권한자의 `recipients`(평문 jsonb) 변경은 막지 못한다. DB 쓰기 계정 최소화와 백업 무결성 관리로 완화한다(ADR-0008 구현 중 확정 10). 코드 동작은 바꾸지 않았다.
- 범위: RQ-022(JWE 봉투 암호화)는 2단계이고 이 RQ의 DB 암호화만 1단계다. 복호화한 평문은 이 RQ의 경로로 DB에 저장된다(`envelope`는 DB를 쓰지 않는다).

### RQ-024 파일 채널 접근 통제

- [ ] **진행 상태:** 진행 중 (2단계, 같은 호스트 Docker named volume과 NFS loopback의 권한 모델은 확인. 실제 NAS 미확인)

**요구사항:**

- 파일 채널은 파일시스템 권한이 유일한 인증이다. 접근 통제와 위조 방지는 ADR-0004를 따른다.
- 호출처마다 입력 폴더를 분리한다. 폴더 이름이 호출처 식별자다.
- 호출처 계정은 자기 폴더에 파일을 만들 수 있다.
- 호출처 계정은 자기 폴더의 목록 조회, 다른 호출처 폴더에 접근할 수 없다.
- 호출처는 자기가 만든 파일의 소유자이므로 그 파일을 읽거나 삭제하는 것은 막을 수 없다.
- Mailo는 공용 그룹과 setgid 디렉터리 또는 default ACL로 호출처 파일을 읽는다. 호출처 umask에 의존하지 않는다.
  - 보완됨(2026-11-23, 사용자 위임 결정, ADR-0004 구현 중 확정 28): 권장은 default ACL이다. 공용 그룹 + setgid는 ACL을 쓸 수 없는 파일시스템용 대안이며 호출처 umask `027` 이하 요건이 있다(`077`에서 읽지 못한다). "호출처 umask에 의존하지 않는다"는 default ACL에서만 성립한다. 호출처가 생성 mode `0600`으로 만든 파일은 두 방식 모두 수집되지 않고 `unreadable`로 남는다(호출처가 `rename` 전에 `0660`으로 `chmod`해야 한다).
- 같은 호스트 Docker 볼륨에서는 Mailo와 호출처 컨테이너가 서로 다른 non-root UID로 실행된다.
- Mailo는 설정에 등록된 호출처 폴더만 수집한다.
- 호출처마다 서명 검증 사용 여부(`required` 또는 `none`)를 명시해야 한다. 기본값은 없다.
- 서명은 JWS HS256이다(ADR-0008 결정 2).
  - 서명 파일의 최상위는 flattened JWS이고 요청 JSON은 `payload` 안에 있다.
  - `caller` 클레임이 폴더의 `caller_id`와 다르면 거부한다.
  - `iat`가 서명 허용 기간(7일)보다 오래됐거나 허용 오차(5분)를 넘어 미래이면 거부한다. 두 값은 추정 기본값이다.
  - 서명 허용 기간은 'Key 보존 기간 − 허용 오차' 이하여야 하고, 기동 시 검증한다.
  - 서명이 `none`인 호출처와 REST는 이 재전송 방지가 없다. Key 보존 기간 안의 재전달만 막는다.
- 같은 호스트 볼륨과 NAS/NFS 폴더 모두 같은 규칙으로 동작해야 한다.

**수용 조건:**

- [x] 서명이 `required`인 호출처의 서명 없는 파일·서명이 틀린 파일은 수집 거부(거부 기록과 `INTAKE_REJECTED` 이벤트)로 처리된다. (`SIGNATURE_REQUIRED`는 거부 사유 `SIGNATURE_INVALID`로 합쳐 기록한다. 파일 채널 통합 테스트.)
- [x] `caller` 클레임이 다른 서명 파일과 `iat`가 허용 기간을 벗어난 서명 파일은 수집 거부로 처리된다. (파일 채널 통합 테스트로 거부 기록과 이벤트까지 확인했다.)
- [x] 서명 허용 기간이 'Key 보존 기간 − 허용 오차'를 넘는 설정은 기동 시 거부된다.
- [x] 서명 사용 여부가 명시되지 않은 호출처 설정은 기동 시 거부된다.
- [x] 등록되지 않은 폴더의 파일은 수집되지 않는다. (`fileChannel: false` 호출처의 폴더도 같다. 읽지 않으므로 거부 기록도 없다.)
- [x] 호출처 계정이 자기 폴더의 목록을 조회할 수 없다. (같은 호스트 Docker named volume, default ACL·공용 그룹 두 방식에서 차단을 확인했다. 이름을 알면 `stat`·읽기·삭제는 가능하다. 스크립트 검증이다. NFS loopback에서도 자기 폴더와 `inbox` 목록 조회가 `EACCES`이고 폴더 `chmod`가 거부됐다: `pnpm test:nfs`.)
- [x] 호출처 계정이 다른 호출처 폴더의 파일을 읽거나 만들 수 없다. (같은 환경, 두 방식에서 목록·읽기·생성·rename·삭제와 inbox 루트 목록이 모두 차단됐다. root나 Mailo와 같은 UID로 실행하면 성립하지 않음을 보였다. NFS loopback에서도 같은 호출처 UID 2개로 서로의 폴더 만들기·목록·읽기·삭제가 `EACCES`이고, root는 `root_squash`로 거부됐다.)
- [x] Mailo 계정이 호출처가 만든 파일을 호출처 umask와 무관하게 읽을 수 있다. (default ACL 방식 한정이다. 2026-11-23 보완: 공용 그룹 방식은 이 조건을 만족하지 않는다. default ACL 방식에서 umask 022·027·077·000 모두 읽었다. 공용 그룹 + setgid는 umask 077에서 읽지 못한다. 두 방식 모두 호출처가 생성 mode를 0600으로 명시한 파일은 읽지 못하므로 rename 전에 chmod 0660이 필요하다. ADR-0004 구현 중 확정 15·16·18. NFS loopback에서는 default ACL 폴더에서 NFSv4.2 클라이언트가 만든 파일만 umask 077에서 읽힌다. NFSv4.1 클라이언트는 umask 077이면 Mailo가 읽지 못해 `unreadable`로 남는다. 호출처 호스트도 `vers=4.2`가 필요하다. ADR-0004 구현 중 확정 22.)
- [ ] 같은 호스트 볼륨(2단계)과 NAS/NFS 환경(3단계)에서 각각 통합 테스트로 확인한다. (같은 호스트 Docker named volume은 `scripts/volume/` 스크립트로 확인했다. jest 통합 테스트에는 넣지 않았다. CI 워크플로 `container` 잡에는 연결했으나 GitHub에서 실행하지 않았다. NFS는 loopback에서 `pnpm test:nfs` 31건(NFSv4.1·4.2 기본값 각각)으로 확인했다. 실제 NAS 제품과 GitHub 호스티드 러너는 확인하지 않았다. `nfs` 잡은 작성만 했다.)

**판정 근거(서명 부분):**

- `envelope/open-request.spec.ts`: JWS 정상, payload·서명 변조, `alg` none 공격, `alg` 혼동(HS384·HS512·RS256·소문자), 알 수 없는 `kid`·다른 호출처 키, 키 2개 교체, `iat` 만료·미래(경계 포함), `caller` 불일치, 서명 범위 밖 필드 거부, 서명 없는 파일.
- `config/load-config.spec.ts`: 허용 기간 + 허용 오차가 Key 보존 기간을 넘으면 기동 거부(경계 포함). `callers/registry.spec.ts`: `signature.mode` 미지정 거부.
- `file-channel/poller.integration-spec.ts`: 서명 required 호출처의 정상 JWS 수집, 서명 없는 파일·다른 키로 서명한 파일·허용 기간(8일) 밖 `iat`·다른 호출처 이름의 `caller` 클레임이 거부 기록과 `INTAKE_REJECTED` 이벤트를 남기고 원본이 삭제된다. 서명 검증 뒤 사유일 때만 거부 기록에 Key를 남긴다(`file-channel/key-hint.spec.ts`).
- 파일시스템 접근 통제(2026-11-23, 같은 호스트 Docker named volume): 코드는 폴더를 만들거나 chmod하지 않는다(ADR-0004 결정 8). 구성은 `scripts/volume/init-volume.sh`와 `docker-compose.volume-example.yml`이 만든다. `verify-permissions.sh acl|group`은 방식별 28개 확인, `verify-root-model.sh`는 15개 확인, `verify-e2e.sh`는 방식별 15개 확인이고 기대와 다른 결과가 0건이다. 권장 구성은 default ACL이다(ADR-0004 구현 중 확정 14·15). Mailo 쪽에서 읽기 권한이 없는 파일은 거부하지 않고 남겨 `unreadable` 로그로 드러난다(e2e로 확인).
- 문서와 어긋난 점(해소됨 2026-11-23): 이 RQ 요구사항의 "공용 그룹과 setgid 디렉터리 또는 default ACL ... 호출처 umask에 의존하지 않는다"에서 공용 그룹 + setgid는 umask 077에서 읽기에 실패한다. 사용자 위임 결정으로 위 요구사항 항목 아래에 "보완됨" 표기를 달았다(ADR-0004 구현 중 확정 18·28). 원문은 지우지 않았다. 호출처 구성 절차는 `docs/operations/caller-onboarding.md` 4절이다.
- NFS 권한 모델(2026-11-23, `test/nfs/file-channel.nfs-spec.ts`, `docs/operations/nfs.md`): 폴더 구성은 `apps/mailo/scripts/nfs/lib.sh`의 `nfs_make_inbox`가 만든다. 같은 default ACL 모델이 NFS에서도 성립했다. 공용 그룹 + setgid 대안은 NFS에서도 umask 077에 읽지 못했고, 서버가 보조 그룹을 서버 조회(`--manage-gids`)로 판정하면 보조 그룹만 가진 계정이 거부된다.
- 미확인: 실제 NAS 환경, bind mount, rootless Docker·`userns-remap`, 파일시스템 ACL 지원이 없는 환경. 같은 호스트 볼륨 검증은 스크립트이고 jest 통합 테스트에 포함되지 않는다. CI 워크플로(`container` 잡)에는 연결했으나 GitHub에서 실행하지 않았다.

## 10. Docker 운영

### RQ-025 Docker 실행과 설정

- [ ] **진행 상태:** 진행 중 (1단계)

**요구사항:**

- Mailo는 Docker 컨테이너로 실행할 수 있어야 한다.
- 환경 변수 또는 설정 파일로 SMTP 설정을 바꿀 수 있어야 한다.
- 개발과 운영 환경을 구분해야 한다.

**수용 조건:**

- [ ] 개발·운영 설정으로 각각 컨테이너가 기동된다. (운영 구성(`NODE_ENV=production`, compose healthcheck `healthy`)은 `scripts/container/`로 기동을 확인했다. `NODE_ENV=development` 컨테이너는 기동하지 않았다.)
- [ ] 이미지에 SMTP 인증 정보가 포함되지 않는다. (`Dockerfile`에 인증 정보를 넣는 단계가 없다. 이미지를 빌드해 검사하지 않았다.)
- [x] 컨테이너 종료 신호를 받으면 새 작업 점유를 멈추고 진행 중인 전송을 기다린다. (Worker와 앱 종료 훅을 테스트로 확인했다. 컨테이너 SIGTERM은 2026-11-23 `scripts/container/verify-sigterm-file.sh`로 파일 채널 활성 상태에서 확인했다. 아래 판정 근거.)
- [x] `stop_grace_period`가 lease 시간 이상으로 설정돼 있다. (compose 기본 150초(`MAILO_STOP_GRACE_PERIOD`), lease 기본 120초. 앱이 `MAILO_STOP_GRACE_PERIOD`가 설정된 경우 drain 상한 + 10초 이상인지 기동 때 검사하고(`config/load-config.spec.ts`), `config/compose-consistency.spec.ts`가 compose 기본값과 `.env.example` lease의 관계를 단언한다. 한계: 변수를 주지 않는 환경(오케스트레이터가 다른 값을 쓰는 경우)은 검사할 수 없다. compose 파일은 `docker compose config` 대신 텍스트 패턴으로 검사한다. 컨테이너 검증은 lease 45초로 실행했고 기본 120초로 종료 시간을 재지는 않았다.)

**판정 근거:**

- `worker/worker.integration-spec.ts`: 종료 신호 뒤 진행 중 전송을 끝까지 기다리고 새 작업을 점유하지 않음, `pause()` 뒤 새 작업을 점유하지 않고 진행 중 전송은 끝냄, drain 상한을 `pause()` 시점부터 셈, 대기 시간 초과 시 포기하고 lease를 풀지 않은 채 회수에 맡김. `http/lifecycle.integration-spec.ts`: 기동 때 `start` 한 번, 종료 때 `pause`를 먼저 부르고 HTTP 서버를 닫은 뒤 `stop`을 호출하며 외부에서 받은 풀은 닫지 않음, 본문을 다 보내지 않은 느린 POST가 열려 있어도 `pause`가 먼저 일어나고 요청 시간제한 안에 종료함(시간제한은 테스트에서 줄여 확인. 운영 기본 30초는 실행하지 않았다).
- `config/load-config.spec.ts`: 기동 시 설정 검증, `.env.example`의 활성 변수가 그대로 통과. DB 접속 URL을 분리 변수(`MAILO_DB_*`)로 조립하는 규칙과 비밀번호 URL 인코딩(`@ / : # %` 포함)도 이 파일이 확인한다.
- 컨테이너 SIGTERM(2026-11-23, `scripts/container/verify-sigterm-file.sh`, 파일 1000개, 폴링 500ms, lease 45초): 폴러가 처리하는 도중(남은 파일 997개일 때) `docker compose stop mailo`를 보냈다. 종료 코드 0, 소요 0.4초, OOMKilled false였다. 로그 순서는 `file_poll`(registered 19) → `file_channel_stopped` → `worker_stopping inFlight 0` → `worker_stopped drained true`였다. 종료 뒤 DB 작업 19건 = 처리한 파일 19건(1000 − 남은 981. 같은 날 종료 순서 변경 뒤 재실행에서는 22건 = 22건, 종료 코드 0, 0.4초, 재기동 뒤 1000건 `SENT`), 남은 파일 중 DB에 등록된 것 0건, `SENDING` 0건이었다. 다시 띄우자 남은 파일이 수집돼 작업 1000건 모두 `SENT`, SMTP 수신 1000통(유일 `Message-ID` 1000개)이었다. 진행 중 전송이 있는 상태의 SIGTERM(전송 응답 지연 중 종료 대기)은 이 스크립트가 만들지 않았고 `worker/worker.integration-spec.ts`만 확인한다.
- 컨테이너 기동(2026-11-23, 같은 스크립트와 `verify-sigkill-duplicate.sh`): 저장소 `Dockerfile`로 빌드한 이미지가 compose의 `MAILO_DB_*` 분리 변수(비밀번호 `p@ss/w:rd#1%2x`)로 PostgreSQL에 접속해 마이그레이션을 적용하고 healthcheck(`/health/live`)가 `healthy`가 됐다.

- DB 시간제한과 풀 크기(2026-11-23 코드 리뷰 반영, H1·M1): 앱 풀에 `statement_timeout`·`lock_timeout`·`idle_in_transaction_session_timeout`·`query_timeout`·keepAlive를 건다(`MAILO_DB_*_TIMEOUT_MS`). `db/pool-timeout.integration-spec.ts`가 `pg_sleep`(57014), 잠금 대기(55P03), 유휴 트랜잭션 연결 끊김, 클라이언트 `query_timeout`과 연결 폐기를 확인한다. `worker/worker-resilience.integration-spec.ts`는 DB가 응답하지 않아도 `pause`·`stop`이 drain 상한 안에 끝남과 결과 기록의 lease 마감까지 재시도를 확인한다. `MAILO_DB_POOL_MAX` ≥ `MAILO_WORKER_CONCURRENCY` + 4는 `config/load-config.spec.ts`가 확인한다. 한계: 실제 네트워크 단절(RST 없는 끊김)은 재현하지 않았다. 응답 없는 연결은 풀 래퍼와 `query_timeout`으로 흉내 냈다. 컨테이너 종료 시간은 다시 재지 않았다.
- 점유 루프 비정상 종료(H2): `poll_loop_crashed`가 나면 정상 종료 경로를 거쳐 종료 코드 70으로 끝난다(`fatal-exit.spec.ts`, `worker-resilience.integration-spec.ts`). `restart: unless-stopped`의 비0 종료 재시작은 일회용 컨테이너로 확인했고 실제 Mailo 컨테이너에서 이 경로를 일으키지는 않았다.
- 개발·운영 구분(2026-11-23 코드 리뷰 반영, M4): `NODE_ENV`가 `development`·`test`로 명시되지 않으면(값이 없는 경우 포함, fail closed) `.env.example` 등 저장소에 공개된 DB 본문 키·지문 키 샘플과 같은 바이트(같은 바이트가 반복된 키 포함)와 공개 샘플 DB 비밀번호(`mailo-dev-password`)를 거부한다. compose의 `POSTGRES_PASSWORD`는 기본값 없이 필수다(`config/compose-consistency.spec.ts`가 패턴을 확인했다). `config/load-config.spec.ts`가 base64·hex 표기, 이전 버전 변수, 오류에 키 값이 없음, development·test 허용을 확인한다. `MAILO_DB_HOST`는 호스트 이름·IPv4·대괄호 IPv6만 받고 포트·경로가 섞이면 기동을 거부하며, `..._V01`처럼 앞자리 0이 있는 키 버전 변수도 거부한다(같은 파일). compose의 HTTP 포트는 기본 `127.0.0.1`에만 연다(`MAILO_PUBLISH_HOST`). `scripts/container/`는 실행마다 일회용 키를 만들도록 고쳤고 변경 뒤 2026-11-23에 SIGKILL·SIGTERM 두 스크립트를 다시 실행해 기동·종료가 기대와 일치했다(production 기본값, 포트 `127.0.0.1`, 일회용 키로 기동).

### RQ-026 영속 보관과 자동 복구

- [ ] **진행 상태:** 진행 중 (1단계)

**요구사항:**

- 메일 큐와 발송 이력은 영속적으로 보관해야 한다.
- 컨테이너 재시작 후 자동으로 복구돼야 한다.
- 보존 기간의 기준 시각은 대상마다 다르다(추정 기본값).
  - 본문은 종결 후 1일(RQ-023).
  - 시도 기록(`mail_attempts`), 작업 행, Key는 작업 종결 후 30일.
  - 거부 기록과 `INTAKE_REJECTED` 이벤트는 기록 생성 후 30일. 거부에는 종결할 작업이 없다.
  - 작업의 종결 이벤트는 작업 행과 함께 삭제한다.
  - 순서 규칙은 본문 유예 ≤ 시도·이벤트·거부 보존 = Key·작업 행 보존이다.
  - 종결되지 않은 작업의 Key는 삭제하지 않는다.
  - 작업 행을 삭제할 때 그 행의 `mail_attempts`와 이벤트 행도 함께 삭제한다. 삭제 뒤 같은 Key는 새 요청이고 Key 조회(RQ-015)는 404다.

**수용 조건:**

- [ ] 컨테이너를 재생성해도 큐와 이력이 남아 있다. (compose가 `postgres-data` 볼륨을 쓴다. 재생성을 실행하지 않았다.)
- [ ] 재시작 후 사람의 개입 없이 미처리 작업이 이어서 처리된다. (compose `restart: unless-stopped`와 lease 회수. 재시작을 실행하지 않았다. `scripts/container/`는 `restart: "no"`로 덮어쓰고 kill·stop 뒤 스크립트가 `compose start`로 수동 재기동해 이어서 처리됨만 관찰했다. 자동 재시작 정책은 확인하지 않았다.)
- [x] 보존 기간이 지난 작업 행을 삭제하면 그 행의 시도 기록과 이벤트 행도 함께 삭제된다.
- [x] 종결되지 않은 작업의 Key는 보존 기간이 지나도 삭제되지 않는다.

**판정 근거:**

- `queue/maintenance.integration-spec.ts`: 작업 행 삭제 시 시도·이벤트 cascade, 거부 기록과 그 이벤트 삭제, 보존 안의 작업과 종결되지 않은 작업은 유지. `worker/worker.integration-spec.ts`: 본문 삭제와 보존 삭제가 주기적으로 실행.
- 실제 30일 경과는 재현하지 않았다. 시각을 DB에서 당겨 확인했다.

### RQ-027 로그

- [ ] **진행 상태:** 진행 중 (1단계)

**요구사항:**

- 실행 로그와 오류 로그를 확인할 수 있어야 한다.
- 로그에 메일 본문과 SMTP 인증 정보를 남기지 않아야 한다.

**수용 조건:**

- [ ] 컨테이너 로그에서 발송 시도와 오류를 확인할 수 있다. (Worker가 JSON 로그를 표준 출력에 쓴다. 컨테이너 로그를 실제로 확인하지 않았다.)
- [x] 본문과 SMTP 비밀번호에 canary 문자열을 넣어 발송·실패·재시도를 수행한 뒤, 로그에서 canary가 검색되지 않는다.

**판정 근거:**

- `worker/worker.integration-spec.ts`: 성공·영구 거부(응답에 수신자 주소 반복)·독성 작업·인증 실패 경로의 로그, 시도 기록, 이벤트, 작업 행에 본문·제목·SMTP 비밀번호·수신자 주소(응답 텍스트 안)가 없다.
- `file-channel/poller.integration-spec.ts`: 거부한 파일(형식 오류·검증 실패·서명 불일치·크기 초과·심볼릭 링크·JWE 변조)의 본문 canary가 폴러 로그, 거부 기록, 이벤트, 작업 행에 없다. 로그에는 호출처 ID·사유 코드·크기·sha256·파일 이름만 남는다(파일 이름은 호출처가 정한 값이다).
- `http/rest-intake.integration-spec.ts`: 제목·본문·수신자·Key·필드 이름에 넣은 canary가 응답과 로그에 없고, 설정 직렬화에 SMTP 비밀번호가 없다. `crypto/body-cipher.spec.ts`, `validation/mail-request.spec.ts`, `config/load-config.spec.ts`: 오류 객체에 원문이 없다.

## 11. 호출처와 입력 검증

### RQ-028 호출처 레지스트리와 REST 인증

- [x] **진행 상태:** 검증 완료 (1단계, 2단계 파일 채널 연결로 마무리)

**요구사항:**

- Mailo는 호출처 레지스트리를 설정으로 가진다.
- 레지스트리 항목은 다음을 포함한다.
  - 호출처 식별자(`caller_id`).
  - REST 자격. 평문이 아니라 해시 등으로만 저장한다.
  - 파일 폴더 사용 여부.
  - 서명 사용 여부(`required` 또는 `none`)와 서명 키 참조.
  - 선택: 호출처별 24시간 발송 할당 `sendQuota24h`(RQ-032). 양의 정수이고 생략하면 무제한이다.
- REST의 `caller_id`와 파일 폴더 이름은 같은 값이다. 채널 간 `Idempotency-Key` 중복 방지의 전제다.
- REST 인증은 호출처별 API 키다. `Authorization: Bearer <키>`로 보낸다.
  - 키는 256비트 난수다. 레지스트리에는 SHA-256 해시만 저장하고 상수 시간으로 비교한다.
  - 호출처당 키 2개를 동시에 허용한다(교체용).
  - mTLS는 인증서 발급·갱신과 TLS 종단 위치에 의존하므로 RQ-029와 맞지 않아 채택하지 않는다.
- 파일 채널 호출처도 REST 자격이 필요하다. 작업 조회와 이벤트 피드를 쓰기 위해서다(ADR-0006 결정 5). 같은 `caller_id`로 REST 자격과 파일 폴더를 발급한다.

**수용 조건:**

- [x] 레지스트리에 없는 호출처의 REST 요청과 파일은 거부된다. (REST는 401. 파일은 등록되지 않은 폴더를 읽지 않으므로 수집되지 않고 거부 기록도 없다.)
- [x] 서명 사용 여부가 명시되지 않은 항목은 기동 시 거부된다.
- [x] REST 자격 평문이 설정 저장소와 로그에 남지 않는다.
- [x] 호출처당 API 키 2개가 동시에 유효하다.
- [x] 파일 채널만 쓰는 호출처도 REST 자격이 발급돼 작업 조회와 이벤트 피드를 쓸 수 있다.
- [x] 같은 호출처가 REST와 파일로 같은 Key를 보내면 같은 작업으로 식별된다. (`e2e/file-flow.integration-spec.ts`: REST로 등록한 뒤 같은 Key·같은 내용의 파일을 넣으면 작업 1건·메일 1통이다.)

**판정 근거:**

- `callers/registry.spec.ts`: 해시만 저장, 키 2개 동시 유효, 서명 `mode` 미지정 거부, 키 해시 1~2개 강제(파일 채널 호출처 포함), 오류에 해시 없음. `crypto/api-key.spec.ts`: SHA-256 해시와 상수 시간 비교.
- `http/rest-intake.integration-spec.ts`: 헤더 없음·틀린 키·형식 오류가 같은 401, 두 번째 키로 인증.
- 파일 채널(`fileChannel: true`인 호출처의 폴더만 수집): `file-channel/poller.integration-spec.ts`(같은 Key도 호출처마다 따로 등록, 호출처 A 폴더의 파일은 A로만 등록)와 `e2e/file-flow.integration-spec.ts`(파일 채널 호출처가 REST 자격으로 Key 조회·이벤트 피드 사용).
- `callers/send-quota.spec.ts`: `sendQuota24h` 생략·`null`은 무제한, 양의 정수 읽기, 0·음수·소수·문자열·불리언·10000001 거부.
- `callers/signature-keys.spec.ts`: 서명 키(`signature.keys`)는 변수 이름만 두고 값은 시크릿 파일·환경 변수로 받는다(원문이 필요해 해시로 둘 수 없다, ADR-0008 구현 중 확정). `required`는 키 1~2개, `none`은 키 없음, 값이 설정 객체 직렬화·오류에 없음.

### RQ-029 단순성과 외부 의존성 최소화

- [x] **진행 상태:** 검증 완료 (1단계)

**요구사항:**

- 구현과 운영 구조를 단순하게 유지한다.
- 운영 의존성은 Mailo 앱과 PostgreSQL로 한정한다.
- 별도 메시지 브로커와 외부 메일 서버(Postfix 등)를 두지 않는다.

**수용 조건:**

- [x] 기본 compose 구성에 Mailo와 PostgreSQL 외의 상시 서비스가 없다.

**판정 근거:**

- `docker-compose.yml` 읽기: 서비스는 `postgres`와 `mailo` 둘이다. 자동 검증은 없고 정적 확인이다.
- 2단계에서 npm 의존성 `jose` 6.2.18를 추가했다. JWE·JWS 암호 형식을 직접 만들지 않기 위해서다(ADR-0008 구현 중 확정 8). 운영 의존성(Mailo, PostgreSQL)은 늘지 않았다.

### RQ-030 요청 입력 검증

- [x] **진행 상태:** 검증 완료 (1단계, 2단계 파일 채널 연결로 마무리)

**요구사항:**

- 제목과 주소 필드의 CR·LF 등 헤더 인젝션 입력을 거부해야 한다.
- 수신자 주소 형식을 검증해야 한다.
- 요청당 수신자 수와 요청 크기에 상한을 둬야 한다. REST와 파일 모두 적용한다.
- 기본 상한은 다음과 같다. 모두 설정으로 바꿀 수 있고 수치는 추정이다.
  - 원시 요청(HTTP 본문, 파일 바이트) 2 MiB. JWS·JWE의 base64 이중 인코딩(약 1.8배)을 반영한 값이다.
  - 복호화 뒤 제목+text+html 합 1 MiB.
  - 제목 255자. 주소 254자.
  - 수신자 to+cc+bcc 합 50명. Google relay의 트랜잭션당 수신자 100명보다 낮게 둔다.
  - `Idempotency-Key` 1~128자(RQ-011).
- 첨부파일은 1·2단계에서 지원하지 않는다. `attachments` 필드가 오면 REST는 400, 파일은 수집 거부로 처리한다. 필요해지면 별도 ADR로 정한다.
- 제목과 본문이 암호화돼 있으면 복호화한 뒤 입력 검증을 한다(ADR-0008 결정 3). 원시 크기 상한은 복호화 전에 적용한다.

**수용 조건:**

- [x] 제목에 CR·LF가 든 평문 요청은 등록되지 않고 거부된다.
- [x] 제목을 봉투 암호화한 요청도 같다. (REST와 파일 채널 모두 복호화 뒤 거부한다.)
- [x] 형식이 잘못된 수신자 주소는 거부된다.
- [x] 위 상한을 넘는 요청은 거부된다. REST의 원시 크기 초과는 413이다.
- [x] `attachments` 필드가 있는 요청은 REST에서 400으로 처리된다.
- [x] `attachments` 필드가 있는 파일은 수집 거부로 처리된다. (`ATTACHMENTS_NOT_SUPPORTED`로 거부 기록·이벤트를 남기고 원본을 삭제한다.)

**판정 근거:**

- `validation/mail-request.spec.ts`: CR·LF, 주소 형식·길이(254자, 로컬 파트 64자), 수신자 합 50명, 제목 255자, 본문 1 MiB(UTF-8 바이트), `attachments`. `http/rest-intake.integration-spec.ts`: 원시 2 MiB 초과 413(chunked 포함), 복호화 뒤 1 MiB 초과는 400 `TOO_LARGE`, 수신자 50명 초과 `TOO_MANY`, `attachments` 400. `file-channel/poller.integration-spec.ts`: 파일의 원시 크기 상한(정확히 상한은 수집, 상한 + 1바이트는 `SIZE_EXCEEDED`), `attachments`, 수신자 형식, 제목 CR/LF, 암호화한 제목의 CR/LF가 거부 기록으로 처리된다. `envelope/open-request.spec.ts`, `envelope/rest-envelope.integration-spec.ts`: 암호화한 제목의 CR/LF(`\r\n`, `\n`, U+2028)를 복호화 뒤 `CONTROL_CHARACTER`로 거부하고 등록하지 않는다. 복호화 뒤 크기·누락·알 수 없는 필드도 400이다.

### RQ-031 헬스와 준비 상태

- [x] **진행 상태:** 검증 완료 (1단계)

**요구사항:**

- 프로세스 생존 상태와 의존성 준비 상태를 확인할 수 있어야 한다.
- 준비 상태에는 PostgreSQL 연결을 포함한다.
- 발송이 중지된 상태(SMTP 인증 실패 등)를 확인할 수 있어야 한다.
- 전역 차단기의 상태(`open`·`half_open`), `open_until`, 마지막 사유를 헬스 응답과 로그에 드러내야 한다(ADR-0007 결정 5).

**수용 조건:**

- [x] PostgreSQL에 연결할 수 없으면 준비 상태 확인이 실패한다.
- [x] 발송 중지 상태가 헬스 응답이나 로그에 드러난다.
- [x] 차단기가 `open`이면 헬스 응답에 상태, `open_until`, 마지막 사유가 있다. (`open_until`과 마지막 사유는 유효한 Bearer가 있을 때만 반환한다. 인증 없는 응답은 상태만 반환한다.)
- [x] 차단기가 `closed`인데 발송이 멈춘 경우(점유 루프 정지, 적체)를 운영자 토큰 응답의 `queue.oldestDueAgeSeconds`·`worker.lastPollAgeSeconds`로 확인할 수 있다. (`/health/ready`의 200/503에는 반영하지 않는다. 호출처 API 키로는 반환하지 않는다.)

**판정 근거:**

- `http/health-ops.integration-spec.ts`(PostgreSQL, 5건): 운영자 토큰이 `queue`·`worker`·`filePoller`를 받음(작업 ID·수신자 없음), 호출처 키·인증 없음에는 없음, 운영자 토큰은 업무 endpoint에서 401, 미래 작업은 적체에서 제외, 적체가 10000건을 넘으면 `dueCount`는 10000에서 멈추고 `truncated`. `worker/worker-resilience.integration-spec.ts`: `lastPollAt`이 빈 큐에서도 갱신, `claimFailureStreak`, `pollLoopCrashed`. 한계: 정지·적체 경보 기준값은 정하지 않았고 장시간 부하에서 측정하지 않았다. 파일 폴러의 `lastPollAt`·`lastPollOk`는 응답에 연결했으나 폴러가 켜진 상태의 응답은 테스트하지 않았다.
- `http/rest-intake.integration-spec.ts`: 유효한 Bearer에만 `eventFeed`(RQ-017) 추가. DB 연결 불가 시 `ready` 503과 `unknown`, 인증 없음은 상태만, 유효한 Bearer는 `openUntil`·`lastReason`, `closed`와 `half_open`의 값, 틀린 `Authorization`은 401. Worker는 차단기가 닫히지 않은 결과에 경고 로그를 남긴다(`breaker_not_closed`). 테스트로 단언하지는 않았다.

### RQ-032 호출처별 발송 할당

- [x] **진행 상태:** 검증 완료 (2단계)

**요구사항:**

- 계정 일일 한도를 모든 호출처가 공유하므로, 한 호출처의 대량 발송이 다른 호출처를 굶기지 않게 해야 한다.
- 발송 단계에 호출처별 24시간 rolling 할당을 설정 항목으로 둔다. 기본값은 무제한이다.
- 설정은 호출처 레지스트리의 `sendQuota24h`다(RQ-028). 1~10000000의 정수이고 생략하거나 `null`이면 무제한이다. 0은 허용하지 않는다.
- 사용량은 최근 24시간의 "할당에 드는 시도" 수와 현재 `SENDING`인 작업 수의 합이다. 할당에 드는 시도는 최대 시도 횟수에 포함되는(`counted`) 시도 중 Mailo 내부 오류(`stage = 'WORKER'`)를 뺀 것이다. 계정 상태 오류(`ACCOUNT`) 시도는 들지 않는다. 단위는 메시지 시도 수이고 수신자 수로 가중하지 않는다(ADR-0007 구현 중 확정 7).
- 등록 단계에는 호출처별 쿼터를 두지 않는다. 등록 응답에 429를 쓰지 않는다(ADR-0005 결정 5, ADR-0007 결정 10).
- 할당을 넘긴 호출처의 작업은 점유 대상에서 빼고 시도 횟수를 쓰지 않는다. 제외된 작업의 상태와 `next_attempt_at`도 바뀌지 않는다. 대기 중 만료 시각에 이르면 주기 sweep이 `EXPIRED`로 만든다.

**수용 조건:**

- [x] 할당을 설정한 호출처가 할당을 넘기면 그 호출처의 작업은 점유되지 않고 다른 호출처의 작업은 점유된다.
- [x] 할당 초과로 점유에서 빠진 작업의 시도 횟수가 늘지 않는다.
- [x] 할당을 설정하지 않으면 제한 없이 점유된다.

**판정 근거:**

- `queue/caller-quota.integration-spec.ts`(PostgreSQL) 12건: 할당 안 점유와 남은 건수까지만 점유, 점유 중 작업(`SENDING`)의 사용량 산입, 초과 시 점유 제외와 상태·시도 횟수·`next_attempt_at` 불변, 24시간 윈도우 경과 뒤 재점유, 한 호출처의 초과가 다른 호출처를 막지 않음, 호출처별 서로 다른 할당, 인스턴스 12개의 동시 점유에서도 한도 초과 0건(3라운드), 할당 없음·목록에 없는 호출처·빈 목록의 무제한, 계정 상태 오류·내부 오류는 사용량 불산입과 `TRANSIENT`는 산입, 차단기 `half_open` 대표 작업도 초과 호출처의 작업을 고르지 않음, 초과 대기 작업의 `EXPIRED` 전이.
- `worker/worker-quota.integration-spec.ts`(PostgreSQL + 로컬 SMTP) 3건: 초과 호출처는 한도까지만 발송하고 나머지는 `PENDING`에 남으며 다른 호출처는 모두 발송, `caller_quota_exceeded`는 상태가 바뀔 때 한 번만 남고 수신자 주소가 없음, 윈도우 경과 뒤 재발송과 `caller_quota_recovered`, 할당 미설정 시 무제한.
- `callers/send-quota.spec.ts`(단위): 레지스트리 값 검증(RQ-028).
- 구현: 점유 쿼리 `queue/claim.ts`(`planQuotas`, 호출처별 advisory lock), 마이그레이션 `migrations/0002_caller_quota.sql`(`mail_attempts.caller_id`, 부분 인덱스 2개), 레지스트리→Worker 연결 `app.module.ts`·`worker/runner.ts`, 로그 `worker/worker.ts`.
- 한계와 미검증:
  - 레지스트리는 기동 때 한 번 읽으므로 `sendQuota24h` 변경은 재시작 뒤 반영된다.
  - `0002` 적용 뒤에도 이전 버전 인스턴스가 돌면 `caller_id` 없이 기록한 시도는 사용량에 잡히지 않는다(롤링 배포 구간의 과소 계수).
  - 한 메시지의 수신자가 많아도 1로 센다. 수신자 수 기준 할당은 지원하지 않는다.
  - 인스턴스가 여럿인 동시 점유는 단일 프로세스 안의 병렬 `claim`으로 확인했다. 실제 다중 프로세스·장시간 부하 배포는 확인하지 않았다.
  - 할당이 있는 호출처가 있는데 `MAILO_RECORD_RETENTION_SECONDS`가 86400 미만이면 Worker 기동을 거부한다(`worker/worker.spec.ts`). 사용량이 최근 24시간의 `mail_attempts`를 세는데 기록이 먼저 지워지면 할당이 느슨해지기 때문이다.
  - 실제 Gmail 일일 한도와 이 할당의 관계는 확인하지 않았다. 호출처 할당의 합이 계정 한도를 넘지 않는다는 보장은 없다(한도 초과는 차단기가 처리한다).

## 확정한 항목

2026-11-23 판정으로 미결정에서 확정한 항목이다. 값은 해당 RQ와 ADR이 정한다.

| 항목                    | 반영 위치                                              |
| ----------------------- | ------------------------------------------------------ |
| Key 범위·보존·불일치 처리 | RQ-011, RQ-026, ADR-0005                               |
| 첨부파일                | RQ-002, RQ-030. 1·2단계 미지원                         |
| 본문·이력 보존 기간     | RQ-023, RQ-026                                         |
| REST 인증 방식          | RQ-028. 호출처별 API 키                                |
| 호출처별 발송 할당      | RQ-032                                                 |
| SMTP 포트·TLS 방식      | RQ-005                                                 |
| 입력 상한 수치          | RQ-030                                                 |
| 재시도 기본값           | RQ-008                                                 |
| 이벤트 cursor           | RQ-017, ADR-0006                                       |
| 구현 순서               | 구현 단계 절                                           |
| NFS 통합 테스트 환경    | 아래                                                   |

NFS 통합 테스트 환경(3단계, 추정):

- Linux VM(CI 러너 포함)에서 `nfs-kernel-server`를 같은 호스트에 NFSv4.1 loopback mount한다.
- `root_squash`를 켜고 서로 다른 non-root UID 2개로 실행한다.
- WSL 로컬에서는 건너뛴다. 특권 컨테이너는 필요 없다. (실행 결과: WSL2 커널 6.6에 nfsd 모듈이 있어 건너뛰지 않고 실행했다. `apps/mailo/scripts/nfs/run.sh`.)
- 속성 캐시는 커널 NFS 클라이언트에서 생기므로 loopback으로 재현된다고 본다. (실행 결과: 주소·호스트 이름이 다른 클라이언트 3개를 mount하면 새 폴더 가시성 지연 31초가 재현됐다.)
- GitHub 호스티드 러너에서 mount가 되는지는 확인하지 않았다. `nfs` 잡(선택, `continue-on-error`)을 작성했고 실행해 본 뒤에야 알 수 있다.

## 미결정 항목

다음 항목은 요구사항으로 확정하지 않았다. 결정되면 RQ를 추가하거나 갱신한다.

| 항목                    | 내용                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| 파일 채널 상세          | `link` 방식 덮어쓰기 방지 여부, 실제 NAS의 mount 옵션(NFS loopback 기준은 `docs/operations/nfs.md`에 정했고 실제 NAS는 미검증). 결정됨: 호출처 계정·폴더 모드는 default ACL 권장(ADR-0004 구현 중 확정 14·28, `docs/operations/caller-onboarding.md`), 스키마 필드명과 폴링 간격(30초)·임시 파일 정리 시간(1시간) 기본값은 2단계에서 정했다(ADR-0004 "구현 중 확정") |
| 메시지별 정책           | 재시도 횟수·간격·만료 시간을 요청별로 지정할지 여부                 |
| 반송(Bounce)            | SMTP 수락 이후 반송까지 추적할지 여부                               |
| 관리 기능               | 발송 이력 조회, 실패 작업 수동 재시도, `CANCELED` 상태              |
| 계정 전체 발송 속도 제어 | 한도에 닿기 전에 계정 전체 발송 속도를 선제적으로 제한할지 여부. 한도 초과 응답은 ADR-0007이, 호출처별 할당은 RQ-032가 정했다. 한도 수치는 Google 문서 갱신으로 바뀔 수 있다 |
| 발신자 필드 정책        | 요청의 From·Reply-To 허용 범위. Gmail은 인증 계정과 다른 From을 덮어쓸 수 있다. 필드 자체는 Key 지문 범위(RQ-011)에 포함한다 |
| SMTP Relay 송신 IP      | Workspace SMTP Relay가 IP 허용 방식이면 Docker 송신 IP 고정이 필요한지 확인 |
| 비기능 요구             | 처리량 목표, 메트릭                                                 |
| ADR 미확정 항목         | 차단기 키 구성(SMTP 구성이 여럿일 때), 실제 Gmail 응답 대조. lease·SMTP 타임아웃, 폴링 간격과 점유 수, 응답 텍스트 마스킹은 1단계 구현 중 확정했다(ADR-0002·0007의 "구현 중 확정"). 각 ADR의 미확정 절을 따른다 |
