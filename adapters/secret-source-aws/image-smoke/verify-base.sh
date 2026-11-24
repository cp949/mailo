#!/usr/bin/env bash
# 기본(기준) 이미지에 어댑터 패키지와 AWS SDK가 없음을 확인한다(RQ-029 수용 조건, ADR-0016 결정 4).
# 사용법: verify-base.sh <기본 이미지>
# 이미지 파일시스템 전체에서 어댑터·@aws-sdk·@smithy(SDK 의존성)·@cp949/mailo-secret-source 이름을 찾는다. 하나라도 있으면 실패한다.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf '사용법: %s <기본 이미지>\n' "$0" >&2
  exit 2
fi
readonly image="$1"

# 이미지 루트 파일시스템만 본다(-xdev). 스크립트 자신이 이름을 담지 않도록 find 인자만 쓴다.
# --user root: 읽기만 한다. non-root로 돌면 /root 등에서 권한 오류가 나 find 종료 코드를 믿을 수 없다.
found="$(docker run --rm --pull never --network none --user root --entrypoint find "$image" / -xdev \
  \( -name '@aws-sdk*' -o -name '@smithy*' -o -name '*mailo-secret-source*' -o -name 'aws-sdk*' \) -print)"
if [[ -n "$found" ]]; then
  printf '기본 이미지 %s에 어댑터·SDK 경로가 있다(앞 10줄):\n%s\n' "$image" "$(head -10 <<<"$found")" >&2
  exit 1
fi

# find가 실제로 동작하는지 대조한다(빈 출력이 find 실패가 아님을 보인다).
docker run --rm --pull never --network none --entrypoint sh "$image" -c 'test -f /repo/apps/mailo/dist/secrets/index.js && find /repo -maxdepth 2 -name node_modules | grep -q .'
printf '기본 이미지 %s: 어댑터·@aws-sdk·@smithy 경로 없음\n' "$image"
