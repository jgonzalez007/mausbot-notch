#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_TO_APPS=false

for arg in "$@"; do
  case "$arg" in
    --install|-i)
      INSTALL_TO_APPS=true
      ;;
  esac
done

echo "=================================================="
echo "  ✦ MausBot Notch — macOS Setup"
echo "=================================================="

# 1. Verify macOS
if [ "$(uname -s)" != "Darwin" ]; then
  echo "[error] MausBot Notch requires macOS."
  exit 1
fi

# 2. Verify Swift compiler (Xcode Command Line Tools)
if ! command -v swiftc > /dev/null 2>&1; then
  echo "[error] swiftc not found. Installing Xcode Command Line Tools..."
  xcode-select --install || true
  echo "Please complete the Xcode Command Line Tools installation and re-run ./scripts/setup.sh"
  exit 1
fi

# 3. Verify Node.js
if ! command -v node > /dev/null 2>&1; then
  echo "[error] Node.js is required (v18+). Install via: brew install node"
  exit 1
fi

# 4. Check for a bots config file; create a template if missing
SUPPORT_DIR="${HOME}/Library/Application Support/MausBot Notch"
CONFIG_FILE="${SUPPORT_DIR}/config.json"
mkdir -p "$SUPPORT_DIR"
chmod 700 "$SUPPORT_DIR"
if [ ! -f "$CONFIG_FILE" ]; then
  cp "$ROOT_DIR/config.example.json" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "[setup] Created an empty bots config at: $CONFIG_FILE"
else
  echo "[ok] Found existing bots config at: $CONFIG_FILE"
fi

# 5. Build MausBot Notch.app
chmod +x "$ROOT_DIR/scripts/build-mac-app.sh" "$ROOT_DIR/scripts/launch.sh"
"$ROOT_DIR/scripts/build-mac-app.sh"

# 6. Optionally copy to /Applications
if [ "$INSTALL_TO_APPS" = true ]; then
  echo "[setup] Installing MausBot Notch.app to /Applications..."
  rm -rf "/Applications/MausBot Notch.app"
  cp -R "$ROOT_DIR/MausBot Notch.app" "/Applications/MausBot Notch.app"
  echo "[ok] Installed to /Applications/MausBot Notch.app"
fi

# 7. Launch MausBot Notch
"$ROOT_DIR/scripts/launch.sh"

echo ""
echo "=================================================="
echo "  ✓ MausBot Notch is live at the top of your Mac!"
echo "  • Toggle Notch:    Option + Space (⌥Space)"
echo "  • Switch bots:     Left / Right Arrows (← / →)"
echo "  • Tap to type:     Enter sends, Esc closes"
echo "=================================================="
echo ""
echo "Add your bots in Settings: click the notch's menu-bar icon (✦), then Settings…"
