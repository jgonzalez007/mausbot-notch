#!/usr/bin/env bash
# Build a universal (arm64 + x86_64) MausBot Notch.app and a DMG in dist/.
# Usage: scripts/make-release.sh [VERSION]
#   VERSION defaults to CFBundleShortVersionString in macos/Info.plist.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$ROOT_DIR/macos/Info.plist" | tr -d '[:space:]')}"
APP_NAME="MausBot Notch"
APP_BUNDLE="$ROOT_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
DIST_DIR="$ROOT_DIR/dist"
BUILD_DIR="$ROOT_DIR/.build-release"

echo "[release] MausBot Notch v$VERSION"

# --- Reuse the shared bundle layout + signing logic from build-mac-app.sh ---
rm -rf "$APP_BUNDLE" "$DIST_DIR" "$BUILD_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR/app" "$BUILD_DIR"
cp "$ROOT_DIR/macos/Info.plist" "$CONTENTS_DIR/Info.plist"
cp "$ROOT_DIR/server.mjs" "$ROOT_DIR/settings.mjs" "$RESOURCES_DIR/app/"
cp "$ROOT_DIR/package.json" "$RESOURCES_DIR/app/package.json"
cp -R "$ROOT_DIR/public" "$RESOURCES_DIR/app/public"

SWIFT_FLAGS=(-O -framework Cocoa -framework WebKit -framework Carbon)

echo "[release] Compiling arm64..."
swiftc "${SWIFT_FLAGS[@]}" -target arm64-apple-macosx13.0 \
  "$ROOT_DIR/macos/CalendarEvents.swift" "$ROOT_DIR/macos/DraftSpot.swift" "$ROOT_DIR/macos/HotKey.swift" "$ROOT_DIR/macos/SettingsWindow.swift" "$ROOT_DIR/macos/NotchApp.swift" -o "$BUILD_DIR/MausBotNotch-arm64"

echo "[release] Compiling x86_64..."
swiftc "${SWIFT_FLAGS[@]}" -target x86_64-apple-macosx13.0 \
  "$ROOT_DIR/macos/CalendarEvents.swift" "$ROOT_DIR/macos/DraftSpot.swift" "$ROOT_DIR/macos/HotKey.swift" "$ROOT_DIR/macos/SettingsWindow.swift" "$ROOT_DIR/macos/NotchApp.swift" -o "$BUILD_DIR/MausBotNotch-x86_64"

lipo -create -output "$MACOS_DIR/MausBotNotch" \
  "$BUILD_DIR/MausBotNotch-arm64" "$BUILD_DIR/MausBotNotch-x86_64"
rm -rf "$BUILD_DIR"

# --- Signing (same policy as build-mac-app.sh) ---
SIGN_ID="${CODESIGN_IDENTITY:-}"
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -n 1 || true)"
fi
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -n 1 || true)"
fi

if [ -n "$SIGN_ID" ]; then
  echo "[release] Signing with $SIGN_ID..."
  codesign --force --deep --options runtime \
    --entitlements "$ROOT_DIR/macos/entitlements.plist" \
    --sign "$SIGN_ID" "$APP_BUNDLE"
else
  echo "[release] Signing ad-hoc (first launch needs right-click → Open, or run install.sh)..."
  codesign --force --deep \
    --entitlements "$ROOT_DIR/macos/entitlements.plist" \
    --sign - "$APP_BUNDLE"
fi
codesign --verify --deep --strict "$APP_BUNDLE"

# --- DMG ---
STAGE_DIR="$DIST_DIR/stage"
mkdir -p "$STAGE_DIR"
cp -R "$APP_BUNDLE" "$STAGE_DIR/"
ln -s /Applications "$STAGE_DIR/Applications"
DMG_PATH="$DIST_DIR/MausBotNotch-$VERSION.dmg"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE_DIR" -format UDZO -o "$DMG_PATH" > /dev/null
rm -rf "$STAGE_DIR"

echo "[release] DMG: $DMG_PATH"
shasum -a 256 "$DMG_PATH"
du -h "$DMG_PATH"
