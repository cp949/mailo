# 봉투 암호화는 JWE, 파일 서명은 호출처별 JWS로 하고, DB 본문은 AES-256-GCM으로 암호화한다

## 상태

승인됨 (2026-11-23)

1단계에서 결정 6(DB 본문 AES-256-GCM)과 결정 7(본문 삭제·보존)을 구현했다.
2단계에서 결정 1(JWE 복호화), 3(수집 순서, `openRequest`), 4(`iat` 검증과 기동 시 기간 검증), 5(개인키 키링), 8(`jose`)과 결정 2의 JWS 검증 함수를 구현했다. REST는 `content`(JWE)를 `openRequest`로 처리한다.
2026-11-23 파일 채널 폴러(`src/file-channel`)가 `openRequest`에 연결돼 JWS 파일과 JWE 파일의 수집·거부 기록까지 PostgreSQL 통합 테스트로 확인했다. 구현 세부는 "구현 중 확정" 절과 ADR-0004 "구현 중 확정"을 따른다.

- ADR-0001 결정 6의 암호화 형식이 구체화되고, ADR-0001 미확정 중 알고리즘·`kid`·키 교체·키 배포 항목이 해소된다.
- 2026-11-23 Java 호출처 샘플(nimbus-jose-jwt 10.10)과 Mailo(`jose` 6.2.18)의 상호 운용을 확인했다(구현 중 확정 11).
- 2026-11-24 ADR-0014 묶음 A: "미확정"의 JWE 개인키 조기 삭제 경로는 ADR-0014 결정 7이 닫았다. 정식 경로를 만들지 않고 현재 기동 검증과 운영 판단 절차를 확정했다(`docs/operations/key-management.md` "키 사고 대응"). 결정 문구는 그대로 둔다.
- 이 ADR의 결정 2가 ADR-0004 결정 9의 HMAC 서명을 JWS로 대체한다.
- 이 ADR의 결정 3이 ADR-0004 결정 5의 3~6단계를 대체한다.
- 이 ADR의 결정 2가 ADR-0004 결정 1의 공통 스키마 적용 위치를 `payload`로 정한다.
- 요구사항 용어표의 "그 키를 Mailo 키로 다시 암호화"를 "그 키를 Mailo 공개키로 암호화"로 바꾼다.
- 2026-11-24 ADR-0013 승인: 구현 중 확정 12(`allowedFrom`)의 기본 발신 주소는 `MAILO_SMTP_FROM`에서 호출처 계정의 `from`으로 바뀐다. 허용 집합은 `{계정 from} ∪ allowedFrom`이다(ADR-0013 결정 6). 결정 문구는 그대로 둔다.

## 배경

ADR-0001은 호출처 선택 봉투 암호화와 DB 본문 상시 암호화를 정했지만 형식은 정하지 않았다.
리뷰에서 다음 문제가 지적됐다.

- 요구사항 용어표는 일회용 키를 "Mailo 키"로 다시 암호화한다고만 적었다.
  - "Mailo 키"가 모든 호출처에 배포되는 대칭키이면, 키를 가진 호출처는 NAS나 백업의 다른 호출처 파일을 복호화할 수 있다.
  - 호출처 키 하나가 유출되면 전체가 노출된다. RQ-022가 막으려는 유출을 막지 못한다.
- ADR-0004 결정 9의 HMAC 서명은 서명 대상인 "정규화 JSON"의 규칙이 없다.
- DB 암호화는 본문만 대상으로 적어, 봉투 암호화가 보호하는 제목이 DB에서는 평문일 수 있다.
- 종결 작업의 본문 보존과 삭제 정책이 없다.

## 결정

