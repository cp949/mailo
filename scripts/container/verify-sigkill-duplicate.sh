#!/usr/bin/env bash
# SIGKILL 중복 발송 재현(RQ-013·020, ADR-0002 결정 12). 관찰만 기록하고 보장 여부를 판정하지 않는다.
# 순서: 가짜 SMTP가 DATA를 받은 직후 최종 응답을 DATA_DELAY_MS 동안 미룬다 -> 그 사이 `docker kill -s KILL`로 Mailo를 죽인다
#       -> Mailo를 다시 띄운다 -> lease 만료 뒤 같은 작업이 다시 발송되는지(SMTP가 받은 Message-ID) 본다.
# 사용: scripts/container/verify-sigkill-duplicate.sh   (저장소 루트와 무관하게 실행 가능)
# 필요: docker compose v2.24 이상(override의 !override·!reset), openssl, curl, 이미지 빌드용 네트워크
# 위험도: 중간. compose 프로젝트 mailo-verify의 mailo 컨테이너 하나에만 `docker kill -s KILL`을 보내고,
#         끝에 그 프로젝트의 컨테이너·볼륨(`down -v`)·빌드 이미지를 지운다. 다른 프로젝트는 건드리지 않는다.
#         롤백: 스크립트 재실행(상태를 새로 만든다). KEEP=1이면 정리하지 않는다.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

FILE_CHANNEL=0
LEASE_SECONDS=45   # SMTP 타임아웃 10초 기준 최소값에 가깝다(connect·greeting·socket 합 30초 + 여유 10초가 lease 이하여야 기동한다. DB 시간제한은 common.sh가 줄여 준다)
DATA_DELAY_MS=90000
KILL_AFTER_RECEIVED_SECONDS=2
verify_setup
trap verify_cleanup EXIT
ensure_tools_image

"${DC[@]}" down -v --remove-orphans >/dev/null 2>&1
log "compose up (healthcheck 통과까지 대기, lease=${LEASE_SECONDS}s, SMTP 응답 지연=${DATA_DELAY_MS}ms)"
if ! "${DC[@]}" up -d --build --wait --wait-timeout 180 >"$WORK/up.log" 2>&1; then
  tail -30 "$WORK/up.log"; "${DC[@]}" logs mailo | tail -20; echo "기동 실패" >&2; exit 1
fi
log "mailo health: $(docker inspect -f '{{.State.Health.Status}}' "$(mailo_cid)")"

code="$(post_job sigkill-0001 SIGKILL-DUP)"
log "POST /jobs -> HTTP $code"
[ "$code" = 202 ] || { echo "등록 실패" >&2; exit 1; }

for _ in $(seq 1 60); do [ "$(smtp_log | wc -l)" -ge 1 ] && break; sleep 0.5; done
[ "$(smtp_log | wc -l)" -ge 1 ] || { echo "SMTP가 메일을 받지 못했다" >&2; "${DC[@]}" logs mailo | tail -20; exit 1; }
log "SMTP가 DATA를 받음(최종 응답은 ${DATA_DELAY_MS}ms 지연 중)"
sleep "$KILL_AFTER_RECEIVED_SECONDS"
t_kill_state="$(psql_q "select status||' lease_until-now='||round(extract(epoch from (lease_until-now()))::numeric,1)||'s attempts='||attempts from mail_jobs where idempotency_key='sigkill-0001'")"
log "kill 직전 DB: $t_kill_state"
t_kill_epoch=$(date +%s)
docker kill -s KILL "$(mailo_cid)" >/dev/null
log "docker kill -s KILL 전송. 컨테이너 상태: $(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' "$("${DC[@]}" ps -aq mailo)")"
log "kill 직후 DB: $(psql_q "select status||' lease_until-now='||round(extract(epoch from (lease_until-now()))::numeric,1)||'s attempts='||attempts from mail_jobs where idempotency_key='sigkill-0001'")"

"${DC[@]}" start mailo >/dev/null 2>&1
log "mailo 재기동. lease 만료 뒤 재발송을 최대 $((LEASE_SECONDS + 60))초 기다린다"
for _ in $(seq 1 $(((LEASE_SECONDS + 60) * 2))); do [ "$(smtp_log | wc -l)" -ge 2 ] && break; sleep 0.5; done
t_second_epoch=$(date +%s)

echo
echo "== SMTP가 받은 메일(수신 순서) =="
smtp_log
n=$(smtp_log | wc -l)
ids=$(smtp_log | sed -n 's/.*"messageId":"\([^"]*\)".*/\1/p' | sort -u | wc -l)
sleep 3
final="$(psql_q "select status||' attempts='||attempts from mail_jobs where idempotency_key='sigkill-0001'")"
echo
echo "== 관찰 요약 =="
echo "SMTP 수신 횟수: $n (유일 Message-ID $ids개)"
echo "kill 뒤 두 번째 수신까지: $((t_second_epoch - t_kill_epoch))초(lease ${LEASE_SECONDS}초)"
echo "최종 DB 상태: $final"
echo "Mailo 로그(재기동 뒤, 회수·결과 이벤트): "
"${DC[@]}" logs --no-log-prefix --since "$(date -u -d "@$t_kill_epoch" +%Y-%m-%dT%H:%M:%SZ)" mailo 2>&1 | grep -E '"event":"(lease_recovered|job_|retry|sent|attempt)' | cut -c1-220 | sed 's/^/  /'
echo "REST 조회: $(curl -sS "http://127.0.0.1:$PUBLISH_PORT/jobs?idempotencyKey=sigkill-0001" -H "Authorization: Bearer $API_KEY" | head -c 200)"
if [ "$n" -ge 2 ] && [ "$ids" = 1 ]; then echo "결과: 같은 Message-ID로 ${n}통이 SMTP에 도착했다(중복 발송 재현)"; else echo "결과: 중복 발송이 재현되지 않았다(수신 ${n}통, Message-ID ${ids}종)"; fi
