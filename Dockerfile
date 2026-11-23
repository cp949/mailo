FROM node:24.20.0-alpine AS base
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
RUN chown -R node:node /repo
USER node
WORKDIR /repo/apps/mailo
EXPOSE 3000
CMD ["node", "dist/main.js"]
