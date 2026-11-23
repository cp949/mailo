#!/bin/sh
# 파일 채널 볼륨 초기화(ADR-0004 결정 8 "구현 중 확정" 13~19). root로 한 번 실행하는 일회용 단계다.
# Mailo 코드는 폴더를 만들거나 chmod하지 않으므로 호스트·init 컨테이너가 이 스크립트로 구성한다.
# 사용: init-volume.sh <acl|group> <루트 경로>
# 환경: MAILO_UID, MAILO_GID, SHARED_GID(group 방식의 공용 그룹), CALLERS="이름:UID 이름:UID ..."
# 여러 번 실행해도 같은 결과가 된다(멱등).
set -eu

MODE="${1:?방식(acl|group) 필요}"
ROOT="${2:?루트 경로 필요}"
: "${MAILO_UID:?}" "${MAILO_GID:?}" "${CALLERS:?}"

mkdir -p "$ROOT/inbox"
# 루트와 inbox는 모든 계정이 통과(x)만 할 수 있다. inbox는 목록도 볼 수 없다(다른 호출처 이름을 숨긴다).
chown 0:0 "$ROOT" "$ROOT/inbox"
chmod 0755 "$ROOT"
chmod 0711 "$ROOT/inbox"

for entry in $CALLERS; do
  name="${entry%%:*}"
  uid="${entry##*:}"
  dir="$ROOT/inbox/$name"
  mkdir -p "$dir"
  case "$MODE" in
    acl)
      # 폴더 소유자는 Mailo다. 호출처는 소유자가 아니므로 chmod·setfacl로 권한을 바꿀 수 없다.
      # 호출처는 ACL로만 쓰기·통과(-wx)를 받고 목록(r)은 받지 못한다.
      # default ACL은 새 파일에 Mailo 읽기·쓰기(rw-)를 상속시키고 호출처 umask를 무시한다.
      chown "$MAILO_UID:$MAILO_GID" "$dir"
      chmod 0700 "$dir"
      setfacl -b "$dir"
      setfacl -m "u:$uid:-wx" "$dir"
      setfacl -d -m "u::rw-,u:$MAILO_UID:rw-,g::---,m::rw-,o::---" "$dir"
      ;;
    group)
      # 폴더 소유자는 호출처(-wx), 그룹은 공용 그룹(rwx, Mailo만 속함), 그 밖은 접근 불가다.
      # setgid가 새 파일의 그룹을 공용 그룹으로 만든다. Mailo의 읽기는 파일 그룹 비트(호출처 umask)에 달려 있다.
      : "${SHARED_GID:?group 방식은 SHARED_GID 필요}"
      chown "$uid:$SHARED_GID" "$dir"
      chmod 2370 "$dir"
      ;;
    *) echo "알 수 없는 방식: $MODE" >&2; exit 2 ;;
  esac
done
echo "볼륨 초기화 완료: mode=$MODE root=$ROOT callers=$CALLERS"
