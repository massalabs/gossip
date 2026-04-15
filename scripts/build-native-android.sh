#!/usr/bin/env bash
# Build the secureStorage Rust crate for Android (arm64-v8a + x86_64),
# drop the .so files into jniLibs, and regenerate UniFFI Kotlin bindings.
#
# Outputs are gitignored; regenerated on demand by the Gradle
# `:app:buildRustSecureStorage` task (wired before `:app:preBuild`).
#
# Usage: bash scripts/build-native-android.sh [--release|--debug|-h]

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage: build-native-android.sh [--release|--debug] [-h|--help]
  --release  Optimised build (stripped by AGP at packaging time)
  --debug    Unoptimised build with symbols (default)
EOF
}

PROFILE="${1:---debug}"
case "$PROFILE" in
    --release) CARGO_FLAGS="--release"; TARGET_DIR="release" ;;
    --debug)   CARGO_FLAGS="";          TARGET_DIR="debug" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown profile '$PROFILE'" >&2; usage >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"
RUST_DIR="$ROOT_DIR/wasm"
ANDROID_DIR="$ROOT_DIR/android/app/src/main"
JNILIBS_DIR="$ANDROID_DIR/jniLibs"
JAVA_DIR="$ANDROID_DIR/java"

# NDK version pinned to match `android.ndkVersion` in
# android/app/build.gradle. cargo-ndk auto-detects the NDK when
# ANDROID_NDK_HOME or ANDROID_HOME/ndk/<ver> is set.
ANDROID_NDK_VERSION="26.3.11579264"
if [ -z "${ANDROID_NDK_HOME:-}" ]; then
    SDK_DIR="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
    export ANDROID_NDK_HOME="$SDK_DIR/ndk/$ANDROID_NDK_VERSION"
fi
if [ ! -d "$ANDROID_NDK_HOME" ]; then
    cat >&2 <<EOF
error: NDK $ANDROID_NDK_VERSION not found at $ANDROID_NDK_HOME
Install via:
  \$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --install "ndk;$ANDROID_NDK_VERSION"
EOF
    exit 1
fi

echo "=== Building secureStorage for Android ($PROFILE) ==="
echo "NDK: $ANDROID_NDK_HOME"

cd "$RUST_DIR"

# 1. `cargo ndk` cross-compiles for each --target, sets CC_*/AR_* and
#    the per-target linker, then copies the produced .so into
#    <output>/<abi>/libname.so. Replaces the manual host-toolchain
#    detection, env plumbing, `file(1)` arch verification, and atomic
#    jniLibs staging we carried before.
echo "[1/2] cargo ndk build (arm64-v8a + x86_64)..."
cargo ndk \
    -t arm64-v8a \
    -t x86_64 \
    -o "$JNILIBS_DIR" \
    build -p secureStorage --features native --no-default-features $CARGO_FLAGS

# 2. UniFFI Kotlin bindings. Emit under <out>/uniffi/secureStorage/.
#    UniFFI version pinned centrally via workspace.dependencies.
echo "[2/2] UniFFI Kotlin bindings..."
mkdir -p "$JAVA_DIR"
cargo run -p uniffi-bindgen -- generate \
    --library "$RUST_DIR/target/aarch64-linux-android/$TARGET_DIR/libsecureStorage.so" \
    --language kotlin \
    --out-dir "$JAVA_DIR" >/dev/null

ARM_SIZE=$(du -h "$JNILIBS_DIR/arm64-v8a/libsecureStorage.so" | cut -f1)
X86_SIZE=$(du -h "$JNILIBS_DIR/x86_64/libsecureStorage.so" | cut -f1)
echo ""
echo "  jniLibs/arm64-v8a: $ARM_SIZE"
echo "  jniLibs/x86_64:    $X86_SIZE"
echo "  Kotlin bindings:   $JAVA_DIR/uniffi/secureStorage/"
