#!/bin/bash
#
# Live reload on both Android and iOS devices simultaneously.
#
# Usage:
#   scripts/dev-all.sh <android-device> [ios-device]
#
# Examples:
#   scripts/dev-all.sh 10.26.239.15:5555 "iPhone de Ben"
#   scripts/dev-all.sh 10.26.239.15:5555   # iOS opens Xcode

set -e

ANDROID_DEVICE="$1"
IOS_DEVICE="$2"

if [ -z "$ANDROID_DEVICE" ]; then
  echo "Usage: $0 <android-device> [ios-device]" >&2
  echo "  android-device: required (e.g. 10.26.239.15:5555)" >&2
  echo "  ios-device:     optional (e.g. \"iPhone de Ben\"), opens Xcode if omitted" >&2
  exit 1
fi

# Detect local IP
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
if [ -z "$LOCAL_IP" ]; then
  echo "ERROR: Could not detect local IP address." >&2
  exit 1
fi

export DEV_SERVER_URL="https://${LOCAL_IP}:5173"
echo "[dev-all] Local IP: ${LOCAL_IP}"
echo "[dev-all] Dev server URL: ${DEV_SERVER_URL}"

# Build SDK once
echo "[dev-all] Building SDK..."
npm run build:sdk

# Sync both platforms in parallel
echo "[dev-all] Syncing Android + iOS..."
npx cap sync android &
npx cap sync ios &
wait

# Deploy Android
echo "[dev-all] Deploying to Android: ${ANDROID_DEVICE}..."
npx cap run android --target "$ANDROID_DEVICE" &

# Deploy iOS
if [ -n "$IOS_DEVICE" ]; then
  echo "[dev-all] Deploying to iOS: ${IOS_DEVICE}..."
  npx cap run ios --target "$IOS_DEVICE" &
else
  echo "[dev-all] Opening Xcode for iOS (select device and hit Cmd+R)..."
  npx cap open ios &
fi

wait

# Start Vite dev server (serves both devices)
echo ""
echo "[dev-all] Both devices deployed! Starting dev server..."
echo "[dev-all] Hot reload active on Android + iOS. Press Ctrl+C to stop."
echo ""
npx vite --host
