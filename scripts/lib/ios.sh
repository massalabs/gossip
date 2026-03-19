#!/bin/bash
#
# Shared iOS helpers for device detection and deployment.
# Supports both USB (ios-deploy) and wireless (devicectl) connections.
#
# Usage: source scripts/lib/ios.sh

# List connected iOS device UDIDs.
# Tries Capacitor (USB) first, falls back to xctrace (wireless).
# Output: one UDID per line
ios_list_devices() {
  local found=()

  # Try Capacitor / ios-deploy first
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local udid
    udid=$(echo "$line" | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}')
    [ -z "$udid" ] && continue
    echo "$line" | grep -qi 'simulator' && continue
    found+=("$udid")
  done < <(npx cap run ios --list 2>/dev/null | tail -n +3)

  # Fallback: xctrace detects wireless devices that ios-deploy misses
  if [ ${#found[@]} -eq 0 ]; then
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      local udid
      udid=$(echo "$line" | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}')
      [ -z "$udid" ] && continue
      found+=("$udid")
    done < <(xcrun xctrace list devices 2>/dev/null \
      | sed -n '/== Devices ==/,/== Devices Offline/p' \
      | grep -v '== Devices' \
      | grep -v 'MacBook\|Macmini\|iMac\|Mac Pro\|Mac Studio')
  fi

  printf '%s\n' "${found[@]}"
}

# Print "  iOS: <name>  (<udid>)" for each connected device.
ios_print_devices() {
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # Try xctrace for the friendly name
    local name
    name=$(xcrun xctrace list devices 2>/dev/null \
      | grep "$line" \
      | sed 's/ (.*//' \
      | head -1)
    echo "  iOS: ${name:-unknown}  (${line})"
  done < <(ios_list_devices)
}

# Build the iOS app and deploy to the given device UDID.
# Uses xcodebuild + devicectl (works over USB and wireless).
#
# Usage: ios_build_and_deploy <udid> [derived-data-path]
ios_build_and_deploy() {
  local device="$1"
  local derived_data="${2:-ios/App/DerivedData}"

  echo "[ios] Building iOS app..."
  xcodebuild build \
    -workspace ios/App/App.xcworkspace \
    -scheme Gossip \
    -configuration Debug \
    -destination "generic/platform=iOS" \
    -derivedDataPath "$derived_data" \
    -allowProvisioningUpdates \
    -quiet \
    || { echo "[ios] ERROR: Build failed"; return 1; }

  local app_path
  app_path=$(find "$derived_data/Build/Products/Debug-iphoneos" -name "*.app" -maxdepth 1 2>/dev/null | head -1)
  if [ -z "$app_path" ]; then
    echo "[ios] ERROR: Could not find built .app bundle"
    return 1
  fi

  echo "[ios] Installing on ${device}..."
  xcrun devicectl device install app --device "$device" "$app_path" 2>&1 \
    || { echo "[ios] ERROR: Install failed for ${device}"; return 1; }

  echo "[ios] Launching on ${device}..."
  xcrun devicectl device process launch --device "$device" net.ben.gossip 2>&1 \
    || echo "[ios] WARNING: Launch failed for ${device}"
}
