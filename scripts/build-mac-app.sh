#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/MausBot Notch.app"
CONTENTS_DIR="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

echo "[build] Building MausBot Notch.app..."
rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR/app"

cp "$ROOT_DIR/macos/Info.plist" "$CONTENTS_DIR/Info.plist"

cp "$ROOT_DIR/server.mjs" "$RESOURCES_DIR/app/server.mjs"
cp "$ROOT_DIR/package.json" "$RESOURCES_DIR/app/package.json"
cp -R "$ROOT_DIR/public" "$RESOURCES_DIR/app/public"

# swiftc defaults the deployment target to the active SDK, which Launch
# Services rejects on older systems with error -10825, so pin it explicitly.
ARCH="$(uname -m)"
swiftc -O \
  -target "${ARCH}-apple-macosx13.0" \
  -framework Cocoa \
  -framework WebKit \
  -framework Carbon \
  "$ROOT_DIR/macos/NotchApp.swift" \
  -o "$MACOS_DIR/MausBotNotch"

# Auto-detect Developer ID / Apple Development certificate, or fall back to ad-hoc signing
SIGN_ID="${CODESIGN_IDENTITY:-}"
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -n 1 || true)"
fi
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -n 1 || true)"
fi

if [ -n "$SIGN_ID" ]; then
  echo "[build] Signing with $SIGN_ID..."
  codesign --force --deep --options runtime \
    --entitlements "$ROOT_DIR/macos/entitlements.plist" \
    --sign "$SIGN_ID" \
    "$APP_BUNDLE"
else
  echo "[build] Signing ad-hoc with entitlements..."
  codesign --force --deep \
    --entitlements "$ROOT_DIR/macos/entitlements.plist" \
    --sign - \
    "$APP_BUNDLE"
fi

echo "[build] Built successfully: $APP_BUNDLE"
