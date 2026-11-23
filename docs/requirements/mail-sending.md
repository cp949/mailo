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
- [ADR-0009](../adr/0009-claim-priority.md): 우선순위 등급, 점유 경로(우선순위·대기 순서), 지문의 `policy.priority`, 배포·롤백 순서. ADR-0002 구현 중 확정 2의 점유 인덱스·순서를 이어받는다.
- [ADR-0010](../adr/0010-per-request-job-ttl.md): 요청별 만료 시간 `ttlSeconds`, 허용 범위와 상한 설정, 지문의 `policy.ttlSeconds`, 만료 의미, 보존 기간 기동 검사, 배포 순서. ADR-0002 결정 7의 요청별 지정 미결정을 정한다.
- [ADR-0011](../adr/0011-operations-control-and-caller-protection.md): 읽기·관리 운영 토큰, 발송 정지(전체·호출처), 작업 취소(`CANCELED`), 감사 기록, 운영 REST와 CLI, 호출처별 수신 도메인 허용 목록, 이벤트 피드 공백 신호, 결과 불명 표시(`outcomeUncertain`), 배포·롤백 순서. 구현 묶음 A(작업 취소, RQ-040·041), 묶음 B(토큰 분리, 발송 정지, 감사, `/ops` REST, 관리 취소, RQ-042~044), 묶음 C(피드 공백, 수신 도메인 허용 목록, CLI, RQ-045~047), 묶음 D(`outcomeUncertain`, RQ-048)를 구현했다. 호출처 단위 일괄 취소는 ADR상 범위 밖이다.
- [ADR-0012](../adr/0012-metrics-endpoint.md): `GET /metrics`(읽기 토큰만, 관리 토큰 403), 전역 gauge와 인스턴스 counter 구분, 라벨 규칙과 시리즈 상한, TTL 캐시·단일 비행, 수동 텍스트 직렬화, 감사 행 수 지표. 구현했다(RQ-049~052).
- [ADR-0013](../adr/0013-multiple-smtp-accounts.md): 다중 SMTP 계정(`MAILO_SMTP_ACCOUNTS_FILE`, `default` 출처 규칙), 호출처의 `accountId`와 작업의 등록 때 계정 고정, 계정 단위 점유·차단기·정지·24시간 할당, 마이그레이션 `0010`~`0016`, 관측과 운영 표면, 발신 주소 허용 집합. 구현 묶음 A(RQ-053~056)와 B(RQ-057~059)를 구현했고 C·D는 구현 전이다.

ADR-0001~0010은 2026-11-23에, ADR-0011~0013은 2026-11-24에 승인됐다.

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
- 검증 수치(2026-11-24 7단계 묶음 A 다중 SMTP 계정 모델 반영 뒤): `pnpm test` 단위 858건(47개 파일), `pnpm test:integration` 통합 711건(48개 파일, 실제 PostgreSQL 17과 로컬 `smtp-server`), 실패 0건. `pnpm format:check`·`pnpm typecheck`·`pnpm build` 통과, `pnpm lint` 경고·오류 0건. 기존 테스트의 변경은 네 가지다. (1) `config.smtp`가 `config.smtpAccounts`로 바뀌어 `config/load-config.spec.ts`·`http/rest-intake.integration-spec.ts`·`support/file-channel.ts`의 접근 경로와 필드 이름(`defaultFrom`→`from`)을 고쳤다. (2) `RegisterInput.accountId`가 필수가 되어 `support/queue-fixtures.ts`의 입력과 `envelope/open-request.spec.ts`의 인자에 `accountId`를 더했다. (3) `db/ops-controls.integration-spec.ts`·`db/event-purges.integration-spec.ts`는 0001~0007·0001~0008만 적용한 schema에 작업 행을 넣는데 `register`가 `account_id`를 쓰므로 컬럼 없는 옛 형태의 `INSERT`(`createLegacyJob`)로 바꿨다(단언은 그대로). (4) `db/event-purges.integration-spec.ts`의 "전체 적용 시 0009가 마지막"은 0010·0011이 이어지므로 "0008 바로 뒤에 0009"로 고쳤다. 나머지 기존 단언은 바꾸지 않았다. 컨테이너 스크립트 `verify-sigterm-file.sh`·`verify-sigkill-duplicate.sh`를 실행했다(`docker-compose.yml`에 주석만 더했고 코드 경로가 Worker 조립을 지나므로, 스크립트 검증이라 `[x]` 근거에 쓰지 않았다): `verify-sigterm-file.sh`는 SIGTERM 뒤 재기동에서 작업 1000건이 모두 `SENT`이고 SMTP 수신 1000통(유일 `Message-ID` 1000), 남은 파일 0이었다. `verify-sigkill-duplicate.sh`는 관찰 스크립트이며 같은 `Message-ID`로 2통이 SMTP에 도착했다(`attempts=2`, 중복 발송 재현, RQ-013의 기존 한계와 같다). 두 스크립트 모두 단일 계정(`default`) 구성이다. `verify-metrics.sh`·`scripts/volume/`·`pnpm test:nfs`·샘플 e2e는 실행하지 않았다(해당 영역 변경 없음. 샘플은 호출처 API 계약이 바뀌지 않았다). 읽기 전용 컨테이너의 계정 파일 마운트와 `_FILE` 비밀 읽기, 실제 Gmail 계정 둘은 실행하지 않았다(RQ-053~056 판정 근거).
- 검증 수치(2026-11-24 8단계 관측성 `/metrics` 반영 뒤): `pnpm test` 단위 776건(43개 파일), `pnpm test:integration` 통합 663건(44개 파일, 실제 PostgreSQL 17과 로컬 `smtp-server`), 실패 0건. `pnpm format:check`·`pnpm typecheck`·`pnpm build` 통과, `pnpm lint` 경고·오류 0건. 전체 통합은 한 번의 묶음으로 실행했고 실패한 파일이 없었다. 기존 테스트의 단언은 한 곳만 바꿨다(취소 결과 `canceled`에 `callerId` 필드가 더해져 `queue/cancel.integration-spec.ts`의 기대값 두 곳이 새 필드를 포함한다, ADR-0012 구현 중 확정 1). Dockerfile·종료 순서·파일 채널 I/O·`docker-compose.yml`은 바꾸지 않았다(`.env.example`은 주석만 더했다). `scripts/container/verify-metrics.sh`를 실행했다(read_only 컨테이너에서 `/metrics` 응답·토큰 행렬·`promtool check metrics`, 스크립트 검증이라 `[x]` 근거에 쓰지 않았다). 실제 Prometheus 스크레이프와 `promtool check rules`는 일회성 확인이다(ADR-0012 구현 중 확정 11). `verify-sigterm-file.sh`·`verify-sigkill-duplicate.sh`·`scripts/volume/`·`pnpm test:nfs`·샘플 e2e는 실행하지 않았다(해당 영역 변경 없음, RQ-049~052 판정 근거).
- 검증 수치(2026-11-24 6단계 묶음 D `outcomeUncertain` 반영 뒤): `pnpm test` 단위 709건(38개 파일, 이 묶음은 단위 테스트를 더하지 않았다), `pnpm test:integration` 통합 590건(40개 파일, 실제 PostgreSQL 17과 로컬 `smtp-server`), 실패 0건. `pnpm format:check`·`pnpm typecheck`·`pnpm lint`·`pnpm build` 통과. 전체 통합 첫 실행에서 `http/rest-intake.integration-spec.ts` 1건이 실패했다. `Job`의 키 목록을 고정한 단언에 새 필드 `outcomeUncertain`이 없었기 때문이고(RQ-048이 정한 계약 필드) 기대 키 목록에 필드를 더한 뒤 그 파일(58건)이 통과했다. 샘플은 Gradle 단위 34건 통과(`EventFeedPollerApplyTest`에 1건 더함), `samples/spring-boot-relay/verify/run-e2e.sh` 통과 123·실패 0(S3에 새 필드 검사 3항목을 더했다, 스크립트 검증이라 `[x]` 근거에 쓰지 않았다). 샘플의 main 코드는 바꾸지 않았다. 마이그레이션·Dockerfile·compose·종료 순서·파일 채널 I/O는 바꾸지 않아 `scripts/container/`·`scripts/volume/`·`pnpm test:nfs`는 실행하지 않았다(RQ-048 판정 근거).
- 검증 수치(2026-11-24 6단계 묶음 C 이벤트 피드 공백 감지·수신 도메인 허용 목록·운영 CLI 반영 뒤): `pnpm test` 단위 709건(38개 파일), `pnpm test:integration` 통합 564건(38개 파일, 실제 PostgreSQL 17과 로컬 `smtp-server`), 실패 0건. `pnpm format:check`·`pnpm typecheck`·`pnpm build` 통과, `pnpm lint` 경고·오류 0건. 한 번의 검증 묶음이고 같은 소스에서 다시 실행하지 않았다. Dockerfile·compose·종료 순서·파일 채널 I/O는 바꾸지 않았고 `.env.example`은 주석만 더했다(`config/compose-consistency.spec.ts`가 새 변수 이름을 확인한다). 샘플은 Gradle 단위 33건 통과, `samples/spring-boot-relay/verify/run-e2e.sh` 통과 120·실패 0(S16 신규 18항목, 스크립트 검증이라 `[x]` 근거에 쓰지 않았다). 읽기 전용 루트 컨테이너(`--read-only --cap-drop ALL --security-opt no-new-privileges`) 안의 CLI 실행을 1회 확인했다(`docker run`·`docker exec`, 스크립트 검증이라 `[x]` 근거에 쓰지 않았다). `scripts/container/verify-sigterm-file.sh`·`verify-sigkill-duplicate.sh`·`scripts/volume/`·`pnpm test:nfs`는 실행하지 않았다(해당 영역 변경 없음, RQ-045~047 판정 근거).
- 검증 수치(2026-11-24 6단계 묶음 B 운영 토큰·발송 정지·감사·`/ops` 반영 뒤): `pnpm test` 단위 622건(33개 파일), `pnpm test:integration` 통합 513건(32개 파일, 실제 PostgreSQL 17과 로컬 `smtp-server`), 실패 0건. `pnpm format:check`·`pnpm typecheck`·`pnpm build` 통과, `pnpm lint` 경고·오류 0건. 전체 통합 첫 실행에서 `http/rest-intake.integration-spec.ts` 1건이 실패했다. 호출처 키 `/health/ready`의 응답 동등 비교에 새 필드 `sendPaused`가 없었기 때문이고(ADR-0011 구현 중 확정 17) 기대값에 필드를 더한 뒤 그 파일(58건)이 통과했다. 이 뒤 독립 리뷰 지적 2건(운영자 작업 응답의 거부 수신자 노출, `/ops` 경로 파라미터 디코딩 오류가 인증보다 먼저 나가는 문제, ADR-0011 구현 중 확정 19·20)을 고치고 전체 검증을 다시 실행해 위 수치를 얻었다. Dockerfile·종료 순서·파일 채널 I/O는 바꾸지 않았고 `docker-compose.yml`은 주석만 더했다. `scripts/container/verify-sigterm-file.sh`를 1회 실행했다(컨테이너 안에서 `0001`~`0008`을 적용하고 기동한 뒤 SIGTERM 종료 코드 0, 재기동 뒤 1000통 중복·유실 없음, 스크립트 검증이라 `[x]` 근거에 쓰지 않았다). `verify-sigkill-duplicate.sh`는 실행하지 않았다. `scripts/volume/`·`pnpm test:nfs`·샘플 e2e는 실행하지 않았다(해당 영역 변경 없음, RQ-042~044 판정 근거).
- 검증 수치(2026-11-24 6단계 묶음 A 작업 취소 반영 뒤): `pnpm test` 단위 602건(31개 파일), `pnpm test:integration` 통합 405건(27개 파일, 실제 PostgreSQL 17), 실패 0건. `pnpm format:check`·`pnpm typecheck`·`pnpm build` 통과, `pnpm lint` 경고·오류 0건. 이 묶음은 단위 테스트를 더하지 않았다(취소는 PostgreSQL 통합 테스트가 확인한다). 샘플은 Gradle 단위 33건 통과, `samples/spring-boot-relay/verify/run-e2e.sh` 통과 102·실패 0(S15·S15b 신규, 스크립트 검증이라 `[x]` 근거에 쓰지 않았다). Dockerfile·compose·파일 채널 I/O를 바꾸지 않아 `scripts/container/`·`scripts/volume/`·`pnpm test:nfs`는 실행하지 않았다(RQ-040·041 판정 근거).
- 검증 수치(2026-11-23 5단계 요청별 만료 시간 반영 뒤): `pnpm test` 단위 602건(31개 파일), `pnpm test:integration` 통합 363건(25개 파일), 실패 0건. `pnpm format:check`·`pnpm typecheck`·`pnpm build` 통과, `pnpm lint` 경고·오류 0건. Dockerfile·compose·파일 채널 I/O·봉투 형식·샘플을 바꾸지 않아 `scripts/container/`·`scripts/volume/`·`pnpm test:nfs`·샘플 e2e를 실행하지 않았다(RQ-039 판정 근거).
- 검증 수치(2026-11-23 개발용 Mailpit profile 반영 뒤): `pnpm test` 단위 568건(31개 파일), 실패 0건. `pnpm format:check`·`pnpm typecheck` 통과, `pnpm lint` 경고·오류 0건. 소스 변경이 없어 통합 테스트는 다시 실행하지 않았다. compose 변경이라 `scripts/container/verify-sigterm-file.sh`(1000건, 종료 코드 0, 재기동 뒤 중복·유실 없음)·`verify-sigkill-duplicate.sh`(같은 Message-ID 2통, 기대대로)를 실행했다. `--profile mailpit`으로 띄운 별도 compose 프로젝트에서 Mailo→Mailpit 1건 발송을 수동 확인했다(RQ-029 판정 근거).
- 검증 수치(2026-11-23 평문 SMTP 모드 반영 뒤): `pnpm test` 단위 563건(31개 파일), 실패 0건. 관련 통합 `e2e/smtp-plaintext.integration-spec.ts`·`e2e/mail-flow.integration-spec.ts` 9건(2개 파일), 실패 0건. `pnpm format:check`·`pnpm typecheck` 통과, `pnpm lint` 경고·오류 0건. 전체 통합·컨테이너·볼륨·NFS·샘플 e2e는 실행하지 않았다(RQ-005 판정 근거).
- 검증 수치(2026-11-23 발송 우선순위 구현 리뷰 뒤, 다음 줄의 실행보다 나중): 다음 줄(4단계 반영 뒤) 실행과 코드 동작이 같고 문서·주석만 바뀐 상태에서 다시 실행한 결과다. 같은 코드의 앞선 전체 통합 실행은 실패 0건이었으므로 아래 1건은 간헐 실패로 본다(원인 미확정). `turbo --force`로 단위 547건(31개 파일), 타입 검사·린트·빌드를 새로 실행해 통과했다. 단위 실패와 린트 경고·오류는 0건이다. 관련 통합 58건(5개 파일)은 실패 0건이다. 전체 통합은 333건 중 332건 통과·1건 실패했다. 실패는 `worker/worker-quota.integration-spec.ts`의 무제한 발송 대기에서 `waitFor 시간 초과`였다. 소스 변경 없이 실패 파일만 재실행해 3건 모두 통과했다. 최초 실패 원인은 미확정이며 전체 통합을 한 번에 통과한 결과로 기록하지 않는다. 포맷·diff 공백 검사도 통과했다. 롤백 전 미확인 Key 처리와 점유 지연 설명을 정적 검토로 보완했다. 성능 측정·실제 롤백·NFS·컨테이너·볼륨·샘플 e2e는 이번 리뷰에서 실행하지 않았다. 기존 성능 수치는 이전 수동 측정 기록이다.
- 검증 수치(2026-11-23 4단계 발송 우선순위 반영 뒤): `pnpm test` 단위 547건(31개 파일), `pnpm test:integration` 통합 333건(22개 파일), 실패 0건. `pnpm lint` 경고·오류 0건, `pnpm typecheck` 통과. 이 묶음은 Dockerfile·compose·파일 채널 I/O·샘플을 바꾸지 않아 `scripts/container/`·`scripts/volume/`·`pnpm test:nfs`·샘플 e2e를 실행하지 않았다(RQ-033~038 판정 근거).
- 검증 수치(2026-11-23 코드 리뷰 운영·컨테이너·로그 묶음 반영 뒤, 같은 작업 트리의 다른 묶음 변경 포함): `pnpm test` 단위 505건(30개 파일), `pnpm test:integration` 통합 278건(19개 파일), 실패 0건. 읽기 전용 루트·`cap_drop`·digest 고정 이미지로 `scripts/container/verify-sigterm-file.sh`·`verify-sigkill-duplicate.sh`와 `scripts/volume/verify-e2e.sh`(acl·group)를 실행해 모두 기대와 일치했다. `verify-permissions.sh`(acl·group, 각 28개), `verify-root-model.sh`(15개), `verify-atomic-rename.sh`(acl·group, 각 4개)도 같은 날 실행해 기대와 다름 0건이었다. 이 수치를 낸 시점에는 `nfs-kernel-server`가 없어 `pnpm test:nfs`와 `apps/mailo/scripts/nfs/verify-docker-volume.sh`를 실행하지 못했다. 같은 날 뒤에 로컬에 `nfs-kernel-server` 2.6.1을 설치해 `scripts/nfs/run.sh`(`pnpm test:nfs` 31건, 기본 NFSv4.1 클라이언트 1회, 통과)와 `verify-docker-volume.sh`(통과 13, 실패 0)를 실행했다(RQ-002 판정 근거).
- 검증 수치(2026-11-23 코드 리뷰 1묶음 반영 뒤): `pnpm test` 단위 449건(25개 파일), `pnpm test:integration` 통합 242건(18개 파일), 실패 0건. 이 묶음 뒤 `scripts/container/verify-sigterm-file.sh`·`verify-sigkill-duplicate.sh`를 각 1회 실행해 기대와 일치했다(`POSTGRES_PASSWORD` 필수화·`MAILO_STOP_GRACE_PERIOD` 반영 compose). `pnpm test:nfs`·`scripts/volume/`은 이 묶음에서 실행하지 않았다.
- 직전 수치(2026-11-23 최종 마무리 실행 결과): `pnpm test` 단위 407건(23개 파일), `pnpm test:integration` 통합 222건(15개 파일, 파일 채널 `file-channel/poller.integration-spec.ts`, `e2e/file-flow.integration-spec.ts`, 호출처 할당 테스트 포함), `pnpm test:nfs`는 NFS 환경이 정리돼 이번에 실행하지 않았다(직전 3단계 마무리 실행 31건, NFSv4.1·4.2 기본값 각각, 실패 0건). 볼륨 스크립트(`scripts/volume/`, a~g)는 CI 워크플로 작성 뒤 2026-11-23에 7개 실행(acl·group 포함)을 모두 다시 실행해 기대와 다름 0건이었다. 컨테이너 스크립트 `scripts/container/`(SIGKILL 중복 발송, SIGTERM 파일 처리)도 같은 날 종료 순서(pause 선행)·compose 기본값 변경 뒤 각 1회 실행해 기대와 일치했다. 단위·통합 실패는 0건이다.
- 수치 이력: 1단계 마무리 뒤 단위 274건·통합 116건(종단 `e2e/mail-flow.integration-spec.ts` 7건 포함), 파일 채널 폴러 구현 뒤 단위 370건·통합 199건. 1단계 마무리 때 쓰지 않던 `smtp/backoff.ts`와 그 테스트를 지워 단위가 이전 보고(287건)보다 13건 줄었다.
- 모든 SMTP 검증은 로컬 `smtp-server` 대상이다. 실제 Gmail·Workspace SMTP와 실제 NAS 제품은 확인하지 않았다. NFS는 같은 호스트 loopback에서 `pnpm test:nfs`와 Docker NFS 볼륨 스크립트(`verify-docker-volume.sh`)로 확인했다(ADR-0004 구현 중 확정 20~27·35, `docs/operations/nfs.md`). 이 테스트와 `scripts/volume/` 스크립트는 `pnpm test`·`pnpm test:integration`에 포함되지 않는다. GitHub Actions 워크플로(`.github/workflows/ci.yml`, `docs/operations/ci.md`)는 GitHub에서 여러 번 성공했다(dev 최근 run 45185115879, `ab7d879`, 2026-11-23, `static`·`integration`·`container`). `nfs` 잡은 GitHub 호스티드 러너에서 1회 통과했다(run 45127889424, `c75052a`, 2026-11-23, 수동 실행). 범위는 같은 러너 안의 loopback NFS다. schedule 실행 기록은 없다.
- 2026-11-23 3단계 마무리에서 RQ-003·004·013·016·021·022·024·028·032와 문서 정합을 갱신했다(운영 문서 `docs/operations/`).

## 구현 단계

| 단계 | 범위 |
| ---- | ---- |
| 1단계 | REST 등록·조회·이벤트 피드, 큐·Worker, ADR-0005·0007 규칙, DB 본문 암호화(ADR-0008 결정 6·7), 호출처별 API 키 인증 |
| 2단계 | 파일 채널(같은 호스트 볼륨), JWS, JWE, 호출처별 발송 할당(RQ-032) |
| 3단계 | NAS/NFS 통합 테스트, 사용처 연동 문서와 운영 문서 |
| 4단계 | 발송 우선순위(RQ-033~038, ADR-0009) |
| 5단계 | 요청별 만료 시간(RQ-039, ADR-0010) |
| 6단계 | 운영 제어와 호출처 보호(ADR-0011). 묶음 A 작업 취소(RQ-040·041), 묶음 B 운영 토큰·발송 정지·감사·`/ops`(RQ-042~044), 묶음 C 이벤트 피드 공백 감지·수신 도메인 허용 목록·운영 CLI(RQ-045~047), 묶음 D 결과 불명 표시(RQ-048)를 구현했다. 호출처 단위 일괄 취소는 ADR상 범위 밖이다 |
| 8단계 | 관측성(ADR-0012). `GET /metrics`(RQ-049), 이름·라벨 규칙(RQ-050), 전역 gauge(RQ-051), 인스턴스 counter·gauge(RQ-052). 마이그레이션 없음 |
| 7단계 | 다중 SMTP 계정(ADR-0013). 구현 묶음 A 계정 모델(RQ-053~056, 마이그레이션 `0010`·`0011`)과 B 계정 단위 점유(RQ-057~059, 마이그레이션 `0012`~`0016`)를 구현했다. C 운영 표면, D 호출처 동시 상한(선택)은 구현 전이다. RQ-060 이후를 해당 묶음에서 추가한다 |

- 이유: Key, 오류 분류, 차단기를 파일시스템 변수 없이 먼저 검증한다. JWE는 선택 기능이다.
- NAS/NFS 수용 조건과 문서 수용 조건은 해당 RQ의 구현 단계와 무관하게 3단계에 확인한다.

1단계 구현 상태(2026-11-23 갱신):

- 구현·테스트 완료: REST 등록·조회·이벤트 피드·헬스, 큐(점유·lease·sweep·보존 삭제), Worker, SMTP 분류, 전역 차단기, DB 본문 암호화, 호출처별 API 키.
- 피드 지연 메트릭(RQ-017): 인증된 `/health/ready`의 `eventFeed` 필드로 구현했다. 8단계에서 최신 이벤트의 경과 초를 `/metrics`의 `mailo_caller_latest_event_age_seconds`로도 낸다(RQ-051). 로그로는 내보내지 않는다.
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
- 확인하지 않은 것: 실제 NAS 제품, 서버 재시작·failover, bind mount·rootless Docker의 권한 모델. (실제 SIGTERM을 받은 프로세스의 종료는 이 시점에는 확인하지 않았고, 같은 날 3단계에서 `scripts/container/verify-sigterm-file.sh`로 확인했다. 아래 RQ-025 판정 근거.)
- 구현 세부와 추정과 다른 점은 ADR-0004 "구현 중 확정"에 있다.

3단계 구현 상태(2026-11-23 갱신):

- 구현·검증 완료: NAS/NFS loopback 통합 테스트(`pnpm test:nfs` 31건, NFSv4.1·4.2 각각), 같은 호스트 Docker named volume 권한·e2e 스크립트(`scripts/volume/` 7항목 a~g), `ESTALE` 처리 수정(`file-channel/errno.ts`), 호출처별 발송 할당(RQ-032).
- 문서: 운영 문서 `docs/operations/`(README, deployment, key-management, caller-onboarding, troubleshooting, nfs), 사용처 연동 지침(`caller-onboarding.md`의 outbox + relay, 이벤트 피드 소비, Key 조회 404 처리).
- 권한 문구: 사용자 위임 결정으로 ADR-0004 결정 8과 RQ-024에 "default ACL 권장, 공용 그룹 + setgid는 대안" 보완 표기를 달았다(ADR-0004 구현 중 확정 28).
- 미검증 목록: 실제 Gmail·Workspace SMTP, 실제 NAS 제품(서버 재시작·failover, NFSv3·4.0·Kerberos 포함), `hard` mount에서 서버를 멈췄을 때의 폴러 정지 감지, GitHub 호스티드 러너의 ESTALE 경로와 `nfs` 잡 schedule 실행(`nfs` 잡은 2026-11-23 run 45127889424에서 1회 통과, 러너 ESTALE 표본 0/40. `static`·`integration`·`container` 잡은 성공), bind mount·rootless Docker, 호스트 외 환경. Java 사용처 샘플(`samples/spring-boot-relay/`)은 컴파일하고 이 저장소의 Mailo와 실행해 확인했다(RQ-021·022, 확인한 범위는 각 RQ의 판정 근거). SIGKILL 중복 발송과 컨테이너 SIGTERM은 로컬 Docker에서 관찰했다.

4단계 구현 상태(2026-11-23 갱신):

- 구현·검증 완료: 요청 `priority` 필드, 지문 `policy.priority`(도입 전 골든 값 고정), 점유 두 경로와 `MAILO_CLAIM_FIFO_RATIO`, 마이그레이션(`0004` 컬럼·CHECK, `0005` 인덱스, INVALID 인덱스 fail-closed), 조회 응답과 운영자 헬스 수치. RQ-033~037은 검증 완료다.
- RQ-038은 진행 중이다. 점유 쿼리 성능은 측정해 기준(2배 이내)을 충족했으나 수동 측정이다(최대 1.08배, ADR-0009 구현 중 확정 3). 문서 갱신은 검토로만 확인했다. 롤링 배포·롤백 실행과 대용량 `0005` 적용은 확인하지 않았다.

5단계 구현 상태(2026-11-23 갱신):

