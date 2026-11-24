# 키 관리

Mailo가 쓰는 키의 발급, 교체, 이전 키 보관, 키 분실·유출 사고 대응, 기동 시 검증 오류 해석을 적는다.
근거는 ADR-0005 결정 3·7, ADR-0008 결정 2·4~7, ADR-0014 결정 7, 코드(`config/key-loader.ts`, `envelope/key-file.ts`, `callers/registry.ts`)다.
`openssl`·`sha256sum` 명령은 2026-11-23 OpenSSL 3.0.2에서 실행해 출력 형식을 확인했다. 교체 절차 전체와 기동 오류 메시지는 코드를 읽어 정했고 운영 환경에서 실행하지 않았다.

## 결론

- 키는 종류가 5개다. DB 본문 키, 지문 키, Mailo JWE 개인키, 호출처 JWS 비밀키, 호출처 API 키(해시). 운영 토큰(읽기·관리)은 키가 아니라 접근 토큰이다("운영 토큰").
- 교체는 새 키를 추가하고 현재 버전을 올리는 방식이다. 이전 키는 해당 키로 만든 데이터가 모두 사라질 때까지 지우지 않는다.
- 이전 키를 지운 실수는 기동 시점에 감지되지 않는 경우가 많다. 지우기 전에 이 문서의 SQL로 남은 행을 확인한다.
- 다중 인스턴스는 새 버전 키를 모든 인스턴스에 먼저 배포한 뒤 현재 버전을 올린다("DB 본문 키 교체").
- 키 분실·유출은 키 종류와 사건별로 "키 사고 대응"이 다룬다. JWE 개인키를 보존 기간 전에 지우는 정식 경로는 없고 만들지 않는다. 조기 삭제는 새 유출을 막지 못한다.

## 키 종류와 이전 키 보관 규칙

| 키 | 용도 | 현재 키 선택 | 이전 키 보관 규칙 | 강제 수단 |
| -- | ---- | ------------ | ----------------- | --------- |
| DB 본문 키(AES-256-GCM, 32바이트) | DB 본문 암호화(ADR-0008 결정 6) | `MAILO_DB_ENCRYPTION_KEY_VERSION` | 그 `body_key_version`을 가진 행의 본문이 모두 삭제될 때까지 | 없음(운영 절차) |
| 지문 키(HMAC-SHA256, 32바이트) | `Idempotency-Key` 내용 지문(ADR-0005 결정 3) | `MAILO_FINGERPRINT_KEY_VERSION` | 그 `fingerprint_key_version`을 가진 작업 행이 모두 삭제될 때까지 | 없음(운영 절차) |
| Mailo JWE 개인키(RSA 3072) | 호출처가 보낸 JWE 복호화(ADR-0008 결정 5) | `retiredAt`이 없는 항목(하나 이상) | `retiredAt`부터 Key 보존 기간(`MAILO_RECORD_RETENTION_SECONDS`, 기본 30일) 이상 | 삭제를 `removed`에 적었을 때만 기동 검증이 거부 |
| 호출처 JWS 비밀키(HS256, 32바이트) | 파일 서명 검증(ADR-0008 결정 2) | 호출처가 서명에 쓰는 `kid` | ADR에 규칙 없음. 아래 권장(추정) | 없음 |
| 호출처 API 키(256비트 난수) | REST 인증(RQ-028) | 호출처당 해시 1~2개가 동시에 유효 | 교체 중에만 2개 | 해시 개수 검증(1~2개) |

- DB 본문 키와 지문 키는 서로 다른 값이어야 한다. 모든 버전 쌍에서 같은 바이트가 있으면 기동하지 않는다.
- 키 형식(DB·지문·JWS): 32바이트를 base64(표준 또는 URL-safe, 패딩 유무 무관) 또는 64자 hex로 쓴다.
- `NODE_ENV`가 `development`·`test`로 명시되지 않으면(`production`이거나 값이 없거나 알 수 없는 값) 저장소에 공개된 샘플 키와 같은 바이트의 DB 본문 키·지문 키를 거부한다. 같은 조건에서 공개 샘플 DB 비밀번호(`mailo-dev-password`)도 거부한다. 거부 대상: `.env.example`·`docker-compose.volume-example.yml`의 `MAILO_DB_ENCRYPTION_KEY_V1`(`fake-db-key-for-dev-only-0000000`의 base64)과 `MAILO_FINGERPRINT_KEY_V1`(`fake-fingerprint-key-dev-only-00`의 base64), 적합성 벡터(`docs/api/conformance/vectors.json`)의 호출처 JWS 비밀키 셋(32바이트 텍스트 `conformance-jws-alpha-1-key-0000`, `conformance-jws-alpha-2-key-0000`, `conformance-jws-beta-1-key-00000`), 그리고 32바이트가 모두 같은 값인 키(테스트 픽스처가 `Buffer.alloc(32, n)`으로 만드는 형태). base64·hex 어느 표기로 줘도 같은 바이트로 비교한다. 이전 버전 변수(`_V1` 등)도 검사한다. 오류에는 변수 이름과 사유만 나오고 키 값은 나오지 않는다. `development`·`test`는 허용한다.
- 같은 조건에서 Mailo JWE 개인키도 거부한다. 대상은 적합성 벡터의 JWE 키 쌍 둘(`kid` `conformance-1`·`conformance-2`)이다. 판정은 공개키(SPKI DER)의 SHA-256을 `envelope/key-file.ts`의 `PUBLIC_SAMPLE_JWE_KEY_SPKI_SHA256`와 비교한다. `kid` 이름은 보지 않는다. 운영자가 같은 이름으로 다른 키를 쓸 수 있다. 오류에는 `envelope keys[i]` 위치만 나온다(RQ-065, ADR-0014 결정 3).
- 이 키들은 시크릿 파일 마운트(`<변수>_FILE`)로 주는 것을 권장한다(`deployment.md` "시크릿 주입").
- 모든 키 값은 로그·오류·이벤트에 나오지 않는다(RQ-027). 키를 코드·이미지·`.env.example`에 넣지 않는다.

## DB 본문 키

한계(ADR-0008 구현 중 확정 10): AES-GCM의 AAD는 `job_id`뿐이다. 행 사이 암호문 바꿔치기는 막지만 DB 쓰기 권한자가 `recipients`를 바꾸는 것은 막지 못한다. 완화는 다음과 같다.

- DB 쓰기 권한 계정을 Mailo 앱 하나로 줄인다. 운영자·분석용 계정은 읽기 전용으로 둔다.
- 백업 덤프와 복구본의 무결성을 관리한다(보관 위치 접근 통제, 해시 기록). 복구한 DB의 `recipients`를 신뢰하려면 덤프가 변조되지 않았다는 근거가 필요하다.
- 향후 선택지(이번 범위 아님): 새 행부터 `key_version`(또는 `aad_version`)으로 구분해 AAD를 `job_id`와 `recipients` 해시로 넓힌다. 기존 행은 마이그레이션 없이 이전 형식으로 복호화한다.

발급:

```sh
openssl rand -base64 32          # 출력 한 줄이 키다. 파일에 저장한다
umask 077; openssl rand -base64 32 > mailo_db_key_v2
```

변수 이름: `MAILO_DB_ENCRYPTION_KEY_V<n>_FILE`(경로) 또는 `MAILO_DB_ENCRYPTION_KEY_V<n>`(값). 현재 버전은 `MAILO_DB_ENCRYPTION_KEY_VERSION`(기본 1)이다. `<n>`은 앞자리 0 없는 10진수다. `_V01`처럼 쓰면 `_V1`과 다른 변수라 읽히지 않으므로 기동을 거부한다.

교체(버전 1에서 2로):

