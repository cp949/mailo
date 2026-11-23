# 태그 대신 다중 아키텍처 index digest로 고정한다(태그는 옮겨질 수 있다). 2026-11-23에 조회한 값이다.
# 갱신: `docker buildx imagetools inspect node:<버전>-alpine`의 Digest로 바꾸고 .github/workflows/ci.yml의 NODE_VERSION도 맞춘다
# (Renovate나 Dependabot을 쓰면 digest를 자동 갱신한다). pnpm은 package.json의 packageManager가 sha512 해시로 고정한다.
FROM node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY apps/mailo/package.json apps/mailo/
RUN pnpm install --frozen-lockfile
COPY apps ./apps
RUN pnpm --filter @cp949/mailo build

FROM base AS runtime
ENV NODE_ENV=production
# 런타임은 corepack의 pnpm만 쓴다. 쓰지 않는 번들 npm·yarn은 이미지에서 지운다.
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/mailo/package.json apps/mailo/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /repo/apps/mailo/dist apps/mailo/dist
COPY apps/mailo/migrations apps/mailo/migrations
# SMTP 인증 정보와 암호화 키는 이미지에 넣지 않는다. 환경 변수나 시크릿 마운트로 받는다.
# /repo 전체가 root 소유(읽기 전용)다. node는 읽고 실행만 하고 dist·node_modules·migrations를 바꿀 수 없다.
# 런타임이 쓰는 경로는 없다(파일 채널·시크릿은 마운트, 임시 파일은 /tmp). `chown -R`은 레이어를 한 벌 더 만들어 뺐다.
USER node
WORKDIR /repo/apps/mailo
EXPOSE 3000
CMD ["node", "dist/main.js"]
