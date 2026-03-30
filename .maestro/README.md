# Maestro Mobile Tests

Native mobile tests using [Maestro](https://maestro.mobile.dev/).

## Setup

```bash
# Install Maestro (Java 11+ required, already installed)
curl -Ls "https://get.maestro.mobile.dev" | bash
export PATH="$PATH:$HOME/.maestro/bin"

# Create iOS simulator (if needed)
xcrun simctl create "iPhone 16 Pro" \
  "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro" \
  "com.apple.CoreSimulator.SimRuntime.iOS-18-6"

# Build & deploy the app
npm run cap:build:android   # then build APK from Android Studio
npm run cap:build:ios       # then build from Xcode
```

## App IDs

| Platform | App ID             |
| -------- | ------------------ |
| Android  | `net.massa.gossip` |
| iOS      | `net.ben.gossip`   |

## Running Tests

```bash
# Single test
maestro test .maestro/keyboard_android.yaml

# All tests
maestro test .maestro/

# iOS (specify simulator)
maestro test .maestro/keyboard_ios.yaml --device <simulator-udid>
```

## Test Flows

| Flow                    | What it tests                                       | Pre-conditions              |
| ----------------------- | --------------------------------------------------- | --------------------------- |
| `keyboard_android.yaml` | Keyboard open/close, layout adaptation, typing      | Logged in, 1+ discussion    |
| `keyboard_ios.yaml`     | Same as above, iOS-specific (KeyboardResize.None)   | Logged in, 1+ discussion    |
| `biometric_login.yaml`  | Biometric success, failure, password fallback       | Account with biometric auth |
| `safe_area_notch.yaml`  | Content not hidden by notch/Dynamic Island/home bar | Logged in, 1+ discussion    |
| `qr_scanner.yaml`       | Scanner opens, camera permission, cancel/reopen     | Logged in                   |

## Screenshots

Tests save screenshots to the Maestro output directory for visual verification.
Name pattern: `<test>_<step>_<description>.png`

## Biometric Setup

**iOS Simulator:** Simulator menu > Features > Face ID > Enrolled
**Android Emulator:** `adb -e emu finger touch 1` to simulate fingerprint
