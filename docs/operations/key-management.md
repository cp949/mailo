# 키 관리

Mailo가 쓰는 키의 발급, 교체, 이전 키 보관, 기동 시 검증 오류 해석을 적는다.
근거는 ADR-0005 결정 3·7, ADR-0008 결정 2·4~7, 코드(`config/key-loader.ts`, `envelope/key-file.ts`, `callers/registry.ts`)다.
`openssl`·`sha256sum` 명령은 2026-11-23 OpenSSL 3.0.2에서 실행해 출력 형식을 확인했다. 교체 절차 전체와 기동 오류 메시지는 코드를 읽어 정했고 운영 환경에서 실행하지 않았다.

## 결론

- 키는 종류가 5개다. DB 본문 키, 지문 키, Mailo JWE 개인키, 호출처 JWS 비밀키, 호출처 API 키(해시). 운영 토큰(읽기·관리)은 키가 아니라 접근 토큰이다("운영 토큰").
- 교체는 새 키를 추가하고 현재 버전을 올리는 방식이다. 이전 키는 해당 키로 만든 데이터가 모두 사라질 때까지 지우지 않는다.
- 이전 키를 지운 실수는 기동 시점에 감지되지 않는 경우가 많다. 지우기 전에 이 문서의 SQL로 남은 행을 확인한다.
- 다중 인스턴스는 새 버전 키를 모든 인스턴스에 먼저 배포한 뒤 현재 버전을 올린다("DB 본문 키 교체").
- JWE 개인키 유출 때 보존 기간 전에 키를 지우는 경로는 없다("유출 대응").

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
- `NODE_ENV`가 `development`·`test`로 명시되지 않으면(`production`이거나 값이 없거나 알 수 없는 값) 저장소에 공개된 샘플 키와 같은 바이트의 DB 본문 키·지문 키를 거부한다. 같은 조건에서 공개 샘플 DB 비밀번호(`mailo-dev-password`)도 거부한다. 거부 대상: `.env.example`·`docker-compose.volume-example.yml`의 `MAILO_DB_ENCRYPTION_KEY_V1`(`fake-db-key-for-dev-only-0000000`의 base64)과 `MAILO_FINGERPRINT_KEY_V1`(`fake-fingerprint-key-dev-only-00`의 base64), 그리고 32바이트가 모두 같은 값인 키(테스트 픽스처가 `Buffer.alloc(32, n)`으로 만드는 형태). base64·hex 어느 표기로 줘도 같은 바이트로 비교한다. 이전 버전 변수(`_V1` 등)도 검사한다. 오류에는 변수 이름과 사유만 나오고 키 값은 나오지 않는다. `development`·`test`는 허용한다.
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

## 호출처 JWS 비밀키

용도: 파일 채널에서 `signature.mode: "required"`인 호출처의 서명. REST는 서명을 쓰지 않는다. 비밀키는 Mailo와 호출처가 같은 값을 가진다(HS256). 해시로 둘 수 없다.

발급:

```sh
umask 077; openssl rand -base64 32 > mailo_jws_billing_2026_12
```

- 호출처마다 다른 키를 쓴다. 한 호출처의 키로 다른 호출처 이름의 서명은 통과하지 못한다. 같은 키를 두 호출처·두 `kid`에 쓰거나 DB 본문 키·지문 키와 같은 키를 쓰면 Mailo가 기동하지 않는다. `NODE_ENV`가 `development`·`test`가 아니면 같은 바이트가 반복된 키와 공개 샘플 키도 거부한다(ADR-0008 구현 중 확정 13).
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
  - 잘못된 값은 그 계정의 작업만 `AUTH` 사유를 낸다. 계정별 차단기 행은 완료 경로가 갱신하지만 구현 묶음 B 전에는 점유를 막지 않는다(`deployment.md` "SMTP 계정"의 한계).
  - 계정 ID를 바꾸려면 새 계정을 만들고 호출처를 옮긴다. 새 차단기 행이 생긴다. 이미 등록한 작업은 이전 계정 ID로 남는다.
  - 계정 파일에는 `user`·`from` 주소가 있다(비밀번호 값은 없다). `MAILO_SMTP_USER`와 같은 민감도로 다루고 읽기 전용으로 마운트한다. 로그·오류·지표에는 계정 ID만 쓴다.
  - 기동 오류: 변수가 없으면 `MAILO_SMTP_SECRET_<이름> 또는 MAILO_SMTP_SECRET_<이름>_FILE이 필요하다(accounts[i].auth.secretVar)`, `_FILE`을 읽지 못하면 `MAILO_SMTP_SECRET_<이름>_FILE이 가리키는 파일을 읽지 못했다(<errno>)`다. 값은 오류에 나오지 않는다.
