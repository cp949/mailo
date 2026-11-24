#!/usr/bin/env bash
# AWS Secrets Manager 어댑터를 LocalStack으로 확인하는 수동 시나리오(ADR-0016 결정 9, RQ-081). 자동 테스트와 CI가 아니다.
# 변형 이미지(-aws)를 로컬에서 만들고 전용 compose 프로젝트로 LocalStack·PostgreSQL·Mailpit·Mailo를 띄운다.
# 확인: (1) _REF만으로 기동하고 /health/ready(운영 토큰), 작업 등록, 발송(Mailpit이 SMTP 비밀번호를 검사). DB 비밀번호·운영 토큰·SMTP 비밀번호는 값이 맞아야 통과하고 키는 형식만 본다
#       (2) secrets_resolved 로그 (3) 로그·Config.Env·초기 프로세스 환경(/proc/1/environ)에 해석 값이 없고 참조만 있음 (4) 값 없는 기동 실패 5종(비밀 없음, JSON 키 없음, 어댑터 없음, 저장소 접근 불가, 충돌)
# 한계: LocalStack은 IAM·KMS를 검사하지 않는다. 실제 AWS의 권한·자격 증명 체인·네트워크는 확인하지 않는다.
# LocalStack 이미지: 기본은 Auth Token 없이 시작하는 고정 태그(4.12). 최신 이미지는 토큰이 필요하다
#   LOCALSTACK_IMAGE=<이미지> LOCALSTACK_AUTH_TOKEN=<토큰> 으로 준다. 토큰은 LocalStack 컨테이너에만 전달하고 이 저장소에 두지 않는다.
# 사용: scripts/secrets-localstack/run.sh [--skip-build] [--keep]
# 위험도: 낮음. 프로젝트 이름에 PID를 붙인 compose 프로젝트만 만들고 `down -v`로 지운다. 로컬 이미지(mailo-secrets-localstack-*)는 남긴다.
# 롤백: 스크립트 재실행으로 재생성. `--keep`이면 정리하지 않으므로 출력된 project 이름으로 `docker compose -p <이름> down -v`를 실행한다.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
readonly here repo
readonly BASE_IMAGE="mailo-secrets-localstack-base:local"
readonly VARIANT_IMAGE="mailo-secrets-localstack-aws:local"
readonly DEFAULT_LOCALSTACK_IMAGE="localstack/localstack:4.12@sha256:0df3a97da57de03a588c05d9b8f390f15c7033fc7c4512f94619d344bc3cd317"
readonly CLI_IMAGE_PINNED="amazon/aws-cli@sha256:fb7ccfc7b4e3a05017e6c9ded4ba959b99af622130e211fb976c68c2f4d3f224"

skip_build=0
keep=0
for option in "$@"; do
  case "$option" in
    --skip-build) skip_build=1 ;;
    --keep) keep=1 ;;
    *) printf '사용법: %s [--skip-build] [--keep]\n' "$0" >&2; exit 2 ;;
  esac
done

# 호스트 환경이 시나리오로 새지 않게 한다. LocalStack 이미지와 토큰만 받는다.
localstack_image="${LOCALSTACK_IMAGE:-$DEFAULT_LOCALSTACK_IMAGE}"
localstack_token="${LOCALSTACK_AUTH_TOKEN:-}"
for name in $(compgen -v | grep -E '^(AWS_|MAILO_|LS_|LOCALSTACK_|COMPOSE_)'); do unset "$name"; done

readonly PROJECT="mailo-secrets-localstack-$$"
readonly WORK="$(mktemp -d)"
failures=0
checks=0

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
check() { # 인자: 설명, 종료 코드(0이면 통과)
  checks=$((checks + 1))
  if [ "$2" -eq 0 ]; then log "통과: $1"; else log "실패: $1"; failures=$((failures + 1)); fi
}

# 가짜 값. 실행마다 새로 만들고 임시 디렉터리와 이 프로세스 환경에만 둔다.
export LS_DB_PASSWORD="fakedb$(openssl rand -hex 12)"
export LS_SMTP_PASSWORD="fakesmtp$(openssl rand -hex 12)"
export LS_DB_KEY="$(openssl rand -base64 32)"
export LS_FINGERPRINT_KEY="$(openssl rand -base64 32)"
export LS_OPS_TOKEN="fake-ops-token-$(openssl rand -hex 20)"
readonly API_KEY="fake-localstack-api-key-$(openssl rand -hex 16)"
export LOCALSTACK_IMAGE="$localstack_image"
export AWS_CLI_IMAGE="$CLI_IMAGE_PINNED"
export MAILO_AWS_IMAGE="$VARIANT_IMAGE"
[ -n "$localstack_token" ] && export LOCALSTACK_AUTH_TOKEN="$localstack_token"
unset localstack_token

