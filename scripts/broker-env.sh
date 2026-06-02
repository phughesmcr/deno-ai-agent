#!/usr/bin/env bash
# Shared broker socket paths for the daemon and Silas agent.
# Usage:
#   source scripts/broker-env.sh   # two terminals: broker, then agent
#   ./scripts/start-with-broker.sh # one terminal (sources this file)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export SILAS_BROKER_LISTEN_PATH="${SILAS_BROKER_LISTEN_PATH:-/tmp/silas-perm.sock}"
export SILAS_PERMISSION_CONTROL_PATH="${SILAS_PERMISSION_CONTROL_PATH:-/tmp/silas-perm-control.sock}"
export DENO_PERMISSION_BROKER_PATH="${DENO_PERMISSION_BROKER_PATH:-$SILAS_BROKER_LISTEN_PATH}"
export SILAS_PERMISSION_RUN_PROMPTS="${SILAS_PERMISSION_RUN_PROMPTS:-1}"
export SILAS_PROJECT_ROOT="${SILAS_PROJECT_ROOT:-$ROOT}"

wait_for_socket() {
  local sock="$1"
  local label="$2"
  local attempts="${3:-50}"
  for _ in $(seq 1 "$attempts"); do
    if [[ -S "$sock" ]]; then
      return 0
    fi
    sleep 0.1
  done
  echo "Timed out waiting for $label socket: $sock" >&2
  return 1
}
