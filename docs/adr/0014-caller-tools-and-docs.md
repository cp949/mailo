# 호출처 도구와 문서는 프로토콜 적합성 벡터(공개 가짜 키), 키 사고 대응 절차, DB 유지보수 안내, 레지스트리 변경 절차로 정하고 레지스트리 재로드와 파티셔닝은 구현하지 않는다

## 상태

승인됨 (2026-11-24)

2026-11-24에 초안을 쓰고 같은 날 사용자가 승인했다. 열린 질문이던 10건은 이 문서가 적은 권고대로 승인했다. 승인된 값은 "미결정·확인하지 않은 것"의 "승인된 결정" 절에 모았다. 입력은 `docs/requirements/roadmap.md`의 "단계 9. 호출처 도구와 문서"다.

구현 상태(2026-11-24): 묶음 B(적합성 벡터) 구현 완료(미검증 항목 있음). 묶음 A(문서: 결정 7~9)를 작성했다(코드 변경 없음, 문서 검토와 운영 환경 실행이 남아 있다). 묶음 C(샘플 연동, 선택)는 구현 전이다. 순서는 B → C → A이고 A의 결정 7~9는 B·C와 파일이 겹치지 않아 C보다 먼저 작성했다(구현 순서 절이 허용한 선후).

- 묶음 B의 범위: 결정 1~5(벡터 범위, `vectors.json`·`README.md`, 공개 가짜 키와 production 거부, 생성 스크립트, 서버 단위 테스트와 `presentOpenFailure` 공개). 요구사항은 RQ-064·065다.
- 묶음 B에서 구현하지 않은 것: 결정 6(Java 샘플 연동), 결정 7~9(문서). 이 문서의 "구현 중 확정" 절이 묶음 B에서 정한 값을 적는다.
- 묶음 A의 범위: 결정 7(키 사고 대응, `key-management.md`), 결정 8(DB 유지보수와 로컬 측정, `db-maintenance.md`), 결정 9(레지스트리 변경 반영, `caller-onboarding.md`). 요구사항은 RQ-067~069다. "구현 중 확정"의 2026-11-24 묶음 A 절이 값을 적는다.

검증 범위는 코드·문서 읽기다(2026-11-24). 테스트, 스크립트, 쿼리, 측정을 실행하지 않았다. 아래 "배경"의 "확인한 사실"은 코드와 문서에서 읽은 것이고 "가정"은 읽지 않았거나 실행으로 확인하지 못한 것이다.

승인으로 다음 관계가 생겼다. 승인된 ADR의 결정 문구는 바꾸지 않는다.

- ADR-0008 "미확정"의 "JWE 개인키 유출 때 보존 기간 전에 이전 키를 지우는 정식 경로"를 결정 7이 닫는다. 경로를 새로 만들지 않고 현재 동작과 운영 판단 절차를 정식 절차로 확정한다.
- ADR-0008 구현 중 확정 11이 "확인하지 않은 것"으로 남긴 "키 교체 중 이전 `kid`"는 결정 1·6의 벡터가 일부 닫는다(벡터가 확인하는 조합에 한정). 다른 nimbus 버전은 닫지 않는다(샘플은 10.10 하나다).
- ADR-0008 구현 중 확정 13의 "공개 샘플 키 거부"를 호출처 JWS 비밀키 외에 Mailo JWE 개인키까지 넓힌다(결정 3). 기존 규칙의 의미는 바뀌지 않는다.
- RQ-022의 미검증 항목("JWE 개인키 유출 대응 절차(미결정)")을 결정 7이 닫고, RQ-032의 한계("레지스트리는 기동 때 한 번 읽는다")는 결정 9가 현 상태로 유지한다.
- 새 RQ는 RQ-064~069다. RQ-064(적합성 벡터와 서버 고정)와 RQ-065(벡터 키의 production 거부)는 묶음 B, RQ-066(Java 샘플 연동, 선택)은 묶음 C, RQ-067(키 분실·유출 대응)·RQ-068(DB 유지보수 안내)·RQ-069(레지스트리 변경 반영)는 묶음 A의 범위다. 이 번호는 승인 때 정했다.

## 배경

### 확인한 사실

모두 2026-11-24에 코드와 문서를 읽어 확인했다.

- `openRequest`(`envelope/open-request.ts`)는 REST와 파일 채널의 공용 판정 함수다. DB를 쓰지 않는다. 순서는 JWS 구조 파싱, 서명 검증(`caller`, `iat` 포함), payload 스키마 검증, 복호화, 복호화한 제목·본문 검증, 지문 계산이다(ADR-0008 결정 3).
- 실패 사유 코드는 11종이다(`envelope/reasons.ts`의 `OPEN_REQUEST_REASONS`): `MALFORMED`, `SIGNATURE_REQUIRED`, `SIGNATURE_INVALID`, `CALLER_MISMATCH`, `IAT_OUT_OF_RANGE`, `VALIDATION_FAILED`, `ATTACHMENTS_NOT_SUPPORTED`, `IDEMPOTENCY_KEY_MISSING`, `IDEMPOTENCY_KEY_INVALID`, `KID_UNKNOWN`, `DECRYPTION_FAILED`.
- 호출처가 보는 값은 이 11종과 다르다. 파일 채널은 `toRejectionReason`으로 `SIGNATURE_REQUIRED`를 `SIGNATURE_INVALID`로, `KID_UNKNOWN`을 `DECRYPTION_FAILED`로 합쳐 `INTAKE_REJECTED`의 `reasonCode`로 낸다. 그래서 `openRequest`가 만들 수 있는 `reasonCode`는 9종이다. `RejectionReason`(`openapi.yaml`) 11종 중 `SIZE_EXCEEDED`, `FINGERPRINT_MISMATCH`는 `openRequest` 밖(파일 읽기, 등록)에서 나온다.
- REST는 `presentOpenFailure`(`intake/open-failure.ts`)가 같은 실패를 `errors[{pointer, code}]`로 바꾼다. 암호 관련 실패는 위치가 `/content`이고 서명·`iat` 사유는 REST에서 나오지 않는다. `presentOpenFailure`는 `intake/index.ts`가 공개하지 않는다.
- 서명은 파일 채널 전용이다. flattened JWS(`protected`, `payload`, `signature`), `alg`는 `HS256`, protected header는 `alg`·`kid`·`caller`·`iat` 네 필드뿐이다. JWE는 compact, `alg` `RSA-OAEP-256`, `enc` `A256GCM`, protected header에 `kid`·`caller`를 둔다(`envelope/jws.ts`, `envelope/jwe.ts`).
- JWE 암호문은 `RSA-OAEP-256`의 무작위 요소 때문에 같은 평문·키에서도 매번 다르다. HS256 서명은 같은 입력에서 같다.
- 지문은 `HMAC-SHA256(서버 지문 키, 정규화한 평문 요청)`이다. 호출처는 계산할 수 없다. 암호문은 비교 대상이 아니다. 같은 Key로 다시 암호화한 같은 내용의 요청은 기존 작업(200)이다(`docs/api/README.md` "Key 계약 요약").
- 기존 테스트(`test/envelope/open-request.spec.ts`)는 사유별 경로를 이미 단언한다. 단 테스트마다 RSA 3072 키를 새로 만들고(`test/support/envelope.ts`의 `rsaKey`) 암호문과 서명을 그 자리에서 만든다. 저장된 값을 고정한 벡터는 지문 정규화의 골든 값(우선순위 도입 전 값)뿐이다.
- Java 샘플(`samples/spring-boot-relay/`)은 nimbus-jose-jwt 10.10으로 만든 JWE·JWS를 Mailo(`jose` 6.2.18)에 보내 수신까지 확인한다(`verify/run-e2e.sh`, 자동 테스트 아님). Gradle 단위 테스트(`EnvelopeTest` 등)는 nimbus끼리 왕복해 형식 필드만 확인한다. Mailo가 낸 값을 읽는 테스트는 없다.
- 저장소에 개인키 PEM 파일이 없다(`BEGIN PRIVATE KEY`, `BEGIN RSA PRIVATE KEY` 검색 결과 0건). 개발용 키는 `scripts/gen-dev-keys.mjs`가 만들고 `.dev-keys/`는 `.gitignore` 대상이다.
- 공개 샘플 키 거부(`NODE_ENV`가 `development`·`test`가 아니면 거부)는 `config/key-loader.ts`의 `isPublicOrWeakKey`가 정한다. 목록은 DB 본문 키·지문 키의 샘플 둘(`PUBLIC_SAMPLE_KEYS`)과 "같은 바이트가 반복된 키"다. 호출처 JWS 비밀키도 같은 함수로 검사한다(`callers/registry.ts`). Mailo JWE 개인키에는 이 규칙이 없다. `envelope/key-file.ts`는 `NODE_ENV`를 보지 않지만 `LoadEnvelopeKeysOptions.env`를 받는다.
- JWE 개인키는 수집 시점에만 쓴다. 복호화한 본문은 DB 본문 키(AES-256-GCM)로 다시 암호화해 저장한다. 큐에 있는 본문은 JWE 개인키와 무관하다(`deployment.md` "백업과 복구", ADR-0008 결정 6).
- 이전 JWE 개인키를 보존 기간(`MAILO_RECORD_RETENTION_SECONDS`, 기본 30일) 전에 지우는 정식 경로는 없다. `removed`의 `removedAt - retiredAt`이 보존 기간보다 짧으면 기동이 거부된다. 우회 절차(보존 기간 축소, `removed` 없이 항목만 삭제)와 대가는 `key-management.md` "JWE 개인키 유출"에 있다.
- `key-management.md`의 "유출 대응" 절은 키 종류별 한 줄 요약과 JWE 개인키 절차를 갖고 있다. 분실(복구할 수 없는 상태) 절차는 없고 마지막 줄이 "유출 대응 절차를 정하지 않았다"다.
- 마이그레이션 `0001`~`0016`에 `autovacuum`·`fillfactor` 설정이 없다. `mail_attempts`와 `mail_events`는 `mail_jobs(id)`를 `ON DELETE CASCADE`로 참조한다. `mail_jobs`에 `UNIQUE (caller_id, idempotency_key)`가 있다. `mail_events.txid`(`xid8`)와 cursor는 `pg_snapshot_xmin`에 의존한다(ADR-0006 결정 7).
- 보존 삭제와 본문 삭제는 `queue/maintenance.ts`가 1000건 배치로 돌린다. 작업 행은 종결 후 30일 뒤 지우고 본문 컬럼은 종결 후 1일 뒤 `NULL`로 바꾼다. 감사 테이블(`mail_ops_audit`)은 자동 삭제가 없다(ADR-0012 결정 8).
- 레지스트리(`callers.json`)는 기동 때 한 번 읽는다. 호출처 ID 목록이 REST 인증, 파일 폴러, Worker 할당·계정 매핑, `/metrics` 시리즈 시드로 흘러간다(`app.module.ts`). 핫 리로드·`SIGHUP`·파일 감시 코드는 없다. 레지스트리의 모르는 필드는 거부되므로 새 필드가 든 레지스트리를 이전 버전이 읽으면 기동하지 못한다(ADR-0009 결정 10).
- 운영 배포 이력이 없다(ADR-0008 구현 중 확정 12).