- 구현·검증 완료: 요청 `ttlSeconds` 필드(하한 60, 상한 `MAILO_JOB_EXPIRY_MAX_SECONDS`), 지문 `policy.ttlSeconds`(생략 요청의 도입 전 골든 값 고정), 등록 때 만료 시각 고정, 기동 검사(기본 TTL ≤ 상한 ≤ 기록 보존). 마이그레이션은 없다.
- RQ-039는 진행 중이다. 문서 갱신은 검토로만 확인했다. 롤링 배포·롤백은 실행하지 않았다.

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
- [ ] 같은 호스트 볼륨(2단계)과 NAS/NFS 폴더(3단계) 모두에서 수집된다. (같은 호스트 Docker named volume은 확인했다: 실제 Mailo 컨테이너 e2e 15개 확인, 두 방식 모두 통과, 임시 이름·rename 가시성 포함. `scripts/volume/verify-e2e.sh`이고 jest 통합 테스트에는 없다. CI 워크플로 `container` 잡으로 GitHub 러너에서 성공했다(예: run 45185115879, 2026-11-23). bind mount와 실제 NAS는 확인하지 않았다. NFS loopback(NFSv4.1·4.2)은 `pnpm test:nfs`로, Docker local 드라이버 NFS named volume으로 컨테이너가 수집하는 경로는 `apps/mailo/scripts/nfs/verify-docker-volume.sh`(스크립트 검증, 통과 13)로 확인했다: 호출처 UID가 NFS에 rename한 파일을 별개 NFS 클라이언트의 Mailo가 수집·삭제하고, 기존 폴더 rename 가시성은 mount 옵션과 무관하게 7~13 ms, 새 폴더는 기본 mount 옵션에서 31초라 `lookupcache=pos`를 권장한다. `nfs` 잡(수동·주 1회, 선택)은 GitHub 러너에서 1회 통과했다(run 45127889424, 2026-11-23, 같은 러너 loopback NFS).)
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
- 컨테이너 시작 검사(2026-11-23, 코드 리뷰 반영): 파일 채널이 켜져 있고 `<root>/inbox`가 없거나 통과할 수 없으면 앱이 기동을 거부한다(`poller.integration-spec.ts`). 호출처 폴더 하나가 없는 것은 경고만 남긴다. `inbox`의 읽기 권한은 요구하지 않는다(권한 모델의 `0711`). 처음 구현이 읽기도 요구해 `scripts/volume/verify-e2e.sh`에서 기동하지 못했고 그 결과로 고쳤다(ADR-0004 구현 중 확정 34).
- NFS를 컨테이너에서 쓰는 구성(`docker-compose.nfs-example.yml`, Docker local 드라이버 `type: nfs` named volume)은 2026-11-23에 같은 호스트 loopback NFS(`nfs-kernel-server` 2.6.1)에서 `apps/mailo/scripts/nfs/verify-docker-volume.sh`로 실행해 확인했다(종료 코드 0, 통과 13, 실패 0). 확인한 것: `vers=4.2,hard,lookupcache=pos` named volume으로 컨테이너 기동, `nfs4` mount, non-root UID 1000, 읽기 전용 루트·`/tmp` tmpfs·`CapEff` 0, 호출처 UID 2001(umask 077)이 넣은 파일의 등록·삭제, 로그에 본문 없음, `<root>/inbox`가 없으면 종료 코드 1. 이 검증은 스크립트이고 jest에 포함되지 않아 수용 조건 `[x]`로 올리지 않았다. `hard` mount에서 NAS가 멈췄을 때의 동작은 코드 읽기 결과만 있다(실행하지 않음. `docs/operations/nfs.md`, ADR-0004 구현 중 확정 35).
- NFS loopback 재실행(2026-11-23, 수정된 `CallerClient` 포함): `scripts/nfs/run.sh`가 종료 코드 0, 31건 통과(기본 NFSv4.1 클라이언트 1회. 4.2 기본값 전체 재실행은 하지 않았다).
- 미확인: 실제 NAS 제품, 서버 재시작·failover, NFSv3·4.0·Kerberos, bind mount, `hard` mount에서 서버를 멈췄을 때의 폴러 정지 감지, 다른 호스트·실제 NAS의 Docker NFS 볼륨, rootless Docker, GitHub 호스티드 러너의 ESTALE 경로(`nfs` 잡은 2026-11-23 run 45127889424에서 1회 통과, 러너 ESTALE 표본 0/40).

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
- 연결 보안 방식(`MAILO_SMTP_SECURITY`)은 운영자 설정이다.
  - 기본값은 `starttls`다. 587 포트와 STARTTLS 필수다.
  - `tls`는 465 포트 implicit TLS다.
  - `none`은 TLS 없는 평문 연결이다. 명시해야만 쓰이고 `NODE_ENV`와 무관하게 받는다.
- 평문 연결(`none`)에서는 SMTP 인증 정보와 메일이 암호화 없이 전송된다. 사용 판단은 운영자 책임이다. Mailo는 기동 때 warn 로그 한 줄로 알린다.
- 인증서 검증을 끄지 않는다. TLS를 쓰는 연결은 TLS 1.2 이상만 허용한다.
- SMTP 라이브러리는 nodemailer다(10.6.1). 구현이 쓰는 옵션은 `starttls`에서 `secure: false`와 `requireTLS: true`, `tls`에서 `secure: true`, `none`에서 `secure: false`와 `ignoreTLS: true`, 공통으로 `tls.minVersion: "TLSv1.2"`다. `ignoreTLS`가 없으면 nodemailer가 서버가 광고한 STARTTLS로 올라가므로 평문을 유지하려고 켠다. `rejectUnauthorized`는 지정하지 않아 인증서 검증이 켜져 있다. 로컬 SMTP 서버 대상 테스트로 확인했고 실제 Gmail 서버로는 확인하지 않았다.

**수용 조건:**

- [ ] 설정 변경만으로 개발·운영 SMTP 서버가 전환된다. (설정 읽기와 발송기 조립은 확인했다. 실제 Gmail·Workspace 서버 전환은 확인하지 않았다.)
- [x] 기본 설정에서 587 포트의 STARTTLS 연결로 발송된다.
- [x] 설정으로 465 포트 implicit TLS 연결을 선택하면 그 연결로 발송된다.
- [x] 인증서 검증을 끄는 설정이 없다. TLS 1.2 미만 연결은 실패한다.
- [x] `starttls`·`tls` 설정에서 TLS를 쓸 수 없는 서버에는 평문으로 발송하지 않고 실패한다.
- [x] SMTP 인증 정보는 설정 파일 평문이 아닌 환경 변수 또는 시크릿으로 받을 수 있다.
- [x] `MAILO_SMTP_SECURITY`를 설정하지 않으면 `starttls`다. `none`은 모든 `NODE_ENV`(production 포함)에서 받는다. 알 수 없는 값은 기동을 거부하고 오류에 값이 없다.
- [x] `none` 설정이면 서버가 STARTTLS를 광고해도 TLS로 올리지 않고 평문으로 인증·발송한다.
- [x] `none` 설정으로 기동하면 warn 로그 `smtp_plaintext_enabled`가 한 줄 남고 SMTP 인증 정보·본문·제목·수신자가 로그에 없다(canary 검사).

**판정 근거:**

- `smtp/sender.spec.ts`: STARTTLS 발송, implicit TLS 발송, STARTTLS 설정으로 implicit 포트 접속 실패. 로컬 `smtp-server` 3.21.7 대상이다.
- `smtp/nodemailer-errors.spec.ts`: STARTTLS 미지원 서버에 평문 발송하지 않음, 신뢰하지 않는 인증서 실패, TLS 1.1 서버 협상 실패, implicit TLS 설정으로 평문 서버 접속 실패.
- `config/load-config.spec.ts`: SMTP 사용자·비밀번호 쌍 검증, 시크릿 `_FILE`이 환경 변수보다 우선(키링 테스트), 오류에 값이 남지 않음. `MAILO_SMTP_SECURITY` 기본값 `starttls`, `none`의 포트 기본값 587과 production 포함 수락, 알 수 없는 값(`NONE`, `plaintext` 등) 거부.
- `smtp/sender.spec.ts` "평문 모드 NONE": STARTTLS를 광고하는 서버에 평문(`secure: false`)으로 인증·발송, STARTTLS 미지원 서버에 평문 발송, implicit TLS 포트 접속 실패.
- `worker/worker.spec.ts`: 설정 값과 발송기 `tlsMode` 대응, `none`일 때만 warn 로그 한 줄과 canary 비밀번호 부재.
- `e2e/smtp-plaintext.integration-spec.ts`: 앱 전체 경로(등록, 설정으로 만든 Worker, nodemailer)가 STARTTLS를 광고하는 로컬 서버에 평문으로 인증·발송해 `SENT`가 되고, 로그에 warn 한 줄과 canary 부재(2026-11-23).
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
  - 만료 TTL 24시간. 요청은 `ttlSeconds`로 상한 안에서 바꿀 수 있다(RQ-039).
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
- `queue/circuit-breaker.integration-spec.ts`(여러 인스턴스 공유 근거): 서로 다른 작업 8건의 계정 오류 결과를 `Promise.all`로 동시에 기록해도 연속 실패가 임계값 3에서 멈추고 `open`, 시도 횟수 합이 2다(전이 한 번). 같은 파일: 3회 `open`, 일일 한도 즉시 `open`과 1시간 고정, 순간 한도 5분에서 30분까지 2배, 대표 1건 점유와 경쟁, `probe_until` 인계, 메시지 오류 뒤 `closed`, `account_trips` 3회 뒤 `FAILED`(한도 사유 제외, 응답이 다르면 승격 없음), 한도 사유는 `account_trips` 3회를 넘어도 `RETRY_WAIT` 유지와 만료 시각 뒤 `EXPIRED`, 차단기 closed의 `OTHER` 거부는 시도 횟수 증가와 최대 시도 `FAILED`·`open`에서는 증가 없음, 내부 오류는 차단기 불변, 재개 시각이 만료 뒤이면 `EXPIRED`.
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

- [x] **진행 상태:** 검증 완료 (1단계, 2026-11-23 재시작 시나리오 테스트 추가)

**요구사항:**

- 여러 사용처 인스턴스가 동시에 같은 Key로 요청해도 중복 등록되지 않아야 한다.
- 중복 방지 정보는 프로세스 재시작 후에도 유지돼야 한다.

**수용 조건:**

- [x] 같은 Key의 동시 요청 N건에서 발송 작업이 하나만 생긴다.
- [x] Mailo 재시작 후 같은 Key로 재요청해도 중복 등록되지 않는다. (Key는 DB의 unique 제약이라 프로세스 상태와 무관하다. `e2e/mail-flow.integration-spec.ts`가 앱을 닫고 메모리 상태가 없는 새 앱을 띄운 뒤 같은 Key로 요청해 200과 같은 작업 ID, 작업 1건을 확인한다. 한계: 같은 jest 프로세스 안에서 앱 인스턴스를 닫고 다시 만든 것이지 OS 프로세스를 죽였다 띄운 것은 아니다. 컨테이너를 실제로 죽였다 띄운 관찰은 RQ-018.)

**판정 근거:**

- `queue/register.integration-spec.ts`: 같은 Key 동시 요청 20건에서 신규 등록은 1건이다.
- `e2e/mail-flow.integration-spec.ts`(재시작 시나리오): `PENDING` 작업을 등록한 앱을 닫고 새 앱을 띄운 뒤 같은 Key 재요청이 200(같은 작업), 작업 1건, 메일 1통이다.

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
| `CANCELED`   | 나가기 전에 호출처가 취소함(RQ-040). 종결이다 |

**수용 조건:**

- [x] 상태 전이 규칙이 설계 문서에 기술돼 있다.
- [x] 허용되지 않는 전이는 거부된다.

**판정 근거:**

- 문서: ADR-0002 결정 7, ADR-0011 결정 4(`CANCELED`와 전이 `PENDING`·`RETRY_WAIT` → `CANCELED`). 마이그레이션 `CHECK`가 상태 값과 lease·종결 시각 일관성을 강제한다. `CANCELED`는 마이그레이션 `0006`이 허용한다.
- `db/job-constraints.integration-spec.ts`: `CHECK` 제약 위반이 SQLSTATE 23514와 제약 이름으로 거부된다. `SENDING`인데 lease 컬럼이 일부만 있음·`SENDING`이 아닌데 lease가 남음(`mail_jobs_lease_state`), 종결 상태인데 `finished_at` 없음·그 반대(`mail_jobs_terminal_state`, `CANCELED`도 같다), 본문 암호문·nonce·키 버전 중 일부만 있음(`mail_jobs_body_state`), 알 수 없는 상태 값, 음수 시도 횟수.
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
  - 취소 시각과 취소 주체(`canceledAt`, `canceledBy`). 취소한 작업에만 값이 있다(RQ-040).
  - 결과 불명 표시(`outcomeUncertain`). 모든 상태에서 불리언이다(RQ-048).
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
  - 이벤트 종류는 `JOB_SENT`, `JOB_FAILED`, `JOB_EXPIRED`, `JOB_CANCELED`, `INTAKE_REJECTED`다. `JOB_CANCELED`는 RQ-040이 정한다.
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
- 피드 지연 메트릭은 인증된 `/health/ready`의 `eventFeed`로 구현했다. `/metrics`에도 같은 뜻의 `mailo_caller_latest_event_age_seconds`가 있다(RQ-051). 로그로는 내보내지 않는다. 해석은 `docs/operations/troubleshooting.md`의 "피드 지연 해석"이다.

## 7. 큐와 영속성

### RQ-018 영속 큐

- [x] **진행 상태:** 검증 완료 (1단계, 2026-11-23 `PENDING` 재시작 시나리오 테스트 추가)

**요구사항:**

- 발송 요청은 큐에 저장해야 한다.
- 발송은 백그라운드에서 처리해야 한다.
- 장애 후에도 대기 중이던 작업이 유실되지 않아야 한다.

**수용 조건:**

- [x] 대기 중 작업이 있는 상태에서 Mailo를 재시작해도 작업이 남아 있고 이어서 처리된다. (큐는 PostgreSQL에 있고 lease 회수 테스트가 있다. `e2e/mail-flow.integration-spec.ts`가 Worker 없는 앱에서 `PENDING`으로 등록한 뒤 앱을 닫고, 새 앱(Worker 켜짐)이 그 작업을 발송해 `SENT`가 되며 메일이 1통임을 확인한다. 한계: 같은 jest 프로세스 안에서 앱을 닫고 다시 만든 것이다. 2026-11-23 `scripts/container/`로 컨테이너를 SIGKILL·SIGTERM으로 죽였다 다시 띄웠을 때 `SENDING` 작업(SIGKILL)과 남은 파일(SIGTERM)이 유실 없이 이어서 처리됨을 관찰했다. 스크립트는 jest 자동 테스트에 포함되지 않는다. CI `container` 잡으로 GitHub 러너에서도 성공했다(예: run 45185115879, 2026-11-23).)

**판정 근거:**

- `worker/worker.integration-spec.ts`: 점유한 Worker가 죽은 경우 lease 만료 뒤 다른 Worker가 회수해 재발송한다.
- `e2e/mail-flow.integration-spec.ts`: `PENDING` 작업을 가진 채 앱을 닫고 새 앱을 띄우면 작업이 남아 있고 이어서 발송된다(RQ-012와 같은 테스트).

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
- 실제 프로세스 kill(2026-11-23, `scripts/container/verify-sigkill-duplicate.sh`): 컨테이너를 `docker kill -s KILL`로 죽인 뒤 재기동하자 `SENDING`이던 작업이 lease 만료 뒤 회수돼 다시 발송됐다(`attempts=2`, `SENT`). 종료 순서·compose 기본값 변경 뒤 같은 날 다시 실행해 같은 결과를 얻었다(kill 뒤 101초에 같은 `Message-ID` 2통). 이 스크립트는 관찰만 기록하므로 CI에서 통과는 "끝까지 실행됨"이다. 자동 테스트에는 없다. CI `container` 잡으로 GitHub 러너에서 끝까지 실행됐다(예: run 45185115879, 2026-11-23).

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
- 한계 문구(`signature.mode=none`, DB AAD 범위)는 문서 항목이다. 코드 동작은 바꾸지 않았고 이를 단언하는 자동 테스트는 없다. 서명 `required`가 수신자 변경을 거부한다는 서술은 서명이 `payload` 전체를 덮는다는 JWS 성질에 근거한다. 잘못된 서명의 거부는 `file-channel/poller.integration-spec.ts`가 확인하고, 서명된 payload의 수신자를 바꾸면 `SIGNATURE_INVALID`가 되는 것은 `envelope/open-request.spec.ts`("payload를 바꾸면 SIGNATURE_INVALID다")가 확인한다.
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
- [x] 호출처 폴더·`inbox`·`<root>`가 심볼릭 링크이면 그 폴링에서 읽지 않고 경고한다. 권한이 넓은 폴더(`o+w`, `<root>`·`inbox`는 `g+w`)는 경고만 하고 수집을 계속한다. (`file-channel/poller.integration-spec.ts`의 "디렉터리 경로 검사", ADR-0004 구현 중 확정 32. NFS의 `lstat` 동작은 확인하지 않았다.)
- [x] 등록되지 않은 폴더의 파일은 수집되지 않는다. (`fileChannel: false` 호출처의 폴더도 같다. 읽지 않으므로 거부 기록도 없다.)
- [x] 호출처 계정이 자기 폴더의 목록을 조회할 수 없다. (같은 호스트 Docker named volume, default ACL·공용 그룹 두 방식에서 차단을 확인했다. 이름을 알면 `stat`·읽기·삭제는 가능하다. 스크립트 검증이다. NFS loopback에서도 자기 폴더와 `inbox` 목록 조회가 `EACCES`이고 폴더 `chmod`가 거부됐다: `pnpm test:nfs`.)
- [x] 호출처 계정이 다른 호출처 폴더의 파일을 읽거나 만들 수 없다. (같은 환경, 두 방식에서 목록·읽기·생성·rename·삭제와 inbox 루트 목록이 모두 차단됐다. root나 Mailo와 같은 UID로 실행하면 성립하지 않음을 보였다. NFS loopback에서도 같은 호출처 UID 2개로 서로의 폴더 만들기·목록·읽기·삭제가 `EACCES`이고, root는 `root_squash`로 거부됐다.)
- [x] Mailo 계정이 호출처가 만든 파일을 호출처 umask와 무관하게 읽을 수 있다. (default ACL 방식 한정이다. 2026-11-23 보완: 공용 그룹 방식은 이 조건을 만족하지 않는다. default ACL 방식에서 umask 022·027·077·000 모두 읽었다. 공용 그룹 + setgid는 umask 077에서 읽지 못한다. 두 방식 모두 호출처가 생성 mode를 0600으로 명시한 파일은 읽지 못하므로 rename 전에 chmod 0660이 필요하다. ADR-0004 구현 중 확정 15·16·18. NFS loopback에서는 default ACL 폴더에서 NFSv4.2 클라이언트가 만든 파일만 umask 077에서 읽힌다. NFSv4.1 클라이언트는 umask 077이면 Mailo가 읽지 못해 `unreadable`로 남는다. 호출처 호스트도 `vers=4.2`가 필요하다. ADR-0004 구현 중 확정 22.)
- [ ] 같은 호스트 볼륨(2단계)과 NAS/NFS 환경(3단계)에서 각각 통합 테스트로 확인한다. (같은 호스트 Docker named volume은 `scripts/volume/` 스크립트로 확인했다. jest 통합 테스트에는 넣지 않았다. CI 워크플로 `container` 잡에는 연결했고 GitHub 러너의 2026-11-23 실행에서 잡은 성공했다. NFS는 loopback에서 `pnpm test:nfs` 31건(NFSv4.1·4.2 기본값 각각, 2026-11-23 `CallerClient` 수정 뒤 기본값 1회 재실행도 통과)으로 확인했다. Docker NFS named volume으로 컨테이너가 호출처 UID 2001(umask 077, 4.2) 파일을 읽는 것은 `verify-docker-volume.sh`로 확인했다. 실제 NAS 제품은 확인하지 않았다. `nfs` 잡은 GitHub 러너에서 1회 통과했다(2026-11-23, run 45127889424, `c75052a`, 31건, 같은 러너 loopback NFS).)

**판정 근거(서명 부분):**

- `envelope/open-request.spec.ts`: JWS 정상, payload·서명 변조, `alg` none 공격, `alg` 혼동(HS384·HS512·RS256·소문자), 알 수 없는 `kid`·다른 호출처 키, 키 2개 교체, `iat` 만료·미래(경계 포함), `caller` 불일치, 서명 범위 밖 필드 거부, 서명 없는 파일.
- `config/load-config.spec.ts`: 허용 기간 + 허용 오차가 Key 보존 기간을 넘으면 기동 거부(경계 포함). `callers/registry.spec.ts`: `signature.mode` 미지정 거부.
- `file-channel/poller.integration-spec.ts`: 서명 required 호출처의 정상 JWS 수집, 서명 없는 파일·다른 키로 서명한 파일·허용 기간(8일) 밖 `iat`·다른 호출처 이름의 `caller` 클레임이 거부 기록과 `INTAKE_REJECTED` 이벤트를 남기고 원본이 삭제된다. 서명 검증 뒤 사유일 때만 거부 기록에 Key를 남긴다(`file-channel/key-hint.spec.ts`).
- 파일시스템 접근 통제(2026-11-23, 같은 호스트 Docker named volume): 코드는 폴더를 만들거나 chmod하지 않는다(ADR-0004 결정 8). 구성은 `scripts/volume/init-volume.sh`와 `docker-compose.volume-example.yml`이 만든다. `verify-permissions.sh acl|group`은 방식별 28개 확인, `verify-root-model.sh`는 15개 확인, `verify-e2e.sh`는 방식별 15개 확인이고 기대와 다른 결과가 0건이다. 권장 구성은 default ACL이다(ADR-0004 구현 중 확정 14·15). Mailo 쪽에서 읽기 권한이 없는 파일은 거부하지 않고 남겨 `unreadable` 로그로 드러난다(e2e로 확인).
- 문서와 어긋난 점(해소됨 2026-11-23): 이 RQ 요구사항의 "공용 그룹과 setgid 디렉터리 또는 default ACL ... 호출처 umask에 의존하지 않는다"에서 공용 그룹 + setgid는 umask 077에서 읽기에 실패한다. 사용자 위임 결정으로 위 요구사항 항목 아래에 "보완됨" 표기를 달았다(ADR-0004 구현 중 확정 18·28). 원문은 지우지 않았다. 호출처 구성 절차는 `docs/operations/caller-onboarding.md` 4절이다.
- NFS 권한 모델(2026-11-23, `test/nfs/file-channel.nfs-spec.ts`, `docs/operations/nfs.md`): 폴더 구성은 `apps/mailo/scripts/nfs/lib.sh`의 `nfs_make_inbox`가 만든다. 같은 default ACL 모델이 NFS에서도 성립했다. 공용 그룹 + setgid 대안은 NFS에서도 umask 077에 읽지 못했고, 서버가 보조 그룹을 서버 조회(`--manage-gids`)로 판정하면 보조 그룹만 가진 계정이 거부된다.
- Docker NFS 볼륨(2026-11-23, `apps/mailo/scripts/nfs/verify-docker-volume.sh`, 스크립트 검증): 호출처 UID 2001이 umask 077로 `w` mount(`vers=4.2`)에 넣은 파일을 컨테이너(UID 1000, named volume)가 등록하고 지웠다. 같은 호스트 loopback 한정이다.
- 미확인: 실제 NAS 환경, bind mount, rootless Docker·`userns-remap`, 파일시스템 ACL 지원이 없는 환경. 같은 호스트 볼륨 검증은 스크립트이고 jest 통합 테스트에 포함되지 않는다. CI 워크플로 `container` 잡으로 GitHub 러너에서 성공했다(예: run 45185115879, 2026-11-23).

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

- DB 시간제한과 풀 크기(2026-11-23 코드 리뷰 반영, H1·M1; 2차 리뷰: `MAILO_DB_CONNECT_TIMEOUT_MS` + `MAILO_DB_QUERY_TIMEOUT_MS` < lease − 10초를 기동 때 검사하고, 결과 기록 재시도는 다음 시도의 시작 + 이 합이 마감 안일 때만 한다. `load-config.spec.ts`, `worker-resilience.integration-spec.ts`): 앱 풀에 `statement_timeout`·`lock_timeout`·`idle_in_transaction_session_timeout`·`query_timeout`·keepAlive를 건다(`MAILO_DB_*_TIMEOUT_MS`). `db/pool-timeout.integration-spec.ts`가 `pg_sleep`(57014), 잠금 대기(55P03), 유휴 트랜잭션 연결 끊김, 클라이언트 `query_timeout`과 연결 폐기를 확인한다. `worker/worker-resilience.integration-spec.ts`는 DB가 응답하지 않아도 `pause`·`stop`이 drain 상한 안에 끝남과 결과 기록의 lease 마감까지 재시도를 확인한다. `MAILO_DB_POOL_MAX` ≥ `MAILO_WORKER_CONCURRENCY` + 4는 `config/load-config.spec.ts`가 확인한다. 한계: 실제 네트워크 단절(RST 없는 끊김)은 재현하지 않았다. 응답 없는 연결은 풀 래퍼와 `query_timeout`으로 흉내 냈다. 컨테이너 종료 시간은 다시 재지 않았다.
- 점유 루프 비정상 종료(H2): `poll_loop_crashed`가 나면 정상 종료 경로를 거쳐 종료 코드 70으로 끝난다(`fatal-exit.spec.ts`, `worker-resilience.integration-spec.ts`). `worker_fatal`과 기동 실패(`startup_failed`)도 앱 로거의 한 줄 JSON이다(2026-11-23 2차 리뷰). `restart: unless-stopped`의 비0 종료 재시작은 일회용 컨테이너로 확인했고 실제 Mailo 컨테이너에서 이 경로를 일으키지는 않았다.
- Docker NFS 볼륨 구성의 컨테이너 상태(2026-11-23, `apps/mailo/scripts/nfs/verify-docker-volume.sh`, 스크립트 검증, 통과 13·실패 0): `docker-compose.nfs-example.yml` 위에서도 컨테이너가 non-root UID 1000, 읽기 전용 루트(`/repo` 쓰기 실패), `/tmp` tmpfs 쓰기, `CapEff` 0으로 동작했다. 같은 호스트 loopback NFS 한정이다(RQ-002 판정 근거).
- 이미지·컨테이너 강화(2026-11-23 코드 리뷰 반영, M9): `Dockerfile`에서 `chown -R node:node /repo`를 없앴다. 빌드한 이미지에서 `find /repo -user node`가 0건이고 `node` 계정이 쓸 수 있는 파일이 0건이며(`find /repo -writable`) `touch /repo/apps/mailo/dist/x`가 `Permission denied`다. base 이미지는 `node:24.20.0-alpine@sha256:…` digest로, pnpm은 `packageManager`의 `+sha512.<hex>`로 고정했다(이미지 빌드가 corepack 해시 검증을 통과했다. 패턴은 `config/compose-consistency.spec.ts`가 단언). compose의 `mailo`에 `read_only: true`(+ `tmpfs: /tmp`), `cap_drop: [ALL]`, `no-new-privileges:true`를 넣었다(`docker-compose.volume-example.yml`도 같다). 이 구성에서 `scripts/container/verify-sigterm-file.sh`(종료 코드 0, 파일 1000건 처리, SMTP 1000통), `verify-sigkill-duplicate.sh`(같은 `Message-ID` 2통 재현), `scripts/volume/verify-e2e.sh`(acl·group 각 15개 확인 통과)가 통과했다. 읽기 전용 루트에서 위 시나리오가 쓰기 오류 없이 통과했으므로 필요한 쓰기 경로는 파일 채널 볼륨 외에 확인되지 않았다(`/tmp` tmpfs가 실제로 쓰였는지는 확인하지 않았다). 한계: 이미지 취약점 검사는 하지 않았다. compose `secrets:` 예시와 `docker-compose.migrate-once.yml`은 `docker compose config` 문법만 확인했다.
- 마이그레이션 운영성(M7): 첫 줄 `-- mailo:no-transaction` 파일은 `BEGIN` 없이 실행한다(문장 하나만 허용, 실행 전 검사). 기본 실행은 풀에 `lock_timeout`이 없으면 `SET LOCAL`로 10초를 건다. `db/migrator.integration-spec.ts`: `CONCURRENTLY` 인덱스 성공, 표식 없는 `CONCURRENTLY` 실패·롤백, 문장 둘 거부, 실패 뒤 재시도, 잠금 대기 `55P03`, 풀의 `lock_timeout` 존중. `db/split-sql.spec.ts`: 문장 분리(주석·문자열·달러 인용·`E'`). 롤백은 `pg_dump` 복원뿐이다(`deployment.md`).
- DB 연결 암호화(L7): `MAILO_DB_SSLMODE`(`disable`·`require`·`verify-ca`·`verify-full`)를 pg `ssl` 옵션으로 옮긴다. production에서 원격 DB 호스트인데 암호화가 꺼져 있으면 기동을 거부하고 `MAILO_DB_ALLOW_INSECURE=true`로 끈다(`config/database-ssl.spec.ts`: 허용값, 원격 판정, 강제와 opt-out, 로컬 TLS 서버 핸드셰이크로 `verify-full`의 호스트 이름 검사와 `verify-ca`의 체인만 검사 확인). 한계: TLS를 켠 PostgreSQL 서버에 실제로 접속하지 않았다. (2026-11-23 2차 리뷰 반영: `verify-ca`는 `MAILO_DB_SSLROOTCERT_FILE` 없이 기동을 거부한다(공개 CA 신뢰 방지). `MAILO_DATABASE_URL` 경로는 pg가 계산한 `host`·`ssl`(`pg.Client`의 `connectionParameters`)로 원격 판정과 암호화 여부를 정한다. `database-ssl.spec.ts`가 `?host=`, `ssl=false`·`ssl=0`, `sslmode=disable`, 유닉스 소켓 경로를 확인한다.)
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

- [ ] 컨테이너 로그에서 발송 시도와 오류를 확인할 수 있다. (2026-11-23부터 모든 로그(Worker·파일 폴러·HTTP 요청·DB·헬스·Nest)가 `ts`·`instance`·`level`·`event`를 가진 한 줄 JSON이다. `scripts/container/` 실행 중 컨테이너 표준 출력에서 `file_poll`, `worker_paused`, `job_completed` 줄과 `nest_log` 기동 줄을 관찰했다. 오류 줄(`claim_failed` 등)은 컨테이너에서 일으키지 않았다.)
- [x] 본문과 SMTP 비밀번호에 canary 문자열을 넣어 발송·실패·재시도를 수행한 뒤, 로그에서 canary가 검색되지 않는다.

**판정 근거:**

