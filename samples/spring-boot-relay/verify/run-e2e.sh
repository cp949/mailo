#!/usr/bin/env bash
# 샘플 relay와 이 저장소의 Mailo(apps/mailo)를 실제로 연결해 검증한다. 직접 실행한다. Mailo CI에는 넣지 않는다.
# 필요: docker, node(24 이상), pnpm, JDK 21, curl, jq, openssl. 임시 PostgreSQL 컨테이너 1개(포트 15432)를 만들고 끝나면 지운다.
# 이 스크립트가 만드는 것(모두 종료 때 정리): 컨테이너 mailo-sample-verify-pg, Mailo·가짜 SMTP·샘플 프로세스, 임시 디렉터리(키, 로그).
# 위험도: 낮음(고정 이름 컨테이너와 임시 디렉터리만 지운다). 롤백: 스크립트 재실행. KEEP=1이면 정리하지 않는다.
set -uo pipefail

SAMPLE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$SAMPLE/../.." && pwd)"
PG=mailo-sample-verify-pg
PG_PORT=15432
MAILO_PORT=13100
SMTP_PORT=12525
APP_PORT=18080
WORK="$(mktemp -d)"
JAR="$SAMPLE/build/libs/mailo-relay-sample-0.1.0.jar"
FAILS=0
PASSES=0
MAILO_PID=""
SMTP_PID=""
APP_PID=""

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
check() { # 이름 기대값 실제값
  if [ "$2" = "$3" ]; then PASSES=$((PASSES + 1)); printf 'PASS  %s (= %s)\n' "$1" "$3"
  else FAILS=$((FAILS + 1)); printf 'FAIL  %s (기대 %s, 실제 %s)\n' "$1" "$2" "$3"; fi
}

