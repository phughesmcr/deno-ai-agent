#!/usr/bin/env bash
# Terminal 2: Silas agent only, connecting to an already-running broker, with OTEL.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/broker-env.sh
source "$ROOT/scripts/broker-env.sh"

wait_for_socket "$SILAS_BROKER_LISTEN_PATH" "broker" || exit 1
wait_for_socket "$SILAS_PERMISSION_CONTROL_PATH" "control" || exit 1

OTEL_ENV="$(mktemp "${TMPDIR:-/tmp}/silas-broker-otel-env.XXXXXX")"
cleanup() {
  rm -f "$OTEL_ENV"
}
trap cleanup EXIT INT TERM

if [[ -f .env ]]; then
  awk '
    /^[[:space:]]*(OTEL_DENO|OTEL_SERVICE_NAME)=/ { next }
    { print }
  ' .env > "$OTEL_ENV"
else
  : > "$OTEL_ENV"
fi

cat >> "$OTEL_ENV" <<'EOF'

OTEL_DENO=true
OTEL_SERVICE_NAME=deno-ai-agent
EOF

otel_env=()
for key in OTEL_DENO OTEL_SERVICE_NAME OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_PROTOCOL; do
  if [[ -n "${!key+x}" ]]; then
    otel_env+=("$key=${!key}")
  fi
done

echo "Starting Silas agent with permission broker + OTEL..."
echo "  broker:  $DENO_PERMISSION_BROKER_PATH"
echo "  control: $SILAS_PERMISSION_CONTROL_PATH"
echo "  otlp:    ${OTEL_EXPORTER_OTLP_ENDPOINT:-from .env or http://localhost:4318}"

env -i \
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
  "${otel_env[@]}" \
  deno run --unstable-kv --env-file="$OTEL_ENV" main.ts
