#!/usr/bin/env bash
# Build the secureStorage Rust crate for Android, drop the .so files
# into jniLibs, and regenerate UniFFI Kotlin bindings.
#
# Outputs are gitignored; regenerated on demand by the Gradle
# `:app:buildRustSecureStorage` task (wired before `:app:preBuild`).
#
# NDK version + ABI list are read from android/gradle.properties so
# this script and android/app/build.gradle cannot drift.
#
# Usage: bash scripts/build-native-android.sh [--release|--debug|-h]

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage: build-native-android.sh [--release|--debug] [-h|--help]
  --release  Optimised build (stripped by AGP at packaging time, default)
  --debug    Unoptimised build with symbols
EOF
}

# Default to --release. Debug Rust is ~10-50x slower on PQ crypto;
# forgetting the flag here used to poison the Gradle cache with a
# debug .so that silently persists across subsequent builds.
PROFILE="${1:---release}"
case "$PROFILE" in
    --release) CARGO_FLAGS=("--release"); TARGET_DIR="release" ;;
    --debug)   CARGO_FLAGS=();             TARGET_DIR="debug" ;;
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
ANDROID_DIR="$ROOT_DIR/android/app/src/main"
JNILIBS_DIR="$ANDROID_DIR/jniLibs"
JAVA_DIR="$ANDROID_DIR/java"
GRADLE_PROPS="$ROOT_DIR/android/gradle.properties"

read_prop() {
    local key=$1
    awk -F= -v k="$key" '$1==k {sub(/[ \t\r]+$/, "", $2); print $2}' "$GRADLE_PROPS"
}

ANDROID_NDK_VERSION="$(read_prop 'gossip.ndkVersion')"
if [ -z "$ANDROID_NDK_VERSION" ]; then
    echo "error: gossip.ndkVersion missing from $GRADLE_PROPS" >&2
    exit 1
fi
ANDROID_ABIS="$(read_prop 'gossip.abis')"
if [ -z "$ANDROID_ABIS" ]; then
    echo "error: gossip.abis missing from $GRADLE_PROPS" >&2
    exit 1
fi

# Always prefer the pinned NDK from $ANDROID_HOME/ndk/<version>. If it
# is present, override $ANDROID_NDK_HOME so cargo-ndk uses the same
# toolchain AGP declares (build.gradle:ndkVersion). If only a
# differently-versioned $ANDROID_NDK_HOME is preset (typical CI), warn
# and fall back rather than fail, since a minor NDK mismatch is
# usually cosmetic for our cdylib output.
PINNED_NDK_PATH="${ANDROID_HOME:-$HOME/Library/Android/sdk}/ndk/$ANDROID_NDK_VERSION"
if [ -d "$PINNED_NDK_PATH" ]; then
    if [ -n "${ANDROID_NDK_HOME:-}" ] && [ "$ANDROID_NDK_HOME" != "$PINNED_NDK_PATH" ]; then
        echo "warning: ANDROID_NDK_HOME=$ANDROID_NDK_HOME does not match"
        echo "  the pinned NDK $ANDROID_NDK_VERSION at $PINNED_NDK_PATH;"
        echo "  using the pinned one"
    fi
    export ANDROID_NDK_HOME="$PINNED_NDK_PATH"
elif [ -z "${ANDROID_NDK_HOME:-}" ]; then
    cat >&2 <<EOF
error: NDK $ANDROID_NDK_VERSION not found at $PINNED_NDK_PATH
Install via:
  \$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --install "ndk;$ANDROID_NDK_VERSION"
EOF
    exit 1
else
    echo "warning: pinned NDK $ANDROID_NDK_VERSION not installed at"
    echo "  $PINNED_NDK_PATH; falling back to ANDROID_NDK_HOME=$ANDROID_NDK_HOME"
    echo "  (the .so may have a different sysroot than declared in build.gradle)"
fi

