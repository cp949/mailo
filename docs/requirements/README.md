# 요구사항 문서

장기적으로 유지하는 제품 요구사항을 둔다.
요구사항 ID와 수용 조건은 이후 작업의 기준이다.
각 문서의 진행 상태와 판정 근거는 관련 구현 변경과 함께 갱신한다.

| 문서                                 | 내용                                                          |
| ------------------------------------ | ------------------------------------------------------------- |
| [mail-sending.md](./mail-sending.md) | Mailo 이메일 발송 요구사항, RQ-001~032 수용 조건, 진행 상태, 구현 단계 |

## 진행 상태 요약 (2026-11-23, 3단계 마무리)

상태 어휘는 `미착수`·`진행 중`·`검증 완료`·`보류`다(`mail-sending.md`의 "용어와 진행 상태"). 이 표는 RQ별 상태를 요약한 것이고 기준은 각 RQ의 수용 조건 체크다. 검증 완료 25건, 진행 중 7건, 미착수 0건, 보류 0건이다.

근거로 쓴 실행 결과는 단위 505건(30개 파일, `pnpm test`, 2026-11-23), 통합 278건(19개 파일, `pnpm test:integration`, 같은 날, 실제 PostgreSQL과 로컬 `smtp-server`)이고 실패는 0건이다. 이 수치는 같은 작업 트리의 다른 묶음 변경을 포함한다. `pnpm test:nfs` 31건(같은 호스트 NFS loopback, NFSv4.1·4.2 각각)은 직전 3단계 마무리 실행 값이고 NFS 환경이 정리돼 이번에는 실행하지 않았다. 볼륨 스크립트(`scripts/volume/`, a~g, acl·group 포함)와 컨테이너 스크립트(`scripts/container/`, SIGKILL 중복 발송·SIGTERM 종료)는 2026-11-23에 읽기 전용 루트·`cap_drop`·digest 고정 이미지(M9)와 로그 형식 변경(M10) 뒤 다시 실행해 모두 기대와 일치했다. `apps/mailo/scripts/nfs/verify-docker-volume.sh`(Docker NFS 볼륨)는 작성만 했고 실행하지 못했다. GitHub Actions 워크플로(`.github/workflows/ci.yml`, `docs/operations/ci.md`)는 작성하고 `actionlint`로 문법을 확인했으나 GitHub에서 실행하지 않았다. `검증 완료`는 로컬 SMTP 서버와 PostgreSQL 기준이다.