1. **봉투 암호화는 JWE(RFC 7516)로 한다. 사용 여부는 호출처가 선택한다.**
   - Mailo 공개키로 콘텐츠 암호화 키를 암호화한다.
   - 키 암호화 `alg`는 `RSA-OAEP-256`, RSA 3072비트로 고정한다.
     - Java JCA, nimbus-jose-jwt, `jose`가 지원한다고 알려져 있다(추정, 버전 미확인).
     - `ECDH-ES+A256KW`는 채택하지 않는다. 곡선 선택과 ephemeral 키 부담이 있다.
   - 콘텐츠 암호화 `enc`는 `A256GCM`이다.
   - 헤더에 `kid`를 둔다.
   - JWE protected header에 `caller`를 넣는다. Mailo는 이 값이 요청의 `caller_id`와 같은지 확인한다.
     - 공개키는 누구나 쓸 수 있어 출처를 묶어야 한다. protected header는 AAD로 인증된다.
   - 호출처는 공개키만 가진다. 한 호출처의 키 유출이 다른 호출처 파일 노출로 이어지지 않는다.
   - 암호화 범위는 제목, text, html이다. 수신자와 `Idempotency-Key`는 평문이다(ADR-0001 결정 6).
   - 암호화한 요청은 `subject`·`text`·`html` 대신 `content` 필드에 JWE를 넣는다.
   - REST와 파일 채널이 같은 형식을 쓴다.
2. **파일 서명은 JWS(RFC 7515) HS256으로 한다. 호출처별로 필수 여부를 지정한다.**
   - 호출처 등록 시 `required` 또는 `none`을 명시한다. 기본값은 없다(ADR-0004 결정 9 유지).
   - 호출처마다 비밀키가 다르다. `kid`로 호출처 키를 식별하고 `caller` 클레임을 넣는다.
   - `caller` 클레임이 폴더의 `caller_id`와 다르면 거부한다.
   - 서명 파일의 최상위는 flattened JWS이고, 요청 JSON은 `payload` 안에 있다. ADR-0004 결정 1의 공통 스키마는 `payload`에 적용한다.
   - JWS는 payload 바이트를 그대로 서명하므로 정규화 규칙이 필요 없다.
   - 직렬화는 JSON 형식(flattened JWS)으로 한다. 파일 확장자 `*.json` 규칙과 맞추기 위해서다. 세부 형식은 설계 문서에서 확정한다.
   - REST는 TLS와 호출처 인증(RQ-028)을 쓰고, 서명은 요구하지 않는다.
3. **수집 순서는 JWS 구조 파싱, 서명 검증, payload 파싱과 스키마 검증, 복호화, 복호화한 제목·본문의 입력 검증(RQ-030), 지문 계산(ADR-0005), 등록이다.**
   - 서명을 복호화보다 먼저 검증한다. 위조 파일의 복호화를 시도하지 않는다.
   - 서명 대상은 암호화된 상태의 payload다.
   - 제목이 암호화돼 있으면 CR/LF 헤더 인젝션 검사를 복호화 전에 할 수 없다. 입력 검증은 복호화 뒤에 한다.
   - REST도 복호화 뒤 입력 검증과 지문 계산 순서를 따른다.
   - 이 순서가 ADR-0004 결정 5의 3~6단계를 대체한다.
4. **서명에 발행 시각(`iat`)을 필수로 넣는다.**
   - Mailo는 `iat`가 서명 허용 기간보다 오래됐거나, 허용 오차를 넘어 미래인 파일을 거부한다.
   - 서명 허용 기간은 7일, 허용 오차는 5분이다(모두 추정). 설정으로 받는다.
   - 서명 허용 기간은 "Key 보존 기간(ADR-0005) − 허용 오차" 이하여야 하고, Mailo는 기동 시 이를 검증한다.
   - Key 보존 기간이 지난 뒤 같은 파일을 다시 넣는 재전송을 막기 위해서다.
   - 서명이 `none`인 호출처와 REST는 이 재전송 방지가 없다. Key 보존 기간 안의 재전달만 막는다.
