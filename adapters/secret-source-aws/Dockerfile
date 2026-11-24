# Mailo 기준 이미지에 AWS Secrets Manager 어댑터를 얹는 변형 이미지(ADR-0016 결정 4). 빌드 컨텍스트는 이 폴더다.
#   docker build --build-arg MAILO_BASE_IMAGE=<기준 이미지> -t <태그> adapters/secret-source-aws
# 기준 이미지는 기본값이 없다. 지정하지 않으면 빌드가 실패한다. 릴리스는 같은 릴리스 커밋의 기본 이미지를
# digest(`ghcr.io/cp949/mailo@sha256:<digest>`)로 지정한다. 로컬·CI는 방금 만든 로컬 태그를 쓴다.
# 기본 이미지에는 어댑터와 SDK가 없다. 이 파일을 쓰는 변형 이미지에만 들어간다.
ARG MAILO_BASE_IMAGE

# base는 루트 Dockerfile과 같은 digest다. 루트 Dockerfile의 digest를 갱신하면 이 줄도 함께 바꾼다
# (apps/mailo/test/config/adapter-image.spec.ts가 두 파일의 digest 일치를 검사한다).
FROM node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS adapter
RUN corepack enable
WORKDIR /opt/mailo-secret-source-aws
# pnpm 버전은 package.json의 packageManager(sha512 해시)가 고정한다. 의존성은 lockfile대로만 설치한다.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY index.js README.md ./

FROM ${MAILO_BASE_IMAGE} AS runtime
# 기준 이미지의 USER node를 이 단계에서만 root로 바꾼다. /repo와 /opt는 root 소유 읽기 전용으로 유지한다.
USER root
COPY --from=adapter /opt/mailo-secret-source-aws /opt/mailo-secret-source-aws
# 로더가 apps/mailo의 node_modules에서 bare 패키지 이름으로 찾는다. 링크의 실제 경로(/opt/...)에서 Node 모듈 해석이
# 위로 올라가며 /opt/mailo-secret-source-aws/node_modules(AWS SDK)를 찾는다. 파일 소유자는 root다.
RUN mkdir -p /repo/apps/mailo/node_modules/@cp949 \
  && ln -s /opt/mailo-secret-source-aws /repo/apps/mailo/node_modules/@cp949/mailo-secret-source-aws
USER node
