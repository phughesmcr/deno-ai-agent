#!/usr/bin/env bash
# Terminal 2: Silas agent only, connecting to an already-running broker, with OTEL.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/broker-env.sh
source "$ROOT/scripts/broker-env.sh"

wait_for_socket "$SILAS_BROKER_LISTEN_PATH" "broker" || exit 1
wait_for_socket "$SILAS_PERMISSION_CONTROL_PATH" "control" || exit 1

if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi
export OTEL_DENO="${OTEL_DENO:-true}"
export OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-deno-ai-agent}"

echo "Starting Silas agent with permission broker + OTEL..."
echo "  broker:  $DENO_PERMISSION_BROKER_PATH"
echo "  control: $SILAS_PERMISSION_CONTROL_PATH"
echo "  otlp:    ${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}"

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
  OTEL_DENO="$OTEL_DENO" \
  OTEL_SERVICE_NAME="$OTEL_SERVICE_NAME" \
  deno run -A --unstable-kv --env-file=.env main.ts
