#!/usr/bin/env bash
# 통합 테스트용 database를 worktree·에이전트별로 만들고 지운다.
# 같은 PostgreSQL 서버 안에서 database를 나누면 DB 전체에 걸리는 advisory lock이 갈라져
# 통합 테스트(`pnpm test:integration`)를 동시에 실행해도 서로 영향을 주지 않는다.
# 근거와 규칙은 docs/agents/verification.md의 "통합 테스트 동시 실행"이다.
#
# 접속 정보는 MAILO_TEST_DATABASE_URL(없으면 compose 개발 값)에서 가져오고 database 이름만 바꾼다.
# 접속 사용자에게 CREATEDB 권한이 필요하다(compose의 mailo 사용자는 가진다).
# 이 스크립트는 이름이 `mailo_test_`로 시작하는 database만 만들고 지운다. 개발 DB(`mailo`)는 건드리지 않는다.
set -euo pipefail

DEFAULT_URL="postgres://mailo:mailo-dev-password@localhost:5432/mailo"
PREFIX="mailo_test_"

usage() {
  cat >&2 <<'EOF_USAGE'
Usage: scripts/test-db.sh <create|url|drop|list|name> [이름]

  create [이름]   database를 만들고(이미 있으면 그대로 둔다) 접속 URL을 stdout에 출력한다.
  url [이름]      만들지 않고 접속 URL만 출력한다.
  drop [이름]     database를 지운다. 접속 중인 세션은 끊는다. 없으면 아무것도 하지 않는다.
  list            mailo_test_ database 목록을 출력한다.
  name            이름을 생략했을 때 쓰는 기본 이름을 출력한다.

이름은 `mailo_test_` 뒤에 소문자·숫자·밑줄만 쓴다(전체 63자 이하).
생략하면 현재 git 작업 폴더 이름에서 만든다(예: mailo-test-db-isolation → mailo_test_test_db_isolation).

사용 예(작업 폴더에서):
  export MAILO_TEST_DATABASE_URL=$(scripts/test-db.sh create)
  pnpm test:integration
  scripts/test-db.sh drop
EOF_USAGE
  exit 2
}

base_url=${MAILO_TEST_DATABASE_URL:-$DEFAULT_URL}
# 쿼리 문자열(?sslmode=... 등)은 그대로 이어 붙인다.
without_query=${base_url%%\?*}
query=${base_url#"$without_query"}
if [[ ! $without_query =~ ^[a-z]+://[^/]+/[^/]+$ ]]; then
  echo "MAILO_TEST_DATABASE_URL 형식이 scheme://사용자:비밀번호@호스트:포트/database가 아니다." >&2
  exit 1
fi
url_prefix=${without_query%/*}

default_name() {
  local top slug
  top=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  slug=$(basename "$top" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '_')
  slug=${slug#mailo_}
  slug=${slug:-main}
  printf '%s%s' "$PREFIX" "${slug:0:$((63 - ${#PREFIX}))}"
}

resolve_name() {
  local name=${1:-$(default_name)}
  if [[ ! $name =~ ^${PREFIX}[a-z0-9_]+$ ]] || ((${#name} > 63)); then
    echo "database 이름은 ${PREFIX}[a-z0-9_]+ 형식이고 63자 이하여야 한다: $name" >&2
    exit 1
  fi
  printf '%s' "$name"
}

# 관리 접속은 항상 postgres database로 한다. 대상 database가 아직 없어도 동작한다.
admin() {
  psql "${url_prefix}/postgres${query}" -v ON_ERROR_STOP=1 -X -At -q "$@"
}

[[ $# -ge 1 ]] || usage
cmd=$1
case $cmd in
  create)
    name=$(resolve_name "${2:-}")
    exists=$(admin -c "SELECT 1 FROM pg_database WHERE datname = '$name'")
    [[ -n $exists ]] || admin -c "CREATE DATABASE \"$name\""
    printf '%s/%s%s\n' "$url_prefix" "$name" "$query"
    ;;
  url)
    name=$(resolve_name "${2:-}")
    printf '%s/%s%s\n' "$url_prefix" "$name" "$query"
    ;;
  drop)
    name=$(resolve_name "${2:-}")
    admin -c "DROP DATABASE IF EXISTS \"$name\" WITH (FORCE)"
    ;;
  list)
    admin -c "SELECT datname FROM pg_database WHERE datname LIKE '${PREFIX}%' ORDER BY 1"
    ;;
  name)
    resolve_name "${2:-}"
    echo
    ;;
  *) usage ;;
esac