5. **Mailo 개인키는 외부 설정이나 시크릿 어댑터로 주입한다.**
   - 키 교체는 새 `kid`를 추가하는 방식이다.
   - 이전 개인키는 교체 시각부터 Key 보존 기간 이상 보관한다.
   - 이전 `kid`로 암호화한 REST 요청이 relay 재시도 기간 동안 사용처 outbox에 남을 수 있다. Mailo는 모든 요청이 수집됐는지 판정할 수 없다.
   - 개인키는 시크릿 파일 마운트로 주입하는 것을 기본으로 하고 환경 변수도 허용한다.
6. **Mailo DB 본문은 AES-256-GCM으로 암호화한다.**
   - 행마다 `key_version`을 저장한다.
   - AAD는 `job_id`다. DB 쓰기 권한을 가진 공격자가 행 사이에 암호문을 바꿔치는 것을 막는다.
   - 범위는 봉투 암호화와 같다. 제목, text, html이다. 첨부는 1·2단계에서 지원하지 않으므로 첨부 암호화는 해당 없다.
   - 이 키는 ADR-0005의 지문 키와 분리한다. 두 키도 시크릿 파일 마운트가 기본이고 환경 변수를 허용한다.
   - `job_id`는 INSERT 전에 앱에서 생성한 UUID다. AAD로 쓰기 때문이다.
   - nonce는 암호화마다 96비트 난수를 새로 쓴다.
   - DB 키를 교체하면 이전 키는 그 `key_version`을 가진 행의 본문이 모두 삭제될 때까지 보관한다.
7. **종결한 작업의 본문은 유예 기간 뒤 삭제한다.**
   - 종결은 `SENT`, `FAILED`, `EXPIRED`다.
   - 본문 컬럼만 비우고 행과 Key는 유지한다(ADR-0005 결정 7).
   - 유예 기간은 종결 후 1일이다(추정). 설정으로 받는다.
   - `mail_attempts`의 응답 텍스트와 수신자 보존 기간은 종결 후 30일이다(추정).
   - 보존 기간 순서는 본문 삭제 유예(1일) ≤ 시도·이벤트·거부 기록 보존(30일) = Key·작업 행 보존(30일)이다(ADR-0005 결정 7). 작업 행을 지울 때 하위 행도 함께 지운다.
8. **라이브러리는 표준 JOSE 구현을 쓴다.**
   - Java 호출처는 nimbus-jose-jwt, Mailo(Node)는 `jose`를 후보로 한다. 버전과 적합성은 구현 시 확인한다.

## 검토한 대안

| 대안                                     | 채택하지 않은 이유                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| 모든 호출처가 공유하는 대칭키로 봉투 암호화 | 키를 가진 호출처가 다른 호출처 파일을 복호화할 수 있다                            |
| `ECDH-ES+A256KW` 키 암호화              | 곡선 선택과 ephemeral 키 부담이 있다. RSA-OAEP-256은 같은 라이브러리가 지원한다(추정) |
| 자체 암호문·서명 형식                    | 형식 설계와 보안 검토 부담이 크다. 호출처마다 구현이 달라질 수 있다               |
| 정규화한 JSON에 HMAC                     | 정규화 규칙을 호출처와 Mailo가 같게 구현해야 한다. JWS는 바이트 그대로 서명한다   |
| 평문 DB 저장과 디스크 암호화만 사용      | DB 덤프, 백업에서 본문이 노출된다                                                 |

## 결과

- 호출처에 비밀 키를 배포하지 않고 공개키만 배포한다.
- 호출처가 JOSE 라이브러리를 사용해야 한다. 암호화는 선택이므로 비용은 선택한 호출처에만 생긴다.
- ADR-0001이 인정한 한계는 그대로다. Mailo 호스트나 메모리가 침해되면 보호되지 않고, 수신자 구간의 종단 간 암호화는 범위 밖이다.
- 서명을 쓰려면 호출처마다 서명 비밀키를 안전하게 발급·보관해야 한다.
- 결정 6·7은 단위·통합 테스트로 확인했다. 결정 1·3·4·5·8은 2단계에서 구현해 단위·통합 테스트로 확인했다(REST 경로). 결정 2의 JWS는 파일 채널 폴러가 연결해 통합 테스트로 확인했다(서명 불일치·서명 없음·`caller` 불일치·`iat` 범위 위반의 거부 기록 포함). nimbus-jose-jwt 등 다른 구현과의 상호 운용은 확인하지 않았다.

