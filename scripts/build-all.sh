#!/usr/bin/env bash
# Build everything needed for a full deploy (web + iOS + Android).
#
# Usage:
#   npm run build:all            # release build, all targets
#   npm run build:all -- android # android only
#   npm run build:all -- ios     # ios only
#   npm run build:all -- web     # web only

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-all}"

cd "$ROOT_DIR"

case "$TARGET" in
  android)
    bash scripts/build-native-android.sh --release
    npm run build
    npx cap sync android
    ;;
  ios)
    bash scripts/build-native-ios.sh --release
    npm run build
    npx cap sync ios
    ;;
  web)
    npm run wasm:build:secure
    npm run wasm:build
    npm run build
    ;;
  all)
    echo "=== Building all targets ==="
    npm run wasm:build:secure
    npm run wasm:build
    bash scripts/build-native-ios.sh --release
    bash scripts/build-native-android.sh --release
    npm run build
    npx cap sync
    ;;
  *)
    echo "Usage: $0 [web|ios|android|all]"
    exit 1
    ;;
esac

echo ""
echo "=== Done: $TARGET ==="
