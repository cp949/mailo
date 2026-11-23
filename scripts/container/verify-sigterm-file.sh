#!/usr/bin/env bash
# 컨테이너 SIGTERM 종료 검증(RQ-025, ADR-0004 구현 중 확정 12·AGENTS.md 컨테이너 절). 관찰만 기록한다.
# 파일 채널을 켠 Mailo 컨테이너에 파일 N개를 한꺼번에 넣고, 폴러가 처리하는 도중 `docker compose stop`(SIGTERM)을 보낸다.
# 확인: (1) 종료 코드 0(SIGKILL 137 아님) (2) 정지에 걸린 시간이 stop_grace_period(150초) 안 (3) 남은 파일은 DB에 없고
#       DB에 있는 작업의 파일은 모두 지워졌다(등록 뒤 삭제 전에 끊기지 않음) (4) SENDING 작업이 남지 않음
#       (5) 다시 띄우면 남은 파일이 수집되고 N통이 중복 없이 발송된다.
# 사용: scripts/container/verify-sigterm-file.sh [파일 수, 기본 1000]
# 위험도: 낮음. compose 프로젝트 mailo-verify만 만들고 `down -v --rmi local`로 지운다. 롤백: 스크립트 재실행. KEEP=1이면 정리하지 않는다.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

N="${1:-1000}"
FILE_CHANNEL=1
LEASE_SECONDS=45
DATA_DELAY_MS=0
FILE_POLL_MS=500
verify_setup
trap verify_cleanup EXIT
ensure_tools_image

"${DC[@]}" down -v --remove-orphans >/dev/null 2>&1
log "compose up (파일 채널 on, 폴링 ${FILE_POLL_MS}ms, lease ${LEASE_SECONDS}s, 비밀번호는 예약 문자 포함)"
if ! "${DC[@]}" up -d --build --wait --wait-timeout 180 >"$WORK/up.log" 2>&1; then
  tail -30 "$WORK/up.log"; "${DC[@]}" logs mailo | tail -20; echo "기동 실패" >&2; exit 1
fi
log "mailo health: $(docker inspect -f '{{.State.Health.Status}}' "$(mailo_cid)")"

INBOX="$WORK/files/inbox/alpha"
STAGE="$WORK/stage"
mkdir -p "$STAGE"
for i in $(seq 1 "$N"); do
  printf '{"version":1,"idempotencyKey":"sigterm-%04d","to":["kim@example.com"],"from":"no-reply@example.com","subject":"SIGTERM-%04d","text":"verify body"}' "$i" "$i" > "$STAGE/req-$i.json"
done
log "파일 ${N}개를 같은 파일시스템의 staging에서 rename으로 한꺼번에 넣는다"
mv "$STAGE"/req-*.json "$INBOX"/

# 폴러가 처리하는 도중(남은 파일이 N보다 적어진 시점)에 SIGTERM을 보낸다.
for _ in $(seq 1 400); do
  c=$(find "$INBOX" -maxdepth 1 -name 'req-*.json' | wc -l)
  [ "$c" -lt "$N" ] && break
  sleep 0.01
done
c_before=$(find "$INBOX" -maxdepth 1 -name 'req-*.json' | wc -l)
t0=$(date +%s.%N)
log "docker compose stop mailo 호출. 이 시점 남은 파일 $c_before / $N"
"${DC[@]}" stop mailo >/dev/null 2>&1
t1=$(date +%s.%N)
cid="$("${DC[@]}" ps -aq mailo)"
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$cid")"
oom="$(docker inspect -f '{{.State.OOMKilled}}' "$cid")"
c_after=$(find "$INBOX" -maxdepth 1 -name 'req-*.json' | wc -l)
elapsed=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}')

jobs_total=$(psql_q "select count(*) from mail_jobs")
sending=$(psql_q "select count(*) from mail_jobs where status='SENDING'")
# 남은 파일의 키가 DB에 있으면(등록은 됐는데 파일이 남음) 등록 뒤 삭제 전에 끊긴 것이다.
keys=$(find "$INBOX" -maxdepth 1 -name 'req-*.json' -printf '%f\n' | sed 's/^req-\([0-9]*\)\.json$/sigterm-\1/' | sed "s/-\([0-9]\)\$/-000\1/;s/-\([0-9][0-9]\)\$/-00\1/;s/-\([0-9][0-9][0-9]\)\$/-0\1/" | sort -u)
registered_but_left=0
if [ -n "$keys" ]; then
  list=$(printf "'%s'," $keys); list="${list%,}"
  registered_but_left=$(psql_q "select count(*) from mail_jobs where idempotency_key in ($list)")
fi

echo
echo "== SIGTERM 관찰 =="
echo "종료 코드: $exit_code (OOMKilled=$oom), stop 소요 ${elapsed}초(stop_grace_period 150초)"
echo "stop 호출 시점 남은 파일 $c_before -> 컨테이너 종료 뒤 남은 파일 $c_after (N=$N)"
echo "DB 작업 수 $jobs_total (기대 N - 남은 파일 = $((N - c_after))), SENDING 잔존 $sending"
echo "남은 파일 중 DB에 이미 등록된 것(등록 뒤 삭제 전 중단): $registered_but_left"
echo "Mailo 종료 직전 로그:"
"${DC[@]}" logs --no-log-prefix --tail 8 mailo 2>&1 | cut -c1-200 | sed 's/^/  /'

log "mailo 재기동 -> 남은 파일 수집·발송 확인"
"${DC[@]}" start mailo >/dev/null 2>&1
for _ in $(seq 1 360); do
  s=$(psql_q "select count(*) from mail_jobs where status='SENT'")
  [ "$s" -ge "$N" ] && break
  sleep 1
done
sleep 2
sent=$(psql_q "select count(*) from mail_jobs where status='SENT'")
jobs_final=$(psql_q "select count(*) from mail_jobs")
left=$(find "$INBOX" -maxdepth 1 -name 'req-*.json' | wc -l)
smtp_n=$(smtp_log | wc -l)
smtp_u=$(smtp_log | sed -n 's/.*"messageId":"\([^"]*\)".*/\1/p' | sort -u | wc -l)
echo
echo "== 재기동 뒤 =="
echo "DB 작업 $jobs_final, SENT $sent, 남은 파일 $left, SMTP 수신 $smtp_n통(유일 Message-ID $smtp_u)"
ok=1
[ "$exit_code" = 0 ] && [ "$sending" = 0 ] && [ "$registered_but_left" = 0 ] && [ "$jobs_total" = "$((N - c_after))" ] \
  && [ "$jobs_final" = "$N" ] && [ "$sent" = "$N" ] && [ "$left" = 0 ] && [ "$smtp_n" = "$N" ] && [ "$smtp_u" = "$N" ] || ok=0
if [ "$ok" = 1 ]; then echo "결과: SIGTERM에서 정상 종료하고 재기동 뒤 중복·유실 없이 처리됐다"; else echo "결과: 기대와 다른 항목이 있다(위 수치 확인)"; fi
[ "$ok" = 1 ]
