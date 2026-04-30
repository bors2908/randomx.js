ARG BUN_IMAGE=oven/bun:1.3.12-debian

FROM ${BUN_IMAGE} AS randomx-builder-base

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    clang \
    lld \
    binaryen \
    wabt \
    ca-certificates \
    nodejs \
    npm \
  && rm -rf /var/lib/apt/lists/*
