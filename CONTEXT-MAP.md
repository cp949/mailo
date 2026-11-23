# Context Map

Mailo는 단일 컨텍스트다. 도메인 용어와 진행 상태 정의는 `docs/requirements/mail-sending.md`의 "용어와 진행 상태" 절이 기준이다. 앱이 하나이므로 `CONTEXT.md`를 따로 두지 않는다. 용어가 늘어 그 절로 부족해지면 `apps/mailo/CONTEXT.md`를 추가하고 이 표를 갱신한다.

| 구분                            | 위치                                |
| ------------------------------- | ----------------------------------- |
| 앱                              | `apps/mailo`                        |
| 요구사항(RQ-001~032, 구현 단계) | `docs/requirements/mail-sending.md` |
| 결정(ADR-0001~0008)             | `docs/adr/`                         |
| API 계약(OpenAPI)               | `docs/api/`                         |
| 운영 문서(배포·키·호출처·장애)  | `docs/operations/`                  |

## 모듈과 근거 문서

| 모듈 (`apps/mailo/src/`) | 책임                                                                                           | 근거                           |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------ |
| `intake`                 | REST 등록·조회, `Idempotency-Key`                                                              | RQ-001, ADR-0005·0006          |
| `queue`                  | 작업 점유(claim), lease 복구, 결과 기록, 만료 sweep, 차단기 저장소                             | ADR-0002·0003, ADR-0007 결정 5 |
| `worker`                 | 점유·전송·기록 루프, SIGTERM drain, 설정→Worker·SMTP 옵션 조립                                 | ADR-0002 결정 4·9~12, RQ-025   |
| `smtp`                   | SMTP 전송, 단계 기준 오류 분류, 백오프 계산                                                    | ADR-0007                       |
| `crypto`                 | DB 본문 암호화, Key 내용 지문                                                                  | ADR-0005·0008                  |
| `envelope`               | JWS 서명 검증, JWE 복호화, 수집 공용 파이프라인(`openRequest`), 큐 등록 입력 변환, 개인키 키링 | ADR-0008, RQ-022·024           |
| `file-channel`           | 파일 채널 폴러(호출처별 `inbox/` 폴링 수집, 거부 기록, 임시 파일 정리), 수명 주기 연결         | ADR-0004, RQ-002·024           |
| `events`                 | 종결 이벤트 피드, 수집 거부 기록                                                               | ADR-0006                       |
| `callers`                | 호출처 레지스트리, API 키 인증                                                                 | RQ-028                         |
| `health`                 | 헬스 응답, 차단기 상태 노출                                                                    | ADR-0007 결정 5                |
| `config`                 | 환경 변수 로딩, Worker 옵션 값                                                                 | RQ-025                         |
| `http`                   | problem+json 오류, 요청 ID, 본문 읽기 공통 처리                                                | RQ-030, ADR-0006               |
| `validation`             | 요청 입력 검증(수신자·제목·본문 상한)                                                          | RQ-030                         |
| `db`                     | `pg` 풀, SQL 마이그레이션 실행기                                                               | ADR-0002                       |

## 앱 조립

`app.module.ts`가 모듈을 묶고, `app-lifecycle.ts`가 기동(파일 폴러 start → Worker start)과 종료(HTTP 닫기 → 파일 폴러 정지 → Worker drain → 풀 닫기) 순서를 정한다. `worker-port.ts`의 `WorkerRunner`와 `file-channel/port.ts`의 `FilePollerRunner`가 각각의 연결 지점이다. 파일 채널은 `MAILO_FILE_CHANNEL_ROOT`가 있을 때만 켜진다.

## 구현 단계

1단계(REST, 큐·Worker, ADR-0005·0007, 본문 암호화, API 키 인증), 2단계의 봉투(`envelope`: JWS·JWE, REST JWE), 파일 채널 폴러(`file-channel`, ADR-0004), 호출처별 발송 할당(RQ-032, `queue/claim.ts`)을 구현했다. 3단계로 같은 호스트 Docker named volume(`scripts/volume/`)과 NFS loopback(`pnpm test:nfs`)에서 파일 채널을 검증하고 운영 문서(`docs/operations/`)를 썼다. 실제 NAS 제품, 실제 Gmail, CI는 검증하지 않았다. RQ별 상태 요약은 `docs/requirements/README.md`다.