cleanup() {
  [ "${KEEP:-0}" = 1 ] && { log "KEEP=1: 정리하지 않음 WORK=$WORK"; return; }
  for pid in "$APP_PID" "$MAILO_PID" "$SMTP_PID"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  sleep 1
  for pid in "$APP_PID" "$MAILO_PID" "$SMTP_PID"; do [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null; done
  docker rm -f "$PG" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

sq() { docker exec -i "$PG" psql -U sample -d sample -At -c "$1"; }
mq() { docker exec -i "$PG" psql -U sample -d mailo -At -c "$1"; }
wait_until() { # 제한초 명령...
  local end=$((SECONDS + $1)); shift
  while (( SECONDS < end )); do "$@" >/dev/null 2>&1 && return 0; sleep 0.5; done
  return 1
}
status_is() { [ "$(sq "SELECT status FROM mail_outbox WHERE id='$1'")" = "$2" ]; }
attempts_ge() { [ "$(sq "SELECT attempt_count FROM mail_outbox WHERE id='$1'")" -ge "$2" ]; }
smtp_count() { jq -s --arg r "$1" '[.[]|select(.rcpt==[$r])]|length' "$WORK/smtp.jsonl"; }
smtp_ids() { jq -s --arg r "$1" '[.[]|select(.rcpt==[$r])|.messageId]|unique|length' "$WORK/smtp.jsonl"; }

place_order() { # 이메일 sku → stdout: 본문. 상태 코드는 ohttp로 읽는다(명령 치환이 서브셸이라 파일로 넘긴다)
  local out
  out="$(curl -s -m 15 -w '\n%{http_code}' -X POST "http://127.0.0.1:$APP_PORT/orders" \
    -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"sku\":\"$2\",\"quantity\":1}")"
  printf '%s' "${out##*$'\n'}" >"$WORK/last_http"
  printf '%s' "${out%$'\n'*}"
}
ohttp() { cat "$WORK/last_http"; }
resend() { sq "UPDATE mail_outbox SET status='PENDING', next_attempt_at=now() WHERE id='$1'" >/dev/null; }

start_smtp() {
  CERT_DIR="$WORK/certs" PORT=$SMTP_PORT LOG_FILE="$WORK/smtp.jsonl" CANARY="접수되었습니다" \
    node "$SAMPLE/verify/fake-smtp.mjs" >"$WORK/smtp.log" 2>&1 &
  SMTP_PID=$!
  wait_until 10 grep -q LISTENING "$WORK/smtp.log"
}
mailo_env() {
  set -a; . "$WORK/mailo.env"; . "$WORK/keys/dev-keys.env"; set +a
}
start_mailo() {
  ( mailo_env; cd "$REPO/apps/mailo" && exec node dist/main.js ) >>"$WORK/mailo.log" 2>&1 &
  MAILO_PID=$!
  wait_until 30 curl -fs "http://127.0.0.1:$MAILO_PORT/health/live"
}
stop_mailo() { kill "$MAILO_PID" 2>/dev/null; wait "$MAILO_PID" 2>/dev/null; MAILO_PID=""; }
start_app() { # 이름 ENV=값...
  local name=$1; shift
  env RELAY_API_KEY="$API_KEY" RELAY_BASE_URL="http://127.0.0.1:$MAILO_PORT" SERVER_PORT=$APP_PORT \
    RELAY_DB_URL="jdbc:postgresql://127.0.0.1:$PG_PORT/sample" RELAY_RETRY_POLL_INTERVAL=1s \
    RELAY_RETRY_BASE_DELAY=2s RELAY_RETRY_MAX_DELAY=4s RELAY_EVENTS_POLL_INTERVAL=2s \
    RELAY_FILE_INBOX_DIR="$WORK/files/inbox/sample" "$@" \
    java -jar "$JAR" >"$WORK/app-$name.log" 2>&1 &
  APP_PID=$!
  wait_until 60 grep -q "Started SampleApplication" "$WORK/app-$name.log" || log "앱 기동 실패: $name"
}
stop_app() { kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; APP_PID=""; }

# ---------- 준비 ----------
log "사전 점검"
for port in $PG_PORT $MAILO_PORT $SMTP_PORT $APP_PORT; do
  ss -ltn | grep -q ":$port " && { echo "포트 $port 사용 중. 중단한다"; exit 2; }
done
[ -f "$JAR" ] || (cd "$SAMPLE" && ./gradlew --no-daemon -q bootJar) || exit 2
[ -d "$REPO/apps/mailo/node_modules" ] || { echo "pnpm install이 필요하다"; exit 2; }
pnpm --dir "$REPO" --filter @cp949/mailo build >/dev/null || exit 2

log "PostgreSQL 컨테이너"
docker run -d --name "$PG" -e POSTGRES_USER=sample -e POSTGRES_PASSWORD=sample-dev-password -e POSTGRES_DB=sample \
  -p "127.0.0.1:$PG_PORT:5432" postgres:17-alpine >/dev/null || exit 2
wait_until 60 docker exec "$PG" pg_isready -U sample -d sample || { echo "PostgreSQL 기동 실패"; exit 2; }
sleep 2
docker exec "$PG" psql -U sample -d sample -qc "CREATE DATABASE mailo" || exit 2

log "개발용 키·인증서·호출처 레지스트리(임시 디렉터리 $WORK)"
mkdir -p "$WORK/certs" "$WORK/files/inbox/sample"
node "$REPO/apps/mailo/scripts/gen-dev-keys.mjs" --kid mailo-dev-1 --out "$WORK/keys" \
  --jws-var MAILO_JWS_SECRET_SAMPLE >/dev/null || exit 2
openssl rand -base64 32 >"$WORK/wrong-jws-secret.txt"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/certs/key.pem" -out "$WORK/certs/cert.pem" -days 2 \
  -subj "/CN=localhost" -addext "subjectAltName=IP:127.0.0.1" >/dev/null 2>&1 || exit 2
API_KEY="$(openssl rand -base64 32)"
HASH="$(printf '%s' "$API_KEY" | sha256sum | cut -d' ' -f1)"
jq -n --arg h "$HASH" '{callers:[{id:"sample",apiKeyHashes:[$h],fileChannel:true,
  signature:{mode:"required",keys:[{kid:"sample-1",secretVar:"MAILO_JWS_SECRET_SAMPLE"}]}}]}' >"$WORK/callers.json"
cat >"$WORK/mailo.env" <<ENV
MAILO_PORT=$MAILO_PORT
MAILO_DATABASE_URL=postgres://sample:sample-dev-password@127.0.0.1:$PG_PORT/mailo
MAILO_CALLERS_FILE=$WORK/callers.json
MAILO_SMTP_HOST=127.0.0.1
MAILO_SMTP_PORT=$SMTP_PORT
MAILO_SMTP_USER=fake-user@example.invalid
MAILO_SMTP_PASSWORD=fake-smtp-password
MAILO_SMTP_FROM=no-reply@example.com
MAILO_DB_ENCRYPTION_KEY_VERSION=1
MAILO_DB_ENCRYPTION_KEY_V1=$(openssl rand -base64 32)
MAILO_FINGERPRINT_KEY_VERSION=1
MAILO_FINGERPRINT_KEY_V1=$(openssl rand -base64 32)
MAILO_FILE_CHANNEL_ROOT=$WORK/files
MAILO_FILE_POLL_INTERVAL_MS=1000
MAILO_JOB_EXPIRY_SECONDS=15
MAILO_MAINTENANCE_INTERVAL_SECONDS=2
NODE_EXTRA_CA_CERTS=$WORK/certs/cert.pem
ENV
: >"$WORK/smtp.jsonl"
start_smtp || { echo "SMTP 기동 실패"; exit 2; }
( mailo_env; cd "$REPO/apps/mailo" && node dist/db/migrate-cli.js ) >"$WORK/migrate.log" 2>&1 || { cat "$WORK/migrate.log"; exit 2; }
start_mailo || { echo "Mailo 기동 실패"; tail -20 "$WORK/mailo.log"; exit 2; }
log "준비 완료"