### 가정

- 저장소에 개인키 PEM을 커밋하면 GitHub의 secret scanning이나 push protection이 걸릴 수 있다. 확인하지 않았다. push는 사용자가 한다.
- 파티셔닝 제약(파티션 키가 유니크·기본키 제약에 들어가야 한다는 PostgreSQL 규칙)은 PostgreSQL 문서 지식이다. 이 저장소의 서버(17.11)로 확인하지 않았다.
- 보존 삭제 뒤 테이블 팽창이 기본 autovacuum 설정에서 회수되는지는 측정하지 않았다.
- 롤링 재시작 중 일부 인스턴스가 이전 레지스트리를 쓰는 구간의 동작은 코드에서 추론했고 실행하지 않았다(호출처 키 인증은 인스턴스마다 로드한 해시로 판정한다).

## 결정

결정 문구는 선택지의 권고를 따랐고 승인됐다. 승인 뒤에는 바꾸지 않는다.

1. **적합성 벡터의 범위는 `openRequest`가 내리는 판정 중 호출처가 관측하는 부분이다. 파일 채널(JWS 서명 여부, JWE 여부)과 REST(JWE)를 모두 담는다.**
   - 문제: "프로토콜 적합성"의 경계를 정해야 한다. 경계가 넓으면 서버 내부 사정이 벡터에 새고, 좁으면 호출처 구현 실수를 못 잡는다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. `openRequest` 판정만(서명·`caller`·`iat`·복호화·스키마·본문 검증) | 권고. 호출처가 틀리기 쉬운 곳(헤더 필드, 숫자 `iat`, `kid`, `caller`, `alg`)이 모두 들어가고 DB와 파일 시스템이 필요 없다 |
     | B. A + 파일 이름·크기·폴더·권한·`Idempotency-Key` 중복 | 환경(파일 시스템, DB)이 필요하고 ADR-0004·0005가 이미 통합 테스트로 확인한다 |
     | C. A + SMTP 발송까지 종단 | 기존 `run-e2e.sh`와 겹치고 벡터가 환경에 묶인다 |

   - 결정 문구(A):
     - 벡터가 판정하는 것: JWS 구조 파싱, 서명 검증, `caller` 일치, `iat` 허용 기간·오차, JWE `alg`·`enc`·`kid`·`caller`, 복호화 평문의 필드 집합, 첨부 거부, 복호화한 제목의 줄바꿈 거부, 파일 채널의 `version`·`idempotencyKey` 형식.
     - 벡터에 넣지 않는 것: 지문(서버 비밀키 HMAC이라 호출처가 계산·검증할 수 없다), 파일 이름·크기·권한, Key 중복, 수신자·발신 주소 허용 정책(`allowedFrom`, `allowedRecipientDomains`), 한도 경계 값(바이트 상한 등).
     - 기대 판정은 호출처가 관측하는 값으로 쓴다. 파일 채널은 `INTAKE_REJECTED`의 `reasonCode`(9종 중 하나), REST는 `errors[{pointer, code}]`다. 서버 내부 사유 코드(`SIGNATURE_REQUIRED`, `KID_UNKNOWN` 등 11종)는 참고 필드로 함께 적는다.
     - 수락 판정은 복호화·검증을 마친 평문 필드(`subject`, `text`, `html`, 수신자, 발신자)를 기대값으로 적는다.
     - 모든 사유 코드(`OPEN_REQUEST_REASONS` 11종)가 적어도 한 케이스에서 나온다.

2. **벡터는 `docs/api/conformance/vectors.json` 한 파일과 같은 폴더의 `README.md`로 둔다. 케이스는 입력을 문자열로 풀어 쓰고 `schemaVersion`을 갖는다.**
   - 문제: 파일 형식, 위치, 변경 규칙을 정해야 한다. 호출처는 Java 등 다른 언어다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 단일 JSON(키, 설정, 케이스 배열) | 권고. 언어 중립이고 한 파일로 가져간다. 케이스 단위 diff를 본다 |
     | B. 케이스마다 파일(`cases/<id>/input.json`, `expect.json`)과 키 PEM 파일 | 파일 수가 늘고 호출처가 폴더 구조를 배워야 한다. 파일 내용을 그대로 입력으로 쓰기는 쉽다 |
     | C. 언어별 테스트 코드(Java·TypeScript)만 | 언어마다 유지해야 하고 다른 언어 호출처가 쓰지 못한다 |

   - 결정 문구(A):
     - 최상위: `schemaVersion`(정수 1), `profile`(`jws`: `HS256`, `jwe`: `RSA-OAEP-256`·`A256GCM`·RSA 3072), `settings`(`iat.maxAgeSeconds` 604800, `iat.skewSeconds` 300), `keys`, `cases`.
     - `keys`: Mailo JWE 키 쌍(`kid`, `privateKeyPem`, `publicKeyPem`)과 호출처별 JWS 비밀키(`callerId`, `kid`, `secretBase64`)다.
     - 케이스: `id`(안정적인 kebab-case), `title`(한국어 한 줄), `channel`(`file`·`rest`), `callerId`, `signatureMode`(`required`·`none`), `nowEpochSeconds`, `input`, `expect`.
       - `input`: 파일은 파일 내용 전체(UTF-8 JSON 텍스트)를 문자열 `fileText`로 둔다. REST는 `body`(객체)다. 바이트가 그대로 보존돼야 하는 입력이라 파일은 문자열로 쓴다.
       - `expect`: `accepted`(불리언), 수락이면 `request`(평문 필드), 거부이면 `reasonCode`(파일) 또는 `errors`(REST)와 참고용 `internalReason`.
       - JWS 케이스는 `signingInput`(`protected` + `.` + `payload`)과 기대 `signature`도 `input` 옆의 `jws`에 적는다. 호출처가 HMAC 구현을 서버 없이 확인한다. 서명은 HS256이라 결정적이다.
     - 케이스 `id`는 바꾸지 않는다. 기대 판정을 바꾸는 변경은 호출처 계약 변경이다. 새 ADR이나 기존 ADR의 "구현 중 확정"에 근거를 적는 변경으로만 한다. 형식이 바뀌면 `schemaVersion`을 올린다.
     - `README.md`는 케이스 목록, 읽는 방법, 호출처 구현에서 확인하는 절차를 쓴다. 절차에는 `openssl dgst -sha256 -hmac`으로 서명 입력을 검증하는 방법을 포함한다.
     - `docs/`는 oxfmt 대상이 아니므로 파일은 생성 스크립트가 2칸 들여쓰기로 쓴다.

