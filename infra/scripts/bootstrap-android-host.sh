#!/usr/bin/env bash
# Prepare a Linux (Ubuntu/Debian) machine as a DeviceLab Android host.
# Usage: sudo ./bootstrap-android-host.sh [install-dir]
set -euo pipefail
DIR="${1:-/opt/devicelab-agent}"

echo "==> Installing adb and Node.js 20"
apt-get update
apt-get install -y --no-install-recommends android-sdk-platform-tools-common adb curl ca-certificates
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Install Node.js 20+ from your internal mirror (or nodesource) before continuing." >&2
  exit 1
fi

echo "==> udev rules so adb works without root (plugdev group)"
cat >/etc/udev/rules.d/51-android.rules <<'RULES'
SUBSYSTEM=="usb", ATTR{idVendor}=="18d1", MODE="0660", GROUP="plugdev"   # Google
SUBSYSTEM=="usb", ATTR{idVendor}=="04e8", MODE="0660", GROUP="plugdev"   # Samsung
SUBSYSTEM=="usb", ATTR{idVendor}=="2717", MODE="0660", GROUP="plugdev"   # Xiaomi
SUBSYSTEM=="usb", ATTR{idVendor}=="22b8", MODE="0660", GROUP="plugdev"   # Motorola
SUBSYSTEM=="usb", ATTR{idVendor}=="12d1", MODE="0660", GROUP="plugdev"   # Huawei
SUBSYSTEM=="usb", ATTR{idVendor}=="2a70", MODE="0660", GROUP="plugdev"   # OnePlus
SUBSYSTEM=="usb", ATTR{idVendor}=="0bb4", MODE="0660", GROUP="plugdev"   # HTC
SUBSYSTEM=="usb", ATTR{idVendor}=="1004", MODE="0660", GROUP="plugdev"   # LG
SUBSYSTEM=="usb", ATTR{idVendor}=="0fce", MODE="0660", GROUP="plugdev"   # Sony
SUBSYSTEM=="usb", ATTR{idVendor}=="2d95", MODE="0660", GROUP="plugdev"   # vivo
SUBSYSTEM=="usb", ATTR{idVendor}=="22d9", MODE="0660", GROUP="plugdev"   # OPPO / realme
RULES
udevadm control --reload-rules && udevadm trigger

echo "==> Service user"
id devicelab >/dev/null 2>&1 || useradd --system --create-home --groups plugdev devicelab
mkdir -p "$DIR" /etc/devicelab
chown devicelab:devicelab "$DIR"

cat <<NEXT

Next steps:
  1. Copy the built agent (apps/host-agent/dist + node_modules, or the pkg binary) to $DIR
  2. Fetch scrcpy-server:   (cd $DIR && node scripts/fetch-scrcpy-server.mjs)
  3. Admin → Hosts → Register host, then save the shown config as /etc/devicelab/agent.config.json
  4. sudo cp $(dirname "$0")/devicelab-agent.service /etc/systemd/system/ && sudo systemctl enable --now devicelab-agent
  5. Plug in phones (powered USB hub, ≤10 per host), enable USB debugging, accept the RSA prompt.
NEXT