# ---------- 실행 1: REST 평문 ----------
log "== 실행 1: REST 평문 =="
start_app rest
OUT="$(place_order rest-plain@example.com SKU-OK)"; check "S1 주문 HTTP" 201 "$(ohttp)"
OB1="$(jq -r .outboxId <<<"$OUT")"
wait_until 40 status_is "$OB1" SENT; check "S1 outbox 최종 상태" SENT "$(sq "SELECT status FROM mail_outbox WHERE id='$OB1'")"
check "S1 Mailo 등록 응답 코드(첫 시도)" 202 "$(sq "SELECT last_http_status FROM mail_outbox WHERE id='$OB1'")"
check "S1 mail_jobs 행 수" 1 "$(mq "SELECT count(*) FROM mail_jobs WHERE idempotency_key='$OB1'")"
check "S1 mail_jobs 상태" SENT "$(mq "SELECT status FROM mail_jobs WHERE idempotency_key='$OB1'")"
check "S1 SMTP 수신 메일 수" 1 "$(smtp_count rest-plain@example.com)"
check "S1 Message-ID 종류 수" 1 "$(smtp_ids rest-plain@example.com)"
check "S1 본문 한글 디코딩" true "$(jq -s -r '[.[]|select(.rcpt==["rest-plain@example.com"])][0].bodyHasCanary' "$WORK/smtp.jsonl")"

log "S2 같은 outbox 행 재전송(relay 장애 뒤 재전달 모사)"
resend "$OB1"
wait_until 20 attempts_ge "$OB1" 2; sleep 5
check "S2 재전송 응답 코드" 200 "$(sq "SELECT last_http_status FROM mail_outbox WHERE id='$OB1'")"
check "S2 재전송 뒤 outbox 상태(200의 Job 상태 반영)" SENT "$(sq "SELECT status FROM mail_outbox WHERE id='$OB1'")"
check "S2 mail_jobs 행 수(중복 등록 없음)" 1 "$(mq "SELECT count(*) FROM mail_jobs WHERE idempotency_key='$OB1'")"
check "S2 SMTP 수신 메일 수(변화 없음)" 1 "$(smtp_count rest-plain@example.com)"

log "S3 수신자 영구 거부(550) -> JOB_FAILED"
OUT="$(place_order nobody@reject.example SKU-OK)"; OB3="$(jq -r .outboxId <<<"$OUT")"
wait_until 40 status_is "$OB3" FAILED; check "S3 outbox 최종 상태" FAILED "$(sq "SELECT status FROM mail_outbox WHERE id='$OB3'")"
check "S3 사유" PERMANENT_ERROR "$(sq "SELECT last_error FROM mail_outbox WHERE id='$OB3'")"
check "S3 이벤트 기록 type" JOB_FAILED "$(sq "SELECT type FROM mailo_event_log WHERE outbox_id='$OB3'")"
check "S3 이벤트 기록 smtpCode" 550 "$(sq "SELECT payload->'lastError'->>'smtpCode' FROM mailo_event_log WHERE outbox_id='$OB3'")"
check "S3 SMTP 수신 메일 수" 0 "$(smtp_count nobody@reject.example)"

log "S3a 확인 필요(NEEDS_CHECK) 행을 GET /jobs로 확인(ADR-0011 구현 순서 1)"
sq "UPDATE mail_outbox SET status='NEEDS_CHECK', last_error='UNKNOWN_EVENT_TYPE' WHERE id='$OB3'" >/dev/null
wait_until 20 status_is "$OB3" FAILED
check "S3a 확인 필요 -> Job 종결 상태 반영" FAILED "$(sq "SELECT status FROM mail_outbox WHERE id='$OB3'")"
check "S3a 사유(Job의 failureReason)" PERMANENT_ERROR "$(sq "SELECT last_error FROM mail_outbox WHERE id='$OB3'")"
OB3B="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
sq "INSERT INTO mail_outbox (id, request_json, status, last_error) VALUES ('$OB3B', '{}', 'NEEDS_CHECK', 'UNKNOWN_EVENT_TYPE')" >/dev/null
sleep 6
check "S3a Mailo에 없는 Key(404)는 확인 필요로 남는다" NEEDS_CHECK "$(sq "SELECT status FROM mail_outbox WHERE id='$OB3B'")"

log "S4 같은 Key에 다른 내용 -> 409 격리"
sq "UPDATE mail_outbox SET request_json = replace(request_json, '주문 접수 안내', '바뀐 제목'), status='PENDING', next_attempt_at=now() WHERE id='$OB1'" >/dev/null
wait_until 20 status_is "$OB1" QUARANTINED
check "S4 outbox 상태" QUARANTINED "$(sq "SELECT status FROM mail_outbox WHERE id='$OB1'")"
check "S4 응답 코드" 409 "$(sq "SELECT last_http_status FROM mail_outbox WHERE id='$OB1'")"
check "S4 사유" "HTTP_409 idempotency-conflict" "$(sq "SELECT last_error FROM mail_outbox WHERE id='$OB1'")"
check "S4 SMTP 수신 메일 수(변화 없음)" 1 "$(smtp_count rest-plain@example.com)"

