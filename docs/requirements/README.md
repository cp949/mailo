# 요구사항 문서

장기적으로 유지하는 제품 요구사항을 둔다.
요구사항 ID와 수용 조건은 이후 작업의 기준이다.
각 문서의 진행 상태와 판정 근거는 관련 구현 변경과 함께 갱신한다.

| 문서                                 | 내용                                                          |
| ------------------------------------ | ------------------------------------------------------------- |
| [mail-sending.md](./mail-sending.md) | Mailo 이메일 발송 요구사항, RQ-001~041 수용 조건, 진행 상태, 구현 단계 |
| [roadmap.md](./roadmap.md) | RQ-041 이후의 장기 방향 제안(수용·보류·미수용 판단). 확정 전 단계 |

## 진행 상태 요약 (2026-11-24, 6단계 묶음 A 작업 취소 반영)

상태 어휘는 `미착수`·`진행 중`·`검증 완료`·`보류`다(`mail-sending.md`의 "용어와 진행 상태"). 이 표는 RQ별 상태를 요약한 것이고 기준은 각 RQ의 수용 조건 체크다. 검증 완료 31건, 진행 중 10건, 미착수 0건, 보류 0건이다. 4단계 발송 우선순위는 RQ-033~037이 검증 완료이고 RQ-038이 진행 중이다. 5단계 요청별 만료 시간(RQ-039)은 문서 조건이 검토로만 확인돼 진행 중이다. 6단계 묶음 A(ADR-0011 결정 4의 호출처 취소)는 RQ-040이 검증 완료이고 배포 호환성(RQ-041)은 롤링 배포·롤백 실행과 저장소 밖 호출처 확인이 남아 진행 중이다. 6단계의 나머지 결정은 구현 전이다.

근거로 쓴 실행 결과는 단위 602건(31개 파일, `pnpm test`, 2026-11-24, 6단계 묶음 A 반영 뒤), 통합 405건(27개 파일, `pnpm test:integration`, 같은 날, 실제 PostgreSQL 17과 로컬 `smtp-server`)이고 실패는 0건이다. 샘플은 Gradle 단위 33건과 `verify/run-e2e.sh` 102항목(2026-11-24, 실패 0)이다. 4단계·5단계 묶음에서는 컨테이너·볼륨·NFS·샘플 스크립트를 다시 실행하지 않았다(해당 영역 변경 없음). 아래 스크립트 결과는 그 전 묶음의 실행 값이다. `pnpm test:nfs` 31건(같은 호스트 NFS loopback, NFSv4.1·4.2 각각)은 3단계 마무리 실행 값이다. 같은 날 `nfs-kernel-server` 2.6.1을 설치해 `scripts/nfs/run.sh`를 기본값(NFSv4.1 클라이언트)으로 다시 실행했고 31건이 통과했다(4.2 기본값 전체 재실행은 하지 않았다). 볼륨 스크립트(`scripts/volume/`, a~g, acl·group 포함)와 컨테이너 스크립트(`scripts/container/`, SIGKILL 중복 발송·SIGTERM 종료)는 2026-11-23에 읽기 전용 루트·`cap_drop`·digest 고정 이미지(M9)와 로그 형식 변경(M10) 뒤 다시 실행해 모두 기대와 일치했다. `apps/mailo/scripts/nfs/verify-docker-volume.sh`(Docker NFS 볼륨, 같은 호스트 loopback)는 같은 날 처음 실행해 통과 13, 실패 0이었다(스크립트 검증이라 수용 조건 `[x]`는 올리지 않았다). GitHub Actions 워크플로(`.github/workflows/ci.yml`, `docs/operations/ci.md`)는 GitHub에서 여러 번 성공했다. dev 최근 성공은 run 45185115879(`ab7d879`, 2026-11-23, `static`·`integration`·`container`)다. `nfs` 잡은 run 45127889424(`c75052a`, 2026-11-23, 수동)에서 1회 통과했고 범위는 같은 러너 안의 loopback NFS다. schedule 실행 기록은 없다. `검증 완료`는 로컬 SMTP 서버와 PostgreSQL 기준이다.

