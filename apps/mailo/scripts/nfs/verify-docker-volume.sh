#!/usr/bin/env bash
# Docker local 드라이버 NFS named volume으로 Mailo 파일 채널이 동작하는지 같은 호스트 loopback NFS에서 확인한다(RQ-002·024, ADR-0004 결정 8).
# docker-compose.yml + docker-compose.nfs-example.yml + test/nfs/docker-compose.verify.yml로 컨테이너를 띄우고,
# 호출처(UID 2001)가 w mount에서 파일을 넣으면 컨테이너의 Mailo가 NFS volume으로 읽어 등록하고 지우는지 본다.
# 위험도: 중간. setup.sh·teardown.sh와 같은 호스트 NFS export·mount를 추가했다가 되돌리고, compose 프로젝트 mailo-nfsvol 2개를 만들었다가 `down -v`로 지운다.
# 롤백: 이 스크립트가 trap으로 정리한다. 중간에 죽었으면 `docker compose -p mailo-nfsvol down -v`, `-p mailo-nfsvol-noinbox down -v`, scripts/nfs/teardown.sh를 실행한다.
# 전제: 비밀번호 없는 sudo(없으면 exit 20), docker, openssl, 호스트 NFS 클라이언트, nfs-kernel-server(없으면 setup.sh가 exit 21. MAILO_NFS_INSTALL=1을 주면 apt로 설치한다).
# 상태: 작성했으나 실행하지 못했다(작성 환경에 nfs-kernel-server가 없었고 호스트 패키지 설치는 하지 않았다). 첫 실행에서 스크립트 자체의 오류가 나올 수 있다.
# 사용: scripts/nfs/verify-docker-volume.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
sudo -n true 2>/dev/null || { echo "sudo 불가: 비밀번호 없이 sudo를 쓸 수 없다. 중단한다." >&2; exit 20; }
# shellcheck source=lib.sh
. "$HERE/lib.sh"

