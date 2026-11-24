#!/usr/bin/env bash
# 작업 트리의 내용 기반 소스 지문을 출력한다. 검증 결과를 다시 쓸 수 있는지(입력이 같은지) 판단하는 데 쓴다.
# 현재 디렉터리가 속한 git 저장소를 대상으로 한다. 규칙은 docs/agents/verification.md의 "소스·환경 지문"이다.
# - 대상: `git ls-files --cached --others --exclude-standard` 중 작업 트리에 있는 일반 파일. 삭제된 추적 파일은 건너뛴다.
# - 입력: 파일 경로와 내용의 SHA-256. HEAD SHA, 브랜치, 커밋 시각, 스테이징 여부는 입력이 아니다.
# - .gitignore로 제외된 파일(node_modules/, dist/, 작업 폴더, .env 등)은 영향이 없다.
# - GNU coreutils(comm -z, sort -z, sha256sum)가 필요하다.
set -euo pipefail

usage() {
  cat >&2 <<'EOF_USAGE'
Usage: scripts/source-fingerprint.sh [--env]

출력(한 줄씩):
  source=<12자> files=<파일 수>   작업 트리 내용 지문
  env=<12자>                      --env일 때만. node --version, pnpm --version,
                                  MAILO_TEST_DATABASE_URL(비밀번호를 지운 값)의 해시.
                                  비밀번호는 입력에도 출력에도 넣지 않는다.
EOF_USAGE
  exit 2
}

WITH_ENV=false
case $# in
  0) ;;
  1) [[ $1 == --env ]] && WITH_ENV=true || usage ;;
  *) usage ;;
esac

# fsmonitor가 변경을 숨기지 않게 끈다.
git_cmd() { git -c core.fsmonitor=false "$@"; }

ROOT=$(git_cmd rev-parse --show-toplevel)
cd "$ROOT"

# 추적 파일과 untracked 파일에서 삭제된 추적 파일을 뺀 목록(NUL 구분)이다. 일반 파일만 남긴다.
list_files() {
  local file
  comm -z -23 \
    <(git_cmd ls-files -z --cached --others --exclude-standard | LC_ALL=C sort -zu) \
    <(git_cmd ls-files -z --deleted | LC_ALL=C sort -zu) |
    while IFS= read -r -d '' file; do
      # `[[ ]] && …`로 쓰면 마지막 항목이 일반 파일이 아닐 때 루프가 1을 반환해 pipefail로 끝난다.
      if [[ -f $file ]]; then printf '%s\0' "$file"; fi
    done
}

short_hash() { sha256sum | cut -c1-12; }

# DB URL에서 비밀번호를 지운다. 해시 입력에도 비밀번호를 넣지 않기 위해서다(RQ-027).
# - userinfo는 쿼리 앞 마지막 `@`까지로 본다. 인코딩하지 않은 `@`가 비밀번호에 있어도 지운다.
# - userinfo는 사용자 이름만 남긴다.
# - `password=` 쿼리 값은 지운다.
mask_db_url() {
  local url=$1 query="" head rest userinfo
  if [[ $url == *\?* ]]; then
    query="?${url#*\?}"
    url=${url%%\?*}
  fi
  if [[ $url == *://*@* ]]; then
    head=${url%%://*}
    rest=${url#*://}
    userinfo=${rest%@*}
    url="${head}://${userinfo%%:*}@${rest##*@}"
  fi
  query=$(printf '%s' "$query" | sed -E 's/([?&])password=[^&#]*/\1password=/g')
  printf '%s%s' "$url" "$query"
}

# "<해시>  <경로>" 줄을 C 로캘로 정렬한 목록이다. 줄 수가 파일 수다.
entries=$(list_files | xargs -0 -r sha256sum | LC_ALL=C sort)
files=0
[[ -z $entries ]] || files=$(printf '%s\n' "$entries" | wc -l)
echo "source=$(printf '%s\n' "$entries" | short_hash) files=$files"

if $WITH_ENV; then
  node_line=$(node --version 2>/dev/null || true)
  pnpm_line=$(pnpm --version 2>/dev/null || true)
  db_url="<unset>"
  if [[ -n ${MAILO_TEST_DATABASE_URL+x} ]]; then
    db_url=$(mask_db_url "$MAILO_TEST_DATABASE_URL")
  fi
  {
    printf 'node=%s\n' "${node_line:-unknown}"
    printf 'pnpm=%s\n' "${pnpm_line:-unknown}"
    printf 'MAILO_TEST_DATABASE_URL=%s\n' "$db_url"
  } | { printf 'env=%s\n' "$(short_hash)"; }
fi
