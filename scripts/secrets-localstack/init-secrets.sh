#!/bin/sh
# LocalStack에 시나리오용 비밀을 만든다(가짜 값, 환경으로 받는다). 값은 출력하지 않는다.
# 출력: `OPS_TOKEN_ARN=<LocalStack이 만든 ARN>` 한 줄. run.sh가 읽는다.
set -eu

endpoint="${LOCALSTACK_ENDPOINT:-http://localstack:4566}"
region="us-east-1"

# JSON 비밀: `aws-sm://<SecretId>#<키>` 참조를 확인한다. 값은 영숫자와 `+/=-`뿐이라 JSON 이스케이프가 필요 없다.
aws --endpoint-url "$endpoint" --region "$region" secretsmanager create-secret \
  --name mailo/localstack/bundle \
  --secret-string "{\"db-password\":\"$LS_DB_PASSWORD\",\"smtp-password\":\"$LS_SMTP_PASSWORD\",\"db-key\":\"$LS_DB_KEY\",\"fingerprint-key\":\"$LS_FINGERPRINT_KEY\"}" \
  >/dev/null

# 평문 비밀: 키 없는 참조(SecretString 전체)와 ARN 참조를 확인한다. 끝에 개행을 붙이지 않는다.
arn="$(aws --endpoint-url "$endpoint" --region "$region" secretsmanager create-secret \
  --name mailo/localstack/ops-token \
  --secret-string "$LS_OPS_TOKEN" \
  --query ARN --output text)"
printf 'OPS_TOKEN_ARN=%s\n' "$arn"
