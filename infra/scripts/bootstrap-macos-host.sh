#!/usr/bin/env bash
# Prepare a macOS machine as a DeviceLab host (Android + iOS). Run as the lab user (not root).
set -euo pipefail
command -v brew >/dev/null || { echo "Install Homebrew (or your internal equivalent) first." >&2; exit 1; }
brew install node@20 android-platform-tools go-ios
xcode-select -p >/dev/null 2>&1 || { echo "Install Xcode from the App Store / internal mirror, then: sudo xcodebuild -license accept" >&2; exit 1; }

echo "==> Keep the Mac awake (no sleep, no display sleep, restart after power failure)"
sudo pmset -a sleep 0 displaysleep 0 disksleep 0 autorestart 1

mkdir -p "$HOME/devicelab-agent" "$HOME/Library/LaunchAgents"
cp "$(dirname "$0")/in.devicelab.agent.plist" "$HOME/Library/LaunchAgents/"
cat <<NEXT

Next steps:
  1. Copy the agent to ~/devicelab-agent and run: node scripts/fetch-scrcpy-server.mjs
  2. Save the config from Admin → Hosts as ~/devicelab-agent/agent.config.json
  3. Build and sign WebDriverAgent (see docs/HOST_SETUP_IOS.md)
  4. launchctl load ~/Library/LaunchAgents/in.devicelab.agent.plist
NEXT
