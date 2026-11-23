#!/usr/bin/env bash
# NFS 검증 환경 공용 설정(RQ-002·024, ADR-0004 결정 10). 직접 실행하지 않고 다른 스크립트가 source한다.
# 환경 변수로 바꿀 수 있는 값은 모두 여기서 기본값을 정한다.

# 이 작업이 만든 것만 지우기 위해 모든 산출물을 BASE 아래와 /etc/exports.d/mailo-nfs-test.exports 한 파일에 둔다.
MAILO_NFS_BASE="${MAILO_NFS_BASE:-/srv/mailo-nfs-test}"
MAILO_NFS_EXPORT="${MAILO_NFS_BASE}/export"
MAILO_NFS_MNT="${MAILO_NFS_BASE}/mnt"
MAILO_NFS_EXPORTS_FILE="/etc/exports.d/mailo-nfs-test.exports"
# 한 export에 여러 클라이언트를 두려고 loopback 대역 전체를 허용한다. 외부 주소는 허용하지 않는다.
MAILO_NFS_CLIENTS="127.0.0.0/8"
MAILO_NFS_FSID="${MAILO_NFS_FSID:-4101}"
# 클라이언트 NFS 버전 기본값. 4.1(ADR-0004 결정)과 4.2를 비교하려고 바꿀 수 있게 한다.
MAILO_NFS_VERS="${MAILO_NFS_VERS:-4.1}"

# 호출처 UID 2개와 Mailo UID. Mailo UID는 테스트를 돌리는 사용자(root가 아니어야 한다).
MAILO_NFS_CALLER_A_UID="${MAILO_NFS_CALLER_A_UID:-2001}"
MAILO_NFS_CALLER_B_UID="${MAILO_NFS_CALLER_B_UID:-2002}"
MAILO_NFS_SHARE_GID="${MAILO_NFS_SHARE_GID:-2100}"
MAILO_NFS_MAILO_UID="${MAILO_NFS_MAILO_UID:-${SUDO_UID:-$(id -u)}}"

# 클라이언트 3개. 주소와 호스트 이름이 서로 달라야 커널이 별개 NFS 클라이언트(client id)로 다룬다.
# 같은 주소로 두 번 mount하면 클라이언트를 공유할 수 있어(추정, 확인하지 않았다) 주소와 이름을 나눈다.
#   w  = 호출처 쪽 클라이언트   m1 = Mailo 인스턴스 1   m2 = Mailo 인스턴스 2
nfs_client_addr() {
  case "$1" in
    w) echo 127.0.0.2 ;;
    m1) echo 127.0.0.1 ;;
    m2) echo 127.0.0.3 ;;
    *) echo "알 수 없는 클라이언트: $1 (w|m1|m2)" >&2; return 1 ;;
  esac
}

# 호출처 폴더(백업 경로 기준). alpha·beta·signed는 default ACL 모델(Mailo UID에 ACL), grp는 공용 그룹 + setgid 모델이다.
MAILO_NFS_ACL_CALLERS_A="alpha signed"
MAILO_NFS_ACL_CALLERS_B="beta"

nfs_need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "root 권한이 필요하다. sudo로 실행한다." >&2
    return 1
  fi
}

# 호출처 폴더를 만든다(백업 경로 기준, root 권한). 폴더 권한 모델은 docs/operations/nfs.md와 같다.
#   acl=yes(권장, 같은 호스트 볼륨 검증과 같은 모델): 폴더 소유자는 Mailo UID, 모드 0700, 호출처 UID에 폴더 `-wx` ACL.
#     새 파일에는 default ACL로 Mailo UID `rw-`가 붙는다. 호출처는 폴더 권한을 바꿀 수 없고 호출처 umask에 읽기가 달리지 않는다(NFSv4.2 클라이언트 한정).
#   acl=no(대안): 폴더 소유자는 호출처, 그룹은 공용 그룹, 모드 2370(setgid). 읽기는 호출처 umask의 그룹 비트에 달렸다.
# 사용: nfs_make_inbox <폴더 이름> <호출처 UID> <acl: yes|no>
nfs_make_inbox() {
  local dir="$MAILO_NFS_EXPORT/inbox/$1"
  mkdir -p "$dir"
  if [ "$3" = "yes" ]; then
    chown "${MAILO_NFS_MAILO_UID}:${MAILO_NFS_SHARE_GID}" "$dir"
    chmod 0700 "$dir"
    setfacl -m "u:${2}:-wx" "$dir"
    setfacl -d -m "u::rw-,u:${MAILO_NFS_MAILO_UID}:rw-,g::---,m::rw-,o::---" "$dir"
  else
    chown "$2:$MAILO_NFS_SHARE_GID" "$dir"
    chmod 2370 "$dir"
  fi
}