| RQ | 제목 | 상태 | 남은 미검증 |
| -- | ---- | ---- | ----------- |
| RQ-001 | REST 입력 채널 | 검증 완료 | 등록 중간 실패 주입 테스트 없음(단일 `INSERT`라는 구조 근거) |
| RQ-002 | 파일 입력 채널 | 진행 중 | 실제 NAS 제품, 서버 재시작·failover, NFSv3·4.0·Kerberos, bind mount, 실제 NAS에서의 Docker local 드라이버 NFS 볼륨(`docker-compose.nfs-example.yml`, 같은 호스트 loopback은 스크립트로 확인함), `hard` mount에서 NAS 정지 시 폴러(코드 읽기 결과만 있음), rootless Docker, GitHub 러너의 ESTALE 경로(`nfs` 잡은 2026-11-23 run 45127889424에서 1회 통과, 러너 ESTALE 표본 0/40). 볼륨·NFS 검증은 스크립트·별도 jest 설정이다 |
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
| RQ-018 | 영속 큐 | 검증 완료 | jest의 `PENDING` 재시작 테스트는 앱 인스턴스를 닫고 다시 만든 것이다(컨테이너 SIGKILL·SIGTERM 재시작은 스크립트로 관찰. 스크립트는 CI `container` 잡으로 GitHub 러너에서도 성공했다, 예: run 45185115879) |
| RQ-019 | Worker 중복 점유 방지 | 검증 완료 | 실제 다중 프로세스 장시간 동작 없음 |
| RQ-020 | 처리 중단 복구 | 검증 완료 | 실제 kill은 스크립트 관찰이며 jest 자동 테스트에 없다. CI `container` 잡으로 GitHub 러너에서 실행돼 성공했다(예: run 45185115879). SIGKILL 스크립트는 관찰만 기록해 중복 재현 여부와 무관하게 성공한다 |
| RQ-021 | 비즈니스 트랜잭션과의 분리 | 검증 완료 | 샘플(`samples/spring-boot-relay/`)은 로컬 PostgreSQL·로컬 SMTP·JDK 21 기준이고 jest·CI에 없음 |
| RQ-022 | 선택적 봉투 암호화 | 검증 완료 | nimbus-jose-jwt 10.10과는 JWE·JWS 한 조합씩 확인함(다른 버전·알고리즘·키 교체 중 이전 `kid`·큰 본문은 미확인), JWE 개인키 유출 대응 절차(미결정) |
| RQ-023 | DB 본문 암호화 | 검증 완료 | |
| RQ-024 | 파일 채널 접근 통제 | 진행 중 | 실제 NAS 제품, bind mount, rootless Docker·`userns-remap`, ACL 미지원 파일시스템, jest 통합 테스트 미포함(볼륨 스크립트는 CI `container` 잡으로 GitHub 러너에서 성공했다, 예: run 45185115879) |
| RQ-025 | Docker 실행과 설정 | 진행 중 | `NODE_ENV=development` 컨테이너 기동, 이미지 검사(취약점·시크릿 스캔 없음), `stop_grace_period`와 lease 관계의 자동 검증, compose secrets 예시·`docker-compose.migrate-once.yml` 기동, TLS를 켠 PostgreSQL 접속(`MAILO_DB_SSLMODE`)(운영 구성 기동과 SIGTERM은 읽기 전용 루트로 로컬 Docker에서 확인함. `verify-sigterm-file.sh`는 GitHub 러너 `container` 잡에서도 성공했다, 예: run 45185115879) |
| RQ-026 | 영속 보관과 자동 복구 | 진행 중 | 컨테이너 재생성, 자동 재시작 정책(스크립트는 수동 `compose start`로 재기동) |
| RQ-027 | 로그 | 진행 중 | 컨테이너 로그 본문·시크릿 노출 검사(컨테이너 로그 출력과 JSON 형식은 관찰함), 컨테이너에서 오류 로그 확인 |
| RQ-028 | 호출처 레지스트리와 REST 인증 | 검증 완료 | |
| RQ-029 | 단순성과 외부 의존성 최소화 | 검증 완료 | compose 파일 글자 검사(`config/compose-consistency.spec.ts`)와 `docker compose config` 수동 확인. 개발용 Mailpit은 profile `mailpit` opt-in 예외 |
| RQ-030 | 요청 입력 검증 | 검증 완료 | |
| RQ-031 | 헬스와 준비 상태 | 검증 완료 | |
| RQ-032 | 호출처별 발송 할당 | 검증 완료 | 실제 다중 프로세스·장시간 부하, 실제 Gmail 한도와의 관계 |
| RQ-033 | 우선순위 지정 | 검증 완료 | 호출처의 등급 남용은 받아들인 위험(자동 검증 대상 아님) |
| RQ-034 | 중복 등록 계약 | 검증 완료 | |
| RQ-035 | 점유 순서 | 검증 완료 | 실제 다중 프로세스 동시 점유(단일 프로세스 병렬 `claim`으로 확인), 비율 0.1의 실제 부하 적정성 |
| RQ-036 | 기존 발송 정책 유지와 굶음의 한계 | 검증 완료 | 실제 다중 프로세스, 장시간 적체에서 낮은 등급의 만료 |
| RQ-037 | 조회와 운영 가시성 | 검증 완료 | |
| RQ-038 | 배포 호환성과 문서 | 진행 중 | 성능은 수동 측정으로 기준 충족(최대 1.08배, 자동 검증 아님), 문서는 검토로만 확인, 롤링 배포·롤백 실행, 대용량·쓰기 부하 중 `0005` 적용, 캐시가 차가운 상태의 점유 지연 |
| RQ-039 | 요청별 만료 시간 지정 | 진행 중 | 문서는 검토로만 확인, 롤링 배포·롤백 실행, 긴 상한에서의 대기 건수와 점유 지연, 하한 60의 적정성 |
| RQ-040 | 호출처 작업 취소 | 검증 완료 | 관리 토큰 경로·감사·일괄 취소는 구현 전(범위 밖), 동시 쓰기 부하에서의 취소·claim 경합(작업 행 잠금은 통합 테스트로 확인함) |
| RQ-041 | 취소 배포 호환성과 호출처 선행 조건 | 진행 중 | 롤링 배포·롤백 실행, 대용량·쓰기 부하 중 `0006`·`0007`의 `ACCESS EXCLUSIVE` 잠금 대기, 저장소 밖 호출처의 모르는 값 처리(ADR-0011 구현 순서 1.8), 문서는 검토로만 확인 |