3. **벡터의 키는 이 용도 전용의 공개 가짜 키이고, 같은 키를 운영에서 쓰지 못하게 기동 거부 규칙을 넓힌다.**
   - 문제: 복호화 벡터에는 개인키가 필요하다. 저장소에 개인키가 처음 들어가고, 이 키를 누가 운영에 쓰면 모든 호출처의 JWE가 공개 키로 풀린다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 벡터 전용 키 쌍을 JSON에 넣고, 기동 때 Mailo JWE 개인키와 호출처 JWS 비밀키가 그 키와 같으면 `NODE_ENV`가 `development`·`test`가 아닌 환경에서 거부한다 | 권고. 기존 "공개 샘플 키" 규칙과 같은 방식이다 |
     | B. 개인키 없이 암호문과 평문만 싣는다 | 호출처가 복호화로 형식을 확인하지 못한다. JWE 적합성의 핵심이 빠진다 |
     | C. 거부 규칙 없이 문서로만 경고한다 | 실수를 막는 수단이 없다. 기존 샘플 키는 모두 코드로 막는다 |
     | D. 테스트가 키를 생성하고 벡터는 구조만 싣는다 | 고정 암호문이 없어 "골든"이 아니다 |

   - 결정 문구(A):
     - 키는 Mailo JWE 쌍 둘(`kid` `conformance-1`, `conformance-2`: 키 교체 중 이전 `kid` 케이스용), 호출처 JWS 비밀키 셋(호출처 둘, 한 호출처에 `kid` 둘)이다. 값은 이 저장소에서만 쓰는 공개 가짜 값이다.
     - JWS 비밀키는 32바이트 텍스트(예: `conformance-…`로 시작하는 읽을 수 있는 문자열)이고 `config/key-loader.ts`의 `PUBLIC_SAMPLE_KEYS`에 더한다. 호출처 레지스트리가 같은 함수로 거부하므로 코드는 한 곳이다. 같은 바이트 반복 규칙에 걸리지 않는 값을 쓴다.
     - JWE 개인키는 새 규칙으로 거부한다. 판정은 공개키(SPKI DER)의 SHA-256을 `envelope/key-file.ts`에 상수로 두고 비교한다. 상수는 개인키가 아니라 해시다. `LoadEnvelopeKeysOptions.env`의 `NODE_ENV`로 엄격 여부를 정하고(`development`·`test`가 아니면 거부), 오류에는 `envelope keys[i]` 위치만 쓴다.
     - 테스트가 `vectors.json`의 공개키 해시와 상수가 같음을 확인한다. 벡터를 다시 만들면 상수가 어긋나 테스트가 실패한다.
     - `kid` 이름으로는 거부하지 않는다. 운영자가 같은 `kid`로 다른 키를 쓸 수 있어야 하고 이름은 신뢰 근거가 아니다.
     - 벡터에 실제 운영 키, 실제 SMTP 인증 정보, 실제 주소(`example.com` 등 예약 도메인 외)를 넣지 않는다. 수신자·제목·본문은 canary 성격의 가짜 문자열이다.
     - `key-management.md`의 "공개 샘플 키" 목록(키 종류 표 아래 기동 거부 설명, JWS 비밀키 절)에 벡터 키를 더한다.

4. **벡터는 생성 스크립트 `apps/mailo/scripts/gen-conformance-vectors.mjs`로 만들고 결과를 커밋한다. 재생성 결과의 바이트 일치는 요구하지 않는다.**
   - 문제: 손으로 만들면 오류가 나고 JWE는 암호문이 비결정적이다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 스크립트가 `jose`로 한 번 생성, 결과 커밋, 서버 테스트가 커밋된 값을 검증 | 권고. 기존 `gen-dev-keys.mjs`와 같은 위치·방식이다 |
     | B. 손으로 작성 | JWS 서명·base64url·JWE 변조 케이스를 정확히 만들기 어렵다 |
     | C. CI에서 재생성해 diff 검사 | JWE가 비결정적이라 항상 다르다 |
     | D. 결정적 JWE(고정 IV·CEK) | `jose`가 지원하지 않는다. 직접 암호 형식을 만들면 RQ-029 규칙에 어긋난다 |

   - 결정 문구(A):
     - 스크립트는 케이스 정의와 기대값을 코드로 갖는다. 서버 코드(`src/`)를 import하지 않는다. 기대값을 서버 출력에서 가져오면 서버 오류가 벡터에 굳는다.
     - 기본은 `vectors.json`의 기존 키를 재사용한다. 키를 새로 만드는 옵션을 별도로 둔다.
     - JWS는 서명 입력을 직접 계산한다(`HMAC-SHA256`). 변조 케이스는 정상 케이스에서 한 곳만 바꿔 만든다. JWE는 `jose`의 `CompactEncrypt`로 만들고 변조 케이스는 암호문 부분을 바꾼다.
     - 케이스 정의를 바꿀 때만 재생성한다. 재생성하면 모든 JWE 암호문이 바뀌고 diff가 커진다. 리뷰어는 `id`와 `expect` 변화를 본다.

5. **서버 코드는 단위 테스트가 벡터를 통과해야 한다. 테스트는 DB가 필요 없고 `pnpm test`에 들어간다.**
   - 문제: 벡터가 문서로만 있으면 서버 변경으로 판정이 바뀌어도 알 수 없다.
   - 결정 문구:
     - `apps/mailo/test/envelope/conformance-vectors.spec.ts`가 `docs/api/conformance/vectors.json`을 읽고 모든 케이스를 `openRequest`에 실제 키링·고정 시각(`nowMs`)으로 넣는다. 파일 케이스는 `toRejectionReason`, REST 케이스는 `presentOpenFailure`로 기대값과 비교한다.
     - `presentOpenFailure`를 `intake/index.ts`로 공개한다. 이 공개 하나가 코드 변경이다. 대안은 REST 케이스를 HTTP 통합 테스트로 도는 것이고 환경(PostgreSQL)이 필요해 채택하지 않는다.
     - 테스트가 함께 확인하는 것: 케이스 `id` 중복 없음, `OPEN_REQUEST_REASONS` 11종이 모두 한 번 이상 나옴, 벡터 JSON에 `fingerprint` 키가 없음, 벡터 공개키 해시와 상수 일치(결정 3), 벡터의 JWE 개인키·JWS 비밀키를 production 환경 변수로 주면 기동 설정 검증이 거부함.
     - 테스트 제목은 한국어로 쓰고 RQ·ADR을 참조한다. 서버가 케이스를 틀리게 판정하면 실패 메시지는 케이스 `id`와 기대·실제 사유 코드만 낸다(요청 값은 내지 않는다).
     - 벡터 파일 변경은 `docs/api/`와 테스트 입력이 한 변경 안에서 같이 바뀐다. 기대값을 고쳐 테스트를 통과시키는 변경은 결정 2의 계약 변경 규칙을 따른다.

6. **Java 샘플은 벡터를 소비하는 Gradle 단위 테스트를 더한다. 이 테스트는 별도 묶음이고 Mailo CI 밖이다.**
   - 문제: Mailo(`jose`)가 자기 벡터를 통과하는 것은 같은 라이브러리끼리의 확인이다. 독립 구현(nimbus)이 같은 벡터를 읽는지가 상호 운용의 증거다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 샘플 Gradle 테스트가 `vectors.json`을 읽어 nimbus로 JWS 검증·JWE 복호화를 하고 기대 평문과 비교한다 | 권고. 호출처가 쓰는 라이브러리 버전의 독립 증거다. 샘플은 Mailo 코드를 import하지 않는다는 규칙을 지킨다(JSON 파일만 읽는다) |
     | B. 연동하지 않는다 | 비용이 없다. 독립 구현 증거는 `run-e2e.sh` 한 조합뿐이다 |
     | C. 벡터를 샘플 `src/test/resources`에 복사한다 | 두 파일이 어긋난다 |

   - 결정 문구(A):
     - 테스트는 저장소 상대 경로(`../../docs/api/conformance/vectors.json`)를 기본으로 읽고 시스템 속성으로 바꿀 수 있다. 파일이 없으면 skip하지 않고 실패한다.
     - 대상은 수락 케이스와 JWS 변조 케이스, JWE 복호화 케이스다(서버 판정이 아니라 nimbus의 검증·복호화 결과가 기대와 맞는지). Mailo의 사유 코드 판정은 Java에서 재현하지 않는다.
     - `samples/spring-boot-relay/`를 바꾸므로 `docs/agents/verification.md`에 따라 `verify/run-e2e.sh`를 L3로 돌린다(Docker, JDK 21).
     - 샘플 README의 "확인하지 않은 조합"과 ADR-0008 구현 중 확정 11은 이 테스트가 확인한 범위(nimbus 10.10, 키 교체 중 이전 `kid`의 복호화)로 갱신한다. 샘플은 pnpm·turbo·CI 대상이 아니라는 규칙은 그대로다.

