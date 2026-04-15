#!/usr/bin/env bash
# Build the secureStorage Rust crate for Android (arm64-v8a + x86_64),
# generate UniFFI Kotlin bindings, and copy the .so + bindings into
# the Android project's jniLibs + java/uniffi trees.
#
# Outputs are gitignored (see .gitignore) and regenerated on demand by
# the Gradle :app:buildRustSecureStorage task (wired as a dependency
# of :app:preBuild) — see android/app/build.gradle.
#
# Usage: bash scripts/build-native-android.sh [--release|--debug|-h]
#        npm run native:build:android          # --release
#        npm run native:build:android:debug    # --debug

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage: build-native-android.sh [--release|--debug] [-h|--help]

  --release   Optimised build (stripped by AGP at packaging time)
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

# Resolve the script's directory even when sourced or symlinked.
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"
RUST_DIR="$ROOT_DIR/wasm"
ANDROID_DIR="$ROOT_DIR/android/app/src/main"
JNILIBS_DIR="$ANDROID_DIR/jniLibs"
JNILIBS_TMP="$JNILIBS_DIR.tmp.$$"
JAVA_DIR="$ANDROID_DIR/java"

cleanup_tmp() {
    rm -rf "$JNILIBS_TMP"
}
trap cleanup_tmp EXIT

# ── 1. Pin the NDK version ──────────────────────────────────────────
#
# Kept in sync with `android.ndkVersion` in android/app/build.gradle.
# Bumping it in one place requires bumping the other.
ANDROID_NDK_VERSION="26.3.11579264"

if [ -z "${ANDROID_NDK_HOME:-}" ]; then
    SDK_DIR="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
    CANDIDATE="$SDK_DIR/ndk/$ANDROID_NDK_VERSION"
    if [ ! -d "$CANDIDATE" ]; then
        cat >&2 <<EOF
error: NDK $ANDROID_NDK_VERSION not found at $CANDIDATE
Install via:
  \$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --install "ndk;$ANDROID_NDK_VERSION"
Or set ANDROID_NDK_HOME to an existing installation of that version.
EOF
        exit 1
    fi
    export ANDROID_NDK_HOME="$CANDIDATE"
fi

# ── 2. Pick the host toolchain slice ────────────────────────────────
#
# NDK prebuilt layout: toolchains/llvm/prebuilt/{host}. Order of
# preference reflects what NDK r26+ ships:
#   darwin-arm64, darwin-x86_64, linux-x86_64, windows-x86_64
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
TOOLCHAIN=""
case "$HOST_OS" in
    Darwin)
        if [ "$HOST_ARCH" = "arm64" ] && [ -d "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/darwin-arm64" ]; then
            TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/darwin-arm64"
        elif [ -d "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64" ]; then
            TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64"
        fi
        ;;
    Linux)
        TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64"
        ;;
    MINGW*|MSYS*|CYGWIN*)
        TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/windows-x86_64"
        ;;
esac
if [ -z "$TOOLCHAIN" ] || [ ! -d "$TOOLCHAIN" ]; then
    echo "error: NDK toolchain not found for host $HOST_OS/$HOST_ARCH under $ANDROID_NDK_HOME/toolchains/llvm/prebuilt" >&2
    exit 1
fi

# ── 3. Resolve minSdkVersion so script + gradle stay aligned ────────
VARIABLES_GRADLE="$ROOT_DIR/android/variables.gradle"
if [ -f "$VARIABLES_GRADLE" ]; then
    ANDROID_API_LEVEL="$(grep -E '^\s*minSdkVersion\s*=' "$VARIABLES_GRADLE" \
        | head -n1 | sed -E 's/[^0-9]//g')"
fi
ANDROID_API_LEVEL="${ANDROID_API_LEVEL:-24}"

echo "=== Building secureStorage for Android ($PROFILE, API $ANDROID_API_LEVEL) ==="
echo "NDK: $ANDROID_NDK_HOME"
echo "Toolchain: $TOOLCHAIN"

cd "$RUST_DIR"

# ── 4. Cargo linker / compiler wiring ───────────────────────────────
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$TOOLCHAIN/bin/aarch64-linux-android${ANDROID_API_LEVEL}-clang"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$TOOLCHAIN/bin/x86_64-linux-android${ANDROID_API_LEVEL}-clang"
export CC_aarch64_linux_android="$TOOLCHAIN/bin/aarch64-linux-android${ANDROID_API_LEVEL}-clang"
export AR_aarch64_linux_android="$TOOLCHAIN/bin/llvm-ar"
export CC_x86_64_linux_android="$TOOLCHAIN/bin/x86_64-linux-android${ANDROID_API_LEVEL}-clang"
export AR_x86_64_linux_android="$TOOLCHAIN/bin/llvm-ar"

# ── 5. Cross-compile ────────────────────────────────────────────────
echo "[1/5] Building aarch64-linux-android + x86_64-linux-android..."
cargo build -p secureStorage --features native $CARGO_FLAGS \
    --target aarch64-linux-android \
    --target x86_64-linux-android

ARM_LIB="$RUST_DIR/target/aarch64-linux-android/$TARGET_DIR/libsecureStorage.so"
X86_LIB="$RUST_DIR/target/x86_64-linux-android/$TARGET_DIR/libsecureStorage.so"

# ── 6. Verify each slice has the right architecture ─────────────────
echo "[2/5] Verifying architectures via file(1)..."
require_arch() {
    local lib="$1"
    local expected="$2"
    local info
    info="$(file "$lib")"
    if ! grep -q "$expected" <<<"$info"; then
        echo "error: $lib is not '$expected': $info" >&2
        exit 3
    fi
}
require_arch "$ARM_LIB" "ARM aarch64"
require_arch "$X86_LIB" "x86-64"

# ── 7. Stage jniLibs atomically ─────────────────────────────────────
echo "[3/5] Staging jniLibs..."
rm -rf "$JNILIBS_TMP"
mkdir -p "$JNILIBS_TMP/arm64-v8a"
mkdir -p "$JNILIBS_TMP/x86_64"
cp "$ARM_LIB" "$JNILIBS_TMP/arm64-v8a/libsecureStorage.so"
cp "$X86_LIB" "$JNILIBS_TMP/x86_64/libsecureStorage.so"

rm -rf "$JNILIBS_DIR"
mv "$JNILIBS_TMP" "$JNILIBS_DIR"

# ── 8. Regenerate UniFFI Kotlin bindings ────────────────────────────
echo "[4/5] Generating UniFFI Kotlin bindings..."
# UniFFI pin lives in wasm/Cargo.toml [workspace.dependencies] at
# =0.31.0 — log the resolved id so any loosening shows up in CI output.
(cd "$RUST_DIR" && cargo pkgid uniffi 2>/dev/null || true)

mkdir -p "$JAVA_DIR"
cargo run -p uniffi-bindgen -- generate \
    --library "$ARM_LIB" \
    --language kotlin \
    --out-dir "$JAVA_DIR"

# ── 9. Report ───────────────────────────────────────────────────────
ARM_SIZE=$(du -h "$JNILIBS_DIR/arm64-v8a/libsecureStorage.so" | cut -f1)
X86_SIZE=$(du -h "$JNILIBS_DIR/x86_64/libsecureStorage.so" | cut -f1)

echo "[5/5] Done."
echo ""
echo "  jniLibs/arm64-v8a: $ARM_SIZE"
echo "  jniLibs/x86_64:    $X86_SIZE"
echo "  Kotlin bindings:   $JAVA_DIR/uniffi/secureStorage/"
