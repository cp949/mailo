# Mailo 프로토콜 적합성 벡터

호출처가 서명(JWS)과 암호화(JWE) 구현을 Mailo 서버 없이 확인하는 골든 벡터다. 파일은 [vectors.json](./vectors.json) 하나다.
결정은 [ADR-0014](../../adr/0014-caller-tools-and-docs.md), 요구사항은 RQ-064·065다.

## 키는 공개 가짜 키다

- `vectors.json`의 `keys`에 있는 Mailo JWE 개인키 PEM과 호출처 JWS 비밀키는 이 저장소에서만 쓰는 공개 가짜 값이다. 실제 운영 키가 아니다.
- 누구나 이 키로 암호화한 내용을 복호화하고 이 키로 서명한 파일을 만들 수 있다. 운영·스테이징·개인 환경에 쓰지 않는다.
- Mailo는 `NODE_ENV`가 `development`·`test`가 아니면(값이 없는 경우 포함) 이 키로 기동하지 않는다. 키 규칙은 `docs/operations/key-management.md`의 "키 종류와 이전 키 보관 규칙"을 본다.
- 케이스의 수신자·발신자는 예약 도메인 `example.com`의 가짜 주소이고 제목·본문은 가짜 문자열이다. 실제 SMTP 인증 정보는 없다.

## 범위

벡터는 서버의 `openRequest`가 내리는 판정 중 호출처가 관측하는 부분을 담는다. 파일 채널(서명 여부, JWE 여부)과 REST(JWE)를 모두 다룬다.

- 다루는 것: JWS 구조 파싱, 서명 검증, `caller` 일치, `iat` 허용 기간·오차, JWE `alg`·`enc`·`kid`·`caller`, 복호화한 평문의 필드 집합, 첨부 거부, 복호화한 제목의 줄바꿈 거부, 파일 채널의 `version`·`idempotencyKey` 형식.
- 다루지 않는 것: 지문(서버 비밀키 HMAC이라 호출처가 계산·검증할 수 없다), 파일 이름·크기·폴더·권한, `Idempotency-Key` 중복, 수신자·발신 주소 허용 정책(`allowedFrom`, `allowedRecipientDomains`), 한도 경계 값(바이트 상한 등), SMTP 발송.

## 파일 구조

