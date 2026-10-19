#!/usr/bin/env bash
# Build the gossip-mobile Rust crate (the mesh node, in the gossip-node
# repository) for Android: .so files into jniLibs and UniFFI Kotlin bindings
# into android/app/src/meshffi/generated. Both outputs are gitignored.
#
# The gossip-node checkout is $GOSSIP_NODE_DIR, or ../gossip-node next to
# this repository. Without it the app builds with the in-memory stub core.
#
# Usage: bash scripts/build-mesh-android.sh [--release|--debug|-h]

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage: build-mesh-android.sh [--release|--debug] [-h|--help]
  --release  Optimised build (default)
  --debug    Unoptimised build with symbols
Env: GOSSIP_NODE_DIR (default ../gossip-node), GOSSIP_MOBILE_TARGET_DIR, JOBS (default 3)
EOF
}

PROFILE="${1:---release}"
case "$PROFILE" in
    --release) CARGO_FLAGS=("--release"); TARGET_DIR="release" ;;
    --debug)   CARGO_FLAGS=();             TARGET_DIR="debug" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown profile '$PROFILE'" >&2; usage >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"
NODE_DIR="${GOSSIP_NODE_DIR:-$ROOT_DIR/../gossip-node}"
if [[ ! -f "$NODE_DIR/crates/gossip-mobile/Cargo.toml" ]]; then
    echo "error: no gossip-mobile crate under $NODE_DIR (set GOSSIP_NODE_DIR)" >&2
    exit 1
fi
NODE_DIR="$(cd -P "$NODE_DIR" && pwd)"
ANDROID_DIR="$ROOT_DIR/android/app/src"
JNILIBS_DIR="$ANDROID_DIR/main/jniLibs"
BINDINGS_DIR="$ANDROID_DIR/meshffi/generated"
GRADLE_PROPS="$ROOT_DIR/android/gradle.properties"
# Our own target dir, so this build never races another build of the
# gossip-node workspace over its target/.
export CARGO_TARGET_DIR="${GOSSIP_MOBILE_TARGET_DIR:-$ROOT_DIR/android/app/build/gossip-mobile-target}"

read_prop() {
    awk -F= -v k="$1" '$1==k {sub(/[ \t\r]+$/, "", $2); print $2}' "$GRADLE_PROPS"
}

# Same NDK choice as build-native-android.sh: the pinned one if installed,
# else ANDROID_NDK_HOME, else the newest under $ANDROID_HOME/ndk.
SDK_DIR="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
PINNED_NDK="$SDK_DIR/ndk/$(read_prop 'gossip.ndkVersion')"
if [[ -d "$PINNED_NDK" ]]; then
    NDK="$PINNED_NDK"
elif [[ -n "${ANDROID_NDK_HOME:-}" ]]; then
    NDK="$ANDROID_NDK_HOME"
else
    NDK="$(ls -d "$SDK_DIR"/ndk/* 2>/dev/null | sort -V | tail -1 || true)"
fi
[[ -d "$NDK" ]] || { echo "error: no Android NDK found (set ANDROID_NDK_HOME)" >&2; exit 1; }
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$(uname -s | tr '[:upper:]' '[:lower:]')-x86_64/bin"
API=24

IFS=',' read -ra ABI_LIST <<< "$(read_prop 'gossip.abis')"

echo "=== Building gossip-mobile for Android ($PROFILE) ==="
echo "gossip-node: $NODE_DIR"
echo "NDK:         $NDK"
echo "ABIs:        ${ABI_LIST[*]}"

# Run cargo from the gossip-node checkout so its pinned toolchain applies.
cd "$NODE_DIR"

TMP_JNILIBS="$JNILIBS_DIR.mesh.tmp.$$"
TMP_BINDINGS="$BINDINGS_DIR.tmp.$$"
trap 'rm -rf "$TMP_JNILIBS" "$TMP_BINDINGS"' EXIT

echo "[1/2] cargo build (${ABI_LIST[*]})..."
LIB=""
for abi in "${ABI_LIST[@]}"; do
    case "$abi" in
        arm64-v8a)   target=aarch64-linux-android;   expected="aarch64" ;;
        armeabi-v7a) target=armv7-linux-androideabi; expected="ARM" ;;
        x86_64)      target=x86_64-linux-android;    expected="x86-64" ;;
        *) echo "error: unknown ABI $abi" >&2; exit 1 ;;
    esac
    rustup target add "$target" >/dev/null
    clang_target="${target/armv7/armv7a}"
    env_target="${target//-/_}"
    cc="$TOOLCHAIN/${clang_target}${API}-clang"
    upper="$(echo "$env_target" | tr '[:lower:]' '[:upper:]')"
    export "CC_${env_target}=$cc" "AR_${env_target}=$TOOLCHAIN/llvm-ar" "CARGO_TARGET_${upper}_LINKER=$cc"
    cargo build -p gossip-mobile --target "$target" -j "${JOBS:-3}" \
        ${CARGO_FLAGS[@]+"${CARGO_FLAGS[@]}"}
    so="$CARGO_TARGET_DIR/$target/$TARGET_DIR/libgossip_mobile.so"
    if ! file "$so" | grep -q "$expected"; then
        echo "error: $so does not look like $expected (file: $(file -b "$so"))" >&2
        exit 1
    fi
    mkdir -p "$TMP_JNILIBS/$abi"
    cp "$so" "$TMP_JNILIBS/$abi/"
    LIB="$so"
done

echo "[2/2] UniFFI Kotlin bindings..."
mkdir -p "$TMP_BINDINGS"
cargo run -q -p gossip-mobile --features bindgen --bin uniffi-bindgen -j "${JOBS:-3}" -- \
    generate --library "$LIB" --language kotlin --out-dir "$TMP_BINDINGS" --no-format

# Install only what changed, so Gradle's fingerprint stays stable.
install_if_changed() {
    local src=$1 dst=$2
    mkdir -p "$(dirname "$dst")"
    if [[ ! -e $dst ]] || ! cmp -s "$src" "$dst"; then
        cp "$src" "$dst"
    fi
}

for abi in "${ABI_LIST[@]}"; do
    install_if_changed "$TMP_JNILIBS/$abi/libgossip_mobile.so" "$JNILIBS_DIR/$abi/libgossip_mobile.so"
done
shopt -s nullglob globstar
for src in "$TMP_BINDINGS"/**/*.kt; do
    install_if_changed "$src" "$BINDINGS_DIR/${src#"$TMP_BINDINGS/"}"
done
shopt -u nullglob globstar

for abi in "${ABI_LIST[@]}"; do
    echo "  jniLibs/$abi: $(du -h "$JNILIBS_DIR/$abi/libgossip_mobile.so" | cut -f1)"
done
echo "  Kotlin bindings: $BINDINGS_DIR"