hash="$(printf '%s' "$API_KEY" | sha256sum | cut -d' ' -f1)"
printf '{"callers":[{"id":"alpha","apiKeyHashes":["%s"],"fileChannel":false,"signature":{"mode":"none"}}]}' "$hash" > "$WORK/callers.json"
chmod 0644 "$WORK/callers.json"
export LS_CALLERS_FILE="$WORK/callers.json"
# compose가 파일 전체를 보간하므로 ARN을 알기 전에는 자리 값을 둔다. Mailo는 ARN을 얻은 뒤에만 기동한다.
export LS_OPS_TOKEN_REF="aws-sm://pending"
: > "$WORK/empty.env"

dc() { docker compose -p "$PROJECT" --env-file "$WORK/empty.env" -f "$here/compose.localstack.yml" "$@"; }

# 신호가 `dc up ... >파일` 실행 중에 오면 trap이 그 리디렉션 안에서 돌아 로그가 사라지므로 원래 표준 출력(3번)으로 쓴다.
exec 3>&1
cleanup() {
  if [ "$keep" -eq 1 ]; then
    log "프로젝트 유지: project=$PROJECT (정리: docker compose -p $PROJECT down -v)" >&3
  else
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    log "정리 완료: project=$PROJECT" >&3
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
# 신호로 끝날 때도 EXIT trap(cleanup)이 일반 종료 경로에서 돌고 "정리 완료" 줄을 남기게 한다.
trap 'exit 130' INT
trap 'exit 143' TERM

log "project=$PROJECT localstack=$localstack_image"

if [ "$skip_build" -eq 1 ]; then
  docker image inspect "$BASE_IMAGE" "$VARIANT_IMAGE" >/dev/null 2>&1 || { log "이미지가 없다. --skip-build 없이 실행한다"; exit 1; }
else
  log "기본 이미지 빌드"
  docker build -q -t "$BASE_IMAGE" "$repo" >/dev/null || { log "기본 이미지 빌드 실패"; exit 1; }
  log "변형 이미지 빌드"
  docker build -q --build-arg "MAILO_BASE_IMAGE=$BASE_IMAGE" -t "$VARIANT_IMAGE" "$repo/adapters/secret-source-aws" >/dev/null || { log "변형 이미지 빌드 실패"; exit 1; }
fi

log "LocalStack 기동"
if ! dc up -d --wait --wait-timeout 120 localstack >"$WORK/up-localstack.log" 2>&1; then
  tail -20 "$WORK/up-localstack.log"; dc logs localstack | tail -15
  log "LocalStack이 시작하지 않았다(최신 이미지는 LOCALSTACK_AUTH_TOKEN이 필요하다)"; exit 1
fi

log "비밀 생성"
init_out="$(dc run --rm --no-deps -T secret-init 2>"$WORK/init.err")" || { cat "$WORK/init.err"; log "비밀 생성 실패"; exit 1; }
ops_arn="$(printf '%s\n' "$init_out" | sed -n 's/^OPS_TOKEN_ARN=//p' | tr -d '\r')"
case "$ops_arn" in
  arn:aws:secretsmanager:us-east-1:*:secret:mailo/localstack/ops-token-*) ;;
  *) log "ARN 형식이 예상과 다르다"; exit 1 ;;
esac
export LS_OPS_TOKEN_REF="aws-sm://$ops_arn"

log "Mailo 기동(변형 이미지, read_only, 모든 비밀이 _REF)"
if ! dc up -d --wait --wait-timeout 120 mailo >"$WORK/up-mailo.log" 2>&1; then
  tail -20 "$WORK/up-mailo.log"; dc logs --no-log-prefix mailo | tail -20
  log "Mailo 기동 실패"; exit 1
fi
cid="$(dc ps -q mailo)"
port="$(dc port mailo 3000 | head -1 | sed 's/.*://')"
base_url="http://127.0.0.1:$port"

