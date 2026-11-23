#!/usr/bin/env bash
# NFS 검증 환경을 만든다: export 폴더, /etc/exports.d 조각, 호출처 폴더 권한, 클라이언트 mount 3개.
# 위험도: 중간(호스트에 NFS export를 추가하고 mount한다). 롤백: scripts/nfs/teardown.sh
#   - 만드는 것: ${MAILO_NFS_BASE}, /etc/exports.d/mailo-nfs-test.exports, ${MAILO_NFS_MNT}/{w,m1,m2} mount, nfsd 모듈 적재.
#   - 기존 /etc/exports는 건드리지 않는다. 다른 export가 있으면 `exportfs -ra`가 다시 읽을 뿐 바꾸지 않는다.
# 사용: scripts/nfs/setup.sh [mount 옵션 추가분]   (sudo -n이 되는 사용자로 실행. 비밀번호가 필요하면 중단한다)
# 전제: nfs-kernel-server 설치됨. 없으면 MAILO_NFS_INSTALL=1을 주어 apt로 설치한다(기본은 설치하지 않는다).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  if ! sudo -n true 2>/dev/null; then
    echo "sudo 불가: 비밀번호 없이 sudo를 쓸 수 없다. 중단한다." >&2
    exit 20
  fi
  # SUDO_UID가 Mailo UID 기본값이 되도록 sudo로 다시 실행한다.
  exec sudo -n --preserve-env=MAILO_NFS_BASE,MAILO_NFS_INSTALL,MAILO_NFS_FSID,MAILO_NFS_CALLER_A_UID,MAILO_NFS_CALLER_B_UID,MAILO_NFS_SHARE_GID,MAILO_NFS_MAILO_UID,MAILO_NFS_VERS "$0" "$@"
fi

# shellcheck source=lib.sh
. "$HERE/lib.sh"
extra_opts="${1:-}"

if ! command -v exportfs >/dev/null 2>&1; then
  if [ "${MAILO_NFS_INSTALL:-0}" = "1" ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y nfs-kernel-server
  else
    echo "nfs-kernel-server가 없다. MAILO_NFS_INSTALL=1로 설치하거나 직접 설치한다." >&2
    exit 21
  fi
fi
if ! command -v setfacl >/dev/null 2>&1; then
  echo "setfacl이 없다(acl 패키지). 설치 뒤 다시 실행한다." >&2
  exit 22
fi
if [ "$MAILO_NFS_MAILO_UID" = "0" ]; then
  echo "Mailo UID가 root다. non-root 사용자로 실행해야 권한 모델이 성립한다." >&2
  exit 23
fi

modprobe nfsd 2>/dev/null || true
# nfs-server 서비스가 없는 환경(컨테이너 등)을 위해 직접 nfsd를 띄우는 경로도 둔다.
if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
  systemctl start nfs-server
else
  mountpoint -q /proc/fs/nfsd || mount -t nfsd nfsd /proc/fs/nfsd
  rpc.nfsd 8
fi

# 사전 점검: 같은 BASE가 이미 mount돼 있으면 teardown을 먼저 하라고 알린다.
if grep -q " ${MAILO_NFS_MNT}/" /proc/mounts; then
  echo "이미 mount가 있다. scripts/nfs/teardown.sh를 먼저 실행한다." >&2
  exit 24
fi

mkdir -p "$MAILO_NFS_EXPORT/inbox" "$MAILO_NFS_MNT"
# inbox는 통과만 허용해 호출처가 다른 호출처 이름을 목록으로 볼 수 없게 한다.
chmod 755 "$MAILO_NFS_BASE" "$MAILO_NFS_EXPORT"
chmod 711 "$MAILO_NFS_EXPORT/inbox"

for c in $MAILO_NFS_ACL_CALLERS_A; do nfs_make_inbox "$c" "$MAILO_NFS_CALLER_A_UID" yes; done
for c in $MAILO_NFS_ACL_CALLERS_B; do nfs_make_inbox "$c" "$MAILO_NFS_CALLER_B_UID" yes; done
# 공용 그룹 + setgid 대안 모델(ACL 없음). 읽기 권한이 호출처 umask에 달려 있다.
nfs_make_inbox grp "$MAILO_NFS_CALLER_A_UID" no

mkdir -p /etc/exports.d
if [ -e "$MAILO_NFS_EXPORTS_FILE" ]; then
  echo "이미 $MAILO_NFS_EXPORTS_FILE 이 있다. teardown을 먼저 실행한다." >&2
  exit 25
fi
echo "${MAILO_NFS_EXPORT} ${MAILO_NFS_CLIENTS}(rw,sync,root_squash,no_subtree_check,fsid=${MAILO_NFS_FSID})" >"$MAILO_NFS_EXPORTS_FILE"
exportfs -ra

for name in w m1 m2; do
  "$HERE/mount.sh" "$name" "$extra_opts"
done
echo "준비 완료: export=$MAILO_NFS_EXPORT mounts=$MAILO_NFS_MNT/{w,m1,m2} mailoUid=$MAILO_NFS_MAILO_UID"
