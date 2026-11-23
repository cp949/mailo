#!/usr/bin/env bash
# 확인 (e): root로 실행하면 권한 모델이 성립하지 않음을 보인다(ADR-0004 결정 8, RQ-024).
# 호출처 B 역할 컨테이너를 root로, 그리고 Mailo와 같은 UID로 실행해 C의 폴더에 접근하는지 확인한다.
# acl·group 두 볼륨을 각각 만들고 끝나면 지운다(전용 접두어 mailo-voltest-).
# 기대: root(기본 capability)는 두 방식 모두에서 C 폴더를 읽고 쓴다. 이 경우 폴더 권한은 접근 통제가 아니다.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

ensure_tools_image
C=/data/inbox/caller-c
VOLS=()
trap 'for v in "${VOLS[@]}"; do remove_volume "$v"; done' EXIT

# 호출처 역할을 임의 사용자·capability로 실행한다. 인자: 볼륨, "사용자 spec", 추가 docker 옵션, 명령
as_role() { local v="$1" u="$2" opt="$3"; shift 3; docker run --rm --user "$u" $opt -v "$v":/data "$TOOLS_IMAGE" sh -c "$*"; }

for mode in acl group; do
  vol="$PREFIX-root-$mode"
  VOLS+=("$vol")
  remove_volume "$vol"
  init_volume "$vol" "$mode" >/dev/null || { echo "초기화 실패: $mode" >&2; exit 1; }
  as_c "$vol" "echo '{\"secret\":1}' > $C/.c.tmp && mv $C/.c.tmp $C/c1.json" >/dev/null

  # 정상 B(non-root, 다른 UID)는 막힌다. 비교 기준이다.
  probe "[$mode] 비교: non-root B(UID $UID_B)가 C 폴더 목록 조회" DENY "as_role $vol $UID_B:$UID_B '' 'ls $C'"
  # root인 호출처 컨테이너
  probe "[$mode] root 호출처가 C 폴더 목록 조회" ALLOW "as_role $vol 0:0 '' 'ls $C'"
  probe "[$mode] root 호출처가 C의 파일 읽기" ALLOW "as_role $vol 0:0 '' 'cat $C/c1.json'"
  probe "[$mode] root 호출처가 C 폴더에 파일 위조 생성" ALLOW "as_role $vol 0:0 '' 'echo forged > $C/forged.json'"
  probe "[$mode] root 호출처가 C의 파일 삭제" ALLOW "as_role $vol 0:0 '' 'rm $C/c1.json'"
  # root여도 capability를 모두 버리면 DAC 우회가 사라진다. 참고용이며 root 실행을 허용하는 근거가 아니다.
  as_c "$vol" "echo '{\"secret\":2}' > $C/.c.tmp && mv $C/.c.tmp $C/c2.json" >/dev/null
  probe "[$mode] 참고: root + cap-drop ALL 호출처가 C 폴더 목록 조회" DENY "as_role $vol 0:0 '--cap-drop ALL' 'ls $C'"
done

# 호출처가 Mailo와 같은 UID이면 acl 방식에서 폴더 소유자 권한을 그대로 얻는다.
vol="$PREFIX-root-acl"
as_c "$vol" "echo '{\"secret\":3}' > $C/.c.tmp && mv $C/.c.tmp $C/c3.json" >/dev/null
probe "[acl] 호출처 UID가 Mailo와 같을 때 C 폴더 목록 조회" ALLOW "as_role $vol $UID_MAILO:$UID_MAILO '' 'ls $C'"
probe "[acl] 호출처 UID가 Mailo와 같을 때 C의 파일 읽기" ALLOW "as_role $vol $UID_MAILO:$UID_MAILO '' 'cat $C/c3.json'"
# 같은 UID의 호출처가 공용 그룹 G에 속하면 group 방식에서 모든 호출처 폴더에 접근한다.
vol="$PREFIX-root-group"
as_c "$vol" "echo '{\"secret\":3}' > $C/.c.tmp && mv $C/.c.tmp $C/c3.json" >/dev/null
probe "[group] 호출처 컨테이너에 공용 그룹 G를 주면 C 폴더 목록 조회" ALLOW "as_role $vol $UID_B:$UID_B '--group-add $GID_SHARED' 'ls $C'"

print_table
[ "$FAIL" -eq 0 ]
