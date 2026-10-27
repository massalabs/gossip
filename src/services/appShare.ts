import { Capacitor, registerPlugin } from '@capacitor/core';

export type WifiPermission = 'granted' | 'denied' | 'prompt';

/** Error codes of `startHotspot`, as `error.code`. */
export type HotspotError =
  | 'PERMISSION_DENIED'
  | 'NOT_SHAREABLE'
  | 'WIFI_OFF'
  | 'UNSUPPORTED'
  | 'FAILED';

export interface AppShareInfo {
  /** False for a split (Play Store) install, whose base APK is incomplete. */
  shareable: boolean;
  sizeBytes: number;
  version: string;
  sharing: boolean;
}

export interface HotspotNetwork {
  ssid: string;
  passphrase: string;
  /** The landing page, e.g. `http://192.168.49.1:9999/`. */
  url: string;
}

/**
 * Native app sharing (Android `net.massa.gossip.share`): a Wi-Fi Direct
 * hotspot that serves the APK to a phone without Gossip.
 */
interface AppSharePlugin {
  getInfo(): Promise<AppShareInfo>;
  requestWifiPermission(): Promise<{ state: WifiPermission }>;
  /** Starts the hotspot and serves `landingPage` at `/` and the APK. */
  startHotspot(options: { landingPage: string }): Promise<HotspotNetwork>;
  stopHotspot(): Promise<void>;
  openWifiSettings(): Promise<void>;
  addListener(
    event: 'download',
    handler: (event: { state: 'started' | 'completed' | 'failed' }) => void
  ): Promise<{ remove(): Promise<void> }>;
  addListener(
    event: 'hotspot',
    handler: (event: { state: 'stopped' }) => void
  ): Promise<{ remove(): Promise<void> }>;
}

export const AppShare = registerPlugin<AppSharePlugin>('AppShare');

export function isAppShareAvailable(): boolean {
  return Capacitor.getPlatform() === 'android';
}

/** `WIFI:` text that phone cameras turn into "join this network". */
export function wifiJoinCode(ssid: string, passphrase: string): string {
  const escape = (value: string) => value.replace(/([\\;,:"])/g, '\\$1');
  return `WIFI:T:WPA;S:${escape(ssid)};P:${escape(passphrase)};;`;
}

export interface LandingPageTexts {
  lang: string;
  title: string;
  androidSteps: string;
  download: string;
  iosTitle: string;
  iosSteps: string;
  webAppUrl: string;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    c =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c] as string
  );
}

/**
 * The page a phone without Gossip opens on the hotspot: the APK download on
 * Android, the web app's address on an iPhone, which cannot install an APK
 * and cannot install a web app from a plain-http page.
 */
export function buildLandingPage(texts: LandingPageTexts): string {
  const e = escapeHtml;
  const webApp = e(texts.webAppUrl);
  return `<!doctype html>
<html lang="${e(texts.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(texts.title)}</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0f1115;color:#f2f3f5;line-height:1.5}
main{max-width:28rem;margin:0 auto;padding:2rem 1rem}
h1{font-size:1.6rem;margin:0 0 1rem}
h2{font-size:1.1rem;margin:2rem 0 .5rem}
p{color:#c4c7cf}
a.button{display:block;text-align:center;background:#4f7cff;color:#fff;text-decoration:none;font-weight:600;padding:1rem;border-radius:.75rem;margin:1.5rem 0}
code{word-break:break-all;color:#f2f3f5}
.ios .android,.android-only .ios{display:none}
</style>
</head>
<body>
<main>
<h1>${e(texts.title)}</h1>
<section class="android">
<p>${e(texts.androidSteps)}</p>
<a class="button" href="/Gossip.apk" download>${e(texts.download)}</a>
</section>
<section class="ios">
<h2>${e(texts.iosTitle)}</h2>
<p>${e(texts.iosSteps)}</p>
<p><code>${webApp}</code></p>
</section>
</main>
<script>
var ua=navigator.userAgent;
var ios=/iPhone|iPad|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
document.body.className=ios?'ios':(/Android/.test(ua)?'android-only':'');
</script>
</body>
</html>`;
}
