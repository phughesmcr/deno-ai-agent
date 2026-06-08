#!/usr/bin/env bash
# Shared broker socket paths for the daemon and Silas agent.
# Reads only broker-related KEY=value pairs from .env; it never sources the file.
# Usage:
#   source scripts/broker-env.sh   # two terminals: broker, then agent
#   ./scripts/start-with-broker.sh # one terminal (sources this file)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SILAS_ENV_FILE="${SILAS_ENV_FILE:-$ROOT/.env}"

broker_env_value() {
  local key="$1"
  local line
  local value

  [[ -f "$SILAS_ENV_FILE" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    [[ "$line" == "$key="* ]] || continue

    value="${line#*=}"
    if [[ ${#value} -ge 2 && "$value" == \"* && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ ${#value} -ge 2 && "$value" == \'* && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf '%s' "$value"
    return 0
  done < "$SILAS_ENV_FILE"

  return 1
}

broker_env_or_default() {
  local key="$1"
  local default_value="$2"
  local value

  if [[ -n "${!key+x}" ]]; then
    printf '%s' "${!key}"
    return 0
  fi
  if value="$(broker_env_value "$key")"; then
    printf '%s' "$value"
    return 0
  fi
  printf '%s' "$default_value"
}

broker_path_default="$(broker_env_or_default "DENO_PERMISSION_BROKER_PATH" "/tmp/silas-perm.sock")"
export SILAS_BROKER_LISTEN_PATH
SILAS_BROKER_LISTEN_PATH="$(broker_env_or_default "SILAS_BROKER_LISTEN_PATH" "$broker_path_default")"
export SILAS_PERMISSION_CONTROL_PATH
SILAS_PERMISSION_CONTROL_PATH="$(broker_env_or_default "SILAS_PERMISSION_CONTROL_PATH" "/tmp/silas-perm-control.sock")"
export DENO_PERMISSION_BROKER_PATH="${DENO_PERMISSION_BROKER_PATH:-$SILAS_BROKER_LISTEN_PATH}"
export SILAS_PERMISSION_RUN_PROMPTS
SILAS_PERMISSION_RUN_PROMPTS="$(broker_env_or_default "SILAS_PERMISSION_RUN_PROMPTS" "1")"
export SILAS_PROJECT_ROOT
SILAS_PROJECT_ROOT="$(broker_env_or_default "SILAS_PROJECT_ROOT" "$ROOT")"

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