- `worker/worker.integration-spec.ts`: 성공·영구 거부(응답에 수신자 주소 반복)·독성 작업·인증 실패 경로의 로그, 시도 기록, 이벤트, 작업 행에 본문·제목·SMTP 비밀번호·수신자 주소(응답 텍스트 안)가 없다.
- `logging/logger.spec.ts`(M10): 모든 줄에 ISO `ts`·`instance`·`level`·`event`가 앞서고 호출자 필드가 이를 덮어쓰지 못하며, Nest 로거 어댑터가 문자열·객체·오류 로그를 같은 형식으로 낸다(중첩 객체 필드는 버린다). `http/rest-intake.integration-spec.ts`: 요청 로그(`http_request`)는 `callerId`·`durationMs`·`method`·`requestId`·`route`·`status`와 앞의 네 필드뿐이고 쿼리 문자열의 Key canary가 없다. `config/instance-id.spec.ts`: `MAILO_INSTANCE_ID`. 로거는 `createApp`에서 한 번 만든다(`app.ts`).
- `file-channel/poller.integration-spec.ts`: 거부한 파일(형식 오류·검증 실패·서명 불일치·크기 초과·심볼릭 링크·JWE 변조)의 본문 canary가 폴러 로그, 거부 기록, 이벤트, 작업 행에 없다. 로그에는 호출처 ID·사유 코드·크기·sha256·거부 기록 id(`rejectionId`)만 남는다. 호출처가 정한 파일 이름은 로그에 남기지 않고 거부 기록과 이벤트에만 남는다(ADR-0004 구현 중 확정 32).
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
  - 선택: 호출처가 요청의 `from`으로 쓸 수 있는 발신 주소 목록 `allowedFrom`(주소 최대 20개, 생략하면 빈 목록). 허용 집합은 호출처 계정의 기본 발신 주소(`default`는 `MAILO_SMTP_FROM`, 없으면 `MAILO_SMTP_USER`)에 이 목록을 더한 것이다(ADR-0008 구현 중 확정 12, ADR-0013 결정 6, RQ-055). 호출처의 계정은 선택 필드 `accountId`가 정한다(RQ-054).
  - 서명 키(JWS)는 호출처 사이·키 사이·DB 본문 키링·지문 키링과 같은 바이트이면 기동 시 거부한다. 같은 바이트가 반복되거나 공개된 샘플 키는 production에서 거부한다(ADR-0008 구현 중 확정 13).
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
- [x] 두 호출처가 같은 JWS 서명 키를 쓰거나 서명 키가 DB 본문 키링과 같으면 기동 시 거부된다. production에서는 같은 바이트가 반복된 키도 거부된다. (`callers/signature-keys.spec.ts`)

**판정 근거:**

- `callers/registry.spec.ts`: 해시만 저장, 키 2개 동시 유효, 서명 `mode` 미지정 거부, 키 해시 1~2개 강제(파일 채널 호출처 포함), 오류에 해시 없음. `crypto/api-key.spec.ts`: SHA-256 해시와 상수 시간 비교.
- `http/rest-intake.integration-spec.ts`: 헤더 없음·틀린 키·형식 오류가 같은 401, 두 번째 키로 인증.
- 파일 채널(`fileChannel: true`인 호출처의 폴더만 수집): `file-channel/poller.integration-spec.ts`(같은 Key도 호출처마다 따로 등록, 호출처 A 폴더의 파일은 A로만 등록)와 `e2e/file-flow.integration-spec.ts`(파일 채널 호출처가 REST 자격으로 Key 조회·이벤트 피드 사용).
- `callers/allowed-from.spec.ts`: `allowedFrom` 생략은 빈 목록, 주소 형식·개수 위반 거부. `callers/signature-keys.spec.ts`: 키 중복(호출처 사이, 키 사이, 다른 키링과)·production의 약한 키 거부.
- `callers/send-quota.spec.ts`: `sendQuota24h` 생략·`null`은 무제한, 양의 정수 읽기, 0·음수·소수·문자열·불리언·10000001 거부.
- `callers/signature-keys.spec.ts`: 서명 키(`signature.keys`)는 변수 이름만 두고 값은 시크릿 파일·환경 변수로 받는다(원문이 필요해 해시로 둘 수 없다, ADR-0008 구현 중 확정). `required`는 키 1~2개, `none`은 키 없음, 값이 설정 객체 직렬화·오류에 없음.

### RQ-029 단순성과 외부 의존성 최소화

- [x] **진행 상태:** 검증 완료 (1단계)

**요구사항:**

- 구현과 운영 구조를 단순하게 유지한다.
- 운영 의존성은 Mailo 앱과 PostgreSQL로 한정한다.
- 별도 메시지 브로커와 외부 메일 서버(Postfix 등)를 두지 않는다.
  - 예외: 개발용 SMTP 수신 서버 Mailpit은 compose profile `mailpit`으로만 켜지는 opt-in 서비스로 둔다. 기본 구성에 들어가지 않고 운영 의존성이 아니다.

**수용 조건:**

- [x] 기본 compose 구성에 Mailo와 PostgreSQL 외의 상시 서비스가 없다.
- [x] 개발용 Mailpit은 profile `mailpit`을 줄 때만 켜지고, 이미지는 digest로 고정하며, 호스트에는 웹 UI만 127.0.0.1로 연다.

**판정 근거:**

- `config/compose-consistency.spec.ts` "개발용 Mailpit profile": `profiles:`는 `mailpit` 서비스에만 있고(postgres·mailo에는 없음), 이미지 태그·digest 고정, 공개 포트는 UI 하나, non-root·`read_only`·`cap_drop`·`no-new-privileges`를 글자로 검사한다.
- `docker compose config --services`(compose v5.5.1, 2026-11-23): profile 없이 `postgres`·`mailo`, `--profile mailpit`이면 `mailpit`이 더해진다. 수동 확인이다.
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
- 요청의 `from`은 호출처의 허용 발신 주소(호출처 계정의 기본 발신 주소 + `allowedFrom`, RQ-028·055)에 있어야 한다. 비교는 대소문자를 무시한다. `from`을 생략하면 작업 계정의 기본 발신 주소를 쓴다. 집합 밖이면 REST는 400 `FROM_NOT_ALLOWED`, 파일은 `VALIDATION_FAILED` 거부다. 이미 등록된 Key의 재전송은 이 검사를 받지 않고 기존 작업(같은 내용) 또는 409(다른 내용)를 돌려받는다.
- `replyTo`는 주소 형식만 검증하고 허용 범위를 두지 않는다(위험은 회신 유도 피싱이다, ADR-0008 구현 중 확정 12).

**수용 조건:**

- [x] 제목에 CR·LF가 든 평문 요청은 등록되지 않고 거부된다.
- [x] 제목을 봉투 암호화한 요청도 같다. (REST와 파일 채널 모두 복호화 뒤 거부한다.)
- [x] 형식이 잘못된 수신자 주소는 거부된다.
- [x] 위 상한을 넘는 요청은 거부된다. REST의 원시 크기 초과는 413이다.
- [x] `attachments` 필드가 있는 요청은 REST에서 400으로 처리된다.
- [x] `attachments` 필드가 있는 파일은 수집 거부로 처리된다. (`ATTACHMENTS_NOT_SUPPORTED`로 거부 기록·이벤트를 남기고 원본을 삭제한다.)
- [x] 허용 집합 밖의 `from`은 REST 400(`FROM_NOT_ALLOWED`, `/from`)이고 작업이 생기지 않는다. 파일은 `VALIDATION_FAILED`로 거부된다. 기본 발신 주소·`allowedFrom`의 주소는 대소문자와 무관하게 등록되고, `replyTo`는 제한되지 않는다. 이미 등록된 Key는 다시 검사하지 않는다. (`http/rest-intake.integration-spec.ts`, `file-channel/poller.integration-spec.ts`, `queue/register.integration-spec.ts`. 실제 Gmail·Workspace relay의 From 처리는 확인하지 않았다.)

**판정 근거:**

- 발신 주소 허용 범위: `callers/allowed-from.spec.ts`(`isSenderAllowed`, 설정 검증), `queue/register.integration-spec.ts`(`denyNew`: 신규 Key는 `denied`, 기존 Key는 `duplicate`·지문 불일치), `http/rest-intake.integration-spec.ts`(기본 발신 주소·`allowedFrom`·다른 호출처의 `allowedFrom`·`replyTo`·재시도), `file-channel/poller.integration-spec.ts`.
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
- `http/rest-intake.integration-spec.ts`: 유효한 Bearer에만 `eventFeed`(RQ-017) 추가. DB 연결 불가 시 `ready` 503과 `unknown`, 인증 없음은 상태만, 유효한 Bearer는 `openUntil`·`lastReason`, `closed`와 `half_open`의 값, 틀린 `Authorization`은 401. Worker는 차단기가 닫히지 않은 결과에 경고 로그를 남긴다(`breaker_not_closed`). `worker/worker.integration-spec.ts`가 일일 한도 응답 뒤 이 로그를 단언한다.

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

## 12. 발송 우선순위

일반 메일이 큐에 많이 쌓인 상황에서 급한 메일을 먼저 발송한다. 결정은 [ADR-0009](../adr/0009-claim-priority.md)다.
기존 PostgreSQL 큐와 Worker를 쓴다. 새 패키지·브로커·상시 서비스를 추가하지 않는다(RQ-029). 폴링을 알림 방식으로 바꾸는 작업은 범위 밖이다.

### RQ-033 우선순위 지정

- [x] **진행 상태:** 검증 완료 (4단계)

**요구사항:**

- REST와 파일 요청의 최상위 필드에 `priority`를 선택적으로 받는다.
- 허용 값은 문자열 `LOW`, `NORMAL`, `HIGH`, `URGENT` 네 가지다. 대소문자를 구분한다. 앞의 것일수록 늦게 점유한다.
- 생략하면 `NORMAL`로 처리한다. `null`, 숫자, 빈 문자열, 그 밖의 문자열은 검증 오류다.
- `priority`는 수신자처럼 Mailo가 점유 순서에 쓰는 값이라 최상위 평문 필드다. JWE `content`의 복호화 평문에 `priority`가 있으면 기존 규칙대로 `UNKNOWN_FIELD`다.
- 파일 JWS는 요청 JSON 전체를 서명하므로 `priority`도 서명 대상이다. REST는 기존과 같이 서명하지 않는다.
- 인증된 모든 호출처가 모든 등급을 지정할 수 있다. 호출처별 허용 필드와 등급별 할당은 두지 않는다(ADR-0009 결정 3).
- 잘못된 값의 REST 응답은 기존 검증 오류 형식의 400이다. 파일은 기존 수집 거부 기록·`INTAKE_REJECTED` 절차를 따른다. 응답·기록에 요청 원문을 넣지 않는다(RQ-027).
- 기존 호출처는 요청을 바꾸지 않고 계속 쓸 수 있어야 한다.
- 받아들인 위험: 지정 권한을 제한하지 않으므로 호출처가 모든 요청을 `URGENT`로 보내면 등급의 효과가 줄어든다. Mailo에는 이를 막는 수단이 없다. 호출처 연동 문서에 등급별 용도 기준(예: `URGENT`는 인증 코드·보안 알림, `LOW`는 대량 안내)을 적는다.

**수용 조건:**

- [x] REST·파일 모두 생략한 우선순위를 `NORMAL`로 등록하고, 네 등급 모두 JWS·JWE 경로에서 같은 값을 보존한다.
- [x] 잘못된 우선순위(`null`, 숫자, 빈 문자열, 소문자 `urgent`, 정의되지 않은 이름)는 REST 400 또는 파일 수집 거부로 처리한다. JWE 복호화 평문 안의 `priority`는 `UNKNOWN_FIELD`다.

**판정 근거:**

- `envelope/open-request.spec.ts`(단위) "openRequest: 우선순위": 생략·`NORMAL`이 `NORMAL`, 파일 JWS 네 등급 보존과 `priority` 변조 시 `SIGNATURE_INVALID`, JWE 요청의 바깥 `priority` 보존, 잘못된 값 8종(`null`, 숫자, 빈 문자열, 소문자, 정의되지 않은 이름, 앞뒤 공백, 배열, 객체)이 REST·파일 모두 `/priority` `INVALID_FORMAT`, JWE 평문 안의 `priority`는 `/content` `UNKNOWN_FIELD`.
- `http/rest-priority.integration-spec.ts`(PostgreSQL): REST 네 등급 202와 DB 순위(10·20·30·40), 생략은 `NORMAL`, 잘못된 값 5종이 400 `/priority` `INVALID_FORMAT`이고 등록하지 않음.
- `envelope/rest-envelope.integration-spec.ts`(PostgreSQL): REST JWE 요청의 네 등급 보존, JWE 평문 안의 `priority`는 400 `UNKNOWN_FIELD`.
- `file-channel/poller.integration-spec.ts`(PostgreSQL) "우선순위": 파일 생략은 `NORMAL`, 평문 JSON·JWS·JWE 파일의 네 등급 저장, 잘못된 값 5종과 JWE 평문 안의 `priority`는 `VALIDATION_FAILED` 거부 기록과 원본 삭제.
- 구현: `envelope/request-schema.ts`(검증), `queue/priority.ts`(등급과 순위), `queue/register.ts`(저장).
- 받아들인 위험(모든 호출처가 모든 등급 지정)은 자동 검증 대상이 아니다. 용도 기준은 `docs/operations/caller-onboarding.md` "우선순위"에 있다.

### RQ-034 중복 등록 계약

- [x] **진행 상태:** 검증 완료 (4단계)

**요구사항:**

- 유일성 범위 `(caller_id, Idempotency-Key)`는 유지한다. REST와 파일이 같은 범위를 쓴다(RQ-011).
- 우선순위는 지문(`crypto/fingerprint.ts`)의 기존 `policy` 입력에 넣는다. ADR-0005 결정 3의 "요청별 정책 필드"에 해당한다(ADR-0009 결정 4).
- 정규화 규칙:
  - `NORMAL`(생략 포함)이면 `policy`에 키를 넣지 않는다.
  - 그 밖의 등급이면 `policy.priority`에 등급 이름(`"LOW"`·`"HIGH"`·`"URGENT"`)을 넣는다.
  - DB 순위 숫자는 지문에 넣지 않는다. 순위 숫자를 다시 매겨도 지문이 바뀌지 않게 하기 위해서다.
- 결과:
  - 생략과 `NORMAL`의 지문은 우선순위 도입 전 지문과 같다. 형식 태그 `mailo-fp-v1`을 올리지 않고 기존 작업의 지문을 다시 계산하지 않는다.
  - 같은 Key·같은 내용·같은 등급은 기존 작업을 반환한다.
  - 같은 Key에서 등급이 바뀌면 지문이 달라진다. REST는 409, 파일은 기존 지문 불일치 수집 거부 절차를 따른다. 기존 작업은 바꾸지 않는다.
- 도입 전 지문 값이 바뀌지 않음을 골든 테스트(고정 입력과 고정 키로 계산한 기존 지문 값)로 고정한다.
- 등록 뒤 우선순위를 바꾸는 API는 범위 밖이다.

**수용 조건:**

- [x] 같은 Key의 생략·`NORMAL`은 같은 작업을 반환하고, 등급 변경은 충돌한다. 도입 전에 등록된 작업에도 적용된다.
- [x] 골든 테스트: 우선순위 생략·`NORMAL` 요청의 지문이 도입 전 계산 값과 같다.

**판정 근거:**

- 골든 값: `crypto/fingerprint.spec.ts`(정책 필드 없는 입력의 정규화 문자열과 HMAC 값)와 `envelope/open-request.spec.ts`(REST 요청의 정규화 문자열과 지문). 두 값은 우선순위 구현 전 코드로 계산해 리터럴로 고정했다. `open-request.spec.ts`는 `NORMAL`을 명시한 요청도 같은 값임을, 나머지 등급은 `policy`에 `["priority","<등급>"]`이 들어가 지문이 달라짐을 확인한다.
- `http/rest-priority.integration-spec.ts`(PostgreSQL): 도입 전 작업은 `0001`~`0003`만 적용한 schema에 도입 전 정규화 문자열의 지문으로 직접 넣은 뒤 `0004`·`0005`를 적용해 만든다. 같은 Key의 생략·`NORMAL` 재요청은 그 작업을 200으로 돌려주고 `LOW`·`HIGH`·`URGENT`는 409이며 저장된 순위는 20 그대로다. 새 작업에서도 생략·`NORMAL`은 200, 등급 변경은 409, `URGENT` 작업에 생략 재요청은 409다.
- `file-channel/poller.integration-spec.ts`: 같은 Key의 생략·`NORMAL` 파일은 중복, 등급을 바꾼 파일은 `FINGERPRINT_MISMATCH`이고 기존 작업의 순위는 그대로다.
- `envelope/rest-envelope.integration-spec.ts`: JWE로 `URGENT` 등록한 Key의 같은 등급 평문 재요청은 200, 등급을 뺀 재요청은 409다.
- 구현: `envelope/open-request.ts`(`priorityPolicy`), `crypto/fingerprint.ts`(정규화 규칙 변경 없음).

### RQ-035 점유 순서

- [x] **진행 상태:** 검증 완료 (4단계)

**요구사항:**

- 점유는 두 경로 중 하나로 고른다. Worker는 claim 호출마다 한 번 경로를 정한다(ADR-0009 결정 5).
  - 우선순위 경로(기본): `priority DESC, next_attempt_at ASC, id ASC`.
  - 대기 순서 경로: 우선순위를 무시한 `next_attempt_at ASC, id ASC`(도입 전 순서).
- 대기 순서 경로를 고를 확률은 설정 `MAILO_CLAIM_FIFO_RATIO`다. 0 이상 1 이하이고 기본 0.1(추정)이다. 0이면 항상 우선순위 경로다. 범위 밖 값은 기동을 거부한다.
- 경로 선택은 애플리케이션 난수로 한다. 테스트에서 난수를 주입할 수 있어야 한다. DB에 상태를 두지 않으므로 여러 Worker에서도 같은 규칙으로 동작한다.
- 비율은 claim 호출 수 기준이다. 한 번의 claim이 빈 슬롯 수만큼 여러 건을 점유하므로 작업 건수 기준 비율은 정확히 10%가 아니다.
- 대기 순서 경로는 가장 오래 기다린 작업에 몫을 준다. 그 작업이 `URGENT`여도 함께 뽑힌다. 어느 등급도 점유 기회가 0이 되지 않는다.
- 대기 시간에 따른 승격은 하지 않는다. 정렬식에 `now()`를 쓰지 않는다(ADR-0009 결정 6).
- 후보 조건은 두 경로 모두 기존과 같다. `PENDING`·`RETRY_WAIT`, `next_attempt_at <= now()`, `expires_at > now()`이고 호출처 할당·차단기 정책상 점유할 수 있어야 한다.
- 서로 다른 호출처의 후보에도 같은 규칙을 적용한다.
- 할당이 남은 호출처의 순번 계산(`row_number() OVER (PARTITION BY caller_id ...)`)에는 고른 경로와 같은 정렬을 쓴다. 우선순위 경로에서 잔여 1건인 호출처에 `URGENT`·`NORMAL` 후보가 함께 있으면 `URGENT` 작업을 점유한다.
- `half_open` 대표 선택은 기존 첫 정렬 키(직전에 차단기를 연 작업을 후순위로, ADR-0007 구현 중 확정 3)를 유지하고, 그다음 키로 고른 경로의 정렬을 쓴다. 대표 작업 수는 1건 그대로다.
- 우선순위는 다음 점유에서 고를 작업에만 적용한다. 이미 `SENDING`인 작업의 전송을 중단하거나 점유를 빼앗지 않는다.
- 여러 Worker의 동시 점유에서는 각 점유 시점에 잠금 없이 고를 수 있는 후보가 기준이다. 전역 SMTP 전송 시작 순서·완료 순서는 보장하지 않는다.
- 긴급 작업 등록 뒤 시작하는 점유는 그 등록 커밋을 볼 수 있을 때부터 반영한다.
- `URGENT` 작업의 점유 시점은 빈 슬롯과 다음 점유 실행에 따라 달라진다. 슬롯이 비면 Worker가 polling 대기에서 일찍 깨어날 수 있다. 폴링 간격은 고정 지연 하한이 아니다. Worker가 빈 슬롯은 있으나 할 일이 없어 대기 중이면 새 `URGENT`는 다음 polling까지 기다린다. 이 대기는 `MAILO_WORKER_POLL_MS`(기본 1000ms)에 ±10% jitter를 더한 값이다(`worker/worker.ts` `pollDelay`). claim이 연속 실패하면 대기가 `pollMs × 2^n`(n 최대 10)으로 늘어난다. 대기 순서 경로에 걸린 claim 동안에는 더 늦어질 수 있다. `URGENT`는 즉시 전송을 뜻하지 않는다.

**수용 조건:**

- [x] 우선순위 경로: 발송 가능한 `NORMAL` 작업 10,000건이 있고 그중 다수가 300초 이상 기다린 상태에서 `URGENT` 작업이 등록되면, 다음 점유에서 `URGENT` 작업을 먼저 선택한다(적체 길이와 무관).
- [x] 우선순위 경로: 네 등급이 섞여 있으면 `URGENT` → `HIGH` → `NORMAL` → `LOW` 순서로 선택하고, 같은 등급은 `next_attempt_at ASC, id ASC`다.
- [x] 대기 순서 경로: 등급과 무관하게 `next_attempt_at ASC, id ASC`로 선택한다.
- [x] 경로 선택: 주입한 난수로 각 경로가 선택되고, `MAILO_CLAIM_FIFO_RATIO=0`이면 항상 우선순위 경로다. 범위 밖 값은 기동을 거부한다.
- [x] 할당 잔여 1건인 호출처에 `NORMAL`·`URGENT` 후보가 함께 있으면 우선순위 경로에서 `URGENT` 작업을 점유한다.
- [x] `half_open` 대표 선택에서 직전 차단 작업 후순위 규칙을 유지하고, 그 밖의 후보 중 고른 경로의 첫 작업을 대표로 고른다. 대표는 1건이다.
- [x] 모든 슬롯이 사용 중이면 `URGENT` 작업은 대기한다. 슬롯이 비면 다음 점유 규칙으로 선택하며 기존 전송을 중단하지 않는다.

**판정 근거:**

- `queue/claim-priority.integration-spec.ts`(PostgreSQL): 301~10,300초 기다린 `NORMAL` 10,000건(`generate_series`로 직접 INSERT, DEFAULT 순위) 뒤 등록한 `URGENT`를 다음 점유가 고름, 네 등급 순서와 같은 등급 안의 오래 기다린 순서, 같은 `next_attempt_at`의 `id` 순서, 경로 생략은 우선순위 경로, 대기 순서 경로는 등급 무관, 할당 잔여 1건에서 우선순위 경로는 `URGENT`·대기 순서 경로는 가장 오래된 `NORMAL`, `half_open` 대표는 직전 차단 작업 다음으로 경로의 첫 작업 1건(두 경로 각각)이고 직전 차단 작업만 남으면 그 작업.
- `worker/worker-priority.integration-spec.ts`(PostgreSQL, 메모리 발송기, 동시 전송 1): 주입한 경로 난수로 우선순위·대기 순서 경로가 claim마다 고른 대로 점유됨, 비율 0이면 난수 0이어도 우선순위 경로, 비율 1이면 대기 순서 경로, 슬롯이 차 있으면 `URGENT`가 `PENDING`으로 기다리고 진행 중 전송을 끊지 않은 채 슬롯이 비면 `URGENT`를 먼저 점유.
- `config/load-config.spec.ts`: `MAILO_CLAIM_FIFO_RATIO` 기본 0.1, 경계값 0·1, 범위 밖·숫자 아님 7종의 기동 거부. `worker/worker.spec.ts`: Worker 옵션의 같은 범위 검사.
- RED 확인: 우선순위 정렬 조각을 대기 순서로 바꾸면 `claim-priority` 20건 중 9건, Worker의 경로 전달을 빼면 `worker-priority` 4건 중 2건이 실패했다(2026-11-23).
- 구현: `queue/claim.ts`(`ORDER_BY` 고정 조각), `worker/worker.ts`(경로 선택), `config/load-config.ts`. SQL 형태는 ADR-0009 구현 중 확정 1이다.
- 한계: 여러 Worker의 동시 점유는 단일 프로세스 안의 병렬 `claim`으로 확인했다. 비율 0.1의 적정성은 실제 부하로 측정하지 않았다.

### RQ-036 기존 발송 정책 유지와 굶음의 한계

- [x] **진행 상태:** 검증 완료 (4단계)

**요구사항:**

- 모든 등급이 재시도 backoff와 `next_attempt_at`을 지킨다. 재시도 대기 중인 높은 등급 작업이 발송 가능한 낮은 등급 작업을 막지 않는다.
- 영구 오류, 최대 시도 횟수, 만료, lease 복구, 결과 기록 계약은 유지한다. 재시도·복구 뒤에도 등록한 우선순위를 보존한다.
- 호출처별 `sendQuota24h`는 모든 등급의 합산 사용량에 적용한다. 높은 등급이 할당을 우회하거나 별도 할당을 얻지 않는다(RQ-032).
- 차단기 `open`에서는 `URGENT` 작업도 점유하지 않는다.
- 기존 `FOR UPDATE SKIP LOCKED`, lease 토큰, 작업 행 → 차단기 행 잠금 순서를 유지한다.
- SMTP 중복 전송 가능성은 기존 at-least-once 계약과 같다(RQ-013). `URGENT`는 수신함 도착이나 정확히 한 번 발송을 보장하지 않는다.
- 굶음의 한계: 대기 순서 경로는 처리량의 일부(기본 약 10%, 추정)만 오래된 작업에 준다. 유입이 처리량보다 많은 상태가 이어지면 낮은 등급 작업은 만료 시각(기본 TTL 24시간)을 넘겨 `EXPIRED`가 될 수 있다. 이 한계는 호출처 연동 문서와 운영 문서에 적는다.

**수용 조건:**

- [x] `URGENT` 작업이 계속 유입되는 동안에도 가장 오래 기다린 `LOW` 작업이 대기 순서 경로로 점유된다.
- [x] 미래 재시도·만료·할당 초과의 높은 등급 작업은 점유하지 않고, 다른 처리 가능한 후보는 선택한다.
- [x] 차단기 `open`, 동시 Worker, lease 복구 상황에서도 기존 점유·복구 계약과 우선순위 보존을 확인한다.

**판정 근거:**

- `queue/claim-priority.integration-spec.ts`(PostgreSQL):
  - 점유마다 새 `URGENT`를 넣으며 우선순위·우선순위·대기 순서 경로로 점유하면 앞 두 번은 `URGENT`, 대기 순서 경로는 1시간 기다린 `LOW`를 고른다. 경로 순서는 Worker 난수 대신 고정했고, 난수로 경로를 고르는 것은 `worker/worker-priority.integration-spec.ts`가 확인한다.
  - 재시도 대기 중인 `URGENT`, 만료된 `HIGH`, 할당 초과 호출처의 `URGENT`는 고르지 않고 발송 가능한 `LOW`를 고른다. 할당은 등급 합산이라 `URGENT`도 할당을 넘겨 점유하지 않는다.
  - 차단기 `open`이면 두 경로 모두 `URGENT`를 점유하지 않는다. 동시 `claim` 두 개가 겹치지 않고 함께 상위 등급을 가져간다(`SKIP LOCKED`). `TRANSIENT` 뒤 `RETRY_WAIT`와 lease 만료 회수 뒤에도 순위가 그대로다.
- 기존 점유·복구 계약 테스트(`queue/claim-complete`·`circuit-breaker`·`caller-quota`·`maintenance.integration-spec.ts`, `worker/*.integration-spec.ts`)가 같은 코드에서 통과했다.
- 한계: 동시 Worker는 단일 프로세스 안의 병렬 `claim`이다. 굶음의 한계(낮은 등급의 만료)는 동작 설명이며 자동 검증 대상이 아니다. 문서 위치는 `docs/operations/caller-onboarding.md` "우선순위"와 `troubleshooting.md` "등급별 적체"다.

### RQ-037 조회와 운영 가시성

- [x] **진행 상태:** 검증 완료 (4단계)

**요구사항:**

- 작업 ID 조회, Key 조회, 신규 등록·중복 등록 응답의 작업 표현에 등록한 `priority` 등급 이름을 반환한다. 도입 전 작업은 `NORMAL`이다. DB 순위 숫자는 노출하지 않는다.
- 기존 API 키 인증과 호출처별 조회 격리는 유지한다.
- 이벤트 피드의 기존 소비 계약은 유지한다. 이벤트 payload에 `priority`를 추가하지 않는다.
- 운영자 토큰(`MAILO_OPS_TOKEN`) `/health` 응답의 `queue`에 등급별 `dueCountByPriority`·`oldestDueAgeSecondsByPriority`(키는 등급 이름)를 추가한다. 기존 `dueCountTruncated` 관례를 따라 등급별 상한 도달 여부 `dueCountTruncatedByPriority`도 준다(ADR-0009 구현 중 확정 2). 등급마다 기존 `dueCount`와 같은 상한(10001건 조회, 10000에서 멈춤)·문 시간제한·후보 조건(`queue/backlog.ts`)을 쓴다. 기존 `dueCount`·`oldestDueAgeSeconds`는 그대로 둔다.
- `/health/ready`의 200/503에는 등급별 적체를 반영하지 않는다(RQ-031).
- 로그·오류·이벤트에 제목·본문·수신자·시크릿을 추가하지 않는다(RQ-027).

