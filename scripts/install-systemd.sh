#!/usr/bin/env bash
# Installs Silas systemd units for a long-running Ubuntu host.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="${SERVICE_DIR:-/etc/systemd/system}"
SILAS_USER="${SILAS_USER:-silas}"
SILAS_GROUP="${SILAS_GROUP:-$SILAS_USER}"
SILAS_HOME="${SILAS_HOME:-/home/$SILAS_USER}"
SILAS_ROOT="${SILAS_ROOT:-/opt/silas}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root, for example: sudo SILAS_ROOT=$SILAS_ROOT $0" >&2
  exit 1
fi

if [[ "$ROOT" != "$SILAS_ROOT" ]]; then
  echo "This installer only installs units. Copy or clone the repo to $SILAS_ROOT before enabling services." >&2
  echo "Current repo: $ROOT" >&2
  exit 1
fi

if ! getent group "$SILAS_GROUP" >/dev/null 2>&1; then
  groupadd --system "$SILAS_GROUP"
fi

if ! id "$SILAS_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$SILAS_HOME" --shell /bin/bash --gid "$SILAS_GROUP" "$SILAS_USER"
fi

if [[ ! -f "$SILAS_ROOT/.env" ]]; then
  echo "Missing $SILAS_ROOT/.env" >&2
  exit 1
fi

if [[ ! -x "$SILAS_HOME/.deno/bin/deno" ]]; then
  echo "Missing Deno at $SILAS_HOME/.deno/bin/deno" >&2
  echo "Install Deno for the $SILAS_USER user before enabling services." >&2
  exit 1
fi

sed_escape() {
  printf '%s' "$1" | sed 's/[\/&]/\\&/g'
}

install_unit() {
  local source="$1"
  local target="$2"
  local escaped_user
  local escaped_group
  local escaped_home
  local escaped_root

  escaped_user="$(sed_escape "$SILAS_USER")"
  escaped_group="$(sed_escape "$SILAS_GROUP")"
  escaped_home="$(sed_escape "$SILAS_HOME")"
  escaped_root="$(sed_escape "$SILAS_ROOT")"

  sed \
    -e "s/User=silas/User=$escaped_user/" \
    -e "s/Group=silas/Group=$escaped_group/" \
    -e "s/Environment=HOME=\\/home\\/silas/Environment=HOME=$escaped_home/" \
    -e "s/Environment=USER=silas/Environment=USER=$escaped_user/" \
    -e "s/WorkingDirectory=\\/opt\\/silas/WorkingDirectory=$escaped_root/" \
    -e "s#Environment=PATH=/home/silas/.deno/bin:#Environment=PATH=$escaped_home/.deno/bin:#" \
    -e "s/EnvironmentFile=\\/opt\\/silas\\/.env/EnvironmentFile=$escaped_root\\/\\.env/" \
    -e "s/ExecStart=\\/opt\\/silas\\//ExecStart=$escaped_root\\//" \
    "$source" > "$target"
  chmod 0644 "$target"
}

install_unit "$ROOT/deploy/systemd/silas-broker.service" "$SERVICE_DIR/silas-broker.service"
install_unit "$ROOT/deploy/systemd/silas-agent.service" "$SERVICE_DIR/silas-agent.service"

chown -R "$SILAS_USER:$SILAS_GROUP" "$SILAS_ROOT"

systemctl daemon-reload
systemctl enable silas-broker.service silas-agent.service

cat <<EOF
Installed systemd services:
  silas-broker.service
  silas-agent.service

Start:
  sudo systemctl start silas-broker.service silas-agent.service

Status:
  systemctl status silas-broker.service silas-agent.service

Logs:
  journalctl -u silas-agent -f
  journalctl -u silas-broker -f
EOF
