#!/usr/bin/env bash
# 확인 (g): 실제 Mailo 컨테이너로 파일 -> 폴링 수집 -> 발송 -> 파일 삭제를 확인한다(RQ-002·024, ADR-0004).
# docker-compose.volume-example.yml(Mailo UID 1000, 호출처 B 10002, C 10003, 볼륨 하나)과
# 로컬 가짜 SMTP(test/volume/fake-smtp.mjs)를 쓴다. 인증서와 callers.json은 임시 디렉터리에 만들고 끝나면 지운다.
# 사용: verify-e2e.sh [acl|group]  기본 acl
# 위험도: 낮음. compose 프로젝트 mailo-voltest-e2e의 컨테이너·볼륨·네트워크만 `down -v`로 지운다. 롤백: 재실행.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

MODE="${1:-acl}"
PROJECT="$PREFIX-e2e"
WORK="$(mktemp -d)"
export VOLUME_MODE="$MODE" VOLTEST_REPO="$REPO_ROOT" VOLTEST_CERT_DIR="$WORK/certs" MAILO_CALLERS_FILE_HOST="$WORK/callers.json"
DC=(docker compose -p "$PROJECT" -f "$REPO_ROOT/docker-compose.volume-example.yml" -f "$REPO_ROOT/test/volume/docker-compose.e2e.yml")