**수용 조건:**

- [x] 작업 조회·등록 응답에서 등급 이름을 확인하고, 다른 호출처의 작업은 기존과 같이 조회할 수 없다.
- [x] 운영자 `/health`의 `dueCountByPriority`·`oldestDueAgeSecondsByPriority`가 등급별 적체를 반영하고, 운영자 토큰 없는 응답에는 나오지 않는다.
- [x] 로그·오류·이벤트·거부 기록에서 본문·주소·시크릿 canary가 검출되지 않는다.

**판정 근거:**

- `http/rest-priority.integration-spec.ts`: 202 등록 응답·ID 조회·Key 조회의 등급 이름, 중복 등록(200) 응답의 등급, 도입 전 작업은 `NORMAL`, 응답에 순위 숫자 없음, 다른 호출처는 ID·Key 조회 모두 404. `http/rest-intake.integration-spec.ts`: `Job` 응답 필드 목록에 `priority`.
- `http/health-ops.integration-spec.ts`: 운영자 응답의 네 등급 키와 등급별 `dueCount`·`oldestDueAgeSeconds`(미래 재시도·`SENDING` 제외), `dueCountTruncatedByPriority`, 등급마다 상한 10000이 따로 걸림, 전체·등급별 값을 문장 하나로 읽음, 호출처 API 키와 인증 없는 응답에는 등급별 필드가 없음.
- canary: 잘못된 `priority` 값에 canary를 넣어 REST 응답·앱 로그(`rest-priority`), 파일 거부 기록·폴러 로그(`poller` "우선순위"), `openRequest` 실패 결과(`open-request.spec.ts`)에서 검출되지 않음. 본문·주소·시크릿 canary 기존 테스트(`rest-intake`, `poller` "로그와 기록에 내용이 없다", `worker.integration-spec.ts`)가 우선순위 코드로 통과했다. 이벤트 payload에는 `priority`를 넣지 않았다(`events/` 변경 없음).
- 구현: `queue/read.ts`, `intake/presenters.ts`, `queue/backlog.ts`, `health/health.service.ts`.

### RQ-038 배포 호환성과 문서

- [ ] **진행 상태:** 진행 중 (4단계)

**요구사항:**

- DB 변경은 새 마이그레이션 파일로 추가한다. 적용된 마이그레이션은 수정하지 않는다.
  - `mail_jobs`에 `priority smallint NOT NULL DEFAULT 20`(`NORMAL` 순위)을 추가한다. 도입 전 작업은 `NORMAL`로 읽힌다. 상수 DEFAULT 컬럼 추가는 PostgreSQL 11 이상에서 테이블을 다시 쓰지 않는다(PostgreSQL 문서 기준, 미측정).
  - 순위는 `LOW` 10, `NORMAL` 20, `HIGH` 30, `URGENT` 40이다. 간격은 나중에 등급을 끼워 넣어도 기존 행을 바꾸지 않기 위한 것이다(ADR-0009 결정 2).
  - 허용 순위 CHECK는 `NOT VALID`로 추가한다(`0003_attempt_instance.sql`과 같은 방식).
  - 우선순위 경로용 인덱스 `(priority DESC, next_attempt_at, id) WHERE status IN ('PENDING','RETRY_WAIT')`를 `CREATE INDEX CONCURRENTLY`로 `-- mailo:no-transaction` 파일에 추가한다. 대기 순서 경로와 기존 헬스 수치는 기존 `mail_jobs_claim_idx`를 쓴다.
- 구 Worker가 섞여 있으면 점유 순서만 기존과 같아질 뿐 정합성 문제는 없다.
- 주 위험은 요청 스키마다. 구 버전은 `priority`를 `UNKNOWN_FIELD`로 거부한다. 배포·롤백 규칙(ADR-0009 결정 10):
  1. 배포 순서는 마이그레이션 → 모든 Mailo 인스턴스 갱신 → 호출처의 `priority` 전송 시작이다.
  2. 롤링 배포 중(구·신 인스턴스 혼용)에는 호출처가 `priority`를 보내지 않는다.
  3. 롤백 전에 호출처의 `priority` 전송을 먼저 끊는다. 끊지 않으면 REST는 400, 파일은 수집 거부가 된다.
  4. 롤백해도 `priority` 컬럼과 인덱스는 남긴다. 구 버전은 이를 읽지 않는다.
- 구현 변경에는 다음 문서 갱신을 포함한다.
  - OpenAPI(`docs/api/openapi.yaml`)와 파일·JWS·JWE 요청 예제.
  - 호출처 연동 문서(`docs/operations/caller-onboarding.md`): 등급별 용도 기준, 굶음 한계.
  - 배포 문서(`docs/operations/deployment.md`): `MAILO_CLAIM_FIFO_RATIO`, 배포·롤백 순서.
  - 운영 문서(`docs/operations/troubleshooting.md`): 등급별 적체 확인 절차(`dueCountByPriority`, 차단기 상태, 할당, 슬롯 사용, 재시도 대기).
- 성능 기준: 점유 쿼리 지연이 같은 데이터·조건·장비에서 기존 측정값의 2배 이내다. 기존 측정값은 ADR-0007 구현 중 확정 10의 값(할당 초과 호출처 대기 1만 건 1.4 ms, 10만 건 11.8 ms, PostgreSQL 17, 캐시 warm)이다.

**수용 조건:**

- [ ] 성능: 등급 혼합·할당 초과 적체가 있는 실제 PostgreSQL에서 두 경로의 점유 쿼리 실행 계획과 지연을 측정한다. 대기 1만 건·10만 건 각각에서 기존 측정값(1.4 ms·11.8 ms)의 2배 이내여야 한다. 기존 측정과 같은 데이터·조건·장비로 비교하고 결과를 기록한다. 기준을 넘으면 인덱스·쿼리 설계를 다시 검토한다.
- [ ] 위 요구사항의 문서(OpenAPI·요청 예제, 호출처 연동, 배포, 운영)에 등급, `MAILO_CLAIM_FIFO_RATIO`, 배포·롤백 순서, 굶음 한계, 등급별 적체 확인 절차가 있다.

**판정 근거:**

- 성능(측정 완료, 기준 충족, 수동 측정이라 `[ ]` 유지): 2026-11-23, PostgreSQL 17.11, 본문 2 KiB, 캐시 warm, 30회 중앙값, 같은 날 기존 쿼리 재측정 대비. 측정 방법과 실행 계획은 ADR-0009 구현 중 확정 3이다. 측정 스크립트는 저장소에 없다.

  | 쿼리 | 1만 건 | 10만 건 |
  | ---- | ------ | ------- |
  | 기존(재측정) | 0.99 ms | 9.09 ms |
  | 우선순위 경로, 등급 혼합 | 0.43 ms | 3.52 ms |
  | 우선순위 경로, 최악(초과 호출처가 모두 `URGENT`) | 1.06 ms | 9.86 ms |
  | 대기 순서 경로 | 1.02~1.11 ms | 9.41~9.46 ms |

  최대 1.08배(우선순위 경로 최악, 10만 건)다. 우선순위 경로는 `mail_jobs_priority_claim_idx`, 대기 순서 경로는 `mail_jobs_claim_idx`를 추가 정렬 없이 읽는다.
- 문서(검토로만 확인, `[ ]` 유지): `docs/api/openapi.yaml`(`Priority` 스키마, `SendRequest.priority`, `Job.priority`, 운영자 `queue`의 등급별 필드, 요청·응답 예시), `docs/api/README.md`, `docs/operations/caller-onboarding.md` "우선순위"(용도 기준, 파일·JWE 예시, 굶음 한계, 배포 순서), `docs/operations/deployment.md`(`MAILO_CLAIM_FIFO_RATIO`, "우선순위 도입 배포 순서", 헬스 필드), `docs/operations/troubleshooting.md` "등급별 적체", `.env.example`. 자동 검증은 없다.
- 마이그레이션(자동 검증): `0004_job_priority.sql`의 DEFAULT 20과 CHECK, `0005_job_priority_claim_index.sql`의 유효한 부분 인덱스(`queue/claim-priority.integration-spec.ts` "스키마"), 도입 전 schema에서 `0004`·`0005` 적용(`http/rest-priority.integration-spec.ts`), INVALID 인덱스가 남은 재실행의 fail-closed(`db/migrator.integration-spec.ts`, ADR-0009 구현 중 확정 4).
- 남은 미검증: 롤링 배포 중 구·신 인스턴스 혼용, 롤백 실행, 대용량 테이블의 `0005` 적용 시간과 쓰기 부하 중 적용, 캐시가 차가운 상태의 점유 지연.

## 13. 요청별 만료 시간

호출처가 요청마다 만료 시간을 상대값으로 정한다. 결정은 [ADR-0010](../adr/0010-per-request-job-ttl.md)이다.
예약 발송(not-before)과 요청별 재시도 횟수·간격은 범위 밖이다.

### RQ-039 요청별 만료 시간 지정

- [ ] **진행 상태:** 진행 중 (5단계)

**요구사항:**

- 요청 필드(ADR-0010 결정 1·2):
  - REST와 파일 요청의 최상위 필드에 정수 `ttlSeconds`를 선택적으로 받는다. 위치와 규칙은 `priority`(RQ-033)와 같다.
  - 만료 시각은 등록 때 DB `now() + ttlSeconds`로 `expires_at`에 고정한다. 같은 Key로 다시 요청해도 바뀌지 않는다.
  - 생략하면 `MAILO_JOB_EXPIRY_SECONDS`(RQ-008)를 쓴다.
  - 절대 시각 필드는 받지 않는다(ADR-0002 결정 10).
  - JWE `content`의 복호화 평문에 `ttlSeconds`가 있으면 `UNKNOWN_FIELD`다. 파일 JWS에서는 서명 대상이다.
- 허용 범위(ADR-0010 결정 3):
  - 정수 60 이상 `MAILO_JOB_EXPIRY_MAX_SECONDS` 이하다. 하한 60은 요청 필드에만 적용한다. `MAILO_JOB_EXPIRY_SECONDS`의 범위(1~31536000)는 그대로다.
  - `MAILO_JOB_EXPIRY_MAX_SECONDS`의 기본값은 `MAILO_JOB_EXPIRY_SECONDS`의 실제 값이다. 범위는 1~31536000이다.
  - 기동 때 `MAILO_JOB_EXPIRY_SECONDS` ≤ `MAILO_JOB_EXPIRY_MAX_SECONDS`를 검사한다.
  - 정수가 아닌 값은 `INVALID_FORMAT`, 범위 밖 정수는 `OUT_OF_RANGE`다(ADR-0010 구현 중 확정 1). REST는 400(위치 `/ttlSeconds`), 파일은 `VALIDATION_FAILED` 수집 거부다. 응답·기록에 요청 값을 넣지 않는다(RQ-027).
- 중복 등록(ADR-0010 결정 4, RQ-011):
  - 지정했을 때만 지문 `policy.ttlSeconds`에 요청 값을 넣는다. 생략 요청의 지문은 도입 전과 바이트 단위로 같다. 형식 태그 `mailo-fp-v1`을 유지한다.
  - 생략한 요청과 기본값을 명시한 요청은 다른 요청이다.
  - 같은 Key에 다른 `ttlSeconds`(생략 포함)를 보내면 REST는 409, 파일은 `FINGERPRINT_MISMATCH` 수집 거부다. 기존 작업은 바꾸지 않는다.
  - `priority`와 함께 쓰면 `policy` 키는 이름 순서로 정규화된다.
- 만료 의미(ADR-0010 결정 5):
  - 만료 시각 이후 새 시도를 시작하지 않는다. claim이 점유하지 않고 sweep이 `PENDING`·`RETRY_WAIT`를 `EXPIRED`로 바꾼다. 차단기 `open`·재시도 대기 중에도 같다.
  - 전송 중에 만료 시각이 지나도 그 시도는 끝까지 간다. 성공하면 `SENT`, 재시도 대상 오류면 재시도하지 않고 `EXPIRED`다.
- 보존 기간 기동 검사(ADR-0010 결정 6): `MAILO_RECORD_RETENTION_SECONDS` ≥ `MAILO_JOB_EXPIRY_MAX_SECONDS`다. 상한을 생략한 기존 설정은 검사 결과가 기존과 같다.
- 조회·이벤트(ADR-0010 결정 7): 조회 응답의 기존 `expiresAt`이 계산된 만료 시각이다. 응답에 `ttlSeconds` 필드를 추가하지 않는다. 이벤트 payload에 TTL을 넣지 않는다.
- 배포(ADR-0010 결정 8): 마이그레이션은 없다. 모든 Mailo 인스턴스를 갱신한 뒤 호출처가 `ttlSeconds`를 보낸다. 구 버전은 `UNKNOWN_FIELD`로 거부한다. 롤백 전에 호출처 전송을 먼저 끊는다.
- 한계: 긴 TTL은 한도 차단이 길어져도 메일이 결국 나가게 할 뿐, 한도로 생긴 지연을 없애지 않는다. 이 한계를 호출처 연동 문서에 적는다.

**수용 조건:**

- [x] `ttlSeconds`를 지정하면 `expires_at`이 등록 때 DB `now() + ttlSeconds`다. 같은 Key 재요청이 만료 시각을 바꾸지 않는다.
- [x] 생략하면 `MAILO_JOB_EXPIRY_SECONDS`를 쓰고 지문이 도입 전과 같다(골든 테스트).
- [x] 하한 미만·상한 초과·정수 아님은 REST 400, 파일 수집 거부다. 오류에 요청 값을 넣지 않는다(RQ-027).
- [x] REST와 파일 채널이 같은 규칙을 쓴다(`openRequest`·`toRegisterInput` 경유). 같은 Key에 다른 값(생략·기본값 명시 포함)은 REST 409, 파일 지문 불일치 거부이고 같은 값은 기존 작업이다.
- [x] 만료 뒤 짧은 TTL 작업은 점유되지 않고 `EXPIRED`가 된다. 차단기 `open`·재시도 대기·Worker 경로를 포함한다. 전송 중 만료된 시도는 끝까지 가서 성공하면 `SENT`다.
- [x] 상한·보존 기간 검사가 기동 때 동작한다. 기본 설정과 상한을 생략한 기존 설정은 기동을 거부하지 않는다.
- [ ] OpenAPI, `caller-onboarding.md`, `deployment.md`(새 변수, 배포 순서), `troubleshooting.md`, `.env.example`을 갱신한다.

**판정 근거:**

- `envelope/open-request.spec.ts`(단위) "openRequest: 요청별 만료 시간": 생략 요청의 정규화 문자열·지문 골든 값(우선순위 도입 전 값과 같은 리터럴), 하한 60·상한 경계값의 REST·파일 수락과 `policy` `["ttlSeconds",<값>]`, 기본값 명시와 생략의 지문 차이, 값이 다르면 지문 차이, `priority`와 함께 쓴 요청의 정규화 문자열(키 이름 순서, 필드 순서 무관), 범위 밖 정수 4종 `OUT_OF_RANGE`, 정수 아님 6종과 무한대·NaN `INVALID_FORMAT`, 상한은 의존성 값을 따름, JWS 서명 대상, JWE 바깥 값 보존, JWE 평문 안은 `UNKNOWN_FIELD`, canary 비노출, `toRegisterInput`의 기본값 대체.
- `config/load-config.spec.ts`(단위) "요청별 만료 상한": 상한 기본값이 기본 TTL의 실제 값, 명시값과 최대 31536000, 기본 TTL > 상한 거부와 같으면 수락, 범위 밖·정수 아님 5종 거부, 보존 < 상한 거부와 같으면 수락, 상한을 생략한 기존 설정(기본 TTL 15초, 30일)의 수락, 상한 생략 시 보존 < 기본 TTL 거부.
- `http/rest-ttl.integration-spec.ts`(PostgreSQL): 하한·중간·상한 값의 `expires_at − created_at`과 응답·ID 조회의 `expiresAt` 일치, 생략은 기본 TTL이고 응답에 `ttlSeconds` 없음, 같은 값 재요청 200과 만료 시각 불변, 다른 값·지정 뒤 생략·생략 뒤 지정·생략 뒤 기본값 명시 409와 만료 시각 불변, `priority`와 함께 쓴 요청의 필드 순서 무관 200, 잘못된 값 8종 400 `/ttlSeconds`와 미등록·canary 비노출, 오류에 요청 값·상한 값 없음.
- `file-channel/poller.integration-spec.ts`(PostgreSQL) "요청별 만료 시간": 생략·평문 JSON·JWS·JWE 파일의 TTL 저장, 잘못된 값 7종과 JWE 평문 안 `ttlSeconds`의 `VALIDATION_FAILED` 거부와 원본 삭제·canary 비노출, 같은 값 중복과 다른 값·생략의 `FINGERPRINT_MISMATCH`, 기존 만료 시각 불변.
- `e2e/job-ttl.integration-spec.ts`(PostgreSQL, REST 등록): 짧은 TTL `PENDING`의 점유 제외와 sweep `EXPIRED`·`JOB_EXPIRED` 이벤트(payload에 TTL 없음), `RETRY_WAIT` 중 만료, 다음 재시도가 만료 뒤이면 결과 기록 때 `EXPIRED`, 차단기 `open`이 기본 TTL보다 길 때 긴 TTL 작업만 남아 닫힌 뒤 점유, 전송 중 만료된 시도의 `SENT`와 일시 오류 시 `EXPIRED`, Worker(메모리 발송기, 일시 오류)가 TTL 60초 작업을 `EXPIRED`로·기본 TTL 작업을 `RETRY_WAIT`로 처리.
- RED 확인(2026-11-23): 구현 전 코드에서 신규 단위 테스트가 실패했다(기존 동작과 같은 일부 항목은 통과, 수는 기록하지 않았다). 신규 통합 테스트는 29건 중 26건이 실패했다(기존 동작과 같은 3건은 통과).
- 구현: `envelope/request-schema.ts`(검증), `envelope/open-request.ts`(`requestPolicy`), `envelope/register-input.ts`, `config/load-config.ts`. 큐 SQL(`queue/register.ts`·`claim.ts`·`complete.ts`·`maintenance.ts`)은 바꾸지 않았다.
- 문서(검토로만 확인, `[ ]` 유지): `docs/api/openapi.yaml`(`SendRequest.ttlSeconds`, 파일 요청, `OUT_OF_RANGE`, `Job.expiresAt`), `docs/api/README.md`, `docs/operations/caller-onboarding.md` "요청별 만료 시간", `deployment.md`(`MAILO_JOB_EXPIRY_MAX_SECONDS`, "요청별 만료 시간 도입 배포 순서"), `troubleshooting.md`, `key-management.md`, `.env.example`.
- 남은 미검증: 롤링 배포 중 구·신 인스턴스 혼용과 롤백 실행, 긴 상한에서의 대기 건수와 점유 지연, 하한 60의 적정성.

## 14. 운영 제어와 호출처 보호: 작업 취소

결정은 [ADR-0011](../adr/0011-operations-control-and-caller-protection.md) 결정 4·10이다. RQ-040·041은 호출처 API 키로 하는 취소만 다룬다. RQ-042~044가 운영 토큰·`/ops`, 발송 정지, 감사와 관리 취소를 다룬다. RQ-045~047이 이벤트 피드 공백 신호(결정 9), 수신 도메인 허용 목록(결정 8), 운영 CLI(결정 7)를 다룬다. RQ-048이 `outcomeUncertain` 표시(결정 5)를 다룬다. 호출처 단위 일괄 취소는 ADR상 범위 밖이고 새 결정이 있을 때 RQ를 추가한다.

### RQ-040 호출처 작업 취소

- [x] **진행 상태:** 검증 완료 (6단계 묶음 A)

**요구사항:**

- 상태 `CANCELED`(종결)와 이벤트 `JOB_CANCELED`를 둔다(ADR-0011 결정 4).
- 취소할 수 있는 작업은 `PENDING`·`RETRY_WAIT`뿐이다. `SENDING`은 취소하지 않는다. 진행 중인 전송을 중단하지 않는다(ADR-0009 결정 8과 같다).
- 호출처 API(호출처 키, 자기 작업만):
  - `POST /jobs/{jobId}/cancel`. 작업 ID를 아는 호출처가 쓴다.
  - `POST /jobs/cancel?idempotencyKey=<Key>`. 파일 채널 호출처가 쓴다. 요청 본문은 없고 보내도 읽지 않는다.
  - 다른 호출처의 작업과 없는 작업은 구분하지 않고 404다(RQ-015와 같다). 형식이 틀린 `jobId`·Key는 400(`validation-failed`)이다.
- 응답:
  - 취소했거나 이미 `CANCELED`이면 200과 `Job`이다. 이미 `CANCELED`이면 이벤트와 로그를 새로 쓰지 않는다(멱등). 처음 취소의 `canceledAt`·`canceledBy`를 바꾸지 않는다.
  - `SENDING`, `SENT`, `FAILED`, `EXPIRED`이면 409(`urn:mailo:problem:job-not-cancelable`)이고 작업은 바뀌지 않는다. 현재 상태는 `jobStatus`로 알린다(ADR-0011 구현 중 확정 1). 요청 값은 넣지 않는다(RQ-027).
- 저장:
  - 한 트랜잭션에서 작업 전이, 본문 삭제, `JOB_CANCELED` 이벤트를 쓴다. 이벤트 쓰기가 실패하면 전이도 롤백한다(RQ-017과 같다).
  - `finished_at = now()`(DB 시각), `failure_reason = CANCELED_BY_CALLER`. 본문 컬럼 세 개를 함께 NULL로 바꾸고 `body_deleted_at`을 쓴다. 나갈 수 없는 메일의 본문을 유예 기간 동안 두지 않는다. 행, Key, 지문은 종결 후 보존 기간(기본 30일)까지 남는다(ADR-0005 결정 7).
  - `failure_reason`은 응답의 `failureReason`으로 내보내지 않는다. `CANCELED`에서 `sentAt`·`failedAt`·`failureReason`은 `null`이다.
- 경합: 취소와 `claim`은 작업 행 잠금으로 직렬화한다. 한 작업이 취소되면서 동시에 점유되지 않는다. 취소는 `mail_circuit_breaker`를 읽거나 쓰지 않아 잠금 순서(작업 행 → 차단기 행)를 지킨다.
- Key 계약(RQ-034): 취소된 작업의 Key로 같은 내용을 다시 보내면 200과 `CANCELED` 작업이다. 다른 내용이면 409다. 새 메일은 새 Key로 보낸다.
- 이벤트와 조회:
  - `JOB_CANCELED`를 작업 호출처의 피드에 쓴다. 호출처가 직접 취소해도 쓴다. 필드는 `jobId`, `idempotencyKey`, `attempts`, `recipients`와 `canceledBy`(`CALLER`·`OPERATOR`)다. 운영자 이름은 넣지 않는다.
  - `GET /events?type=JOB_CANCELED` 필터를 지원한다.
  - `Job` 응답에 `canceledAt`, `canceledBy`(`CALLER`·`OPERATOR`·`null`)를 더한다.
- 로그: `job_canceled`(info)에 `jobId`, `callerId`, `canceledBy`만 남긴다. `Idempotency-Key`·수신자·본문은 남기지 않는다(RQ-027).
- 후속 처리: `CANCELED` 작업은 점유·만료 sweep·본문 정리 대상이 아니다. 보존 기간이 지나면 작업과 이벤트를 함께 지운다.
- 관리 토큰 취소와 감사는 RQ-044가 다룬다. 호출처 단위 일괄 취소는 ADR상 범위 밖이다.

**수용 조건:**

- [x] `PENDING`·`RETRY_WAIT` 작업의 취소가 `CANCELED`, `finished_at`, 사유, 본문 삭제, `JOB_CANCELED` 이벤트를 한 트랜잭션에서 쓴다. 이벤트 쓰기가 실패하면 전이도 롤백한다. 행·Key·지문은 남는다.
- [x] `SENDING`, `SENT`, `FAILED`, `EXPIRED`는 409 `job-not-cancelable`과 `jobStatus`이고 작업·본문·이벤트를 바꾸지 않는다.
- [x] 이미 `CANCELED`이면 200과 같은 응답이고 이벤트·시각·사유가 바뀌지 않는다(멱등).
- [x] 다른 호출처의 작업과 없는 작업은 같은 404이고 다른 호출처의 작업은 바뀌지 않는다. ID와 Key 경로 모두 같다. 인증 없음·틀린 키는 401이다.
- [x] 취소와 `claim`이 한 작업에서 둘 다 이기지 않는다. 잠금을 쥔 상태의 두 방향과 동시 반복으로 확인한다.
- [x] 취소된 작업의 Key로 같은 내용은 200(`CANCELED`)이고 다른 내용은 409다. 새 작업이 생기지 않는다.
- [x] 호출처 피드에 `JOB_CANCELED`가 한 건 생기고 `canceledBy`를 담는다. `type` 필터로 거를 수 있다. 다른 호출처의 피드에는 없다.
- [x] `Job` 응답이 `CANCELED`와 `canceledAt`·`canceledBy`를 내고, 취소하지 않은 작업은 두 필드가 `null`이다.
- [x] 취소 응답·이벤트·로그에 본문·제목·수신자·`Idempotency-Key`가 없다(canary).
- [x] 취소된 작업은 Worker가 켜져 있어도 발송되지 않는다. `RETRY_WAIT`에서 취소하면 재시도 시각이 돼도 다시 보내지 않는다.
- [x] 취소된 작업은 claim·sweep·본문 정리 대상이 아니고 보존 기간 뒤 작업과 이벤트가 함께 삭제된다.

**판정 근거:**

- `queue/cancel.integration-spec.ts`(PostgreSQL): `PENDING` 취소의 모든 저장 값과 이벤트, Key로 취소와 `OPERATOR` 사유(확장 자리), `RETRY_WAIT` 취소와 시도 횟수 유지, 멱등(이벤트 1건·시각 불변), `SENDING`·`SENT`·`FAILED`·`EXPIRED`의 `not_cancelable`과 무변경, 다른 호출처·없는 작업의 `not_found`, 이벤트 쓰기 실패 시 롤백(`mail_events_type_check`를 임시로 옛 값으로 되돌려 확인), `claim`이 행 잠금을 쥔 동안 취소가 기다렸다가 `SENDING`을 보고 `not_cancelable`, 취소가 행을 잡은 동안 `claim`이 건너뜀, 취소 40건과 `claim` 8건 동시 실행의 상호 배타와 이벤트 수, claim·sweep·본문 정리 제외, 보존 삭제, 읽기 모델, 차단기 `open`·대표 작업 중 차단기 행 불변.
- `http/rest-cancel.integration-spec.ts`(PostgreSQL, 실제 앱): 두 endpoint의 200 응답 모양과 본문 삭제, 멱등, `SENDING`·종결 409(`type`·`jobStatus`), 호출처 격리 404 동일 응답(요청 ID만 다름), `jobId` 형식·퍼센트 디코딩 오류 400, 401, Key 누락·형식 오류 400, 본문을 보내도 처리, Key 계약(200·409·새 작업 없음), 조회 두 경로 동일, 취소하지 않은 작업의 `canceledAt`·`canceledBy` null, `JOB_CANCELED` 이벤트 필드 집합과 `type` 필터(단독·복수)와 격리, 모르는 `type` 400, canary(응답·로그·DB 이벤트), `job_canceled` 로그 필드 집합과 멱등 재요청 무로그.
- `e2e/mail-flow.integration-spec.ts`(PostgreSQL, Worker, 로컬 SMTP): 취소한 `PENDING` 작업이 Worker 기동 뒤에도 발송되지 않음(SMTP 0통), `RETRY_WAIT` 취소 뒤 재시도 시각이 돼도 DATA 호출 수가 늘지 않음.
- `db/job-constraints.integration-spec.ts`: `CANCELED`와 `finished_at`의 짝, `JOB_CANCELED` 삽입, 모르는 값 거부.
- RED 확인(2026-11-24): 구현 전 코드에서 신규 `rest-cancel` 통합 테스트와 `job-constraints` 신규 항목이 실패했고(실행 결과 31건 중 20건 실패, 11건은 기존 동작과 같아 통과) `queue/cancel` 통합 테스트는 `cancelJob`이 없어 컴파일에 실패했다.
- 구현: `queue/cancel.ts`, `intake/intake.service.ts`·`intake.controller.ts`·`presenters.ts`·`query-params.ts`, `http/problem.ts`, 마이그레이션 `0006`·`0007`.
- 샘플 e2e(`samples/spring-boot-relay/verify/run-e2e.sh`의 S15·S15b)는 스크립트 검증이라 `[x]` 근거에 쓰지 않았다. 결과는 RQ-041 판정 근거에 적는다.

