#!/usr/bin/env bash
# 컨테이너 `/metrics` 검증(RQ-049, ADR-0012). 관찰만 기록한다. 자동 테스트가 아니다.
# read_only 컨테이너로 Mailo를 띄우고 메일 N통을 보낸 뒤 `GET /metrics`를 호출한다.
# 확인: (1) 컨테이너 루트가 읽기 전용 (2) 읽기 토큰 200·text/plain 0.0.4, 관리 토큰 403, 무토큰 401
#       (3) 보낸 통수가 mailo_attempts_total{result="sent"}·mailo_jobs_finished_total{status="sent"}에 반영
#       (4) 전역 gauge(큐·차단기·감사)가 나오고 collect_ok가 모두 1 (5) 토큰·API 키·메일 주소가 응답에 없다
#       (6) promtool check metrics가 응답을 받아들인다(PROMTOOL_IMAGE 이미지가 있거나 받을 수 있을 때. 없으면 건너뛴다).
# 사용: scripts/container/verify-metrics.sh [메일 수, 기본 5]
# 위험도: 낮음. compose 프로젝트 mailo-verify만 만들고 `down -v --rmi local`로 지운다. 롤백: 스크립트 재실행. KEEP=1이면 정리하지 않는다.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

N="${1:-5}"
FILE_CHANNEL=0
LEASE_SECONDS=45
DATA_DELAY_MS=0
PROMTOOL_IMAGE="${PROMTOOL_IMAGE:-prom/prometheus:v2.55.1}"
# 가짜 토큰이다. 실행마다 새로 만들고 임시 env 파일에만 둔다.
READ_TOKEN="fake-metrics-read-$(openssl rand -hex 20)"
ADMIN_TOKEN="fake-metrics-admin-$(openssl rand -hex 20)"
verify_setup
trap verify_cleanup EXIT
ensure_tools_image
cat >> "$WORK/mailo.env" <<ENV
MAILO_OPS_TOKEN=$READ_TOKEN
MAILO_OPS_ADMIN_NAMES=oncall
MAILO_OPS_ADMIN_TOKEN_ONCALL=$ADMIN_TOKEN
MAILO_METRICS_CACHE_SECONDS=1
ENV

"${DC[@]}" down -v --remove-orphans >/dev/null 2>&1
log "compose up (read_only 컨테이너, 캐시 1초)"
if ! "${DC[@]}" up -d --build --wait --wait-timeout 180 >"$WORK/up.log" 2>&1; then
  tail -30 "$WORK/up.log"; "${DC[@]}" logs mailo | tail -20; echo "기동 실패" >&2; exit 1
fi
cid="$(mailo_cid)"
readonly_rootfs="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid")"
log "mailo health: $(docker inspect -f '{{.State.Health.Status}}' "$cid"), ReadonlyRootfs=$readonly_rootfs"

for i in $(seq 1 "$N"); do post_job "metrics-$i" "METRICS-SUBJECT-$i" >/dev/null; done
for _ in $(seq 1 60); do
  s=$(psql_q "select count(*) from mail_jobs where status='SENT'")
  [ "$s" -ge "$N" ] && break
  sleep 1
done
sleep 2 # 캐시 TTL(1초)이 지나 전역 gauge가 최신 값이 되게 한다.

URL="http://127.0.0.1:$PUBLISH_PORT/metrics"
code_of() { curl -sS -o /dev/null -w '%{http_code}' "$@" "$URL"; }
code_read=$(code_of -H "Authorization: Bearer $READ_TOKEN")
code_admin=$(code_of -H "Authorization: Bearer $ADMIN_TOKEN")
code_none=$(code_of)
code_key=$(code_of -H "Authorization: Bearer $API_KEY")
curl -sS -D "$WORK/headers.txt" -o "$WORK/metrics.txt" -H "Authorization: Bearer $READ_TOKEN" "$URL"
ctype=$(grep -i '^content-type:' "$WORK/headers.txt" | tr -d '\r' | tr 'A-Z' 'a-z')
metric() { grep -E "^$1 " "$WORK/metrics.txt" | awk '{print $2}'; }
sent_attempts=$(metric 'mailo_attempts_total\{caller_id="alpha",account_id="default",result="sent"\}')
sent_finished=$(metric 'mailo_jobs_finished_total\{caller_id="alpha",account_id="default",status="sent"\}')
due=$(metric 'mailo_queue_jobs\{account_id="default",state="due"\}')
breaker_closed=$(metric 'mailo_breaker_state\{account_id="default",state="closed"\}')
audit_rows=$(metric 'mailo_ops_audit_rows')
collect_bad=$(grep -E '^mailo_metrics_collect_ok\{' "$WORK/metrics.txt" | grep -vc ' 1$')
series=$(grep -vc '^#' "$WORK/metrics.txt")
leaks=0
for secret in "$READ_TOKEN" "$ADMIN_TOKEN" "$API_KEY" "kim@example.com" "METRICS-SUBJECT" "metrics-1"; do
  grep -q -- "$secret" "$WORK/metrics.txt" && { echo "응답에 비밀 값이 있다: ${secret:0:12}…"; leaks=$((leaks + 1)); }
done
if "${DC[@]}" logs --no-log-prefix mailo 2>&1 | grep -qF -e "$READ_TOKEN" -e "$ADMIN_TOKEN"; then echo "컨테이너 로그에 토큰이 있다"; leaks=$((leaks + 1)); fi

promtool="건너뜀"
if docker image inspect "$PROMTOOL_IMAGE" >/dev/null 2>&1 || docker pull -q "$PROMTOOL_IMAGE" >/dev/null 2>&1; then
  if out=$(docker run --rm -i --entrypoint promtool "$PROMTOOL_IMAGE" check metrics < "$WORK/metrics.txt" 2>&1); then
    promtool="통과"
  else
    promtool="지적 있음"
  fi
  [ -n "$out" ] && promtool_out="$out" || promtool_out="(출력 없음)"
fi

echo
echo "== /metrics 관찰 =="
echo "ReadonlyRootfs=$readonly_rootfs"
echo "상태 코드: 읽기 토큰 $code_read, 관리 토큰 $code_admin, 무토큰 $code_none, 호출처 키 $code_key"
echo "$ctype"
echo "시리즈 $series개, attempts(sent)=$sent_attempts, finished(sent)=$sent_finished, due=$due, breaker closed=$breaker_closed, 감사 행=$audit_rows, collect_ok가 1이 아닌 그룹=$collect_bad"
echo "비밀 값 노출 $leaks건"
echo "promtool check metrics: $promtool"
[ "$promtool" = "지적 있음" ] && echo "$promtool_out" | sed 's/^/  /'
ok=1
[ "$readonly_rootfs" = true ] && [ "$code_read" = 200 ] && [ "$code_admin" = 403 ] && [ "$code_none" = 401 ] && [ "$code_key" = 401 ] \
  && [ "$ctype" = "content-type: text/plain; version=0.0.4; charset=utf-8" ] \
  && [ "$sent_attempts" = "$N" ] && [ "$sent_finished" = "$N" ] && [ "$due" = 0 ] && [ "$breaker_closed" = 1 ] && [ "$audit_rows" = 0 ] \
  && [ "$collect_bad" = 0 ] && [ "$leaks" = 0 ] && [ "$promtool" != "지적 있음" ] || ok=0
if [ "$ok" = 1 ]; then echo "결과: read_only 컨테이너에서 /metrics가 기대대로 응답한다"; else echo "결과: 기대와 다른 항목이 있다(위 수치 확인)"; fi
[ "$ok" = 1 ]
