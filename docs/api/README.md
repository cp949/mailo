# Mailo REST API 계약

1단계 REST 계약은 [openapi.yaml](./openapi.yaml)(OpenAPI 3.1)이다.
근거는 ADR-0001~0008과 [요구사항](../requirements/mail-sending.md)이다.
1단계 REST 구현(`apps/mailo/src/intake`, `health`, `http`)이 이 계약을 따른다. 파일 채널 폴러(`apps/mailo/src/file-channel`)는 이 계약을 바꾸지 않고 `INTAKE_REJECTED` 이벤트를 만든다. 계약과 어긋난 곳은 "계약과 구현의 불일치" 절에 있다.
암호화 모드(JWE `content`)는 2단계 봉투 모듈(`apps/mailo/src/envelope`)이 처리한다(ADR-0008).

## 인증

- 호출처별 API 키를 `Authorization: Bearer <키>`로 보낸다(RQ-028).
- 호출처당 키 2개가 동시에 유효하다. 교체할 때 새 키를 먼저 배포한 뒤 이전 키를 폐기한다.
- `caller_id`는 키에서 얻는다. 다른 호출처의 작업은 ID로도 Key로도 조회되지 않고 404다.
- 파일 채널만 쓰는 호출처도 조회와 이벤트 피드를 쓰려면 키가 필요하다(ADR-0006 결정 5).
- 헬스 endpoint(`/health/live`, `/health/ready`)는 인증 없이 호출할 수 있다.
  - `/health/live`는 `Authorization` 헤더를 읽지 않는다. 헤더가 틀려도 200이다.
  - `/health/ready`는 헤더가 없으면 공개 필드만 반환한다. 유효한 Bearer가 있으면 필드를 더하고, 틀린 헤더는 401이다. 운영자 토큰(`MAILO_OPS_TOKEN`)은 호출처 전체의 큐 적체와 Worker·파일 폴러 상태(`queue`, `worker`, `filePoller`)를 더한다. 호출처 API 키로는 반환하지 않는다. 필드 범위는 openapi.yaml의 `/health/ready` 설명을 따른다.

## 오류 형식

- 모든 오류 응답은 `application/problem+json`(RFC 9457)이다. 분기는 `type`(URN)으로 한다.
- 검증 오류(`validation-failed`)는 `errors[]`에 위치(`pointer` 또는 `parameter`)와 고정 `code`만 담는다.
- 오류 응답, 서버 로그, 수집 거부 기록에 다음을 넣지 않는다.
  - 제목, text, html, JWE 암호문, 복호화한 평문.
  - 요청에서 받은 값 전반(주소, Key 포함). 위치와 코드로만 알린다.
- `title`은 `type`마다 고정 문구다. `detail`도 요청 값으로 조립하지 않는다.
- `instance`(`urn:uuid:<요청 ID>`)는 서버 로그의 같은 값과 대조해 문의할 때 쓴다.

## Key 계약 요약

| 항목 | 규칙 |
| ---- | ---- |
| 필수 여부 | `Idempotency-Key` 헤더 필수. 없으면 400 |
| 형식 | 1~128자, `[A-Za-z0-9._:-]` |
| 유일성 | `(caller_id, Key)`. REST와 파일 채널이 같은 범위를 쓴다 |
| 같은 Key, 같은 내용 | 200, 기존 작업 반환 |
| 같은 Key, 다른 내용 | 409. 두 번째 메일은 등록하지 않는다 |
| 내용 동일 판정 | 복호화한 평문의 지문. to, cc, bcc, from, replyTo, 제목, text, html이 범위다. 암호문은 비교하지 않는다 |
| 보존 | 작업 종결 후 30일(추정). 종결되지 않은 작업의 Key는 지우지 않는다. 지난 뒤 같은 Key는 새 요청이다 |
| Key로 쓸 값 | 요청 단위로 고유한 값. outbox 행 ID 등. 사용자 ID처럼 공유되는 값은 409를 일으킨다 |

## 호출처 relay 재시도 지침

같은 요청은 항상 같은 Key와 같은 내용으로 다시 보낸다. 재시도할 때 필드를 바꾸면 409다.

| 결과 | relay 동작 |
| ---- | ---------- |
| 202, 200 | 완료. outbox 행을 전송 완료로 표시한다 |
| 네트워크 오류, 타임아웃, 5xx(503 포함) | 같은 Key로 재시도한다. 서버가 등록했는지 알 수 없으므로 Key가 중복을 막는다 |
| 400, 413, 415 | 재시도하지 않는다. 요청을 고쳐야 한다. 실패로 기록하고 알린다 |
| 401 | 재시도하지 않는다. 자격 문제이므로 알린다. 고친 뒤 재전송하는 절차는 사용처가 정한다 |
| 409 | 재시도하지 않는다. 영구 실패로 기록하고 운영 알림을 낸다. Key를 재사용하는 호출처 버그를 의심한다 |
| 429 | 쓰지 않는다. 등록 단계에는 쿼터가 없다 |

