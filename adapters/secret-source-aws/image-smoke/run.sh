#!/usr/bin/env bash
# 변형 이미지(-aws)의 구조와 어댑터 해석을 확인한다(ADR-0016 결정 4·9).
# 사용법: run.sh <변형 이미지>
# compose와 같은 보안 옵션(read_only, cap_drop ALL, no-new-privileges)과 `--network none`으로 이미지 안에서 실행한다.
# 출력에 시험 값(SMOKE-SENTINEL)이 있으면 실패한다. 제한 시간 안에 끝나지 않으면(어댑터가 핸들을 남김) 실패한다.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf '사용법: %s <변형 이미지>\n' "$0" >&2
  exit 2
fi
readonly image="$1"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly here

run=(docker run --rm --pull never --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true)

# 1. 구조: non-root, 어댑터와 SDK 존재, /repo와 /opt의 어댑터는 root 소유이고 node가 쓸 수 없다.
id_out="$("${run[@]}" --entrypoint id "$image")"
case "$id_out" in
  "uid=1000(node) gid=1000(node)"*) ;;
  *)
    printf '컨테이너가 node(UID 1000)로 실행되지 않는다: %s\n' "$id_out" >&2
    exit 1
    ;;
esac
"${run[@]}" --entrypoint sh "$image" -c '
  set -e
  link=/repo/apps/mailo/node_modules/@cp949/mailo-secret-source-aws
  test -L "$link"
  test -f "$link/index.js"
  test -d /opt/mailo-secret-source-aws/node_modules/@aws-sdk/client-secrets-manager
  # node 소유이거나 누구나 쓸 수 있는 경로(심볼릭 링크 자체의 모드는 제외)가 없어야 한다. BusyBox find에는 -writable이 없다.
  bad="$(find /repo /opt/mailo-secret-source-aws \( ! -user root -o \( ! -type l -a -perm -0002 \) \) -print -quit)"
  if [ -n "$bad" ]; then echo "root 소유가 아니거나 누구나 쓸 수 있는 경로: $bad"; exit 1; fi
  test ! -w /repo/apps/mailo/node_modules/@cp949
' || {
  printf '변형 이미지 구조 확인이 실패했다\n' >&2
  exit 1
}

# 2. 이미지 안 스모크. 값은 출력하지 않는다.
output="$("${run[@]}" --volume "$here/smoke.mjs:/smoke/smoke.mjs:ro" --entrypoint timeout "$image" \
  -s KILL 60 node /smoke/smoke.mjs 2>&1)" && status=0 || status=$?
printf '%s\n' "$output"
if grep -q 'SMOKE-SENTINEL' <<<"$output"; then
  printf '스모크 출력에 시험 값이 있다\n' >&2
  exit 1
fi
if [[ "$status" -eq 137 ]]; then
  printf '스모크가 제한 시간 안에 끝나지 않았다(어댑터가 핸들을 남겼을 수 있다)\n' >&2
fi
exit "$status"
