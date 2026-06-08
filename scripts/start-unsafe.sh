#!/usr/bin/env bash
# Direct broad-permission Silas startup for debugging without the permission broker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SAFE_ENV="$(mktemp "${TMPDIR:-/tmp}/silas-unsafe-env.XXXXXX")"
cleanup() {
  rm -f "$SAFE_ENV"
}
trap cleanup EXIT INT TERM

if [[ -f .env ]]; then
  awk '
    /^[[:space:]]*(#|$)/ { print; next }
    /^[[:space:]]*(DENO_PERMISSION_BROKER_PATH|SILAS_BROKER_LISTEN_PATH|SILAS_PERMISSION_CONTROL_PATH)=/ { next }
    { print }
  ' .env > "$SAFE_ENV"
else
  : > "$SAFE_ENV"
fi

exec deno run \
  --unstable-kv \
  --env-file="$SAFE_ENV" \
  --allow-read \
  --allow-write \
  --allow-run \
  --allow-net \
  --allow-env \
  main.ts
