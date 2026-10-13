#!/usr/bin/env bash
# Create a self-signed certificate for infra/nginx/certs (dev / pilot only — use your internal CA in production).
set -euo pipefail
CN="${1:-devicelab.local}"
OUT="$(cd "$(dirname "$0")/../nginx/certs" && pwd)"
openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -subj "/CN=$CN/O=DeviceLab (self-signed)" \
  -addext "subjectAltName=DNS:$CN,DNS:localhost,IP:127.0.0.1" \
  -keyout "$OUT/tls.key" -out "$OUT/tls.crt"
chmod 600 "$OUT/tls.key"
echo "Wrote $OUT/tls.crt and tls.key for $CN"