## 구현 중 확정 (2026-11-23)

결정 문구는 바꾸지 않는다. 구현이 정한 세부는 다음과 같다. 코드는 `apps/mailo/src/envelope`, 호출처 키는 `callers`, 설정은 `config`에 있다.

1. **JWS 직렬화(결정 2).** 최상위는 `{"protected","payload","signature"}` 세 필드뿐인 flattened JWS다.
   - `protected`는 base64url JSON이고 `alg`(`HS256` 고정), `kid`, `caller`, `iat`(초 단위 숫자) 네 필드만 받는다. 다른 필드(`crit`, `b64`, `jwk` 등)는 거부한다.
   - `caller`와 `iat`는 서명 범위에 들어가야 하므로 protected header에 둔다. `payload`는 요청 JSON 그대로여야 하기 때문이다.
   - unprotected `header`와 `signatures`는 서명 범위 밖이라 받지 않는다.
   - `alg`가 `HS256`이 아니면 `none`을 포함해 `SIGNATURE_INVALID`다. 서명에 성공한 뒤에만 `caller`·`iat`를 믿는다.
2. **JWS `kid`와 호출처 키(결정 2).** `kid`는 호출처의 서명 키 식별자다. 형식은 `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`이다.
   - 호출처마다 키 1~2개(교체 중 2개)를 레지스트리 `signature.keys`에 둔다. 검증은 요청 호출처(폴더의 `caller_id`)의 키로만 한다. 다른 호출처 키로 서명한 파일은 `SIGNATURE_INVALID`다.
   - 비밀키 원문은 HMAC 검증에 필요하므로 해시로 둘 수 없다. 레지스트리 JSON에는 키 값 대신 변수 이름(`secretVar`, `MAILO_JWS_SECRET_`로 시작)만 둔다. 값은 `<변수>_FILE`(시크릿 파일 마운트, 우선)이나 `<변수>`(환경 변수)로 받는다. 레지스트리를 비밀 없이 검토·배포할 수 있고, 파일 권한은 마운트가 정한다.
   - 키 형식은 32바이트의 base64 또는 64자 hex다. 메모리에서는 `Secret`으로 감싼다.
   - `signature.mode`가 `none`이면 `keys`를 둘 수 없다.
3. **JWE 세부(결정 1).**
   - `kid` 형식은 JWS와 같다. `kid`가 없거나 키링에 없으면 `KID_UNKNOWN`이다.
   - `alg`·`enc`가 고정값이 아니거나 `zip`·`crit`가 있으면 복호화를 시도하지 않고 `DECRYPTION_FAILED`다.
   - `caller`는 복호화에 성공한 뒤 확인한다. 헤더는 AAD로 인증되므로 복호화 전의 값은 믿지 않는다. 헤더를 바꾸면 `CALLER_MISMATCH`가 아니라 `DECRYPTION_FAILED`다.
   - 암호화 평문은 UTF-8 JSON `{"subject","text","html"}`다. 다른 필드는 거부하고 `attachments`는 `ATTACHMENTS_NOT_SUPPORTED`다. 복호화한 평문의 검증 오류 위치는 `/content`다.