| RQ | 제목 | 상태 | 남은 미검증 |
| -- | ---- | ---- | ----------- |
| RQ-001 | REST 입력 채널 | 검증 완료 | 등록 중간 실패 주입 테스트 없음(단일 `INSERT`라는 구조 근거) |
| RQ-002 | 파일 입력 채널 | 진행 중 | 실제 NAS 제품, 서버 재시작·failover, NFSv3·4.0·Kerberos, bind mount, Docker local 드라이버 NFS 볼륨(`docker-compose.nfs-example.yml`, 스크립트 작성만 함), `hard` mount에서 NAS 정지 시 폴러, rootless Docker, GitHub 러너(워크플로 작성만 함). 볼륨·NFS 검증은 스크립트·별도 jest 설정이다 |
| RQ-003 | DB 비공유 | 진행 중 | "설정에 사용처 DB 정보 없음"·"사용처용 DB 계정 없음"의 자동 검증 없음(설정 읽기) |
| RQ-004 | 보장 범위 | 검증 완료 | 여러 relay 인스턴스 동시 실행·전송 도중 강제 종료는 재현하지 않음(샘플 relay는 단일 인스턴스로 실행) |
| RQ-005 | SMTP 발송 | 진행 중 | 실제 Gmail·Workspace SMTP, 서버 전환 |
| RQ-006 | 메일 내용 | 검증 완료 | 실제 Gmail 대상 확인 없음 |
| RQ-007 | 비동기 분리 | 검증 완료 | 연결은 받고 응답하지 않는 SMTP 서버와 등록의 동시 테스트 없음 |
| RQ-008 | 재시도 설정 | 검증 완료 | 수치는 추정 |
| RQ-009 | 오류 분류 | 검증 완료 | 응답 코드·텍스트 매핑 일부는 추정, 실제 Gmail 응답 대조 없음 |
| RQ-010 | 재시도 중단과 시도 기록 | 검증 완료 | 시도 이력 전체의 REST 조회는 미결정(마지막 오류만 노출) |
| RQ-011 | 요청 중복 등록 방지 | 검증 완료 | 실제 30일 경과 없음(DB 시각을 당겨 확인) |
| RQ-012 | 동시성과 영속성 | 검증 완료 | 재시작 테스트는 같은 jest 프로세스에서 앱 인스턴스를 닫고 다시 만든 것이다(OS 프로세스 재시작은 컨테이너 스크립트로 관찰) |
| RQ-013 | SMTP 중복 전송 한계 | 검증 완료 | 실제 Gmail이 같은 `Message-ID`를 중복으로 버리는지(SIGKILL 재발송 자체는 컨테이너에서 관찰함) |
| RQ-014 | 상태 모델 | 검증 완료 | |
| RQ-015 | 상태 조회 | 검증 완료 | 보존 기간이 지난 Key의 404를 조회 호출까지 이어 검증한 테스트 없음 |
| RQ-016 | `SENT` 의미 | 검증 완료 | |
| RQ-017 | 최종 실패 인지 | 검증 완료 | 피드 지연은 헬스 필드로만 노출(외부 메트릭 시스템 없음) |
| RQ-018 | 영속 큐 | 검증 완료 | jest의 `PENDING` 재시작 테스트는 앱 인스턴스를 닫고 다시 만든 것이다(컨테이너 SIGKILL·SIGTERM 재시작은 스크립트로 관찰, CI 연결은 작성만 하고 GitHub에서 미실행) |
| RQ-019 | Worker 중복 점유 방지 | 검증 완료 | 실제 다중 프로세스 장시간 동작 없음 |
| RQ-020 | 처리 중단 복구 | 검증 완료 | 실제 kill은 스크립트 관찰이며 jest 자동 테스트에 없다. CI `container` 잡에 연결했으나 GitHub에서 미실행 |
| RQ-021 | 비즈니스 트랜잭션과의 분리 | 검증 완료 | 샘플(`samples/spring-boot-relay/`)은 로컬 PostgreSQL·로컬 SMTP·JDK 21 기준이고 jest·CI에 없음 |
| RQ-022 | 선택적 봉투 암호화 | 검증 완료 | nimbus-jose-jwt 10.10과는 JWE·JWS 한 조합씩 확인함(다른 버전·알고리즘·키 교체 중 이전 `kid`·큰 본문은 미확인), JWE 개인키 유출 대응 절차(미결정) |
| RQ-023 | DB 본문 암호화 | 검증 완료 | |
| RQ-024 | 파일 채널 접근 통제 | 진행 중 | 실제 NAS 제품, bind mount, rootless Docker·`userns-remap`, ACL 미지원 파일시스템, jest 통합 테스트 미포함(CI `container` 잡에 연결했으나 GitHub에서 미실행) |
| RQ-025 | Docker 실행과 설정 | 진행 중 | `NODE_ENV=development` 컨테이너 기동, 이미지 검사(취약점·시크릿 스캔 없음), `stop_grace_period`와 lease 관계의 자동 검증, compose secrets 예시·`docker-compose.migrate-once.yml` 기동, TLS를 켠 PostgreSQL 접속(`MAILO_DB_SSLMODE`)(운영 구성 기동과 SIGTERM은 읽기 전용 루트로 로컬 Docker에서 확인함, GitHub 러너는 미확인) |
| RQ-026 | 영속 보관과 자동 복구 | 진행 중 | 컨테이너 재생성, 자동 재시작 정책(스크립트는 수동 `compose start`로 재기동) |
| RQ-027 | 로그 | 진행 중 | 컨테이너 로그 본문·시크릿 노출 검사(컨테이너 로그 출력과 JSON 형식은 관찰함), 컨테이너에서 오류 로그 확인 |
| RQ-028 | 호출처 레지스트리와 REST 인증 | 검증 완료 | |
| RQ-029 | 단순성과 외부 의존성 최소화 | 검증 완료 | 정적 확인(자동 검증 없음) |
| RQ-030 | 요청 입력 검증 | 검증 완료 | |
| RQ-031 | 헬스와 준비 상태 | 검증 완료 | |
| RQ-032 | 호출처별 발송 할당 | 검증 완료 | 실제 다중 프로세스·장시간 부하, 실제 Gmail 한도와의 관계 |

## 전체 미검증 목록

- 실제 Gmail·Workspace SMTP(RQ-005·006·009).
- 실제 NAS 제품과 그 서버 재시작·failover(RQ-002·024). 같은 호스트 loopback만 확인했다.
- GitHub 호스티드 러너. 워크플로(`ci.yml`)는 작성만 했고 실행하지 않았다. `nfs` 잡은 러너에서 커널 NFS 서버 구성이 되는지부터 모른다(`docs/operations/ci.md`).
- 실제 Gmail의 `Message-ID` 중복 처리(RQ-013). SIGKILL 재발송은 로컬 가짜 SMTP로 관찰했다.
- Docker local 드라이버 NFS 볼륨(`docker-compose.nfs-example.yml`, RQ-002·024), compose `secrets:` 예시, `docker-compose.migrate-once.yml`, TLS를 켠 PostgreSQL 접속(RQ-025).
- 컨테이너 재생성과 PostgreSQL 컨테이너 재시작(RQ-026), `NODE_ENV=development` 컨테이너(RQ-025). 운영 구성 기동·SIGTERM·SIGKILL은 로컬 가짜 SMTP로 관찰했다.
- 호스트 외 환경: bind mount, rootless Docker, Docker Desktop·macOS·Windows, ACL 미지원 파일시스템, 호출처가 Linux가 아닌 환경.
- Java 샘플이 확인하지 않은 범위: 다른 nimbus-jose-jwt 버전, `RSA-OAEP-256`·`A256GCM`·`HS256` 외 알고리즘, 키 교체 중 이전 `kid`, 큰 본문, 여러 relay 인스턴스의 동시 실행(RQ-021·022). 확인한 조합과 결과는 `samples/spring-boot-relay/README.md`다.
