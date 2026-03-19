#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/ios.sh"

DEVICE="$1"

if [ -z "$DEVICE" ]; then
  echo "ERROR: Missing device name argument." >&2
  echo "Usage: npm run cap:run:ios:device -- \"Device Name\"" >&2
  echo "" >&2
  echo "First, list available devices with: npm run cap:list:ios" >&2
  exit 1
fi

echo "[run-ios-device] Building and running on device: $DEVICE"

# Build
echo "[run-ios-device] Building web assets..."
npm run build

# Build and deploy to device
echo "[run-ios-device] Deploying to device: $DEVICE"
ios_build_and_deploy "$DEVICE"
