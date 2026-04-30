#!/usr/bin/env sh
set -eu

ENV_FILE="${ENV_FILE:-.env}"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.12-debian}"
BASE_IMAGE="pouw-randomx-builder-base:local"
BUILDER_IMAGE="pouw-randomx-builder:local"
PACKAGE_DIR="${PACKAGE_DIR:-pkg-randomx.js-shared}"
NPM_REGISTRY="${NPM_REGISTRY:-http://host.docker.internal:8081/repository/npm-hosted/}"
LOAD_BASE_IMAGE=0
LOAD_BUILDER_IMAGE=0

for arg in "$@"; do
  case "$arg" in
    --env-file=*)
      ENV_FILE="${arg#*=}"
      ;;
    --registry=*)
      NPM_REGISTRY="${arg#*=}"
      ;;
    --package-dir=*)
      PACKAGE_DIR="${arg#*=}"
      ;;
    --bun-image=*)
      BUN_IMAGE="${arg#*=}"
      ;;
    --load-base-image)
      LOAD_BASE_IMAGE=1
      ;;
    --load-builder-image)
      LOAD_BUILDER_IMAGE=1
      ;;
    --*)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
    *)
      PACKAGE_DIR="$arg"
      ;;
  esac
done

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

ENV_FILE_PATH=""
case "$ENV_FILE" in
  /*)
    [ -f "$ENV_FILE" ] && ENV_FILE_PATH="$ENV_FILE"
    ;;
  *)
    if [ -f "$ENV_FILE" ]; then
      ENV_FILE_PATH="$PWD/$ENV_FILE"
    elif [ -f "$SCRIPT_DIR/$ENV_FILE" ]; then
      ENV_FILE_PATH="$SCRIPT_DIR/$ENV_FILE"
    fi
    ;;
esac

if [ -n "$ENV_FILE_PATH" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE_PATH"
  set +a
fi

NPM_REGISTRY="${NPM_REGISTRY:-http://host.docker.internal:8081/repository/npm-hosted/}"
NPM_REGISTRY="$(printf '%s' "$NPM_REGISTRY" | sed 's#/repositories/#/repository/#')"
NPM_REGISTRY="${NPM_REGISTRY%/}/"
NPM_TOKEN="${NPM_TOKEN:-${NPM_AUTH_TOKEN:-}}"
NPM_USERNAME="${NPM_USERNAME:-${NPM_USER:-}}"
NPM_PASSWORD="${NPM_PASSWORD:-${NPM_PASS:-}}"
NPM_EMAIL="${NPM_EMAIL:-}"
NPMRC_TMP=""

build_base_image() {
  docker buildx build \
    --build-arg BUN_IMAGE="$BUN_IMAGE" \
    --tag "${BASE_IMAGE}" \
    --load \
    -f randomx-builder-base.Dockerfile \
    .
}

cleanup_npmrc_secret() {
  if [ -n "$NPMRC_TMP" ] && [ -f "$NPMRC_TMP" ]; then
    rm -f "$NPMRC_TMP"
  fi
}

create_npmrc_secret() {
  NPMRC_TMP="$(mktemp 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/randomx-npmrc.$$")"
  : > "$NPMRC_TMP"
  trap cleanup_npmrc_secret EXIT INT TERM

  registry_host="$(printf '%s' "$NPM_REGISTRY" | sed -E 's#^https?://##')"
  registry_host="${registry_host%/}/"

  {
    printf 'registry=%s\n' "$NPM_REGISTRY"
    printf 'always-auth=true\n'
  } > "$NPMRC_TMP"

  if [ -n "$NPM_TOKEN" ]; then
    printf '//%s:_authToken=%s\n' "$registry_host" "$NPM_TOKEN" >> "$NPMRC_TMP"
  else
    auth_b64="$(printf '%s:%s' "$NPM_USERNAME" "$NPM_PASSWORD" | base64 | tr -d '\n')"
    printf '//%s:_auth=%s\n' "$registry_host" "$auth_b64" >> "$NPMRC_TMP"
    printf '//%s:username=%s\n' "$registry_host" "$NPM_USERNAME" >> "$NPMRC_TMP"
    if [ -n "$NPM_EMAIL" ]; then
      printf '//%s:email=%s\n' "$registry_host" "$NPM_EMAIL" >> "$NPMRC_TMP"
    fi
  fi
}

if [ "$LOAD_BASE_IMAGE" -eq 1 ]; then
  build_base_image
elif ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  echo "Base image '${BASE_IMAGE}' not found locally, building it now..."
  build_base_image
fi

if [ "$LOAD_BUILDER_IMAGE" -eq 1 ]; then
  docker buildx build \
    --build-arg BUILDER_BASE_IMAGE="$BASE_IMAGE" \
    --target randomx-builder-image \
    --tag "${BUILDER_IMAGE}" \
    --load \
    -f randomx-builder.Dockerfile \
    .
fi

if [ -z "$NPM_TOKEN" ] && { [ -z "$NPM_USERNAME" ] || [ -z "$NPM_PASSWORD" ]; }; then
  echo "Set NPM_TOKEN or NPM_USERNAME/NPM_PASSWORD in ${ENV_FILE} (or environment)." >&2
  exit 1
fi

create_npmrc_secret

docker buildx build \
  --build-arg BUILDER_BASE_IMAGE="$BASE_IMAGE" \
  --build-arg PACKAGE_DIR="$PACKAGE_DIR" \
  --build-arg NPM_REGISTRY="$NPM_REGISTRY" \
  --secret id=npmrc,src="$NPMRC_TMP" \
  --target npm-publish \
  -f randomx-builder.Dockerfile \
  .