# Build the cargo-ndk -t arg list from the gradle.properties ABI csv.
NDK_TARGET_ARGS=()
IFS=',' read -ra ABI_LIST <<< "$ANDROID_ABIS"
for abi in "${ABI_LIST[@]}"; do
    NDK_TARGET_ARGS+=("-t" "$abi")
done

echo "=== Building secureStorage for Android ($PROFILE) ==="
echo "NDK:  $ANDROID_NDK_HOME"
echo "ABIs: $ANDROID_ABIS"

cd "$RUST_DIR"

# Stage .so + Kotlin bindings into temp dirs and only install them
# into the committed jniLibs/java tree at the very end. Asymmetric
# staging (.so in place before bindgen runs) risks shipping a new
# ABI .so alongside stale Kotlin wrappers if bindgen fails or the
# user kills the script between steps - silent UnsatisfiedLinkError /
# ABI mismatch at the first FFI call.
TMP_JNILIBS="$JNILIBS_DIR.tmp.$$"
TMP_BINDINGS="$JAVA_DIR/uniffi.tmp.$$"
trap 'rm -rf "$TMP_JNILIBS" "$TMP_BINDINGS"' EXIT

echo "[1/2] cargo ndk build ($ANDROID_ABIS)..."
cargo ndk \
    "${NDK_TARGET_ARGS[@]}" \
    -o "$TMP_JNILIBS" \
    build -p secureStorage --features native --no-default-features "${CARGO_FLAGS[@]}"

# Belt-and-suspenders: cargo-ndk trusts the toolchain it picks up, so
# a host-build leak would slip through. file(1) string per Android
# ABI; case rather than an associative array so the script runs on
# macOS bash 3.2.
for abi in "${ABI_LIST[@]}"; do
    so="$TMP_JNILIBS/$abi/libsecureStorage.so"
    case "$abi" in
        arm64-v8a)   expected="aarch64" ;;
        armeabi-v7a) expected="ARM" ;;
        x86_64)      expected="x86-64" ;;
        x86)         expected="80386" ;;
        *)
            echo "warning: no arch heuristic for ABI '$abi'; skipping arch check"
            continue
            ;;
    esac
    if ! file "$so" | grep -q "$expected"; then
        echo "error: $so does not look like $expected (file: $(file -b "$so"))" >&2
        exit 1
    fi
done

echo "[2/2] UniFFI Kotlin bindings..."
mkdir -p "$TMP_BINDINGS"
cargo run -p uniffi-bindgen -- generate \
    --library "$RUST_DIR/target/aarch64-linux-android/$TARGET_DIR/libsecureStorage.so" \
    --language kotlin \
    --out-dir "$TMP_BINDINGS"

# Install both products. Skip the cp when content is unchanged so
# Gradle's input fingerprint stays stable and AGP does not repackage +
# re-sign the AAR every build.
install_if_changed() {
    local src=$1 dst=$2
    mkdir -p "$(dirname "$dst")"
    if [[ ! -e $dst ]] || ! cmp -s "$src" "$dst"; then
        cp "$src" "$dst"
    fi
}

for abi in "${ABI_LIST[@]}"; do
    install_if_changed "$TMP_JNILIBS/$abi/libsecureStorage.so" \
                       "$JNILIBS_DIR/$abi/libsecureStorage.so"
done

# UniFFI emits under <out>/uniffi/secureStorage/. Mirror the same
# subtree under java/uniffi/.
shopt -s nullglob
for src in "$TMP_BINDINGS/uniffi"/*/*.kt; do
    rel=${src#"$TMP_BINDINGS/"}
    install_if_changed "$src" "$JAVA_DIR/$rel"
done
shopt -u nullglob

for abi in "${ABI_LIST[@]}"; do
    sz=$(du -h "$JNILIBS_DIR/$abi/libsecureStorage.so" | cut -f1)
    echo "  jniLibs/$abi: $sz"
done
echo "  Kotlin bindings: $JAVA_DIR/uniffi/secureStorage/"