7. **키 분실·유출 대응은 키 종류와 사건별 절차를 `key-management.md`에 쓰고 코드는 바꾸지 않는다. JWE 개인키의 조기 삭제용 정식 경로는 만들지 않는다.**
   - 문제: ADR-0008·RQ-022에 "유출 대응 절차 미결정"이 남아 있다. 현재 문서는 JWE 개인키 유출 절차를 갖고 있고 분실 절차와 영향 평가가 없다.
   - 선택지(JWE 개인키의 보존 기간 전 삭제):

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 정식 경로를 만들지 않는다. 현재 기동 검증과 우회 절차를 정식 운영 판단으로 확정하고 "조기 삭제는 보안 통제가 아니다"를 문서에 명시한다 | 권고. 아래 해석이 근거다 |
     | B. `removed[]` 항목에 `reason: "COMPROMISED"`를 추가해 보존 기간 검사를 면제한다 | 코드 변경(키 처리, 독립 리뷰 필요). 감사 증적이 필요한 운영자에게만 값이 있다 |
     | C. 키를 지우지 않고 해당 `kid`의 새 요청만 거부하는 상태(`revokedAt`)를 둔다 | 코드 변경과 새 사유 코드 또는 `KID_UNKNOWN` 재사용 결정이 필요하다. A와 같은 이유로 이득이 작다 |

   - 해석(근거): Mailo가 유출된 개인키를 계속 들고 있어도 공격자가 얻는 능력이 늘지 않는다. 공격자는 키를 이미 갖고 있고 암호화용 공개키는 공개다. 이전 `kid`로 암호화한 요청을 Mailo에 넣으려면 REST 호출처 API 키나 inbox 쓰기 권한이 필요한데 새 `kid`로도 똑같이 넣을 수 있다. 즉 조기 삭제가 막는 새 위험은 없고 잃는 것은 처리 대기 중인 이전 `kid` 요청이다. 유출의 실제 피해는 그 키로 암호화돼 이미 어딘가에 있는 암호문(호출처 outbox, NAS 파일, 프록시 로그, 백업)의 기밀성 상실이다. 이 피해는 Mailo의 키 삭제로 되돌리지 못한다. 이 해석은 코드 읽기에서 나온 것이고 위협 모델 검토를 거치지 않았다.
   - 결정 문구(A):
     - `key-management.md`의 "유출 대응"을 아래 표로 바꾼다. 항목은 키 종류, 사건(유출·분실), 영향 범위, 절차, 코드 필요 여부다.

       | 키 | 유출 | 분실(복구 불가) |
       | -- | ---- | --------------- |
       | Mailo JWE 개인키 | 새 키 쌍 발급과 `kid` 교체(현재 절차). 이전 키는 보존 기간 동안 남는다. 노출 평가: 유출 키의 `kid`로 암호화된 요청이 있던 곳(호출처 outbox, 파일 채널 폴더와 NAS 백업, 프록시·APM 로그)을 호출처와 확인한다. 큐에 저장된 본문은 영향이 없다(DB 본문 키로 재암호화됨) | 새 키 쌍 발급, 호출처에 새 `kid` 전달. 처리 대기 중인 이전 `kid` 요청은 `KID_UNKNOWN`(REST 400) 또는 거부 기록(파일, 원본 삭제)이 된다. 호출처는 같은 `Idempotency-Key`와 같은 내용을 새 `kid`로 다시 암호화해 보낸다(지문은 평문 기준이라 이미 등록된 건은 200) |
       | DB 본문 키 | 새 버전 교체(2단계 롤링). 유출된 키는 그 버전 행의 본문이 모두 지워질 때까지 남는다. 영향: 유출 시점에 DB·백업에 있던 그 버전의 미삭제 본문. 기본값에서 약 2일, 요청별 TTL을 크게 쓰면 `TTL + 1일`까지다(`MAILO_JOB_EXPIRY_MAX_SECONDS`) | 그 버전의 본문은 복원할 수 없다. 비종결 작업은 복호화 오류로 `FAILED`가 된다. 영향 작업을 `body_key_version`으로 찾고 `PENDING`·`RETRY_WAIT`은 관리 취소(`CANCELED`)로 정리한다. 호출처는 새 `Idempotency-Key`로 다시 제출한다 |
       | 지문 키 | 새 버전 교체. 유출된 키로는 DB의 지문에 후보 평문을 대입해 요청 내용을 추측할 수 있다(해석). 이전 버전은 해당 행이 지워질 때까지(기본 약 31일) 필요하다 | 그 버전의 `Idempotency-Key`로 다시 오는 요청은 비교가 예외가 돼 REST 503, 파일 `file_ingest_failed`다. 새 Key는 영향이 없다. 키 없이는 복구할 수 없고 행이 보존 기간 뒤 지워질 때까지 기다린다 |
       | 호출처 JWS 비밀키 | 새 `kid` 추가와 이전 항목 즉시 삭제(현재 절차). `iat` 허용 기간(7일) 안의 위조 파일 가능성을 호출처와 평가한다. 위조에는 inbox 쓰기 권한이 필요하다 | Mailo가 값을 갖고 있으므로 재발급이다. 호출처가 키를 잃었으면 새 키를 발급하고 이전 항목을 지운다 |
       | 호출처 API 키 | 해시 삭제와 재시작(현재 절차) | 해시만 있으므로 재발급이다 |

     - 각 칸의 절차는 번호 목록으로 풀고 `key-management.md`의 기존 교체 절차를 가리킨다. 같은 절차를 두 곳에 쓰지 않는다.
     - 키 분실·유출 때 위험 작업(DB 직접 삭제, 보존 기간 축소 후 재시작, `removed` 없이 항목 삭제)에는 위험도와 롤백 가능 여부를 적는다. 지문 키 분실 때 `mail_jobs` 행을 직접 지우는 방법은 Key 중복 방지를 없애 중복 발송을 허용하므로 이 ADR이 절차로 정하지 않는다.
     - JWE 조기 삭제(선택지 A): 보존 기간 축소 우회 절차와 대가를 표로 유지하고 "조기 삭제는 새 유출을 막지 못하고 처리 대기 요청만 잃는다"를 명시한다. `removed`에 `retiredAt`을 앞당겨 적지 않는다.
     - 이미 암호화된 큐 본문: 재암호화(rewrap) 도구는 만들지 않는다. 이유: 큐 SQL과 암호 경로를 바꾸는 변경이고 이득이 유출 키 노출 기간(약 2일)을 줄이는 데 한정된다. 백업과 덤프에 이미 있는 본문은 도구로 고치지 못한다. 재검토 조건: DB 본문 키 유출 때 짧은 노출 기간이 요구되는 운영자가 있다.
     - 기동 때 DB에 있는 키 버전의 키가 설정에 있는지 검사하는 기능은 이 단계에서 만들지 않는다. 문서의 SQL(키 버전별 건수)로 점검한다(열린 질문 7).

