#!/usr/bin/env bash
# Downloads jaeger-all-in-one next to this script (no Docker).
set -euo pipefail

VERSION="${JAEGER_VERSION:-1.76.0}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/jaeger-all-in-one"

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

TARBALL="jaeger-${VERSION}-${OS}-${ARCH}.tar.gz"
URL="https://github.com/jaegertracing/jaeger/releases/download/v${VERSION}/${TARBALL}"

echo "Downloading ${URL} ..."
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
curl -fsSL "$URL" -o "$tmpdir/${TARBALL}"
tar -xzf "$tmpdir/${TARBALL}" -C "$tmpdir"
bin="$(find "$tmpdir" -name jaeger-all-in-one -type f | head -1)"
if [[ -z "$bin" ]]; then
  echo "jaeger-all-in-one not found in archive" >&2
  exit 1
fi
cp "$bin" "$OUT"
chmod +x "$OUT"
echo "Installed $OUT (UI: http://localhost:16686)"
