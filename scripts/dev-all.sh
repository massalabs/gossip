#!/bin/bash
#
# Live reload on multiple Android and iOS devices simultaneously.
#
# Device lists can be set via env vars (comma-separated) or CLI args.
# Env vars take precedence over CLI args.
#
# Env vars (in .env or exported):
#   ANDROID_DEVICES="10.26.239.15:5555,10.26.239.20:5555"
#   IOS_DEVICES="iPhone de Ben,iPad de Ben"
#
# Usage (CLI fallback):
#   scripts/dev-all.sh <android-device> [ios-device]
#
# Examples:
#   # Using env vars (recommended for multi-device):
#   ANDROID_DEVICES="10.26.239.15:5555,10.26.239.20:5555" scripts/dev-all.sh
#
#   # Using CLI args (single device each, backwards-compatible):
#   scripts/dev-all.sh 10.26.239.15:5555 "iPhone de Ben"
#   scripts/dev-all.sh 10.26.239.15:5555   # iOS opens Xcode

# Read a var from .env safely (handles special chars like apostrophes)
read_env() {
  local key="$1"
  if [ -f .env ]; then
    grep -E "^${key}=" .env 2>/dev/null | head -1 | sed "s/^${key}=//" || true
  fi
}

# Load device lists: env var > .env file > CLI arg
ANDROID_RAW="${ANDROID_DEVICES:-$(read_env ANDROID_DEVICES)}"
IOS_RAW="${IOS_DEVICES:-$(read_env IOS_DEVICES)}"
ANDROID_RAW="${ANDROID_RAW:-$1}"
IOS_RAW="${IOS_RAW:-$2}"

# Split comma-separated lists into arrays
IFS=',' read -ra ANDROIDS <<< "$ANDROID_RAW"
IFS=',' read -ra IOSES <<< "$IOS_RAW"

# Trim whitespace from device entries
for i in "${!ANDROIDS[@]}"; do
  ANDROIDS[$i]=$(echo "${ANDROIDS[$i]}" | xargs)
done
for i in "${!IOSES[@]}"; do
  IOSES[$i]=$(echo "${IOSES[$i]}" | xargs)
done

# Filter out empty entries
CLEAN_ANDROIDS=()
for d in "${ANDROIDS[@]}"; do [ -n "$d" ] && CLEAN_ANDROIDS+=("$d"); done
ANDROIDS=("${CLEAN_ANDROIDS[@]}")

CLEAN_IOSES=()
for d in "${IOSES[@]}"; do [ -n "$d" ] && CLEAN_IOSES+=("$d"); done
IOSES=("${CLEAN_IOSES[@]}")