### RQ-041 취소 배포 호환성과 호출처 선행 조건

- [ ] **진행 상태:** 진행 중 (6단계 묶음 A)

**요구사항:**

- 마이그레이션은 `0006_job_canceled_status.sql`(`mail_jobs`의 `mail_jobs_status_check`·`mail_jobs_terminal_state`)과 `0007_event_type_canceled.sql`(`mail_events`의 `mail_events_type_check`)이다. 테이블마다 파일을 나눈다. 각 제약을 `DROP` 뒤 같은 이름으로 `NOT VALID`로 다시 추가한다. 기존 파일은 고치지 않는다. 되돌리지 않는다(ADR-0011 결정 10).
- 호출처가 모르는 이벤트 종류·`Job.status`·응답 필드를 처리하는 규칙은 `docs/api/README.md`에 있다(ADR-0011 구현 순서 1). 취소 API를 쓰기 전에 사용처가 이 규칙을 지켜야 한다.
- 샘플(`samples/spring-boot-relay/`)은 `CANCELED`·`JOB_CANCELED`를 실패가 아닌 종결로 처리한다(ADR-0011 구현 순서 1.7).
- 배포 순서는 선행 조건 확인 → 마이그레이션 → 모든 인스턴스 교체 → 호출처가 취소 API 사용이다. 롤링 중에는 취소 API를 쓰지 않는다. 롤백은 취소 API 사용 중지 → 이전 버전이고 스키마는 되돌리지 않는다.
- 구버전 인스턴스는 `CANCELED`를 그대로 내보내고 `GET /events?type=JOB_CANCELED`를 400으로 거부한다(코드를 읽어 확인했다).
- 운영 문서: `docs/operations/deployment.md`("작업 취소 도입 배포 순서", `job_canceled` 로그), `caller-onboarding.md`("작업 취소"), `troubleshooting.md`("작업 취소"). API 문서: `docs/api/openapi.yaml`, `docs/api/README.md`.

**수용 조건:**

- [x] `0006`·`0007` 적용 뒤 `CANCELED`·`JOB_CANCELED`가 허용되고 모르는 값은 계속 거부되며 세 제약의 이름이 유지되고 `convalidated = false`다.
- [x] 마이그레이션 실행기가 새 schema에 `0001`~`0007`을 순서대로 적용하고 기존 통합 테스트가 모두 통과한다.
- [x] 샘플이 `CANCELED`와 `JOB_CANCELED`를 종결로 반영하고(이벤트·`GET /jobs`·확인 필요 해소 경로) 모르는 값은 계속 확인 필요로 둔다. Gradle 단위 테스트로 확인한다(로컬 실행, CI 대상 아님).
- [ ] 롤링 배포(구·신 인스턴스 혼용)와 롤백을 실행해 구버전 동작과 문서 절차를 확인한다.
- [ ] 이 저장소 밖 호출처가 모르는 값 규칙을 지키는지 확인한다(ADR-0011 구현 순서 1.8).
- [ ] `docs/api/openapi.yaml`, `docs/api/README.md`, `docs/operations/`를 갱신한다(검토로만 확인했고 자동 검증은 예시 스키마 적합성 점검뿐이다).

**판정 근거:**

- `db/job-constraints.integration-spec.ts`: `CANCELED`·`JOB_CANCELED` 허용과 짝 제약, 모르는 값 거부, 제약 이름·`convalidated`(`pg_constraint`). 모든 PostgreSQL 통합 테스트가 `test/support/queue-fixtures.ts`의 `migrate`로 `0001`~`0007`을 새 schema에 적용한다.
- 샘플 Gradle 단위 테스트(`JobStatusMappingTest`, `EventFeedPollerApplyTest`, `NeedsCheckResolverTest`): `CANCELED` 종결 반영과 취소 사유, `JOB_CANCELED` 이벤트 처리, 모르는 상태·이벤트 종류의 확인 필요 유지(대소문자가 다른 값 포함). DB 없이 대역으로 확인하며 상태 전이 SQL 조건은 e2e 스크립트가 맡는다.
- 샘플 e2e 스크립트 `samples/spring-boot-relay/verify/run-e2e.sh`의 S15·S15b(결과는 아래 "검증 수치"의 샘플 항목). 스크립트 검증이라 자동 테스트가 아니다.
- API 계약 예시 8건을 일회성 스크립트(ajv 8, JSON Schema 2020-12)로 스키마에 대조했다(저장소에 없다). OpenAPI 전용 린터는 실행하지 않았다.
- 남은 미검증: 롤링 배포·롤백 실행, 대용량 테이블·쓰기 부하 중 `ACCESS EXCLUSIVE` 잠금 대기, 저장소 밖 호출처, 샘플 외 호출처의 모르는 값 처리.

### RQ-042 운영 토큰(읽기·관리)과 `/ops` 인증

- [x] **진행 상태:** 검증 완료 (6단계 묶음 B)

**요구사항:**

- 운영 토큰은 두 종류다(ADR-0011 결정 1).
  - 읽기 토큰은 기존 `MAILO_OPS_TOKEN`이다. 읽기 endpoint(`/health/ready`의 운영자 필드, `GET /ops/*`)만 연다. RQ-031의 "운영자 토큰"은 읽기 토큰으로 해석한다.
  - 관리 토큰은 이름마다 하나다. `MAILO_OPS_ADMIN_NAMES`(쉼표 구분, 이름 `[a-z][a-z0-9]{0,31}`, 최대 8개)에 이름을 적고 이름마다 `MAILO_OPS_ADMIN_TOKEN_<이름 대문자>`(`_FILE` 우선)로 값을 받는다. 관리 토큰은 읽기 권한을 포함한다.
- 토큰 값은 공백 없는 32자 이상이다. 비교는 상수 시간이다(해시끼리 `timingSafeEqual`, 일치 뒤에도 끝까지 비교한다).
- 기동을 거부하는 경우: 이름 형식 위반·중복·9개 이상, 이름의 토큰 없음·규칙 위반, 토큰 값끼리 같음(읽기 포함), 호출처 API 키와 같음(레지스트리의 `authenticate`로 비교). 사유에는 변수 이름만 담고 값은 담지 않는다(RQ-027).
- `MAILO_OPS_ADMIN_NAMES`가 없으면 관리 기능이 꺼진다. 관리 endpoint는 읽기 토큰에 403, 그 밖에 401이다.
- 판정: 인증은 라우트 매칭 전 미들웨어가 먼저 한다(경로 파라미터 디코딩 오류가 인증보다 먼저 나가지 않는다, ADR-0011 구현 중 확정 20). 읽기 endpoint는 읽기·관리 토큰, 변경 endpoint는 관리 토큰만 받는다. 읽기 토큰으로 변경 endpoint를 부르면 403 `forbidden`, 호출처 키와 모르는 값과 자격 없음은 401이다. 모든 `/ops/*`는 호출처 키로 401이다. 업무 endpoint(`/jobs`, `/events`)에서는 두 토큰 모두 401이다.
- `GET /ops/jobs/{jobId}`는 모든 호출처의 작업을 `Job`에서 `idempotencyKey`와 `rejectedRecipients`(거부된 수신자 주소)를 빼고 `callerId`를 더해 준다. 수신자·본문은 없다.
- 토큰 값은 로그·감사·오류·응답에 쓰지 않는다. `/ops` 응답은 `Cache-Control: no-store`다.

**수용 조건:**

- [x] 이름 목록·토큰 변수(`_FILE` 우선)를 읽고 이름 형식·중복·개수·누락·길이·공백·토큰끼리 같음을 기동 거부한다. 값은 사유에 없다.
- [x] 호출처 API 키와 같은 운영 토큰(읽기·관리)은 기동을 거부하고 값을 오류에 쓰지 않는다.
- [x] Bearer 판정이 읽기(`role: read`)·관리(`role: admin`, 이름)·호출처·모르는 값·없음을 구분한다. 판정기를 넘기지 않는 업무 endpoint는 운영 토큰을 `invalid`로 본다.
- [x] 읽기·관리·변경 endpoint마다 자격 없음·호출처 키·모르는 값 401, 읽기 토큰의 변경 403(상태·감사 불변)을 확인한다. 관리 토큰이 없는 앱과 운영 토큰이 없는 앱의 동작이 맞다.
- [x] `/ops/jobs/%`·`/ops/jobs/%/cancel`·`/ops/pauses/callers/%`는 자격 없음·호출처 키에 401, 읽기 토큰의 변경에 403이고 인증된 호출에만 400이다.
- [x] 두 토큰은 업무 endpoint에서 401이다.
- [x] 응답·로그·감사 행·이벤트에 토큰 값이 없다(canary).
- [x] `/ops` 응답(작업 조회·취소, 정지 목록, 감사, 헬스)에 수신자 주소가 없다. 거부된 수신자가 있는 `SENT` 작업의 `GET /ops/jobs/{jobId}`에도 없다(호출처 응답은 기존대로 준다).

**판정 근거:**

- `config/ops-tokens.spec.ts`(단위): 이름·토큰 읽기, `_FILE` 우선, 이름 형식 위반 5종, 중복·9개, 8개 허용, 토큰 누락·짧음·공백, 토큰끼리·읽기와 같음, 이름 목록에 없는 변수 무시, 설정 객체 직렬화 비노출.
- `callers/ops-bearer.spec.ts`(단위): 읽기·관리·호출처·invalid·absent 판정, 판정기 없음, 토큰 없는 설정.
- `http/ops.integration-spec.ts`(PostgreSQL, 실제 앱) "권한" 절: 읽기·변경 endpoint 매트릭스, 관리 토큰 없는 앱·운영 토큰 없는 앱, 업무 endpoint 401, 호출처 키와 같은 토큰의 기동 거부. "로그와 시크릿 비노출" 절: 토큰·본문·제목·수신자·Key canary.
- RED 확인(2026-11-24): `OpsModule`을 빼고 실행하면 `ops.integration-spec.ts` 58건 중 53건이 실패한다(`/ops` 404). 단위 두 파일은 구현 뒤에 작성해 실행했다(RED를 따로 확인하지 않았다).
- 구현: `config/load-config.ts`의 `loadOps`, `callers/bearer-auth.ts`(`createOpsTokenMatcher`, `OpsReadGuard`, `OpsAdminGuard`), `callers/callers.module.ts`(호출처 키 비교), `http/problem.ts`(`forbidden`).
- 남은 미검증: 실제 운영 시크릿 마운트(`_FILE`)를 쓰는 컨테이너 기동, 다중 인스턴스에서 토큰 교체 순서.

### RQ-043 발송 정지(전체·호출처)

- [ ] **진행 상태:** 진행 중 (6단계 묶음 B)

**요구사항:**

- 정지는 DB 테이블 `mail_send_controls`에 저장한다. 행이 있으면 정지다. 키는 `(scope_type, scope_id)`이고 컬럼은 `paused_at`(DB `now()`), `paused_by`(관리 토큰 이름)뿐이다. 자유 텍스트 컬럼은 없다. `account` 범위는 스키마에만 있고 이 버전은 쓰지 않는다(ADR-0011 결정 2).
- `claim`은 차단기 행을 읽은 뒤 정지를 읽는다. 행을 잠그지 않는다. 잠금 순서(작업 행 → 차단기 행)를 바꾸지 않는다.
  - 전체 정지면 일반 점유와 대표 작업(`half_open`·`open` 만료) 점유를 모두 하지 않고 차단기도 바꾸지 않는다.
  - 호출처 정지는 `planQuotas` 전에 할당 맵에서 빼고 `caller_id <> ALL` 목록(`blocked`)에 합친다. 정지한 호출처에는 advisory lock과 사용량 쿼리를 쓰지 않는다. 할당이 없거나 할당 맵이 비어 있어도 정지는 적용된다.
  - 다른 호출처는 영향이 없다. 정지는 차단기와 독립이다. 정지를 풀어도 차단기 상태는 바뀌지 않는다.
- 정지 중에도 lease 복구, 결과 기록, 만료 sweep, 본문·기록 삭제, 등록(REST·파일)은 계속한다. 이미 `SENDING`인 작업의 전송은 끝까지 가고 결과를 기록한다. 정지 명령이 커밋되기 전에 정지를 읽은 `claim`이 있을 수 있어 정지 직후에도 최대 인스턴스 수 × `MAILO_WORKER_CONCURRENCY`건이 점유를 마친 채 남을 수 있다(코드 읽기에 따른 상한 추정, 측정하지 않았다).
- 정지 중에도 `expiresAt`은 흐른다. 긴 정지는 `EXPIRED`를 만든다.
- `/health/ready`의 200/503에는 반영하지 않는다(RQ-031). 호출처 키 응답에만 `sendPaused: { paused, scope: "all" | "caller" | null }`(자기 범위, `all` 우선, 호출처 ID·이름·시각 없음)을, 운영자 응답에만 `sendControls: { allPaused, pausedCallerCount }`(호출처 ID 없음)를 더한다. 인증 없는 응답은 바뀌지 않는다. 정지를 이벤트 피드로 알리지 않는다.
- REST: `PUT`·`DELETE /ops/pauses/all`, `PUT`·`DELETE /ops/pauses/callers/{callerId}`(관리), `GET /ops/pauses`(읽기). 멱등이다. 이미 그 상태면 `changed: false`다. `callerId`는 레지스트리 ID 형식이어야 하고(틀리면 400) 레지스트리에 있는지는 확인하지 않는다(`inRegistry`로 알린다). 호출처 정지는 레지스트리 `enabled`가 아니라 DB `caller` 범위다.
- Worker는 정지 상태가 바뀐 것을 관찰할 때 한 번 `send_paused`(warn)·`send_resumed`(info)를 남긴다(필드 `scope`, `callerId`). 폴링마다 반복하지 않는다.
- 롤링 중(구·신 혼용)에는 정지 명령을 쓰지 않는다. 구버전은 정지를 읽지 않는다.

**수용 조건:**

- [x] 전체 정지 중 일반 점유가 0건이고 작업·시도 횟수·재시도 시각이 변하지 않는다. 해제하면 다음 점유에서 발송 대상이 된다.
- [x] 차단기가 `open`(만료)·`half_open`(`probe_until` 경과)이어도 전체 정지 중에는 대표 작업을 점유하지 않고 차단기를 바꾸지 않는다. 호출처 정지는 대표 작업 후보에서도 그 호출처를 고르지 않는다.
- [x] 호출처 정지는 다른 호출처에 영향이 없고 해제하면 점유된다. `all`과 `caller`는 따로 해제된다.
- [x] 정지한 호출처는 할당 계산에서 빠진다(advisory lock·사용량 쿼리 없음, 할당 초과 알림 없음). 정지하지 않은 호출처는 같은 조건에서 계산한다.
- [x] 정지 조회는 행을 잠그지 않고 차단기 조회 뒤, 작업 행 잠금 앞에서 읽는다. 시각은 DB `now()`다.
- [x] 이미 `SENDING`인 작업은 정지 뒤에도 결과를 기록한다. 정지 중 실패한 작업은 `RETRY_WAIT`이고 해제 전에는 점유되지 않는다. lease 복구는 정지 중에도 돈다.
- [x] 정지 중에도 등록은 202다. 실제 Worker는 정지 중 발송하지 않고 재개하면 발송한다. 호출처 정지는 다른 호출처의 발송을 막지 않는다.
- [x] 호출처 키 `/health/ready`가 자기 범위의 `sendPaused`만 낸다. 운영자 응답은 `sendControls`만 내고 호출처 ID가 없다. 정지 중에도 200이고 `status`는 `UP`이다.
- [x] `PUT`·`DELETE`는 멱등이고 `changed`·`pausedAt`·`pausedBy`·`inRegistry`가 맞다. 형식이 틀린 `callerId`는 400이다.
- [x] `send_paused`·`send_resumed`가 상태가 바뀔 때만 한 번 남고 폴링마다 반복되지 않는다.
- [x] 마이그레이션 `0008`이 `0001`~`0007` 위에서 적용되고 재실행해도 다시 적용되지 않는다. 기존 작업 행을 바꾸지 않는다.
- [ ] 롤링 배포(구·신 혼용)와 롤백을 실행해 구버전이 정지를 무시하는 동작과 문서 절차를 확인한다.
- [ ] 다중 인스턴스에서 정지 명령 직후 점유를 마친 작업 수가 추정 상한(인스턴스 수 × 동시 전송 수) 이내인지 확인한다.

**판정 근거:**

- `queue/send-controls.integration-spec.ts`(PostgreSQL 25건): 전체 정지(일반·probe 둘 다, `open`·`half_open`), 호출처 정지(격리, 해제, probe 후보), 쿼터 계산 제외(풀 래퍼가 보낸 SQL 대조), 잠금 순서와 `now()`, 진행 중 영향, 알림·조회.
- `worker/worker-send-controls.integration-spec.ts`: Worker의 로그 한 번과 재개 발송, 호출처 정지의 격리.
- `e2e/ops-pause.integration-spec.ts`: `/ops` 정지 → 실제 Worker → 로컬 SMTP. 정지 중 SMTP 0통과 재개 뒤 발송.
- `http/ops.integration-spec.ts`: 정지·재개 REST, 호출처 정지, 목록, 헬스 요약, 정지 중 등록, 원자성.
- `db/ops-controls.integration-spec.ts`: `0008` 적용·재실행, `CHECK` 제약.
- RED 확인(2026-11-24): `claim.ts`를 정지 구현 전으로 되돌리면 `send-controls.integration-spec.ts` 25건 중 15건이 실패한다.
- 점유 쿼리 비용(로컬 PostgreSQL 17, 임시 schema, 10만 건 대기, `EXPLAIN (ANALYZE)`, 단일 측정): 정지 조회는 `Seq Scan on mail_send_controls` 1행, 실행 0.009ms다. 정지가 없으면 점유 쿼리 계획은 바뀌지 않는다(`mail_jobs_priority_claim_idx` 인덱스 스캔). 정지한 호출처를 `caller_id <> ALL`로 빼도 같은 계획이다. 정지한 호출처가 대기 작업 전부를 가지면 순서 인덱스를 쓰지 못하고 `mail_jobs`를 전체 읽는다(실행 7.4~13.8ms, ADR-0007 구현 중 확정 10의 할당 초과와 같은 동작). 다중 인스턴스·운영 크기는 측정하지 않았다.
- 구현: `queue/send-controls.ts`, `queue/claim.ts`, `worker/worker.ts`, `health/health.service.ts`, `ops/`, 마이그레이션 `0008`.
- 남은 미검증: 롤링 배포·롤백 실행, 다중 인스턴스에서 정지 직후 점유 수, 정지 해제 직후의 SMTP 계정 한도 반응, 정지가 길 때의 점유 쿼리 비용(운영 크기).

### RQ-044 관리 감사와 관리 취소

- [x] **진행 상태:** 검증 완료 (6단계 묶음 B)

**요구사항:**

- 관리 작업은 DB 테이블 `mail_ops_audit`에 감사를 남긴다(ADR-0011 결정 6). 컬럼은 `id`(identity), `at`(DB `now()`), `actor`(관리 토큰 이름, 1~32자), `action`(`PAUSE`·`RESUME`·`CANCEL_JOB`), `scope_type`·`scope_id`(정지·재개), `job_id`(취소, 외래 키 없음)다. `CHECK`가 동작별 필드 조합을 강제한다. 자유 텍스트 컬럼은 없다.
- 감사는 상태 변경과 같은 트랜잭션에 쓴다. 한쪽이 실패하면 둘 다 롤백한다. 상태를 바꾼 요청만 기록한다. `changed: false`인 멱등 재요청과 이미 `CANCELED`인 취소는 기록하지 않는다. 401·403은 감사하지 않는다. 호출처가 키로 직접 취소한 것은 감사 대상이 아니다.
- `GET /ops/audit?limit=<1~200, 기본 50>&before=<id>`(읽기)는 최근 순서로 `{ entries, nextBefore }`를 준다. `id`는 문자열이다. 더 오래된 항목이 없으면 `nextBefore`는 `null`이다.
- `POST /ops/jobs/{jobId}/cancel`(관리)은 호출처 범위 없이 `PENDING`·`RETRY_WAIT`을 `CANCELED`(`canceledBy: OPERATOR`)로 바꾸고 `JOB_CANCELED`를 쓴다. 응답은 `GET /ops/jobs/{jobId}`와 같은 모양이다. 이미 `CANCELED`면 200이고 이벤트·감사를 새로 쓰지 않는다. `SENDING`·종결이면 409 `job-not-cancelable`(`jobStatus`), 없으면 404, 형식이 틀리면 400이다.
- 로그: `ops_pause_set`, `ops_pause_cleared`, `ops_job_canceled`(info)를 `actor`와 범위(`scope`, 호출처 정지면 `callerId`) 또는 `jobId`만 담아 남긴다. 멱등 재요청에는 남기지 않는다(ADR-0011 구현 중 확정 9).
- 감사 보존은 자동 삭제 없이 DB 테이블이다. 삭제 정책은 새 결정으로 정한다.

**수용 조건:**

- [x] 정지·재개는 변경됐을 때만 감사 한 건을 쓴다(`PAUSE`·`RESUME`, 토큰 이름, 범위). 멱등 재요청은 쓰지 않는다.
- [x] 감사 기록이 실패하면 정지·재개·취소가 롤백되고 503이다. 정지 변경이 실패하면 감사도 남지 않는다. 취소 이벤트 쓰기가 실패하면 감사도 남지 않는다.
- [x] 관리 취소는 어느 호출처의 작업이든 취소하고 `OPERATOR`로 기록하며 본문을 지우고 피드에 `JOB_CANCELED`(운영자 이름 없음)를 한 건 쓰고 감사에 `CANCEL_JOB`과 작업 ID를 쓴다.
- [x] 이미 `CANCELED`인 취소는 200이고 이벤트·감사가 늘지 않는다. `SENDING`·`SENT` 취소는 409이고 감사가 없다. 없는 작업은 404, 형식 오류는 400이다.
- [x] 감사 목록이 최근 순서, `limit`·`before` 쪽 나눔, 마지막 쪽 `nextBefore` null, 입력 검증(400)을 지킨다.
- [x] 로그가 `actor`와 범위·작업 ID 필드만 담고 멱등 재요청에는 남지 않는다.
- [x] 감사 행·로그·응답에 토큰 값·본문·제목·수신자·Key가 없다(canary).
- [x] 감사 테이블에 자유 텍스트 컬럼이 없고 `CHECK`가 동작별 필드 조합을 강제한다. 작업 행이 지워져도 감사가 남는다.

**판정 근거:**

- `http/ops.integration-spec.ts`(PostgreSQL, 실제 앱): 관리 취소(다른 호출처, `OPERATOR`, 피드, 멱등, 409·404·400), 작업 조회, 감사 목록(최근 순서, 쪽 나눔, 경계, 입력 검증 11종), 원자성 5종(`mail_ops_audit`·`mail_send_controls`·`mail_events`에 실패 트리거를 걸어 주입), 로그 필드 집합, canary.
- `db/ops-controls.integration-spec.ts`: 감사 `CHECK` 조합 허용 3종·위반 9종, 외래 키 없음, 컬럼 목록.
- 구현: `queue/cancel.ts`의 `cancelJobAsOperator`, `ops/`(`audit.ts`, `ops.service.ts`, `ops.controller.ts`), `intake/presenters.ts`의 `presentOperatorJob`, 마이그레이션 `0008`.
- 남은 미검증: 감사 행 수 증가(운영 기간), 동시 정지·재개의 경합(`INSERT ... ON CONFLICT`의 동작은 한 연결에서만 확인했다).

### RQ-045 이벤트 피드 공백 감지

- [ ] **진행 상태:** 진행 중 (6단계 묶음 C)

**요구사항:**

- 이벤트는 보존 삭제(`deleteExpiredRecords`)가 작업·거부 기록을 지울 때 외래 키 `ON DELETE CASCADE`로 함께 지워진다. 이 삭제를 호출처가 알 수 있어야 한다(ADR-0011 결정 9). cursor 형식과 반환 조건은 바꾸지 않는다(RQ-017).
- 삭제 표지 테이블 `mail_event_purges(caller_id, type, purged_txid xid8, purged_id bigint, updated_at)`를 둔다(마이그레이션 `0009`). 키는 `(caller_id, type)`이고 `type`에는 `CHECK`가 없다. 삭제된 이벤트 중 `(txid, id)` 순서가 가장 큰 위치를 호출처·종류별로 담는다. `JOB_CANCELED`와 `INTAKE_REJECTED`를 포함한 모든 종류가 대상이다.
- `deleteExpiredRecords`는 지울 행을 `FOR UPDATE SKIP LOCKED`로 고른 뒤, 같은 트랜잭션에서 삭제 전에 그 행의 이벤트의 호출처·종류별 최대 위치를 표지에 올리고 지운다. 표지는 줄어들지 않는다. 표지 갱신과 삭제는 함께 커밋하거나 함께 롤백한다.
- 표지 테이블의 행 수는 (삭제 이벤트가 있었던 호출처 수) × (이벤트 종류 수, 최대 5)가 상한이다. 위치를 갱신할 뿐 행을 늘리지 않으므로 정리 정책을 두지 않는다. 보존 삭제는 호출처당 갱신 1회 비용이다.
- `GET /events`는 `after`가 있을 때만 판정한다. 요청한 종류(필터가 없으면 모든 종류)의 표지 중 하나라도 `after` cursor보다 크면 공백이다. 표지가 cursor와 같거나 작으면 호출처가 이미 지나온 이벤트라 공백이 아니다. 다른 호출처의 표지는 보지 않는다. 이벤트를 읽은 뒤에 표지를 읽는다.
- 공백이면 상태 200과 응답 헤더 `Mailo-Cursor-Gap: true`를 낸다. 본문 형식은 바뀌지 않는다. 헤더는 표지가 cursor보다 큰 동안 매 응답에 붙고 `nextCursor`로 이어 읽어 cursor가 표지를 넘으면 사라진다.
- 쿼리 `onGap=error`를 보내면 공백일 때 헤더 대신 410(`cursor-expired`)이다. 본문은 고정 문구이고 cursor를 담지 않는다. `onGap`은 `error`만 받고 다른 값·반복은 400(`parameter: onGap`)이다. `after`가 없으면 판정하지 않아 `onGap=error`여도 200이다.
- 공백으로 판정한 응답마다 `event_cursor_gap`(warn)을 `callerId`만 담아 한 줄 남긴다. 헤더든 410이든 같다.
- 한계: 공백 감지 도입 전에 삭제된 이벤트, `after` 없는 읽기(cursor가 `null`인 호출처, 복구 읽기), 롤링 중 구버전 인스턴스가 지운 이벤트는 판정하지 못한다. 헤더를 모르는 호출처는 알지 못한다.

**수용 조건:**

- [x] 마이그레이션 `0009`가 `0001`~`0008` 위에서 적용되고 재실행해도 다시 적용되지 않으며 기존 작업 행을 바꾸지 않는다. `(caller_id, type)`이 기본키다.
- [x] `deleteExpiredRecords`가 삭제한 이벤트의 호출처·종류별 최대 `(txid, id)`를 표지에 올린다. 작업 삭제와 거부 기록 삭제(`INTAKE_REJECTED`) 모두, `JOB_CANCELED` 포함. 보존 기간 안의 작업과 삭제 대상이 없는 호출처는 표지가 없다.
- [x] 표지는 줄어들지 않는다. 나중에 더 앞 위치가 삭제돼도 값이 유지된다. 반복 삭제에도 행 수가 호출처×종류 수를 넘지 않는다. 배치 크기보다 많이 지워도 표지가 전체의 최대 위치까지 오른다.
- [x] 표지 갱신이 실패하면 삭제도 롤백하고 삭제가 실패하면 표지 갱신도 롤백한다.
- [x] 판정 경계: cursor가 표지와 같으면 공백이 아니고, 앞이면 공백이며, 뒤이면 공백이 아니다. 표지가 없으면 공백이 아니다. 다른 호출처의 삭제는 공백이 아니다. `type` 필터는 요청한 종류의 표지만 본다(필터 없음은 모든 종류). `JOB_CANCELED`·`INTAKE_REJECTED` 삭제도 각 종류의 공백이다.
- [x] REST: 공백이면 200과 `Mailo-Cursor-Gap: true`이고 본문 키는 `events`·`nextCursor`·`hasMore`뿐이다. 공백이 아니면 헤더가 없다. `after` 없는 읽기는 판정하지 않는다. `onGap=error`는 공백일 때 410 `cursor-expired`이고 공백이 아니면 200이다. `onGap`의 다른 값과 반복은 400이다. `nextCursor`로 이어 읽어 표지를 넘으면 헤더가 사라진다.
- [x] `event_cursor_gap`(warn)이 공백 응답마다 `callerId`만 담아 남고, 공백이 아닌 응답에는 남지 않는다. 응답·로그에 cursor 값과 수신자 canary가 없다.
- [ ] 롤링 배포(구·신 혼용)와 롤백을 실행해 구버전이 지운 이벤트가 공백 감지에서 빠지는 동작과 문서 절차를 확인한다.
- [ ] 보존 삭제와 `GET /events`가 동시에 실행될 때(두 조회 사이에 삭제가 커밋되는 경우) 신호가 누락되지 않음을 확인한다. 이벤트를 읽은 뒤 표지를 읽는 순서로 구현했고 이 순서는 오탐 쪽으로만 틀린다는 추론은 동시 실행으로 확인하지 않았다.

