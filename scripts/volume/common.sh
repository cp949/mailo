#!/usr/bin/env bash
# 볼륨 권한 검증 공용 함수(ADR-0004 결정 8, RQ-024). 직접 실행하지 않고 source한다.
# 이 작업이 만든 볼륨·컨테이너·이미지만 이름 접두어(mailo-voltest)로 다룬다.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOLS_IMAGE="mailo-volume-tools:local"
PREFIX="mailo-voltest"

# 계정 구성: Mailo(A)는 non-root 1000, 호출처 B·C는 서로 다른 non-root UID, 공용 그룹 G는 Mailo만 가진다.
UID_MAILO=1000
GID_MAILO=1000
UID_B=10002
UID_C=10003
GID_SHARED=2000

PASS=0
FAIL=0
ROWS=()

# 도구 이미지가 없으면 만든다(alpine + node + acl).
ensure_tools_image() {
  if ! docker image inspect "$TOOLS_IMAGE" >/dev/null 2>&1; then
    docker build -q -t "$TOOLS_IMAGE" -f "$REPO_ROOT/test/volume/Dockerfile.tools" "$REPO_ROOT/test/volume" >/dev/null
  fi
}

# 볼륨을 만들고 초기화한다. 인자: 볼륨 이름, 방식(acl|group)
init_volume() {
  local vol="$1" mode="$2"
  docker volume create "$vol" >/dev/null
  docker run --rm --user 0:0 \
    -e MAILO_UID="$UID_MAILO" -e MAILO_GID="$GID_MAILO" -e SHARED_GID="$GID_SHARED" \
    -e CALLERS="caller-b:$UID_B caller-c:$UID_C" \
    -v "$vol":/data -v "$REPO_ROOT/scripts/volume/init-volume.sh":/init-volume.sh:ro \
    "$TOOLS_IMAGE" sh /init-volume.sh "$mode" /data
}

# 역할별 컨테이너 실행. 인자: 볼륨, 명령(sh -c 문자열). 종료 코드를 그대로 돌려준다.
# Mailo는 compose의 group_add와 같이 보조 그룹 G를 받는다. 호출처는 G에 속하지 않는다.
as_mailo() { local v="$1"; shift; docker run --rm --user "$UID_MAILO:$GID_MAILO" --group-add "$GID_SHARED" -v "$v":/data "$TOOLS_IMAGE" sh -c "$*"; }
as_b()     { local v="$1"; shift; docker run --rm --user "$UID_B:$UID_B" -v "$v":/data "$TOOLS_IMAGE" sh -c "$*"; }
as_c()     { local v="$1"; shift; docker run --rm --user "$UID_C:$UID_C" -v "$v":/data "$TOOLS_IMAGE" sh -c "$*"; }

# 한 가지 동작의 허용(ALLOW)·차단(DENY)을 기대와 비교하고 표 행으로 남긴다.
# 인자: 라벨, 기대(ALLOW|DENY), 실행 함수 호출 전체(문자열, eval)
probe() {
  local label="$1" expect="$2" cmd="$3" actual out
  if out=$(eval "$cmd" 2>&1); then actual=ALLOW; else actual=DENY; fi
  local verdict=OK
  if [ "$actual" != "$expect" ]; then verdict="기대와 다름"; FAIL=$((FAIL + 1)); else PASS=$((PASS + 1)); fi
  ROWS+=("| $label | $expect | $actual | $verdict |")
  [ "$verdict" = OK ] || printf '  [불일치] %s: %s\n' "$label" "$(printf '%s' "$out" | head -2 | tr '\n' ' ')" >&2
}

print_table() {
  printf '| 확인 | 기대 | 실제 | 판정 |\n| --- | --- | --- | --- |\n'
  printf '%s\n' "${ROWS[@]}"
  printf '\n통과 %d, 기대와 다름 %d\n' "$PASS" "$FAIL"
}

# 이 작업이 만든 볼륨만 지운다. 위험도: 낮음(전용 이름 접두어 검사). 롤백: 스크립트 재실행으로 재생성.
remove_volume() {
  local vol="$1"
  case "$vol" in
    "$PREFIX"-*) docker volume rm -f "$vol" >/dev/null 2>&1 || true ;;
    *) echo "접두어가 다른 볼륨은 지우지 않는다: $vol" >&2 ;;
  esac
}