## 전체 미검증 목록

- 작업 취소(RQ-040·041, ADR-0011 결정 4·10): 롤링 배포 중 구·신 인스턴스 혼용과 롤백 실행, 대용량 테이블·쓰기 부하 중 `0006`·`0007`의 `ACCESS EXCLUSIVE` 잠금 대기, 이 저장소 밖 호출처가 모르는 값 규칙을 지키는지. 구버전 인스턴스의 `CANCELED` 처리는 코드 읽기 결과다. ADR-0011의 나머지 결정(토큰 분리, 정지, 감사, `/ops`, CLI, 수신 도메인 허용 목록, 피드 공백 감지)은 구현 전이다.
- 요청별 만료 시간(RQ-039, ADR-0010): 롤링 배포 중 구·신 인스턴스 혼용과 롤백 실행, `MAILO_JOB_EXPIRY_MAX_SECONDS`를 기본 TTL보다 늘린 배치의 대기 건수와 점유 지연, 하한 60의 적정성.
- 발송 우선순위(RQ-038, ADR-0009): 롤링 배포 중 구·신 인스턴스 혼용과 롤백 실행, 대용량 테이블과 쓰기 부하 중의 `0005`(`CREATE INDEX CONCURRENTLY`) 적용 시간, 캐시가 차가운 상태의 점유 지연, 실제 다중 프로세스·장시간 부하에서의 등급 효과. 점유 쿼리 성능은 수동 측정이다(ADR-0009 구현 중 확정 3).
- 실제 Gmail·Workspace SMTP(RQ-005·006·009).
- 실제 NAS 제품과 그 서버 재시작·failover(RQ-002·024). 같은 호스트 loopback만 확인했다.
- GitHub 호스티드 러너의 `nfs` 잡 반복 실행과 schedule 실행. 러너 통과는 1회다(2026-11-23, run 45127889424, `c75052a`, 31건, 같은 러너 loopback NFS). 그 실행에서 ESTALE 표본은 0/40이라 러너에서 ESTALE 경로는 검증되지 않았다(`docs/operations/ci.md` "NFS 잡").
- 실제 Gmail의 `Message-ID` 중복 처리(RQ-013). SIGKILL 재발송은 로컬 가짜 SMTP로 관찰했다.
- 실제 NAS 제품에서의 Docker local 드라이버 NFS 볼륨(`docker-compose.nfs-example.yml`, RQ-002·024)과 `hard` mount에서 서버를 멈췄을 때의 폴러 정지 감지(`filePoller.lastPollAt`). 같은 호스트 loopback 기준 컨테이너 수집은 `verify-docker-volume.sh`로 확인했다(2026-11-23, 통과 13).
- compose `secrets:` 예시, `docker-compose.migrate-once.yml`, TLS를 켠 PostgreSQL 접속(RQ-025).
- 컨테이너 재생성과 PostgreSQL 컨테이너 재시작(RQ-026), `NODE_ENV=development` 컨테이너(RQ-025). 운영 구성 기동·SIGTERM·SIGKILL은 로컬 가짜 SMTP로 관찰했다.
- 호스트 외 환경: bind mount, rootless Docker, Docker Desktop·macOS·Windows, ACL 미지원 파일시스템, 호출처가 Linux가 아닌 환경.
- Java 샘플이 확인하지 않은 범위: 다른 nimbus-jose-jwt 버전, `RSA-OAEP-256`·`A256GCM`·`HS256` 외 알고리즘, 키 교체 중 이전 `kid`, 큰 본문, 여러 relay 인스턴스의 동시 실행(RQ-021·022). 확인한 조합과 결과는 `samples/spring-boot-relay/README.md`다.
