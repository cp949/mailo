#!/usr/bin/env bash
# 환경 준비, NFS 테스트 실행, 정리를 한 번에 한다. CI와 로컬이 같은 경로를 쓴다.
# 위험도: 중간(setup.sh·teardown.sh와 같다: 호스트에 NFS export와 mount를 추가했다가 되돌린다).
# 롤백: 이 스크립트가 trap으로 teardown.sh를 부른다. 중간에 죽었으면 scripts/nfs/teardown.sh를 직접 실행한다.
# 사용: scripts/nfs/run.sh [jest 인자...]   예) scripts/nfs/run.sh -t "(g)"
# 전제: PostgreSQL이 떠 있어야 한다(`docker compose up -d postgres`). 비밀번호 없는 sudo가 필요하다(없으면 exit 20).
# CI에서는 MAILO_NFS_INSTALL=1을 주어 nfs-kernel-server를 설치한다. 이 설치는 teardown이 되돌리지 않는다.
# 테스트 전체 시간 상한은 MAILO_NFS_RUN_TIMEOUT(초, 기본 1200)이다. 넘기면 테스트를 끝내고 teardown을 한 뒤 종료 코드 124로 끝난다.
#   CI nfs 잡 timeout-minutes(30)·단계 timeout-minutes(25)보다 짧아야 teardown까지 마친다.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"

"$HERE/setup.sh"
trap '"$HERE/teardown.sh"' EXIT
cd "$APP"
# 환경을 만든 뒤에는 건너뛰지 않고 실패하게 한다.
# timeout은 프로세스 그룹 전체에 TERM을 보내고, 30초 뒤에도 남은 프로세스는 KILL한다.
# set -e 아래에서 비정상 종료는 곧바로 스크립트를 끝내고 EXIT trap이 teardown을 실행한다.
status=0
MAILO_NFS_REQUIRED=1 timeout --kill-after=30 "${MAILO_NFS_RUN_TIMEOUT:-1200}" pnpm test:nfs "$@" || status=$?
if [ "$status" -eq 124 ]; then
  echo "NFS 테스트가 ${MAILO_NFS_RUN_TIMEOUT:-1200}초 안에 끝나지 않아 중단했다(MAILO_NFS_RUN_TIMEOUT)." >&2
fi
exit "$status"