if [ ${#ANDROIDS[@]} -eq 0 ] && [ ${#IOSES[@]} -eq 0 ]; then
  echo "Usage: $0 <android-device> [ios-device]" >&2
  echo "" >&2
  echo "Or set env vars (comma-separated for multiple devices):" >&2
  echo "  ANDROID_DEVICES=\"device1,device2\"" >&2
  echo "  IOS_DEVICES=\"device1,device2\"" >&2
  exit 1
fi

# Detect local IP
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || ipconfig getifaddr en6 2>/dev/null || route get default 2>/dev/null | awk '/interface:/{print $2}' | xargs -I{} ipconfig getifaddr {} 2>/dev/null || true)
if [ -z "$LOCAL_IP" ]; then
  echo "ERROR: Could not detect local IP address." >&2
  exit 1
fi

export DEV_SERVER_URL="https://${LOCAL_IP}:5173"
echo "[dev-all] Local IP: ${LOCAL_IP}"
echo "[dev-all] Dev server URL: ${DEV_SERVER_URL}"
echo "[dev-all] Android devices (${#ANDROIDS[@]}): ${ANDROIDS[*]:-none}"
echo "[dev-all] iOS devices (${#IOSES[@]}): ${IOSES[*]:-none}"

# Build SDK once
echo "[dev-all] Building SDK..."
npm run build:sdk

# Filter to only connected devices
echo "[dev-all] Checking connected devices..."

if [ ${#ANDROIDS[@]} -gt 0 ]; then
  ADB_CONNECTED=$(adb devices 2>/dev/null | tail -n +2 | awk '/device$/{print $1}' || true)
  CONNECTED_ANDROIDS=()
  for device in "${ANDROIDS[@]}"; do
    if echo "$ADB_CONNECTED" | grep -qF "$device"; then
      CONNECTED_ANDROIDS+=("$device")
    else
      echo "[dev-all] SKIP Android: ${device} (not connected)"
    fi
  done
  ANDROIDS=("${CONNECTED_ANDROIDS[@]}")
fi

if [ ${#IOSES[@]} -gt 0 ]; then
  # Capacitor --list can miss real devices on some setups.
  # Use Xcode destinations as the source of truth for connected/buildable iOS devices.
  IOS_DESTINATIONS=$(cd ios/App && xcodebuild -workspace App.xcworkspace -scheme Gossip -showdestinations 2>/dev/null || true)
  CONNECTED_IOSES=()
  for device in "${IOSES[@]}"; do
    if echo "$IOS_DESTINATIONS" | grep -qF "id:${device}," || echo "$IOS_DESTINATIONS" | grep -qF "name:${device}"; then
      CONNECTED_IOSES+=("$device")
    else
      echo "[dev-all] SKIP iOS: ${device} (not connected)"
    fi
  done
  IOSES=("${CONNECTED_IOSES[@]}")
fi

echo "[dev-all] Android connected (${#ANDROIDS[@]}): ${ANDROIDS[*]:-none}"
echo "[dev-all] iOS connected (${#IOSES[@]}): ${IOSES[*]:-none}"

if [ ${#ANDROIDS[@]} -eq 0 ] && [ ${#IOSES[@]} -eq 0 ]; then
  echo "[dev-all] No devices connected. Aborting." >&2
  exit 1
fi

# Sync platforms in parallel (only sync platforms that have devices)
echo "[dev-all] Syncing platforms..."
[ ${#ANDROIDS[@]} -gt 0 ] && npx cap sync android &
[ ${#IOSES[@]} -gt 0 ] && npx cap sync ios &
wait

# Start Vite dev server in background, wait for it to be ready
echo "[dev-all] Starting Vite dev server..."
npx vite --host &
VITE_PID=$!

# Wait for Vite to be ready
echo "[dev-all] Waiting for Vite to be ready..."
for i in $(seq 1 30); do
  if curl -sk "$DEV_SERVER_URL" >/dev/null 2>&1; then
    echo "[dev-all] Vite is ready!"
    break
  fi
  if ! kill -0 $VITE_PID 2>/dev/null; then
    echo "[dev-all] ERROR: Vite failed to start." >&2
    exit 1
  fi
  sleep 1
done

# Deploy functions
APK_PATH="android/app/build/outputs/apk/debug/app-debug.apk"

deploy_android() {
  local first=true
  for device in "${ANDROIDS[@]}"; do
    if $first; then
      echo "[dev-all] Building + deploying to Android: ${device}..."
      npx cap run android --target "$device" --no-sync || echo "[dev-all] WARNING: Android deploy failed for ${device}"
      first=false
    else
      # APK already built — just install directly via adb
      echo "[dev-all] Installing APK on Android: ${device}..."
      adb -s "$device" install -r "$APK_PATH" || echo "[dev-all] WARNING: Android install failed for ${device}"
      # Launch the app
      adb -s "$device" shell am start -n "net.massa.gossip/.MainActivity" 2>/dev/null || true
    fi
  done
}

deploy_ios() {
  if [ ${#IOSES[@]} -gt 0 ]; then
    for device in "${IOSES[@]}"; do
      echo "[dev-all] Building + deploying to iOS: ${device}..."
      npx cap run ios --target "$device" --no-sync || echo "[dev-all] WARNING: iOS deploy failed for ${device}"
    done
  else
    echo "[dev-all] No iOS devices specified, opening Xcode..."
    npx cap open ios
  fi
}

# Run Android and iOS deploys in parallel (sequential within each platform)
deploy_android &
ANDROID_PID=$!
deploy_ios &
IOS_PID=$!

wait $ANDROID_PID || true
wait $IOS_PID || true

# Vite is already running — bring it to foreground
TOTAL=$(( ${#ANDROIDS[@]} + ${#IOSES[@]} ))
echo ""
echo "[dev-all] ${TOTAL} device(s) deployed! Hot reload active. Press Ctrl+C to stop."
echo ""
wait $VITE_PID
