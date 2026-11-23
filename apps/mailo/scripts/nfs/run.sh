#!/usr/bin/env bash
# 환경 준비, NFS 테스트 실행, 정리를 한 번에 한다. CI와 로컬이 같은 경로를 쓴다.
# 위험도: 중간(setup.sh·teardown.sh와 같다: 호스트에 NFS export와 mount를 추가했다가 되돌린다).
# 롤백: 이 스크립트가 trap으로 teardown.sh를 부른다. 중간에 죽었으면 scripts/nfs/teardown.sh를 직접 실행한다.
# 사용: scripts/nfs/run.sh [jest 인자...]   예) scripts/nfs/run.sh -t "(g)"
# 전제: PostgreSQL이 떠 있어야 한다(`docker compose up -d postgres`). 비밀번호 없는 sudo가 필요하다(없으면 exit 20).
# CI에서는 MAILO_NFS_INSTALL=1을 주어 nfs-kernel-server를 설치한다. 이 설치는 teardown이 되돌리지 않는다.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"

"$HERE/setup.sh"
trap '"$HERE/teardown.sh"' EXIT
cd "$APP"
# 환경을 만든 뒤에는 건너뛰지 않고 실패하게 한다.
MAILO_NFS_REQUIRED=1 pnpm test:nfs "$@"