- DB 접속 URL: 비밀번호를 바꾸면 PostgreSQL 계정과 시크릿을 함께 바꾸고 재시작한다.

## 유출 대응

- 지문 키·DB 본문 키: 새 버전으로 교체한다. 이전 버전은 해당 행이 사라질 때까지 필요하므로 유출된 키는 그 기간 동안 남는다. 이전 행의 본문이 사라지는 기본 기간은 DB 본문 키 약 2일, 지문 키 약 31일이다. 덤프가 유출됐다면 그 덤프의 본문은 이미 유출된 키로 열린다.
- JWS 비밀키: 새 키를 추가하고 이전 키를 바로 지운다. 지우는 데 제한 규칙이 없다. 이전 `kid`의 처리 대기 파일은 거부된다.
- API 키: 해시를 지우고 재시작한다.
- 운영 토큰: "운영 토큰"의 유출 대응을 따른다.
- JWE 개인키: 아래 "JWE 개인키 유출"을 따른다.

### JWE 개인키 유출

현재 한계: 유출된 개인키를 보존 기간(`MAILO_RECORD_RETENTION_SECONDS`, 기본 30일)이 지나기 전에 Mailo에서 지우는 정상 경로는 없다. `removed`의 `removedAt - retiredAt`이 보존 기간보다 짧으면 기동을 거부하기 때문이다(`envelope/key-file.ts`, 코드 읽기 결과). 그동안 Mailo는 이전 `kid`로 암호화된 요청을 계속 복호화한다.

키를 지워도 유출 자체는 되돌리지 못한다. 공격자는 개인키로 이미 수집한 암호문을 푼다. 지우면 막는 것은 Mailo가 그 `kid`의 새 요청을 받아들이는 경로뿐이다. 서명(JWS)은 별개 키라 공개키만으로 요청을 위조할 수는 없다(ADR-0008 결정 2, 서명 `required` 호출처 한정).

순서:

1. 새 키 쌍을 발급하고 키 목록에 추가한다. 유출된 항목에 `retiredAt`(교체 시각)을 적고 재시작한다. 새 `kid`와 공개키를 호출처에 전달해 새 요청이 새 키로 가게 한다.
2. 유출된 `kid`의 요청 수신을 멈춘다. 호출처가 이전 `kid`를 더 쓰지 않는지 호출처 담당에게 확인한다. 이 `kid`를 쓰는 요청만 골라 막는 설정은 없다(`kid`는 요청 본문 안에 있다). 모든 호출처가 새 키로 옮긴 것이 확인되기 전에는 이전 키를 남겨 둬야 처리 대기 요청이 `KID_UNKNOWN`으로 거부되지 않는다.
3. 보존 기간이 지날 때까지 기다린다. 지난 뒤 `keys`에서 항목을 빼고 `removed`에 적는다(위 "교체" 4번). 이 경로가 유일하게 기록과 일치하는 정상 절차다.
4. 보존 기간을 기다릴 수 없으면 명시적 운영 판단이 필요하다. 선택지와 대가는 아래와 같다. 코드는 바꾸지 않는다.

| 선택지 | 효과 | 대가 |
| ------ | ---- | ---- |
| `MAILO_RECORD_RETENTION_SECONDS`를 줄이고 재시작 | 기동 검증이 요구하는 최소 간격이 줄어 `removed`를 더 일찍 적을 수 있다 | 종결 작업의 `Idempotency-Key` 중복 방지 기간이 함께 줄어든다. `MAILO_BODY_RETENTION_SECONDS`·`MAILO_JOB_EXPIRY_MAX_SECONDS`(생략하면 `MAILO_JOB_EXPIRY_SECONDS`) 이상, `MAILO_JWS_IAT_MAX_AGE_SECONDS + MAILO_JWS_IAT_SKEW_SECONDS` 이상이어야 기동한다 |
| 처리 대기 요청이 없음을 확인한 뒤 `keys`에서 항목만 지우고 `removed`에 쓰지 않음 | 이전 키가 즉시 사라진다 | 기동 검증이 이 실수를 감지하지 못한다(위 참고). 지운 사유·시각·승인자를 별도 운영 기록에 남긴다. `removed`에 `retiredAt`을 실제보다 앞당겨 적는 것은 기록을 허위로 만들므로 하지 않는다 |