log "S5 잘못된 수신자 주소 -> 400 재시도 불가"
OB5="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
sq "INSERT INTO mail_outbox (id, request_json) VALUES ('$OB5', '{\"to\":[\"not-an-email\"],\"subject\":\"x\",\"text\":\"y\"}')" >/dev/null
wait_until 20 status_is "$OB5" REJECTED
check "S5 outbox 상태" REJECTED "$(sq "SELECT status FROM mail_outbox WHERE id='$OB5'")"
check "S5 응답 코드" 400 "$(sq "SELECT last_http_status FROM mail_outbox WHERE id='$OB5'")"
check "S5 사유 코드" "HTTP_400 validation-failed INVALID_FORMAT" "$(sq "SELECT last_error FROM mail_outbox WHERE id='$OB5'")"
check "S5 시도 횟수(재시도 없음)" 1 "$(sq "SELECT attempt_count FROM mail_outbox WHERE id='$OB5'")"

log "S6 재고 부족 -> 주문과 outbox 함께 롤백"
BEFORE="$(sq "SELECT count(*) FROM mail_outbox")"
place_order rollback@example.com SKU-EMPTY >/dev/null; check "S6 주문 HTTP" 409 "$(ohttp)"
check "S6 outbox 행 수 변화" "$BEFORE" "$(sq "SELECT count(*) FROM mail_outbox")"
check "S6 주문 행 수" 0 "$(sq "SELECT count(*) FROM orders WHERE customer_email='rollback@example.com'")"
sleep 3
check "S6 SMTP 수신 메일 수" 0 "$(smtp_count rollback@example.com)"

log "S7 일시 오류 수신자가 만료 -> JOB_EXPIRED"
OUT="$(place_order slow@tempfail.example SKU-OK)"; OB7="$(jq -r .outboxId <<<"$OUT")"
wait_until 60 status_is "$OB7" EXPIRED
check "S7 outbox 최종 상태" EXPIRED "$(sq "SELECT status FROM mail_outbox WHERE id='$OB7'")"
check "S7 이벤트 기록 type" JOB_EXPIRED "$(sq "SELECT type FROM mailo_event_log WHERE outbox_id='$OB7'")"

log "S15 작업 취소(RQ-040, ADR-0011 결정 4): 대기 중인 작업을 호출처 키로 취소 -> JOB_CANCELED"
cancel_http() { # 경로와 쿼리. 응답 본문은 $WORK/cancel.json, 상태 코드를 stdout으로 낸다
  curl -s -m 10 -o "$WORK/cancel.json" -w '%{http_code}' -X POST -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:$MAILO_PORT$1"
}
# 차단기를 열어(계정 장애 모사, 검증용 DB 조작) 새 작업이 PENDING으로 남게 한다. 낮은 TTL(15초)에서는 일시 오류가 곧바로 EXPIRED라 RETRY_WAIT를 만들 수 없다.
mq "UPDATE mail_circuit_breaker SET state='open', open_until=now() + interval '10 minutes', last_reason='AUTH_FAILED'" >/dev/null
new_pending_order() { # 이메일 → stdout: outbox ID. Mailo에 등록돼 PENDING이 될 때까지 기다린다
  local out id seen="" i
  out="$(place_order "$1" SKU-OK)"; id="$(jq -r .outboxId <<<"$out")"
  for i in $(seq 1 40); do
    seen="$(mq "SELECT status FROM mail_jobs WHERE idempotency_key='$id'" </dev/null)"
    [ "$seen" = PENDING ] && break
    sleep 0.5
  done
  [ "$seen" = PENDING ] || echo "PENDING 대기 실패(마지막 상태: $seen)" >&2
  printf '%s' "$id"
}
OB15A="$(new_pending_order cancel-a@example.com)"
JOB15A="$(mq "SELECT id FROM mail_jobs WHERE idempotency_key='$OB15A'")"
check "S15 취소 전 mail_jobs 상태" PENDING "$(mq "SELECT status FROM mail_jobs WHERE idempotency_key='$OB15A'")"
check "S15 취소 응답 코드(작업 ID)" 200 "$(cancel_http "/jobs/$JOB15A/cancel")"
check "S15 취소 응답 status" CANCELED "$(jq -r .status "$WORK/cancel.json")"
check "S15 취소 응답 canceledBy" CALLER "$(jq -r .canceledBy "$WORK/cancel.json")"
check "S15 mail_jobs 상태" CANCELED "$(mq "SELECT status FROM mail_jobs WHERE idempotency_key='$OB15A'")"
check "S15 본문 즉시 삭제" 0 "$(mq "SELECT count(*) FROM mail_jobs WHERE idempotency_key='$OB15A' AND body_ciphertext IS NOT NULL")"
check "S15 같은 취소 재요청은 200(멱등)" 200 "$(cancel_http "/jobs/$JOB15A/cancel")"
check "S15 JOB_CANCELED 이벤트는 1건" 1 "$(mq "SELECT count(*) FROM mail_events WHERE job_id='$JOB15A' AND type='JOB_CANCELED'")"
wait_until 20 status_is "$OB15A" CANCELED
check "S15 outbox 최종 상태(실패가 아닌 취소 종결)" CANCELED "$(sq "SELECT status FROM mail_outbox WHERE id='$OB15A'")"
check "S15 outbox 사유" CANCELED_BY_CALLER "$(sq "SELECT last_error FROM mail_outbox WHERE id='$OB15A'")"
check "S15 이벤트 기록 type" JOB_CANCELED "$(sq "SELECT type FROM mailo_event_log WHERE outbox_id='$OB15A'")"
check "S15 완료된 작업(S1)의 취소는 409" 409 "$(cancel_http "/jobs/$(mq "SELECT id FROM mail_jobs WHERE idempotency_key='$OB1'")/cancel")"
check "S15 409 type" "urn:mailo:problem:job-not-cancelable" "$(jq -r .type "$WORK/cancel.json")"
check "S15 409 jobStatus" SENT "$(jq -r .jobStatus "$WORK/cancel.json")"
check "S15 없는 Key의 취소는 404" 404 "$(cancel_http "/jobs/cancel?idempotencyKey=$(cat /proc/sys/kernel/random/uuid)")"

