#!/usr/bin/env bash
# Build the gossip-mobile Rust crate (the mesh node, in the gossip-node
# repository) for iOS: a static-library xcframework with the UniFFI C headers,
# and the Swift bindings, into ios/App/GossipMobile/generated (gitignored).
# Then run `pod install` in ios/App: the Podfile adds the GossipMobile pod
# once these files exist, and the app switches from the stub core to it.
#
# macOS with Xcode only. The gossip-node checkout is $GOSSIP_NODE_DIR, or
# ../gossip-node next to this repository.
#
# Usage: bash scripts/build-mesh-ios.sh [--release|--debug|-h]

set -Eeuo pipefail

PROFILE="${1:---release}"
case "$PROFILE" in
    --release) CARGO_FLAGS=("--release"); TARGET_DIR="release" ;;
    --debug)   CARGO_FLAGS=();             TARGET_DIR="debug" ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "error: unknown profile '$PROFILE'" >&2; exit 2 ;;
esac

[[ "$(uname -s)" == Darwin ]] || { echo "error: the iOS build needs macOS and Xcode" >&2; exit 1; }

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"
NODE_DIR="${GOSSIP_NODE_DIR:-$ROOT_DIR/../gossip-node}"
if [[ ! -f "$NODE_DIR/crates/gossip-mobile/Cargo.toml" ]]; then
    echo "error: no gossip-mobile crate under $NODE_DIR (set GOSSIP_NODE_DIR)" >&2
    exit 1
fi
NODE_DIR="$(cd -P "$NODE_DIR" && pwd)"
OUT_DIR="$ROOT_DIR/ios/App/GossipMobile/generated"
export CARGO_TARGET_DIR="${GOSSIP_MOBILE_TARGET_DIR:-$ROOT_DIR/ios/build/gossip-mobile-target}"

# Xcode-launched shells often miss ~/.cargo/bin.
if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
fi
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$NODE_DIR"

TMP="$OUT_DIR.tmp.$$"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/headers"

echo "[1/3] cargo build (aarch64-apple-ios + aarch64-apple-ios-sim)..."
for target in aarch64-apple-ios aarch64-apple-ios-sim; do
    rustup target add "$target" >/dev/null
    cargo build -p gossip-mobile --target "$target" -j "${JOBS:-3}" ${CARGO_FLAGS[@]+"${CARGO_FLAGS[@]}"}
done
DEVICE_LIB="$CARGO_TARGET_DIR/aarch64-apple-ios/$TARGET_DIR/libgossip_mobile.a"
SIM_LIB="$CARGO_TARGET_DIR/aarch64-apple-ios-sim/$TARGET_DIR/libgossip_mobile.a"

echo "[2/3] UniFFI Swift bindings..."
cargo run -q -p gossip-mobile --features bindgen --bin uniffi-bindgen -j "${JOBS:-3}" -- \
    generate --library "$DEVICE_LIB" --language swift --out-dir "$TMP/swift" --no-format
cp "$TMP/swift/GossipMobileFFI.h" "$TMP/headers/"
cp "$TMP/swift/GossipMobileFFI.modulemap" "$TMP/headers/module.modulemap"

echo "[3/3] xcodebuild -create-xcframework..."
xcodebuild -create-xcframework \
    -library "$DEVICE_LIB" -headers "$TMP/headers" \
    -library "$SIM_LIB" -headers "$TMP/headers" \
    -output "$TMP/GossipMobileFFI.xcframework" >/dev/null

rm -rf "$OUT_DIR"
mkdir -p "$(dirname "$OUT_DIR")"
mv "$TMP" "$OUT_DIR"
trap - EXIT
echo "  $OUT_DIR/GossipMobileFFI.xcframework"
echo "  $OUT_DIR/swift/GossipMobile.swift"
echo "Now run: (cd ios/App && pod install)"
