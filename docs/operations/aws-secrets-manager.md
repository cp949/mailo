# AWS Secrets Manager 연동

비밀값(DB 비밀번호, SMTP 비밀번호, 암호화 키, 운영 토큰 등)을 AWS Secrets Manager에서 기동 때 한 번 읽는 방법이다(ADR-0016, RQ-075~081).
`X_REF` 규약, 변수 목록, 충돌 규칙, 로그 이벤트는 `deployment.md` "외부 시크릿 소스(`X_REF`)"가 소유하고 이 문서는 AWS 쪽 구성(IAM, KMS, 자격 증명, 비밀 형식)과 운영 절차를 다룬다.

검증 범위(2026-11-24).

- 어댑터와 변형 이미지는 가짜 HTTP 서버, LocalStack 4.12(Auth Token 없이 시작하는 고정 태그), 컨테이너 스모크로 확인했다("LocalStack 수동 시나리오").
- 실제 AWS 계정에서는 실행하지 않았다. 이 문서의 AWS 동작 기술은 출처를 붙였다. "AWS 문서 확인"은 2026-11-24에 AWS 공식 문서를 읽은 것이고 "기억"은 읽지 않은 것이다.

## 언제 쓰는가

| 기준 | `_FILE`·환경 변수(기본) | `X_REF`(`aws-sm://`) |
| ---- | ------------------------ | -------------------- |
| 비밀 보관 위치 | 호스트 파일·compose secrets·플랫폼 시크릿 | AWS Secrets Manager |
| 이미지 | 기본 이미지 | 변형 이미지 `vX.Y.Z-aws` |
| 새로 필요한 것 | 없음 | 저장소 접근 자격 증명, IAM 정책, `AWS_REGION` |
| 기동 때 외부 의존 | 없음 | Secrets Manager. 닿지 못하면 새 인스턴스가 뜨지 못한다. 실행 중 인스턴스는 영향이 없다 |
| 값 교체 | 파일 교체 뒤 재시작 | 저장소 교체 뒤 재시작(자동 반영 없음) |

선택 규칙.

- 이미 AWS에서 운영하고 비밀을 중앙에서 보관·감사하려면 `X_REF`를 쓴다.
- ECS·EKS처럼 플랫폼이 Secrets Manager 값을 환경 변수나 파일로 주입하는 기능이 있으면 그 기능으로 받아 `X`·`X_FILE`에 두는 방법도 있다. 이 경우 변형 이미지와 어댑터가 필요 없다. 플랫폼 기능의 세부는 기억이고 확인하지 않았다.
- 단일 호스트 compose에서 비밀 파일을 마운트할 수 있으면 `_FILE`이 의존이 적다. `X_REF`로 옮겨도 저장소 접근 자격 증명이라는 비밀 하나는 남는다(ADR-0016 결정 8).
- `X_REF`는 값을 바꿔도 실행 중 프로세스에 반영하지 않는다. 재시작 없는 교체가 필요하면 이 기능으로 풀 수 없다(ADR-0016 결정 7).

## 구성

1. 이미지: `ghcr.io/cp949/mailo:vX.Y.Z-aws`. 기본 이미지에는 어댑터와 AWS SDK가 없다. 변형 이미지의 태그, 발행 순서, 늦거나 없을 수 있는 경우는 `deployment.md` "AWS 변형 이미지(`-aws`)"와 `ci.md` "variants 잡"이다.
2. 환경 변수.

   | 변수 | 값 | 비고 |
   | ---- | -- | ---- |
   | `MAILO_SECRET_ADAPTERS` | `@cp949/mailo-secret-source-aws` | 필수. 없으면 `X_REF`가 `unknown-scheme`으로 거부된다 |
   | `AWS_REGION` | 비밀이 있는 리전(예: `ap-northeast-2`) | 필수. 어댑터는 이 값만 쓴다. ARN의 리전은 읽지 않는다. ARN을 쓰면 ARN의 지역이 `AWS_REGION`과 같아야 한다(어긋날 때 서비스 응답의 분류는 추정이다. `troubleshooting.md` 참조) |
   | `MAILO_SECRET_RESOLVE_TIMEOUT_MS` | 기본 10000, 범위 100~60000 | 해석 1건과 어댑터 `import()` 1건의 제한 시간. 어댑터 내부의 SDK 재시도가 이 안에서 일어난다. SDK 기본값은 한 번의 해석에 최대 3회 시도(첫 요청 포함, 재시도 2회)다 |
   | `X_REF` 변수 | `aws-sm://<SecretId>[#<JSON 키>]` | 변수 이름 목록과 충돌 규칙은 `deployment.md`. 변수마다 `GetSecretValue`가 1회 나간다 |
   | `AWS_ENDPOINT_URL_SECRETS_MANAGER` | 지정하지 않는다 | LocalStack 같은 호환 서버 전용이다. 운영에서 지정하면 요청이 그 주소로 간다. 전역 `AWS_ENDPOINT_URL`도 SDK가 읽는다(어댑터 `README.md`의 설명이고 이 변수는 시험하지 않았다). 운영에서는 둘 다 지정하지 않는다 |

