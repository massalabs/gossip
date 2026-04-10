#!/usr/bin/env bash
# Build the secureStorage Rust crate for Android (aarch64 + x86_64),
# generate UniFFI Kotlin bindings, and copy the .so + bindings into
# the Android project's jniLibs.
#
# Usage: npm run native:build:android
#        or: bash scripts/build-native-android.sh [--release|--debug]

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
ANDROID_DIR="$ROOT_DIR/android/app/src/main"
JNILIBS_DIR="$ANDROID_DIR/jniLibs"

# Find NDK
if [ -z "${ANDROID_NDK_HOME:-}" ]; then
    # Try the default Android SDK location
    SDK_DIR="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
    # Pick the latest NDK version available
    NDK_DIR=$(ls -d "$SDK_DIR/ndk/"* 2>/dev/null | sort -V | tail -1)
    if [ -z "$NDK_DIR" ]; then
        echo "ERROR: ANDROID_NDK_HOME not set and no NDK found in $SDK_DIR/ndk/"
        exit 1
    fi
    export ANDROID_NDK_HOME="$NDK_DIR"
fi

TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64"
if [ ! -d "$TOOLCHAIN" ]; then
    TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64"
fi
if [ ! -d "$TOOLCHAIN" ]; then
    echo "ERROR: NDK toolchain not found at $TOOLCHAIN"
    exit 1
fi

echo "=== Building secureStorage for Android ==="
echo "NDK: $ANDROID_NDK_HOME"

cd "$WASM_DIR"

# ── 1. Set up cargo linker config for Android targets ────────────────
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$TOOLCHAIN/bin/aarch64-linux-android21-clang"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$TOOLCHAIN/bin/x86_64-linux-android21-clang"
export CC_aarch64_linux_android="$TOOLCHAIN/bin/aarch64-linux-android21-clang"
export AR_aarch64_linux_android="$TOOLCHAIN/bin/llvm-ar"
export CC_x86_64_linux_android="$TOOLCHAIN/bin/x86_64-linux-android21-clang"
export AR_x86_64_linux_android="$TOOLCHAIN/bin/llvm-ar"

# ── 2. Cross-compile ─────────────────────────────────────────────────
echo "[1/4] Building aarch64-linux-android (arm64)..."
cargo build -p secureStorage --features native $CARGO_FLAGS \
    --target aarch64-linux-android

echo "[1/4] Building x86_64-linux-android (emulator)..."
cargo build -p secureStorage --features native $CARGO_FLAGS \
    --target x86_64-linux-android

# ── 3. Copy .so into jniLibs ─────────────────────────────────────────
echo "[2/4] Copying .so to jniLibs..."
mkdir -p "$JNILIBS_DIR/arm64-v8a"
mkdir -p "$JNILIBS_DIR/x86_64"

cp "$WASM_DIR/target/aarch64-linux-android/$TARGET_DIR/libsecureStorage.so" \
   "$JNILIBS_DIR/arm64-v8a/libsecureStorage.so"

cp "$WASM_DIR/target/x86_64-linux-android/$TARGET_DIR/libsecureStorage.so" \
   "$JNILIBS_DIR/x86_64/libsecureStorage.so"

# ── 4. Generate UniFFI Kotlin bindings ───────────────────────────────
echo "[3/4] Generating UniFFI Kotlin bindings..."
# UniFFI generates files into a subdirectory matching the package name
# (uniffi/secureStorage/), so we point --out-dir at the java root.
JAVA_DIR="$ANDROID_DIR/java"
mkdir -p "$JAVA_DIR"

cargo run -p uniffi-bindgen -- generate \
    --library "$WASM_DIR/target/aarch64-linux-android/$TARGET_DIR/libsecureStorage.so" \
    --language kotlin \
    --out-dir "$JAVA_DIR"

# ── 5. Report ────────────────────────────────────────────────────────
ARM_SIZE=$(du -h "$JNILIBS_DIR/arm64-v8a/libsecureStorage.so" | cut -f1)
X86_SIZE=$(du -h "$JNILIBS_DIR/x86_64/libsecureStorage.so" | cut -f1)
KOTLIN_OUT="$JAVA_DIR/uniffi/secureStorage"

echo "[4/4] Done."
echo ""
echo "  jniLibs/arm64-v8a: $ARM_SIZE"
echo "  jniLibs/x86_64:    $X86_SIZE"
echo "  Kotlin bindings:   $KOTLIN_OUT/"
echo ""
echo "Next: uncomment registerPlugin(SecureStoragePlugin.class) in MainActivity.java"
echo "and run: npx cap sync android"