4. **Mailo 개인키 키링(결정 5).** `MAILO_ENVELOPE_KEYS_FILE`의 JSON `{keys:[{kid, privateKeyVar, retiredAt?}], removed:[{kid, retiredAt, removedAt}]}`다. 개인키 값은 `privateKeyVar`가 가리키는 `<변수>_FILE`(우선) 또는 `<변수>`(PEM)로 받는다. 변수 이름은 `MAILO_JWE_KEY_`로 시작해야 한다.
   - 키는 RSA 3072비트여야 한다. 다른 크기와 RSA가 아닌 키는 기동 때 거부한다.
   - 파일을 설정하지 않으면 JWE를 쓰지 않는 배치다. 모든 `content`는 `KID_UNKNOWN`이다.
   - 교체는 새 항목 추가와 이전 항목의 `retiredAt`(교체 시각) 기록이다. `retiredAt`이 없는 현재 키가 하나 이상 있어야 한다.
   - "교체 시각부터 Key 보존 기간 이상 보관"은 설정 검증으로 표현한다. 항목을 지울 때는 `removed`에 `{kid, retiredAt, removedAt}`을 남기고, `removedAt - retiredAt`이 Key 보존 기간(`MAILO_RECORD_RETENTION_SECONDS`)보다 짧으면 기동을 거부한다.
   - 한계: `removed`를 적지 않고 항목만 지우는 것은 감지하지 못한다. 설정 파일만으로는 사라진 키를 알 수 없다. 삭제 절차는 3단계 운영 문서가 정한다.
5. **`iat` 검사(결정 4).** `iat > now + 허용 오차` 또는 `now - iat > 허용 기간`이면 `IAT_OUT_OF_RANGE`다. 경계(정확히 7일, 정확히 5분)는 받는다. `iat`가 없거나 숫자가 아니면 `MALFORMED`다.
   - 설정은 `MAILO_JWS_IAT_MAX_AGE_SECONDS`(기본 604800)와 `MAILO_JWS_IAT_SKEW_SECONDS`(기본 300)다.
   - 기동 검증은 `허용 기간 + 허용 오차 <= MAILO_RECORD_RETENTION_SECONDS`다. 어긴 설정은 기동을 거부한다.
   - 근거: 허용 기간 안에 처음 수집된 파일을 다시 넣어도 `iat`가 `허용 기간 + 허용 오차`를 넘기면 거부된다. 그보다 먼저 Key 행이 지워지면 같은 파일이 새 요청으로 등록되므로, Key 보존 기간이 그 합보다 길어야 한다. Key 보존 기간은 종결 후 기준이라 이 검증은 보수적이다.
6. **파일 채널 요청 필드(ADR-0004 결정 1).** 파일의 요청 JSON(서명이 `required`이면 `payload`)은 REST 필드에 `version`(정수 1)과 `idempotencyKey`를 더한다. REST에서는 이 둘이 정의되지 않은 필드다.
7. **수집 순서의 구현(결정 3).** `openRequest(input, ctx)`가 JWS 구조 파싱, 서명 검증, 스키마 검증, 복호화, 복호화한 제목·본문 검증, 지문 계산을 이 순서로 한다. 등록은 호출자가 한다.
   - 실패 결과는 사유 코드와 위치(`field`, `issues`)만 담는다. 요청 값은 담지 않는다.
   - 파일 채널의 거부 사유 코드로 바꿀 때 `SIGNATURE_REQUIRED`는 `SIGNATURE_INVALID`로, `KID_UNKNOWN`은 `DECRYPTION_FAILED`로 합친다(`toRejectionReason`). 계약의 사유 코드 11종에 이 둘이 없기 때문이다.
   - REST는 서명을 쓰지 않는다. 수신자·발신자 검증 뒤 복호화하고, 오류 위치는 `/content`다.
8. **라이브러리(결정 8, RQ-029).** Mailo는 `jose` 6.2.18를 고정해 쓴다(MIT, 런타임 의존성 없음).
   - 이유: 암호 형식(JWE 키 암호화, AES-GCM AAD 처리, HMAC 서명 검증)을 직접 만들면 형식 설계와 보안 검토 부담이 생긴다. 표준 JOSE 구현을 쓰면 호출처(Java의 nimbus-jose-jwt 등)와 상호 운용된다.
   - 사용 범위: `compactDecrypt`, `decodeProtectedHeader`, `flattenedVerify`뿐이다. 암호화(`CompactEncrypt`)는 테스트가 호출처 역할로만 쓴다. 허용 알고리즘은 호출마다 명시한다.
   - 확인한 것: 테스트는 `jose`로 만든 JWE를 Mailo가 복호화하고, JWS는 `jose` 없이 직접 서명한 값을 `jose` 검증이 받는다. nimbus-jose-jwt와의 상호 운용은 확인하지 않았다.
   - 운영 의존성은 Mailo와 PostgreSQL 그대로다. npm 의존성만 하나 늘었다.