3. 같은 변수에 `X`·`X_FILE`이 남아 있으면 `conflict`다. compose에서는 `X: ""`로 비운다. 예시는 `deployment.md`.
4. 쓰지 않는 `_REF`를 남기지 않는다. 환경에 있는 `_REF`는 모두 해석하므로 쓰지 않는 비밀의 읽기 권한이 필요하다.

## 비밀 값 형식

참조는 두 가지다.

| 참조 | 읽는 값 |
| ---- | ------- |
| `aws-sm://mailo/prod/ops-token` | `SecretString` 전체 |
| `aws-sm://mailo/prod/bundle#db-password` | `SecretString`을 JSON 객체로 읽고 그 키의 문자열 값 |

- `SecretId`는 비밀 이름(영문 대소문자·숫자·`/_+=.@-`, 최대 512자) 또는 ARN이다. 형식이 틀리면 SDK를 부르기 전에 `invalid-value`다.
- JSON 키는 `[A-Za-z0-9_.-]+`이고 `#`은 하나만 쓴다. 값이 문자열이 아니거나 키가 없으면 `invalid-value`다.
- `AWSCURRENT` 단계만 읽는다. `SecretBinary`, 버전·단계 지정, 중첩 JSON 키는 지원하지 않는다.
- compose `.env`에서는 `#` 바로 앞에 공백을 두지 않는다. 공백이 있으면 그 뒤가 주석으로 잘려 JSON 키 없는 참조가 된다(어댑터 `README.md`, `docker compose config`로 확인).

값 끝의 개행.

- `X_REF` 값은 개행을 자르지 않는다(`_FILE`은 끝 개행 한 개를 자른다). SMTP·DB 비밀번호에 개행이 붙으면 인증에서 실패한다. 증상은 `troubleshooting.md` "기동 시 비밀값 해석 실패"의 개행 항목이다.
- AWS CLI `--secret-string file://<파일>`은 파일 끝의 개행을 그대로 저장한다. AWS CLI 2.37.5와 LocalStack 4.12로 확인했다(`abc\n` 파일이 `"abc\n"`으로 저장됨).
- 값은 셸 인자에 직접 쓰지 않고(셸 기록에 남는다) 개행 없는 임시 파일에서 읽는다.

```sh
# 값 생성 예. 임시 파일은 소유자만 읽게 만들고 쓴 뒤 지운다.
umask 077
tmp="$(mktemp)"
openssl rand -base64 32 | tr -d '\n' > "$tmp"
aws secretsmanager create-secret \
  --name mailo/prod/db-key-v1 \
  --secret-string "file://$tmp" \
  --region ap-northeast-2
rm -f "$tmp"
```

비밀 나누기.