8. **DB 유지보수 안내는 새 문서 `docs/operations/db-maintenance.md`로 쓴다. 안내의 수치는 로컬 측정 한 번을 근거로 하고 임계값은 PostgreSQL 기본 동작을 기준으로 한다. 파티셔닝은 검토 기준만 쓰고 구현하지 않는다.**
   - 문제: 테이블 팽창과 VACUUM 점검 방법이 문서에 없다. 임계값을 근거 없이 쓰면 틀린 안내가 된다.
   - 선택지(측정):

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 측정 없이 점검 쿼리와 원리만 쓴다 | 쿼리가 실제로 동작하는지 모른다 |
     | B. 로컬 PostgreSQL 17 임시 schema에서 한 번 측정한다: 작업을 넣고 상태 전이·본문 삭제·보존 삭제를 돌린 뒤 `pg_stat_user_tables`의 `n_dead_tup`, 테이블·인덱스 크기, autovacuum 실행 시점과 회수 여부를 본다 | 권고. 점검 쿼리를 실행해 확인하고 "기본 설정에서 회수되는가"에 근거를 준다 |
     | C. 운영 크기(수백만 행)·다중 인스턴스에서 측정한다 | 환경이 없다. 안내를 막는 조건으로 삼지 않는다 |

   - 선택지(파티셔닝): 구현하지 않는다. 스키마 제약상 검토 기준만 쓴다.
   - 결정 문구(B):
     - 문서의 내용: 테이블별 갱신·삭제 패턴(위 "확인한 사실"), 점검 쿼리(`pg_stat_user_tables`, `pg_stat_activity`의 오래된 트랜잭션, 테이블·인덱스 크기, `last_autovacuum`), 판단 순서(오래 열린 쓰기 트랜잭션·prepared transaction이 vacuum 기준선과 이벤트 피드를 함께 막는다), 대응(수동 `VACUUM`, autovacuum 매개변수 조정은 DB 운영자의 몫), 하지 않는 것(`VACUUM FULL`은 `ACCESS EXCLUSIVE` 잠금이므로 점검 목록에 두지 않는다. 쓰려면 위험도를 적는다).
     - 수치는 로컬 측정값에 "로컬 단일 측정, 운영 크기 아님"을 붙여 쓴다. 측정하지 않은 임계값(예: 죽은 행 비율 N%)은 쓰지 않는다. PostgreSQL 기본값(`autovacuum_vacuum_scale_factor` 등)은 서버 문서를 가리킨다.
     - 파티셔닝 검토 기준: 구현하지 않는다. 시작 조건은 측정 가능한 신호로 쓴다(보존 삭제가 유지 주기 안에 끝나지 못해 `mail_jobs` 크기가 계속 늘어난다 등). 제약은 다음과 같다. `mail_jobs`는 `UNIQUE (caller_id, idempotency_key)`와 `id` 기본키가 있어 시간 기준 파티션 키를 넣으면 Key 유일성의 의미가 바뀐다. `mail_attempts`·`mail_events`는 `mail_jobs(id)`를 `ON DELETE CASCADE`로 참조해 파티션을 통째로 버리는 방식이 작업 보존 기간과 맞지 않는다. 이벤트 피드 cursor는 `txid`·`xmin`에 의존한다. 결론: 파티셔닝은 스키마·마이그레이션 변경이므로 새 ADR이 먼저다.
     - 감사 테이블은 자동 삭제가 없다(ADR-0012 결정 8). 이 문서가 "행 수 지표(`mailo_ops_audit_rows`)를 보고 직접 삭제하는 판단 기준"을 안내한다. 삭제 자동화는 이 단계에서 하지 않는다.
     - `deployment.md` "PostgreSQL 요건"과 `docs/operations/README.md` 표에서 새 문서를 가리킨다.

9. **레지스트리 재로드는 구현하지 않는다. 레지스트리 변경 절차(롤링 재시작과 혼용 구간의 동작)를 `caller-onboarding.md`에 쓰고, 재검토 조건을 정한다.**
   - 문제: 레지스트리 변경이 재시작 뒤 반영된다(RQ-032 한계). 롤링 재시작으로 충분한지 정해야 한다.
   - 선택지:

     | 선택지 | 판단 |
     | ------ | ---- |
     | A. 구현하지 않는다. 변경 절차를 문서화하고 재검토 조건을 둔다 | 권고. 운영 경험이 없다. 로드맵도 "운영 경험으로 판단"으로 적었다 |
     | B. `SIGHUP`으로 재로드한다 | 레지스트리를 쓰는 소비자(REST 인증, 파일 폴러 폴더, Worker 할당·계정 매핑, `/metrics` 시드)를 한꺼번에 바꿔야 하고 부분 적용을 막아야 한다. 기동 검증(키 중복, 약한 키, 계정 참조)을 재실행하고 실패하면 이전 상태를 유지해야 한다 |
     | C. 파일 감시로 자동 재로드한다 | B에 더해 쓰는 도중의 불완전 파일을 읽을 위험이 있다 |
     | D. `/ops`에 재로드 endpoint를 둔다 | 관리 토큰 범위와 감사에 새 동작이 늘고 인스턴스별 호출이 필요하다 |

   - 결정 문구(A):
     - 코드를 바꾸지 않는다.
     - `caller-onboarding.md`에 "레지스트리 변경 반영" 절을 쓴다. 내용: 변경 종류별(호출처 추가, API 키 추가·폐기, `signature.keys`, `allowedFrom`, `sendQuota24h`, `accountId`, `fileChannel`) 효력 시점. 롤링 재시작 중 인스턴스마다 레지스트리 버전이 달라, 추가한 호출처나 키가 일부 인스턴스에서 401이 될 수 있고 폐기한 키가 일부 인스턴스에서 유효할 수 있다. relay 지침이 401을 재시도하지 않는다고 정하므로(`docs/api/README.md`) 새 호출처·새 API 키는 롤링이 끝난 뒤 호출처에 전달한다. 폐기의 효력은 롤링이 끝나야 완성된다. 새 필드를 넣을 때는 코드를 먼저 모든 인스턴스에 배포한다(ADR-0009 결정 10).
     - 재시작 한 번의 비용을 문서에 적는다. 종료 순서(`pause` → drain → 풀 닫기)와 기본 상한(drain 110초, `stop_grace_period` 150초), 단일 인스턴스에서의 REST 중단 구간과 relay의 같은 Key 재시도로 흡수되는 범위다. 수치는 기존 문서의 값을 가리키고 새로 측정하지 않는다.
     - 재검토 조건(둘 중 하나): (1) 호출처 추가·폐기 같은 레지스트리 변경 때 재시작의 서비스 영향(drain 시간, 401 혼용 구간)이 운영 기록으로 문제가 된다. (2) 레지스트리 변경이 위협 대응(키 폐기 등)이라 롤링 완료 전의 부분 유효 구간이 허용되지 않는다. 조건이 생기면 새 ADR로 B~D 중 하나를 정한다.
     - 이 결정은 RQ-032의 한계 문구를 유지한다. 한계는 "기동 때 한 번 읽는다"이고 이 ADR이 그것을 의도한 동작으로 확정한다.

## 구현 순서

이 ADR이 승인된 뒤의 순서다. 작업 방식은 `AGENTS.md`의 "작업 실행"을 따른다.

- 결정 3·5는 키 처리(기동 거부 규칙)를 바꾸므로 직접 작업이 아니다. 결정 6은 `samples/spring-boot-relay/`를 바꾼다. 결정 7~9는 문서만 바꾼다.
- 로드맵 단계 하나이고 DELTA가 7개 안팎으로 예상되어 `rubber-workflow`를 권고한다. 5개 이상이므로 LEG 3개로 묶는다.
- 새 RQ는 RQ-064~069로 정했다(적합성 벡터, 벡터 키 거부, 샘플 연동, 키 사고 대응 문서, DB 유지보수 안내, 레지스트리 변경 절차). 상태 절을 따른다.

| 묶음 | 내용 | 코드 | 독립 리뷰 지점 |
| ---- | ---- | ---- | -------------- |
| B. 적합성 벡터 | (1) 공개 샘플 키 거부 규칙 확장(`PUBLIC_SAMPLE_KEYS`, JWE 공개키 해시) 단위 테스트 포함, (2) 생성 스크립트와 `vectors.json`·`README.md`, (3) 서버 고정 테스트와 `presentOpenFailure` 공개, `docs/api/README.md`·`openapi.yaml` 링크, `key-management.md`의 공개 샘플 키 설명, RQ 갱신 | 있음(키 처리, 테스트) | 기대값이 서버 출력에서 복사되지 않았는지, 케이스가 사유 11종을 모두 덮는지, 벡터 키가 운영에서 거부되는지, 벡터에 시크릿이 없는지 |
| C. 샘플 연동(선택) | nimbus로 벡터를 읽는 Gradle 테스트, 샘플 README와 ADR-0008 구현 중 확정 11의 확인 범위 갱신, `run-e2e.sh` 실행 | 샘플 테스트 | 독립 구현이 같은 벡터를 읽는지, 샘플이 Mailo 코드를 import하지 않는지 |
| A. 문서 | (1) `key-management.md` 키 사고 대응(결정 7), (2) `db-maintenance.md`와 로컬 측정(결정 8), (3) `caller-onboarding.md` 레지스트리 변경 반영(결정 9), 운영 README·`deployment.md` 링크, ADR-0008·RQ-022 상태 표기 | 없음 | 문서의 사실을 코드와 대조, 측정 방법·범위 표기, 위험 작업의 위험도·롤백 표기 |