1. 새 키를 발급하고 `MAILO_DB_ENCRYPTION_KEY_V2_FILE`로 준다. `MAILO_DB_ENCRYPTION_KEY_V1`은 그대로 둔다.
2. 인스턴스가 하나면 `MAILO_DB_ENCRYPTION_KEY_VERSION=2`를 같은 변경에 넣어 재시작한다.
3. 인스턴스가 여럿이면 두 단계로 한다. 먼저 `_V2`만 추가해 모든 인스턴스를 재시작하고(`VERSION`은 1 유지), 그 뒤 `VERSION=2`로 올려 다시 재시작한다. 한 번에 올리면 이전 코드의 인스턴스가 `V2` 키 없이 버전 2 행을 점유하고, 복호화에 실패해 3번째 시도에서 `FAILED`가 된다(코드 읽기 결과).
4. 새 작업은 버전 2로 암호화된다. 이전 작업은 행의 `body_key_version`으로 이전 키를 찾아 복호화한다.
5. 버전 1 행이 남았는지 확인한다. 0이면 `V1` 변수와 시크릿을 지운다.

```sql
-- 본문이 남아 있는 행의 키 버전별 건수. 지우려는 버전의 건수가 0이어야 한다.
SELECT body_key_version, count(*) FROM mail_jobs
 WHERE body_key_version IS NOT NULL GROUP BY body_key_version ORDER BY 1;
```

- 본문은 종결 후 `MAILO_BODY_RETENTION_SECONDS`(기본 1일) 뒤에 비워진다. 기본값에서 버전 1로 등록된 마지막 작업의 본문이 사라지기까지는 대략 만료 TTL(24시간) + 1일 + 유지 주기(60초)다(계산값, 실행해 확인하지 않았다). SQL 결과를 기준으로 삼는다.
- 이전 키를 너무 일찍 지우면 기동은 되지만 해당 버전 작업의 발송 시 `job_internal_error`(`error=BodyCipherError:UNKNOWN_KEY_VERSION`)가 나고, 같은 작업이 3번째 시도에서 `FAILED`가 된다.

## 지문 키

발급과 변수는 DB 본문 키와 같다. 접두어만 `MAILO_FINGERPRINT_KEY`다. DB 본문 키와 같은 값을 쓰지 않는다.

교체 절차와 다중 인스턴스 주의는 DB 본문 키와 같다. 확인 SQL만 다르다.

```sql
-- 지문 키 버전별 작업 행 수. 지우려는 버전의 건수가 0이어야 한다.
SELECT fingerprint_key_version, count(*) FROM mail_jobs
 GROUP BY fingerprint_key_version ORDER BY 1;
```

- 지문은 작업 행과 함께 남는다. 기본값에서 이전 버전이 사라지기까지는 대략 만료 TTL(24시간) + 보존 30일이다. 이 기간 안에는 이전 키가 필요하다.
- 이전 지문 키를 지운 뒤 그 버전 행의 Key로 요청이 다시 오면 비교가 예외가 된다. REST는 503, 파일은 `file_ingest_failed` 오류로 세어지고 파일이 남아 다시 시도된다(코드 읽기 결과).
- 키를 교체해도 정상 재시도는 409가 되지 않는다. 비교는 저장된 버전의 키로 계산하기 때문이다(RQ-011).

## Mailo JWE 개인키

JWE를 쓰지 않는 배치(`MAILO_ENVELOPE_KEYS_FILE` 없음)는 이 절이 필요 없다. 모든 `content`가 `KID_UNKNOWN` 400이다.