- 버전이 있는 키(DB 본문 키 `_V<n>`, 지문 키 `_V<n>`, JWE 개인키, 호출처 JWS 비밀키)는 버전마다 별도 비밀로 두고 값을 바꾸지 않는다. 같은 비밀에 JSON으로 묶으면 그 비밀을 다시 쓸 때 이미 쓰는 버전의 값이 바뀔 위험이 있다(`key-management.md`).
- SMTP·DB 비밀번호, 운영 토큰처럼 값 하나를 교체하는 비밀은 JSON 하나에 묶어도 된다. 대신 변수 N개가 같은 비밀을 가리키면 `GetSecretValue`가 N번 나간다.
- ARN 끝 6자는 AWS가 붙이는 무작위 문자열이다. 비밀을 지우고 같은 이름으로 다시 만들면 ARN이 바뀐다(AWS 문서 확인). ARN 참조는 그때 `not-found`가 되므로 이름 참조가 재생성에 강하다. ARN은 다른 계정의 비밀을 읽을 때 필요하다(기억).

## IAM 최소 권한

어댑터는 `GetSecretValue`만 부른다(`adapters/secret-source-aws/index.js`). `DescribeSecret`, `ListSecrets`, `BatchGetSecretValue`는 필요 없다. 아래 정책의 `<REGION>`·`<ACCOUNT_ID>`·`<KEY_ID>`는 실제 값으로 바꾼다.