- 재시도 간격은 exponential backoff에 jitter를 더하고 상한을 둔다. 수치는 사용처가 정한다.
- 최대 재시도 기간은 7일 이하로 한다. Key 보존 기간(30일)보다 충분히 짧아야 한다(7일은 추정).
- 202나 200은 등록 완료이며 발송 완료가 아니다. 최종 결과는 `GET /jobs/{jobId}`나 이벤트 피드로 확인한다.
- 발송은 at-least-once다. SMTP 수락 직후 장애가 나면 같은 메일이 두 번 갈 수 있다(RQ-013).
- `SENT`는 SMTP 서버의 수락이다. 받은편지함 도착이 아니고, 일부 수신자가 거부됐을 수 있다. `rejectedRecipients`를 확인한다.
- 이벤트는 `GET /events`를 약 30초(추정) 간격으로 폴링해 받는다. cursor를 저장하고 `eventId`로 멱등하게 처리한다.
- 파일 채널 호출처는 `GET /jobs?idempotencyKey=`가 404이면 이벤트 피드에서 같은 Key의 `INTAKE_REJECTED`를 찾는다.

## 계약에서 새로 정한 것

ADR과 RQ에 없던 결정이다. 모두 추정이며 구현 전에 검토한다. ADR과 RQ는 고치지 않았다.

경로와 요청.

- 등록 경로는 `POST /jobs`다. 헬스 경로는 `/health/live`, `/health/ready`다.
- `to`, `cc`, `bcc`, `from`, `replyTo`는 addr-spec 문자열이다. 표시 이름은 지원하지 않는다. `from`과 `replyTo`는 주소 하나다.
- `to`는 1명 이상이다. 수신자 50명 상한은 to+cc+bcc 합계이고 중복 주소도 각각 센다.
- 정의되지 않은 필드는 `attachments`를 포함해 모두 400이다. `subject`는 빈 문자열을 허용하지 않는다.
- 암호화 모드는 JWE compact serialization 문자열을 `content`에 넣는다. 평문은 UTF-8 JSON `{"subject","text","html"}`이다. `alg`는 `RSA-OAEP-256`(RSA 3072), `enc`는 `A256GCM`이고 protected header에 `kid`와 `caller`를 넣는다. `kid` 형식은 `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`이다.
- 평문 모드와 암호화 모드는 한 요청에서 섞을 수 없다(400, `CONFLICTING_FIELDS`).
- REST의 복호화 실패(`DECRYPTION_FAILED`), 알 수 없는 `kid`(`KID_UNKNOWN`), `caller` 불일치(`CALLER_MISMATCH`)는 모두 위치 `/content`의 400(`validation-failed`)이다. 복호화한 제목·본문의 검증 오류(CR·LF, 1 MiB 초과, 누락)도 위치가 `/content`다.
- 암호화 모드의 처리 순서는 수신자·발신자 검증, 복호화, 복호화한 제목·본문 검증, 지문 계산, 등록이다(ADR-0008 결정 3). 같은 Key로 같은 내용을 평문 모드와 암호화 모드로 보내면 같은 요청이다(200).
- 서명(JWS)은 REST에서 쓰지 않는다. 파일 채널 전용이다(ADR-0008 결정 2).
- Mailo에 JWE 개인키를 설정하지 않은 배치는 모든 `content`를 `KID_UNKNOWN`(형식이 JWE로 해석되지 않으면 `DECRYPTION_FAILED`)으로 거부한다. 호출처는 평문 모드를 쓴다.
- `Content-Type`이 `application/json`이 아니면 415다.

응답.

