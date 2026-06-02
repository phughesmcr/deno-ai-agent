#!/usr/bin/env bash
# Terminal 1: permission broker daemon only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/broker-env.sh
source "$ROOT/scripts/broker-env.sh"

rm -f "$SILAS_BROKER_LISTEN_PATH" "$SILAS_PERMISSION_CONTROL_PATH"

echo "Starting permission broker..."
echo "  broker:  $SILAS_BROKER_LISTEN_PATH"
echo "  control: $SILAS_PERMISSION_CONTROL_PATH"
echo "In another terminal: deno task agent:broker:otel"
echo ""

unset DENO_PERMISSION_BROKER_PATH
exec deno task broker
