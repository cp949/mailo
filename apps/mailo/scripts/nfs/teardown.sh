#!/usr/bin/env bash
# setup.sh가 만든 것만 되돌린다: mount 3개, exports 조각, export 폴더. 설치한 패키지와 nfsd 모듈은 남긴다.
# 위험도: 중간(BASE 아래를 rm -rf 한다). 롤백: 불가(테스트 데이터만 지운다). BASE 경로가 비었거나 /이면 중단한다.
# 사용: scripts/nfs/teardown.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  sudo -n true 2>/dev/null || { echo "sudo 불가" >&2; exit 20; }
  exec sudo -n --preserve-env=MAILO_NFS_BASE "$0" "$@"
fi
# shellcheck source=lib.sh
. "$HERE/lib.sh"

case "$MAILO_NFS_BASE" in
  ""|"/"|"/srv"|"/home"|"/tmp"|"/var") echo "MAILO_NFS_BASE가 위험한 값이다: '$MAILO_NFS_BASE'" >&2; exit 30 ;;
esac

for name in w m1 m2; do
  target="$MAILO_NFS_MNT/$name"
  if grep -q " $target " /proc/mounts; then
    umount "$target" || umount -l "$target"
  fi
done
rm -f "$MAILO_NFS_EXPORTS_FILE"
rmdir /etc/exports.d 2>/dev/null || true
exportfs -ra 2>/dev/null || true
if ! grep -q " $MAILO_NFS_BASE/" /proc/mounts; then
  rm -rf --one-file-system "$MAILO_NFS_BASE"
fi
echo "정리 완료"
