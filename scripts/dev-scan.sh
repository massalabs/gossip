#!/bin/bash
#
# Scan for available Android (ADB) and iOS devices.
# Outputs ready-to-paste .env lines.

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

# --- iOS: connected devices (via Capacitor) ---
IOS_LIST=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  udid=$(echo "$line" | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}')
  [ -z "$udid" ] && continue
  echo "$line" | grep -qi 'simulator' && continue
  name=$(echo "$line" | awk -F'  +' '{print $1}' | xargs)
  echo "  iOS: ${name}  (${udid})"
  IOS_LIST+=("$udid")
done < <(npx cap run ios --list 2>/dev/null | tail -n +3)

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
