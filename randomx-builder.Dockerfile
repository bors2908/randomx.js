# syntax=docker/dockerfile:1.7
ARG BUILDER_BASE_IMAGE=pouw-randomx-builder-base:local

FROM ${BUILDER_BASE_IMAGE} AS randomx-builder
WORKDIR /workspace

COPY . .

RUN bun install --frozen-lockfile
RUN bun run scripts/build.ts

FROM randomx-builder AS npm-publish

ARG PACKAGE_DIR=pkg-randomx.js-shared
ARG NPM_REGISTRY=http://host.docker.internal:9001/repository/npm-hosted/

RUN --mount=type=secret,id=npmrc,target=/run/secrets/npmrc,required=true set -eux; \
    cd "/workspace/${PACKAGE_DIR}"; \
    npm pkg set "publishConfig.registry=${NPM_REGISTRY}"; \
    npm publish --registry "${NPM_REGISTRY}" --userconfig /run/secrets/npmrc

FROM scratch AS randomx-builder-image
COPY --from=randomx-builder /workspace/pkg-randomx.js-shared/ /pkg-randomx.js-shared/