**판정 근거:**

- `db/event-purges.integration-spec.ts`(PostgreSQL): `0009` 적용(0001~0008 위)·재실행·기본키·전체 폴더 적용.
- `events/event-purges.integration-spec.ts`(PostgreSQL): 표지 기록(호출처·종류별 최대, `JOB_CANCELED`·`INTAKE_REJECTED`, 줄어들지 않음, 행 수 상한, 배치 크기 2로 반복 삭제), 원자성 2방향(표지 테이블·작업 테이블에 실패 트리거), 판정 경계(같음·앞·뒤, 표지 없음, 호출처 격리, `type` 필터, cursor가 표지를 넘음).
- `http/rest-event-gap.integration-spec.ts`(PostgreSQL, 실제 앱): 헤더·본문, 410, `onGap` 입력 검증, `after` 없음, `type` 필터별 판정, 호출처 격리, 이어 읽기, 로그 필드 집합, 값 비노출.
- RED 확인(2026-11-24): 구현 전 `events/event-purges.integration-spec.ts`는 `hasEventGap` export가 없어 모듈 로드가 실패했고, `http/rest-event-gap.integration-spec.ts`는 10건 중 8건이 실패했다.
- 쿼리 비용(로컬 PostgreSQL 17, 임시 schema, 작업 20만·이벤트 20만건, 호출처 20개, `EXPLAIN (ANALYZE, BUFFERS)` 1회 측정): 1000건 배치에서 표지 갱신(`mail_events_job_idx` 비트맵 스캔 + 정렬 + `ON CONFLICT`)은 실행 2.2ms, 20행 갱신이었다. 같은 배치의 작업 삭제(cascade 트리거 포함)는 21.6ms였다. 판정 쿼리는 기본키 비트맵 스캔이고 실행 0.021ms다. 운영 크기·동시 부하는 측정하지 않았다.
- 구현: `events/purge-marks.ts`(`recordPurgedJobEvents`·`recordPurgedRejectionEvents`·`hasEventGap`), `queue/maintenance.ts`의 `deleteExpiredRecords`, `intake/intake.service.ts`·`intake.controller.ts`·`query-params.ts`, `http/problem.ts`, 마이그레이션 `0009`.
- 샘플 e2e(`samples/spring-boot-relay/verify/run-e2e.sh`의 S16, 실제 Mailo 서버가 보존 삭제 뒤 헤더·410을 내고 샘플이 등록됨 행을 확인 필요로 둠)는 스크립트 검증이라 `[x]` 근거에 쓰지 않았다. 결과는 검증 수치 줄에 적는다.
- 남은 미검증: 롤링 배포·롤백 실행, 보존 삭제와 조회의 동시 실행, 실제 30일 경과(DB 시각을 당겨 만든 데이터만 확인), 운영 크기에서 삭제 배치 비용.

### RQ-046 호출처별 수신 도메인 허용 목록

- [x] **진행 상태:** 검증 완료 (6단계 묶음 C)

**요구사항:**

- 호출처 레지스트리의 선택 필드 `allowedRecipientDomains`는 소문자 ASCII 도메인 문자열 배열이다(1~50개). 생략하면 수신자를 제한하지 않는다(ADR-0011 결정 8). 마이그레이션은 없다.
- 기동 때 검사한다. 접수 검증과 같은 도메인 규칙(`validation`의 `checkDomain`: ASCII 영숫자·`-` 라벨, 라벨 수 2 이상, 마지막 라벨이 숫자뿐이 아님, 라벨 63자 이하)에 더해 다음을 거부한다: 대문자, 비ASCII(U-label), 끝 점, `*`, 선행 `.`, 목록 안의 중복, 빈 배열, `null`, 배열이 아닌 값, 문자열이 아닌 원소, 51개 이상. 오류 메시지는 항목 위치(`callers[i].allowedRecipientDomains[j]`)와 고정 사유만 담고 값은 담지 않는다(RQ-027). 선행 `.`와 `*`를 거부해 하위 도메인 문법을 나중에 넣을 자리를 남긴다.
- 판정은 `to`·`cc`·`bcc`의 모든 주소에서 `@` 뒤를 소문자로 바꿔 목록과 정확히 비교한다. 하위 도메인은 따로 적는다. 와일드카드는 없다. `replyTo`는 수신자가 아니라 제한하지 않는다. 지문 범위에 넣지 않는다(요청 내용이 아니라 호출처 정책이다).
- 하나라도 어기면 요청 전체를 거부한다(부분 등록 없음). REST는 400 `validation-failed`이고 `errors`에 어긴 주소마다 위치(`/to/0`, `/cc/1`, `/bcc/0`)와 `code: RECIPIENT_DOMAIN_NOT_ALLOWED`를 넣는다. 발신 주소 위반(`FROM_NOT_ALLOWED`)과 함께 있으면 모두 담는다. 파일 채널은 `VALIDATION_FAILED` 수집 거부이고 새 거부 사유 코드는 없다. 주소와 도메인 값은 응답·로그·거부 기록·이벤트에 넣지 않는다(RQ-027). `ValidationErrorCode`와 openapi 검증 오류 코드 enum에 `RECIPIENT_DOMAIN_NOT_ALLOWED`를 더한다.
- 검사 위치와 순서는 `allowedFrom`과 같다. REST와 파일 채널이 `validation`의 `checkRequestPolicy` 하나로 판정한다. 새 작업이 될 때만 거부하고 이미 등록된 Key의 재전송은 기존 작업(200)이나 409를 그대로 돌려준다(`denyNew`). 평문·암호화 모드가 같다(수신자는 평문 필드, RQ-022).
- ADR-0007 결정 7의 부분 거부(SMTP 서버가 일부 수신자를 거부하는 경우)는 발송 단계의 정책이고 이 검사와 단계가 다르다. 이 검사에서 거부된 수신자는 `rejectedRecipients`에 나오지 않는다.
- 레지스트리는 기동 때 한 번 읽으므로 변경은 재시작 뒤 반영된다(RQ-032와 같다).

**수용 조건:**

- [x] 생략하면 제한이 없다(`null`). 소문자 ASCII(A-label 포함) 1~50개는 그대로 읽는다.
- [x] 대문자·U-label·끝 점·`*`·선행 `.`·중복·빈 배열·`null`·배열이 아님·문자열이 아닌 원소·51개·도메인 형식 오류(라벨 1개, 숫자뿐인 마지막 라벨, 공백, 주소 형태)를 기동 거부한다. 사유가 항목마다 구분되고 오류 메시지에 위치만 있고 값이 없다.
- [x] `checkDomain`이 `checkAddress`와 같은 규칙을 쓴다(통과·거부 표). 63자 초과 라벨과 주소 상한 초과 도메인은 거부한다.
- [x] 판정: 대소문자 무시 정확 일치, 하위·상위·접미사만 같은 도메인 거부, A-label 일치, `to`·`cc`·`bcc` 모두 검사, 어긴 주소의 위치만 반환, 결과에 값 없음, `null`이면 제한 없음.
- [x] REST: 허용 도메인은 202이고 어기면 400 + 위치 목록 + 코드다. 수신자 하나만 어겨도 요청 전체를 거부하고 작업이 생기지 않는다. 제한이 없는 호출처는 영향이 없다. `replyTo`는 제한하지 않는다. 발신 주소 위반과 함께 있으면 둘 다 담는다.
- [x] 이미 등록된 Key의 같은 내용 재전송은 정책이 바뀐 뒤에도 200이고 다른 내용은 409이며 새 Key는 400이다.
- [x] 파일 채널: 허용 도메인은 등록하고 위반은 `VALIDATION_FAILED`로 거부하며 원본을 지운다. JWE 암호화 본문도 같다. 이미 등록된 Key의 재수집은 `duplicate`다. 제한이 없는 호출처는 영향이 없다.
- [x] 응답·로그·거부 기록·이벤트·DB에 수신자 주소와 도메인 canary가 없다(REST·파일 모두).

**판정 근거:**

- `validation/recipient-policy.spec.ts`(단위): `checkDomain`, `findDisallowedRecipients`.
- `callers/allowed-recipient-domains.spec.ts`(단위): 기동 검사 허용·거부 표와 메시지 값 비노출.
- `http/rest-recipient-domains.integration-spec.ts`(PostgreSQL, 실제 앱): REST 거부·허용·재전송·canary.
- `file-channel/recipient-domains.integration-spec.ts`(PostgreSQL, 임시 폴더): 파일 채널 거부·허용·JWE·재수집·canary.
- RED 확인(2026-11-24): 구현 전 단위 두 파일에서 20건 중 5건이 실패했고 `checkDomain`·`findDisallowedRecipients` export가 없어 한 파일은 로드가 실패했다.
- 구현: `validation/recipient-policy.ts`·`mail-request.ts`(`checkDomain`)·`error-item.ts`, `callers/registry.ts`, `intake/intake.service.ts`, `file-channel/ingest.ts`.
- 남은 미검증: 롤링 중 구버전 인스턴스의 새 필드 거부(코드 읽기 결과, 실행하지 않음), 실제 호출처의 수신 도메인 목록 조사. 한계는 허용 도메인 안의 대량 발송과 MX 확인이 없다는 점이다.

### RQ-047 운영 CLI

- [x] **진행 상태:** 검증 완료 (6단계 묶음 C)

**요구사항:**

- 같은 이미지에서 `node dist/cli.js`로 실행한다. 상주 프로세스가 아니고 DB에 접속하지 않는다. 운영 REST(`/health/ready`, `/ops/*`)를 Node의 `fetch`로 부른다. 새 npm 의존성은 없다(ADR-0011 결정 7).
- 읽기 명령: `status`(`/health/ready`와 `/ops/pauses`를 `{ready, pauses}`로 묶음), `queue stats`(`/health/ready`의 `queue`), `jobs show <jobId>`, `audit list [--limit N] [--before ID]`.
- 변경 명령: `pause`, `resume`(`--all` 또는 `--caller <호출처 ID>` 중 하나를 명시), `jobs cancel <jobId>`. `--yes`가 없으면 서버를 부르지 않고 종료 코드 1이다. 기본 범위가 없다.
- 접속: `MAILO_CLI_URL`(기본 `http://127.0.0.1:<MAILO_PORT>`, `MAILO_PORT` 기본 3000). 토큰은 `MAILO_CLI_TOKEN_FILE`(우선, 읽지 못하면 환경 변수로 넘어가지 않음) 또는 `MAILO_CLI_TOKEN`이다. 서버의 `MAILO_OPS_*` 변수는 읽지 않는다. 토큰은 명령줄 인자로 받지 않고(`--token` 등은 거부) 출력·오류에 쓰지 않는다(RQ-027).
- 출력은 서버 응답 JSON이다(성공 stdout, 오류 stderr). 종료 코드는 성공 0, 사용법·설정 오류 1, HTTP 오류 2(상태와 problem 본문을 stderr에), 연결 실패·시간 초과 3이다. 3xx는 따라가지 않고 2다. 시간 제한은 헤더 대기와 본문 읽기를 함께 덮는다. 서버 유래 문자열은 출력 전에 제어 문자(탭·줄바꿈 제외한 C0, DEL, C1)를 치환한다. 2xx인데 JSON이 아니거나 `queue stats`에 `queue`가 없으면 2다.
- `http`이고 loopback이 아닌 주소에는 평문 전송 경고를 stderr에 낸다. 쓰기가 없어 `read_only` 컨테이너에서 동작해야 한다.

**수용 조건:**

- [x] 인자 해석: 명령별 인자·옵션 검사, UUID·호출처 ID·`--limit`(1~200)·`--before` 형식 검사, 알 수 없는 명령·옵션·여분의 인자는 종료 코드 1이다. `--help`는 0이다.
- [x] 변경 명령은 `--yes`가 없으면 호출하지 않는다. `pause`·`resume`은 범위를 하나만 명시해야 한다. 읽기 명령에 `--yes`를 붙이면 거부한다.
- [x] 호출처 ID 형식 판정이 서버의 `isCallerId`와 같다.
- [x] 토큰 인자(`--token`, `--token=`, `--token-file`, `--password`)를 거부하고 환경 변수 안내만 한다. 오류 메시지에 입력 값을 되풀이하지 않는다.
- [x] 접속 주소: 기본값과 `MAILO_PORT`, `MAILO_CLI_URL` 우선·끝 슬래시·경로 접두사, 잘못된 URL(스킴·사용자 정보·형식)은 호출 없이 1이다. 토큰 파일 우선·끝 줄바꿈 제거, 파일 읽기 실패는 환경 변수로 넘어가지 않고 errno 코드만 낸다. 토큰 없음·공백·제어 문자는 1이다. `MAILO_OPS_*`는 읽지 않는다.
- [x] REST 호출: 명령별 메서드·경로, Bearer 헤더, `status` 묶음 출력, `queue stats`의 `queue` 값, `audit list` 쿼리가 맞다.
- [x] 종료 코드: HTTP 오류(401·403·404·409·503·3xx)는 2, 비 JSON 2xx는 2, 연결 실패·시간 초과는 3이고 토큰·URL이 오류에 없다.
- [x] 실제 서버·PostgreSQL 대상: 읽기 명령 출력, `--yes` 없는 변경은 서버 상태 불변, 관리 토큰의 정지·재개와 감사의 `actor`, 읽기 토큰의 변경은 2(403), 작업 조회·취소·멱등 재취소, 없는 작업 2(404), 서버 없음 3(`ECONNREFUSED`), 호출처 키는 `queue stats`가 2다.
- [x] 토큰이 CLI 출력·서버 로그·감사 행 어디에도 없다(canary).
- [x] 서버가 헤더만 보내고 본문을 멈추거나 응답하지 않으면 종료 코드 3이고 스택 트레이스가 없다(실제 로컬 HTTP 서버). 서버가 준 제어 문자(C0, DEL, C1)는 stdout·stderr 어디에서도 출력되지 않는다.

**판정 근거:**

- `cli/args.spec.ts`, `cli/run.spec.ts`(단위, 가짜 `fetch`): 인자 해석, 접속·토큰 해석, 명령별 REST 호출, 종료 코드, 토큰 비노출, 제어 문자 치환. `cli/run-timeout.spec.ts`(단위, 실제 로컬 HTTP 서버): 본문 정지·오류 본문 정지·헤더 없음의 시간 초과.
- `cli/cli.integration-spec.ts`(PostgreSQL, 실제 앱과 실제 `fetch`·토큰 파일): 위 실제 서버 조건.
- RED 확인(2026-11-24): 구현 전 `cli/args.spec.ts`·`cli/run.spec.ts`가 `src/cli/index.js`를 찾지 못해 두 파일 모두 로드에 실패했다.
- 컨테이너 확인(2026-11-24, 스크립트 검증이라 `[x]` 근거에 쓰지 않았다): 저장소 `Dockerfile`로 빌드한 이미지를 `--read-only --cap-drop ALL --security-opt no-new-privileges`와 `/tmp` tmpfs로 띄우고(`NODE_ENV=development`, 개발 DB 비밀번호 때문) 컨테이너 안에서 `node dist/cli.js`의 `status`, `queue stats`, `audit list`, `--yes` 없는 `pause`(종료 1), 읽기 토큰의 `pause --yes`(HTTP 403, 종료 2), 관리 토큰의 `pause`·`resume`(감사 2건)을 토큰 파일 마운트로 실행했다. 컨테이너 로그에 토큰이 없었다.
- 구현: `cli/args.ts`·`run.ts`·`index.ts`, 진입점 `cli.ts`. `Dockerfile`은 바꾸지 않았다(`dist/`에 `cli.js`가 포함된다).
- 남은 미검증: `docker compose exec`로의 실행, `https` 프록시 뒤 주소, 호출처 단위 일괄 취소 명령(범위 밖), 실제 Windows·macOS 셸에서의 인자 처리.

### RQ-048 결과 불명 표시와 운영자 재시도 없음

- [x] **진행 상태:** 검증 완료 (6단계 묶음 D)

**요구사항:**

- 작업 조회(`GET /jobs/{jobId}`, `GET /jobs?idempotencyKey=`, 등록 응답, 취소 응답)의 `Job`과 운영자 읽기(`GET /ops/jobs/{jobId}`, CLI `jobs show`)의 `OpsJob`은 `outcomeUncertain`(불리언)을 모든 상태에서 항상 낸다(ADR-0011 결정 5).
- `JOB_FAILED`·`JOB_EXPIRED` 이벤트는 같은 값의 `outcomeUncertain`을 항상 낸다. `JOB_SENT`·`JOB_CANCELED`·`INTAKE_REJECTED`에는 없다.
- 값은 `mail_attempts`에서 도출한다. 다음 시도가 한 건이라도 있으면 `true`다.
  - `classification = 'LEASE_EXPIRED'`(lease 회수는 전송 결과를 모른다).
  - `classification = 'TRANSIENT'`이고 `stage = 'DATA'`이고 `response_code IS NULL`(DATA 단계 타임아웃·연결 끊김, ADR-0007 결정 3).
  그 밖에는 `false`다. SMTP 응답 코드가 있는 실패, DATA 이전 단계, Mailo 내부 오류(`stage = 'WORKER'`), 시도가 없는 작업이 해당한다.
- 새 컬럼과 마이그레이션은 없다. 단건 조회는 `mail_attempts_job_idx`를 쓰는 `EXISTS`, 이벤트 피드는 한 페이지의 `JOB_FAILED`·`JOB_EXPIRED` 작업 ID를 한 쿼리로 읽는다.
- 표시만 한다. 재시도 정책(ADR-0001 결정 5, ADR-0007 결정 3)은 바꾸지 않는다. 운영자 재시도 API는 만들지 않는다. 호출처가 새 Key로 다시 제출하고 중복 발송 위험은 호출처가 판단한다.
- 수신자·본문·SMTP 응답 텍스트·Key(운영자 읽기)는 이 표시로 노출하지 않는다(RQ-027).
- `openapi.yaml`의 `Job`·`OpsJob`은 `additionalProperties: false`라 필드 추가는 호출처 계약 변경이다. 문서에 명시하고, 호출처는 모르는 필드를 무시한다(`docs/api/README.md` "호출처가 모르는 값을 만났을 때").
- 한계: 서버가 응답했지만 Mailo가 받지 못한 경우처럼 위 두 조건 밖의 불명은 잡지 못한다. 시도 이력은 작업과 함께 보존 기간(기본 30일) 뒤 지워진다.

**수용 조건:**

- [x] `LEASE_EXPIRED` 시도와 DATA 단계 응답 없는 `TRANSIENT` 시도가 있으면 `true`다. 응답 코드가 있는 `TRANSIENT`·`PERMANENT`, DATA 이전 단계, `ACCOUNT`, 내부 오류(`WORKER`), 시도 없음은 `false`다. 불확실한 시도가 한 건이라도 있으면 뒤의 시도가 확실해도 `true`다(`SENT` 포함).
- [x] 단건 조회(ID·Key·운영자)와 이벤트 일괄 조회가 같은 판정이다.
- [x] `Job`은 모든 상태에서 불리언이고(비종결 포함) 등록 응답·재전송 응답·취소 응답에도 있다. `JOB_FAILED`·`JOB_EXPIRED` 이벤트의 값이 `Job`과 같고 `JOB_SENT`·`JOB_CANCELED` 이벤트에는 없다. 한 페이지의 여러 이벤트가 작업별로 맞는 값을 받는다.
- [x] 실제 Worker와 가짜 SMTP: DATA 뒤 응답 없이 연결이 끊기면 `RETRY_WAIT`에서 `true`이고 만료 뒤 `JOB_EXPIRED` 이벤트도 `true`다. 응답 코드가 명확한 `550`은 `FAILED`에서 `false`이고 `JOB_FAILED` 이벤트도 `false`다.
- [x] 호출처 격리: 다른 호출처는 작업을 조회하지 못하고 이벤트에서도 보지 못한다.
- [x] 운영자 읽기(읽기·관리 토큰)와 CLI `jobs show`가 같은 값을 주고 Key·수신자·응답 텍스트가 없다.
- [x] canary: 시도의 응답 텍스트와 수신자 canary가 작업 조회·운영자 읽기·이벤트 응답·로그에 없다.
- [x] 운영자 재시도 경로(`/ops/jobs/{jobId}/retry` 등)가 없다(404).
- [x] 샘플은 새 필드를 무시한다. `JsonNode`로 응답을 읽고 `JOB_FAILED`의 `outcomeUncertain`을 상태 해석에 쓰지 않고 `FAILED`로 반영한다(`samples/spring-boot-relay`의 `EventFeedPollerApplyTest`, Gradle 단위 테스트). `run-e2e.sh`는 스크립트 검증이라 이 항목의 `[x]` 근거에 쓰지 않았다.

**판정 근거:**

- `queue/outcome-uncertain.integration-spec.ts`(PostgreSQL): 시도 종류별 판정 표, 단건·일괄 조회 일치, 호출처 범위.
- `http/rest-outcome-uncertain.integration-spec.ts`(PostgreSQL, 실제 앱): `Job`·이벤트·운영자 읽기의 값과 생략 규칙, 격리, canary, 재시도 경로 없음.
- `e2e/mail-flow.integration-spec.ts`(실제 Worker, 로컬 `smtp-server`): DATA 뒤 연결 끊김 `true`, 550 `false`. `cli/cli.integration-spec.ts`: `jobs show` 출력.
- RED 확인(2026-11-24): 구현 전 `queue/outcome-uncertain.integration-spec.ts`가 `findOutcomeUncertain` export가 없어 로드에 실패했고, `http/rest-outcome-uncertain.integration-spec.ts`는 13건 중 10건이 실패했다(`outcomeUncertain`이 응답에 없음).
- 구현: `queue/read.ts`(`UNCERTAIN_ATTEMPT`, `findOutcomeUncertain`), `intake/presenters.ts`, `intake/intake.service.ts`. 마이그레이션은 없다.
- 샘플 e2e(`samples/spring-boot-relay/verify/run-e2e.sh` S3, 2026-11-24, 스크립트 검증): 서버가 새 필드를 보내는 상태에서 샘플 outbox 흐름이 그대로 통과했다. `JOB_FAILED` payload의 `outcomeUncertain`이 `false`로 남고 `JOB_SENT` payload에는 없다.
- 남은 미검증: `true`가 되는 실제 Gmail 응답 경로(가짜 SMTP의 연결 끊김만 확인), 서버가 응답했지만 Mailo가 받지 못한 경우, 저장소 밖 호출처가 새 필드를 무시하는지.

## 15. 관측성: `GET /metrics`

결정은 [ADR-0012](../adr/0012-metrics-endpoint.md)다. RQ-049가 인증·응답 형식·호환성을, RQ-050이 이름·분류·라벨·시크릿 규칙을, RQ-051이 DB를 읽는 전역 gauge를, RQ-052가 인스턴스 counter·gauge를 다룬다. 알림 전송은 범위 밖이다(RQ-029). 알림 규칙은 예시로만 `docs/operations/deployment.md`에 둔다.

### RQ-049 `/metrics` 인증과 응답 형식

- [ ] **진행 상태:** 진행 중 (8단계)

**요구사항:**

- `GET /metrics`는 Prometheus 텍스트 형식(0.0.4)으로 응답한다(ADR-0012 결정 2). `Content-Type: text/plain; version=0.0.4; charset=utf-8`, `Cache-Control: no-store`다.
- 읽기 토큰(`MAILO_OPS_TOKEN`)만 200이다. 관리 토큰은 403(`forbidden`)이고 호출처 API 키·자격 없음·모르는 값은 401이다(ADR-0012 결정 1). ADR-0011 결정 1의 "관리 토큰은 읽기 권한을 포함한다"는 이 endpoint에서만 예외다.
  - `MAILO_OPS_TOKEN`이 없으면 어떤 값도 읽기 권한이 아니라 401이다. 관리 토큰만 설정돼 있으면 그 토큰은 403이다.
  - 인증은 라우트 매칭 전 미들웨어(`/metrics` 이하 모든 경로)가 먼저 하고 컨트롤러의 `MetricsReadGuard`가 같은 판정을 한 번 더 한다. `/metrics/%` 같은 경로가 인증보다 먼저 오류를 내지 않는다(ADR-0011 구현 중 확정 20과 같다).
- 인증 오류 외에는 항상 200이다. DB 수집이 실패해도 200이고 실패한 그룹의 시리즈만 빠지며 `mailo_metrics_collect_ok{group}`이 0이다(RQ-051).
- 요청 로그는 debug다. 스크레이프가 인스턴스마다 info 줄을 만들지 않는다. 토큰 값은 로그·응답에 쓰지 않는다(RQ-027).
- 호환성: 마이그레이션이 없다. 새 npm 의존성이 없다(직렬화를 직접 쓴다, ADR-0012 결정 7). `/health/ready`의 응답·판정·인증·쿼리는 바뀌지 않는다(ADR-0012 결정 9). 새 환경 변수는 `MAILO_METRICS_CACHE_SECONDS`(정수, 기본 5, 1~60) 하나다. 새 로그 이벤트는 `metrics_collect_failed`·`metrics_series_limit` 둘이다. 새 오류 `type`은 없다.
- 구버전 인스턴스는 `/metrics`가 없어 404다. 모든 인스턴스를 새 버전으로 바꾼 뒤 스크레이프 타깃에 추가한다.

**수용 조건:**

