#!/usr/bin/env bash
# 호출처 폴더를 export 쪽(서버 백업 경로)에서 만들거나 지운다. 운영자가 새 호출처를 추가하는 상황을 흉내 낸다.
# 위험도: 낮음(BASE 아래 폴더만). 롤백: remove 또는 teardown.sh
# 사용: scripts/nfs/inbox.sh create <이름> <A|B> [acl|noacl]   /   scripts/nfs/inbox.sh remove <이름>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$(id -u)" -ne 0 ]; then
  sudo -n true 2>/dev/null || { echo "sudo 불가" >&2; exit 20; }
  exec sudo -n --preserve-env=MAILO_NFS_BASE,MAILO_NFS_CALLER_A_UID,MAILO_NFS_CALLER_B_UID,MAILO_NFS_SHARE_GID,MAILO_NFS_MAILO_UID "$0" "$@"
fi
# shellcheck source=lib.sh
. "$HERE/lib.sh"
case "${1:-}" in
  create)
    name="${2:?이름 필요}"; who="${3:?A|B 필요}"; mode="${4:-acl}"
    case "$who" in A) uid="$MAILO_NFS_CALLER_A_UID" ;; B) uid="$MAILO_NFS_CALLER_B_UID" ;; *) echo "A|B" >&2; exit 2 ;; esac
    case "$name" in */*|.*|"") echo "잘못된 이름" >&2; exit 2 ;; esac
    nfs_make_inbox "$name" "$uid" "$([ "$mode" = acl ] && echo yes || echo no)"
    ;;
  remove)
    name="${2:?이름 필요}"
    case "$name" in */*|.*|"") echo "잘못된 이름" >&2; exit 2 ;; esac
    rm -rf --one-file-system "$MAILO_NFS_EXPORT/inbox/$name"
    ;;
  *) echo "사용: inbox.sh create <이름> <A|B> [acl|noacl] | remove <이름>" >&2; exit 2 ;;
esac