- 위 선택지는 검증하지 않았다. 코드 읽기 결과다.
- 보존 기간 전에 키를 지우기 위한 정식 경로(예: 유출 사유 표기가 있는 `removed` 항목)는 미결정이다. 필요하면 새 ADR로 결정한다(ADR-0008 "미확정").

## 기동 시 검증 오류 해석

설정 오류는 `설정이 올바르지 않다:` 아래에 `- <사유>` 줄로 모두 모아 출력하고 종료 코드 1로 끝난다. 호출처 레지스트리 오류는 `호출처 레지스트리가 올바르지 않다:`로 시작한다. 메시지에는 변수 이름과 위치(`callers[0]`, `envelope keys[1]`)만 있고 값은 없다.

| 메시지(일부) | 원인 | 조치 |
| ------------ | ---- | ---- |
| `MAILO_DB_ENCRYPTION_KEY_V<n> 또는 ..._V<n>_FILE이 필요하다(현재 버전 키)` | `..._VERSION`이 가리키는 버전의 키 변수가 없다. 지문 키도 같다 | 해당 버전 변수를 추가하거나 `VERSION`을 되돌린다 |
| `<변수>은 32바이트 키(base64 또는 64자 hex)여야 한다` | 키 길이·형식이 틀리다 | `openssl rand -base64 32`로 다시 만든다. base64 한 줄인지 본다(앞뒤 공백과 끝 개행은 무시된다) |
| `<변수>_FILE이 가리키는 파일을 읽지 못했다(ENOENT)` | 경로가 없거나(`ENOENT`) 권한이 없다(`EACCES`) | 마운트 경로와 UID 1000의 읽기 권한을 확인한다 |
| `<변수>_FILE이 가리키는 파일이 비어 있다` | 빈 파일 | 키를 채운다 |
| `<변수>은 저장소에 공개된 샘플 키이거나 같은 바이트가 반복된 키라 production에서 쓸 수 없다(...)` | `NODE_ENV`가 `development`·`test`가 아닌데(없는 경우 포함) `.env.example`의 샘플 키나 반복 바이트 키를 썼다 | `openssl rand -base64 32`로 새로 만든다. 로컬 시험이면 `NODE_ENV=development`로 둔다 |
| `DB 비밀번호가 저장소에 공개된 샘플 값이라 production(...)에서 쓸 수 없다(...)` | 같은 조건에서 DB 비밀번호가 `mailo-dev-password`다 | `.env`의 `POSTGRES_PASSWORD`와 접속 설정(`MAILO_DB_PASSWORD` 또는 `MAILO_DATABASE_URL`)을 새 값으로 바꾼다. 이미 만든 DB는 `ALTER USER`로 비밀번호도 바꾼다 |
| `<변수>의 버전 번호에 앞자리 0을 쓸 수 없다(..._V1처럼 쓴다)` | `..._V01`처럼 앞자리 0이 있는 변수 이름이다(`_V1`과 다른 변수) | 변수 이름을 `_V1`로 고친다 |
| `DB 본문 암호화 키링와 지문 키링가 같은 키를 쓴다. 두 키는 서로 달라야 한다` | 두 키링이 같은 바이트를 가진다 | 한쪽을 새로 발급한다 |
| `MAILO_JWS_IAT_MAX_AGE_SECONDS는 MAILO_RECORD_RETENTION_SECONDS에서 MAILO_JWS_IAT_SKEW_SECONDS를 뺀 값 이하여야 한다` | 허용 기간 + 오차가 Key 보존 기간을 넘는다 | 허용 기간을 줄이거나 보존 기간을 늘린다 |
| `MAILO_ENVELOPE_KEYS_FILE을 읽지 못했다(<code>)`, `...이 올바른 JSON이 아니다` | 키 목록 파일 경로·형식 오류 | 경로, JSON 구문을 확인한다 |
| `envelope keys: ... keys 배열이 하나 이상 필요하다` | `keys`가 비었다 | 항목을 추가한다. JWE를 쓰지 않으려면 `MAILO_ENVELOPE_KEYS_FILE`을 비운다 |
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
- 유출 대응 절차를 정하지 않았다.