- [x] 읽기 토큰 200, 관리 토큰 403, 호출처 키·헤더 없음·모르는 값·Bearer 아닌 형식 401, `MAILO_OPS_TOKEN` 없음 401(관리 토큰만 있으면 그 토큰 403). 읽기 토큰으로 업무 endpoint를 부르면 여전히 401이다.
- [x] `/metrics/%`는 자격 없음 401·관리 토큰 403·읽기 토큰 404이고, 쿼리의 잘못된 퍼센트 인코딩은 인증 결과를 바꾸지 않는다.
- [x] 응답 헤더, 끝 개행, 모든 시리즈 줄의 형식, 지표마다 HELP·TYPE 한 번, 중복 시리즈 없음, HEAD 동작.
- [x] 직렬화: HELP·TYPE 줄, 라벨 값 이스케이프(`\`, `"`, 줄바꿈), 값 표기(`NaN`·`+Inf`·`-Inf`), 중복·카탈로그 밖 시리즈 거부.
- [x] `/metrics` 요청 로그는 debug이고 토큰 값이 로그에 없다.
- [x] `MAILO_METRICS_CACHE_SECONDS`는 1~60의 정수만 받고 생략하면 5다. 범위 밖이면 변수 이름으로 기동을 거부한다.
- [ ] 실제 Prometheus 서버가 이 응답을 스크레이프하고 `promtool check metrics`·`check rules`가 통과한다. 자동 테스트가 아니다.
- [ ] 롤링 배포 중 구·신 인스턴스 혼용(구버전 404는 코드 읽기 결과)과 롤백을 실행하지 않았다.

**판정 근거:**

- `http/metrics-auth.integration-spec.ts`(PostgreSQL, 실제 앱): 인증 행렬, 경로 디코딩 순서, 응답 형식, 요청 로그, 토큰 비노출. `metrics/serialize.spec.ts`(단위): 직렬화. `config/load-config.spec.ts`: `MAILO_METRICS_CACHE_SECONDS`.
- 컨테이너 확인(2026-11-24, 스크립트 검증이라 `[x]` 근거에 쓰지 않았다): `scripts/container/verify-metrics.sh`가 `read_only` 컨테이너에서 읽기 토큰 200·관리 토큰 403·무토큰 401·호출처 키 401과 응답 헤더를 관찰했고 `promtool check metrics`가 지적 없이 통과했다. 실제 Prometheus(`v2.55.1`)가 읽기 토큰 타깃을 스크레이프했고 관리 토큰 타깃은 403으로 `down`이었다(ADR-0012 구현 중 확정 11).
- RED 확인(2026-11-24): 구현 전 `http/metrics-auth.integration-spec.ts`는 16건 중 14건이 실패했다(`/metrics` 라우트 없음). `metrics/*.spec.ts`는 `src/metrics/index.js`를 찾지 못해 로드에 실패했다.
- 구현: `callers/bearer-auth.ts`의 `MetricsReadGuard`, `callers/ops-auth-middleware.ts`의 `createMetricsAuthMiddleware`, `health/metrics.controller.ts`, `metrics/serialize.ts`.

### RQ-050 지표 이름·분류·라벨·시크릿 규칙

- [x] **진행 상태:** 검증 완료 (8단계)

**요구사항:**

- 지표는 전역 gauge, 인스턴스 counter, 인스턴스 gauge, 프로세스(`process_*` 3개)로 나눈다. 이름·종류·분류·라벨 이름·허용 값은 `metrics/catalog.ts` 한 곳에 둔다(ADR-0012 결정 3·4).
  - 전역 지표는 gauge뿐이고 `mailo_queue_`·`mailo_breaker_`·`mailo_send_paused`·`mailo_caller_`·`mailo_ops_audit_` 접두를 쓴다. 합칠 때 `max by (...)`를 쓰고 `sum`을 쓰지 않는다.
  - counter는 인스턴스·프로세스 분류이고 이름이 `_total`로 끝난다. gauge는 `_total`로 끝나지 않는다. 시간 값은 `_seconds`다.
  - HELP 첫 단어는 "전역." 또는 "인스턴스."다. `instance` 라벨은 앱이 붙이지 않는다(Prometheus 타깃 라벨).
- 허용 라벨 이름은 `caller_id`, `account_id`, `reason`, `state`, `priority`, `result`, `stage`, `status`, `group`뿐이다(ADR-0012 결정 6). 카탈로그 밖의 라벨 이름은 기동 때 던진다.
- 값 규칙: `caller_id`는 형식을 지키고 기동 때 읽은 레지스트리에 있는 값이거나 `unregistered` 하나다. `account_id`는 단계 7 전에 `default`다. 닫힌 열거는 카탈로그의 표로 바꾸고 표 밖의 값은 `unknown`(`reason`은 `other`)으로 세거나, 대체 값이 없으면 버리고 `mailo_metrics_dropped_samples_total`에 센다.
- 지표 하나의 시리즈는 2000개까지다(추정). 넘으면 새 시리즈를 만들지 않고 `dropped_samples`를 올리며 `metrics_series_limit`(warn, 지표 이름만)을 한 번 남긴다.
- 수신자·발신 주소, 제목·본문, `Idempotency-Key`, 작업 ID, 요청 ID, lease 토큰, SMTP 응답 코드·텍스트, SMTP 사용자 주소, 파일 이름, 토큰·API 키, 오류 메시지를 라벨·값으로 쓰지 않는다(RQ-027).

**수용 조건:**

- [x] 카탈로그 전체에 이름 형식·중복 없음, 전역은 gauge, counter는 인스턴스·프로세스와 `_total`, 접두, HELP 첫 단어, `_seconds`, 허용 라벨 9개, 금지 라벨 이름 없음을 단위 테스트가 검사한다.
- [x] 카탈로그 밖의 라벨 이름 등록은 던진다. ADR-0012 결정 4의 지표 이름이 모두 있다.
- [x] counter 저장소: 같은 라벨의 증가 합산, `account_id` 기본값, `unregistered` 묶음(형식 오류 포함), 열거 fallback, fallback 없는 값·모르는 라벨 이름·gauge 이름의 폐기와 `dropped_samples`, 증가량 검증, 시리즈 상한 2000과 상한 알림 한 번.
- [x] 레지스트리 밖 호출처의 작업이 DB에 많아도 gauge의 `caller_id` 시리즈는 레지스트리 호출처뿐이다. 정지 개수에는 센다.
- [x] canary: 본문·제목·수신자·Key·SMTP 응답 텍스트·SMTP 비밀번호·작업 ID·읽기 토큰·관리 토큰·호출처 API 키가 `/metrics` 응답과 로그에 없다.

**판정 근거:**

- `metrics/catalog.spec.ts`, `metrics/store.spec.ts`(단위), `http/metrics-gauges.integration-spec.ts`의 "라벨 카디널리티"·"요청 값 비노출", `e2e/metrics-counters.integration-spec.ts`의 canary 항목(PostgreSQL, 실제 앱·Worker).
- 구현: `metrics/catalog.ts`, `metrics/store.ts`, `app.module.ts`의 `AppMetricsModule`(레지스트리와 로거 연결).

### RQ-051 전역 gauge와 DB 수집

- [ ] **진행 상태:** 진행 중 (8단계)

**요구사항:**

- 전역 gauge는 DB 상태와 DB `now()`로만 계산한다(ADR-0002 결정 10, ADR-0012 결정 5). 예외는 `mailo_caller_quota_limit`(이 인스턴스의 레지스트리 값)과 `account_id` 라벨(상수)이다.
- 값(ADR-0012 결정 4): 큐 깊이 `due`·`scheduled`·`sending`(`due`·`scheduled`는 10000에서 멈추고 `_truncated`가 1이 된다), 등급별 가장 오래 기다린 점유 가능 작업의 나이(대기가 없으면 0), 차단기 상태(원핫)와 사유, 전체·호출처 정지, 호출처 할당 한도·사용량(설정한 호출처만. 사용량 = 최근 24시간 시도 수(`LIMIT 할당`으로 한도에서 멈춘 값) + 점유 중 수라서 한도를 넘을 수 있고 비율이 1을 넘을 수 있다. `claim`의 사용량 문장과 같다), 호출처별 최신 이벤트 경과 초(이벤트가 없으면 시리즈 없음), 감사 행 수(100000에서 멈춤)·상한 도달·가장 오래된 행의 나이.
- `mailo_queue_jobs{state="due"}`는 헬스의 `queue.dueCount`와 같은 `getQueueBacklog`에서 나온다.
- 수집은 TTL 캐시(`MAILO_METRICS_CACHE_SECONDS`)와 단일 비행으로 한다. 인스턴스당 DB 조회는 TTL마다 최대 1회이고 풀 연결은 1개다. 실패한 그룹도 TTL 동안 재사용한다.
- 그룹(`queue`·`breaker`·`controls`·`quota`·`feed`·`audit`)은 연결 하나로 순차 실행하고 그룹마다 `BEGIN READ ONLY`와 `SET LOCAL statement_timeout = 2000`을 건다. 쓰기·행 잠금·advisory lock이 없어 점유·완료 경로의 잠금 순서(작업 행 → 차단기 행)에 끼지 않는다. 전체 상한은 5초다.
- 한 그룹이 실패하면 그 그룹의 시리즈만 응답에서 빼고 `collect_ok{group}`을 0으로 낸다. 연결을 얻지 못하면 모든 그룹이 0이다. `metrics_collect_failed`(warn)는 그룹 이름과 오류 이름·코드만 담고 연속 실패 동안 반복하지 않는다.
- 종결 건수는 DB로 세지 않는다(상태별 `count(*)`를 받치는 인덱스가 없다). 인스턴스 counter가 맡는다(RQ-052).

**수용 조건:**

- [x] 작업 상태별 건수(`due`·`scheduled`·`sending`, 종결 상태 제외)와 등급별 가장 오래된 대기 나이, 10001건에서 `truncated`, 정확히 10000건은 `truncated` 아님.
- [x] 헬스의 `queue.dueCount`·등급별 나이와 같은 값이다. 같은 DB를 쓰는 앱 둘의 전역 gauge가 같다(나이는 1초 오차).
- [x] 차단기 세 상태와 사유(헬스 `lastReason`과 같은 어휘, closed에서는 사유 시리즈 없음), 전체·호출처 정지(레지스트리 밖 정지 포함), 할당 한도·사용량·할당 없는 호출처 제외(사용량의 시도 쪽은 한도에서 멈추고 점유 중 수를 더하므로 사용량이 한도를 넘을 수 있다. 한도 2에서 시도 2건과 점유 중 1건이면 사용량 3, 비율 1 초과), 최신 이벤트 나이, 감사 통계(상한 100001행에서 100000과 truncated).
- [x] 동시 스크레이프 20건이 풀 연결 1회만 쓴다. TTL 안에는 DB를 다시 읽지 않고(캐시된 값) TTL 뒤에는 다시 읽는다. 수집 뒤 풀 연결이 모두 반환된다.
- [x] 수집 쿼리는 `BEGIN READ ONLY` 6회와 `SET LOCAL statement_timeout` 6회이고 `FOR UPDATE`·advisory lock·쓰기 문장이 없다.
- [x] 한 그룹의 쿼리가 실패(테이블 없음, `statement_timeout`)해도 HTTP 200이고 그 그룹만 빠지며 `collect_ok`가 0이다. 연결을 얻지 못하면 모든 그룹이 0이고 전역 gauge가 빠지지만 인스턴스 값은 나온다. 실패 로그는 한 번이고 오류 메시지·테이블 이름이 없다.
- [x] 읽기 함수는 읽기 전용 트랜잭션에서 돈다. 호출처·이벤트 대상이 비면 쿼리하지 않는다.
- [ ] 운영 크기(수백만 행)·다중 인스턴스·Prometheus 복제본 여러 개의 동시 스크레이프에서 쿼리 비용과 풀 점유(예비 연결 4개 가정)를 확인하지 않았다. 로컬 단일 측정(작업 150만 행)은 ADR-0012 구현 중 확정에 있다.

**판정 근거:**

- `http/metrics-gauges.integration-spec.ts`, `queue/metrics-reads.integration-spec.ts`(PostgreSQL). 캐시·단일 비행 테스트는 캐시나 단일 비행을 끄면 실패하는 것을 확인했다(변경 확인, 2026-11-24).
- 쿼리 비용: 임시 schema에서 `EXPLAIN (ANALYZE, BUFFERS)` 1회씩(작업 150만 행 규모까지). 결과는 ADR-0012 "구현 중 확정".
- 구현: `health/metrics-collector.ts`, `health/metrics-samples.ts`, `queue/backlog.ts`의 `getQueueDepth`, `queue/quota-usage.ts`, `events/event-store.ts`의 `getFeedLagsForCallers`, `ops/audit.ts`의 `getAuditStats`.

### RQ-052 인스턴스 counter와 gauge

- [x] **진행 상태:** 검증 완료 (8단계)

**요구사항:**

- counter는 이 프로세스가 한 일이고 재시작하면 0에서 다시 시작한다. 커밋 뒤에 올리므로 커밋과 증가 사이에 프로세스가 죽으면 그 한 건을 놓친다(ADR-0012 결정 4).
- 증가 시점(ADR-0012 결정 4·7):
  - `mailo_attempts_total{caller_id,account_id,result}`: 결과 기록이 적용됐을 때(`LEASE_LOST`로 버린 결과는 세지 않는다). `internal`은 `AttemptOutcome.internal`이 true인 결과다.
  - `mailo_attempt_errors_total{account_id,result,stage,reason}`: 실패 결과마다. `reason`은 `account`일 때만 `none`이 아니다.
  - `mailo_jobs_finished_total{caller_id,account_id,status}`: 이 인스턴스가 커밋한 종결 전이(결과 기록, 만료 sweep, lease 복구, 호출처·관리 토큰 취소). 멱등 반복 취소는 세지 않는다.
  - `mailo_claim_polls_total{result}`, `mailo_claimed_jobs_total`, `mailo_lease_recovered_total`, `mailo_file_channel_files_total{caller_id,result}`, `mailo_event_cursor_gap_total{caller_id}`.
- `queue/`는 `metrics/`를 import하지 않는다. 종결 전이를 만드는 경로는 반환 형식을 바꾸지 않고 커밋 뒤 관찰자 콜백(`sweepExpired`, `recoverExpiredLeases`, `claim`의 `onLeaseRecovered`)으로 알린다. 취소 결과는 호출처 ID를 담는다. 주입하지 않은 앱은 세지 않는다.
- 알림 규칙이 쓰는 counter는 시작할 때 0으로 미리 낸다. 시리즈가 처음 생기는 순간의 증가는 `increase()`가 놓치기 때문이다(ADR-0012 구현 중 확정 15). 대상은 `claim_polls`(3개), `lease_recovered`, 레지스트리 호출처마다 `attempts`(5개)·`finished`(4개)·`claimed_jobs`·`cursor_gap`이다. 지표당 시리즈 상한(2000) 안에서만 미리 낸다. `unregistered`, `file_channel_files`, `attempt_errors`는 미리 내지 않는다(첫 증가를 `increase()`가 놓친다).
- 인스턴스 gauge: Worker 상태(원핫)·진행 중 전송·마지막 점유 경과·연속 점유 실패·점유 루프 사망, 파일 폴러 상태, `collect_ok`, `snapshot_age`. `process_start_time_seconds`·`process_resident_memory_bytes`·`process_cpu_seconds_total`을 낸다.

**수용 조건:**

- [x] 실제 Worker와 가짜 SMTP: 성공(`sent`), 일시 오류 451(`transient`·`data`), 영구 오류 550(`permanent`·`failed`), 계정 상태 오류(`account`·`mail_from`·`daily_limit`과 차단기 gauge), 내부 오류(`internal`·`worker`), RCPT 단계 오류의 `stage`가 라벨로 나온다. 성공은 `attempt_errors`를 올리지 않는다. 종결이 아닌 실패는 `finished`를 올리지 않는다.
- [x] `claim_polls`의 `claimed`·`empty`, `claimed_jobs`가 오른다.
- [x] lease 회수(새 Worker가 회수, `RETRY_WAIT`로 돌아간 회수는 종결로 세지 않는다)와 만료 sweep(`expired`)이 오른다.
- [x] 호출처 취소와 관리 토큰 취소가 `canceled`를 올리고 멱등 반복은 올리지 않는다. 관리 토큰 취소는 작업의 호출처로 센다.
- [x] cursor 공백 감지 요청마다 `event_cursor_gap_total`이 오른다.
- [x] 파일 채널 `registered`·`duplicate`·`rejected`가 오르고 파일 이름이 라벨에 없다. 폴러 gauge가 켜짐·동작·호출처 수를 낸다.
- [x] 시작할 때 0 시리즈: 위 대상이 0으로 나오고, 레지스트리 호출처가 없으면 호출처 시리즈가 없으며, 시리즈 상한을 넘지 않고 `dropped_samples`를 올리지 않는다(호출처 400개에서 `attempts` 2000개). 미리 낸 시리즈에 증가하면 시리즈 수가 그대로다. `process_start_time_seconds`는 호출마다 같은 값이다.
- [x] 라벨 규칙: 결과·stage·reason 매핑, 모르는 stage는 `unknown`, 레지스트리 밖 호출처는 `unregistered`, `LEASE_LOST` 제외. `dropped_samples`는 정상 경로에서 0이다.
- [x] Worker·파일 폴러가 없는 앱은 `worker_state{state="disabled"}`가 1이고 `in_flight` 시리즈가 없다. `process_*` 3개가 나온다.

**판정 근거:**

- `e2e/metrics-counters.integration-spec.ts`(PostgreSQL, 실제 앱·Worker·파일 폴러·로컬 `smtp-server`), `metrics/store.spec.ts`의 0 시리즈·`health/metrics-samples.spec.ts`(`process_*`)·`worker/metrics.spec.ts`(단위), `queue/metrics-reads.integration-spec.ts`의 관찰자 항목(커밋 뒤 호출, 롤백 때 미호출, 관찰자 예외 무시).
- RED 확인(2026-11-24): 계측 전 `e2e/metrics-counters.integration-spec.ts`는 11건 모두 실패했다.
- 구현: `worker/metrics.ts`, `worker/worker.ts`, `file-channel/poller.ts`, `intake/intake.service.ts`, `ops/ops.service.ts`, `queue/transitions.ts`.
- 남은 미검증: 실제 Gmail 응답에서의 `stage`·`reason` 분포, 장시간 부하에서의 counter 정확도, 커밋과 증가 사이의 종료로 놓치는 한 건.

## 16. 다중 SMTP 계정

결정은 [ADR-0013](../adr/0013-multiple-smtp-accounts.md)이고 구현은 묶음 A(계정 모델)·B(계정 단위 점유)·C(운영 표면)·D(호출처 동시 상한, 선택)로 나눈다. RQ-053~056은 묶음 A, RQ-057~059는 묶음 B의 범위다. `/metrics`·`/health/ready`·`/ops` 계정 표면(묶음 C)과 호출처 동시 상한(묶음 D)은 이 RQ에 없고 해당 묶음을 구현할 때 RQ-060 이후로 추가한다. 계정이 `default` 하나일 때는 현행과 같은 동작이다.

### RQ-053 SMTP 계정 정의와 설정 로드

- [ ] **진행 상태:** 진행 중 (7단계 묶음 A)

**요구사항:**

- 계정은 `MAILO_SMTP_ACCOUNTS_FILE`의 JSON과 기존 `MAILO_SMTP_*`로 정의한다. `default` 계정의 출처는 정확히 하나다(ADR-0013 결정 1).
  - 파일 없음: `MAILO_SMTP_*`가 `default`를 정의한다(`MAILO_SMTP_HOST` 필수). 단일 계정 배포는 설정을 바꾸지 않는다.
  - 파일 있음, `MAILO_SMTP_HOST` 있음: `default`는 환경 변수 정의이고 파일에 `id: "default"`가 있으면 거부한다.
  - 파일 있음, `MAILO_SMTP_HOST` 없음: `default`는 파일에 있으면 그것이고 없으면 `default` 계정이 없다. 이때 `MAILO_SMTP_USER`·`PASSWORD`·`FROM`·`PORT`·`SECURITY`가 있으면 거부한다.
- 파일 형식은 호출처 레지스트리와 같은 방식이다. 값은 JSON에 두지 않고 변수 이름(`auth.secretVar`)만 둔다. 값은 `<변수>_FILE`(우선) 또는 `<변수>`로 받는다.
- 계정 ID는 `^[a-z0-9][a-z0-9_-]{0,31}$`이고 `unregistered`는 예약어다. SMTP 사용자 주소는 ID가 될 수 없다(RQ-027).
- 기동 검증: 구조·모르는 필드·ID 형식·중복, host·port·security·timeout(lease 미만), 비밀 변수 존재·형식(`MAILO_SMTP_SECRET_*`, `_FILE` 금지)·중복, `from` 형식, 같은 `(host, port, user)` 중복(인증 계정만), 계정 수 20개 이하·`MAILO_WORKER_CONCURRENCY` 이하. 오류에는 위치와 고정 사유만 담는다. host·user·from·비밀번호는 담지 않는다.
- `sendQuota24h`·`concurrency`는 로더가 형식을 검증하고 묶음 B부터 Worker가 점유에 쓴다(RQ-058). 묶음 A가 남기던 `account_limits_not_enforced` 경고는 없앴다.
- `default`가 아닌 계정도 앱이 기동한다. 묶음 A의 기동 거부(`createApp`)는 묶음 B에서 계정별 격리가 성립해 제거했다(ADR-0013 구현 중 확정 2026-11-24 묶음 B 항목 10).
- 어느 호출처도 쓰지 않는 계정은 허용하고 `account_unused`(info)를 남긴다. `security: "none"` 계정은 `smtp_plaintext_enabled`(warn)에 `accountId`를 싣는다(RQ-005).

**수용 조건:**

- [x] `default` 출처 4상태와 잔여 `MAILO_SMTP_*` 거부, 환경 변수 `default`와 파일 `default`의 중복 거부.
- [x] 계정 ID 형식(대문자·기호·길이·예약어·주소 형태 거부), 필드 규칙(포트·보안·대기 시간·`from`·`auth`), 모르는 필드, 파일 읽기·JSON 오류.
- [x] 비밀 변수: 없음, `_FILE` 우선, `_FILE` 읽기 실패는 환경 변수로 돌아가지 않음, 두 계정의 같은 변수, 접두사·`_FILE` 형식 오류.
- [x] 같은 `(host, port, user)`(대소문자 무시, 환경 변수 `default`와도) 거부. 계정 수 상한 20과 `MAILO_WORKER_CONCURRENCY`.
- [x] 오류 메시지에 host·user·비밀번호가 없다. 비밀번호는 `Secret`이라 설정 객체의 `inspect`·`JSON.stringify`에 나오지 않는다.
- [x] 기존 단일 계정 설정(`MAILO_SMTP_*`만)은 `default` 하나로 기존과 같은 값을 만든다.
- [ ] 읽기 전용 루트 컨테이너에서 계정 파일 마운트와 `_FILE` 비밀 읽기를 실행하지 않았다.
- [ ] 실제 Gmail·Workspace 계정 둘 이상으로 인증·전송을 확인하지 않았다.

**판정 근거:**

- `config/smtp-accounts.spec.ts`(단위, 임시 파일), `config/load-config.spec.ts`(기존 단일 계정 값), `worker/account-startup.spec.ts`(기동 점검 로그와 값 비노출).
- RED 확인(2026-11-24): 로더는 구현 뒤에 테스트를 썼으므로 구현 전 실패 기록이 없다. 대신 `default` 중복 검사와 예약어 검사를 일시적으로 끈 변이에서 3건이 실패했다(테스트가 규칙을 고정한다는 확인, 변이는 되돌렸다).
- 구현: `config/smtp-accounts.ts`, `config/load-config.ts`, `worker/account-report.ts`.
- 남은 미검증: 위 두 항목, 계정 수 상한 20(추정), 계정 파일 변경의 핫 리로드 없음(재시작 필요).

### RQ-054 호출처의 계정과 등록 때 계정 고정

- [ ] **진행 상태:** 진행 중 (7단계 묶음 A)

**요구사항:**

- 호출처 레지스트리의 선택 필드 `accountId`가 호출처의 계정 하나를 가리킨다. 생략하면 `default`다. 형식은 계정 ID 규칙이고 구성에 없는 ID이거나 `default` 계정이 없는데 생략하면 기동을 거부한다(ADR-0013 결정 2). 오류에 계정 목록을 싣지 않는다.
- 작업은 등록 때 `mail_jobs.account_id`로 계정을 고정한다. 어떤 SQL도 이 컬럼을 `UPDATE`하지 않는다. 시도 기록(`mail_attempts.account_id`)은 작업 행의 값을 복사한다. 계정 변경·재라우팅·failover는 없다.
- 같은 Key의 재전송은 기존 작업의 계정을 바꾸지 않는다. 지문은 계정을 포함하지 않는다(매핑이 바뀐 뒤의 재전송이 409가 되면 안 된다).
- 마이그레이션 `0010`(`mail_jobs`)·`0011`(`mail_attempts`): `ADD COLUMN account_id text NOT NULL DEFAULT 'default'`와 `NOT VALID` CHECK(`^[a-z0-9][a-z0-9_-]{0,31}$`). 백필이 없고 표를 다시 쓰지 않는다. 기존 행은 `default`로 보이고 컬럼 없이 쓰는 구버전의 `INSERT`도 `default`가 된다.
- `claim`은 계정 하나(`accountId`)의 작업만 점유한다(RQ-057). 구성에서 빠진 계정의 작업은 어느 `claim`도 점유하지 않아 전송되지 않고 다른 계정으로 옮겨지지 않으며 만료 sweep이 `EXPIRED`(`JOB_EXPIRED`)로 만든다. 기동 때 구성 밖 계정의 비종결 작업이 있으면 `account_orphan_jobs`(warn, `accountId`, `count`)를 남긴다.
- `completeAttempt`는 작업 행의 `account_id`로 차단기 행을 정한다(키는 계정 ID). 기동 때 구성한 계정마다 차단기 행을 `INSERT ... ON CONFLICT DO NOTHING`으로 만들고 실패하면 Worker를 시작하지 않는다. 내부 오류(`internal: true`)는 어느 계정의 차단기도 건드리지 않는다. half_open 대표 작업은 차단기 계정의 작업만 고른다.
- 호출처는 계정을 고르지도 알지도 못한다. 요청에 계정 필드가 없고(모르는 필드 `UNKNOWN_FIELD`) `Job`·`Event`·거부 기록·검증 오류에 계정 필드가 없다.

**수용 조건:**

- [x] 레지스트리 `accountId`: 생략은 `default`, 구성에 없는 ID·`default` 없는 생략·형식 오류는 기동 거부, 오류에 계정 목록이 없다. 파일 채널·REST 모두 앱 기동 단계에서 거부한다.
- [x] `register`가 `account_id`를 쓴다. 같은 Key의 다른 계정 재등록은 `duplicate`이고 기존 계정이 그대로다. 형식이 틀린 값은 DB가 23514로 거부한다.
- [x] 등록된 작업의 계정은 레지스트리 변경 뒤에도 그대로이고 새 요청만 새 매핑을 따른다(실제 앱 재기동으로 확인).
- [x] 구성 밖 계정의 작업은 `claim`이 점유하지 않고 상태를 바꾸지 않으며 만료 sweep이 `EXPIRED`로 만든다. `account_orphan_jobs`가 한 줄 남는다. 전송되지 않는다.
- [x] 차단기 행의 갱신: 계정 상태 오류 3회는 작업 계정의 행만 `open`으로 바꾸고(open 전이까지) `default` 행은 그대로다. `SENT`는 작업 계정의 연속 실패를 0으로 만들고, 내부 오류는 건드리지 않는다. half_open 대표 작업은 차단기 계정의 작업만 고른다. 기동 때 행이 만들어지고 실패하면 `start()`가 거부된다.
- [x] `default`가 아닌 계정의 차단기가 `open`인 동안 그 계정의 작업이 점유되지 않고, open → half_open → closed 전이가 계정 행에서 일어나며, open 뒤(`open_until`이 지난 open 포함) 계정 상태 오류의 `next_attempt_at`이 과거로 기록되지 않는다(묶음 B, RQ-057).
- [x] 시도 기록(성공·lease 만료 회수 포함)이 작업의 `account_id`를 복사한다.
- [x] 마이그레이션 `0010`·`0011`: 0001~0009 위에 적용, 재실행은 아무것도 적용하지 않음, 기존 행이 `default`, `relfilenode` 불변, `NOT VALID` 제약, 컬럼 없는 `INSERT`가 `default`, 형식 위반 23514.
- [x] `src/`의 SQL 문자열이 `account_id`를 `SET`하지 않고 `mail_jobs`·`mail_attempts` `INSERT`가 `account_id`를 열거한다. `src/`에 `SELECT *`·`RETURNING *`가 없다(정적 검사).
- [x] 호출처 응답에 계정 필드·값이 없고 요청의 계정 필드는 `UNKNOWN_FIELD`다.
- [ ] 롤링 배포(구·신 혼용)와 롤백을 실행하지 않았다. 구버전이 `accountId`를 거부해 기동하지 못한다는 점과 컬럼을 무시한다는 점은 코드 읽기 결과다(컬럼 없는 `INSERT`만 통합 테스트로 확인).
- [ ] 대용량 테이블·동시 쓰기에서 `0010`·`0011`의 `ACCESS EXCLUSIVE` 잠금 대기를 측정하지 않았다(ADR-0013 측정은 150만 행 단일 실행 1.2ms).
- [ ] 저장소 밖 호출처가 `accountId` 도입에 영향받지 않는지 확인하지 않았다(계약 변경은 없다).

**판정 근거:**

- `callers/account-id.spec.ts`(단위), `db/account-id-migration.integration-spec.ts`·`queue/account-id.integration-spec.ts`(PostgreSQL), `queue/account-id-sql.spec.ts`(정적 검사), `e2e/multi-account.integration-spec.ts`·`file-channel/account-id.integration-spec.ts`(실제 앱·Worker·파일 폴러·로컬 `smtp-server`).
- RED 확인(2026-11-24): `callers/account-id.spec.ts`는 구현 전 `accountId`가 모르는 필드라 거부됐고, `db/account-id-migration.integration-spec.ts`는 0010 파일이 없어 `ENOENT`로 실패했으며, `queue/account-id.integration-spec.ts`는 `ensureBreakerRows` export가 없어 로드에 실패했다. Worker가 모든 작업을 `default` 발송기로 보내게 바꾼 변이에서 `e2e/multi-account.integration-spec.ts`(그 시점 11건) 중 4건이 실패했다(변이는 되돌렸다).
- 구현: `callers/registry.ts`, `queue/register.ts`·`claim.ts`·`complete.ts`·`circuit-breaker.ts`(`ensureBreakerRows`)·`backlog.ts`(`countOrphanAccountJobs`), `migrations/0010_job_account_id.sql`·`0011_attempt_account_id.sql`, `worker/runner.ts`.
- 남은 미검증: 위 세 항목. 묶음 A의 한계(`claim`이 모드를 `default` 차단기 하나로 정함, `account_id` 인덱스 없음)는 묶음 B에서 없앴다(RQ-057·059, ADR-0013 구현 중 확정 2026-11-24 묶음 B).

### RQ-055 계정별 SMTP 전송과 발신 주소 허용 집합

- [ ] **진행 상태:** 진행 중 (7단계 묶음 A)

**요구사항:**

- 작업은 자기 `account_id`의 SMTP 서버·자격증명·발신 주소로 전송한다. `MAIL FROM`, 인증, `Message-ID` 도메인은 작업 계정의 것이다(ADR-0013 결정 2, ADR-0007 결정 8). 요청이 `from`을 생략하면 작업 계정의 `from`으로 채운다.
- 호출처의 허용 발신 주소 집합은 `{호출처 계정의 from} ∪ allowedFrom`이다(ADR-0013 결정 6). 다른 계정의 `from`은 `allowedFrom`에 없으면 거부한다(REST 400 `FROM_NOT_ALLOWED`, 파일 `VALIDATION_FAILED`). `validation/`의 `isSenderAllowed`·`checkRequestPolicy`는 바꾸지 않고 호출 쪽(`IntakeService`·파일 채널 `ingest`)이 계정의 `from`을 넘긴다.
- `allowedFrom`이 다른 계정의 `from`과 같으면 기동 때 `allowed_from_other_account`(warn, `callerId`)를 남긴다. 거부하지 않는다. 계정 단위 `sendAs`는 보류한다(Gmail send-as 동작 미확인).
- 이미 등록된 Key의 재전송은 호출처의 계정을 바꾼 뒤에도 기존 작업(200)이나 409를 그대로 돌려준다(ADR-0011 구현 중 확정 27).
- Worker가 점유한 작업의 계정 발송기가 없으면 `internal: true`로 끝낸다(차단기를 건드리지 않고 독성 작업 규칙을 따른다). `claim`이 구성한 계정만 점유하므로 정상 경로에서는 일어나지 않는다.
- 기존 단일 계정 설정은 계정 `default` 하나이고 발신 주소 집합이 이전과 같다(`MAILO_SMTP_FROM`에 `allowedFrom`을 더한 값).

**수용 조건:**

- [x] 가짜 SMTP 서버 둘에서 `default` 계정 작업은 서버 A로, 파일 계정 `marketing` 작업은 서버 B로 간다. 서버마다 `MAIL FROM`, 인증 사용자·비밀번호, `Message-ID` 도메인이 작업 계정 것이고 다른 서버로 가지 않는다.
- [x] `from`을 생략한 작업이 계정마다 다른 기본 발신 주소로 나간다.
- [x] REST: 호출처 계정의 `from`은 202, 다른 계정의 `from`은 400 `FROM_NOT_ALLOWED`이고 응답에 주소가 없다. `allowedFrom`은 계정 `from`에 더해 허용된다. 호출처의 계정을 바꾼 뒤 이미 등록된 Key의 재전송은 200이다.
- [x] 파일 채널: 같은 판정이다. 계정 `from`은 등록하고 다른 계정의 `from`은 `VALIDATION_FAILED`로 거부하며 거부 기록에 주소가 없다. `from` 생략은 등록된다.
- [x] `allowedFrom`의 다른 계정 `from` 경고와 호출처 자기 계정 `from`의 비경고.
- [x] Worker 조립: `accounts`와 단일 계정 형태의 동시 지정·계정 없음은 던진다. 기존 단일 계정 테스트(`sender`·`defaultFrom`)는 그대로 통과한다.
- [ ] 계정 발송기가 없는 점유 작업의 `internal` 종료 경로는 테스트하지 않았다(`claim`이 구성 계정만 점유해 만들 수 없다).
- [ ] 실제 Gmail에서 `allowedFrom` 주소가 send-as 별칭이어야 `From`이 유지되는지, 계정마다 다른 한도·IP 정책을 확인하지 않았다.

**판정 근거:**

- `e2e/multi-account.integration-spec.ts`(실제 앱·Worker·로컬 `smtp-server` 둘), `file-channel/account-id.integration-spec.ts`, `worker/account-startup.spec.ts`. 기존 `worker/*.integration-spec.ts`·`http/rest-intake.integration-spec.ts`가 단일 계정 동작 불변을 확인한다.
- 구현: `worker/worker.ts`(`accounts`), `worker/runner.ts`(`toSenderConfig`·계정별 발송기), `intake/intake.service.ts`, `file-channel/ingest.ts`·`poller.ts`, `envelope/register-input.ts`.
- 남은 미검증: 위 두 항목.

### RQ-056 계정 모델의 배포 호환성과 시크릿 비노출

- [ ] **진행 상태:** 진행 중 (7단계 묶음 A)

**요구사항:**

- 배포 순서: (1) `0010`·`0011` 적용 (2) 모든 인스턴스를 새 버전으로 (3) 계정 파일·비밀 변수 배포와 재시작 (4) 레지스트리에 `accountId`를 넣고 재시작. 4는 모든 인스턴스가 3을 마친 뒤에만 한다("코드 먼저, 레지스트리 나중", ADR-0013 결정 2). 이 단계가 끝나기 전에 `default`가 아닌 계정의 작업이 생기면 구버전이 `default` SMTP로 보낸다. 롤백은 레지스트리의 `accountId` 제거, 비`default` 비종결 작업 0 확인, 앱 되돌림 순서다. 절차는 `docs/operations/deployment.md` "SMTP 계정 도입 배포 순서"다.
- 계정 비밀번호·`auth.user`·host·`from`은 로그·오류·이벤트·지표·`/health/ready`·`/ops`·거부 기록에 남기지 않는다(RQ-027, ADR-0013 결정 6). 로그에는 계정 ID, 호출처 ID, 건수만 쓴다. 비밀번호는 `Secret`으로 감싼다.
- 묶음 A·B는 `/metrics`·`/health/ready`·`/ops`의 응답 모양을 바꾸지 않는다(`account_id` 라벨은 `default` 상수 그대로, 묶음 C). `queue.dueCount`의 값만 계정별 합이 된다(계정이 하나면 같다, RQ-059). 호출처 API 계약(`openapi.yaml`)의 필드는 바뀌지 않는다.
- 새 npm 의존성이 없고 새 상시 서비스가 없다(RQ-029).

**수용 조건:**

- [x] canary 검증: 계정 비밀번호·`auth.user`가 가짜 SMTP로 실제 전송된 상태에서 로그, `/health/ready`(공개·호출처 키·운영자 토큰), `/metrics`, 오류 응답에 없다.
- [x] 설정 오류 메시지에 host·user·비밀번호가 없다. 설정 객체의 `inspect`·`JSON.stringify`에도 없다.
- [x] 기동 점검 로그(`account_unused`·`allowed_from_other_account`)에 host·from 값이 없다. 묶음 B의 로그(`account_quota_exceeded`·`account_quota_recovered`·`claim_failed`·`send_paused`)는 계정 ID·한도 수치·건수만 싣는다(RQ-058, 수신자 주소 canary 검색).
- [x] 기존 단일 계정 환경에서 기존 단위·통합 테스트가 통과한다(변경은 설정 접근자 `config.smtp`→`config.smtpAccounts`와 픽스처의 `accountId` 필드뿐이다. 단언을 약화하지 않았다).
- [ ] 롤링 배포·롤백 실행, 읽기 전용 루트 컨테이너에서 계정 파일 마운트와 `_FILE` 비밀 읽기를 실행하지 않았다.
- [ ] `/ops`·CLI·감사의 계정 비노출은 해당 표면이 묶음 C에 있어 확인하지 않았다.

**판정 근거:**

- `e2e/multi-account.integration-spec.ts`의 시크릿 비노출 테스트, `config/smtp-accounts.spec.ts`, `worker/account-startup.spec.ts`, 전체 단위·통합 테스트.
- 문서: `docs/operations/deployment.md`·`key-management.md`·`caller-onboarding.md`·`troubleshooting.md`, `.env.example`, `docker-compose.yml`(계정 파일 마운트 주석).
- 남은 미검증: 위 두 항목.

### RQ-057 계정 단위 점유와 차단기·정지 격리

- [ ] **진행 상태:** 진행 중 (7단계 묶음 B)

**요구사항:**

- `claim`은 계정 하나(`accountId`)만 다룬다. 차단기 행(키는 계정 ID)·모드(closed·open·half_open)·대표 작업·정지가 계정마다 독립이다. 한 계정의 `open`은 다른 계정의 점유를 막지 않는다(ADR-0013 결정 3 가·나).
- 호출 순서는 차단기 행 읽기 → 정지 읽기 → 모드 결정 → (none이면 종료) → 계정 할당(RQ-058) → 호출처 할당(RQ-032) → 작업 쿼리다. 작업 쿼리는 `account_id = $n` 조건과 계정 부분 인덱스를 쓴다(RQ-059). lease 복구는 poll 라운드마다 한 번이다(`recoverLeases`).
- 대표 작업은 그 계정의 작업만 고른다. 내부 오류(`internal: true`)로 끝난 대표 작업은 그 계정을 닫지 않는다. 임계값·대기 시간은 모든 계정이 공유하는 `MAILO_BREAKER_*` 값이다.
- 계정 정지(`mail_send_controls`의 `account` 범위 행)는 그 계정의 점유를 멈춘다(대표 작업 포함). 정지는 차단기와 독립이다. 전체 정지·호출처 정지와 합쳐진다. 정지를 쓰고 지우는 REST·CLI·감사는 묶음 C다.
- 계정 상태 오류의 재시도 시각(`next_attempt_at`)은 차단기가 open이고 `open_until`이 미래일 때만 `open_until`이다. 그 밖은 사유별 초기 대기 뒤다. 과거로 기록하지 않는다.
- 잠금 순서는 작업 행 → 차단기 행이다. `claim`과 `completeAttempt`는 트랜잭션당 차단기 행을 하나만 갱신한다. advisory lock은 `try`뿐이다. 시각은 DB `now()`다.
- 계정이 하나(`default`)일 때 `claim` 한 번의 문장 수는 묶음 A와 같다.

**수용 조건:**

- [x] 계정 A의 차단기 `open`이 계정 B의 점유를 막지 않고 반대도 같다(`default`↔`marketing`). 대기 시간이 남은 open 계정의 `claim`은 빈 배열이다.
- [x] 비`default` 계정의 open → half_open(대표 작업 하나, 진행 중에는 다른 점유 없음) → 대표 `SENT`로 closed 전이, 대표 실패로 open 복귀와 대기 2배. 다른 계정의 차단기 행은 그대로다. 대표 작업은 그 계정의 작업만 고른다.
- [x] 내부 오류로 끝난 대표 작업은 그 계정의 half_open을 유지한다.
- [x] 재시도 시각: 차단기를 연 계정 오류의 `next_attempt_at`은 미래이고, `open_until`이 지난 open에서 늦게 도착한 계정 오류도 미래다(비`default`와 `default` 모두). 같은 작업을 곧바로 다시 점유하지 못한다.
- [x] 계정 정지: 정지한 계정만 점유가 멈추고 대표 작업도 점유하지 않는다. 정지를 풀어도 차단기 상태는 그대로이고 다음 점유가 대표 작업이다. 전체 정지는 모든 계정을 멈춘다. Worker는 상태가 바뀔 때 `send_paused`·`send_resumed`를 `scope: "account"`로 한 번씩 남긴다.
- [x] 구성 밖 계정의 작업은 어떤 계정의 `claim`도 점유하지 않는다. 차단기 행이 없는 계정의 `claim`은 던진다.
- [x] 계정이 하나일 때 `claim`의 문장 수가 묶음 A와 같다(closed 8, 호출처 할당 하나 10, open 대기 7, 전체 정지 7, 대표 작업 10).
- [x] 앱 단위 e2e: 한 계정의 SMTP 인증 오류로 그 계정의 차단기만 열리고 다른 계정의 호출처는 계속 발송한다. 복구되면 대표 작업이 닫고 남은 작업이 나간다.
- [x] 한 계정의 `claim`이 계속 실패해도 다른 계정은 발송하고 실패한 계정은 지수 백오프한다. 로그 `claim_failed`에 `accountId`가 있다.
- [ ] 다중 인스턴스(4개 이상) 동시 부하에서 계정별 점유 경합과 풀 점유, 롤링 배포 중 구·신 혼용을 확인하지 않았다.
- [ ] 대표 작업 쿼리는 계정의 대기 건수에 비례한다(로컬 단일 측정, 대기 12만 건 계정에서 64.6ms, open 대기가 끝날 때 한 번). 묶음 B는 이 쿼리를 바꾸지 않았고 운영 크기·동시 부하는 측정하지 않았다.

**판정 근거:**

- `queue/account-claim.integration-spec.ts`, `queue/claim-query-count.integration-spec.ts`, `queue/account-id.integration-spec.ts`, `worker/worker-accounts.integration-spec.ts`, `e2e/multi-account.integration-spec.ts`(실제 PostgreSQL, 로컬 `smtp-server`).
- RED 확인(2026-11-24): `queue/account-claim.integration-spec.ts`는 구현 전 27건 중 24건 실패했다(`claim`이 `accountId`를 몰라 계정 조건이 없었고, `open_until`이 지난 open에서의 계정 오류가 `next_attempt_at`을 과거로 썼다). `e2e/multi-account.integration-spec.ts`는 기동 거부를 제거하기 전 17건 중 16건 실패했다.
- 구현: `queue/claim.ts`·`complete.ts`·`send-controls.ts`, `worker/worker.ts`.
- 남은 미검증: 위 두 항목, 계정 정지의 REST·CLI(묶음 C)와 `/health/ready`·`/metrics` 반영.

### RQ-058 계정 24시간 할당과 슬롯 배분

- [ ] **진행 상태:** 진행 중 (7단계 묶음 B)

**요구사항:**

- `sendQuota24h`가 있는 계정은 호출처 할당(RQ-032)과 같은 정의로 센다. 사용량은 그 계정의 최근 24시간 "할당에 드는 시도"(`counted`이고 `stage`가 `WORKER`가 아님, `mail_attempts.account_id`)와 `SENDING` 수다. 점유 전에 계정 advisory lock(`pg_try_advisory_xact_lock`, 클래스 7364224, `hashtext(account_id)`)을 잡고 못 잡으면 이번 점유를 건너뛴다. 남은 건수가 0 이하면 모드를 none으로 하고 호출처 할당 계산을 건너뛴다. 남았으면 점유 건수를 `min(남은 건수, limit)`로 줄이고 호출처 할당은 기존대로 호출처마다 자른다. 단위는 메시지 시도 수이고 수신자 수로 가중하지 않는다(ADR-0013 결정 3 라).
- 상태가 바뀔 때만 `account_quota_exceeded`(warn, `accountId`, `limit`)·`account_quota_recovered`(info, `accountId`)를 남긴다.
- Worker는 전체 동시성 C를 계정에 나눈다. 계정별 상한 `cap_a`는 `concurrency` 또는 `max(1, C − (N − 1))`이다. poll 라운드마다 계정 순서의 시작점을 무작위로 돌리고 `limit = min(cap_a − 진행 중, 남은 전체 슬롯)`로 계정마다 `claim`을 부른다. 상한은 인스턴스별이다(ADR-0013 결정 3 바).
- 한 계정의 `claim` 오류는 그 계정만 지수 백오프한다. 다른 계정은 계속 점유한다.
- 기동 검사: 계정 수 N > `MAILO_WORKER_CONCURRENCY`이면 거부한다(설정 로더와 `createWorker`). 계정의 `concurrency`가 1~C가 아니거나 `sendQuota24h`가 양의 정수가 아니거나, 계정 할당이 있는데 시도 기록 보존이 24시간 미만이면 `createWorker`가 거부한다.

**수용 조건:**

- [x] 순수 함수: `cap_a` 기본식(C=4, N=1~4 등)과 계정 `concurrency`, `limit = min(cap_a − 진행 중, 남은 전체 슬롯)`와 0일 때 호출하지 않음, 순서 회전(원본 불변).
- [x] 한 계정의 SMTP가 응답하지 않아도(지연 전송) 그 계정은 `cap_a`(C=4, N=2에서 3)개까지만 슬롯을 쥐고 다른 계정의 작업은 계속 나간다. 계정 `concurrency: 1`이면 한 건씩 나간다. 다른 계정이 비어도 `cap_a`를 넘지 않는다.
- [x] 계정 24시간 할당: 사용량만큼 점유 건수가 준다. 한도에 닿으면 점유하지 않고(대표 작업 포함) 알린다. 한도에 걸린 계정이 다른 계정을 막지 않는다. 내부 오류(`WORKER`)·`counted=false`·24시간 지난 시도·다른 계정의 시도는 사용량에 들지 않는다. 호출처 할당과 겹치면 더 작은 쪽이다. 한도가 없으면 사용량을 읽지 않는다.
- [x] 인스턴스 12개 동시 점유에서 계정 한도를 넘지 않는다(초과 0건, 3라운드 + 순차 채움 뒤 정확히 한도).
- [x] Worker: 한도를 넘긴 계정은 한도까지만 발송하고 나머지는 대기하며 다른 계정은 영향이 없다. 로그는 상태가 바뀔 때만 한 번이고 수신자 주소가 없다. 윈도우가 지나면 다시 발송하고 `account_quota_recovered`를 남긴다.
- [x] 기동 검사: 계정 수 > C, 계정 `concurrency` > C, 보존 < 24시간(계정 할당 있음)은 `createWorker`가 거부한다.
- [x] lease 복구는 poll 라운드마다 한 번이다(계정마다 반복하지 않음, 문장 수 비교).
- [ ] 실제 Gmail·Workspace 계정의 한도 수치와 수신자 수 가중 여부, 같은 IP의 동시 연결 한도를 확인하지 않았다(`sendQuota24h`·`concurrency`는 운영자가 정하는 값이다).
- [ ] 다중 인스턴스에서 인스턴스 수 × `cap_a`의 실제 SMTP 동시 연결과 계정 advisory lock 경합을 부하로 확인하지 않았다(동시 점유는 한 인스턴스 안의 12개 동시 호출로만 확인했다).

**판정 근거:**

- `worker/slots.spec.ts`(단위), `queue/account-claim.integration-spec.ts`(계정 할당·동시 점유), `worker/worker-accounts.integration-spec.ts`(Worker·슬롯·정지·할당 로그).
- RED 확인(2026-11-24): `worker/slots.spec.ts`는 모듈이 없어 로드에 실패했다. `worker/worker-accounts.integration-spec.ts`는 Worker 구현 전 12건 중 8건 실패했다(슬롯 상한 없음, 계정 할당 미적용 등).
- 구현: `worker/slots.ts`·`worker/worker.ts`·`worker/runner.ts`, `queue/claim.ts`·`quota-usage.ts`.
- 남은 미검증: 위 두 항목. `/metrics`의 `mailo_account_quota_*`·`mailo_worker_in_flight`와 `/ops/accounts`의 할당 표시는 묶음 C다.

### RQ-059 계정 단위 인덱스와 건수 쿼리

- [ ] **진행 상태:** 진행 중 (7단계 묶음 B)

**요구사항:**

- 마이그레이션 `0012`(`mail_jobs_account_priority_claim_idx (account_id, priority DESC, next_attempt_at, id)`), `0013`(`mail_jobs_account_claim_idx (account_id, next_attempt_at, id)`), `0014`(`mail_attempts_account_quota_idx (account_id, finished_at) WHERE counted AND stage IS DISTINCT FROM 'WORKER'`)는 `CREATE INDEX CONCURRENTLY IF NOT EXISTS`다. `0012`·`0013`의 부분 조건은 `status IN ('PENDING','RETRY_WAIT')`다. `0015`·`0016`은 기존 점유 인덱스 둘(`mail_jobs_priority_claim_idx`, `mail_jobs_claim_idx`)을 `DROP INDEX CONCURRENTLY IF EXISTS`로 지운다. 이번 릴리스의 마지막 마이그레이션이다. 파일마다 첫 줄 `-- mailo:no-transaction`, 문장 하나, 멱등이다(ADR-0013 결정 4).
- `queue.dueCount`·등급별 적체·예약 건수는 구성한 계정마다 상수 계정 쿼리로 읽고 합산한다. 계정별 상한(10000)에서 멈춘 값의 합이라 N>1이면 `dueCount`가 10000을 넘을 수 있고 `dueCountTruncated`는 어느 한 계정이라도 잘렸는지다. 구성 밖 계정의 작업은 세지 않는다. 계정이 하나이면 값과 문장 수가 이전과 같다(ADR-0013 결정 3 아).
- 구성 밖 계정 점검(`countOrphanAccountJobs`)은 계정 인덱스를 건너뛰며 읽어 테이블 크기가 아니라 구성 밖 계정의 대기 건수에 비례한다.
- 배포 순서와 롤백은 `docs/operations/deployment.md` "SMTP 계정 도입 배포 순서"다.

**수용 조건:**

- [x] 0001~0011 위에 `0012`~`0016`만 순서대로 적용되고 재실행은 아무것도 적용하지 않는다. 새 인덱스 셋이 유효하고 정의가 결정 4와 같다. 레거시 인덱스 둘이 지워지고 다른 인덱스는 남는다. 파일 다섯 개가 표식·문장 하나·멱등 형태이고 직접 다시 실행해도 오류가 없다.
- [x] 작은 데이터에서 `enable_seqscan = off`로 계정 조건 점유 쿼리가 새 우선순위·대기 순서 인덱스를, 사용량 쿼리가 새 시도 인덱스를 쓸 수 있다(계획 선택은 자동 테스트로 고정하지 못한다).
- [x] 건수 쿼리의 합산: `dueCount` 합과 `oldest` 최댓값, 계정별 상한 합과 `truncated`(어느 한 계정), 구성 밖 계정 제외, 계정 하나에서 문장 하나·N개에서 N문장, 중복 ID 한 번, `getQueueDepth`의 `scheduled` 합·`sending` 전체. 기존 `getQueueBacklog`·`getQueueDepth` 테스트는 계정 인자만 더해 같은 단언으로 통과한다.
- [x] `countOrphanAccountJobs`: 대기·점유 중인 구성 밖 계정만 계정별로 센다(종결·구성 안 계정 제외).
- [x] 로컬 단일 측정(ADR-0013 구현 중 확정 2026-11-24 묶음 B 항목 8): 74.5만 행에서 점유 쿼리·건수 쿼리·사용량 쿼리가 모두 새 인덱스를 쓰고 약 0.03~2.3ms였다. 구성 밖 계정 점검은 읽는 buffers가 16300(순차 스캔, 약 35ms)에서 69로 줄었고 실행 시간은 기본 설정(JIT 켜짐)에서 약 21ms, `jit = off`에서 0.6ms였다.
- [ ] 레거시 인덱스 삭제 뒤 구버전 인스턴스의 점유 성능(ADR-0013 M8, 한 쿼리 측정)과 롤링 배포·롤백 실행을 확인하지 않았다.
- [ ] 동시 쓰기 부하에서 `CREATE INDEX CONCURRENTLY`·`DROP INDEX CONCURRENTLY`가 걸리는 시간, 운영 크기(수백만 행)와 통계가 오래된 상태의 계획 안정성을 확인하지 않았다.

**판정 근거:**

- `db/account-claim-indexes.integration-spec.ts`, `queue/backlog-accounts.integration-spec.ts`, `queue/metrics-reads.integration-spec.ts`, `http/health-ops.integration-spec.ts`(PostgreSQL).
- RED 확인(2026-11-24): `db/account-claim-indexes.integration-spec.ts`는 새 파일이 없어 `ENOENT`로 8건 모두 실패했다. `queue/backlog-accounts.integration-spec.ts`는 이전 구현에서 6건 중 4건 실패했다.
- 구현: `migrations/0012`~`0016`, `queue/backlog.ts`, `health/health.service.ts`·`metrics-collector.ts`.
- 남은 미검증: 위 두 항목.

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
| 발송 우선순위           | RQ-033~038, ADR-0009                                   |
| 요청별 만료 시간        | RQ-039, ADR-0010                                       |
| 다중 SMTP 계정(묶음 A·B) | RQ-053~059, ADR-0013                                  |
| NFS 통합 테스트 환경    | 아래                                                   |

NFS 통합 테스트 환경(3단계, 추정):

- Linux VM(CI 러너 포함)에서 `nfs-kernel-server`를 같은 호스트에 NFSv4.1 loopback mount한다.
- `root_squash`를 켜고 서로 다른 non-root UID 2개로 실행한다.
- WSL 로컬에서는 건너뛴다. 특권 컨테이너는 필요 없다. (실행 결과: WSL2 커널 6.6에 nfsd 모듈이 있어 건너뛰지 않고 실행했다. `apps/mailo/scripts/nfs/run.sh`.)
- 속성 캐시는 커널 NFS 클라이언트에서 생기므로 loopback으로 재현된다고 본다. (실행 결과: 주소·호스트 이름이 다른 클라이언트 3개를 mount하면 새 폴더 가시성 지연 31초가 재현됐다.)
- GitHub 호스티드 러너에서 `nfs` 잡은 1회 통과했다(2026-11-23, run 45127889424, `c75052a`, 수동 실행, 31건, 잡 1분 38초). 범위는 같은 러너 안의 loopback NFS다. 그 전 두 실행은 실패했다. 첫 실행은 호출처 UID가 `caller-client.mjs` 경로를 통과하지 못했고, 두 번째 실행(run 45126208202)은 31건 중 28 통과·3 실패였다(캐시 만료 시점 `lstat` `EACCES` 2건, ESTALE 미재현 1건). 수정(ADR-0004 구현 중 확정 37·38) 뒤 통과한 실행에서도 러너 ESTALE 표본은 0/40이었다(`docs/operations/ci.md` "NFS 잡").

## 미결정 항목

다음 항목은 요구사항으로 확정하지 않았다. 결정되면 RQ를 추가하거나 갱신한다.

| 항목                    | 내용                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| 파일 채널 상세          | 결정됨: `link` 방식은 채택하지 않는다(ADR-0004 구현 중 확정 10·30·32, `rename`만 쓴다). 실제 NAS의 mount 옵션(NFS loopback 기준은 `docs/operations/nfs.md`에 정했고 실제 NAS는 미검증). 결정됨: 호출처 계정·폴더 모드는 default ACL 권장(ADR-0004 구현 중 확정 14·28, `docs/operations/caller-onboarding.md`), 스키마 필드명과 폴링 간격(30초)·임시 파일 정리 시간(1시간) 기본값은 2단계에서 정했다(ADR-0004 "구현 중 확정") |
| 메시지별 정책           | 재시도 횟수·간격을 요청별로 지정할지 여부. 결정됨: 우선순위(RQ-033, ADR-0009), 만료 시간(RQ-039, ADR-0010) |
| 반송(Bounce)            | SMTP 수락 이후 반송까지 추적할지 여부                               |
| 관리 기능               | 결정됨: `CANCELED` 상태와 운영 REST·CLI는 RQ-040~047, 실패 작업 수동 재시도는 만들지 않고 결과 불명 표시로 대신한다(RQ-048). 미결정: 발송 이력 조회 |
| 계정 전체 발송 속도 제어 | 24시간 할당은 결정됨(ADR-0013 결정 3, 구현 전). 초·분 단위 선제 제한은 범위 밖으로 남는다. 한도에 닿기 전에 계정 전체 발송 속도를 선제적으로 제한할지 여부. 한도 초과 응답은 ADR-0007이, 호출처별 할당은 RQ-032가 정했다. 한도 수치는 Google 문서 갱신으로 바뀔 수 있다 |
| 발신자 필드 정책        | 결정됨(ADR-0008 구현 중 확정 12, RQ-028·RQ-030): From은 기본 발신 주소 + 호출처 `allowedFrom`만 허용하고 Reply-To는 형식만 검증한다. 필드 자체는 Key 지문 범위(RQ-011)에 포함한다. 미확인: Gmail 인증 모드에서 `allowedFrom` 주소를 send-as 별칭으로 등록해야 From이 유지되는지 |
| SMTP Relay 송신 IP      | Workspace SMTP Relay가 IP 허용 방식이면 Docker 송신 IP 고정이 필요한지 확인 |
| 비기능 요구             | 처리량 목표. 결정됨: 메트릭은 `GET /metrics`로 낸다(ADR-0012, RQ-049~052)  |
| ADR 미확정 항목         | 실제 Gmail 응답 대조. 차단기 키 구성(SMTP 구성이 여럿일 때)은 결정됨(ADR-0013 결정 3, 키는 계정 ID, 구현 전). lease·SMTP 타임아웃, 폴링 간격과 점유 수, 응답 텍스트 마스킹은 1단계 구현 중 확정했다(ADR-0002·0007의 "구현 중 확정"). 각 ADR의 미확정 절을 따른다 |
