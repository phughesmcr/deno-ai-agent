#!/usr/bin/env bash
# Downloads otelcol-contrib (includes transform processor) to otel/otelcol.
set -euo pipefail

VERSION="${OTELCOL_VERSION:-0.153.0}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/otelcol"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ARCH=arm64 ;;
  Darwin-x86_64) ARCH=amd64 ;;
  Linux-x86_64) ARCH=amd64 ;;
  Linux-aarch64) ARCH=arm64 ;;
  *)
    echo "Unsupported platform: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

OS=darwin
[[ "$(uname -s)" == Linux ]] && OS=linux

TARBALL="otelcol-contrib_${VERSION}_${OS}_${ARCH}.tar.gz"
URL="https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${VERSION}/${TARBALL}"

echo "Downloading ${URL} ..."
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
curl -fsSL "$URL" -o "$tmpdir/${TARBALL}"
tar -xzf "$tmpdir/${TARBALL}" -C "$tmpdir"
bin="$(find "$tmpdir" \( -name otelcol-contrib -o -name otelcol \) -type f | head -1)"
if [[ -z "$bin" ]]; then
  echo "otelcol-contrib binary not found in archive" >&2
  exit 1
fi
cp "$bin" "$OUT"
chmod +x "$OUT"
echo "Installed $OUT (OpenTelemetry Collector Contrib ${VERSION})"
