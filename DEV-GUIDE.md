# Gossip App — Wireless Dev Mode Guide

Hot reload over Wi-Fi on Android and iOS, with an optional Gossip bot for remote control.

## Quick Start

### Android only

```bash
npm run cap:dev:android -- 10.26.239.15:5555
```

### iOS only

```bash
npm run cap:dev:ios
# → Opens Xcode. Select your iPhone → Cmd+R
# (Vite starts automatically, hot reload is active)
```

### Both platforms

```bash
npm run cap:dev:all -- "10.26.239.15:5555"
# → Android deploys via ADB, iOS opens Xcode for manual run
```

## Prerequisites

### Network

- Phone(s) and Mac on the **same Wi-Fi network**
- Android: ADB Wi-Fi connected (`adb connect <ip>:5555`)
- iOS: Wi-Fi debugging enabled in Xcode (Window → Devices and Simulators → Connect via network)

### One-time iOS setup

1. Install the mkcert root CA on your iPhone:
   - AirDrop `~/.vite-plugin-mkcert/rootCA.pem` to your phone
   - Settings → General → VPN & Device Management → install the profile
   - Settings → General → About → Certificate Trust Settings → enable full trust

2. Ensure Xcode has your device set up for Wi-Fi debugging

### One-time Android setup

```bash
adb tcpip 5555
adb connect <phone-ip>:5555
```

## How It Works

### The dev scripts

All scripts follow the same flow:

1. Detect local IP address
2. Build the SDK (`npm run build:sdk`)
3. Set `DEV_SERVER_URL=https://<local-ip>:5173`
4. Run `cap sync` (writes the dev server URL into the Capacitor config)
5. Deploy to device (or open Xcode for iOS)
6. Start Vite HTTPS dev server (`npx vite --host`)

The WebView loads from the Vite server instead of bundled files → any code change triggers hot reload.

### SSL handling

The Vite server uses HTTPS (required for `crypto.subtle`). Self-signed certs need bypass on both platforms:

**Android** (already in repo):

- `MainActivity.java`: `BridgeWebViewClient` subclass that accepts all certs in debug
- `network_security_config.xml`: trusts user-installed CAs in debug

**iOS** (3 layers, belt-and-suspenders):

1. `patches/@capacitor+ios+8.0.0.patch` — patches `WebViewDelegationHandler.swift` to accept self-signed certs in debug builds only (persisted via `patch-package`, applied on `npm install`)
2. `ios/App/App/SSLBypassPlugin.swift` — Capacitor plugin registered in debug builds only
3. `ios/App/App/Info.plist` — `WKAppBoundDomains` removed (blocks localStorage on non-listed domains)

### Key files

| File                                              | Purpose                                         |
| ------------------------------------------------- | ----------------------------------------------- |
| `scripts/dev-android.sh`                          | Android hot reload script                       |
| `scripts/dev-ios.sh`                              | iOS hot reload script                           |
| `scripts/dev-all.sh`                              | Both platforms simultaneously                   |
| `capacitor.config.ts`                             | Reads `DEV_SERVER_URL` env var                  |
| `patches/@capacitor+ios+8.0.0.patch`              | SSL bypass patch for Capacitor iOS (debug only) |
| `ios/App/App/SSLBypassPlugin.swift`               | SSL bypass Capacitor plugin (debug only)        |
| `ios/App/App/MyViewController.swift`              | Plugin registration + WebView inspectable       |
| `android/app/src/main/java/.../MainActivity.java` | SSL bypass for Android (debug only)             |

## Troubleshooting

### iOS black screen

This means the WebView can't load from the dev server (SSL rejection).

1. Verify the patch is applied: check `node_modules/@capacitor/ios/Capacitor/Capacitor/WebViewDelegationHandler.swift` for "patched by gossip-app" comment
2. If not applied: `npx patch-package` or `npm install` (postinstall hook runs it)
3. After patching: `npx cap sync ios`, then clean build in Xcode (Cmd+Shift+K → Cmd+R)
4. Nuclear option: delete `~/Library/Developer/Xcode/DerivedData` and rebuild

### `cap sync` removed the dev server URL

Never run `cap sync` without `DEV_SERVER_URL` set. Always use the dev scripts which set it automatically.

### Safari Web Inspector doesn't show the app

- Ensure `bridge?.webView?.isInspectable = true` is set in `MyViewController.swift` (under `#if DEBUG`)
- The app must actually load (no black screen) for it to appear
- Safari → Settings → Advanced → Show features for web developers

### Android not connecting

```bash
adb devices  # check connection
adb disconnect
adb connect <ip>:5555
```

## Gossip Bot (optional)

For remote control — send instructions from your phone via Gossip:

```bash
cd bot.local && npm start
```

Then set up a cron in Claude Code:

```
/loop 1m Check bot.local/inbox.jsonl for unprocessed messages...
```

Bot config is in `bot.local/.env`. See `memory/dev-setup.md` for full details.