- 순서는 B → C → A다. B가 `key-management.md`의 기동 거부 설명을 바꾸고 A가 같은 파일의 사고 대응 절을 바꾸므로 순차로 한다. A는 B·C와 파일이 겹치지 않는 부분(결정 8·9)을 먼저 시작해도 된다.
- C는 B의 벡터 파일이 확정된 뒤에 시작한다.
- 분할 이유: 코드 있음(B, C)과 없음(A)은 리뷰 관점이 다르다. B는 크기가 작아도 키 처리라 독립 리뷰가 필요하다. A는 측정이 있어 결과를 별도로 기록한다.

## 검증 계획

구현 때 다음을 확인한다. 이 ADR은 아무것도 실행하지 않았다.

- 단위(`pnpm test`): `conformance-vectors.spec.ts`(모든 케이스의 기대 판정, 사유 11종 커버리지, 벡터에 `fingerprint` 없음, 공개키 해시 일치), `key-file.spec.ts`(production에서 벡터 JWE 개인키 거부, development·test에서 허용, 오류에 키 값 없음), `signature-keys.spec.ts`(production에서 벡터 JWS 비밀키 거부).
- 변조 확인: 벡터의 기대 `reasonCode` 하나를 바꾸면 테스트가 해당 케이스 `id`로 실패하는지 한 번 확인한다(변경은 되돌린다).
- 독립 확인: 벡터 JWS의 `signingInput`이 `openssl dgst -sha256 -hmac`과 같은 서명을 내는지 확인한다. 수동이고 결과를 구현 중 확정에 적는다.
- 샘플(C): Gradle 테스트와 `verify/run-e2e.sh`(Docker, JDK 21, 자동 테스트 아님).
- 문서(A): 금지 표기 검사, 기존 SQL과 명령이 실제로 동작하는지(PostgreSQL 임시 schema), 위험 작업의 위험도·롤백 표기.
- 측정(A): 결정 8 선택지 B의 환경과 범위를 결과에 적는다. 운영 크기·다중 인스턴스는 확인하지 않았다고 적는다.
- 시크릿: 벡터 파일에 실제 키·주소가 없는지(canary 성격의 가짜 값만), 서버 테스트 실패 메시지에 요청 값이 없는지(RQ-027).

## 검토한 대안

| 결정 | 대안 | 채택하지 않은 이유 |
| ---- | ---- | ------------------ |
| 1 | 벡터에 지문 포함 | 지문 키는 서버 비밀이다. 호출처가 계산·검증할 수 없고 키를 공개하면 지문 보호가 없어진다 |
| 1 | 벡터에 파일 크기·폴더·권한 포함 | 환경 의존이다. ADR-0004 통합 테스트와 볼륨 스크립트가 확인한다 |
| 2 | 케이스별 파일 | 파일 수가 늘고 호출처가 폴더 구조를 배워야 한다 |
| 3 | 개인키 없는 벡터 | JWE 복호화를 호출처가 확인하지 못한다 |
| 3 | 거부 규칙 없이 경고 문서만 | 기존 샘플 키는 모두 코드로 막는다. 같은 수준을 지킨다 |
| 3 | `kid` 이름(`conformance-*`)으로 거부 | 이름은 신뢰 근거가 아니다. 운영자가 같은 이름을 쓸 수 있어야 한다 |
| 4 | 결정적 JWE(고정 CEK·IV) | `jose`가 지원하지 않는다. 직접 구현하면 RQ-029에 어긋난다 |
| 4 | CI에서 재생성 후 diff | JWE가 비결정적이다 |
| 5 | REST 케이스를 HTTP 통합 테스트로 | PostgreSQL이 필요하다. 판정 함수만 부르면 충분하다 |
| 6 | 벡터를 샘플에 복사 | 두 파일이 어긋난다 |
| 7 | `removed[].reason: "COMPROMISED"`로 조기 삭제 허용 | 새 유출을 막지 못한다(결정 7 해석). 키 처리 코드 변경 비용이 이득보다 크다. 감사 증적이 필요한 운영자가 나오면 재검토한다 |
| 7 | `kid`별 폐기 상태(`revokedAt`) | 같은 이유와 새 사유 코드 결정이 필요하다 |
| 7 | 큐 본문 재암호화 도구(rewrap) | 큐 SQL과 암호 경로 변경이고 백업의 본문은 고치지 못한다 |
| 7 | 기동 때 DB 키 버전과 설정 키를 대조 | 큐 SQL 읽기 경로가 늘고 기동이 DB 상태에 묶인다. SQL 점검으로 시작한다(열린 질문 7) |
| 8 | 운영 크기 측정을 선행 조건으로 | 환경이 없어 안내가 막힌다. 측정 범위를 문서에 명시하는 것으로 대신한다 |
| 8 | 파티셔닝 구현 | 스키마 제약상 설계 변경이다. 로드맵이 구현하지 않기로 했다 |
| 9 | `SIGHUP` 재로드, 파일 감시, `/ops` endpoint | 소비자가 많고 부분 적용을 막아야 한다. 운영 경험이 없다 |

## 결과

- 호출처는 `docs/api/conformance/`의 벡터로 JWS·JWE 구현을 서버 없이 확인한다. 서버 코드가 벡터와 어긋나면 `pnpm test`가 실패한다.
- 저장소에 개인키 PEM이 처음 들어간다. 운영에서 같은 키를 쓰면 기동이 거부된다(`NODE_ENV`가 `development`·`test`일 때는 허용).
- 코드 변경은 공개 샘플 키 규칙 확장, `presentOpenFailure` 공개, 생성 스크립트, 테스트다. 새 npm 의존성과 마이그레이션이 없다.
- 키 사고 대응이 키 종류·사건별 표로 정해진다. JWE 개인키의 보존 기간 전 삭제는 여전히 운영 판단이다. "조기 삭제는 새 유출을 막지 못한다"는 판단이 문서로 남는다.
- DB 유지보수 안내가 생긴다. 수치는 로컬 측정에 한정된다. 파티셔닝은 구현되지 않고 시작 조건만 남는다.
- 레지스트리는 기동 때 한 번 읽는 동작을 유지한다. 호출처는 롤링 구간의 401 혼용을 알고 절차를 따른다.
- 벡터의 JWE는 비결정적이라 재생성하면 파일 diff가 크다. 케이스 정의가 바뀔 때만 재생성한다.
- 이 ADR의 모든 동작은 구현하지 않았다.

## 미결정·확인하지 않은 것

### 승인된 결정(2026-11-24)

열린 질문이던 10건이다. 사용자가 "추천으로 진행"해 모두 권고대로 승인했다. 결정 본문과 같은 값이다.

1. 벡터 범위: `openRequest` 판정(파일 JWS·JWE, REST JWE)만 담고 지문·파일 환경·정책은 뺀다(결정 1, 권고 A).
2. 형식: `docs/api/conformance/vectors.json` 단일 파일과 `README.md`(결정 2, 권고 A).
3. 키: 벡터 전용 공개 가짜 키(JWE 둘, JWS 셋)를 넣고 production에서 거부한다(결정 3, 권고 A). 저장소 첫 개인키 PEM이다.
4. 생성: `gen-conformance-vectors.mjs`로 한 번 만들어 커밋한다. 서버 코드를 import하지 않는다(결정 4, 권고 A).
5. 서버 고정: 단위 테스트가 벡터를 통과하고 `presentOpenFailure`를 공개한다(결정 5).
6. Java 샘플: 벡터를 읽는 Gradle 테스트를 별도 묶음(선택)으로 더한다(결정 6, 권고 A).
7. 키 사고 대응: 문서로 닫고 코드는 바꾸지 않는다. JWE 조기 삭제 정식 경로, 큐 본문 재암호화 도구, 기동 때 키 버전 대조는 만들지 않는다(결정 7, 권고 A).
8. DB 유지보수: 새 문서와 로컬 측정 한 번. 파티셔닝은 구현하지 않는다(결정 8, 권고 B).
9. 레지스트리 재로드: 구현하지 않고 변경 절차만 문서화한다(결정 9, 권고 A).
10. 작업 방식: `rubber-workflow`, LEG 3개(B → C → A)(구현 순서).

### 확인하지 않은 것

