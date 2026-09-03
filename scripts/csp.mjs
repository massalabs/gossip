/**
 * Content-Security-Policy: single source of truth.
 *
 * A CSP is a declaration of every origin this application is permitted to talk
 * to. Its value here is not only that it blocks an attack in progress; it is
 * that any dependency which starts contacting a new host fails loudly during
 * development instead of silently exfiltrating user IP addresses from
 * production. Gossip's existing guardrails (audit-logging, audit-production-worker,
 * compatibility fixtures) all constrain data at rest. This constrains egress.
 *
 * Consumed by:
 *   - vite.config.ts, which injects the policy as a <meta http-equiv> tag so it
 *     applies to the web build, the dev server, and the Capacitor WebView on
 *     iOS and Android (native builds have no server to set a real header);
 *   - this file run directly, which writes the same policy into the DeWeb
 *     deployment configs as a real HTTP response header.
 *
 * Usage:
 *   node scripts/csp.mjs           # write the header into deweb configs
 *   node scripts/csp.mjs --check   # fail if they are out of date (CI)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Massa JSON-RPC and gRPC endpoints. Both networks are listed because the
 * network is switchable at runtime (see src/stores/appStore.tsx), so a build
 * cannot know which one a given user will select.
 */
const MASSA_ENDPOINTS = [
  'https://mainnet.massa.net',
  'https://mainnet.massa.net:33037',
  'https://buildnet.massa.net',
  'https://buildnet.massa.net:33037',
  'https://deweb.massa.network',
];

const DEFAULT_API_URL = 'https://api.usegossip.com';

/** Reduce a URL to the scheme://host[:port] form a CSP source expression wants. */
function toOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * Build the policy.
 *
 * @param {object} options
 * @param {string} [options.apiUrl] Value of VITE_GOSSIP_API_URL for this build.
 *   The protocol API host is deployment-configurable, so the policy has to be
 *   generated per build rather than hardcoded.
 * @param {boolean} [options.allowDevServer] Permit the Vite dev server's HMR
 *   websocket and inline React refresh runtime.
 * @param {'meta'|'header'} [options.target] Where the policy will be delivered.
 *   frame-ancestors is omitted for 'meta' because browsers ignore it there and
 *   log a warning on every page load; the DeWeb response header carries it.
 */
export function buildContentSecurityPolicy({
  apiUrl = DEFAULT_API_URL,
  allowDevServer = false,
  target = 'header',
} = {}) {
  const apiOrigin = toOrigin(apiUrl) ?? toOrigin(DEFAULT_API_URL);

  // No third-party origins: every host the shipped bundle contacts is either
  // Gossip's own protocol API or a Massa node. Adding one here is a privacy
  // decision, not a build detail — it grants that origin the user's IP address
  // and the timing of whatever action triggers the request.
  const connect = new Set(["'self'", apiOrigin, ...MASSA_ENDPOINTS]);

  if (allowDevServer) {
    // Vite's HMR client opens a websocket back to the dev server.
    connect
      .add('ws:')
      .add('wss:')
      .add('http://localhost:*')
      .add('https://localhost:*');
  }

  const directives = {
    // Anything not named below falls back to same-origin only.
    'default-src': ["'self'"],

    // 'wasm-unsafe-eval' is mandatory: the SDK compiles WebAssembly
    // (pq-rerand, secure storage, wa-sqlite). Without it the app cannot start.
    // It permits WASM compilation only — it does not re-enable eval() for JS.
    'script-src': allowDevServer
      ? ["'self'", "'wasm-unsafe-eval'", "'unsafe-inline'"]
      : ["'self'", "'wasm-unsafe-eval'"],

    // Tailwind and emoji-picker-react inject style elements at runtime.
    // Tightening this to a nonce is possible later; it buys little, because
    // style injection is not an exfiltration channel under this connect-src.
    'style-src': ["'self'", "'unsafe-inline'"],

    // data: for generated QR codes and inlined icons, blob: for camera frames.
    'img-src': ["'self'", 'data:', 'blob:'],

    // Fonts are self-hosted in public/fonts — no Google Fonts, and this
    // directive is what keeps it that way.
    'font-src': ["'self'"],

    // blob: for the live camera stream feeding the QR scanner.
    'media-src': ["'self'", 'blob:'],

    // SQLite, secure storage and the service worker all run in workers.
    'worker-src': ["'self'", 'blob:'],

    'manifest-src': ["'self'"],

    'connect-src': [...connect].filter(Boolean),

    // No plugins, no <base> hijacking, no framing, no form posts anywhere.
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"],
  };

  // Browsers ignore frame-ancestors delivered via <meta> and warn about it, so
  // it is only emitted for real response headers.
  if (target === 'header') directives['frame-ancestors'] = ["'none'"];

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

const DEWEB_CONFIGS = [
  'deweb_cli_config.mainnet.json',
  'deweb_cli_config.main.mainnet.json',
  'deweb_cli_config.buildnet.json',
];

const HEADER_KEY = 'http-header:Content-Security-Policy';

function syncDewebConfigs(checkOnly) {
  // DeWeb serves a static site with no origin server, so response headers come
  // from the deployment manifest. The deployed artifact is always the
  // production build, which uses the default API origin.
  const policy = buildContentSecurityPolicy();
  const stale = [];

  for (const relativePath of DEWEB_CONFIGS) {
    const path = join(root, relativePath);
    const raw = readFileSync(path, 'utf8');
    const config = JSON.parse(raw);

    if (config.metadatas?.[HEADER_KEY] === policy) continue;

    if (checkOnly) {
      stale.push(relativePath);
      continue;
    }

    config.metadatas = { ...config.metadatas, [HEADER_KEY]: policy };
    // Match the two-space indentation and trailing newline of the originals.
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`Updated ${relativePath}`);
  }

  if (stale.length > 0) {
    console.error(
      `Content-Security-Policy header is out of date in:\n` +
        stale.map(name => `  ${name}`).join('\n') +
        `\n\nRun: npm run csp:sync`
    );
    process.exit(1);
  }

  console.log(
    checkOnly
      ? 'DeWeb Content-Security-Policy headers are up to date.'
      : 'DeWeb Content-Security-Policy headers synced.'
  );
}

// Only act when executed directly, so vite.config.ts can import the builder.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  syncDewebConfigs(process.argv.includes('--check'));
}
