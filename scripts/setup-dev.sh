#!/usr/bin/env bash
# One-shot dev setup: Rust toolchains, targets, cargo subcommands, and
# platform-specific prerequisites. Idempotent — safe to re-run.
#
# Usage:  npm run setup
#         bash scripts/setup-dev.sh
set -Eeuo pipefail

echo "=== Gossip dev setup ==="

# ── 1. Rust ─────────────────────────────────────────────────────────
command -v rustup >/dev/null || {
    echo "error: rustup not found. Install from https://rustup.rs" >&2
    exit 1
}

rustup toolchain install nightly 2>/dev/null || true
rustup component add rust-src --toolchain nightly
# llvm-ar (bundled here) is used as the wasm32 archiver because zig 0.16's
# bundled ar fails to create archives, and Apple's /usr/bin/ar can't read
# wasm object files. See scripts/build-wasm-secure.sh.
rustup component add llvm-tools-preview --toolchain nightly

RUST_TARGETS=(
    wasm32-unknown-unknown
    aarch64-linux-android
    x86_64-linux-android
    aarch64-apple-ios
    aarch64-apple-ios-sim
)
for t in "${RUST_TARGETS[@]}"; do
    rustup target add "$t"
done

# ── 2. Cargo subcommands ────────────────────────────────────────────
#
# - cargo-ndk       : Android cross-compile helper (replaces manual
#                     NDK toolchain plumbing in build-native-android.sh).
# - cargo-zigbuild  : Drop-in `cargo build` using zig as the C compiler.
#                     Needed for wasm targets that compile C (sqlite-wasm-rs)
#                     without forcing every dev to install Homebrew LLVM.
for crate in cargo-ndk cargo-zigbuild; do
    if ! command -v "$crate" >/dev/null; then
        echo "Installing $crate..."
        cargo install "$crate"
    fi
done

# wasm-bindgen-cli must match the wasm-bindgen lib version pinned in
# wasm/Cargo.lock — bump both together.
WASM_BINDGEN_VERSION="0.2.104"
if [ "$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')" != "$WASM_BINDGEN_VERSION" ]; then
    echo "Installing wasm-bindgen-cli $WASM_BINDGEN_VERSION..."
    cargo install --locked wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION"
fi

# ── 3. Platform deps ────────────────────────────────────────────────
case "$(uname -s)" in
    Darwin)
        if ! command -v zig >/dev/null; then
            echo "Installing zig (for cargo-zigbuild)..."
            if command -v brew >/dev/null; then
                brew install zig
            else
                echo "error: Homebrew not found. Install zig manually:" >&2
                echo "       https://ziglang.org/download/" >&2
                exit 1
            fi
        fi
        ;;
    Linux)
        if ! command -v zig >/dev/null; then
            echo "warning: zig not found. Install from your package manager"
            echo "         or from https://ziglang.org/download/"
        fi
        ;;
esac

# ── 4. Android NDK (optional; only if Android SDK present) ──────────
ANDROID_NDK_VERSION="26.3.11579264"
if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/cmdline-tools/latest/bin" ]; then
    if [ ! -d "$ANDROID_HOME/ndk/$ANDROID_NDK_VERSION" ]; then
        echo "Installing Android NDK $ANDROID_NDK_VERSION..."
        "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
            --install "ndk;$ANDROID_NDK_VERSION"
    fi
else
    echo "note: Android SDK not detected (ANDROID_HOME unset or cmdline-tools missing)."
    echo "      To build for Android, install Android Studio, add to ~/.zshrc:"
    echo "        export ANDROID_HOME=\"\$HOME/Library/Android/sdk\""
    echo "        export PATH=\"\$PATH:\$ANDROID_HOME/cmdline-tools/latest/bin\""
    echo "      then re-run this script."
fi

# ── 5. JS deps ──────────────────────────────────────────────────────
echo "Installing npm deps..."
npm install

echo ""
echo "✓ Setup complete."
echo ""
echo "Next:"
echo "  npm run dev                  # web only, no native build needed"
echo "  npm run build:all ios        # iOS (needs Xcode)"
echo "  npm run build:all android    # Android (needs SDK + NDK)"