- 저장소에 개인키 PEM을 커밋할 때 GitHub secret scanning·push protection이 막는지. 막으면 허용 처리나 키 표기 방식(JWK 등)을 다시 정한다.
- nimbus-jose-jwt 10.10 외 버전, `RSA-OAEP-256` 외 알고리즘, 2 MiB 근처 큰 본문에서의 벡터 동작. 벡터는 작은 본문만 쓴다.
- 지문 키 분실 때 REST 503, 파일 `file_ingest_failed`와 DB 본문 키 분실 때 `FAILED` 전이는 `key-management.md`의 코드 읽기 결과를 인용했다. 이 초안에서 코드로 다시 확인하지 않았다. 구현 때 통합 테스트로 확인한다.
- 롤링 재시작 구간의 호출처 키 401 혼용은 코드에서 추론했다. 실행하지 않았다.
- 보존 삭제 뒤 팽창의 회수 여부, 점검 쿼리의 동작. 결정 8의 로컬 측정에서 확인한다.
- 파티셔닝 제약(파티션 키와 유니크 제약)은 PostgreSQL 문서 지식이다. 서버로 확인하지 않았다.
- 실제 Gmail·Workspace, 운영 크기, 다중 인스턴스에서의 모든 항목.
- `AGENTS.md`가 가리키는 `docs/agents/verification.md`, `qq-workflow.md`, `rubber-workflow.md`는 이 브랜치(`dev` 분기)에 없고 다른 브랜치(`docs/agent-workflow`)에만 있다. 이 초안은 `verification.md`와 `rubber-workflow.md`의 앞부분만 읽었고 `dev`에 병합되기 전에는 링크가 끊긴다.

## 구현 중 확정

### 2026-11-24 묶음 B

결정 문구는 바꾸지 않는다. 구현하면서 정한 값과 결정의 해석을 적는다. 구현 순서 표와 어긋난 곳은 없다.

1. **키 구성.** Mailo JWE 키 쌍은 `conformance-1`(`role` `previous`, 키 교체 중 이전 키)과 `conformance-2`(`current`)다. 호출처 JWS 비밀키는 `alpha`(`kid` `alpha-1`·`alpha-2`)와 `beta`(`beta-1`)이고 값은 32바이트 ASCII 텍스트(`conformance-jws-<호출처>-<번호>-key-…`)다. 서명을 쓰지 않는 호출처 `gamma`는 키가 없다. 같은 바이트가 반복된 값이 아니므로 `isPublicOrWeakKey`는 `PUBLIC_SAMPLE_KEYS`의 목록으로 거부한다.
2. **결정 2의 필드에 더한 것.** 최상위 `description`·`notice`·`generator`, `keys.jwe[].role`, 서명 케이스의 `jws.hmacKid`다. `hmacKid`는 `jws.signature`를 만든 키의 `kid`이고 어느 벡터 키로도 만들 수 없는 서명(변조, `alg` `none`, `HS512`)은 `null`이다. 기대 `signature`와 함께 서명 변조 케이스를 한 형식으로 적으려고 더했다.
3. **JWE 시나리오 공유.** 같은 JWE 시나리오(현재 키·이전 키 수락, 암호 실패, 복호화한 평문 검증 실패)를 파일(서명 포함)과 REST가 각각 쓴다. 암호문은 채널마다 따로 만든다. 서명을 쓰지 않는 호출처의 JWE 파일은 수락 1건만 둔다.
4. **기대값 두 건을 입력 쪽에서 고쳤다.** 기대값을 ADR·계약에서 먼저 적고 서버 판정과 비교했을 때 두 케이스가 어긋났다. 서버 코드를 바꾸지 않았다.
   - 서명을 쓰지 않는 호출처에 JWS 봉투를 보내는 케이스: 서버는 `IDEMPOTENCY_KEY_MISSING`을 낸다. `request-schema.ts`의 사유 우선순위(Key 오류 > 첨부 > 그 밖)에 따른 것이다. 사유 우선순위까지 호출처 계약으로 굳히지 않으려고 이 케이스를 뺐다.
   - REST에서 `content`와 `subject`를 함께 보내는 케이스: `text`가 없으면 `CONFLICTING_FIELDS` 말고 `/text REQUIRED`가 더 나온다. 부수 오류에 기대가 묶이지 않도록 `text`까지 넣어 오류가 하나만 나게 했다.
5. **테스트 위치.** 결정 5와 검증 계획은 `key-file.spec.ts`·`signature-keys.spec.ts`를 따로 적었다. 벡터 파일을 읽는 테스트를 한 곳에 두려고 `test/envelope/conformance-vectors.spec.ts` 한 파일이 벡터 키 거부를 확인한다. JWE 개인키는 `parseEnvelopeKeys`, JWS 비밀키는 `parseCallerRegistry`로 확인하고 production(`NODE_ENV` 없음 포함)에서 거부, `development`·`test`에서 허용, 오류에 키 값·`kid`가 없음을 본다. DB 본문 키·지문 키 로더(`loadKeyRing`)는 같은 `isPublicOrWeakKey`를 쓰지만 벡터 키를 그 로더에 넣는 테스트는 없다(코드 읽기).
6. **오류 메시지.** `envelope keys[<i>]: 저장소에 공개된 샘플 JWE 키라 production에서 쓸 수 없다(...)`다. 변수 이름·`kid`·키 값은 담지 않는다.
7. **README 목록.** `docs/api/conformance/README.md`의 케이스 표는 생성 스크립트가 아니라 사람이 옮긴다. 단위 테스트가 모든 케이스 `id`가 표에 있음을 확인한다.
8. **RED와 변이 확인(2026-11-24).** 구현 전 RED는 모듈 export 누락과 벡터 파일 없음으로 스위트가 로드되지 않은 것이다. 케이스 단언이 실패하는 RED는 확인하지 않았다. 대신 구현 뒤 서버 판정 규칙을 일부러 바꿔 테스트가 실패하는지 두 번 수동으로 확인하고 되돌렸다.
   - `openJws`의 `iat` 상한 비교 `>`를 `>=`로 바꿨다: `file-jws-accepted-iat-max-age`가 `IAT_OUT_OF_RANGE`로 실패했다.
   - `toRejectionReason`의 `KID_UNKNOWN` 매핑(`DECRYPTION_FAILED`)을 바꿨다: `file-jws-jwe-kid-unknown`과 "reasonCode 9종" 테스트가 실패했다.
9. **독립 확인(수동, 2026-11-24).** `file-jws-accepted-plain`(`alpha-1`)과 `file-jws-accepted-rotated-kid`(`alpha-2`)의 `signingInput`을 `openssl dgst -sha256 -hmac`으로 계산한 값이 `signature`와 같았다. 단위 테스트도 같은 계산을 `node:crypto`로 모든 서명 케이스에 한다.
10. **생성 스크립트.** 처음에는 `--new-keys`로 JWE 키를 만들었고 이후 기본 경로(기존 키 재사용)로 다시 만들어 공개키 해시가 `PUBLIC_SAMPLE_JWE_KEY_SPKI_SHA256`와 같음을 확인했다.
11. **검증하지 않은 것(묶음 B).** GitHub push protection이 저장소의 개인키 PEM을 막는지(push 때 확인한다), 벡터 키로 컨테이너·`main.ts`를 실제로 기동해 거부되는지(거부 시점은 `createApp` 안 DI 팩토리이고 `loadConfig`가 아니다. 코드 읽기와 임시 시험으로 `ConfigError`가 `createApp` reject로 오는 것은 확인했다. 단위 테스트는 `parseEnvelopeKeys`·`parseCallerRegistry`까지 본다), JWE 쪽의 독립 구현 확인(묶음 C), 호출처가 쓰는 라이브러리와의 상호 운용.
12. **push protection 대응.** push 때 GitHub가 벡터의 개인키 PEM을 막으면 그 결과를 이 절에 기록한다. 막히면 `.github/secret_scanning.yml`의 `paths-ignore`에 `docs/api/conformance/vectors.json`을 두거나 push protection의 허용 절차와 이 폴더 `README.md`의 공개 가짜 키 안내로 대응한다. 대응 방식은 push 결과를 보고 정한다. 아직 확인하지 않았다.

### 2026-11-24 묶음 A

결정 문구는 바꾸지 않는다. 코드는 바꾸지 않았다. 구현 순서 표와 어긋난 곳은 없다(순서 B → C → A 중 A의 결정 7~9를 C보다 먼저 작성했다. 구현 순서 절이 허용한 선후다).