발급(RSA 3072, PKCS#8 PEM):

```sh
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out mailo-2026-12.private.pem
openssl rsa -in mailo-2026-12.private.pem -pubout -out mailo-2026-12.public.pem
```

- 개인키는 Mailo만 가진다. 공개키 PEM(`BEGIN PUBLIC KEY`)과 `kid`만 호출처에 준다. 다른 크기의 RSA 키나 RSA가 아닌 키는 기동 시 거부된다.
- `kid` 형식은 `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`이다. 예: `mailo-2026-12`.
- 키 목록 JSON(`MAILO_ENVELOPE_KEYS_FILE`)은 개인키 값이 아니라 변수 이름만 가진다. 변수 이름은 `MAILO_JWE_KEY_`로 시작하는 대문자·숫자·`_`다.

```json
{
  "keys": [
    { "kid": "mailo-2026-12", "privateKeyVar": "MAILO_JWE_KEY_2026_12" },
    { "kid": "mailo-2026-11", "privateKeyVar": "MAILO_JWE_KEY_2026_11", "retiredAt": "2026-12-01T00:00:00Z" }
  ]
}
```

값은 `MAILO_JWE_KEY_2026_12_FILE=/run/secrets/mailo_jwe_2026_12.pem`처럼 준다. `retiredAt`은 시간대가 있는 ISO 8601 시각이다.

교체:

1. 새 키 쌍을 발급한다. 키 목록에 새 항목(`retiredAt` 없음)을 추가하고, 이전 항목에 `retiredAt`(교체 시각)을 적는다. 이전 항목은 지우지 않는다.
2. 새 개인키 변수를 시크릿으로 마운트하고 Mailo를 재시작한다. 새 `kid`와 공개키를 호출처에 전달한다.
3. 호출처가 새 `kid`로 암호화하도록 바꾼다. 이전 `kid`로 암호화한 요청은 이전 키가 남아 있는 동안 복호화된다.
4. `retiredAt`부터 `MAILO_RECORD_RETENTION_SECONDS`(기본 30일)가 지나면 이전 키를 지울 수 있다. 지울 때는 `keys`에서 항목을 빼고 `removed`에 기록한다.

```json
"removed": [
  { "kid": "mailo-2026-11", "retiredAt": "2026-12-01T00:00:00Z", "removedAt": "2027-01-05T00:00:00Z" }
]
```

- `removedAt - retiredAt`이 보존 기간보다 짧거나 `removedAt`이 기동 시각보다 미래이면 기동하지 않는다. `removed`에 올린 `kid`가 `keys`에도 있으면 기동하지 않는다.
- `removed`를 적지 않고 항목만 지우는 실수는 감지하지 못한다. 항상 `removed`에 기록한다(ADR-0008 구현 중 확정 4).
- 이전 키를 보관하는 이유: 이전 `kid`로 암호화한 REST 요청이 relay 재시도 기간(7일 이하) 동안 사용처 outbox에 남을 수 있고, 입력 폴더의 파일은 Mailo가 내려가 있는 동안 쌓일 수 있다. 30일은 이 기간보다 보수적인 값이다.
- `retiredAt`이 없는 항목이 하나 이상 있어야 한다. `retiredAt`이 있어도 Mailo는 그 키로 복호화한다.
- 개발용 키 생성기 `pnpm --filter @cp949/mailo dev:keys`는 개발·테스트 전용이다. 운영 키에 쓰지 않는다.
- `docs/api/conformance/vectors.json`의 JWE 개인키 PEM은 공개 가짜 키다. 실제 운영 키가 아니다. 운영에 쓰면 모든 호출처의 JWE를 누구나 풀 수 있다. 위 규칙이 `NODE_ENV`가 `development`·`test`가 아닐 때 기동을 거부한다.

## 호출처 JWS 비밀키

용도: 파일 채널에서 `signature.mode: "required"`인 호출처의 서명. REST는 서명을 쓰지 않는다. 비밀키는 Mailo와 호출처가 같은 값을 가진다(HS256). 해시로 둘 수 없다.

발급:

```sh
umask 077; openssl rand -base64 32 > mailo_jws_billing_2026_12
```

- 호출처마다 다른 키를 쓴다. 한 호출처의 키로 다른 호출처 이름의 서명은 통과하지 못한다. 같은 키를 두 호출처·두 `kid`에 쓰거나 DB 본문 키·지문 키와 같은 키를 쓰면 Mailo가 기동하지 않는다. `NODE_ENV`가 `development`·`test`가 아니면 같은 바이트가 반복된 키와 공개 샘플 키(적합성 벡터의 JWS 비밀키 셋 포함)도 거부한다(ADR-0008 구현 중 확정 13, ADR-0014 결정 3).
- `signature.mode=none` 호출처는 inbox 쓰기 권한자의 수신자 바꿔치기를 막지 못한다. JWE 본문 유출을 막아야 하면 `required`로 두고 이 키를 발급한다(`caller-onboarding.md` "`none`의 한계", ADR-0008 구현 중 확정 9).
- `callers.json`의 `signature.keys[]`는 `kid`와 변수 이름(`secretVar`, `MAILO_JWS_SECRET_`로 시작하는 대문자)만 가진다. 호출처당 1~2개다.

```json
"signature": {
  "mode": "required",
  "keys": [
    { "kid": "billing-2026-12", "secretVar": "MAILO_JWS_SECRET_BILLING_2026_12" },
    { "kid": "billing-2026-11", "secretVar": "MAILO_JWS_SECRET_BILLING_2026_11" }
  ]
}
```

교체:

1. 새 비밀키를 발급한다. `signature.keys`에 새 `kid`와 `secretVar`를 추가하고(최대 2개), 새 변수를 시크릿으로 마운트한 뒤 Mailo를 재시작한다.
2. 호출처에 새 `kid`와 비밀키를 안전한 경로로 전달한다. 호출처가 새 `kid`로 서명하도록 바꾼다.
3. 이전 `kid`로 서명한 파일이 모두 처리됐는지 확인한다. 입력 폴더가 비었고 호출처가 이전 키로 새 파일을 만들지 않는다면 이전 항목을 지운다.
4. 권장 대기(추정): 호출처가 새 키로 바꾼 뒤 `MAILO_JWS_IAT_MAX_AGE_SECONDS + MAILO_JWS_IAT_SKEW_SECONDS`(기본 7일 5분)가 지나면 이전 키로 서명한 파일은 `iat` 검사에서도 거부되므로 이전 키를 지워도 새로 잃는 파일이 없다.

- 이전 키를 너무 일찍 지우면 그 `kid`의 파일은 `SIGNATURE_INVALID`로 거부되고 원본이 삭제된다. 호출처가 같은 Key로 다시 서명해 넣으면 등록된다.
- Mailo 호스트가 침해되면 호출처의 서명 능력이 함께 노출된다(대칭키의 한계).

## API 키

발급·교체·폐기는 `caller-onboarding.md`다. 요약: 256비트 난수 → SHA-256 hex를 `callers.json`의 `apiKeyHashes`에 추가 → Mailo 재시작 → 호출처에 평문 전달 → 이전 해시 삭제.

## 운영 토큰

근거: RQ-042, ADR-0011 결정 1·6. 운영 토큰은 `/ops/*`와 `/health/ready`의 운영자 응답을 여는 Bearer 값이다. 호출처 API 키와 다른 경로다.

| 토큰 | 변수 | 권한 |
| ---- | ---- | ---- |
| 읽기 토큰 | `MAILO_OPS_TOKEN` | 읽기 endpoint만(`GET /ops/*`, 헬스 운영자 응답, `GET /metrics`) |
| 관리 토큰 | `MAILO_OPS_ADMIN_NAMES`에 이름, 이름마다 `MAILO_OPS_ADMIN_TOKEN_<이름 대문자>` | 읽기 권한 + 정지·재개·작업 취소 |

- 관리 토큰은 사람(또는 역할)마다 하나씩 발급한다. 이름이 감사 기록의 `actor`가 되므로 공용 이름(`admin`)보다 `oncall`·`deploy`처럼 구분되는 이름을 쓴다. 이름은 `[a-z][a-z0-9]{0,31}`, 최대 8개다.
- 읽기 토큰은 모니터링(Prometheus 설정 등)에 둔다. 변경 권한이 있는 관리 토큰은 모니터링 설정에 두지 않는다. `/metrics`는 이를 강제한다. 관리 토큰으로 `/metrics`를 부르면 403이고 Prometheus 타깃이 `down`이 된다(RQ-049, ADR-0012 결정 1).
- Prometheus는 읽기 토큰을 `authorization.credentials_file`의 파일로 읽는다(`deployment.md` "지표"). 이 파일은 Prometheus 계정만 읽게 한다. 읽기 토큰을 교체하면 모든 Mailo 인스턴스를 다시 시작하고 Prometheus의 토큰 파일도 바꾼다. 인스턴스를 순서대로 다시 시작하는 동안 아직 이전 토큰인 인스턴스와 새 토큰인 인스턴스가 섞이므로 그 사이 한쪽 타깃은 401로 `down`이 된다(교체 중 두 값을 함께 쓰는 방법이 없다).
- 발급: `openssl rand -base64 32`(44자). 공백 없는 32자 이상이어야 한다. 시크릿 파일 마운트(`<변수>_FILE`)로 준다(`deployment.md` "시크릿 주입").
- 값이 서로 같거나 호출처 API 키와 같으면 기동하지 않는다. 호출처 키와의 비교는 레지스트리가 기동 때 읽은 해시로 한다.
- 추가·교체·폐기는 변수를 바꾸고 모든 인스턴스를 다시 시작한다. 환경 변수는 기동 때 읽고 핫 리로드가 없다. 교체 중 이전·새 값을 함께 두는 방법은 없다. 이름을 새로 추가한 뒤(예: `oncall2`) 이전 이름을 목록에서 빼는 순서로 겹쳐 쓴다.
- 폐기: 이름을 목록에서 빼고 재시작한다. 이전 토큰으로 한 작업은 감사 기록의 `actor`에 이름으로 남는다. 이름을 다른 사람에게 다시 쓰면 이전 기록과 구분되지 않으므로 폐기한 이름은 다시 쓰지 않는다(권고).
- 유출 대응: 유출된 이름을 목록에서 빼고 재시작한다. 이 토큰으로 한 정지·취소는 `GET /ops/audit`으로 확인한다. 토큰 값은 감사·로그·오류에 쓰이지 않는다.
- 운영 CLI(`node dist/cli.js`, RQ-047)는 같은 토큰을 별도 변수로 받는다. `MAILO_CLI_TOKEN_FILE`(우선) 또는 `MAILO_CLI_TOKEN`이고 서버의 `MAILO_OPS_*` 변수를 읽지 않는다. 명령줄 인자로는 받지 않는다. 읽기 토큰 파일과 관리 토큰 파일을 따로 두고 평소에는 읽기 토큰 파일을 쓴다(`deployment.md` "운영 CLI"). 토큰 파일은 CLI를 실행하는 계정만 읽게 한다.
- 감사 기록은 DB 테이블이다. 자동 삭제가 없다. 행 수는 운영자 조작 건수라 작다고 추정한다(측정하지 않았다).

## 기타 시크릿

- SMTP 비밀번호(`MAILO_SMTP_PASSWORD`): Google 앱 비밀번호 등. 교체는 시크릿을 바꾸고 Mailo를 재시작한다. 잘못된 값은 `AUTH` 사유로 차단기를 연다(`troubleshooting.md`).
- SMTP 계정 비밀번호(`MAILO_SMTP_SECRET_<이름>`, RQ-053, ADR-0013 결정 1·5): 계정 파일(`MAILO_SMTP_ACCOUNTS_FILE`)의 `auth.secretVar`가 가리키는 변수다. 값은 `<변수>_FILE`(우선) 또는 `<변수>`로 받고 계정마다 변수가 따로다. 같은 변수를 두 계정이 쓰면 기동하지 않는다.
  - 교체: (1) 계정에서 새 앱 비밀번호를 만든다. 이전 값은 아직 유효하게 둔다. (2) 시크릿 파일을 새 값으로 바꾼다. (3) 인스턴스를 롤링 재시작한다. 재시작 중 인스턴스마다 이전·새 값이 섞이지만 둘 다 유효하다. (4) 모든 인스턴스가 바뀐 뒤 이전 앱 비밀번호를 폐기한다. Google 계정이 앱 비밀번호를 여럿 허용하는지는 확인하지 않았다.
  - 잘못된 값은 그 계정의 작업만 `AUTH` 사유를 낸다. 그 계정의 차단기만 열리고 다른 계정은 계속 발송한다(`deployment.md` "SMTP 계정"의 계정 단위 점유).
  - 계정 ID를 바꾸려면 새 계정을 만들고 호출처를 옮긴다. 새 차단기 행이 생긴다. 이미 등록한 작업은 이전 계정 ID로 남는다.
  - 계정 파일에는 `user`·`from` 주소가 있다(비밀번호 값은 없다). `MAILO_SMTP_USER`와 같은 민감도로 다루고 읽기 전용으로 마운트한다. 로그·오류·지표에는 계정 ID만 쓴다.
  - 기동 오류: 변수가 없으면 `MAILO_SMTP_SECRET_<이름> 또는 MAILO_SMTP_SECRET_<이름>_FILE이 필요하다(accounts[i].auth.secretVar)`, `_FILE`을 읽지 못하면 `MAILO_SMTP_SECRET_<이름>_FILE이 가리키는 파일을 읽지 못했다(<errno>)`다. 값은 오류에 나오지 않는다.
- DB 접속 URL: 비밀번호를 바꾸면 PostgreSQL 계정과 시크릿을 함께 바꾸고 재시작한다.

## 키 사고 대응

근거: RQ-067, ADR-0014 결정 7(코드는 바꾸지 않는다). 이 절의 표기는 두 가지다.

- (확인): 2026-11-24에 코드를 읽어 확인한 동작이다. 실행해 본 것이 아니다.
- (가정): 코드로 확인하지 못한 추정이다.

이 절의 절차를 운영 환경에서 실행하지 않았다. 아래 SQL은 임시 schema에 마이그레이션을 적용해 실행했다("검증하지 않은 것").

### 먼저 할 일

1. 키 종류와 사건(유출: 제3자가 값을 얻었을 수 있다, 분실: 값을 잃었고 복구할 수 없다)을 정한다.
2. "키별 요약" 표로 영향 범위를 본다. 해당 키의 절을 순서대로 따른다.
3. 키 값을 채팅·티켓·로그에 붙이지 않는다. 사고 시각, 판단, 지운 키의 `kid`·버전, 승인자를 운영 기록에 남긴다. `mail_ops_audit`은 관리 토큰의 정지·취소만 남기므로 키 작업의 기록이 아니다(확인).
4. 호출처에 영향이 가는 절차(`kid` 교체, 재서명, 재암호화)는 호출처 담당과 시각을 맞춘 뒤 한다.

### 키별 요약

| 키 | 유출 때 노출되는 것 | 분실 때 깨지는 것 | 코드 변경 |
| -- | ------------------- | ----------------- | --------- |
| Mailo JWE 개인키 | 그 `kid`로 암호화돼 Mailo 밖에 남은 암호문의 기밀성. 큐 본문은 해당 없음 | 그 `kid`로 암호화한 요청이 수집되지 못함. 큐의 작업은 해당 없음 | 필요 없음 |
| DB 본문 키 | 그 버전으로 암호화된 DB·백업의 미삭제 본문. 키만으로는 읽을 수 없고 DB·덤프도 필요하다 | 그 버전 본문을 가진 비종결 작업이 발송되지 못하고 `FAILED`가 됨 | 필요 없음 |
| 지문 키 | 후보 평문을 지문에 대입해 내용을 추측할 수 있다. DB 지문도 필요하다(가정) | 그 버전 행의 Key로 다시 온 요청이 REST 503, 파일 `file_ingest_failed` | 필요 없음 |
| 호출처 JWS 비밀키 | 그 호출처 이름으로 서명한 파일을 만들 수 있다. inbox 쓰기 권한도 필요하다 | 호출처가 서명하지 못함. Mailo가 잃으면 기동하지 못함 | 필요 없음 |
| 호출처 API 키 | 그 호출처로 `POST /jobs`와 조회·이벤트 읽기 | 호출처가 호출하지 못함. Mailo는 해시만 가져 영향 없음 | 필요 없음 |
| 운영 토큰 | 읽기 토큰은 큐 수치·`/ops` 조회, 관리 토큰은 정지·재개·작업 취소 | 해당 토큰으로 운영하지 못함 | 필요 없음 |
| SMTP 비밀번호 | 그 계정으로 Mailo 밖에서 발송 | 해당 계정의 발송이 `AUTH` 사유로 멈춤 | 필요 없음 |
| DB 비밀번호 | DB 전체. 수신자는 평문이다 | Mailo가 DB에 접속하지 못함 | 필요 없음 |

### 로테이션이 되는 것과 안 되는 것

된다(코드 확인).

- JWE 개인키: 새 `kid` 항목을 `retiredAt` 없이 추가하고 이전 항목에 `retiredAt`을 적는다. 키링은 `retiredAt`으로 키를 거르지 않으므로 이전 `kid`는 항목이 남아 있는 동안 복호화된다(`envelope/key-ring.ts`, `envelope/key-file.ts`).
- DB 본문 키·지문 키: 새 버전을 추가하고 현재 버전을 올린다. 이전 버전 행은 행의 버전으로 이전 키를 찾는다("DB 본문 키", "지문 키").
- JWS 비밀키: 호출처당 `kid` 2개까지 동시에 둔다. API 키: 해시 2개까지 동시에 둔다.
- 운영 토큰, SMTP 비밀번호, DB 비밀번호: 값을 바꾸고 재시작한다.

안 된다(코드 확인).

- JWE 개인키를 보존 기간(`MAILO_RECORD_RETENTION_SECONDS`) 전에 정상 경로로 지우지 못한다. `removed`의 `removedAt - retiredAt`이 보존 기간보다 짧으면 기동이 거부된다.
- 큐에 이미 저장된 본문과 백업·덤프의 본문을 새 DB 본문 키로 다시 암호화하지 못한다. 재암호화 코드가 없다.
- 지문을 새 키로 다시 계산하지 못한다. 평문을 저장하지 않으므로 계산 입력이 없다.
- 유출된 키로 암호화돼 Mailo 밖(호출처 outbox, 파일 채널 폴더·NAS 백업, 프록시·APM 로그)에 남은 암호문의 기밀성은 Mailo가 되돌리지 못한다.
- 특정 `kid`나 키 버전의 새 요청만 막는 폐기 상태가 없다. 키를 항목에서 지우는 것이 유일한 폐기다.
- 기동 때 DB에 남은 키 버전과 설정의 키를 대조하지 않는다. 이전 키를 지워도 기동은 된다. 문서의 SQL로 점검한다.
- 레지스트리(API 키 해시, `signature.keys`)와 환경 변수는 기동 때 한 번 읽는다. 변경은 인스턴스를 다시 시작해야 반영된다(`caller-onboarding.md` "레지스트리 변경 반영").

### 만들지 않는 것

ADR-0014 결정 7이 정한 것이다. 필요가 생기면 새 ADR이 먼저다.

- JWE 개인키의 보존 기간 전 삭제용 정식 경로(`removed[].reason: "COMPROMISED"`로 검사 면제, `kid`별 `revokedAt`). 조기 삭제는 새 유출을 막지 못하고 처리 대기 요청만 잃기 때문이다(아래 "JWE 개인키 사고").
- 큐 본문 재암호화(rewrap) 도구. 큐 SQL과 암호 경로를 바꾸는 변경이고 이득이 유출 키의 노출 기간(기본 약 2일) 단축에 한정된다. 재검토 조건: DB 본문 키 유출 때 더 짧은 노출 기간을 요구하는 운영자가 나온다.
- 기동 때 DB의 키 버전과 설정의 키 대조. 큐 SQL 읽기 경로가 늘고 기동이 DB 상태에 묶인다.
- 지문 키 분실 때 `mail_jobs` 행을 직접 지우는 절차. Key 중복 방지가 없어져 같은 메일이 다시 발송될 수 있다("지문 키 사고").

### JWE 개인키 사고

해석(가정): Mailo가 유출된 개인키를 계속 들고 있어도 공격자가 얻는 능력은 늘지 않는다. 공격자는 이미 키를 갖고 있고 암호화용 공개키는 공개다. 이전 `kid`로 암호화한 요청을 Mailo에 넣으려면 호출처 API 키나 inbox 쓰기 권한이 필요하고, 새 `kid`로도 똑같이 넣을 수 있다. 유출의 피해는 그 키로 암호화돼 이미 어딘가에 있는 암호문의 기밀성 상실이다. 이 해석은 코드 읽기에서 나왔고 위협 모델 검토를 거치지 않았다.

Mailo 쪽에 남는 JWE 암호문은 없다(확인). 수집은 복호화한 평문을 DB 본문 키로 다시 암호화해 저장하고(`queue/register.ts`), 거부 기록은 파일 이름·크기·`sha256`만 갖는다(`events/event-store.ts`). 파일 채널 원본은 등록·거부 기록 커밋 뒤 삭제된다. 큐의 작업은 JWE 개인키와 무관하다.

지문(Key 중복 판정)은 복호화한 평문으로 계산한다. 새 `kid`로 다시 암호화한 같은 내용의 요청은 기존 작업(200)이다(확인, `docs/api/README.md` "Key 계약 요약").

유출:

1. 새 키 쌍을 발급하고 키 목록에 추가한다. 유출된 항목에 `retiredAt`(교체 시각)을 적는다. 재시작하고 호출처에 새 `kid`와 공개키를 전달한다("Mailo JWE 개인키"의 교체 1~3번).
2. 노출을 평가한다. 유출된 `kid`로 암호화된 요청이 있던 곳(호출처 outbox, 파일 채널 폴더와 NAS 백업, 프록시·APM 로그)을 호출처와 확인한다. 유출 이전에 Mailo가 수신한 요청의 평문은 큐·백업에 DB 본문 키로 암호화돼 있으므로 이 키로는 열리지 않는다.
3. 모든 호출처가 새 `kid`로 옮긴 것을 확인한다. 이전 `kid`를 쓰는 요청만 골라 막는 설정은 없다(`kid`는 요청 안에 있다).
4. `retiredAt`부터 보존 기간(기본 30일)이 지난 뒤 `keys`에서 항목을 빼고 `removed`에 기록한다("Mailo JWE 개인키"의 교체 4번). 이 경로가 기록과 일치하는 정상 절차다.
5. 보존 기간을 기다릴 수 없으면 아래 "조기 삭제"를 따른다. 조기 삭제는 보안 통제가 아니다.

분실(복구할 수 없다):

1. 새 키 쌍을 발급해 키 목록에 추가하고 호출처에 새 `kid`와 공개키를 전달한다.
2. 분실한 키의 항목을 `keys`에서 뺀다. 항목이 남아 있으면 개인키 변수가 없어 기동하지 못한다(확인, `key-file.ts`의 `<변수> 또는 <변수>_FILE이 필요하다`). 보존 기간 전이라면 `removed`에 쓰지 않는다. 기록이 없는 삭제라서 위험도·롤백은 "조기 삭제"와 같다.
3. 분실한 `kid`로 암호화된 요청은 수집되지 못한다. REST는 400(`/content`, `KID_UNKNOWN`)이다. 파일 채널은 `DECRYPTION_FAILED`로 거부하고 원본을 삭제한다(확인, `envelope/reasons.ts`의 `toRejectionReason`, 거부 기록 커밋 뒤 삭제). 원본이 사라지므로 호출처가 평문을 outbox에 보관하는지 먼저 확인한다(가정).
4. 호출처는 같은 `Idempotency-Key`와 같은 내용을 새 `kid`로 다시 암호화해 보낸다. 지문이 평문 기준이라 이미 등록된 건은 200이다. REST 400은 relay가 재시도하지 않으므로(`caller-onboarding.md` "relay 규칙") 호출처가 `FAIL_AND_ALERT`를 받아 직접 다시 보낸다.
5. 큐에 있는 작업은 영향이 없다.

조기 삭제(유출 때 보존 기간 전에 이전 키를 지우는 운영 판단). 정식 경로는 없고 만들지 않는다. 아래 두 방법 중 하나를 택하거나, 택하지 않고 보존 기간을 기다린다.

| 방법 | 효과 | 대가 |
| ---- | ---- | ---- |
| `MAILO_RECORD_RETENTION_SECONDS`를 줄이고 재시작한 뒤 `removed`에 기록 | 기동 검증이 요구하는 최소 간격이 줄어 `removed`를 일찍 적을 수 있다 | 종결 작업의 `Idempotency-Key` 중복 방지 기간이 함께 줄어든다. `MAILO_BODY_RETENTION_SECONDS`·`MAILO_JOB_EXPIRY_MAX_SECONDS`(생략하면 `MAILO_JOB_EXPIRY_SECONDS`) 이상, `MAILO_JWS_IAT_MAX_AGE_SECONDS + MAILO_JWS_IAT_SKEW_SECONDS` 이상이어야 기동한다 |
| 처리 대기 요청이 없음을 확인한 뒤 `keys`에서 항목만 지우고 `removed`에 쓰지 않음 | 이전 키가 즉시 사라진다 | 기동 검증이 이 실수를 감지하지 못한다. 지운 사유·시각·승인자를 별도 운영 기록에 남긴다 |

- 두 방법 모두 새 유출을 막지 못하고 처리 대기 중인 이전 `kid` 요청만 잃는다(해석 참고). 잃은 요청은 위 분실 3~4번과 같이 호출처가 다시 보낸다.
- `removed`에 `retiredAt`을 실제보다 앞당겨 적지 않는다. 기록을 허위로 만든다.

```txt
위험도: 중간 (이전 `kid`로 암호화한 처리 대기 요청이 거부되고 파일 채널 원본이 삭제된다)
롤백: 삭제 전의 키 목록 JSON과 개인키 시크릿을 보관해 두었다면 항목을 되돌리고 재시작한다. 유출된 키라도 보관해야 되돌릴 수 있다. 이미 거부·삭제된 요청은 되돌리지 못하고 호출처가 다시 보낸다
위험도(보존 기간 축소): 높음 (Key 중복 방지 기간이 줄어 같은 Key의 재전송이 새 작업이 될 수 있다)
롤백(보존 기간 축소): 값을 되돌리고 재시작한다. 이미 보존 삭제가 지운 행은 되돌리지 못한다
```

### DB 본문 키 사고

유출된 키는 그 버전 행의 본문이 모두 지워질 때까지 설정에 남는다. 본문은 종결 후 `MAILO_BODY_RETENTION_SECONDS`(기본 1일) 뒤 비워지므로 기본값에서 유출 키의 노출은 새 버전으로 바꾼 뒤 약 2일(요청별 TTL을 크게 쓰면 `TTL + 1일`, 상한 `MAILO_JOB_EXPIRY_MAX_SECONDS`)이다(계산값).

유출:

1. 새 버전 키를 발급하고 "DB 본문 키"의 교체 절차(2단계 롤링)로 현재 버전을 올린다.
2. 영향 범위를 확인한다. 유출 시점에 DB·백업에 있던 그 버전의 미삭제 본문이다. 키만으로는 읽을 수 없고 DB 접근이 함께 필요하다(가정).

```sql
-- 그 버전 본문이 남은 작업의 상태별 건수(수신자·본문은 출력하지 않는다)
SELECT status, count(*) FROM mail_jobs WHERE body_key_version = 1 GROUP BY status ORDER BY 1;
```

3. 새 작업은 새 버전으로 암호화된다. 이전 버전 본문은 재암호화하지 못하므로 그 행이 지워질 때까지 기다린다. 위 SQL 결과가 0이면 이전 키 변수와 시크릿을 지운다.
4. 백업·덤프의 본문은 Mailo가 고치지 못한다. 유출된 키로 열리는 덤프의 접근 기록을 확인하고 필요하면 덤프를 폐기한다. 이전 덤프를 복원할 가능성이 있으면 그 덤프를 읽는 데 이전 키가 필요하다(확인, 행의 `body_key_version`).

분실:

1. 영향 범위를 확인한다. 현재 버전 키를 잃었으면 기동하지 못한다(확인). 새 버전 키를 발급해 `_V<n+1>`과 `MAILO_DB_ENCRYPTION_KEY_VERSION`을 올린다. 이전 버전 키를 잃었으면 기동은 된다.
2. 분실한 버전 본문을 가진 비종결 작업을 찾는다.

```sql
-- 잃은 버전(예: 1)의 비종결 작업. 종결 작업은 본문이 필요 없다.
SELECT id, caller_id, status, attempts, created_at FROM mail_jobs
 WHERE body_key_version = 1 AND status IN ('PENDING', 'RETRY_WAIT', 'SENDING')
 ORDER BY created_at LIMIT 1000;
```

3. 아무것도 하지 않으면 그 작업은 발송 시 `job_internal_error`(`error=BodyCipherError:UNKNOWN_KEY_VERSION`)를 내고 3번째 시도(`POISON_MAX_ATTEMPTS`)에서 `FAILED`가 된다(확인, `worker.ts`의 `internalFailure`). 내부 오류라 차단기는 건드리지 않는다(확인). 호출처는 `FAILED`와 `JOB_FAILED`를 받는다.
4. 오류 로그와 재시도를 줄이려면 `PENDING`·`RETRY_WAIT` 작업을 관리 취소한다(`node dist/cli.js jobs cancel <jobId> --yes`, 관리 토큰). 취소는 본문을 복호화하지 않는다(확인, `queue/cancel.ts`). `SENDING` 작업은 취소할 수 없고 lease가 끝나면 위 3번으로 간다. 호출처는 `CANCELED`(`canceledBy: OPERATOR`)와 `JOB_CANCELED`를 받는다.
5. 호출처는 새 `Idempotency-Key`로 다시 제출한다. 같은 Key는 종결된 작업을 돌려준다(RQ-034).
6. 분실한 키의 버전을 설정에서 되살리지 못하면 그 버전 행의 본문은 복원할 수 없다. 같은 키를 가진 백업이 있으면 그 키로 읽는다.

```txt
위험도: 중간 (관리 취소는 호출처가 바라지 않은 CANCELED를 만든다)
롤백: 취소는 되돌리지 못한다. 호출처가 새 Key로 다시 제출한다
```

### 지문 키 사고

유출: 키와 DB의 지문이 함께 있으면 후보 평문을 대입해 요청 내용이 맞는지 확인할 수 있다(가정, HMAC 입력은 정규화한 평문 요청이다). 키가 없으면 해당 없다.

1. 새 버전 키를 발급하고 교체 절차로 현재 버전을 올린다.
2. 지문은 작업 행과 함께 남는다. 기본값에서 이전 버전이 사라지기까지 대략 만료 TTL(24시간) + 보존 30일이다(계산값). 이 기간에는 이전 키가 필요하다.
3. 이전 버전 행을 새 키로 다시 계산하지 못한다(평문이 없다). 노출 기간을 줄이려면 보존 기간을 줄여야 하는데 Key 중복 방지 기간도 함께 줄어든다("조기 삭제"의 보존 기간 축소와 같은 대가).

```sql
-- 지문 키 버전별 작업 행 수와 가장 늦은 종결 시각. 이전 버전이 0이 되면 그 키를 지운다.
SELECT fingerprint_key_version, count(*) AS jobs, max(finished_at) AS last_finished
  FROM mail_jobs GROUP BY fingerprint_key_version ORDER BY 1;
```

분실:

1. 현재 버전 키를 잃었으면 기동하지 못한다(확인). 새 버전 키를 발급해 현재 버전을 올린다.
2. 잃은 버전 행의 Key로 다시 오는 요청은 비교가 예외다. REST는 503, 파일 채널은 `file_ingest_failed`이고 파일이 남아 다시 시도된다(확인, `queue/register.ts`의 `fingerprint`, `file-channel/poller.ts`). REST 503은 relay가 같은 Key로 재시도한다. 새 Key와 현재 버전 행은 영향이 없다.
3. 파일이 연속 3건 오류(`MAX_CONSECUTIVE_ERRORS`)면 그 폴링은 접힌다. 잃은 버전 행의 Key를 가진 파일이 3건 이상 폴더에 쌓이면 같은 폴링의 나머지 파일이 밀릴 수 있다(가정, 파일 순서와 간격에 따라 다르고 실행하지 않았다). `file_ingest_failed` 로그와 폴더 파일 수로 본다.
4. 복구할 방법은 없다. 잃은 버전의 행이 보존 기간 뒤 지워지면(위 SQL의 `last_finished` + 보존 기간) 같은 Key가 새 요청으로 등록된다. 그 사이 같은 Key로 다시 보내려는 호출처는 relay의 최대 재시도 기간(7일 이하)이 지나면 `DEAD`로 처리한다.
5. `mail_jobs` 행을 직접 지우지 않는다. Key 중복 방지가 사라져 호출처의 재시도가 같은 메일을 다시 발송할 수 있다.

```txt
위험도: 높음 (mail_jobs 직접 삭제는 중복 발송을 허용한다. 이 문서는 절차로 정하지 않는다)
롤백: 삭제한 행은 백업 복원으로만 되돌린다("백업과 복구")
```

### 호출처 JWS 비밀키 사고

유출(그 호출처 이름으로 위조한 서명 파일이 생길 수 있다):

1. 호출처에 새 `kid`와 비밀키를 안전한 경로로 먼저 전달하고 호출처가 서명을 바꿀 준비를 하게 한다.
2. 한 번의 재시작으로 `signature.keys`에서 유출된 항목을 빼고 새 `kid`를 넣는다. 이전 키를 남겨 둔 채 교체하지 않는다. 남겨 두면 `iat` 허용 기간(기본 7일)이 지나기 전까지 위조 파일이 통과한다.
3. 재시작 사이에 호출처가 이전 키로 서명한 파일은 `SIGNATURE_INVALID`로 거부되고 원본이 삭제된다(확인). 호출처는 같은 Key로 새 `kid`로 다시 서명해 넣는다.
4. 다중 인스턴스는 롤링이 끝나야 이전 키가 모든 인스턴스에서 사라진다. 아직 재시작하지 않은 인스턴스는 이전 키로 서명한 파일을 받는다(확인, 폴러가 기동 때 읽은 레지스트리를 쓴다). 파일 채널을 쓰는 호출처의 inbox 쓰기를 롤링 동안 멈춘다.
5. 노출을 평가한다. 유출 가능 기간의 그 호출처 작업을 시간별로 본다. 작업 행에는 채널이나 서명 키를 구분하는 열이 없다(확인, 스키마). 위조 여부는 이 숫자로 판정하지 못하고 호출처의 outbox와 대조한다.

```sql
-- 호출처의 시간별 등록 건수. 호출처 outbox의 전송 건수와 대조한다.
SELECT date_trunc('hour', created_at) AS hour, count(*) AS jobs
  FROM mail_jobs WHERE caller_id = 'billing' AND created_at >= now() - interval '7 days'
 GROUP BY 1 ORDER BY 1;
```

6. 위조로 의심되는 대기 작업은 관리 취소하거나 호출처를 정지한다(`node dist/cli.js pause --caller <호출처 ID> --yes`). 이미 `SENT`인 메일은 되돌리지 못한다.

분실:

- 호출처가 잃었고 유출 의심이 없다: 일반 교체 절차("호출처 JWS 비밀키"의 교체)로 새 `kid`를 추가한다. 호출처가 이전 키로 서명해 둔 파일이 폴더에 있으면 처리될 때까지 이전 항목을 남긴다.
- Mailo가 잃었다(변수·시크릿 파일 없음): 기동하지 못한다(확인, `<변수> 또는 <변수>_FILE이 필요하다(callers[i].signature.keys[j])`). 호출처가 같은 값을 갖고 있으면 그 값을 받아 시크릿을 복원한다. 없으면 새 키를 발급해 항목을 바꾸고 호출처에 전달한다.

### 호출처 API 키 사고

유출(그 호출처로 `POST /jobs`와 `GET /jobs`·`GET /events` 읽기가 가능하다. 이벤트의 수신자가 노출된다):

1. 즉시 호출처를 정지한다(`node dist/cli.js pause --caller <호출처 ID> --yes`, 관리 토큰). 정지는 DB 행이라 모든 인스턴스에 바로 적용된다. 점유만 멈추고 등록은 계속 받는다(확인, `deployment.md` "발송 정지와 운영 REST").
2. 새 키를 만들고 해시로 바꾼다. 호출처에 새 키를 먼저 전달한 뒤 한 번의 재시작으로 유출된 해시를 새 해시로 바꾼다. 호출처가 401을 받으면 relay를 멈추는 구현이 많으므로(`caller-onboarding.md` "relay 규칙") 전달 시각을 맞춘다.
3. 다중 인스턴스는 롤링이 끝나야 유출된 키가 모든 인스턴스에서 거부된다("레지스트리 변경 반영"). 그 사이 정지가 발송을 막는다.
4. 정지 중 쌓인 의심 작업을 확인하고 필요하면 관리 취소한 뒤 정지를 푼다. `allowedFrom`·`allowedRecipientDomains`·`sendQuota24h`가 있으면 위조 요청이 낼 수 있는 피해의 범위를 줄인다(확인, 등록 때 검사).

분실: Mailo는 해시만 가진다. 새 키를 발급해 해시로 교체한다("API 키 발급·교체·폐기").

### 운영 토큰·SMTP·DB 비밀번호 사고

- 운영 토큰: 유출과 분실 모두 "운영 토큰"의 절차를 따른다. 유출 때 이름을 목록에서 빼고 재시작하며, 그 토큰의 정지·취소는 `GET /ops/audit`으로 본다. 읽기 토큰의 조회는 감사에 남지 않는다(확인, 감사는 상태를 바꾼 요청만 쓴다).
- SMTP 비밀번호 유출: 제공자(Google 계정)에서 앱 비밀번호를 먼저 폐기하고 새 값으로 시크릿을 바꿔 롤링 재시작한다("기타 시크릿"). 폐기부터 재시작이 끝날 때까지 그 계정은 `AUTH` 사유로 차단기가 열린다. 계정으로 Mailo 밖에서 보낸 메일은 제공자의 활동 기록에서 본다(가정).
- DB 비밀번호 유출: PostgreSQL 계정 비밀번호를 `ALTER USER`로 바꾸고 시크릿을 바꾼 뒤 재시작한다. DB에 접근했다면 수신자(평문)와 암호화된 본문이 노출된 것이다. DB 본문 키가 함께 유출되지 않았는지 확인한다.
- 세 가지 모두 분실은 새 값을 만들어 같은 순서로 바꾸는 재발급이다.

## 기동 시 검증 오류 해석

설정 오류는 `설정이 올바르지 않다:` 아래에 `- <사유>` 줄로 모두 모아 출력하고 종료 코드 1로 끝난다. 호출처 레지스트리 오류는 `호출처 레지스트리가 올바르지 않다:`로 시작한다. 메시지에는 변수 이름과 위치(`callers[0]`, `envelope keys[1]`)만 있고 값은 없다.

| 메시지(일부) | 원인 | 조치 |
| ------------ | ---- | ---- |
| `MAILO_DB_ENCRYPTION_KEY_V<n> 또는 ..._V<n>_FILE이 필요하다(현재 버전 키)` | `..._VERSION`이 가리키는 버전의 키 변수가 없다. 지문 키도 같다 | 해당 버전 변수를 추가하거나 `VERSION`을 되돌린다 |
| `<변수>은 32바이트 키(base64 또는 64자 hex)여야 한다` | 키 길이·형식이 틀리다 | `openssl rand -base64 32`로 다시 만든다. base64 한 줄인지 본다(앞뒤 공백과 끝 개행은 무시된다) |
| `<변수>_FILE이 가리키는 파일을 읽지 못했다(ENOENT)` | 경로가 없거나(`ENOENT`) 권한이 없다(`EACCES`) | 마운트 경로와 UID 1000의 읽기 권한을 확인한다 |
| `<변수>_FILE이 가리키는 파일이 비어 있다` | 빈 파일 | 키를 채운다 |
| `<변수>은 저장소에 공개된 샘플 키이거나 같은 바이트가 반복된 키라 production에서 쓸 수 없다(...)` | `NODE_ENV`가 `development`·`test`가 아닌데(없는 경우 포함) `.env.example`의 샘플 키, 적합성 벡터의 JWS 비밀키, 반복 바이트 키를 썼다 | `openssl rand -base64 32`로 새로 만든다. 로컬 시험이면 `NODE_ENV=development`로 둔다 |
| `DB 비밀번호가 저장소에 공개된 샘플 값이라 production(...)에서 쓸 수 없다(...)` | 같은 조건에서 DB 비밀번호가 `mailo-dev-password`다 | `.env`의 `POSTGRES_PASSWORD`와 접속 설정(`MAILO_DB_PASSWORD` 또는 `MAILO_DATABASE_URL`)을 새 값으로 바꾼다. 이미 만든 DB는 `ALTER USER`로 비밀번호도 바꾼다 |
| `<변수>의 버전 번호에 앞자리 0을 쓸 수 없다(..._V1처럼 쓴다)` | `..._V01`처럼 앞자리 0이 있는 변수 이름이다(`_V1`과 다른 변수) | 변수 이름을 `_V1`로 고친다 |
| `DB 본문 암호화 키링와 지문 키링가 같은 키를 쓴다. 두 키는 서로 달라야 한다` | 두 키링이 같은 바이트를 가진다 | 한쪽을 새로 발급한다 |
| `MAILO_JWS_IAT_MAX_AGE_SECONDS는 MAILO_RECORD_RETENTION_SECONDS에서 MAILO_JWS_IAT_SKEW_SECONDS를 뺀 값 이하여야 한다` | 허용 기간 + 오차가 Key 보존 기간을 넘는다 | 허용 기간을 줄이거나 보존 기간을 늘린다 |
| `MAILO_ENVELOPE_KEYS_FILE을 읽지 못했다(<code>)`, `...이 올바른 JSON이 아니다` | 키 목록 파일 경로·형식 오류 | 경로, JSON 구문을 확인한다 |
| `envelope keys: ... keys 배열이 하나 이상 필요하다` | `keys`가 비었다 | 항목을 추가한다. JWE를 쓰지 않으려면 `MAILO_ENVELOPE_KEYS_FILE`을 비운다 |
| `envelope keys[<i>]: 저장소에 공개된 샘플 JWE 키라 production에서 쓸 수 없다(...)` | `NODE_ENV`가 `development`·`test`가 아닌데(없는 경우 포함) 적합성 벡터의 JWE 개인키를 항목에 썼다 | `openssl genpkey`로 새 키를 발급해 바꾼다. 로컬 시험이면 `NODE_ENV=development`로 둔다 |
| `<변수> 또는 <변수>_FILE이 필요하다(envelope keys[<i>])` | 항목의 `privateKeyVar`가 가리키는 변수가 없다 | 개인키 변수를 마운트한다 |
| `<변수>은 PEM 형식의 RSA 개인키여야 한다` | PEM이 아니거나 공개키를 넣었다 | PKCS#8 개인키 PEM을 넣는다 |
| `<변수>은 RSA 3072비트 키여야 한다` | 다른 길이의 RSA 키 | 3072비트로 다시 발급한다 |
| `envelope keys: retiredAt이 없는 현재 키가 하나 이상 필요하다` | 모든 항목에 `retiredAt`이 있다 | 현재 키 항목에서 `retiredAt`을 뺀다 |
| `envelope removed[<i>]: 교체 시각부터 Key 보존 기간(MAILO_RECORD_RETENTION_SECONDS)이 지나기 전에는 이전 키를 삭제할 수 없다` | `removedAt - retiredAt`이 보존 기간 미만이다 | 보존 기간이 지난 뒤에 삭제한다. 시각을 고쳐 적는 것은 기록을 허위로 만든다 |
| `envelope removed[<i>].removedAt이 현재 시각보다 미래다` | `removedAt`이 기동 시각보다 뒤다(시각을 잘못 적었거나 아직 삭제하지 않았다) | 실제로 삭제한 시각을 적는다 |
| `envelope removed[<i>].kid가 keys에도 있다` | 삭제 기록과 현재 항목이 겹친다 | 둘 중 하나를 고친다 |
| `callers[<i>].signature.mode는 required 또는 none으로 명시해야 한다` | 서명 사용 여부가 없다(기본값 없음) | `required` 또는 `none`을 적는다 |
| `callers[<i>].signature.keys는 키 1~2개의 배열이어야 한다` | `required`인데 키가 0개이거나 3개 이상 | 1~2개로 맞춘다 |
| `callers[<i>].signature.keys는 signature.mode가 none이면 둘 수 없다` | `none`에 `keys`가 있다 | `keys`를 지우거나 `required`로 바꾼다 |
| `<변수> 또는 <변수>_FILE이 필요하다(callers[<i>].signature.keys[<j>])` | `secretVar`가 가리키는 변수가 없다 | JWS 비밀키 변수를 마운트한다 |
| `MAILO_OPS_ADMIN_NAMES의 <n>번째 이름은 ...`, `...에 같은 이름이 두 번 있다`, `...는 이름을 8개까지 받는다` | 관리 토큰 이름 형식·중복·개수 위반 | 이름을 `[a-z][a-z0-9]{0,31}`로 고치고 중복을 없앤다 |
| `MAILO_OPS_ADMIN_NAMES의 이름 <이름>에 해당하는 MAILO_OPS_ADMIN_TOKEN_<이름>이 설정되지 않았다` | 이름 목록에 있는데 토큰이 없다 | 토큰 변수(또는 `_FILE`)를 추가하거나 이름을 뺀다 |
| `MAILO_OPS_ADMIN_TOKEN_<이름>은 공백 없는 32자 이상이어야 한다` | 짧거나 공백이 있다 | `openssl rand -base64 32`로 다시 만든다 |
| `<변수>이 <변수>과 같은 값이다. 토큰마다 달라야 한다` | 읽기·관리 토큰이 겹친다 | 토큰마다 새로 발급한다 |
| `<변수>이 호출처 API 키와 같은 값이다` | 운영 토큰이 호출처 키와 같다 | 운영 토큰을 새로 발급한다 |
| `callers[<i>].apiKeyHashes는 해시 1~2개의 배열이어야 한다`, `...가 다른 키와 겹친다` | 해시 개수·중복 오류 | 해시를 1~2개로, 호출처 사이에 겹치지 않게 한다 |

- 개인키 파일(JWE)·키 목록은 Nest 모듈 생성 중에 읽으므로 같은 형식의 오류가 출력된다. 일부 키링 구성 오류(`PrivateKeyRingError`)는 `기동 실패: PrivateKeyRingError`로만 출력될 수 있다(코드 읽기 결과, 재현하지 않았다).
- 한 단계(환경 변수 설정, 호출처 레지스트리, 개인키 목록) 안의 오류는 모아서 한 번에 출력된다. 한 단계를 고치면 다음 단계의 오류가 나올 수 있다.

## 검증하지 않은 것

- 키 교체 절차 전체를 운영 환경에서 실행하지 않았다. 단위·통합 테스트는 개별 규칙(키 2개 교체, 이전 `kid` 복호화, 보존 기간 전 삭제 거부, 지문 키 교체 뒤 재시도, DB 키 교체 뒤 복호화)을 확인한다.
- 다중 인스턴스에서 키 버전이 어긋났을 때의 동작(위 3단계 이유)은 코드 읽기 결과다.
- nimbus-jose-jwt 10.10은 JWE(`RSA-OAEP-256`+`A256GCM`)와 JWS(`HS256`, flattened)를 한 조합씩 확인했다(`samples/spring-boot-relay/README.md`). 다른 버전·알고리즘, 키 교체 중 이전 `kid`로 암호화한 요청은 확인하지 않았다.
- "키 사고 대응"의 절차 전체를 운영 환경에서 실행하지 않았다. 키 사고에서 쓰는 SQL(본문·지문 키 버전별 건수, 잃은 버전의 비종결 작업, 호출처별 시간별 등록 건수)은 임시 schema에서 실행해 동작을 확인했다(2026-11-24, PostgreSQL 17.11).
- 지문 키 분실 때 REST 503, 파일 `file_ingest_failed`와 DB 본문 키 분실 때 `FAILED` 전이는 코드를 다시 읽어 확인했다. 통합 테스트로 재현하지 않았다. 단위 테스트는 키 버전이 없을 때 `UNKNOWN_KEY_VERSION`이 나는 것까지 확인한다(`test/crypto/body-cipher.spec.ts`, `test/crypto/queue-adapters.spec.ts`).
- 잃은 지문 키 버전의 Key를 가진 파일이 3건 이상 쌓였을 때 같은 폴링의 다른 파일이 밀리는지는 실행하지 않았다(코드 읽기 추정).
- 다중 인스턴스 롤링 중 키·레지스트리 변경의 부분 유효 구간은 실행하지 않았다(`caller-onboarding.md` "레지스트리 변경 반영").
- JWE 개인키 유출 때 조기 삭제의 위협 모델 검토. 해석은 코드 읽기에서 나왔다.
- 적합성 벡터의 JWE 개인키·JWS 비밀키로 production 환경에서 Mailo를 실제로 기동해 거부되는지는 실행하지 않았다. 거부는 `createApp` 안(listen 전)에서 JWE 개인키는 `ENVELOPE_DEPS` DI 팩토리가, JWS 비밀키는 호출처 레지스트리 로더가 던지는 오류다(코드 읽기와 임시 시험). 단위 테스트(`test/envelope/conformance-vectors.spec.ts`)는 `parseEnvelopeKeys`·`parseCallerRegistry`까지 확인하고 `createApp` 수준 테스트는 없다.