# 1. 값이 맞아야 통과하는 경로
ready_code="$(curl -sS -o "$WORK/ready.json" -w '%{http_code}' -H "Authorization: Bearer $LS_OPS_TOKEN" "$base_url/health/ready")"
grep -q '"sendControls"' "$WORK/ready.json"; has_controls=$?
[ "$ready_code" = 200 ] && [ "$has_controls" -eq 0 ]; check "운영 토큰(ARN 참조, SecretString 전체)으로 /health/ready가 운영자 응답을 준다(200, sendControls)" $?
anon_code="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong-$LS_OPS_TOKEN" "$base_url/health/ready")"
[ "$anon_code" = 401 ]; check "틀린 토큰은 401이다" $?

post_code="$(curl -sS -o "$WORK/post.json" -w '%{http_code}' -X POST "$base_url/jobs" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: ls-1" \
  -d '{"to":["kim@example.com"],"from":"no-reply@example.com","subject":"localstack scenario","text":"localstack body"}')"
job_id="$(sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p' "$WORK/post.json")"
[ "$post_code" = 202 ] && [ -n "$job_id" ]; check "DB 키·지문 키 _REF(JSON 키 선택)가 올바른 키 형식으로 해석돼 작업 등록이 202다" $?
status=""
for _ in $(seq 1 30); do
  status="$(curl -sS -H "Authorization: Bearer $API_KEY" "$base_url/jobs/$job_id" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
  [ "$status" = SENT ] && break
  sleep 1
done
[ "$status" = SENT ]; check "SMTP 비밀번호 _REF 값으로 Mailpit 인증을 통과해 발송이 SENT가 된다(상태=$status)" $?

# 2. 로그
mailo_logs="$(dc logs --no-log-prefix mailo 2>&1)"
resolved_line="$(printf '%s\n' "$mailo_logs" | grep '"event":"secrets_resolved"' | head -1)"
printf '%s' "$resolved_line" | grep -q '"count":5' && printf '%s' "$resolved_line" | grep -q '"schemes":"aws-sm"'
check "secrets_resolved가 count 5, schemes aws-sm으로 남는다" $?
echo "$resolved_line" | sed 's/^/        /'

# 3. 값 비노출
leak=0
for value in "$LS_DB_PASSWORD" "$LS_SMTP_PASSWORD" "$LS_DB_KEY" "$LS_FINGERPRINT_KEY" "$LS_OPS_TOKEN" "$API_KEY"; do
  printf '%s' "$mailo_logs" | grep -qF -- "$value" && leak=$((leak + 1))
done
printf '%s' "$mailo_logs" | grep -qF -e 'mailo/localstack' -e "$ops_arn" && leak=$((leak + 1))
# 로그가 비어 있으면 통과하지 않는다(secrets_resolved 줄이 있어야 한다).
[ -n "$resolved_line" ] && [ "$leak" -eq 0 ]; check "Mailo 로그(secrets_resolved 포함)에 값, 참조 문자열(SecretId·ARN)이 없다" $?
config_env=""
[ -n "$cid" ] && config_env="$(docker inspect --format '{{json .Config.Env}}' "$cid" 2>/dev/null)"
leak=0
for value in "$LS_DB_PASSWORD" "$LS_SMTP_PASSWORD" "$LS_DB_KEY" "$LS_FINGERPRINT_KEY" "$LS_OPS_TOKEN"; do
  printf '%s' "$config_env" | grep -qF -- "$value" && leak=$((leak + 1))
