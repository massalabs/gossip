#!/bin/bash
#
# Fallback iOS deploy using xcodebuild when Capacitor/native-run fails
# (e.g. Wi-Fi connected devices not detected by native-run).
#
# Sourced by dev-all.sh — provides deploy_ios_xcode_fallback().
#

deploy_ios_xcode_fallback() {
  local device="$1"
  local ws="ios/App/App.xcworkspace"
  local scheme="Gossip"

  if [ ! -d "$ws" ]; then
    echo "[ios-fallback] Workspace not found: $ws" >&2
    return 1
  fi

  echo "[ios-fallback] Building ${scheme} for device ${device} via xcodebuild..."

  xcodebuild \
    -workspace "$ws" \
    -scheme "$scheme" \
    -destination "id=${device}" \
    -allowProvisioningUpdates \
    build 2>&1 | tail -5

  if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    echo "[ios-fallback] xcodebuild failed for ${device}" >&2
    return 1
  fi

  # Derive the built .app path from DerivedData
  local app_path
  app_path=$(find ~/Library/Developer/Xcode/DerivedData -path "*${scheme}*/Build/Products/Debug-iphoneos/*.app" -maxdepth 5 -print -quit 2>/dev/null)

  if [ -z "$app_path" ]; then
    echo "[ios-fallback] Could not locate built .app in DerivedData" >&2
    return 1
  fi

  echo "[ios-fallback] Installing ${app_path} on ${device}..."

  # Use devicectl (Xcode 15+) to install
  if command -v xcrun >/dev/null 2>&1; then
    xcrun devicectl device install app --device "$device" "$app_path" 2>&1
    if [ $? -eq 0 ]; then
      echo "[ios-fallback] Installed successfully on ${device}"
      # Launch the app
      local bundle_id
      bundle_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "${app_path}/Info.plist" 2>/dev/null)
      if [ -n "$bundle_id" ]; then
        xcrun devicectl device process launch --device "$device" "$bundle_id" 2>/dev/null || true
      fi
      return 0
    fi
  fi

  echo "[ios-fallback] Install failed for ${device}" >&2
  return 1
}