- 등록(202, 200)과 조회는 같은 `Job` 스키마를 쓰고 `Location: /jobs/{jobId}`를 반환한다. 본문과 수신자는 포함하지 않는다.
- `Job` 필드: `jobId`, `idempotencyKey`, `status`, `attempts`, `createdAt`, `expiresAt`, `sentAt`, `failedAt`, `failureReason`, `lastError`, `rejectedRecipients`.
- `attempts`는 차단기를 연 계정 상태 오류 시도를 뺀 횟수다. 차단기가 `closed`로 남은 계정 상태 오류는 포함한다(ADR-0007 구현 중 확정 8).
- `failureReason`은 `PERMANENT_ERROR`, `MAX_ATTEMPTS_EXCEEDED`, `ACCOUNT_ERROR_REPEATED`, `EXPIRED`다.
- `lastError`는 `category`(`TRANSIENT`, `PERMANENT`, `ACCOUNT`, `LEASE_EXPIRED`), `smtpCode`, `enhancedCode`, `occurredAt`이다. SMTP 응답 텍스트는 API에 노출하지 않는다.
- `rejectedRecipients`는 `address`, `smtpCode`, `enhancedCode`다. 응답 텍스트는 없다.
- 오류 `type`은 `urn:mailo:problem:<이름>` 8종이다. 401은 `WWW-Authenticate: Bearer`를 반환한다.
- 예상하지 못한 서버 오류(DB 장애 포함)는 모두 503(`service-unavailable`)이다. 500은 쓰지 않는다. 호출처는 같은 Key로 재시도한다(ADR-0005 결정 5).
- 정의되지 않은 필드(`UNKNOWN_FIELD`)의 `pointer`는 빈 문자열(본문 전체)이다. 필드 이름도 요청에서 온 값이라 되돌려 주지 않는다.
- `content`의 형식(점으로 구분한 다섯 부분)이 틀리면 복호화 전에 `INVALID_FORMAT`이다. 형식은 맞지만 헤더를 해석할 수 없으면 `DECRYPTION_FAILED`다.
- 큐 내부의 실패 원인은 `failureReason`으로 변환한다. `PERMANENT`는 `PERMANENT_ERROR`, `ATTEMPTS_EXHAUSTED`는 `MAX_ATTEMPTS_EXCEEDED`, `ACCOUNT_REPEATED`는 `ACCOUNT_ERROR_REPEATED`다. `EXPIRED`는 그대로다.
- 404는 없는 ID, 다른 호출처의 작업, 보존 기간이 지나 삭제된 작업을 구분하지 않는다.
- 409 응답에 먼저 등록된 작업의 `jobId`를 넣는다(같은 호출처 작업이다).
- 검증 오류 코드는 `REQUIRED`, `INVALID_FORMAT`, `TOO_LONG`, `TOO_MANY`, `TOO_LARGE`, `CONTROL_CHARACTER`, `UNKNOWN_FIELD`, `ATTACHMENTS_NOT_SUPPORTED`, `CONFLICTING_FIELDS`, `DECRYPTION_FAILED`, `KID_UNKNOWN`, `CALLER_MISMATCH`, `FROM_NOT_ALLOWED`다. `FROM_NOT_ALLOWED`는 `from`이 호출처의 허용 발신 주소(기본 발신 주소 + `allowedFrom`)가 아닐 때이고 위치는 `/from`이다. `replyTo`는 제한하지 않는다.

이벤트 피드.

- 응답은 `{events, nextCursor, hasMore}`다. 이벤트가 없으면 `nextCursor`는 요청의 `after`이고, `after`도 없었으면 `null`이다. `hasMore`를 추가했다.
- `type` 필터는 반복해서 여러 종류를 받는다. cursor는 필터와 무관하므로 필터 조합마다 따로 저장한다.
- `limit`은 기본 100, 최대 500이다. cursor는 최대 256자다.
- `eventId`는 문자열이고 순서 의미가 없다. 이벤트의 `recipients`는 `to`, `cc`, `bcc`를 모두 담는다.
- `INTAKE_REJECTED` 필드는 `rejectionId`, `idempotencyKey`(없으면 `null`), `fileName`, `fileSize`, `sha256`, `reasonCode`다. 사유 코드 11종(`MALFORMED` 등)의 이름은 이 계약이 정했다.
- 파일 채널(2026-11-23 구현)의 거부 기록 규칙. `idempotencyKey`는 파일에서 파싱할 수 있고 형식을 지킨 경우에만 있다. 서명이 `required`인 호출처의 파일은 서명을 확인한 뒤의 사유일 때만 있다. 서명을 확인하지 못한 파일은 `null`이어서 `fileName`과 `sha256`으로 식별한다. `sha256`은 파일 전체의 해시이지만 `SIZE_EXCEEDED`(처음 2 MiB + 1바이트)와 내용을 읽지 않은 항목(빈 입력의 해시, `fileSize` 0)은 예외다. 일반 파일이 아닌 항목은 `MALFORMED`다. 같은 이름과 같은 `sha256`의 파일을 다시 넣어도 거부 기록과 이벤트는 새로 생기지 않는다(ADR-0004 "구현 중 확정" 4·5·6).

헬스.

