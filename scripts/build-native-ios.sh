#!/usr/bin/env bash
# Build the secureStorage Rust crate for iOS (device + simulator),
# package into an XCFramework, regenerate UniFFI Swift bindings, and
# drop everything into the Xcode project. The outputs are gitignored
# (see .gitignore) and regenerated on demand by the Xcode
# "Build secure-storage (Rust)" pre-build phase.
#
# Usage: bash scripts/build-native-ios.sh [--release|--debug|-h]
#        npm run native:build:ios          # alias for --release
#        npm run native:build:ios:debug    # alias for --debug

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: build-native-ios.sh [--release|--debug] [-h|--help]

  --release   Optimised build, symbols stripped (suitable for archive)
  --debug     Unoptimised build with symbols (default — fast iteration)
  -h, --help  Show this message
EOF
}

# ── 0. Arg parsing ──────────────────────────────────────────────────
PROFILE="${1:-"--debug"}"
case "$PROFILE" in
    --release)
        CARGO_FLAGS="--release"
        TARGET_DIR="release"
        ;;
    --debug)
        CARGO_FLAGS=""
        TARGET_DIR="debug"
        ;;
    -h|--help)
        usage
        exit 0
        ;;
    *)
        echo "error: unknown profile '$PROFILE'" >&2
        usage >&2
        exit 2
        ;;
esac

# Resolve the script's directory even when invoked via symlink or sourced.
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"
WASM_DIR="$ROOT_DIR/wasm"
IOS_DIR="$ROOT_DIR/ios/App"
PLUGIN_DIR="$IOS_DIR/App/plugins/secureStorage"
XCFW_DIR="$IOS_DIR/SecureStorage.xcframework"
XCFW_TMP="$XCFW_DIR.tmp.$$"

cleanup_tmp() {
    rm -rf "$XCFW_TMP"
}
trap cleanup_tmp EXIT

echo "=== Building secureStorage for iOS ($PROFILE) ==="

cd "$WASM_DIR"

# ── 1. Cross-compile for device + simulator ─────────────────────────
echo "[1/6] Building aarch64-apple-ios (device)..."
cargo build -p secureStorage --features native $CARGO_FLAGS \
    --target aarch64-apple-ios

echo "[1/6] Building aarch64-apple-ios-sim (Apple-silicon simulator)..."
# Intel-mac simulator (x86_64-apple-ios) is intentionally excluded.
# The project is Apple-silicon-only; extend here if that changes.
cargo build -p secureStorage --features native $CARGO_FLAGS \
    --target aarch64-apple-ios-sim

DEVICE_LIB="$WASM_DIR/target/aarch64-apple-ios/$TARGET_DIR/libsecureStorage.a"
SIM_LIB="$WASM_DIR/target/aarch64-apple-ios-sim/$TARGET_DIR/libsecureStorage.a"

# ── 2. Verify each slice has the right architecture ─────────────────
echo "[2/6] Verifying architectures..."
require_arch() {
    local lib="$1"
    local expected="$2"
    local info
    info="$(lipo -info "$lib")"
    if ! grep -q "$expected" <<<"$info"; then
        echo "error: $lib does not contain '$expected': $info" >&2
        exit 3
    fi
}
require_arch "$DEVICE_LIB" "arm64"
require_arch "$SIM_LIB" "arm64"

# ── 3. Preserve debug info before strip (release only) ──────────────
if [ "$PROFILE" = "--release" ]; then
    echo "[3/6] Preserving line-tables and stripping local symbols..."
    # strip -S removes debug symbols; -x preserves external symbols so
    # the archive still links. We keep the un-stripped libs alongside
    # under target/ for offline symbolication; App Store Connect won't
    # see Rust frames without a matching dSYM upload, but devs can run
    # `atos -o <unstripped-lib> <address>` against these.
    cp "$DEVICE_LIB" "${DEVICE_LIB%.a}.unstripped.a"
    cp "$SIM_LIB" "${SIM_LIB%.a}.unstripped.a"
    strip -S -x "$DEVICE_LIB"
    strip -S -x "$SIM_LIB"
else
    echo "[3/6] Skipping strip (debug build keeps full symbols)"
fi

# ── 4. Package into XCFramework (atomic via tmp dir) ────────────────
echo "[4/6] Creating XCFramework..."
rm -rf "$XCFW_TMP"
mkdir -p "$XCFW_TMP/ios-arm64"
mkdir -p "$XCFW_TMP/ios-arm64-simulator"
cp "$DEVICE_LIB" "$XCFW_TMP/ios-arm64/libsecureStorage.a"
cp "$SIM_LIB" "$XCFW_TMP/ios-arm64-simulator/libsecureStorage.a"

cat > "$XCFW_TMP/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AvailableLibraries</key>
	<array>
		<dict>
			<key>BinaryPath</key>
			<string>libsecureStorage.a</string>
			<key>LibraryIdentifier</key>
			<string>ios-arm64</string>
			<key>LibraryPath</key>
			<string>libsecureStorage.a</string>
			<key>SupportedArchitectures</key>
			<array>
				<string>arm64</string>
			</array>
			<key>SupportedPlatform</key>
			<string>ios</string>
		</dict>
		<dict>
			<key>BinaryPath</key>
			<string>libsecureStorage.a</string>
			<key>LibraryIdentifier</key>
			<string>ios-arm64-simulator</string>
			<key>LibraryPath</key>
			<string>libsecureStorage.a</string>
			<key>SupportedArchitectures</key>
			<array>
				<string>arm64</string>
			</array>
			<key>SupportedPlatform</key>
			<string>ios</string>
			<key>SupportedPlatformVariant</key>
			<string>simulator</string>
		</dict>
	</array>
	<key>CFBundlePackageType</key>
	<string>XFWK</string>
	<key>XCFrameworkFormatVersion</key>
	<string>1.0</string>
</dict>
</plist>
PLIST

# Atomic rename — leaves the previous XCFramework intact if anything
# above failed.
rm -rf "$XCFW_DIR"
mv "$XCFW_TMP" "$XCFW_DIR"

# ── 5. Regenerate UniFFI Swift bindings ─────────────────────────────
echo "[5/6] Generating UniFFI Swift bindings..."
cargo run -p uniffi-bindgen -- generate \
    --library "$DEVICE_LIB" \
    --language swift \
    --out-dir "$PLUGIN_DIR"

# ── 6. Report ───────────────────────────────────────────────────────
DEVICE_SIZE=$(du -h "$XCFW_DIR/ios-arm64/libsecureStorage.a" | cut -f1)
SIM_SIZE=$(du -h "$XCFW_DIR/ios-arm64-simulator/libsecureStorage.a" | cut -f1)

echo "[6/6] Done."
echo ""
echo "  XCFramework: $XCFW_DIR"
echo "  Device lib:  $DEVICE_SIZE"
echo "  Sim lib:     $SIM_SIZE"
echo "  Bindings:    $PLUGIN_DIR/secureStorage.swift"
