#!/usr/bin/env bash
# Build the secureStorage Rust crate for iOS (device + simulator),
# package into an XCFramework, and regenerate UniFFI Swift bindings.
#
# All outputs land in the committed xcframework + plugin directories.
# Files whose content is unchanged keep their existing mtime so Xcode's
# input fingerprinting does not trigger downstream Swift recompiles
# every build.
#
# Usage: bash scripts/build-native-ios.sh [--release|--debug|-h]

set -Eeuo pipefail

# Xcode build phases run with a sanitized PATH that excludes
# `~/.cargo/bin`, so `cargo` is unresolved when this script is
# triggered from the "Build secure-storage (Rust)" pre-build phase.
# Source the cargo env if available, then add the canonical install
# locations to PATH as a belt-and-suspenders fallback. No effect when
# the script is run from a normal interactive shell that already has
# cargo on PATH.
if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
fi
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

usage() {
    cat <<'EOF'
Usage: build-native-ios.sh [--release|--debug] [-h|--help]
  --release  Optimised build, stripped by Xcode at archive time
  --debug    Unoptimised build with symbols (default)
EOF
}

PROFILE="${1:---debug}"
case "$PROFILE" in
    --release) CARGO_FLAGS=("--release"); PROFILE_DIR="release" ;;
    --debug)   CARGO_FLAGS=();            PROFILE_DIR="debug" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown profile '$PROFILE'" >&2; usage >&2; exit 2 ;;
esac

if (($# > 1)); then
    echo "error: unexpected extra arguments: ${*:2}" >&2
    usage >&2
    exit 2
fi

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"
RUST_DIR="$ROOT_DIR/wasm"
IOS_DIR="$ROOT_DIR/ios/App"
PLUGIN_DIR="$IOS_DIR/App/plugins/secureStorage"
XCFW_DIR="$IOS_DIR/SecureStorage.xcframework"

echo "=== Building secureStorage for iOS ($PROFILE) ==="

cd "$RUST_DIR"

echo "[1/3] cargo build (aarch64-apple-ios + aarch64-apple-ios-sim)..."
# `${arr[@]+"${arr[@]}"}` so an empty CARGO_FLAGS does not trip
# `set -u` on macOS bash 3.2 (older bash treats `${arr[@]}` on an
# empty array as an unset reference).
cargo build -p secureStorage --features native --no-default-features \
    ${CARGO_FLAGS[@]+"${CARGO_FLAGS[@]}"} \
    --target aarch64-apple-ios \
    --target aarch64-apple-ios-sim

DEVICE_LIB="$RUST_DIR/target/aarch64-apple-ios/$PROFILE_DIR/libsecureStorage.a"
SIM_LIB="$RUST_DIR/target/aarch64-apple-ios-sim/$PROFILE_DIR/libsecureStorage.a"

# Belt-and-suspenders: xcodebuild -create-xcframework trusts the
# declared platform but does not verify the actual arch of the .a, so
# a host-build leak (e.g. stale x86_64 lib) would slip through.
for slice_lib in "$DEVICE_LIB" "$SIM_LIB"; do
    if ! lipo -info "$slice_lib" | grep -q 'arm64'; then
        echo "error: $slice_lib is not arm64" >&2
        exit 1
    fi
done

# Stage xcframework + bindings into temp dirs, then install both into
# the committed structure as the final step. Asymmetric staging (libs
# in place before bindgen runs) would leave new .a alongside old Swift
# wrappers if bindgen fails - silent ABI mismatch at first FFI call.
TMP_XCFW="${IOS_DIR}/SecureStorage.tmp.$$.xcframework"
TMP_BINDINGS="${PLUGIN_DIR}/.tmp.$$.bindings"
trap 'rm -rf "$TMP_XCFW" "$TMP_BINDINGS"' EXIT

echo "[2/3] xcodebuild -create-xcframework..."
xcodebuild -create-xcframework \
    -library "$DEVICE_LIB" \
    -library "$SIM_LIB" \
    -output "$TMP_XCFW" >/dev/null

echo "[3/3] UniFFI Swift bindings..."
mkdir -p "$TMP_BINDINGS"
cargo run -p uniffi-bindgen -- generate \
    --library "$DEVICE_LIB" \
    --language swift \
    --out-dir "$TMP_BINDINGS"

install_if_changed() {
    local src=$1 dst=$2
    if [[ ! -e $dst ]] || ! cmp -s "$src" "$dst"; then
        cp "$src" "$dst"
    fi
}

# Info.plist is committed and deterministic for a stable slice set; do
# not overwrite (avoids spurious git status diffs on toolchain bumps).
install_if_changed "$TMP_XCFW/ios-arm64/libsecureStorage.a" \
                   "$XCFW_DIR/ios-arm64/libsecureStorage.a"
install_if_changed "$TMP_XCFW/ios-arm64-simulator/libsecureStorage.a" \
                   "$XCFW_DIR/ios-arm64-simulator/libsecureStorage.a"

for f in "$TMP_BINDINGS"/*; do
    install_if_changed "$f" "$PLUGIN_DIR/$(basename "$f")"
done

DEVICE_SIZE=$(du -h "$XCFW_DIR/ios-arm64/libsecureStorage.a" | cut -f1)
SIM_SIZE=$(du -h "$XCFW_DIR/ios-arm64-simulator/libsecureStorage.a" | cut -f1)
echo ""
echo "  XCFramework: $XCFW_DIR"
echo "  Device lib:  $DEVICE_SIZE"
echo "  Sim lib:     $SIM_SIZE"
echo "  Bindings:    $PLUGIN_DIR/secureStorage.swift"
