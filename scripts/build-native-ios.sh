#!/usr/bin/env bash
# Build the secureStorage Rust crate for iOS (device + simulator),
# package into an XCFramework, regenerate UniFFI Swift bindings,
# and copy everything into the Xcode project.
#
# Usage: npm run native:build:ios
#        or: bash scripts/build-native-ios.sh [--release|--debug]

set -euo pipefail

PROFILE="${1:-"--release"}"
if [ "$PROFILE" = "--release" ]; then
    CARGO_FLAGS="--release"
    TARGET_DIR="release"
else
    CARGO_FLAGS=""
    TARGET_DIR="debug"
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WASM_DIR="$ROOT_DIR/wasm"
IOS_DIR="$ROOT_DIR/ios/App"
PLUGIN_DIR="$IOS_DIR/App/plugins/secureStorage"
XCFW_DIR="$IOS_DIR/SecureStorage.xcframework"

echo "=== Building secureStorage for iOS ==="

cd "$WASM_DIR"

# ── 1. Cross-compile for device + simulator ─────────────────────────
echo "[1/5] Building aarch64-apple-ios (device)..."
cargo build -p secureStorage --features native $CARGO_FLAGS \
    --target aarch64-apple-ios

echo "[1/5] Building aarch64-apple-ios-sim (simulator)..."
cargo build -p secureStorage --features native $CARGO_FLAGS \
    --target aarch64-apple-ios-sim

DEVICE_LIB="$WASM_DIR/target/aarch64-apple-ios/$TARGET_DIR/libsecureStorage.a"
SIM_LIB="$WASM_DIR/target/aarch64-apple-ios-sim/$TARGET_DIR/libsecureStorage.a"

# ── 2. Strip debug symbols (release only) ───────────────────────────
if [ "$PROFILE" = "--release" ]; then
    echo "[2/5] Stripping debug symbols..."
    strip -S "$DEVICE_LIB"
    strip -S "$SIM_LIB"
else
    echo "[2/5] Skipping strip (debug build)"
fi

# ── 3. Package into XCFramework ─────────────────────────────────────
echo "[3/5] Creating XCFramework..."
rm -rf "$XCFW_DIR"
mkdir -p "$XCFW_DIR/ios-arm64"
mkdir -p "$XCFW_DIR/ios-arm64-simulator"
cp "$DEVICE_LIB" "$XCFW_DIR/ios-arm64/libsecureStorage.a"
cp "$SIM_LIB" "$XCFW_DIR/ios-arm64-simulator/libsecureStorage.a"

cat > "$XCFW_DIR/Info.plist" << 'PLIST'
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

# ── 4. Regenerate UniFFI Swift bindings ──────────────────────────────
echo "[4/5] Generating UniFFI Swift bindings..."
cargo run -p uniffi-bindgen -- generate \
    --library "$DEVICE_LIB" \
    --language swift \
    --out-dir "$PLUGIN_DIR"

# ── 5. Report ────────────────────────────────────────────────────────
DEVICE_SIZE=$(du -h "$XCFW_DIR/ios-arm64/libsecureStorage.a" | cut -f1)
SIM_SIZE=$(du -h "$XCFW_DIR/ios-arm64-simulator/libsecureStorage.a" | cut -f1)

echo "[5/5] Done."
echo ""
echo "  XCFramework: $XCFW_DIR"
echo "  Device lib:  $DEVICE_SIZE"
echo "  Sim lib:     $SIM_SIZE"
echo "  Bindings:    $PLUGIN_DIR/secureStorage.swift"
echo ""
echo "Next: open ios/App/App.xcworkspace in Xcode, add SecureStorage.xcframework"
echo "to Frameworks, and run on device/simulator."
