#!/usr/bin/env bash
# Prints a cargo `--config` value that adds `--remap-path-prefix` flags, so
# that the Rust libraries the app ships (wasm bundles, Android .so, iOS .a)
# do not embed the builder's home directory, user name or checkout path in
# panic messages and debug info.
#
# Usage:
#   cargo build --config "$(bash scripts/rust-remap-flags.sh)" ...
#   cargo build --config "$(bash scripts/rust-remap-flags.sh target.wasm32-unknown-unknown.rustflags)" ...
#
# The argument is the config key, `build.rustflags` by default. A crate whose
# .cargo/config.toml sets `target.<triple>.rustflags` (secure-storage for
# wasm32) must get that key instead: cargo then ignores `build.rustflags`,
# while it joins the arrays of one key, so the crate's own flags stay.
# RUSTFLAGS in the environment is not used for the same reason: it would
# replace the crate's flags instead of adding to them.
set -euo pipefail

key="${1:-build.rustflags}"
root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
home="${HOME:?HOME is not set}"
cargo_home="${CARGO_HOME:-$home/.cargo}"
rustup_home="${RUSTUP_HOME:-$home/.rustup}"

# When several prefixes match a path, rustc applies the one given last, so
# the most specific come last. The neutral prefixes contain no user name.
pairs=(
    "$home=~"
    "$cargo_home=/cargo"
    "$rustup_home=/rustup"
    "$root=/gossip"
)

toml_string() {
    local s="${1//\\/\\\\}"
    printf '"%s"' "${s//\"/\\\"}"
}

out="$key=["
sep=""
for pair in "${pairs[@]}"; do
    out+="$sep$(toml_string "--remap-path-prefix=$pair")"
    sep=","
done
printf '%s]\n' "$out"
