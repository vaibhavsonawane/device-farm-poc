#!/bin/sh
# Generate a self-signed certificate on first start if none is mounted.
# Production: mount your internal-CA certificate as /etc/nginx/certs/tls.crt + tls.key.
set -eu
CERT_DIR=/etc/nginx/certs
if [ ! -s "$CERT_DIR/tls.crt" ] || [ ! -s "$CERT_DIR/tls.key" ]; then
  mkdir -p "$CERT_DIR"
  CN="${DEVICELAB_HOSTNAME:-devicelab.local}"
  echo "devicelab: no TLS certificate mounted — generating a self-signed one for $CN"
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -subj "/CN=$CN/O=DeviceLab (self-signed)" \
    -addext "subjectAltName=DNS:$CN,DNS:localhost,IP:127.0.0.1" \
    -keyout "$CERT_DIR/tls.key" -out "$CERT_DIR/tls.crt" >/dev/null 2>&1
  chmod 600 "$CERT_DIR/tls.key"
fi