9. **`signature.mode=none` 호출처의 한계(결정 2·4, 2026-11-23 코드 리뷰).** 결정 문구는 바꾸지 않는다.
   - `none` 호출처는 파일 채널의 inbox 쓰기 권한자가 요청을 바꾸는 것을 막지 못한다. 수신자(`to`·`cc`·`bcc`)는 평문 필드이므로 쓰기 권한자가 수신자를 바꿔치기할 수 있다.
   - 쓰기 권한자는 `none`에서 본문을 새로 만들어 보낼 수도 있다(서명이 없어 만든 이를 구분할 수 없다). 이 변조로 새로 생기는 위험은 기밀성뿐이다. 탈취한 JWE `content`를 다른 수신자로 바꿔 보내면 Mailo가 복호화해 그 수신자에게 본문을 보낸다.
   - JWE 본문 유출을 막아야 하면 `signature.mode=required`를 쓴다. 서명은 암호화된 payload와 `caller`·`iat`를 묶으므로 수신자 바꿔치기를 `SIGNATURE_INVALID`로 거부한다.
   - 레지스트리에 기본값은 없다. `signature.mode`를 적지 않으면 기동하지 않는다(결정 2, 코드 `callers/registry.ts`). 신규 호출처 권장값은 `required`이고 `none`은 사유를 적고 고르는 선택지다(`docs/operations/caller-onboarding.md`). 코드는 바꾸지 않았다.
10. **DB 본문 AAD 범위의 한계(결정 6, 2026-11-23 코드 리뷰).** 결정 문구는 바꾸지 않는다.
   - AES-GCM의 AAD는 `job_id`뿐이다. 행 사이 암호문 바꿔치기는 막지만, DB 쓰기 권한자가 같은 행의 `recipients`(평문 jsonb)를 바꾸는 것은 막지 못한다. 바뀐 수신자로 본문이 발송된다.
   - 완화는 운영 절차다. DB 쓰기 계정을 Mailo 앱으로 최소화하고, 백업·복구본의 무결성을 관리한다(`docs/operations/key-management.md`, `deployment.md`).
   - 향후 선택지(이번 범위 아님): 새 행부터 `key_version`(또는 별도 `aad_version`)으로 AAD 형식을 구분해 `job_id`와 `recipients` 해시를 함께 넣는다. 기존 행은 이전 형식 그대로 복호화하므로 마이그레이션 없이 가능하다. 도입하려면 새 ADR로 결정한다.
11. **nimbus-jose-jwt 상호 운용 확인(결정 1·2·8, 2026-11-23).** 결정 문구는 바꾸지 않는다. 구현 중 확정 8의 "nimbus-jose-jwt와의 상호 운용은 확인하지 않았다"는 아래 범위에서 확인으로 바뀌었다.
   - 확인 방법: `samples/spring-boot-relay/verify/run-e2e.sh`가 Spring Boot 샘플(nimbus-jose-jwt 10.10, JDK 21)이 만든 요청을 이 저장소의 Mailo(`jose` 6.2.18)에 보내 SMTP 수신까지 확인했다. 로컬 PostgreSQL 17과 로컬 SMTP 서버 대상이다.
   - 확인한 조합: JWE `RSA-OAEP-256` + `A256GCM`, RSA 3072 공개키, protected header `kid`·`caller`(`customParam`)를 REST `content`와 파일 채널 `content`로. JWS flattened `HS256`, protected header `kid`·`caller`·`iat`(숫자)를 파일 채널(`signature.mode=required`)로. 모두 수신까지 갔고 두 구현 사이의 형식 해석 차이는 관찰되지 않았다.
   - 거부 확인: 다른 비밀키로 서명한 JWS는 `SIGNATURE_INVALID`(`INTAKE_REJECTED`), 알 수 없는 `kid`의 JWE는 400 `KID_UNKNOWN`.
   - 확인하지 않은 것: 다른 nimbus 버전, 다른 알고리즘, 키 교체 중 이전 `kid`, 2 MiB 근처의 큰 본문, `jose` 외 다른 구현.

