#!/usr/bin/env bash
# One terminal: broker (background) + Silas with OTEL.
# If the broker already runs elsewhere, use: deno task agent:broker:otel
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/broker-env.sh
source "$ROOT/scripts/broker-env.sh"

rm -f "$SILAS_BROKER_LISTEN_PATH" "$SILAS_PERMISSION_CONTROL_PATH"

echo "Starting permission broker (background)..."
env -u DENO_PERMISSION_BROKER_PATH deno task broker &
BROKER_PID=$!

cleanup() {
  kill "$BROKER_PID" 2>/dev/null || true
  wait "$BROKER_PID" 2>/dev/null || true
  rm -f "$SILAS_BROKER_LISTEN_PATH" "$SILAS_PERMISSION_CONTROL_PATH"
}
trap cleanup EXIT INT TERM

wait_for_socket "$SILAS_BROKER_LISTEN_PATH" "broker" || exit 1
wait_for_socket "$SILAS_PERMISSION_CONTROL_PATH" "control" || exit 1

echo "Broker ready (pid $BROKER_PID). Starting Silas with OTEL..."
deno task agent:broker:otel