cleanup() {
  if [ "${KEEP:-0}" != 1 ]; then
    "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# 가짜 시크릿 준비: 자체 서명 인증서(SMTP IP), 가짜 API 키의 SHA-256 해시를 담은 callers.json
mkdir -p "$WORK/certs"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/certs/key.pem" -out "$WORK/certs/cert.pem" -days 2 \
  -subj "/CN=smtp" -addext "subjectAltName=IP:172.29.88.10" >/dev/null 2>&1
chmod 0644 "$WORK/certs/key.pem"   # SMTP 컨테이너의 non-root가 읽는다. 일회용 가짜 키다.
hash() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
cat > "$WORK/callers.json" <<JSON
{"callers":[
 {"id":"caller-b","apiKeyHashes":["$(hash fake-key-b)"],"fileChannel":true,"signature":{"mode":"none"}},
 {"id":"caller-c","apiKeyHashes":["$(hash fake-key-c)"],"fileChannel":true,"signature":{"mode":"none"}}
]}
JSON
chmod 0644 "$WORK/callers.json"

ensure_tools_image
"${DC[@]}" down -v --remove-orphans >/dev/null 2>&1
if ! "${DC[@]}" up -d >"$WORK/up.log" 2>&1; then cat "$WORK/up.log"; echo "compose up 실패" >&2; exit 1; fi

# Mailo 준비 대기(최대 60초)
ready=0
for _ in $(seq 1 60); do
  if "${DC[@]}" exec -T mailo wget -qO- http://127.0.0.1:3000/health/ready >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
probe_true() { probe "$1" ALLOW "$2"; local l=$(( ${#ROWS[@]} - 1 )); ROWS[$l]="${ROWS[$l]//ALLOW/참}"; ROWS[$l]="${ROWS[$l]//DENY/거짓}"; }
probe_true "(g) Mailo 컨테이너 기동(/health/ready)" "[ $ready = 1 ]"
if [ "$ready" != 1 ]; then "${DC[@]}" logs mailo | tail -20; print_table; exit 1; fi
probe_true "(g) Mailo가 UID 1000 non-root로 실행" "[ \"\$(${DC[*]} exec -T mailo id -u)\" = 1000 ]"

# 제목은 ASCII로 둔다(SMTP 로그의 Subject 헤더가 MIME 인코딩되므로 검색이 어렵다).
# 호출처 역할: 임시 이름으로 쓰고 같은 폴더 안에서 rename한다. 인자: 서비스, 파일 이름, Idempotency-Key, 제목
req() { printf '{"version":1,"idempotencyKey":"%s","to":["kim@example.com"],"from":"no-reply@example.com","subject":"%s","text":"볼륨 e2e 본문"}' "$1" "$2"; }
drop() {
  local svc="$1" name="$2" key="$3" subj="$4"
  "${DC[@]}" exec -T "$svc" sh -c "printf '%s' '$(req "$key" "$subj")' > /outbox/.$name.tmp && mv /outbox/.$name.tmp /outbox/$name.json"
}
inbox_empty() { [ -z "$("${DC[@]}" exec -T mailo ls -A /var/mailo/files/inbox/"$1")" ]; }
sent_count() { "${DC[@]}" logs smtp 2>/dev/null | grep -c "\"subject\":\"$1\""; }
wait_sent() { for _ in $(seq 1 40); do [ "$(sent_count "$1")" -ge 1 ] && return 0; sleep 0.5; done; return 1; }

# (g1) B·C가 각자 폴더에 파일을 넣으면 발송되고 파일이 지워진다.
drop caller-b req-b1 vol-b-0001 "VOLB-OK"
drop caller-c req-c1 vol-c-0001 "VOLC-OK"
probe_true "(g) B 파일 -> 발송(SMTP 수신)" "wait_sent VOLB-OK"
probe_true "(g) C 파일 -> 발송(SMTP 수신)" "wait_sent VOLC-OK"
sleep 1
probe_true "(g) 발송 뒤 B 폴더에서 파일 삭제됨" "inbox_empty caller-b"
probe_true "(g) 발송 뒤 C 폴더에서 파일 삭제됨" "inbox_empty caller-c"
probe_true "(g) 같은 요청이 한 번만 발송됨(B)" "[ \"\$(sent_count VOLB-OK)\" = 1 ]"
probe_true "(g) REST로 조회한 B 작업 상태가 SENT" \
  "${DC[*]} exec -T mailo wget -qO- --header 'Authorization: Bearer fake-key-b' 'http://127.0.0.1:3000/jobs?idempotencyKey=vol-b-0001' | grep -q '\"SENT\"'"

# (g2) 점(.) 임시 이름의 파일은 완성 JSON 내용이어도 수집하지 않고, rename한 뒤에만 수집한다.
"${DC[@]}" exec -T caller-b sh -c "printf '%s' '$(req vol-b-hold "VOLB-HOLD")' > /outbox/.hold.tmp"
sleep 3
probe_true "(g) rename 전 임시 파일은 3초 동안(폴링 6회) 수집되지 않음" "[ \"\$(sent_count VOLB-HOLD)\" = 0 ] && ${DC[*]} exec -T mailo test -f /var/mailo/files/inbox/caller-b/.hold.tmp"
"${DC[@]}" exec -T caller-b mv /outbox/.hold.tmp /outbox/hold.json
probe_true "(g) rename 뒤에는 수집·발송" "wait_sent VOLB-HOLD"

# (g3) 호출처가 mode 0600으로 만든 파일: Mailo가 읽지 못하고 파일이 남는다(거부·삭제하지 않음). chmod 뒤에는 수집된다.
"${DC[@]}" exec -T caller-b node -e "const fs=require('fs');fs.writeFileSync('/outbox/.k.tmp',process.argv[1],{mode:0o600});fs.renameSync('/outbox/.k.tmp','/outbox/k0600.json')" "$(req vol-b-0600 "VOLB-0600")"
sleep 3
probe_true "(g) 0600 파일은 Mailo가 읽지 못해 발송되지 않음(남김)" "[ \"\$(sent_count VOLB-0600)\" = 0 ] && ${DC[*]} exec -T mailo test -f /var/mailo/files/inbox/caller-b/k0600.json"
probe_true "(g) 폴링 요약 로그에 unreadable이 기록됨" "${DC[*]} logs mailo 2>&1 | grep -q 'unreadable\":[1-9]'"
"${DC[@]}" exec -T caller-b chmod 0660 /outbox/k0600.json
probe_true "(g) 호출처가 chmod 0660 하면 수집·발송" "wait_sent VOLB-0600"

# (g4) 호출처 컨테이너에서 본 격리: subpath 마운트라 다른 호출처 폴더가 보이지 않는다.
probe "(g) caller-b 컨테이너에서 /outbox 목록 조회" DENY "${DC[*]} exec -T caller-b ls /outbox"

# 로그에 본문이 없는지 확인(RQ-027)
probe_true "(g) Mailo 로그에 본문 문자열이 없음" "! ${DC[*]} logs mailo 2>&1 | grep -q '볼륨 e2e 본문'"

echo "mode=$MODE"
print_table
[ "$FAIL" -eq 0 ]