12. **발신 주소(From) 허용 범위와 replyTo(결정 3 뒤 단계, 2026-11-23, RQ-028·RQ-030, `src/validation/sender-policy.ts`).** 결정 문구는 바꾸지 않는다. `docs/requirements/mail-sending.md`의 미결정 "발신자 필드 정책"을 이 항목이 정한다.
    - **이전 동작.** 요청의 `from`·`replyTo`는 주소 형식만 검사하고 아무 주소나 허용했다. Mailo는 `from`을 그대로 SMTP `MAIL FROM`·`From` 헤더로 보낸다. IP 허용 relay(인증 없는 Workspace SMTP Relay)에서는 호출처 A가 임의 주소로 발신할 수 있었다. Gmail SMTP(인증)는 인증 계정과 다른 From을 계정 주소로 바꾸는 것으로 알려져 있다(미검증, 추정). 그래서 Gmail 인증 모드에서는 이 정책이 없어도 사칭이 성립하지 않을 수 있지만, Mailo가 이 동작에 기대면 안 된다.
    - **정책.** 호출처의 허용 발신 주소 = `config.smtp.defaultFrom`(`MAILO_SMTP_FROM`, 없으면 `MAILO_SMTP_USER`) ∪ `callers.json`의 선택 필드 `allowedFrom`(주소 배열, 최대 20개, 기본 빈 목록). 요청의 `from`이 있고 이 집합에 없으면 거부한다. 비교는 addr-spec 전체를 대소문자 무시로 한다(표시 이름은 지원하지 않으므로 형식 검증만). `from`을 생략하면 항상 허용하고 Worker가 `defaultFrom`으로 채운다. 거부: REST는 400 `validation-failed`의 `errors: [{pointer: "/from", code: "FROM_NOT_ALLOWED"}]`, 파일 채널은 거부 사유 `VALIDATION_FAILED`(새 사유 코드 없음)다. 오류에 주소를 싣지 않는다.
    - **`from`은 항상 평문 필드다.** JWE 본문(`content`)에는 `subject`·`text`·`html`만 들어가고 `from`·`replyTo`·수신자는 바깥 필드다(`envelope/open-request.ts`의 `DECRYPTED_FIELDS`). 그래서 `from` 값은 복호화 전에도 확정돼 있다. 검사는 등록 직전(`register`의 `denyNew`)에 한다.
    - **이미 등록된 Key는 다시 검사하지 않는다.** `register`가 `denyNew`로 호출되면 새 행을 만들지 않고 기존 Key만 본다. 기존 Key가 있으면 지문이 같으면 `duplicate`(REST 200), 다르면 `fingerprint_mismatch`(409)이고 없으면 `denied`(위 거부)다. 정책이 생기거나 `allowedFrom`이 줄어든 뒤에도, 앞서 등록된 요청을 relay가 재전송하면 기존 작업을 그대로 돌려받는다. 이 순서는 RQ-012·ADR-0005 결정 4(같은 Key·같은 내용은 기존 작업, 다른 내용은 불일치)와 충돌하지 않는다. 신규 Key에만 정책이 더해진다. 파일 채널의 재수집도 같은 `register` 경로를 쓰므로 같다.
    - **replyTo.** 제한하지 않는다(형식 검증만). SPF·DMARC 정렬 대상은 `From`이라 `Reply-To`가 발신 사칭을 늘리지 않는다. 위험은 회신을 다른 주소로 유도하는 피싱이다. 문의 폼 relay가 방문자 주소를 `replyTo`로 쓰는 용도가 있어 제한하지 않았다. 호출처 신뢰가 낮으면 이 위험을 운영에서 감안한다(`caller-onboarding.md`). 요구사항의 "같은 규칙" 문구는 이 항목에 맞춰 고쳤다.
    - **호환성.** 운영 배포 이력이 없어 즉시 강제한다(코드 변경과 같은 릴리스). 호출처가 `defaultFrom`이 아닌 `from`을 보내고 있으면 `allowedFrom`에 넣어야 한다. 이미 큐에 있는 작업의 `from`은 검사하지 않고 그대로 발송한다(Worker는 `envelope.from`을 그대로 쓴다). 샘플 relay(`samples/spring-boot-relay`)는 `from: no-reply@example.com`을 보내고 `verify/run-e2e.sh`가 `MAILO_SMTP_FROM=no-reply@example.com`을 준다. 볼륨 예시(`docker-compose.volume-example.yml`)와 `scripts/volume/verify-e2e.sh`도 같은 값으로 맞췄다.
    - **Gmail 인증 모드의 별칭.** `allowedFrom`의 주소를 실제로 From으로 보내려면 Gmail "다른 주소에서 메일 보내기"(send-as) 별칭으로 등록해야 한다. 등록하지 않으면 From이 계정 주소로 바뀐다(미검증, 추정). `caller-onboarding.md`에 미검증으로 적었다.
    - 검증: `test/callers/allowed-from.spec.ts`, `test/queue/register.integration-spec.ts`(`denyNew`), `test/http/rest-intake.integration-spec.ts`, `test/file-channel/poller.integration-spec.ts`. 실제 Gmail·Workspace relay에서의 From 처리는 확인하지 않았다.
