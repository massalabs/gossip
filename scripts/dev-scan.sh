#!/bin/bash
#
# Scan for available Android (ADB) and iOS devices.
# Outputs ready-to-paste .env lines.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/ios.sh"

echo "[scan] Looking for devices..."
echo ""

# --- Android: ADB-connected devices ---
ANDROID_LIST=()
if command -v adb &>/dev/null; then
  while read -r line; do
    echo "$line" | grep -q 'device$' || continue
    id=$(echo "$line" | awk '{print $1}')
    [ -z "$id" ] && continue
    # Skip mDNS service names — only keep ip:port or serial numbers
    echo "$id" | grep -q '\._' && continue
    model=$(timeout 3 adb -s "$id" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
    echo "  Android: ${id}  (${model:-unknown})"
    ANDROID_LIST+=("$id")
  done < <(adb devices 2>/dev/null | tail -n +2)
fi

echo ""

# --- iOS: connected devices (USB + wireless) ---
IOS_LIST=()
ios_print_devices
while IFS= read -r udid; do
  [ -z "$udid" ] && continue
  IOS_LIST+=("$udid")
done < <(ios_list_devices)

echo ""
echo "--- Paste into .env ---"
echo ""

if [ ${#ANDROID_LIST[@]} -gt 0 ]; then
  echo "ANDROID_DEVICES=$(IFS=','; echo "${ANDROID_LIST[*]}")"
else
  echo "# ANDROID_DEVICES="
fi

if [ ${#IOS_LIST[@]} -gt 0 ]; then
  echo "IOS_DEVICES=$(IFS=','; echo "${IOS_LIST[*]}")"
else
  echo "# IOS_DEVICES="
fi

echo ""
