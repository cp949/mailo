#!/usr/bin/env bash
# 클라이언트 mount 하나를 (다시) 만든다. 옵션을 바꿔 가며 속성 캐시 동작을 비교할 때 쓴다.
# 사용: sudo scripts/nfs/mount.sh <w|m1|m2> [mount 옵션 추가분(쉼표 구분)]
# 기본 옵션: vers=${MAILO_NFS_VERS:-4.1},sec=sys,nosharecache. 추가분은 뒤에 붙는다. 추가분에 vers=를 주면 기본 버전을 대체한다.
# 위험도: 낮음(BASE 아래 mount만 바꾼다). 롤백: scripts/nfs/teardown.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
nfs_need_root

name="${1:?클라이언트 이름 필요(w|m1|m2)}"
extra="${2:-}"
addr="$(nfs_client_addr "$name")"
target="$MAILO_NFS_MNT/$name"
# 추가분에 vers=가 있으면 기본 버전(4.1)을 빼서 한 번만 지정되게 한다(mount.nfs4가 vers 중복을 거부한다).
case ",$extra," in
  *,vers=*|*,nfsvers=*) base="sec=sys,nosharecache" ;;
  *) base="vers=${MAILO_NFS_VERS},sec=sys,nosharecache" ;;
esac
opts="${base}${extra:+,$extra}"

if grep -q " $target " /proc/mounts; then
  umount "$target"
fi
mkdir -p "$target"
# 호스트 이름은 mount 시점의 UTS 이름공간에서 정해진다. 서로 다른 이름으로 mount해야 NFSv4.1 client id가 겹치지 않는다.
unshare --uts sh -c "hostname mailo-nfs-$name && mount -t nfs4 -o '$opts' '$addr:$MAILO_NFS_EXPORT' '$target'"
