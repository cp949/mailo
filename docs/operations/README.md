# 운영 문서

Mailo를 배포·운영하고 호출처를 연동하는 문서다. 요구사항은 `../requirements/`, 결정은 `../adr/`, API 계약은 `../api/`에 있다.
모든 문서의 값·변수 이름·경로는 2026-11-23 코드와 대조했다. 실행하지 않은 검증은 각 문서의 "검증하지 않은 것" 절에 적었다.

| 문서 | 내용 | 읽을 사람 |
| ---- | ---- | --------- |
| [deployment.md](./deployment.md) | compose 구성과 컨테이너 강화, 환경 변수 표, 시크릿 주입(compose secrets 예시), 마이그레이션(비트랜잭션 파일, 일회성 실행), 헬스, 지표(`/metrics`, Prometheus 스크레이프 설정, 지표 목록, 알림 규칙 예시), 로그 형식, `stop_grace_period`와 lease, PostgreSQL 요건·연결 암호화, 백업·복구 | 배포 담당 |
| [key-management.md](./key-management.md) | DB 본문 키·지문 키·JWE 키·JWS 키·API 키의 발급, 교체, 이전 키 보관 기간, 키 종류·사건(유출·분실)별 사고 대응, 기동 시 검증 오류 해석 | 배포·보안 담당 |
| [caller-onboarding.md](./caller-onboarding.md) | 호출처 레지스트리 등록, API 키 발급·교체, 서명 선택, 파일 채널 폴더·권한·쓰기 규약, Spring Boot outbox + relay 지침(실행 샘플: `samples/spring-boot-relay/`), 레지스트리 변경 반영(재시작 뒤 적용, 롤링 중 인스턴스별 차이) | 운영자, 사용처 개발자 |
| [data-retention.md](./data-retention.md) | 개인정보(수신자, 발신자, 제목·본문, 호출처가 정한 Key·파일 이름, SMTP 응답 텍스트)가 DB·로그·지표·백업에 얼마나 남고 어떻게 지워지는지 표, Mailo 밖에 남는 것, 보존 설정과 기동 검사, 호출처 안내, 보존 기간 변경·수동 삭제의 위험도 | 운영자, 보안 담당 |
| [db-maintenance.md](./db-maintenance.md) | 테이블별 갱신·삭제 패턴, 팽창·VACUUM 점검 쿼리, 오래 열린 트랜잭션 확인, 보존 삭제 지연 판단, 감사 테이블 행 수 판단, 파티셔닝 검토 시작 조건, 로컬 단일 측정 결과와 한계 | 운영자, DB 운영자 |
| [troubleshooting.md](./troubleshooting.md) | 차단기 `open`, lease 만료, `unreadable` 파일, 수집 거부 사유 코드, 피드 지연, 지표 해석, 로그 이벤트 이름 | 운영자 |
| [nfs.md](./nfs.md) | NAS/NFS에서 파일 채널을 운영할 때의 mount 옵션, 컨테이너(Docker NFS 볼륨, 같은 호스트 loopback 확인)에서 쓰는 방법, 폴더 권한, 실측 결과와 한계 | 인프라 담당 |
| [ci.md](./ci.md) | GitHub Actions 잡 구성, 필수·선택 구분, 로컬 재현 명령, 로컬 확인 범위 | 개발자 |

## 읽는 순서

- 새로 배포한다: `deployment.md` → `key-management.md` → `caller-onboarding.md`.
- 호출처를 추가한다: `caller-onboarding.md`. 파일 채널이 NAS/NFS면 `nfs.md`.
- 호출처의 서명·암호화 구현을 서버 없이 확인한다: `../api/conformance/README.md`(공개 가짜 키로 만든 골든 벡터). 키 규칙은 `key-management.md`.
- 개인정보가 어디에 얼마나 남는지 확인한다: `data-retention.md`.
- DB가 커지거나 느려진다: `db-maintenance.md`. 이벤트 피드가 멈추면 `troubleshooting.md`.
- 키를 잃었거나 유출됐다: `key-management.md`의 "키 사고 대응".
- 레지스트리를 바꾼다: `caller-onboarding.md`의 "레지스트리 변경 반영".
- 장애를 본다: `troubleshooting.md`. 기동 실패는 `key-management.md`의 오류 표와 `deployment.md`의 제약 표.

## 갱신 규칙

- 환경 변수, 로그 이벤트 이름, 레지스트리 필드, 경로를 바꾸는 변경은 같은 변경에서 해당 문서를 갱신한다.
- 수치 기본값은 `.env.example`, `apps/mailo/src/config/load-config.ts`, `deployment.md`의 표가 같아야 한다.
- 검증하지 않은 내용은 검증하지 않았다고 적는다. 추정은 "추정"으로 표시한다.

## 알려진 공백

- 실제 NAS 제품(Docker local 드라이버 NFS 볼륨 `docker-compose.nfs-example.yml`은 같은 호스트 loopback만 확인했다), 실제 Gmail·Workspace SMTP 검증은 없다. CI 워크플로(`ci.md`)는 GitHub에서 실행해 성공했다(2026-11-23, dev 최근 run 45185115879). `nfs` 잡 러너 통과는 1회(run 45127889424)이고 schedule 실행 기록은 없다.
- 컨테이너 SIGKILL·SIGTERM은 `scripts/container/`로 실행했다(lease 45초 기준). lease 기본 120초에서의 종료 시간, 백업·복구 절차는 실행하지 않았다.
- 키 사고 대응 절차(`key-management.md`)와 레지스트리 롤링 중 동작(`caller-onboarding.md`)은 코드 읽기와 임시 schema SQL로만 확인했고 운영 환경·다중 인스턴스에서 실행하지 않았다. DB 유지보수 수치(`db-maintenance.md`)는 로컬 PostgreSQL 17 한 번의 측정이고 운영 크기가 아니다.
- `caller-onboarding.md`의 인라인 Java 조각은 컴파일하지 않았다. 컴파일·실행한 구현은 `samples/spring-boot-relay/`이고 nimbus-jose-jwt 10.10과 JWE·JWS 한 조합씩 확인했다(`samples/spring-boot-relay/README.md`).