log "S15b Key로 취소하고, 확인 필요 행이 GET /jobs로 CANCELED가 된다"
OB15B="$(new_pending_order cancel-b@example.com)"
check "S15b Key로 취소 응답 코드" 200 "$(cancel_http "/jobs/cancel?idempotencyKey=$OB15B")"
wait_until 20 status_is "$OB15B" CANCELED
sq "UPDATE mail_outbox SET status='NEEDS_CHECK', last_error='UNKNOWN_EVENT_TYPE' WHERE id='$OB15B'" >/dev/null
wait_until 20 status_is "$OB15B" CANCELED
check "S15b 확인 필요 -> 취소 종결 반영" CANCELED "$(sq "SELECT status FROM mail_outbox WHERE id='$OB15B'")"
check "S15b 사유" CANCELED_BY_CALLER "$(sq "SELECT last_error FROM mail_outbox WHERE id='$OB15B'")"
resend "$OB15B"
wait_until 20 attempts_ge "$OB15B" 2; sleep 3
check "S15b 같은 Key 재전송 응답 코드(취소된 작업이 돌아온다)" 200 "$(sq "SELECT last_http_status FROM mail_outbox WHERE id='$OB15B'")"
check "S15b 재전송 뒤 outbox 상태(200의 Job 상태 CANCELED 반영)" CANCELED "$(sq "SELECT status FROM mail_outbox WHERE id='$OB15B'")"
check "S15b 취소된 Key의 mail_jobs 행 수(새 작업 없음)" 1 "$(mq "SELECT count(*) FROM mail_jobs WHERE idempotency_key='$OB15B'")"
mq "UPDATE mail_circuit_breaker SET state='closed', open_until=NULL, last_reason=NULL" >/dev/null
sleep 3
check "S15 차단기를 닫은 뒤에도 취소한 작업은 발송되지 않음(a)" 0 "$(smtp_count cancel-a@example.com)"
check "S15 차단기를 닫은 뒤에도 취소한 작업은 발송되지 않음(b)" 0 "$(smtp_count cancel-b@example.com)"

