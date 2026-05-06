#!/usr/bin/env bash
# Build the secureStorage Rust crate for wasm32-unknown-unknown (web),
# regenerate wasm-bindgen JS glue, and emit an index.js re-export.
#
# Usage: bash scripts/build-wasm-secure.sh
#
# Why AR_wasm32_unknown_unknown is set:
#   zig 0.16's bundled llvm-ar fails to create archives, and Apple's
#   /usr/bin/ar can't read wasm object files. Rust's llvm-tools-preview
#   ships a working llvm-ar that handles wasm. cargo-zigbuild honors
#   AR_<target> when set in the environment (add_env_if_missing).

set -Eeuo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"
SDK_GEN="$ROOT_DIR/gossip-sdk/src/assets/generated/wasm-secureStorage"

SYSROOT="$(rustc +nightly --print sysroot)"
HOST="$(rustc +nightly -vV | sed -n 's/^host: //p')"
LLVM_AR="$SYSROOT/lib/rustlib/$HOST/bin/llvm-ar"
[ -x "$LLVM_AR" ] || {
    echo "error: llvm-ar not found at $LLVM_AR" >&2
    echo "       run: rustup component add llvm-tools-preview --toolchain nightly" >&2
    exit 1
}

echo "=== Building secureStorage for wasm32 (web) ==="

cd "$ROOT_DIR/wasm/secure-storage"
echo "[1/3] cargo zigbuild (wasm32-unknown-unknown)..."
AR_wasm32_unknown_unknown="$LLVM_AR" \
    cargo +nightly zigbuild --lib --release \
        --target wasm32-unknown-unknown --features wasm

echo "[2/3] wasm-bindgen JS glue..."
wasm-bindgen --target web --out-dir "$SDK_GEN" \
    "$ROOT_DIR/wasm/target/wasm32-unknown-unknown/release/secureStorage.wasm"
rm -f "$SDK_GEN/.gitignore"

echo "[3/3] index.js re-export..."
cat > "$SDK_GEN/index.js" <<'EOF'
export * from "./secureStorage.js";
export { default } from "./secureStorage.js";
EOF

echo ""
echo "  Output: $SDK_GEN"
