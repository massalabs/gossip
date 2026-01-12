#!/bin/bash

set -e

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

# Run on device (cap run ios already handles sync automatically)
echo "[run-ios-device] Running on device: $DEVICE"
npx cap run ios --target "$DEVICE"