log "S16 이벤트 피드 공백(RQ-045, ADR-0011 결정 9): 보존 삭제 뒤 실제 서버가 Mailo-Cursor-Gap 헤더를 내고 샘플이 등록됨 행을 확인 필요로 둔다"
gap_header() { # 쿼리 문자열 → stdout: Mailo-Cursor-Gap 헤더 값(없으면 빈 문자열). MDow는 cursor 0:0이다(어떤 이벤트보다 앞)
  curl -s -m 10 -o /dev/null -D - -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:$MAILO_PORT/events?$1" | tr -d '\r' | awk 'tolower($1)=="mailo-cursor-gap:" {print tolower($2)}'
}
events_http() { curl -s -m 10 -o "$WORK/events.json" -w '%{http_code}' -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:$MAILO_PORT/events?$1"; }
check "S16 삭제 전 표지 행 수" 0 "$(mq "SELECT count(*) FROM mail_event_purges")"
check "S16 삭제 전에는 헤더가 없다" "" "$(gap_header after=MDow)"
# 종결 작업(S1·S3)의 종결 시각을 40일 전으로 당긴다(검증용 DB 조작). Mailo Worker의 정리 루프(2초 주기)가 지운다.
mq "UPDATE mail_jobs SET finished_at = now() - interval '40 days' WHERE idempotency_key IN ('$OB1', '$OB3')" >/dev/null
mq "UPDATE mail_circuit_breaker SET state='open', open_until=now() + interval '10 minutes', last_reason='AUTH_FAILED'" >/dev/null
OB16="$(new_pending_order gap@example.com)"
gone() { [ "$(mq "SELECT count(*) FROM mail_jobs WHERE idempotency_key IN ('$OB1', '$OB3')")" = 0 ]; }
wait_until 30 gone
check "S16 보존 삭제로 작업 행이 지워짐" 0 "$(mq "SELECT count(*) FROM mail_jobs WHERE idempotency_key IN ('$OB1', '$OB3')")"
check "S16 삭제 표지 JOB_SENT" 1 "$(mq "SELECT count(*) FROM mail_event_purges WHERE caller_id='sample' AND type='JOB_SENT'")"
check "S16 삭제 표지 JOB_FAILED" 1 "$(mq "SELECT count(*) FROM mail_event_purges WHERE caller_id='sample' AND type='JOB_FAILED'")"
check "S16 after 뒤에서 삭제됐으면 헤더 true" true "$(gap_header after=MDow)"
check "S16 응답 상태는 200" 200 "$(events_http after=MDow)"
check "S16 삭제된 종류가 아닌 type 필터에는 헤더가 없다" "" "$(gap_header 'after=MDow&type=INTAKE_REJECTED')"
check "S16 삭제된 종류의 type 필터에는 헤더가 있다" true "$(gap_header 'after=MDow&type=JOB_FAILED')"
check "S16 onGap=error는 410" 410 "$(events_http 'after=MDow&onGap=error')"
check "S16 410 type" "urn:mailo:problem:cursor-expired" "$(jq -r .type "$WORK/events.json")"
check "S16 after 없는 읽기에는 헤더가 없다" "" "$(gap_header limit=1)"
# 샘플의 cursor를 0:0으로 되돌려 삭제 지점 앞에서 읽게 한다. 샘플이 헤더를 받아 등록됨 행을 확인 필요로 두는지 앱 로그로 본다.
sq "UPDATE mailo_event_cursor SET cursor='MDow'" >/dev/null
wait_until 30 grep -q "event_cursor_gap action=check_delivered_jobs" "$WORK/app-rest.log"
check "S16 샘플이 헤더를 받아 확인 필요 처리를 함(앱 로그 event_cursor_gap)" 1 "$(grep -c 'event_cursor_gap action=check_delivered_jobs' "$WORK/app-rest.log" | awk '{print ($1 >= 1) ? 1 : 0}')"
check "S16 헤더 처리 뒤 샘플 로그에 410 처리 없음" 0 "$(grep -c 'event_cursor_expired' "$WORK/app-rest.log")"
cancel_http "/jobs/cancel?idempotencyKey=$OB16" >/dev/null
mq "UPDATE mail_circuit_breaker SET state='closed', open_until=NULL, last_reason=NULL" >/dev/null
sleep 3
check "S16 정리: 취소한 작업은 발송되지 않음" 0 "$(smtp_count gap@example.com)"

log "S8 Mailo 중단 중 주문"
stop_mailo
T0=$SECONDS
OUT="$(place_order down@example.com SKU-OK)"; check "S8 Mailo 중단 중 주문 HTTP" 201 "$(ohttp)"
check "S8 주문 응답 시간 3초 이내" true "$([ $((SECONDS - T0)) -le 3 ] && echo true || echo false)"
OB8="$(jq -r .outboxId <<<"$OUT")"
check "S8 주문 행 존재" 1 "$(sq "SELECT count(*) FROM orders WHERE customer_email='down@example.com'")"
wait_until 30 attempts_ge "$OB8" 3
check "S8 중단 중 상태(PENDING 유지)" PENDING "$(sq "SELECT status FROM mail_outbox WHERE id='$OB8'")"
check "S8 중단 중 사유" NETWORK_ERROR "$(sq "SELECT last_error FROM mail_outbox WHERE id='$OB8'")"
check "S8 중단 중 시도 횟수 3 이상" true "$(attempts_ge "$OB8" 3 && echo true || echo false)"
start_mailo || { echo "Mailo 재기동 실패"; exit 2; }
wait_until 40 status_is "$OB8" SENT; check "S8 Mailo 복구 뒤 최종 상태" SENT "$(sq "SELECT status FROM mail_outbox WHERE id='$OB8'")"
check "S8 SMTP 수신 메일 수" 1 "$(smtp_count down@example.com)"
check "S8 이벤트 cursor 저장" 1 "$(sq "SELECT count(*) FROM mailo_event_cursor")"
stop_app

# ---------- 실행 2: REST + JWE ----------
log "== 실행 2: REST + JWE =="
start_app rest-jwe RELAY_ENCRYPTION_ENABLED=true RELAY_ENCRYPTION_KID=mailo-dev-1 \
  RELAY_ENCRYPTION_PUBLIC_KEY_FILE="$WORK/keys/mailo-dev-1.public.pem"
OUT="$(place_order rest-jwe@example.com SKU-OK)"; check "S9 주문 HTTP" 201 "$(ohttp)"
OB9="$(jq -r .outboxId <<<"$OUT")"
wait_until 40 status_is "$OB9" SENT; check "S9 outbox 최종 상태" SENT "$(sq "SELECT status FROM mail_outbox WHERE id='$OB9'")"
check "S9 등록 응답 코드" 202 "$(sq "SELECT last_http_status FROM mail_outbox WHERE id='$OB9'")"
check "S9 outbox에 본문 평문 없음" 0 "$(sq "SELECT count(*) FROM mail_outbox WHERE id='$OB9' AND request_json LIKE '%접수되었습니다%'")"
check "S9 outbox에 content(JWE) 있음" 1 "$(sq "SELECT count(*) FROM mail_outbox WHERE id='$OB9' AND request_json LIKE '%\"content\":\"eyJ%'")"
check "S9 SMTP 수신 메일 수" 1 "$(smtp_count rest-jwe@example.com)"
check "S9 복호화된 본문이 메일에 있음" true "$(jq -s -r '[.[]|select(.rcpt==["rest-jwe@example.com"])][0].bodyHasCanary' "$WORK/smtp.jsonl")"
check "S9 복호화된 제목" "주문 접수 안내" "$(jq -s -r '[.[]|select(.rcpt==["rest-jwe@example.com"])][0].subject' "$WORK/smtp.jsonl")"
resend "$OB9"; wait_until 20 attempts_ge "$OB9" 2; sleep 4
check "S9 JWE 재전송 응답 코드(암호문이 같은 요청이라 200)" 200 "$(sq "SELECT last_http_status FROM mail_outbox WHERE id='$OB9'")"
check "S9 JWE 재전송 뒤 SMTP 수신 메일 수" 1 "$(smtp_count rest-jwe@example.com)"
stop_app

log "== 실행 2b: REST + JWE(알 수 없는 kid) =="
start_app rest-jwe-badkid RELAY_ENCRYPTION_ENABLED=true RELAY_ENCRYPTION_KID=no-such-kid \
  RELAY_ENCRYPTION_PUBLIC_KEY_FILE="$WORK/keys/mailo-dev-1.public.pem"
OUT="$(place_order badkid@example.com SKU-OK)"; OB10="$(jq -r .outboxId <<<"$OUT")"
wait_until 20 status_is "$OB10" REJECTED
check "S10 outbox 상태" REJECTED "$(sq "SELECT status FROM mail_outbox WHERE id='$OB10'")"
check "S10 사유" "HTTP_400 validation-failed KID_UNKNOWN" "$(sq "SELECT last_error FROM mail_outbox WHERE id='$OB10'")"
stop_app

# ---------- 실행 3: 파일 채널 + JWS ----------
log "== 실행 3: 파일 채널 + JWS(HS256) =="
start_app file-jws RELAY_TRANSPORT=FILE RELAY_SIGNATURE_ENABLED=true RELAY_SIGNATURE_KID=sample-1 \
  RELAY_SIGNATURE_SECRET_FILE="$WORK/keys/jws-secret.txt"
OUT="$(place_order file-jws@example.com SKU-OK)"; OB11="$(jq -r .outboxId <<<"$OUT")"
wait_until 40 status_is "$OB11" SENT; check "S11 outbox 최종 상태" SENT "$(sq "SELECT status FROM mail_outbox WHERE id='$OB11'")"
check "S11 mail_jobs 행 수" 1 "$(mq "SELECT count(*) FROM mail_jobs WHERE idempotency_key='$OB11'")"
check "S11 SMTP 수신 메일 수" 1 "$(smtp_count file-jws@example.com)"
check "S11 수집 거부 기록 없음" 0 "$(mq "SELECT count(*) FROM mail_intake_rejections WHERE file_name='$OB11.json'")"
resend "$OB11"; wait_until 20 attempts_ge "$OB11" 2; sleep 5
check "S11 파일 재전송(새 iat) 뒤 mail_jobs 행 수" 1 "$(mq "SELECT count(*) FROM mail_jobs WHERE idempotency_key='$OB11'")"
check "S11 파일 재전송 뒤 SMTP 수신 메일 수" 1 "$(smtp_count file-jws@example.com)"
check "S11 파일 재전송 뒤 수집 거부 기록 없음" 0 "$(mq "SELECT count(*) FROM mail_intake_rejections WHERE file_name='$OB11.json'")"
check "S11 inbox에 남은 파일 수" 0 "$(find "$WORK/files/inbox/sample" -type f | wc -l | tr -d ' ')"
stop_app

log "== 실행 4: 파일 채널 + JWS + JWE =="
start_app file-jws-jwe RELAY_TRANSPORT=FILE RELAY_SIGNATURE_ENABLED=true RELAY_SIGNATURE_KID=sample-1 \
  RELAY_SIGNATURE_SECRET_FILE="$WORK/keys/jws-secret.txt" RELAY_ENCRYPTION_ENABLED=true \
  RELAY_ENCRYPTION_KID=mailo-dev-1 RELAY_ENCRYPTION_PUBLIC_KEY_FILE="$WORK/keys/mailo-dev-1.public.pem"
OUT="$(place_order file-jws-jwe@example.com SKU-OK)"; OB12="$(jq -r .outboxId <<<"$OUT")"
wait_until 40 status_is "$OB12" SENT; check "S12 outbox 최종 상태" SENT "$(sq "SELECT status FROM mail_outbox WHERE id='$OB12'")"
check "S12 SMTP 수신 메일 수" 1 "$(smtp_count file-jws-jwe@example.com)"
check "S12 Message-ID 종류 수" 1 "$(smtp_ids file-jws-jwe@example.com)"
check "S12 복호화된 본문이 메일에 있음" true "$(jq -s -r '[.[]|select(.rcpt==["file-jws-jwe@example.com"])][0].bodyHasCanary' "$WORK/smtp.jsonl")"
stop_app

log "== 실행 5: 파일 채널 + 잘못된 JWS 비밀키 -> INTAKE_REJECTED =="
start_app file-badsig RELAY_TRANSPORT=FILE RELAY_SIGNATURE_ENABLED=true RELAY_SIGNATURE_KID=sample-1 \
  RELAY_SIGNATURE_SECRET_FILE="$WORK/wrong-jws-secret.txt"
OUT="$(place_order badsig@example.com SKU-OK)"; OB13="$(jq -r .outboxId <<<"$OUT")"
wait_until 40 status_is "$OB13" REJECTED
check "S13 outbox 상태" REJECTED "$(sq "SELECT status FROM mail_outbox WHERE id='$OB13'")"
check "S13 사유 코드" SIGNATURE_INVALID "$(sq "SELECT last_error FROM mail_outbox WHERE id='$OB13'")"
check "S13 이벤트 기록 type" INTAKE_REJECTED "$(sq "SELECT type FROM mailo_event_log WHERE outbox_id='$OB13'")"
check "S13 Mailo 거부 기록 수" 1 "$(mq "SELECT count(*) FROM mail_intake_rejections WHERE file_name='$OB13.json'")"
check "S13 SMTP 수신 메일 수" 0 "$(smtp_count badsig@example.com)"
stop_app

# ---------- 실행 6: 잘못된 API 키 ----------
log "== 실행 6: 잘못된 API 키 -> 401 =="
start_app badkey RELAY_API_KEY="wrong-api-key-0000000000000000000000000000"
OUT="$(place_order unauth1@example.com SKU-OK)"; OB14="$(jq -r .outboxId <<<"$OUT")"
wait_until 20 status_is "$OB14" REJECTED
check "S14 outbox 상태" REJECTED "$(sq "SELECT status FROM mail_outbox WHERE id='$OB14'")"
check "S14 응답 코드" 401 "$(sq "SELECT last_http_status FROM mail_outbox WHERE id='$OB14'")"
OUT="$(place_order unauth2@example.com SKU-OK)"; OB15="$(jq -r .outboxId <<<"$OUT")"
sleep 5
check "S14 relay 중지 뒤 다음 행 시도 횟수" 0 "$(sq "SELECT attempt_count FROM mail_outbox WHERE id='$OB15'")"
stop_app

# ---------- 공통 점검 ----------
log "== 공통 점검 =="
LEAK=0
for f in "$WORK"/app-*.log; do grep -Eq '@(example\.com|reject\.example|tempfail\.example)|접수되었습니다|Bearer ' "$f" && { LEAK=1; echo "누출 의심: $f"; }; done
check "샘플 앱 로그에 주소·본문·Bearer 없음" 0 "$LEAK"
check "Mailo 로그에 본문 없음" 0 "$(grep -c '접수되었습니다' "$WORK/mailo.log")"
check "Mailo 로그에 수신자 주소 없음" 0 "$(grep -cE '@(example\.com|reject\.example|tempfail\.example)' "$WORK/mailo.log")"
check "Mailo 메일 단위 Message-ID 총수(고유)" "$(jq -s '[.[]|.messageId]|length' "$WORK/smtp.jsonl")" "$(jq -s '[.[]|.messageId]|unique|length' "$WORK/smtp.jsonl")"

echo
echo "결과: PASS $PASSES, FAIL $FAILS"
[ "$FAILS" -eq 0 ]