| 필드 | 내용 |
| ---- | ---- |
| `schemaVersion` | 정수 1. 형식이 바뀌면 올린다 |
| `profile` | `jws`: `HS256`. `jwe`: `RSA-OAEP-256`, `A256GCM`, RSA 3072 |
| `settings` | `iat.maxAgeSeconds`(604800), `iat.skewSeconds`(300). 서버 기본값과 같다 |
| `keys.jwe[]` | Mailo JWE 키 쌍. `kid`, `role`(`current`·`previous`), `privateKeyPem`(PKCS#8), `publicKeyPem`(SPKI). `conformance-1`은 키 교체 중 이전 키, `conformance-2`는 현재 키다 |
| `keys.jws[]` | 호출처별 JWS 비밀키. `callerId`, `kid`, `secretBase64`(32바이트). `alpha`는 `kid`가 둘이다(키 교체 중) |
| `cases[]` | 케이스. 아래 표 |

케이스 필드:

| 필드 | 내용 |
| ---- | ---- |
| `id` | 바뀌지 않는 이름(kebab-case) |
| `title` | 한 줄 설명 |
| `channel` | `file` 또는 `rest` |
| `callerId` | 요청 호출처. 파일은 폴더 이름이다 |
| `signatureMode` | `required`(파일이 flattened JWS) 또는 `none`(파일 전체가 요청 JSON). REST는 항상 `none`이다 |
| `nowEpochSeconds` | 서버가 판정할 때의 현재 시각(초). `iat` 판정이 이 값을 기준으로 한다 |
| `input` | 파일은 `fileText`(파일 내용 전체, UTF-8 JSON 텍스트). REST는 `body`(JSON 본문 객체) |
| `jws` | 서명 케이스만. `signingInput`(`protected` + `.` + `payload`), `signature`(파일에 적힌 값), `hmacKid`(그 `signature`를 만든 키의 `kid`. 어느 키로도 만들 수 없으면 `null`) |
| `expect` | 기대 판정. 아래 표 |

`expect` 필드:

| 필드 | 내용 |
| ---- | ---- |
| `accepted` | 수락이면 `true` |
| `request` | 수락일 때. 복호화·검증을 마친 평문(`from`, `replyTo`, `to`, `cc`, `bcc`, `subject`, `text`, `html`). 쓰지 않은 필드는 `null` 또는 빈 배열이다 |
| `signed`, `encrypted` | 수락일 때. 서명을 검증했는가, JWE를 복호화했는가 |
| `reasonCode` | 파일 채널 거부일 때. `INTAKE_REJECTED` 이벤트의 `reasonCode` 9종 중 하나 |
| `errors` | REST 거부일 때. 400 응답의 `errors[{pointer, code}]`. `pointer`가 빈 문자열이면 본문 전체다 |
| `internalReason` | 거부일 때 참고용. 서버 내부 사유 코드 11종 중 하나 |

내부 사유 코드는 파일 채널에서 두 가지가 합쳐진다. `SIGNATURE_REQUIRED`는 `SIGNATURE_INVALID`로, `KID_UNKNOWN`은 `DECRYPTION_FAILED`로 보인다. REST는 암호 관련 실패를 모두 `/content` 위치로 알린다.

## 읽는 방법

1. 케이스의 `input`을 서버가 받은 입력으로 본다. 파일 케이스는 `fileText`를 그대로 폴더에 쓴 파일 내용이다.
2. `expect`가 서버의 판정이다. 수락이면 `request`가 서버가 읽은 평문이다.
3. 서명 케이스(`jws`)는 `signingInput`과 `signature`로 HMAC 구현을 서버 없이 확인한다.

## 호출처 구현에서 확인하는 절차

1. 서명: `jws.signingInput`을 HS256으로 서명한 값이 `jws.signature`와 같은지 본다. `hmacKid`가 가리키는 `keys.jws[]`의 `secretBase64`를 푼 32바이트가 키다. 서명은 같은 입력에서 항상 같은 값이다.

   ```sh
   # 입력: SIGNING_INPUT(jws.signingInput), SECRET_B64(keys.jws[].secretBase64)
   printf %s "$SIGNING_INPUT" \
     | openssl dgst -sha256 -hmac "$(printf %s "$SECRET_B64" | base64 -d)" -binary \
     | base64 -w0 | tr '+/' '-_' | tr -d '='
   ```

   `hmacKid`가 `null`인 케이스는 어느 키로도 같은 값이 나오지 않는다.
2. 서명 파일 만들기: `file-jws-accepted-plain`의 `payload`(base64url)를 풀면 요청 JSON이다. 같은 요청 JSON과 같은 protected header(`alg`, `kid`, `caller`, `iat`)로 만든 파일이 같은 `signature`를 내는지 본다. JSON 직렬화(필드 순서, 공백)가 다르면 base64url 값도 달라진다. 값이 다르면 `protected`를 디코딩해 필드 내용부터 비교한다.
3. 복호화: `content` 값이 있는 수락 케이스(`id`에 `jwe-accepted`가 들어간 케이스)를 `keys.jwe[]`의 개인키로 복호화하고 평문이 `expect.request`의 `subject`·`text`·`html`과 같은지 본다. JWE는 `RSA-OAEP-256`의 무작위 요소 때문에 같은 입력으로 암호화해도 암호문이 매번 다르다. 그래서 암호화 쪽은 암호문을 비교하지 않고 서버가 받아 주는지로 확인한다.
4. 암호화: 호출처가 `keys.jwe[]`의 공개키로 만든 JWE를 로컬 Mailo(`NODE_ENV=development`, 이 개인키를 `MAILO_ENVELOPE_KEYS_FILE`에 등록)에 보내 수락되는지 본다. 거부 케이스는 호출처가 같은 실수를 하지 않는지 점검하는 용도다.
5. 거부 케이스를 호출처 코드가 만들 수 있는지 살핀다. 예: `iat`를 문자열로 쓰거나, protected header에 `typ`를 넣거나, `kid` 없이 서명하는 구현은 거부된다.

## 변경 규칙

- 케이스 `id`는 바꾸지 않는다. 기대 판정을 바꾸는 변경은 호출처 계약 변경이다. 새 ADR이나 기존 ADR의 "구현 중 확정"에 근거를 적는다.
- 서버 단위 테스트 `apps/mailo/test/envelope/conformance-vectors.spec.ts`가 모든 케이스를 서버 코드에 넣고 기대와 비교한다. 서버 판정이 바뀌면 이 테스트가 케이스 `id`로 실패한다. DB가 필요 없고 `pnpm test`에 들어간다.
- 파일은 `apps/mailo/scripts/gen-conformance-vectors.mjs`가 만든다. 스크립트는 서버 코드를 읽지 않고 케이스 정의와 기대값을 직접 갖는다. 케이스 정의를 바꿀 때만 다시 만든다.
- 다시 만들면 모든 JWE 케이스의 암호문이 바뀐다. 리뷰는 `id`와 `expect`의 변화를 본다. 키는 기본으로 그대로 쓴다. 키를 새로 만들면(`--new-keys`) 서버의 공개 샘플 JWE 키 상수도 고친다.
- `docs/`는 포매터 대상이 아니다. 스크립트가 2칸 들여쓰기로 쓴다.
- 이 README의 케이스 표는 `id` 기준으로 단위 테스트가 확인한다. 케이스를 더하거나 빼면 표도 같이 바꾼다.

## 확인하지 않은 것

- 호출처 구현 확인 절차 3·4의 도구(JWE 복호화·암호화)는 호출처가 쓰는 라이브러리에 따라 다르다. 이 저장소는 `jose`(서버)와 nimbus-jose-jwt(샘플)만 다룬다. 샘플은 이 벡터를 아직 읽지 않는다.
- 2 MiB 근처 큰 본문, `RSA-OAEP-256` 외 알고리즘, 서버가 호출처 키를 둘 이상 가진 경우의 다른 조합은 벡터에 없다.

## 케이스 목록

| `id` | 기대 판정 | 설명 |
| ---- | --------- | ---- |
| `file-jws-accepted-plain` | 수락 | 서명한 평문 파일을 수락한다(cc, bcc, replyTo, html 포함) |
| `file-jws-accepted-rotated-kid` | 수락 | 교체 중인 호출처의 두 번째 kid(alpha-2)로 서명한 파일도 수락한다 |
| `file-jws-accepted-iat-max-age` | 수락 | iat가 허용 기간(604800초)과 정확히 같으면 수락한다 |
| `file-jws-accepted-iat-skew` | 수락 | iat가 허용 오차(300초)만큼 미래이면 수락한다 |
| `file-jws-malformed-not-json` | 거부 `MALFORMED` | 파일이 JSON이 아니면 MALFORMED다 |
| `file-jws-signature-required` | 거부 `SIGNATURE_INVALID` (내부 `SIGNATURE_REQUIRED`) | 서명이 필요한 호출처가 서명 없는 평문 파일을 보내면 SIGNATURE_REQUIRED다(파일 호출처는 SIGNATURE_INVALID로 본다) |
| `file-jws-top-level-extra-field` | 거부 `MALFORMED` | JWS 최상위에 protected·payload·signature 밖의 필드가 있으면 MALFORMED다 |
| `file-jws-protected-extra-field` | 거부 `MALFORMED` | protected header에 alg·kid·caller·iat 밖의 필드가 있으면 서명이 맞아도 MALFORMED다 |
| `file-jws-iat-string` | 거부 `MALFORMED` | iat가 숫자가 아닌 문자열이면 MALFORMED다 |
| `file-jws-iat-missing` | 거부 `MALFORMED` | iat가 없으면 MALFORMED다 |
| `file-jws-payload-not-json` | 거부 `MALFORMED` | 서명은 맞지만 payload가 JSON이 아니면 MALFORMED다 |
| `file-jws-signature-not-base64url` | 거부 `MALFORMED` | signature가 base64url이 아니면 MALFORMED다 |
| `file-jws-alg-none` | 거부 `SIGNATURE_INVALID` | alg가 none이면 SIGNATURE_INVALID다 |
| `file-jws-alg-hs512` | 거부 `SIGNATURE_INVALID` | alg가 HS256이 아니면(HS512) 서명이 맞아도 SIGNATURE_INVALID다 |
| `file-jws-kid-unknown` | 거부 `SIGNATURE_INVALID` | 호출처에 없는 kid이면 SIGNATURE_INVALID다 |
| `file-jws-kid-other-caller` | 거부 `SIGNATURE_INVALID` | 다른 호출처(beta)의 kid와 키로 서명하면 SIGNATURE_INVALID다 |
| `file-jws-wrong-key` | 거부 `SIGNATURE_INVALID` | kid는 alpha-1이지만 다른 키(beta-1)로 서명하면 SIGNATURE_INVALID다 |
| `file-jws-payload-tampered` | 거부 `SIGNATURE_INVALID` | 서명한 뒤 payload를 바꾸면 SIGNATURE_INVALID다 |
| `file-jws-caller-mismatch` | 거부 `CALLER_MISMATCH` | 서명이 맞아도 protected header의 caller가 폴더의 호출처와 다르면 CALLER_MISMATCH다 |
| `file-jws-iat-expired` | 거부 `IAT_OUT_OF_RANGE` | iat가 허용 기간보다 1초 오래되면 IAT_OUT_OF_RANGE다 |
| `file-jws-iat-future` | 거부 `IAT_OUT_OF_RANGE` | iat가 허용 오차보다 1초 미래이면 IAT_OUT_OF_RANGE다 |
| `file-jws-version-missing` | 거부 `VALIDATION_FAILED` | version이 없으면 VALIDATION_FAILED다 |
| `file-jws-version-unsupported` | 거부 `VALIDATION_FAILED` | version이 1이 아니면 VALIDATION_FAILED다 |
| `file-jws-idempotency-key-missing` | 거부 `IDEMPOTENCY_KEY_MISSING` | idempotencyKey가 없으면 IDEMPOTENCY_KEY_MISSING이다 |
| `file-jws-idempotency-key-invalid` | 거부 `IDEMPOTENCY_KEY_INVALID` | idempotencyKey에 허용하지 않는 문자(공백)가 있으면 IDEMPOTENCY_KEY_INVALID다 |
| `file-jws-attachments` | 거부 `ATTACHMENTS_NOT_SUPPORTED` | attachments 필드가 있으면 ATTACHMENTS_NOT_SUPPORTED다 |
| `file-jws-unknown-field` | 거부 `VALIDATION_FAILED` | 정의되지 않은 필드가 있으면 VALIDATION_FAILED다 |
| `file-jws-recipient-missing` | 거부 `VALIDATION_FAILED` | to가 빈 배열이면 VALIDATION_FAILED다 |
| `file-jws-body-missing` | 거부 `VALIDATION_FAILED` | 평문 모드에서 text와 html이 모두 없으면 VALIDATION_FAILED다 |
| `file-none-accepted-plain` | 수락 | 서명을 쓰지 않는 호출처는 파일 전체가 요청 JSON이고 수락한다 |
| `file-jws-jwe-accepted-current-kid` | 수락 | 서명한 파일: 현재 kid(conformance-2)로 암호화한 JWE를 복호화해 수락한다 |
| `rest-jwe-accepted-current-kid` | 수락 | REST: 현재 kid(conformance-2)로 암호화한 JWE를 복호화해 수락한다 |
| `file-jws-jwe-accepted-previous-kid` | 수락 | 서명한 파일: 키 교체 중 이전 kid(conformance-1)로 암호화한 JWE도 복호화해 수락한다 |
| `rest-jwe-accepted-previous-kid` | 수락 | REST: 키 교체 중 이전 kid(conformance-1)로 암호화한 JWE도 복호화해 수락한다 |
| `file-jws-jwe-kid-unknown` | 거부 `DECRYPTION_FAILED` (내부 `KID_UNKNOWN`) | 서명한 파일: 알 수 없는 kid의 JWE는 KID_UNKNOWN이다(파일 호출처는 DECRYPTION_FAILED로 본다) |
| `rest-jwe-kid-unknown` | 거부 `/content KID_UNKNOWN` | REST: 알 수 없는 kid의 JWE는 KID_UNKNOWN이다(파일 호출처는 DECRYPTION_FAILED로 본다) |
| `file-jws-jwe-caller-mismatch` | 거부 `CALLER_MISMATCH` | 서명한 파일: JWE protected header의 caller가 요청 호출처와 다르면 CALLER_MISMATCH다 |
| `rest-jwe-caller-mismatch` | 거부 `/content CALLER_MISMATCH` | REST: JWE protected header의 caller가 요청 호출처와 다르면 CALLER_MISMATCH다 |
| `file-jws-jwe-alg-mismatch` | 거부 `DECRYPTION_FAILED` | 서명한 파일: 키 암호화 alg가 RSA-OAEP-256이 아니면 복호화하지 않는다 |
| `rest-jwe-alg-mismatch` | 거부 `/content DECRYPTION_FAILED` | REST: 키 암호화 alg가 RSA-OAEP-256이 아니면 복호화하지 않는다 |
| `file-jws-jwe-enc-mismatch` | 거부 `DECRYPTION_FAILED` | 서명한 파일: 콘텐츠 암호화 enc가 A256GCM이 아니면 복호화하지 않는다 |
| `rest-jwe-enc-mismatch` | 거부 `/content DECRYPTION_FAILED` | REST: 콘텐츠 암호화 enc가 A256GCM이 아니면 복호화하지 않는다 |
| `file-jws-jwe-wrong-key` | 거부 `DECRYPTION_FAILED` | 서명한 파일: kid가 가리키는 키와 다른 공개키로 암호화하면 복호화에 실패한다 |
| `rest-jwe-wrong-key` | 거부 `/content DECRYPTION_FAILED` | REST: kid가 가리키는 키와 다른 공개키로 암호화하면 복호화에 실패한다 |
| `file-jws-jwe-ciphertext-tampered` | 거부 `DECRYPTION_FAILED` | 서명한 파일: 암호문(네 번째 부분)을 바꾸면 복호화에 실패한다 |
| `rest-jwe-ciphertext-tampered` | 거부 `/content DECRYPTION_FAILED` | REST: 암호문(네 번째 부분)을 바꾸면 복호화에 실패한다 |
| `file-jws-jwe-header-tampered` | 거부 `DECRYPTION_FAILED` | 서명한 파일: protected header를 바꾸면 인증 태그가 맞지 않아 복호화에 실패한다 |
| `rest-jwe-header-tampered` | 거부 `/content DECRYPTION_FAILED` | REST: protected header를 바꾸면 인증 태그가 맞지 않아 복호화에 실패한다 |
| `file-jws-jwe-content-not-json` | 거부 `VALIDATION_FAILED` | 서명한 파일: 복호화한 평문이 JSON이 아니면 VALIDATION_FAILED다 |
| `rest-jwe-content-not-json` | 거부 `/content INVALID_FORMAT` | REST: 복호화한 평문이 JSON이 아니면 VALIDATION_FAILED다 |
| `file-jws-jwe-content-unknown-field` | 거부 `VALIDATION_FAILED` | 서명한 파일: 복호화한 평문에 subject·text·html 밖의 필드가 있으면 VALIDATION_FAILED다 |
| `rest-jwe-content-unknown-field` | 거부 `/content UNKNOWN_FIELD` | REST: 복호화한 평문에 subject·text·html 밖의 필드가 있으면 VALIDATION_FAILED다 |
| `file-jws-jwe-content-subject-line-break` | 거부 `VALIDATION_FAILED` | 서명한 파일: 복호화한 제목에 줄바꿈이 있으면 VALIDATION_FAILED다 |
| `rest-jwe-content-subject-line-break` | 거부 `/content CONTROL_CHARACTER` | REST: 복호화한 제목에 줄바꿈이 있으면 VALIDATION_FAILED다 |
| `file-jws-jwe-content-attachments` | 거부 `ATTACHMENTS_NOT_SUPPORTED` | 서명한 파일: 복호화한 평문에 attachments가 있으면 ATTACHMENTS_NOT_SUPPORTED다 |
| `rest-jwe-content-attachments` | 거부 `/content ATTACHMENTS_NOT_SUPPORTED` | REST: 복호화한 평문에 attachments가 있으면 ATTACHMENTS_NOT_SUPPORTED다 |
| `file-jws-jwe-content-body-missing` | 거부 `VALIDATION_FAILED` | 서명한 파일: 복호화한 평문에 text와 html이 모두 없으면 VALIDATION_FAILED다 |
| `rest-jwe-content-body-missing` | 거부 `/content REQUIRED` | REST: 복호화한 평문에 text와 html이 모두 없으면 VALIDATION_FAILED다 |
| `file-none-jwe-accepted` | 수락 | 서명을 쓰지 않는 호출처의 JWE 파일을 복호화해 수락한다 |
| `rest-plain-accepted` | 수락 | REST: 평문 본문을 수락한다 |
| `rest-plain-attachments` | 거부 `/attachments ATTACHMENTS_NOT_SUPPORTED` | REST: attachments 필드가 있으면 ATTACHMENTS_NOT_SUPPORTED다 |
| `rest-plain-file-only-field` | 거부 `(본문) UNKNOWN_FIELD` | REST: 파일 채널 전용 필드(idempotencyKey)를 본문에 넣으면 정의되지 않은 필드라 VALIDATION_FAILED다(Key는 Idempotency-Key 헤더로 보낸다) |
| `rest-content-not-compact` | 거부 `/content INVALID_FORMAT` | REST: content가 JWE compact 형식(점으로 구분한 다섯 부분)이 아니면 VALIDATION_FAILED다 |
| `rest-content-and-plain-conflict` | 거부 `/content CONFLICTING_FIELDS` | REST: content와 평문 필드(subject·text·html)를 함께 보내면 VALIDATION_FAILED다 |