비밀을 하나씩 지정한다(권장). 이름 끝의 `-??????`는 AWS가 붙이는 6자를 한 글자씩 맞춘다(AWS 문서 확인: 예시가 `another_secret_name-??????`를 쓴다).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": [
        "arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:mailo/prod/bundle-??????",
        "arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:mailo/prod/db-key-v1-??????"
      ]
    }
  ]
}
```

- 경로로 묶으려면 `secret:mailo/prod/*`를 쓸 수 있다(AWS 문서 확인: `TestEnv/*` 예시). 그 경로에 나중에 만드는 비밀도 읽을 수 있게 된다.
- 이름 끝을 `-*`로 두면 `name-<아무 문자열>a1b2c3`처럼 이름이 더 긴 다른 비밀도 맞는다(AWS 문서 확인). 이름 끝은 `-??????`로 쓴다.

KMS 키에 따라 달라지는 부분.

| 비밀의 암호화 키 | 정책에 더할 것 |
| ---------------- | -------------- |
| AWS 관리형 키 `aws/secretsmanager` | 같은 계정에서는 없다. 이 키의 키 정책이 "Secrets Manager가 계정 주체를 대신해 요청할 때"의 `kms:Decrypt`를 허용한다(AWS 문서 확인: 키 정책 예시를 읽었다. 실제 호출로는 확인하지 않았다). 다른 계정에서는 이 키를 쓸 수 없다(AWS 문서 확인: 관리형 키는 교차 계정 접근을 지원하지 않는다) |
| 고객 관리형 키 | `kms:Decrypt`를 그 키의 ARN에 허용한다(AWS 문서 확인). 키 정책도 이 역할을 허용해야 한다(기억) |

```json
{
  "Effect": "Allow",
  "Action": "kms:Decrypt",
  "Resource": "arn:aws:kms:<REGION>:<ACCOUNT_ID>:key/<KEY_ID>",
  "Condition": {
    "StringEquals": { "kms:ViaService": "secretsmanager.<REGION>.amazonaws.com" }
  }
}
```

`kms:ViaService` 조건은 Secrets Manager를 거친 요청에만 키 사용을 허용한다(AWS 문서 확인). 이 조건을 넣었을 때 `GetSecretValue`가 통과하는지는 실제 계정에서 확인하지 않았다. 통과하지 않으면 `access-denied`로 나타난다.

권한이 부족하면 어댑터는 `access-denied`로 분류한다. 비밀 접근 정책과 KMS 키 정책 중 어느 쪽이 거부했는지는 Mailo 로그로 구분되지 않는다. AWS CloudTrail에서 확인한다(기억).

## 자격 증명

어댑터는 AWS SDK for JavaScript v3의 기본 자격 증명 체인을 쓴다. 코드에서 키를 지정하지 않는다. SDK 공통 체인은 처음 찾은 자격 증명에서 멈춘다(AWS 문서 확인). JavaScript SDK의 정확한 제공자 순서는 읽지 않았다.

| 실행 환경 | 권장 | 주의 |
| --------- | ---- | ---- |
| ECS | 태스크 역할(task role)에 위 정책을 붙인다 | 이미지를 받거나 로그를 쓰는 task execution role은 애플리케이션의 호출 권한이 아니다(기억) |
| EKS | IRSA 또는 EKS Pod Identity로 ServiceAccount에 역할을 연결한다 | SDK 공통 체인 문서가 웹 ID 토큰 제공자와 컨테이너 제공자(ECS·EKS)를 나열한다(AWS 문서 확인). 이 이미지에서 시험하지 않았다 |
| EC2 | 인스턴스 프로파일에 역할을 붙인다 | 아래 IMDSv2 주의 |
| AWS 밖(온프레미스, 단일 호스트) | 정적 액세스 키는 마지막 수단이다 | `AWS_ACCESS_KEY_ID` 등은 환경 변수라 `docker inspect`에 보이고 교체 부담이 있다. 최소 권한 IAM 사용자로 한정한다 |

환경 변수의 `AWS_ACCESS_KEY_ID`가 남아 있으면 연결한 역할보다 먼저 쓰일 수 있다(기억, JavaScript SDK 체인의 순서는 읽지 않았다). 역할을 쓰려면 환경 변수 키를 주지 않는다.

IMDSv2와 컨테이너(EC2 인스턴스 프로파일을 쓸 때).

- IMDSv2 토큰 요청(`PUT`)의 응답 hop limit 기본값은 1이다(AWS 문서 확인). 문서는 인스턴스에서 도는 컨테이너 서비스를 위해 값을 올릴 수 있다고 쓰고 `aws ec2 modify-instance-metadata-options --http-put-response-hop-limit`을 안내한다.
- Docker 기본 bridge 네트워크의 컨테이너는 호스트보다 한 단계 더 거치므로 값을 2 이상으로 올려야 한다(기억, 확인하지 않았다).
- 올리지 않았을 때 어댑터에서 보이는 증상은 확인하지 않았다. 어댑터는 자격 증명을 얻지 못한 오류를 `access-denied`로 분류하고, 응답이 없으면 `timeout`이나 `unavailable`일 수 있다(추정).
- 컨테이너 안에서 먼저 자격 증명이 잡히는지 보려면 `docker run`으로 같은 네트워크 설정의 컨테이너를 띄워 IMDS 응답을 확인한다. 이 명령은 실행하지 않았다.

## 값 교체와 재시작

- 값은 기동 때 한 번만 읽는다. 저장소에서 바꾸면 재시작해야 반영된다(ADR-0016 결정 7).
- 한 값만 쓰는 비밀(SMTP·DB 비밀번호, 운영 토큰): 저장소에서 새 값을 만든다, 상대편(SMTP 계정, PostgreSQL)이 새 값을 받게 한다, 롤링 재시작한다, 이전 값을 폐기한다. 절차와 이유는 `key-management.md` "기타 시크릿"의 외부 시크릿 소스 항목이다.
- 버전이 있는 키는 새 버전을 새 비밀로 추가하고 현재 버전을 올린다. 이전 키 비밀은 그 키로 만든 데이터가 사라질 때까지 지우지 않는다.
- Secrets Manager의 자동 교체(rotation)를 켜지 않는다. 버전이 있는 키는 값이 바뀌면 복호화와 지문 비교가 깨진다. SMTP·DB 비밀번호에 자동 교체를 쓰려면 교체 직후 모든 인스턴스를 재시작하는 절차를 따로 마련해야 한다(이 절차는 만들지 않았고 확인하지 않았다).
- 어댑터는 `AWSCURRENT`만 읽는다. 교체 중 이전 값(`AWSPREVIOUS`)으로 되돌아가지 않는다.

## 시작 실패와 조치

실패한 인스턴스는 종료 코드 1이다. 로그에서 사유를 확인한다.

```sh
docker compose logs --no-log-prefix mailo | jq -c 'select(.event=="startup_failed") | .message'
```

메시지 형식은 `비밀값 해석 실패: <변수>(<방식>): <종류>`다. 종류 전체와 어댑터 로드 실패는 `troubleshooting.md` "기동 시 비밀값 해석 실패"가 소유한다. 아래는 AWS 어댑터가 붙이는 닫힌 코드 5개의 AWS 쪽 원인이다.

| 코드 | AWS 쪽 원인 | 확인과 조치 |
| ---- | ----------- | ----------- |
| `adapter-error:not-found` | 이름 오타, 리전 불일치(`AWS_REGION`이 비밀의 리전과 다르다), 비밀이 없음. ARN 참조의 지역이 `AWS_REGION`과 다를 때의 분류는 추정이다(`troubleshooting.md`) | 조회 권한이 있는 관리자 자격으로 `aws secretsmanager describe-secret --secret-id <이름> --region <리전>`을 실행해 같은 리전에 있는지 본다(Mailo의 정책에는 `DescribeSecret`이 없다). ARN 참조는 비밀을 재생성하면 바뀐다 |
| `adapter-error:access-denied` | IAM 정책 없음·`Resource` 불일치, KMS `kms:Decrypt` 없음, 자격 증명을 얻지 못함(역할 미연결, IMDSv2 hop limit) | 정책의 `Resource`가 비밀 ARN과 같은지, 고객 관리형 키면 `kms:Decrypt`와 키 정책을 본다. 컨테이너에 자격 증명이 들어오는지 본다. 어느 쪽이 거부했는지는 CloudTrail(기억) |
| `adapter-error:throttled` | 요청 제한 | 인스턴스를 한꺼번에 재시작하지 않는다. 같은 비밀을 가리키는 변수가 많으면 호출이 변수 수만큼 나간다 |
| `adapter-error:unavailable` | Secrets Manager 엔드포인트에 닿지 못함(DNS, 보안 그룹, VPC 엔드포인트 없음), 서비스 오류, 시간 초과 | 컨테이너에서 `secretsmanager.<리전>.amazonaws.com`에 닿는지 본다. 프라이빗 서브넷이면 NAT 또는 VPC 엔드포인트가 필요하다(기억). 이미 실행 중인 인스턴스는 영향이 없다 |
| `adapter-error:invalid-value` | `AWS_REGION` 없음, ARN 참조의 지역과 `AWS_REGION` 불일치(분류는 추정, `troubleshooting.md`), 비밀 이름 형식 오류, `SecretBinary`만 있음, JSON이 아님·키가 없음·문자열이 아닌 값, 서비스가 요청을 거부함(삭제 예약된 비밀 등, 기억) | 비밀의 `SecretString`과 `#<키>` 철자를 본다 |

- 닫힌 코드는 진단 힌트다. 분류를 잘못 붙이면 원인을 잘못 읽을 수 있다. AWS 쪽 오류 이름과 코드 대응은 어댑터 `README.md`다.
- 코드 없는 `adapter-error`는 어댑터가 분류하지 못한 오류다. SDK 오류 메시지는 로그에 나오지 않는다.

## 로그에서 확인할 것

| 이벤트 | 필드 | 뜻 |
| ------ | ---- | -- |
| `secrets_resolved`(info) | `count`, `schemes` | 기동 때 해석한 건수와 scheme(`aws-sm`). 해석 대상이 없으면 남지 않는다 |
| `startup_failed`(error) | `message` | 해석 실패면 변수 이름, 방식, 종류만 담는다 |

```sh
docker compose logs --no-log-prefix mailo | jq -c 'select(.event=="secrets_resolved")'
```

로그, 오류, 지표, 헬스 응답에 나오지 않는 것: 비밀 값, 참조 문자열(SecretId·ARN), SDK 오류 메시지, AWS 요청 ID. 컨테이너 환경(`docker inspect`의 `Config.Env`)에는 참조 변수(`X_REF`)와 정적 키를 쓰는 경우의 `AWS_*` 값이 보인다. 해석한 값은 보이지 않는다. LocalStack 시나리오에서 `Config.Env`와 초기 프로세스 환경(`/proc/1/environ`)에 해석 값이 없고 참조만 있음을 확인했다. `/proc/<pid>/environ`은 프로세스 시작 때의 환경이라 앱이 `process.env`를 바꿔도 달라지지 않는다. 앱이 `process.env`를 바꾸지 않는 성질은 단위 테스트가 보증하고 메모리 노출은 시험하지 않았다.

## 롤백

위험도: 중간. 변수와 이미지를 함께 되돌려야 하고, 저장소에 닿지 못하는 동안 새 인스턴스는 뜨지 못한다.
롤백: `X_REF`를 `_FILE` 또는 환경 변수로 되돌리고 기본 이미지로 교체한다. 데이터·마이그레이션 변경이 없다.

1. `X_REF`가 가리키던 값을 `_FILE`(권장) 또는 환경 변수로 준비한다. 값은 저장소에서 꺼내 시크릿 마운트에 넣는다.
2. 설정을 바꾼다. 같은 변수에 `X_REF`와 `X`·`X_FILE`을 함께 두면 `conflict`로 기동하지 않으므로 `X_REF`를 지우고 `X_FILE`을 준다.
3. 이미지를 기본 이미지로 바꾸고(또는 `-aws`를 유지하고 `MAILO_SECRET_ADAPTERS`만 비운다) 롤링 재시작한다.
4. 기능이 없는 이전 버전으로 되돌릴 때는 먼저 1~2를 끝낸다. 이전 버전은 `_REF`를 읽지 않고 무시한다. 필수 비밀은 "필요하다" 오류로 기동하지 않아 안전하지만 선택 비밀 `MAILO_OPS_TOKEN`은 값이 없으면 읽기 토큰 없이 기동한다(`deployment.md` "롤백 경고").
5. 발행된 `-aws` 태그는 GHCR에 남는다. 지우는 일은 롤백에 필요하지 않다.

## LocalStack 수동 시나리오

실제 AWS 없이 변형 이미지와 SDK의 요청 흐름을 확인하는 수동 시나리오다. 자동 테스트와 CI가 아니다. `scripts/secrets-localstack/`에 있다.

LocalStack 라이선스·이미지 정책(2026-11-24 확인, ADR-0016 "구현 중 확정").

- LocalStack for AWS는 2026-03-23(`2026.03.0`)부터 `localstack/localstack` 이미지 하나로 나오고 시작에 Auth Token이 필요하다(LocalStack 릴리스 노트, 공지 글 2026-03-05, 인증 문서).
- 무료 Hobby 플랜은 비상업 용도다. 상업 용도는 유료 플랜이다. Hobby 플랜 사용에 LocalStack 계정이 필요한지는 문서에서 확인하지 못했다.
- 2026-04-06까지는 `LOCALSTACK_ACKNOWLEDGE_ACCOUNT_REQUIREMENT=1` 우회가 있었다. 지금은 끝났다.
- 로컬 실행 결과: `localstack/localstack-pro:2026.08.2`는 토큰 없이 종료 코드 55로 끝난다(`License activation failed`). `localstack/localstack:4.12`(4.12.0, 빌드 2025-12-11)는 토큰 없이 시작하고 `edition: community`를 보고하며 `secretsmanager`가 `available`이다.
- 4.12는 갱신이 없는 고정 이미지다(공지 글: 고정 버전은 이후 갱신이 없다). 라이선스 조건은 확인하지 않았다. 이 시나리오는 가짜 값만 쓰고 compose 네트워크 안에서만 연다.

결정: 수동 시나리오를 둔다. 기본값은 토큰 없이 시작하는 `4.12` 고정 이미지(digest 포함)다. 최신 이미지를 쓰려면 `LOCALSTACK_IMAGE`와 `LOCALSTACK_AUTH_TOKEN`을 환경에 준다. 토큰은 LocalStack 컨테이너에만 전달하고 저장소에 두지 않는다. 최신 이미지 경로는 토큰이 없어 실행하지 못했다.

실행(Docker, `openssl`, `curl` 필요).

```sh
scripts/secrets-localstack/run.sh              # 이미지를 빌드하고 실행
scripts/secrets-localstack/run.sh --skip-build # 이미 만든 로컬 이미지를 재사용
```

확인하는 것(2026-11-24 `run.sh` 통과, 실패 0건. 건수는 스크립트 출력이 정한다).

- `_REF`만으로(읽기 전용, `cap_drop: [ALL]` 컨테이너) 기동한다. 운영 토큰은 ARN 참조, 나머지는 JSON 키 참조다.
- 운영 토큰 값이 맞아야 `/health/ready`가 운영자 응답(200)이고 틀린 토큰은 401이다.
- DB 비밀번호 값이 맞아야 기동한다(PostgreSQL 비밀번호를 같은 값으로 만든다).
- Mailpit이 SMTP 비밀번호를 검사하고 작업이 `SENT`가 된다. Mailpit의 기대 비밀번호를 다른 값으로 바꾸면 이 항목이 실패하는 것도 확인했다.
- DB 본문 키와 지문 키는 32바이트 키 형식으로 해석돼 작업 등록이 202다. 값이 같은지는 보지 않는다.
- `secrets_resolved`가 `count: 5`, `schemes: aws-sm`으로 남는다.
- Mailo 로그에 값, SecretId, ARN이 없다(`secrets_resolved` 줄이 있어야 통과한다). `docker inspect`의 `Config.Env`와 초기 프로세스 환경(`/proc/1/environ`)에 해석 값이 없고 참조(`_REF`)만 있다. `/proc/1/environ`은 시작 때의 환경만 보므로 앱이 `process.env`를 바꾸는지는 이 검사로 알 수 없다(단위 테스트가 보증하고 메모리 노출은 시험하지 않았다).
- 값 없는 기동 실패: 비밀 없음(`adapter-error:not-found`), JSON 키 없음(`adapter-error:invalid-value`), 평문 값과 `_REF` 동시 지정(`conflict`), 저장소 접근 불가(`adapter-error:unavailable`), 기본 이미지에서 같은 `_REF`(`unknown-scheme`). 모두 종료 코드 1이고 출력에 값이 없다.

한계.

- LocalStack은 IAM 정책과 KMS 권한을 검사하지 않는다. `access-denied`, `throttled` 경로와 자격 증명 체인(역할, IRSA, IMDS)은 이 시나리오로 확인되지 않는다.
- LocalStack 통과는 실제 AWS 동작을 보증하지 않는다. 가짜 자격 증명(`test`/`test`)을 쓴다.
- 시나리오가 만드는 로컬 이미지(`mailo-secrets-localstack-base:local`, `mailo-secrets-localstack-aws:local`)는 정리하지 않고 남긴다.
- compose 프로젝트(이름에 PID가 붙는다)와 볼륨은 종료 때 `down -v`로 지운다. `--keep`이면 지우지 않는다.

```txt
위험도: 낮음 (전용 compose 프로젝트와 임시 디렉터리에 한정. 가짜 값만 쓴다)
롤백: 스크립트를 다시 실행한다. 중단 뒤 남은 프로젝트는 `docker compose -p <출력된 project 이름> down -v`로 지운다
```

## 검증하지 않은 것

- 실제 AWS 계정에서의 모든 동작: IAM 정책 평가, KMS 키 정책과 `kms:ViaService` 조건, 자격 증명 체인(ECS 태스크 역할, EKS IRSA·Pod Identity, EC2 인스턴스 프로파일), 네트워크 제한(VPC 엔드포인트, NAT, 보안 그룹), 실제 지연과 throttling, 리전 불일치와 삭제 예약된 비밀의 서비스 응답.
- EC2의 IMDSv2 hop limit 설정이 컨테이너 자격 증명에 미치는 영향과 미설정 때의 증상.
- Secrets Manager 자동 교체와 `X_REF`를 함께 쓴 재시작 절차.
- LocalStack 최신 이미지(Auth Token 필요) 경로. 4.12 고정 이미지만 실행했다.
- 변형 이미지의 취약점 스캔, 발행된 `-aws` 이미지를 pull해 실행하는 검증(`.github/workflows/release.yml` `variants` 잡의 GitHub 실행은 `v0.6.0`의 run 45380436731에서 성공했다, `ci.md`).
- 이 문서의 "기억" 표기 항목(플랫폼의 비밀 주입 기능, 키 정책 위임, CloudTrail, NAT·VPC 엔드포인트, hop limit 2, 환경 변수 키의 우선순위).
