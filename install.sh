#!/usr/bin/env bash
# Install the latest (or a pinned) MausBot Notch release from GitHub.
# No clone, no compiler needed: downloads the DMG, installs to /Applications,
# clears the quarantine flag and launches.
#
#   ./install.sh               # latest release
#   ./install.sh v1.0.0        # pinned version
#   ./install.sh --no-open     # install without launching
set -euo pipefail

REPO="jgonzalez007/mausbot-notch"
APP_NAME="MausBot Notch"
VERSION="latest"
DO_OPEN=true

for arg in "$@"; do
  case "$arg" in
    --no-open) DO_OPEN=false ;;
    v*) VERSION="${arg#v}" ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      VERSION="$arg"
      ;;
  esac
done

command -v curl > /dev/null || { echo "[error] curl is required."; exit 1; }
command -v hdiutil > /dev/null || { echo "[error] hdiutil not found — is this macOS?"; exit 1; }

if [ "$VERSION" = "latest" ]; then
  API_URL="https://api.github.com/repos/$REPO/releases/latest"
  WORK_TAG="latest"
else
  API_URL="https://api.github.com/repos/$REPO/releases/tags/v$VERSION"
  WORK_TAG="$VERSION"
fi

echo "[install] Fetching release info for v$VERSION ..."
RELEASE_JSON="$(curl -fsSL "$API_URL")"

DMG_URL="$(printf '%s' "$RELEASE_JSON" | tr ',' '\n' \
  | grep -o '"browser_download_url":[^,}]*\.dmg[^,}]*' | head -n 1 \
  | sed 's/.*"browser_download_url":[[:space:]]*//; s/^"//; s/"[[:space:]]*$//')"

if [ -z "$DMG_URL" ]; then
  echo "[error] No DMG asset found on that release."
  exit 1
fi

DMG_PATH="$(mktemp -d)/MausBotNotch.dmg"
echo "[install] Downloading $DMG_URL"
curl -fL --progress-bar -o "$DMG_PATH" "$DMG_URL"

echo "[install] Mounting..."
# Detach any stale mounts from earlier failed runs (e.g. "/Volumes/MausBot Notch 1").
for v in "/Volumes/MausBot Notch" "/Volumes/MausBot Notch"[0-9]*; do
  [ -d "$v" ] && hdiutil detach -quiet "$v" 2>/dev/null || true
done
# hdiutil attach prints tab-separated lines: device, fs type, mount point.
# The mount point is the third tab-separated field (it may contain spaces).
ATTACH_OUT="$(hdiutil attach -nobrowse "$DMG_PATH" 2>&1)"
MOUNT_POINT="$(printf '%s\n' "$ATTACH_OUT" | awk -F'\t' 'NF >= 3 && $3 ~ /^\/Volumes\// { last = $3 } END { print last }')"
if [ -z "$MOUNT_POINT" ]; then
  echo "[error] Could not determine the DMG mount point:"
  echo "$ATTACH_OUT"
  exit 1
fi

echo "[install] Installing to /Applications..."
rm -rf "/Applications/$APP_NAME.app"
cp -R "$MOUNT_POINT/$APP_NAME.app" "/Applications/"
hdiutil detach -quiet "$MOUNT_POINT" || true
rm -rf "$(dirname "$DMG_PATH")"

echo "[install] Clearing quarantine flag (ad-hoc signed build)..."
xattr -dr com.apple.quarantine "/Applications/$APP_NAME.app" 2>/dev/null || true

if [ "$DO_OPEN" = true ]; then
  open "/Applications/$APP_NAME.app"
  echo "[ok] MausBot Notch is live. Toggle the notch with Option+Space (⌥Space)."
else
  echo "[ok] Installed /Applications/$APP_NAME.app (use --no-open to launch yourself)."
fi

echo "Add your bots in Settings: click the notch's menu-bar icon (✦), then Settings…"
