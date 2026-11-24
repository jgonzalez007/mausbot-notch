#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
swiftc "$ROOT_DIR/macos/DraftSpot.swift" "$ROOT_DIR/scripts/draft-spot-test.swift" -o "$OUT/test"
"$OUT/test"
