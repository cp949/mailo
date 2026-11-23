#!/usr/bin/env bash
# 컨테이너 종료·중복 발송 검증 공용 함수(RQ-013·018·020·025). 직접 실행하지 않고 source한다.
# 이 작업이 만든 compose 프로젝트(mailo-verify)의 컨테이너·볼륨·네트워크·이미지만 다룬다.
# 사용 전 설정: FILE_CHANNEL=0|1, LEASE_SECONDS, DATA_DELAY_MS(가짜 SMTP 응답 지연)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="mailo-verify"
TOOLS_IMAGE="mailo-volume-tools:local"
PUBLISH_PORT="${VERIFY_PUBLISH_PORT:-13000}"
API_KEY="fake-verify-api-key-0000000000000000000001"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S.%3N)" "$*"; }

# 임시 디렉터리, 가짜 시크릿, env 파일, callers.json을 만든다. 모든 값은 가짜다.
verify_setup() {
  WORK="$(mktemp -d)"
  mkdir -p "$WORK/certs" "$WORK/files/inbox/alpha"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/certs/key.pem" -out "$WORK/certs/cert.pem" -days 2 \
    -subj "/CN=smtp" -addext "subjectAltName=IP:172.29.89.10" >/dev/null 2>&1
  chmod 0644 "$WORK/certs/key.pem"   # SMTP 컨테이너의 non-root가 읽는다. 일회용 가짜 키다.
  local hash; hash="$(printf '%s' "$API_KEY" | sha256sum | cut -d' ' -f1)"
  local fc=false; [ "${FILE_CHANNEL:-0}" = 1 ] && fc=true
  printf '{"callers":[{"id":"alpha","apiKeyHashes":["%s"],"fileChannel":%s,"signature":{"mode":"none"}}]}' "$hash" "$fc" > "$WORK/callers.json"
  chmod 0644 "$WORK/callers.json"
  # 폴더 소유자는 컨테이너의 Mailo(UID 1000)와 같은 호스트 UID여야 한다. 아니면 호출처(호스트) 쓰기를 위해 777로 둔다.
  chmod 0777 "$WORK/files" "$WORK/files/inbox" "$WORK/files/inbox/alpha"
  # compose는 NODE_ENV 기본값이 production이라 공개 샘플 키를 거부한다. 실행마다 일회용 키를 만든다(임시 디렉터리에만 남는다).
  cat > "$WORK/mailo.env" <<ENV
MAILO_SMTP_HOST=172.29.89.10
MAILO_SMTP_PORT=2525
MAILO_SMTP_USER=fake-user@example.invalid
MAILO_SMTP_PASSWORD=fake-smtp-password
MAILO_SMTP_FROM=no-reply@example.com
MAILO_DB_ENCRYPTION_KEY_VERSION=1
MAILO_DB_ENCRYPTION_KEY_V1=$(openssl rand -base64 32)
MAILO_FINGERPRINT_KEY_VERSION=1
MAILO_FINGERPRINT_KEY_V1=$(openssl rand -base64 32)
MAILO_LEASE_SECONDS=${LEASE_SECONDS:-45}
MAILO_SMTP_TIMEOUT_SECONDS=10
NODE_EXTRA_CA_CERTS=/certs/cert.pem
ENV
  if [ "${FILE_CHANNEL:-0}" = 1 ]; then
    printf 'MAILO_FILE_CHANNEL_ROOT=/var/mailo/files\nMAILO_FILE_POLL_INTERVAL_MS=%s\n' "${FILE_POLL_MS:-500}" >> "$WORK/mailo.env"
  fi
  export VERIFY_REPO="$REPO_ROOT" VERIFY_ENV_FILE="$WORK/mailo.env" VERIFY_CALLERS_FILE="$WORK/callers.json" \
    VERIFY_CERT_DIR="$WORK/certs" VERIFY_FILES_DIR="$WORK/files" VERIFY_PUBLISH_PORT="$PUBLISH_PORT" \
    VERIFY_DATA_DELAY_MS="${DATA_DELAY_MS:-0}" POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-p@ss/w:rd#1%2x}"
  DC=(docker compose -p "$PROJECT" -f "$REPO_ROOT/docker-compose.yml" -f "$REPO_ROOT/test/container/docker-compose.verify.yml")
}

ensure_tools_image() {
  TOOLS_IMAGE_CREATED=0
  if ! docker image inspect "$TOOLS_IMAGE" >/dev/null 2>&1; then
    docker build -q -t "$TOOLS_IMAGE" -f "$REPO_ROOT/test/volume/Dockerfile.tools" "$REPO_ROOT/test/volume" >/dev/null
    TOOLS_IMAGE_CREATED=1
  fi
}

# 이 작업이 만든 것만 지운다. 위험도: 낮음(프로젝트 이름 고정, 다른 프로젝트 영향 없음). 롤백: 스크립트 재실행으로 재생성.
# `down -v`는 프로젝트의 postgres 볼륨을 지운다. 이미지는 `--rmi local`로 이 프로젝트가 빌드한 것만 지운다.
# KEEP=1이면 지우지 않는다(디버깅용).
verify_cleanup() {
  if [ "${KEEP:-0}" != 1 ]; then
    "${DC[@]}" down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
    if [ "${TOOLS_IMAGE_CREATED:-0}" = 1 ]; then docker rmi "$TOOLS_IMAGE" >/dev/null 2>&1 || true; fi
  fi
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
}

# POSTGRES 값에 예약 문자가 있는 비밀번호로 기동해 앱 조립 URL을 함께 확인한다(.env에 POSTGRES_PASSWORD 없이 환경으로 준다).
psql_q() { "${DC[@]}" exec -T postgres psql -U mailo -d mailo -At -c "$1"; }
smtp_log() { "${DC[@]}" logs --no-log-prefix smtp 2>/dev/null | grep '"event":"RECEIVED"'; }
mailo_cid() { "${DC[@]}" ps -q mailo; }
post_job() { # 인자: Idempotency-Key, 제목
  curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PUBLISH_PORT/jobs" \
    -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: $1" \
    -d "{\"to\":[\"kim@example.com\"],\"from\":\"no-reply@example.com\",\"subject\":\"$2\",\"text\":\"verify body\"}"
}
