#!/bin/bash
#
# Live reload on Android device over Wi-Fi.
#
# Usage:
#   scripts/dev-android.sh <device>
#
# Prerequisites:
#   1. Connect your phone via ADB Wi-Fi:
#        adb connect <phone-ip>:5555
#   2. Verify it shows up:
#        adb devices
#
# What this script does:
#   1. Detects your local IP on the network
#   2. Builds the SDK
#   3. Starts Vite dev server with --host (HTTPS, needed for crypto.subtle)
#   4. Sets DEV_SERVER_URL so capacitor.config.ts points the WebView at Vite
#   5. Syncs and deploys to your Android device
#   6. Vite stays running — edits hot reload on the phone
#
# Why HTTPS?
#   The Web Crypto API (crypto.subtle) only works in "secure contexts".
#   Vite serves HTTPS via vite-plugin-mkcert (self-signed cert).
#   The Android WebView is patched in MainActivity.java (debug builds only)
#   to accept self-signed certs — so HTTPS works without installing a CA.

set -e

DEVICE="$1"

if [ -z "$DEVICE" ]; then
  # Try to load ANDROID_DEVICES from .env before failing
  if [ -f ".env" ]; then
    # shellcheck disable=SC2046
    ANDROID_DEVICES_FROM_ENV=$(grep '^ANDROID_DEVICES=' .env | tail -n 1 | cut -d '=' -f2- | tr -d '"' | tr -d "'")
    if [ -n "$ANDROID_DEVICES_FROM_ENV" ]; then
      DEVICE="$ANDROID_DEVICES_FROM_ENV"
      echo "[dev-android] Using ANDROID_DEVICES from .env: ${DEVICE}"
    fi
  fi

  if [ -z "$DEVICE" ]; then
    echo "ERROR: Missing device target." >&2
    echo "" >&2
    echo "Usage: $0 <device>" >&2
    echo "" >&2
    echo "Find your device target with:" >&2
    echo "  adb devices" >&2
    echo "" >&2
    echo "Example:" >&2
    echo "  $0 10.26.239.15:5555" >&2
    echo "" >&2
    echo "Or set ANDROID_DEVICES in your .env file." >&2
    exit 1
  fi
fi

# Detect local IP
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$LOCAL_IP" ]; then
  echo "ERROR: Could not detect local IP address." >&2
  exit 1
fi

export DEV_SERVER_URL="https://${LOCAL_IP}:5173"
echo "[dev-android] Local IP: ${LOCAL_IP}"
echo "[dev-android] Dev server URL: ${DEV_SERVER_URL}"
echo "[dev-android] Target device: ${DEVICE}"

# Build SDK
echo "[dev-android] Building SDK..."
npm run build:sdk

# Sync capacitor (picks up DEV_SERVER_URL via capacitor.config.ts)
echo "[dev-android] Syncing Android..."
npx cap sync android

# Deploy to device
echo "[dev-android] Deploying to device..."
npx cap run android --target "$DEVICE"

# Start Vite dev server (foreground — Ctrl+C to stop)
echo ""
echo "[dev-android] App deployed! Starting dev server..."
echo "[dev-android] Hot reload is active. Edit your code and see changes on your phone."
echo "[dev-android] Press Ctrl+C to stop."
echo ""
npx vite --host
