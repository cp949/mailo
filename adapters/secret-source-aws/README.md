# @cp949/mailo-secret-source-aws

Mailo의 `SecretSource` 계약(`apps/mailo/src/secrets/source.ts`)을 구현하는 AWS Secrets Manager 어댑터다. 결정은 ADR-0016(결정 3·4·8)이다.

- pnpm 워크스페이스·turbo·Mailo CI 밖의 독립 패키지다. Mailo 코드를 import하지 않는다.
- `@aws-sdk/client-secrets-manager`는 이 패키지에만 있다. 기본 이미지에는 들어가지 않고, 릴리스마다 발행하는 변형 이미지 `ghcr.io/cp949/mailo:vX.Y.Z-aws`에만 들어간다.
- npm에 공개하지 않는다(`private: true`).

## 사용

변형 이미지에서 `MAILO_SECRET_ADAPTERS`에 패키지 이름을 지정하고 `X_REF`에 참조를 둔다.

```sh
MAILO_SECRET_ADAPTERS=@cp949/mailo-secret-source-aws
AWS_REGION=ap-northeast-2
MAILO_SMTP_PASSWORD_REF=aws-sm://prod/mailo/smtp#password
```

- 참조 형식은 `aws-sm://<SecretId>[#<JSON 키>]`다. `SecretId`는 비밀 이름(영문 대소문자·숫자·`/_+=.@-`, 최대 512자) 또는 ARN이다. 공백·제어문자가 있거나 형식이 다르면 SDK를 부르기 전에 `invalid-value`로 거부한다.
- ARN을 쓰면 ARN의 지역이 `AWS_REGION`과 같아야 한다. 코드는 `AWS_REGION`만 쓰고 ARN의 지역을 읽지 않는다.
- `SecretString`을 `AWSCURRENT` 단계로 읽는다. `SecretBinary`는 지원하지 않는다.
- `#<키>`가 있으면 `SecretString`을 JSON 객체로 읽어 그 키의 문자열 값만 돌려준다. 키는 `[A-Za-z0-9_.-]+`이고 `#`은 하나만 쓴다. compose `.env`에서는 `#` 바로 앞에 공백을 두지 않으면 값의 일부다(공백이 있으면 주석으로 잘린다. `docker compose config`와 `docker run --env-file`로 확인했다).
- `AWS_REGION`은 필수다. 자격 증명은 AWS SDK 기본 체인에서 얻는다.
- 호환 서버(LocalStack 등)는 SDK 표준 환경 변수 `AWS_ENDPOINT_URL_SECRETS_MANAGER`(또는 `AWS_ENDPOINT_URL`)로 지정한다.
- 요청마다 SDK 클라이언트를 만들고 해석이 끝나면 `destroy()`한다. 그래서 `X_REF` 변수가 N개면 클라이언트 생성과 자격 증명 조회도 N번이다(같은 `SecretId`를 가리켜도 합치지 않는다). SDK 기본 재시도를 쓴다(한 번의 해석에 최대 3회 시도, 첫 요청 포함).

## 오류

오류는 `code`에 닫힌 코드 5개 중 하나를 싣고, 메시지는 코드마다 고정 문구다. SDK의 오류 메시지, 요청 ID, SecretId, 값은 싣지 않는다. 분류하지 못한 오류는 `code` 없이 던져 Mailo가 `adapter-error`로 보고한다.

| 코드            | 원인                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `not-found`     | 비밀이 없다(`ResourceNotFoundException`)                                                                                       |
| `access-denied` | 권한·자격 증명·서명·KMS 복호화 거부, 자격 증명을 얻지 못함                                                                     |
| `throttled`     | 요청 제한                                                                                                                      |
| `unavailable`   | 서비스 오류(5xx), 네트워크 오류, 시간 초과, `signal` abort                                                                     |
| `invalid-value` | 참조 형식 오류, `AWS_REGION` 없음, `SecretBinary`만 있음, JSON이 아니거나 키가 없거나 값이 문자열이 아님, 잘못된 요청 파라미터 |

## 검증

```sh
cd adapters/secret-source-aws
pnpm install --frozen-lockfile
pnpm test
```

테스트는 가짜 SDK 클라이언트(`test/index.test.mjs`)와 로컬 HTTP fixture를 거치는 실제 SDK(`test/sdk.test.mjs`)를 쓴다. 실제 AWS(IAM, KMS, 자격 증명 체인, 서명 검증)는 확인하지 않는다.

변형 이미지 빌드와 스모크는 `docs/operations/ci.md`의 "어댑터 잡"을 따른다.
