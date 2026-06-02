#!/usr/bin/env bash
# Terminal 2: Silas agent only, connecting to an already-running broker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/broker-env.sh
source "$ROOT/scripts/broker-env.sh"

wait_for_socket "$SILAS_BROKER_LISTEN_PATH" "broker" || exit 1
wait_for_socket "$SILAS_PERMISSION_CONTROL_PATH" "control" || exit 1

echo "Starting Silas agent with permission broker..."
echo "  broker:  $DENO_PERMISSION_BROKER_PATH"
echo "  control: $SILAS_PERMISSION_CONTROL_PATH"

exec env -i \
  PATH="${PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin}" \
  HOME="${HOME:-}" \
  USER="${USER:-}" \
  SHELL="${SHELL:-/bin/zsh}" \
  TERM="${TERM:-dumb}" \
  TMPDIR="${TMPDIR:-/tmp}" \
  SILAS_BROKER_LISTEN_PATH="$SILAS_BROKER_LISTEN_PATH" \
  SILAS_PERMISSION_CONTROL_PATH="$SILAS_PERMISSION_CONTROL_PATH" \
  DENO_PERMISSION_BROKER_PATH="$DENO_PERMISSION_BROKER_PATH" \
  SILAS_PERMISSION_RUN_PROMPTS="$SILAS_PERMISSION_RUN_PROMPTS" \
  SILAS_PROJECT_ROOT="$SILAS_PROJECT_ROOT" \
  deno run -A --unstable-kv --env-file=.env main.ts
