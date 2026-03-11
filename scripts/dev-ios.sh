#!/bin/bash
#
# Live reload on iOS device over Wi-Fi.
#
# Usage:
#   scripts/dev-ios.sh [device-name]
#
# Prerequisites:
#   1. iPhone on the same Wi-Fi network as your Mac
#      (Wi-Fi debugging is already enabled in Xcode — no USB needed)
#   2. List available devices: npx cap run ios --list
#
# What this script does:
#   1. Detects your local IP on the network
#   2. Builds the SDK
#   3. Sets DEV_SERVER_URL so capacitor.config.ts points the WebView at Vite
#   4. Syncs and deploys to your iOS device
#   5. Starts Vite dev server — edits hot reload on the phone
#
# Why HTTPS?
#   The Web Crypto API (crypto.subtle) only works in "secure contexts".
#   Vite serves HTTPS via vite-plugin-mkcert (self-signed cert).
#   The iOS WebView is patched in MyViewController.swift (debug builds only)
#   to accept self-signed certs.

set -e

DEVICE="$1"

# Detect local IP
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
if [ -z "$LOCAL_IP" ]; then
  echo "ERROR: Could not detect local IP address." >&2
  exit 1
fi

export DEV_SERVER_URL="https://${LOCAL_IP}:5173"
echo "[dev-ios] Local IP: ${LOCAL_IP}"
echo "[dev-ios] Dev server URL: ${DEV_SERVER_URL}"

# Build SDK
echo "[dev-ios] Building SDK..."
npm run build:sdk

# Sync capacitor (picks up DEV_SERVER_URL via capacitor.config.ts)
echo "[dev-ios] Syncing iOS..."
npx cap sync ios

# Deploy to device
echo "[dev-ios] Deploying to device..."
if [ -n "$DEVICE" ]; then
  echo "[dev-ios] Target device: ${DEVICE}"
  npx cap run ios --target "$DEVICE"
else
  echo "[dev-ios] No target specified, opening Xcode..."
  echo "[dev-ios] Select your device in Xcode and hit Run (Cmd+R)."
  npx cap open ios &
fi

# Start Vite dev server (foreground — Ctrl+C to stop)
echo ""
echo "[dev-ios] App deployed! Starting dev server..."
echo "[dev-ios] Hot reload is active. Edit your code and see changes on your phone."
echo "[dev-ios] Press Ctrl+C to stop."
echo ""
npx vite --host
