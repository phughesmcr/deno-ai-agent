#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BROKER_SOCK="${SILAS_BROKER_LISTEN_PATH:-/tmp/silas-perm.sock}"
CONTROL_SOCK="${SILAS_PERMISSION_CONTROL_PATH:-/tmp/silas-perm-control.sock}"
export SILAS_BROKER_LISTEN_PATH="$BROKER_SOCK"
export SILAS_PERMISSION_CONTROL_PATH="$CONTROL_SOCK"
export DENO_PERMISSION_BROKER_PATH="$BROKER_SOCK"
export SILAS_PERMISSION_RUN_PROMPTS="${SILAS_PERMISSION_RUN_PROMPTS:-1}"
export SILAS_PROJECT_ROOT="${SILAS_PROJECT_ROOT:-$ROOT}"

rm -f "$BROKER_SOCK" "$CONTROL_SOCK"

# Daemon listens only; must not inherit DENO_PERMISSION_BROKER_PATH (Deno would connect as client).
env -u DENO_PERMISSION_BROKER_PATH deno task broker &
BROKER_PID=$!

cleanup() {
  kill "$BROKER_PID" 2>/dev/null || true
  wait "$BROKER_PID" 2>/dev/null || true
  rm -f "$BROKER_SOCK" "$CONTROL_SOCK"
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 50); do
  if [[ -S "$BROKER_SOCK" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -S "$BROKER_SOCK" ]]; then
  echo "permission broker socket did not appear: $BROKER_SOCK" >&2
  exit 1
fi

deno task start:broker