WORK="$(mktemp -d)"
export MAILO_NFS_ADDR=127.0.0.1 MAILO_NFS_EXPORT="$MAILO_NFS_EXPORT"
export VERIFY_ENV_FILE="$WORK/mailo.env" VERIFY_CALLERS_FILE="$WORK/callers.json" VERIFY_PUBLISH_PORT=13100
export POSTGRES_PASSWORD="p@ss/w:rd#1%2x"
FILES=(-f "$REPO/docker-compose.yml" -f "$REPO/docker-compose.nfs-example.yml" -f "$REPO/test/nfs/docker-compose.verify.yml")
DC=(docker compose -p mailo-nfsvol "${FILES[@]}")
DC2=(docker compose -p mailo-nfsvol-noinbox "${FILES[@]}")
PASS=0; FAIL=0
check() { # 인자: 라벨, 명령
  if eval "$2" >/dev/null 2>&1; then PASS=$((PASS + 1)); echo "  [통과] $1"; else FAIL=$((FAIL + 1)); echo "  [실패] $1"; fi
}
cleanup() {
  "${DC[@]}" down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
  MAILO_NFS_EXPORT="$MAILO_NFS_EXPORT/inbox/alpha" VERIFY_PUBLISH_PORT=13101 "${DC2[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  "$HERE/teardown.sh" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# 호출처 호스트의 클라이언트는 4.2여야 한다(nfs.md). 서버·mount는 setup.sh가 만든다.
MAILO_NFS_VERS=4.2 "$HERE/setup.sh" >"$WORK/setup.log" 2>&1 || { cat "$WORK/setup.log"; echo "NFS 환경 준비 실패" >&2; exit 1; }

hash="$(printf '%s' fake-nfsvol-key | sha256sum | cut -d' ' -f1)"
printf '{"callers":[{"id":"alpha","apiKeyHashes":["%s"],"fileChannel":true,"signature":{"mode":"none"}}]}' "$hash" >"$WORK/callers.json"
chmod 0644 "$WORK/callers.json"
cat >"$WORK/mailo.env" <<ENV
MAILO_SMTP_HOST=smtp.example.invalid
MAILO_SMTP_USER=fake-user@example.invalid
MAILO_SMTP_PASSWORD=fake-smtp-password
MAILO_SMTP_FROM=no-reply@example.com
MAILO_DB_ENCRYPTION_KEY_VERSION=1
MAILO_DB_ENCRYPTION_KEY_V1=$(openssl rand -base64 32)
MAILO_FINGERPRINT_KEY_VERSION=1
MAILO_FINGERPRINT_KEY_V1=$(openssl rand -base64 32)
MAILO_FILE_CHANNEL_ROOT=/var/mailo/files
MAILO_FILE_POLL_INTERVAL_MS=500
ENV

echo "== 1. NFS named volume으로 기동 =="
if ! "${DC[@]}" up -d --build --wait --wait-timeout 180 >"$WORK/up.log" 2>&1; then
  tail -30 "$WORK/up.log"; "${DC[@]}" logs mailo | tail -20; echo "기동 실패" >&2; exit 1
fi
MOUNT_LINE="$("${DC[@]}" exec -T mailo sh -c "grep ' /var/mailo/files ' /proc/mounts")"
echo "  컨테이너 mount: $MOUNT_LINE"
check "컨테이너의 /var/mailo/files가 nfs4 mount다" "[[ '$MOUNT_LINE' == *' nfs4 '* ]]"
check "mount 옵션에 vers=4.2, hard, lookupcache=pos가 있다" "[[ '$MOUNT_LINE' == *vers=4.2* && '$MOUNT_LINE' == *,hard,* && '$MOUNT_LINE' == *lookupcache=pos* ]]"
check "컨테이너가 non-root UID 1000이다" "[ \"\$(${DC[*]} exec -T mailo id -u)\" = 1000 ]"
check "Mailo가 inbox/alpha를 읽을 수 있다" "${DC[*]} exec -T mailo ls /var/mailo/files/inbox/alpha"
check "로그에 file_channel_started가 있다" "${DC[*]} logs mailo 2>&1 | grep -q file_channel_started"
check "이미지 파일시스템은 읽기 전용이다(/repo 쓰기 실패)" "! ${DC[*]} exec -T mailo sh -c 'touch /repo/apps/mailo/dist/x'"
check "/tmp는 쓸 수 있다(tmpfs)" "${DC[*]} exec -T mailo sh -c 'touch /tmp/x'"
check "capability가 모두 빠져 있다(CapEff 0)" "${DC[*]} exec -T mailo sh -c \"grep -q '^CapEff:.*0000000000000000' /proc/1/status\""

echo "== 2. 호출처(UID 2001)가 w mount에 파일을 넣으면 컨테이너가 읽어 등록하고 지운다 =="
REQ='{"version":1,"idempotencyKey":"nfsvol-0001","to":["kim@example.com"],"from":"no-reply@example.com","subject":"NFSVOL","text":"nfs volume body"}'
INBOX_W="$MAILO_NFS_MNT/w/inbox/alpha"
sudo -n setpriv --reuid=2001 --regid=2001 --clear-groups sh -c "umask 077; printf '%s' '$REQ' > '$INBOX_W/.nfsvol.tmp' && mv '$INBOX_W/.nfsvol.tmp' '$INBOX_W/nfsvol.json'"
registered=0
for _ in $(seq 1 40); do
  n="$("${DC[@]}" exec -T postgres psql -U mailo -d mailo -At -c "select count(*) from mail_jobs where idempotency_key='nfsvol-0001'" 2>/dev/null)"
  [ "$n" = 1 ] && { registered=1; break; }
  sleep 0.5
done
check "NFS volume의 파일이 작업으로 등록됐다(umask 077 호출처, 4.2)" "[ $registered = 1 ]"
check "등록 뒤 원본 파일이 지워졌다" "[ -z \"\$(sudo -n ls -A '$MAILO_NFS_EXPORT/inbox/alpha')\" ]"
check "로그에 본문이 없다(RQ-027)" "! ${DC[*]} logs mailo 2>&1 | grep -q 'nfs volume body'"

echo "== 3. inbox가 없는 경로를 volume으로 주면 앱이 기동을 거부한다 =="
export MAILO_NFS_EXPORT="$MAILO_NFS_EXPORT/inbox/alpha" VERIFY_PUBLISH_PORT=13101
"${DC2[@]}" up -d mailo >"$WORK/up2.log" 2>&1
code=""
for _ in $(seq 1 60); do
  code="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$("${DC2[@]}" ps -aq mailo)" 2>/dev/null)"
  [[ "$code" == exited* ]] && break
  sleep 1
done
echo "  mailo 상태: $code"
echo "  로그: $("${DC2[@]}" logs --no-log-prefix mailo 2>&1 | tail -2 | tr '\n' ' ')"
check "mailo가 종료 코드 1로 끝났다" "[ '$code' = 'exited 1' ]"
check "로그가 inbox 폴더 문제를 알린다" "${DC2[*]} logs mailo 2>&1 | grep -q 'inbox 폴더'"

echo
echo "통과 $PASS, 실패 $FAIL"
[ "$FAIL" -eq 0 ]