done
# 조회가 실패했거나 참조 변수가 없으면 통과하지 않는다.
printf '%s' "$config_env" | grep -qF 'MAILO_DB_PASSWORD_REF=' && [ "$leak" -eq 0 ]; check "docker inspect의 Config.Env에 해석한 값이 없고 참조(_REF)만 있다" $?
# 한계: /proc/1/environ은 프로세스가 시작할 때의 환경이다. 앱이 process.env를 바꿔도 이 파일은 바뀌지 않고 compose도 해석값을 환경으로 주지 않으므로,
# 이 검사는 "시작 환경에 해석 값이 없고 참조만 있다"만 확인한다. 앱이 process.env를 바꾸지 않는 성질은 단위 테스트(test/secrets/)가 보증하고 메모리 노출은 시험하지 않는다.
proc_result="$(printf '%s\n%s\n%s\n%s\n%s\n' "$LS_DB_PASSWORD" "$LS_SMTP_PASSWORD" "$LS_DB_KEY" "$LS_FINGERPRINT_KEY" "$LS_OPS_TOKEN" |
  dc exec -T mailo node -e '
    const { readFileSync } = require("node:fs");
    let input = "";
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", () => {
      const environ = readFileSync("/proc/1/environ", "utf8");
      const cmd = readFileSync("/proc/1/cmdline", "utf8").split("\0")[1] ?? "";
      const leaked = input.split("\n").filter(Boolean).some((v) => environ.includes(v));
      const hasRef = environ.includes("MAILO_DB_PASSWORD_REF=");
      process.stdout.write(`${leaked ? "leaked" : hasRef ? "absent" : "no-ref"} pid1=${cmd}`);
    });
  ' 2>&1)"
case "$proc_result" in absent*) rc=0 ;; *) rc=1 ;; esac
check "초기 프로세스 환경(/proc/1/environ)에 해석 값이 없고 참조만 있다. 시작 환경만 본다($proc_result)" $rc
[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$cid")" = true ]; check "컨테이너 루트가 읽기 전용이다" $?

# 4. 값 없는 기동 실패. 어떤 줄에도 값·참조가 없어야 한다.
fail_run() { # 인자: 설명, 기대 문자열, 변수=값...
  local desc="$1" expect="$2"; shift 2
  local args=() out code
  for kv in "$@"; do args+=(-e "$kv"); done
  out="$(dc run --rm --no-deps -T "${args[@]}" mailo node dist/main.js 2>&1)"; code=$?
  printf '%s' "$out" | grep -qF -- "$expect"; local found=$?
  local leaked=0
  for value in "$LS_DB_PASSWORD" "$LS_SMTP_PASSWORD" "$LS_DB_KEY" "$LS_FINGERPRINT_KEY" "$LS_OPS_TOKEN"; do
    printf '%s' "$out" | grep -qF -- "$value" && leaked=1
  done
  printf '%s' "$out" | grep -qF -e 'mailo/localstack' -e 'localstack-absent' && leaked=1
  [ "$code" -eq 1 ] && [ "$found" -eq 0 ] && [ "$leaked" -eq 0 ]
  check "$desc (종료 코드 $code)" $?
  printf '%s\n' "$out" | grep -o '"message":"[^"]*"' | head -2 | sed 's/^/        /'
}
fail_run "비밀이 없으면 adapter-error:not-found로 기동을 거부한다" "adapter-error:not-found" \
  "MAILO_SMTP_PASSWORD_REF=aws-sm://mailo/localstack/absent"
fail_run "JSON 키가 없으면 adapter-error:invalid-value로 기동을 거부한다" "adapter-error:invalid-value" \
  "MAILO_SMTP_PASSWORD_REF=aws-sm://mailo/localstack/bundle#no-such-key"
fail_run "X_REF와 평문 X를 함께 주면 conflict로 기동을 거부한다" "conflict" \
  "MAILO_SMTP_PASSWORD=fake-plain-value"
fail_run "저장소에 닿지 못하면 adapter-error:unavailable로 기동을 거부한다" "adapter-error:unavailable" \
  "AWS_ENDPOINT_URL_SECRETS_MANAGER=http://localstack-absent:4566" "MAILO_SECRET_RESOLVE_TIMEOUT_MS=20000"

# 어댑터가 없는 기본 이미지는 같은 _REF를 unknown-scheme으로 거부한다.
base_out="$(docker run --rm --pull never --network none -e NODE_ENV=production -e MAILO_SMTP_PASSWORD_REF=aws-sm://mailo/localstack/bundle#smtp-password "$BASE_IMAGE" node dist/main.js 2>&1)"; base_code=$?
printf '%s' "$base_out" | grep -qF 'unknown-scheme'; found=$?
[ "$base_code" -eq 1 ] && [ "$found" -eq 0 ] && ! printf '%s' "$base_out" | grep -qF 'mailo/localstack'
check "기본 이미지(어댑터 없음)는 같은 _REF를 unknown-scheme으로 거부한다 (종료 코드 $base_code)" $?

log "결과: 확인 $checks건, 실패 $failures건"
[ "$failures" -eq 0 ]
