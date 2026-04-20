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

# --- iOS: connected devices (via xctrace, then Capacitor fallback) ---
IOS_LIST=()

# Try xcrun xctrace first — detects both USB and WiFi-connected devices
if command -v xcrun &>/dev/null; then
  in_devices=false
  while IFS= read -r line; do
    if echo "$line" | grep -q '^== Devices ==$'; then
      in_devices=true; continue
    fi
    if echo "$line" | grep -q '^=='; then
      in_devices=false; continue
    fi
    $in_devices || continue
    echo "$line" | grep -qi 'simulator' && continue
    echo "$line" | grep -qi 'macbook\|mac pro\|mac mini\|imac\|mac studio' && continue
    [ -z "$line" ] && continue
    udid=$(echo "$line" | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}')
    [ -z "$udid" ] && continue
    # Skip if already seen (xctrace can list USB + Wi-Fi pairing separately)
    if [ ${#IOS_LIST[@]} -gt 0 ] && printf '%s\n' "${IOS_LIST[@]}" | grep -qx "$udid"; then
      continue
    fi
    name=$(echo "$line" | sed 's/ ([^)]*) *$//' | xargs)
    echo "  iOS: ${name}  (${udid})"
    IOS_LIST+=("$udid")
  done < <(xcrun xctrace list devices 2>/dev/null)
fi

# Fallback to Capacitor if xctrace found nothing
if [ ${#IOS_LIST[@]} -eq 0 ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    udid=$(echo "$line" | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}')
    [ -z "$udid" ] && continue
    echo "$line" | grep -qi 'simulator' && continue
    if [ ${#IOS_LIST[@]} -gt 0 ] && printf '%s\n' "${IOS_LIST[@]}" | grep -qx "$udid"; then
      continue
    fi
    name=$(echo "$line" | awk -F'  +' '{print $1}' | xargs)
    echo "  iOS: ${name}  (${udid})"
    IOS_LIST+=("$udid")
  done < <(npx cap run ios --list 2>/dev/null | tail -n +3)
fi

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