13. **호출처 JWS 비밀키 품질 검사(결정 2·5, 2026-11-23 코드 리뷰, `src/callers/registry.ts`).** 결정 문구는 바꾸지 않는다. 기동 때 `callers.json`의 서명 키를 다음과 같이 검사한다.
    - **중복(항상 거부).** 같은 키 바이트가 다른 `kid`나 다른 호출처에 있으면 거부한다(base64·hex 표기가 달라도 바이트로 비교). DB 본문 키링·지문 키링과 같은 바이트여도 거부한다. 한 키가 여러 용도·호출처에 쓰이면 서명으로 호출처를 구분하는 의미가 없어진다. 오류에는 위치(`callers[i].signature.keys[j]`)와 라벨만 담고 값은 담지 않는다.
    - **약한 키(production만 거부).** 저장소에 공개된 샘플 키나 같은 바이트가 반복된 키(`key-loader.ts`의 `isPublicOrWeakKey`)는 `NODE_ENV`가 `development`·`test`가 아닐 때 거부한다. DB 본문 키·지문 키와 같은 규칙이다. 그 밖의 엔트로피는 검사하지 않는다(생성 방법은 `openssl rand -base64 32`).
    - 검증: `test/callers/signature-keys.spec.ts`. 기존 테스트 키는 반복 바이트라 이 파일의 테스트는 `NODE_ENV=test`를 준다.

## 미확정

- 결정됨(구현 중 확정): JWS 직렬화 세부 형식(flattened JWS의 필드 구성). 위의 "구현 중 확정" 절이 정했다.
- 호출처 공개키·서명 키 발급과 교체 절차. 저장 방식(레지스트리 `signature.keys`, 개인키 목록 파일)은 구현 중 확정했고, 운영 절차는 3단계 문서에서 정한다.
- 미결정: JWE 개인키 유출 때 보존 기간 전에 이전 키를 지우는 정식 경로. 현재는 기동 검증이 거부하고, 우회 절차와 대가는 `docs/operations/key-management.md` "JWE 개인키 유출"에 적었다.