- 인증 없이는 `status`, `checks.database`, `circuitBreaker.state`만 반환한다. 유효한 Bearer가 있으면 `openUntil`, `lastReason`, `eventFeed`를 더한다.
- `eventFeed`는 호출처 자신의 피드 지연(RQ-017)이다. `latestEventAt`은 `GET /events`가 반환할 수 있는 최신 이벤트 시각이고 `lagSeconds`는 서버 현재 시각에서 그 시각을 뺀 초다. 이벤트가 없으면 둘 다 `null`이다. 새 이벤트가 없어도 값이 커진다.
- 이유: `openUntil`과 `lastReason`은 계정 인증 실패, 한도 소진 같은 SMTP 계정 상태를 드러낸다. 외부 탐색을 막기 위해 인증을 요구한다.
- 차단기 `open`·`half_open`이어도 준비 상태는 200이다. 등록과 조회는 정상이고, 오케스트레이터가 인스턴스를 내리지 않게 하기 위해서다.
- DB가 끊기면 503이고 `circuitBreaker.state`는 `unknown`이다.
- `lastReason`은 `AUTH_FAILED`, `TLS_FAILED`, `CONNECTION_FAILED`, `QUOTA_DAILY`, `QUOTA_BURST`, `OTHER`다.
- `/health/ready`에 `Authorization` 헤더를 보냈는데 자격이 틀리면 401이다. `/health/live`는 헤더를 보지 않는다.
- `openUntil`은 상태가 `open`일 때만 값이 있고 `half_open`에서는 `null`이다. `lastReason`은 `closed`이면 `null`이다(구현 기준, openapi 설명과 같다).

## 계약과 구현의 불일치

2026-11-23 코드·테스트를 읽어 대조한 결과다. 이 문서 작업에서 코드는 고치지 않았다. 판단은 "어느 쪽을 맞추는 것이 맞는가"다.

| 항목 | 계약 | 구현 | 판단 |
| ---- | ---- | ---- | ---- |
| `rejectionId` 형식 | `format: uuid` | DB `bigint` 식별자를 문자열로 낸다(`eventId`와 같은 방식) | 계약을 고쳤다. `rejectionId`를 불투명 문자열로 바꿨다. 구현을 uuid로 바꾸면 마이그레이션이 필요하고 호출처는 값을 해석하지 않는다. 파일 채널(2단계) 전에는 이 이벤트가 생기지 않아 호환 영향이 없다 |
| `RejectedRecipient.smtpCode` | `integer`, `null` 불가 | 거부 응답을 찾지 못한 수신자는 `null`이다 | 계약을 고쳤다. `[integer, 'null']`로 완화했다. `LastError.smtpCode`와 같은 방식이다 |
| `PERMANENT_ERROR` 의미 | 메시지 단계의 `5xx` | Mailo 내부 오류(독성 작업)도 `PERMANENT_ERROR`이고 `lastError.smtpCode`가 `null`이다 | 구현을 유지하고 계약 설명을 보완했다(openapi `FailureReason`) |
| JWE `content` | 암호화 모드 지원 | 구현했다(2단계). 개인키 미설정 배치는 `KID_UNKNOWN` 400 | 계약과 구현이 같다. 1단계의 임시 `KID_UNKNOWN` 처리는 제거했다 |
| 오류 위치 | `pointer` 예시는 필드 위치만 있다 | `UNKNOWN_FIELD`는 빈 문자열 | 구현을 유지하고 계약 설명을 보완했다(openapi `ValidationErrorItem.pointer`) |
| 예상 밖 오류 | 500 정의 없음 | 503 | 구현을 유지한다. ADR-0005 결정 5와 같다 |
| `/health/live` 인증 | 인증 불필요 | `Authorization`을 읽지 않음 | 구현이 openapi와 같다. 이 README를 openapi에 맞췄다 |

## 검증 상태

- YAML 구문, `$ref` 해소, 예시 48건의 스키마 적합성은 일회성 스크립트(ajv 8, JSON Schema 2020-12)로 확인했다. 이 스크립트는 저장소에 없다.
- OpenAPI 전용 린터(redocly, swagger-cli, spectral)는 실행하지 않았다.
- 구현 통합 테스트(`apps/mailo/test/http/rest-intake.integration-spec.ts`)가 상태 코드, 오류 `type`, 검증 오류 위치·코드, 이벤트 모양을 대조한다. openapi 스키마를 읽어 응답을 자동 검증하는 계약 테스트는 없다.
- 2026-11-23 단위 테스트 274건, 통합 테스트 116건(종단 7건 포함)이 통과했고 실패는 0건이다. 계약 변경(`rejectionId`, `smtpCode`, `eventFeed`) 뒤 실행한 결과다.
- 실제 Gmail 서버, 실제 호출처(relay) 대상 검증은 하지 않았다.
- 위 수치는 계약 변경 시점의 값이다. 이후 실행 수치와 RQ별 상태는 `docs/requirements/README.md`를 따른다. 운영·연동 절차는 `docs/operations/`다.
