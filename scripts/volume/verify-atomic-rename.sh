#!/usr/bin/env bash
# 확인 (f): rename이 같은 폴더 안에서 원자적이고 Mailo 폴링이 부분 파일을 보지 못하는지 확인한다
# (RQ-002, ADR-0004 결정 3·4). 호출처(UID 10002)가 4 MiB 파일을 64 KiB 청크로 써서 rename하는 동안
# Mailo 역할(UID 1000)이 readdir을 1 ms 간격으로 돌며 *.json을 읽고 삭제한다.
# 사용: verify-atomic-rename.sh [acl|group] [건수]  기본 acl 100건
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

MODE="${1:-acl}"
COUNT="${2:-100}"
MIB=4
VOL="$PREFIX-atomic-$MODE"
B=/data/inbox/caller-b
trap 'remove_volume "$VOL"' EXIT
ensure_tools_image
remove_volume "$VOL"
init_volume "$VOL" "$MODE" >/dev/null || { echo "초기화 실패" >&2; exit 1; }

MJS="$REPO_ROOT/test/volume/rename-visibility.mjs"
OUT="$(mktemp -d)"

# Mailo 역할 폴러를 먼저 띄우고 호출처 쓰기를 시작한다.
docker run --rm --user "$UID_MAILO:$GID_MAILO" --group-add "$GID_SHARED" -v "$VOL":/data \
  -v "$MJS":/probe.mjs:ro "$TOOLS_IMAGE" node /probe.mjs poller "$B" "$MIB" > "$OUT/poller.json" 2> "$OUT/poller.err" &
POLLER=$!
sleep 1
docker run --rm --user "$UID_B:$UID_B" -v "$VOL":/data \
  -v "$MJS":/probe.mjs:ro "$TOOLS_IMAGE" node /probe.mjs writer "$B" "$COUNT" "$MIB" > "$OUT/writer.json" 2> "$OUT/writer.err"
WRITER_RC=$?
wait "$POLLER"; POLLER_RC=$?

echo "writer(호출처): $(cat "$OUT/writer.json") rc=$WRITER_RC"
echo "poller(Mailo):  $(cat "$OUT/poller.json") rc=$POLLER_RC"
cat "$OUT/writer.err" "$OUT/poller.err" 2>/dev/null | head -5

# 같은 파일시스템이 아닌 곳에서 옮기는 경우(비원자적). 호출처가 컨테이너 임시 디렉터리에 쓰고 볼륨으로 rename하면 실패한다.
probe "(f) 같은 폴더 안 rename은 같은 inode 유지(복사 아님)" ALLOW "grep -q '\"inodeKept\":true' $OUT/writer.json"
probe "(f) 폴러가 읽은 *.json은 모두 완성 파일(끝 표지 존재)" ALLOW "grep -q '\"partial\":0' $OUT/poller.json && grep -q '\"complete\":$COUNT' $OUT/poller.json"
probe "(f) 폴러가 쓰는 도중의 임시 파일을 실제로 관찰했다(시험이 공허하지 않음)" ALLOW "node -e 'const r=JSON.parse(require(\"fs\").readFileSync(\"$OUT/poller.json\",\"utf8\"));process.exit(r.tmpSmallerThanFull>0?0:1)'"
probe "(f) 다른 파일시스템(컨테이너 /tmp)에서 볼륨으로 rename은 EXDEV로 실패(원자적 이동 불가)" ALLOW \
  "docker run --rm --user $UID_B:$UID_B -v $VOL:/data $TOOLS_IMAGE node -e \"const fs=require('fs');fs.writeFileSync('/tmp/x','x');try{fs.renameSync('/tmp/x','$B/x.json');process.exit(1)}catch(e){process.exit(e.code==='EXDEV'?0:1)}\""

print_table
rm -rf "$OUT"
[ "$FAIL" -eq 0 ]
