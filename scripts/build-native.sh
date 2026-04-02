#!/bin/bash
set -euo pipefail

# Build secure-storage Rust crate for all native targets,
# generate UniFFI bindings, and copy everything into place.
#
# Usage:
#   ./scripts/build-native.sh           # All platforms
#   ./scripts/build-native.sh android   # Android only
#   ./scripts/build-native.sh ios       # iOS only

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WASM_DIR="$ROOT/wasm"
CRATE="secureStorage"

PLATFORM="${1:-all}"

export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$HOME/Library/Android/sdk/ndk/29.0.13599879}"

# ── 1. Build for host (macOS) — needed for binding generation ────────

echo "==> Building for host (binding generation)..."
cd "$WASM_DIR"
cargo build --release --features native -p "$CRATE" 2>&1 | grep -E "Compiling|Finished"

# ── 2. Generate bindings ─────────────────────────────────────────────

echo "==> Generating Kotlin bindings..."
cargo run -p uniffi-bindgen -- generate \
  --library "target/release/libsecureStorage.dylib" \
  --language kotlin \
  --out-dir "$ROOT/android/app/src/main/java" \
  --no-format 2>&1 | grep -v "^$"

echo "==> Generating Swift bindings..."
cargo run -p uniffi-bindgen -- generate \
  --library "target/release/libsecureStorage.dylib" \
  --language swift \
  --out-dir "/tmp/uniffi-swift-gen" \
  --no-format 2>&1 | grep -v "^$"

cp /tmp/uniffi-swift-gen/secureStorage.swift "$ROOT/ios/App/App/plugins/secureStorage/"
cp /tmp/uniffi-swift-gen/secureStorageFFI.h "$ROOT/ios/App/App/plugins/secureStorage/"
cp /tmp/uniffi-swift-gen/secureStorageFFI.h "$ROOT/ios/App/App/secureStorageFFI.h"

# ── 3. Android ───────────────────────────────────────────────────────

if [[ "$PLATFORM" == "all" || "$PLATFORM" == "android" ]]; then
  echo "==> Building Android (3 targets)..."
  ANDROID_NDK_HOME="$ANDROID_NDK_HOME" cargo ndk \
    --target aarch64-linux-android \
    --target armv7-linux-androideabi \
    --target x86_64-linux-android \
    --platform 24 \
    -- build --release --features native -p "$CRATE" 2>&1 | grep -E "Compiling|Finished"

  echo "==> Copying .so to jniLibs..."
  JNILIBS="$ROOT/android/app/src/main/jniLibs"
  mkdir -p "$JNILIBS"/{arm64-v8a,armeabi-v7a,x86_64}
  cp "target/aarch64-linux-android/release/libsecureStorage.so" "$JNILIBS/arm64-v8a/"
  cp "target/armv7-linux-androideabi/release/libsecureStorage.so" "$JNILIBS/armeabi-v7a/"
  cp "target/x86_64-linux-android/release/libsecureStorage.so" "$JNILIBS/x86_64/"
  echo "    arm64: $(du -h "$JNILIBS/arm64-v8a/libsecureStorage.so" | cut -f1)"
fi

# ── 4. iOS ───────────────────────────────────────────────────────────

if [[ "$PLATFORM" == "all" || "$PLATFORM" == "ios" ]]; then
  echo "==> Building iOS (device + simulator)..."
  cargo build --release --target aarch64-apple-ios --features native -p "$CRATE" 2>&1 | grep -E "Compiling|Finished"
  cargo build --release --target aarch64-apple-ios-sim --features native -p "$CRATE" 2>&1 | grep -E "Compiling|Finished"

  echo "==> Creating XCFramework..."
  rm -rf "target/SecureStorage.xcframework"
  xcodebuild -create-xcframework \
    -library "target/aarch64-apple-ios/release/libsecureStorage.a" \
    -library "target/aarch64-apple-ios-sim/release/libsecureStorage.a" \
    -output "target/SecureStorage.xcframework" 2>&1 | tail -1

  rm -rf "$ROOT/ios/App/SecureStorage.xcframework"
  cp -R "target/SecureStorage.xcframework" "$ROOT/ios/App/SecureStorage.xcframework"
  echo "    XCFramework: $(du -sh "$ROOT/ios/App/SecureStorage.xcframework" | cut -f1)"
fi

echo ""
echo "==> Done. Next steps:"
echo "    npx cap sync android   # or ios"
echo "    npx cap open android   # or ios"
