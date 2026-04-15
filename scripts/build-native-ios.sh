#!/usr/bin/env bash
# Build the secureStorage Rust crate for iOS (device + simulator),
# package into an XCFramework, and regenerate UniFFI Swift bindings.
#
# Outputs are gitignored; regenerated on demand by the Xcode
# "Build secure-storage (Rust)" pre-build phase.
#
# Usage: bash scripts/build-native-ios.sh [--release|--debug|-h]

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage: build-native-ios.sh [--release|--debug] [-h|--help]
  --release  Optimised build, stripped by Xcode at archive time
  --debug    Unoptimised build with symbols (default)
EOF
}

PROFILE="${1:---debug}"
case "$PROFILE" in
    --release) CARGO_FLAGS="--release"; PROFILE_DIR="release" ;;
    --debug)   CARGO_FLAGS="";          PROFILE_DIR="debug" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown profile '$PROFILE'" >&2; usage >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"
RUST_DIR="$ROOT_DIR/wasm"
IOS_DIR="$ROOT_DIR/ios/App"
PLUGIN_DIR="$IOS_DIR/App/plugins/secureStorage"
XCFW_DIR="$IOS_DIR/SecureStorage.xcframework"

echo "=== Building secureStorage for iOS ($PROFILE) ==="

cd "$RUST_DIR"

# 1. Cross-compile for device + simulator in a single cargo invocation.
echo "[1/3] cargo build (aarch64-apple-ios + aarch64-apple-ios-sim)..."
cargo build -p secureStorage --features native --no-default-features $CARGO_FLAGS \
    --target aarch64-apple-ios \
    --target aarch64-apple-ios-sim

DEVICE_LIB="$RUST_DIR/target/aarch64-apple-ios/$PROFILE_DIR/libsecureStorage.a"
SIM_LIB="$RUST_DIR/target/aarch64-apple-ios-sim/$PROFILE_DIR/libsecureStorage.a"

# 2. Package via `xcodebuild -create-xcframework` (Apple's official tool).
#    Handles Info.plist generation, arch validation, and atomic output —
#    replaces the manual lipo + heredoc plist + staging we used to carry.
echo "[2/3] xcodebuild -create-xcframework..."
rm -rf "$XCFW_DIR"
xcodebuild -create-xcframework \
    -library "$DEVICE_LIB" \
    -library "$SIM_LIB" \
    -output "$XCFW_DIR" >/dev/null

# 3. UniFFI Swift bindings (version pinned centrally in
#    wasm/Cargo.toml [workspace.dependencies]).
echo "[3/3] UniFFI Swift bindings..."
cargo run -p uniffi-bindgen -- generate \
    --library "$DEVICE_LIB" \
    --language swift \
    --out-dir "$PLUGIN_DIR" >/dev/null

DEVICE_SIZE=$(du -h "$XCFW_DIR/ios-arm64/libsecureStorage.a" | cut -f1)
SIM_SIZE=$(du -h "$XCFW_DIR/ios-arm64-simulator/libsecureStorage.a" | cut -f1)
echo ""
echo "  XCFramework: $XCFW_DIR"
echo "  Device lib:  $DEVICE_SIZE"
echo "  Sim lib:     $SIM_SIZE"
echo "  Bindings:    $PLUGIN_DIR/secureStorage.swift"
