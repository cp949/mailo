#!/usr/bin/env bash
# 확인 (a)(b)(c)(d): Mailo 컨테이너(UID 1000)와 호출처 컨테이너 2개(UID 10002·10003)가
# 하나의 Docker named volume을 공유할 때의 권한 모델을 확인한다(ADR-0004 결정 8, RQ-024).
# 사용: verify-permissions.sh <acl|group>
# 볼륨은 이 스크립트가 만들고 끝나면 지운다(전용 접두어 mailo-voltest-).
# 판정은 "기대(ALLOW|DENY)"와 실제 동작의 비교다. 기대는 방식별 설계 분석이고 어긋나면 표에 표시한다.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

MODE="${1:?사용: $0 <acl|group>}"
case "$MODE" in acl | group) ;; *) echo "방식은 acl|group" >&2; exit 2 ;; esac

VOL="$PREFIX-perm-$MODE"
trap 'remove_volume "$VOL"' EXIT
ensure_tools_image
remove_volume "$VOL"
init_volume "$VOL" "$MODE" >/dev/null || { echo "볼륨 초기화 실패(파일시스템이 ACL을 지원하지 않을 수 있다)" >&2; exit 1; }

B=/data/inbox/caller-b
C=/data/inbox/caller-c

# 조건 판정용: 표에서 ALLOW/DENY 대신 참/거짓으로 보이게 한다.
probe_true() {
  probe "$1" "$2" "$3"
  local last=$(( ${#ROWS[@]} - 1 ))
  ROWS[$last]="${ROWS[$last]//ALLOW/참}"
  ROWS[$last]="${ROWS[$last]//DENY/거짓}"
}

echo "== 방식: $MODE =="

# (a) 호출처가 자기 폴더에 임시 이름으로 쓰고 rename한다.
probe "(a) B: 자기 폴더에 .tmp로 쓰고 *.json으로 rename" ALLOW \
  "as_b $VOL 'echo {\"k\":1} > $B/.a1.tmp && mv $B/.a1.tmp $B/a1.json && test -f $B/a1.json'"
probe "(a) B: 같은 이름으로 rename해 기존 파일 덮어쓰기(ADR-0004 결정 3의 경고)" ALLOW \
  "as_b $VOL 'echo {\"k\":2} > $B/.a2.tmp && mv $B/.a2.tmp $B/a1.json'"
probe "(a) C: 자기 폴더에 같은 방식으로 파일 넣기" ALLOW \
  "as_c $VOL 'echo {\"k\":3} > $C/.c1.tmp && mv $C/.c1.tmp $C/c1.json'"

# (b) Mailo가 호출처 소유 파일을 읽고 삭제한다.
probe_true "(b) 파일 소유자가 B(UID $UID_B)" ALLOW "as_mailo $VOL 'test \"\$(stat -c %u $B/a1.json)\" = $UID_B'"
if [ "$MODE" = group ]; then
  probe_true "(b) setgid로 새 파일 그룹이 공용 그룹($GID_SHARED)으로 상속" ALLOW "as_mailo $VOL 'test \"\$(stat -c %g $B/a1.json)\" = $GID_SHARED'"
fi
probe "(b) Mailo: B 소유 파일 읽기(umask 022 기본)" ALLOW "as_mailo $VOL 'cat $B/a1.json'"
probe "(b) Mailo: B 소유 파일 삭제" ALLOW "as_mailo $VOL 'rm $B/a1.json && test ! -e $B/a1.json'"

# umask 의존: 호출처 셸의 umask를 바꿔 파일을 만들고 Mailo가 읽는지 본다.
for um in 022 027 077 000; do
  expect=ALLOW
  if [ "$MODE" = group ] && [ "$um" = 077 ]; then expect=DENY; fi
  as_b "$VOL" "umask $um; echo x > $B/.u.tmp && mv $B/.u.tmp $B/u-$um.json" >/dev/null 2>&1
  probe "(b) Mailo: B가 umask $um로 만든 파일 읽기" "$expect" "as_mailo $VOL 'cat $B/u-$um.json'"
done

# 호출처가 생성 mode를 0600으로 명시하는 경우(예: mkstemp, 일부 라이브러리의 임시 파일).
as_b "$VOL" "node -e \"const fs=require('fs');fs.writeFileSync('$B/.k.tmp','x',{mode:0o600});fs.renameSync('$B/.k.tmp','$B/k0600.json')\"" >/dev/null 2>&1
probe "(b) Mailo: B가 mode 0600으로 생성한 파일 읽기(umask 무관)" DENY "as_mailo $VOL 'cat $B/k0600.json'"
probe "(b) Mailo: 읽을 수 없는 그 파일도 삭제(디렉터리 쓰기 권한만 필요)" ALLOW "as_mailo $VOL 'rm $B/k0600.json'"
as_b "$VOL" "node -e \"const fs=require('fs');fs.writeFileSync('$B/.k.tmp','x',{mode:0o600});fs.chmodSync('$B/.k.tmp',0o660);fs.renameSync('$B/.k.tmp','$B/k0660.json')\"" >/dev/null 2>&1
probe "(b) Mailo: B가 0600 생성 뒤 rename 전에 chmod 0660 한 파일 읽기" ALLOW "as_mailo $VOL 'cat $B/k0660.json'"

# (c) 호출처 간 격리. C의 파일(c1.json)을 B가 건드릴 수 있는지 본다.
probe "(c) B: C 폴더 목록 조회" DENY "as_b $VOL 'ls $C'"
probe "(c) B: C 폴더의 알려진 파일 읽기" DENY "as_b $VOL 'cat $C/c1.json'"
probe "(c) B: C 폴더에 파일 만들기" DENY "as_b $VOL 'echo x > $C/intruder.json'"
probe "(c) B: 자기 파일을 C 폴더로 rename" DENY "as_b $VOL 'echo x > $B/.m.tmp && mv $B/.m.tmp $C/m.json'"
probe "(c) B: C 폴더의 파일 삭제" DENY "as_b $VOL 'rm $C/c1.json'"
probe "(c) B: inbox 루트 목록 조회(다른 호출처 이름 노출)" DENY "as_b $VOL 'ls /data/inbox'"
probe "(c) C: B 폴더 목록 조회" DENY "as_c $VOL 'ls $B'"
probe "(c) C: B 폴더에 파일 만들기" DENY "as_c $VOL 'echo x > $B/intruder.json'"

# (d) 호출처의 자기 폴더 목록 조회. POSIX는 목록(r)과 이름 접근(x)을 분리한다.
probe "(d) B: 자기 폴더 목록 조회" DENY "as_b $VOL 'ls $B'"
probe "(d) B: 자기 폴더의 알려진 파일 stat(이름을 알면 가능)" ALLOW "as_b $VOL 'stat $B/u-022.json'"
probe "(d) B: 자기 폴더의 알려진 파일 읽기(소유자라 막을 수 없다)" ALLOW "as_b $VOL 'cat $B/u-022.json'"
probe "(d) B: 자기 폴더의 알려진 파일 삭제(소유자라 막을 수 없다)" ALLOW "as_b $VOL 'rm $B/u-022.json'"
probe "(d) Mailo: 호출처 폴더 목록 조회(폴링에 필요)" ALLOW "as_mailo $VOL 'ls $B'"

# 폴더 상태는 호출처의 권한 변경 시도 전에 기록한다.
echo
printf '폴더 상태(%s, 권한 변경 시도 전)\n' "$MODE"
as_mailo "$VOL" "ls -ld /data/inbox /data/inbox/caller-b /data/inbox/caller-c; getfacl -p $B 2>/dev/null || true"
echo

# 호출처가 폴더 권한을 바꿀 수 있는가. group 방식은 폴더 소유자가 호출처라 가능하다(자기 폴더에 한정).
if [ "$MODE" = group ]; then
  probe "(d) B: 자기 폴더에 chmod u+r로 목록 조회 권한 부여" ALLOW "as_b $VOL 'chmod u+r $B'"
else
  probe "(d) B: 자기 폴더 chmod u+r(소유자가 아니므로 불가)" DENY "as_b $VOL 'chmod u+r $B'"
  probe "(d) B: 자기 폴더 setfacl로 목록 조회 권한 부여" DENY "as_b $VOL 'setfacl -m u:$UID_B:rwx $B'"
fi

print_table
[ "$FAIL" -eq 0 ]