1. **결정 7: 문서 위치와 구성.** `key-management.md`의 "유출 대응" 절을 "키 사고 대응"으로 바꿨다. 결정 문구의 표(키 × 유출·분실)는 문서에서 "키별 요약"(노출·깨짐 요약)과 키별 소절(절차)로 나눴다. 키 종류는 결정 문구의 다섯 가지에 운영 토큰, SMTP 비밀번호, DB 비밀번호를 더했다(저장소에 있는 비밀이다). 기존 교체 절차는 다시 쓰지 않고 가리킨다.
2. **결정 7: 결정 문구와 달라진 곳.**
   - JWE 개인키 분실: 결정 문구는 "새 키 쌍 발급, 호출처에 새 `kid` 전달"이다. 문서는 분실한 항목을 `keys`에서 빼야 한다고 더했다. 항목이 남으면 개인키 변수가 없어 기동하지 못한다(코드 확인). 보존 기간 전이면 `removed`에 쓸 수 없으므로 "`removed` 없이 항목 삭제"와 같은 위험이 생긴다고 적었다.
   - 호출처 JWS 비밀키 유출: 결정 문구는 "새 `kid` 추가와 이전 항목 즉시 삭제"다. 문서는 호출처에 새 키를 먼저 전달한 뒤 한 번의 재시작으로 교체하는 순서로 적었다. 이전 키를 남기면 키를 가진 공격자가 `iat`를 현재로 넣어 만든 위조 파일이 그 키가 남아 있는 동안 통과한다(`envelope/jws.ts`는 서명 검증 뒤에 `iat`를 확인한다).
   - 호출처 API 키 유출: 결정 문구는 "해시 삭제와 재시작"이다. 문서는 호출처 정지(DB 행이라 모든 인스턴스에 바로 적용)를 먼저 하도록 더했다. 다중 인스턴스는 롤링이 끝나야 유출된 키가 모두 거부되기 때문이다. 정지는 점유(발송)만 멈춘다. 인증, 등록, `GET /jobs`·`GET /events` 조회는 계속 통과하므로 수신자 정보 읽기는 키 교체가 끝날 때까지 이어진다(`queue/claim.ts`만 정지를 읽는다).
3. **결정 7: 코드로 다시 확인한 것.** 열린 질문 "확인하지 않은 것"의 지문 키·DB 본문 키 분실 동작을 코드를 다시 읽어 확인했다. 지문 키 분실은 `queue/register.ts`의 `fingerprint` 비교가 `FingerprintError`(`UNKNOWN_KEY_VERSION`)를 던지고 REST는 `http/problem.filter.ts`의 예상하지 못한 오류 503, 파일은 `file-channel/poller.ts`의 `file_ingest_failed`다. DB 본문 키 분실은 `BodyCipherError`가 `worker/worker.ts`의 `internalFailure`로 가서 `POISON_MAX_ATTEMPTS`(3)번째 시도에서 `FAILED`가 되고 차단기는 건드리지 않는다. 통합 테스트로는 재현하지 않았다.
4. **결정 7: 새로 발견한 것.**
   - 파일 폴러의 연속 오류 예산(`MAX_CONSECUTIVE_ERRORS`, 3건)은 호출처 사이에서 공유되고 파일 하나가 성공하면 0으로 돌아간다. 폴더는 정렬 없이 읽는다. 잃은 지문 키 버전의 Key를 가진 파일이 3건 이상 쌓이면 같은 폴링의 다른 파일과 다른 호출처가 밀릴 수 있다. 코드 읽기 추정이고 실행하지 않았다. 문서에 가정으로 적었다.
   - 읽기 전용 긴 트랜잭션은 이벤트 피드를 막지 않지만 VACUUM 청소를 막는다(결정 8 측정). 기존 `deployment.md`는 피드 쪽만 적고 있었다.
5. **결정 8: 측정(2026-11-24).** 로컬 compose PostgreSQL 17.11, 임시 schema에 `0001`~`0016` 적용, 작업 20만 건, 본문 약 2 KiB(압축되지 않는 의사 난수). 앱의 점유·결과 기록·본문 삭제·보존 삭제와 같은 갱신 열의 SQL을 1000건 배치로 돌렸다. 결과와 방법, 한계는 `db-maintenance.md` "로컬 측정"이 소유한다. 요약: (1) `mail_jobs` 갱신 640,732건이 모두 HOT가 아니다. (2) 기본 autovacuum(`naptime` 60초, `scale_factor` 0.2)에서 보존 삭제가 끝난 약 60초 뒤 세 표의 `n_dead_tup`이 0이 됐다. (3) 삭제 뒤 heap 파일은 줄지 않고 10만 건 추가 삽입에도 늘지 않았다(공간 재사용). (4) 읽기 전용 `REPEATABLE READ`·쓰기 트랜잭션이 열려 있으면 `VACUUM`이 죽은 행 2만 건을 지우지 못했고 종료 뒤 지웠다. (5) 감사 테이블 10만 행은 합계 9.95 MB, 행 수 쿼리 8.0ms. 이 측정이 "확인하지 않은 것"의 "보존 삭제 뒤 팽창의 회수 여부, 점검 쿼리의 동작"을 로컬 한 번의 범위에서 닫는다. 운영 크기·다중 인스턴스는 닫지 않았다. 측정이 끝난 뒤 임시 schema만 `DROP SCHEMA`로 지웠다.
6. **결정 8: 측정으로 정한 문서 값.** 문서의 임계값은 쓰지 않았다. 파티셔닝 검토 시작 조건은 코드에서 계산한 정리 상한(한 인스턴스, 분당 2만 건 = 사이클당 20배치 × 1000건)과 점검 쿼리(`oldest_finished_age`, `retention_due`)로 썼다. 인스턴스가 여럿일 때의 합산 상한은 확인하지 않았다.
7. **결정 9: 코드로 확인한 소비자.** 레지스트리 값은 인스턴스 메모리에서 REST 인증, 파일 폴러 호출처 목록, 등록 때의 `allowedFrom`·`allowedRecipientDomains`·`accountId`, Worker의 `callerQuotas`, `/metrics` 시드가 쓴다. 결정 문구의 변경 종류 일곱 가지에 호출처 삭제와 `allowedRecipientDomains`를 더해 표를 만들었다. 롤링 중 새 `kid` 파일은 이전 레지스트리 인스턴스가 `SIGNATURE_INVALID`로 거부하고 원본을 삭제한다(코드 확인). 호출처가 같은 Key로 다시 서명해 넣으면 된다.
8. **링크와 서식 검사(2026-11-24, 수동).** 변경한 운영 문서·요구사항·ADR의 마크다운 링크와 백틱 경로를 스크립트로 확인했고 끊긴 링크가 없다. `pnpm format:check`는 통과했지만 `docs/`는 대상이 아니라 문서 변경을 검사하지 못한다.
9. **검증하지 않은 것(묶음 A).** 키 사고 절차 전체와 레지스트리 롤링 중 동작의 운영 환경·다중 인스턴스 실행, 단일 인스턴스 재시작 중 REST 중단 구간의 길이, 운영 크기에서의 DB 팽창·autovacuum, 실제 `pg_dump`·prepared transaction·복제 슬롯을 둔 VACUUM 지연, `VACUUM FULL`의 잠금, 파티셔닝 제약(PostgreSQL 문서 지식), JWE 조기 삭제 판단의 위협 모델 검토, 문서 문구의 독립 검토. 묶음 A의 RQ-067~069에는 `[x]`가 없다. RQ-068의 측정 기록·링크 검사는 수동 확인이라 `AGENTS.md`의 `[x]` 기준(코드와 자동 검증)에 맞지 않아 체크하지 않았고 나머지는 문서 검토로만 확인했다.
10. **독립 검토 반영(2026-11-24).** 코드를 다시 읽어 고쳤다. (1) 조기 삭제의 보존 기간 축소 롤백은 값만 되돌리면 안 된다. `envelope/key-file.ts`의 `checkRemoved`가 기동마다 현재 보존 기간으로 `removed`를 다시 검사하므로 줄인 값으로 쓴 `removed` 항목도 함께 빼야 한다. (2) 호출처 정지는 점유만 막고 `sendQuota24h`는 등록이 아니라 점유 때 적용된다. (3) 위험 작업(JWS·API 키 교체, 호출처 정지, SMTP 앱 비밀번호 먼저 폐기, DB 비밀번호 변경, 운영 토큰 교체)에 위험도·롤백 블록을 더했다. (4) 증거 보존 단계, JWE·JWS 교체의 롤링 완료 뒤 `kid` 전달, SMTP `AUTH` 차단기 대기(최대 30분)를 더했다. (5) 검토자의 `key-file.ts` 줄 번호는 실제 `checkRemoved` 위치로 대조했고 다르게 나온 사실은 없다. 검토자와 달리 본 점: API 키 유출의 노출 평가는 `http_request` 로그에 IP·키 식별자가 없어 정상·공격 호출을 구분하지 못한다는 한계를 문서에 적었다.
