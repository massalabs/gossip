#!/usr/bin/env bash
# Build everything needed for a full deploy (web + iOS + Android).
#
# Usage:
#   npm run build:all                      # release, all targets
#   bash scripts/build-all.sh web          # web assets only
#   bash scripts/build-all.sh ios          # wasm + web + iOS native + cap sync
#   bash scripts/build-all.sh android      # wasm + web + Android native + cap sync
#   bash scripts/build-all.sh all --debug  # everything, debug native
#
# Order of operations (for targets that include a native shell):
#   1. Rust wasm + secure-storage wasm  (JS consumers of the wasm)
#   2. npm run build                     (web assets into dist/)
#   3. native Rust build                 (iOS .a / Android .so)
#   4. cap sync                          (copy dist/ + native into shell)

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage: build-all.sh [web|ios|android|all] [--release|--debug] [-h|--help]

  web       Build the web bundle only
  ios       wasm + web + iOS native + cap sync ios
  android   wasm + web + Android native + cap sync android
  all       everything (default)
  --release Optimised native builds (default)
  --debug   Debug native builds (fast iteration)
  -h|--help Show this message
EOF
}

TARGET="all"
MODE="--release"
for arg in "$@"; do
    case "$arg" in
        web|ios|android|all) TARGET="$arg" ;;
        --release|--debug)   MODE="$arg" ;;
        -h|--help)           usage; exit 0 ;;
        *)
            echo "error: unknown argument '$arg'" >&2
            usage >&2
            exit 2
            ;;
    esac
done

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

CURRENT_STAGE="init"
trap 'rc=$?; echo "error: build:all failed during stage \"$CURRENT_STAGE\" (exit $rc)" >&2; exit "$rc"' ERR

run_stage() {
    CURRENT_STAGE="$1"
    shift
    echo ""
    echo "=== [$CURRENT_STAGE] ==="
    "$@"
}

build_wasm() {
    run_stage "wasm:secure" npm run wasm:build:secure
    run_stage "wasm:main"   npm run wasm:build
}

build_web() {
    run_stage "npm:build" npm run build
}

case "$TARGET" in
    web)
        build_wasm
        build_web
        ;;
    ios)
        build_wasm
        build_web
        run_stage "native:ios" bash scripts/build-native-ios.sh "$MODE"
        run_stage "cap:sync"   npx cap sync ios
        ;;
    android)
        build_wasm
        build_web
        run_stage "native:android" bash scripts/build-native-android.sh "$MODE"
        run_stage "cap:sync"       npx cap sync android
        ;;
    all)
        build_wasm
        build_web
        run_stage "native:ios"     bash scripts/build-native-ios.sh "$MODE"
        run_stage "native:android" bash scripts/build-native-android.sh "$MODE"
        run_stage "cap:sync"       npx cap sync
        ;;
esac

echo ""
echo "=== Done: $TARGET ($MODE) ==="
