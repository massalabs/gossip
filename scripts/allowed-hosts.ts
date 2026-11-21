/*
 * Hosts the built app may name. Read by scripts/audit-hosts.mjs, which runs
 * in `npm run build` and fails when the bundle (dist/) names any other host.
 *
 * READ THIS BEFORE YOU CHANGE THIS FILE, whether you are a person or an AI
 * agent. Gossip is a privacy-first messenger: the app may contact only the
 * Gossip backend, mesh peers, and the short list of hosts below, which the
 * project owner approved one by one. A request to any other host tells that
 * host the user's IP address and when they use the app, and often what they
 * do. Never add a host here to make the build pass. When the check finds a
 * new host, find where it comes from and remove it, or override the library
 * default that brings it (a CDN, telemetry, update or font server). If the
 * host is truly needed, STOP and ask the project owner, and add it only with
 * their explicit approval, with what it is for and who approved it.
 */

export type HostKind =
  /** The app sends requests to it (fetch, WebSocket, RPC). */
  | 'connect'
  /** A page the user opens with a tap; the app itself sends nothing. */
  | 'link'
  /** An identifier (a namespace URI), never requested. */
  | 'identifier'
  /** A development default on the user's own device. */
  | 'loopback';

export interface AllowedHost {
  host: string;
  kind: HostKind;
  /** What it is for. */
  purpose: string;
  /** Who approved it. */
  approvedBy: string;
}

export interface KnownInertHost {
  host: string;
  /** Why the app never contacts it. */
  whyInert: string;
  /** The file that overrides the default, or where the text comes from. */
  evidence: string;
  approvedBy: string;
}

const OWNER = 'project owner, privacy hardening decision (Nov 2026)';
// The eight library hosts below were found in the bundle by the first run of
// the check. The owner checked each one by hand: it is text inside a library's
// error message or license notice, and the app never requests it.
const OWNER_CHECKED_TEXT =
  'project owner, confirmed on 2026-11-21 after a hand check: text inside a library error message or license notice, never requested';

/** ALLOWED: hosts the app may contact, link to, or name. */
export const ALLOWED_HOSTS: readonly AllowedHost[] = [
  // Gossip backend. The build's own VITE_GOSSIP_API_URL host is allowed too
  // (read by the check from the build environment).
  {
    host: 'api.usegossip.com',
    kind: 'connect',
    purpose: 'Gossip backend API',
    approvedBy: OWNER,
  },
  {
    host: 'localhost',
    kind: 'loopback',
    purpose:
      'development defaults and URL parsing bases (React Router, SQLite VFS); DeWeb local provider probe of massa-web3',
    approvedBy: OWNER,
  },
  {
    host: '127.0.0.1',
    kind: 'loopback',
    purpose: 'development default (loopback)',
    approvedBy: OWNER,
  },

  // Invite links.
  {
    host: 'gossip.massa.network',
    kind: 'link',
    purpose: 'invite link domain (main)',
    approvedBy: OWNER,
  },
  {
    host: 'dev-gossip.build.half-red.net',
    kind: 'link',
    purpose:
      'invite link domain (development, default of src/utils/inviteUrl.ts)',
    approvedBy: OWNER,
  },

  // Massa services.
  {
    host: 'mainnet.massa.net',
    kind: 'connect',
    purpose: 'Massa mainnet RPC (name service lookups)',
    approvedBy: OWNER,
  },
  {
    host: 'buildnet.massa.net',
    kind: 'connect',
    purpose: 'Massa buildnet RPC (name service lookups)',
    approvedBy: OWNER,
  },
  {
    host: 'testnet.massa.net',
    kind: 'connect',
    purpose:
      'Massa testnet RPC: only in the PublicApiUrl enum of massa-web3; the app selects mainnet or buildnet',
    approvedBy: OWNER,
  },
  {
    host: 'station.massa',
    kind: 'connect',
    purpose:
      'DeWeb resolution: MassaStation local provider status (massa-web3 resolveDeweb)',
    approvedBy: OWNER,
  },
  {
    host: 'deweb.massa.network',
    kind: 'link',
    purpose: 'DeWeb resolution: public redirect page (massa-web3 resolveDeweb)',
    approvedBy: OWNER,
  },
  {
    host: 'mns.massa',
    kind: 'link',
    purpose: 'DeWeb name of the Massa name service, shown in Settings, Web3',
    approvedBy: OWNER,
  },
  {
    host: 'mns.massa.network',
    kind: 'link',
    purpose: 'Massa name service website (Settings, Web3, user tap)',
    approvedBy: OWNER,
  },
  {
    host: 'usegossip.massa.network',
    kind: 'link',
    purpose: 'Gossip landing page (About, invite page, user tap)',
    approvedBy: OWNER,
  },

  // Store and download links.
  {
    host: 'play.google.com',
    kind: 'link',
    purpose: 'Google Play store link',
    approvedBy: OWNER,
  },
  {
    host: 'apps.apple.com',
    kind: 'link',
    purpose: 'App Store link',
    approvedBy: OWNER,
  },
  {
    host: 'github.com',
    kind: 'link',
    purpose:
      'APK download link; also in library message and license comment text',
    approvedBy: OWNER,
  },

  // External pages the user opens with a tap, announced before the tap.
  {
    host: 'cryptpad.fr',
    kind: 'link',
    purpose: 'feedback form (Settings, Send Feedback)',
    approvedBy: OWNER,
  },
  {
    host: 'dontkillmyapp.com',
    kind: 'link',
    purpose:
      'battery optimisation help per phone maker (Settings, Background Sync)',
    approvedBy: OWNER,
  },

  // Identifiers, never requested.
  {
    host: 'www.w3.org',
    kind: 'identifier',
    purpose: 'SVG, XLink and XML namespace URIs in React DOM and the icons',
    approvedBy: OWNER,
  },
];

/**
 * KNOWN-INERT: hosts a library carries that the app never contacts, each
 * with the reason and the file that shows it. Recheck the evidence whenever
 * the library is updated.
 */
export const KNOWN_INERT_HOSTS: readonly KnownInertHost[] = [
  {
    host: 'cdn.jsdelivr.net',
    whyInert:
      'emoji-picker-react image CDN; the app renders native emoji, so no image is requested',
    evidence:
      'src/components/ui/EmojiPickerModal.tsx (emojiStyle={EmojiStyle.NATIVE})',
    approvedBy: OWNER,
  },
  {
    host: 'fastly.jsdelivr.net',
    whyInert:
      'zxing-wasm default location of its wasm; the app serves the bundled copy',
    evidence:
      'src/components/qr/WebQRScanner.tsx (setZXingModuleOverrides locateFile)',
    approvedBy: OWNER,
  },
  {
    host: 'fb.me',
    whyInert:
      'address in the text of a prop-types error message (React), never requested',
    evidence: 'node_modules/prop-types (message of checkPropTypes)',
    approvedBy: OWNER_CHECKED_TEXT,
  },
  {
    host: 'react.dev',
    whyInert: 'address in the text of a React error message, never requested',
    evidence: 'node_modules/react-dom (production error formatter)',
    approvedBy: OWNER_CHECKED_TEXT,
  },
  {
    host: 'reactrouter.com',
    whyInert:
      'address in the text of a React Router error message, never requested',
    evidence: 'node_modules/react-router (data router error message)',
    approvedBy: OWNER_CHECKED_TEXT,
  },
  {
    host: 'www.i18next.com',
    whyInert: 'address in the text of an i18next warning, never requested',
    evidence: 'node_modules/i18next (legacy format warning)',
    approvedBy: OWNER_CHECKED_TEXT,
  },
  {
    host: 'capacitorjs.com',
    whyInert:
      'address in the license notice comment of @capacitor/core, never requested',
    evidence: 'node_modules/@capacitor/core (/*! Capacitor ... */)',
    approvedBy: OWNER_CHECKED_TEXT,
  },
  {
    host: 'feross.org',
    whyInert:
      'address in the license notice comments of buffer, ieee754 and safe-buffer, never requested',
    evidence: 'node_modules/ieee754, node_modules/safe-buffer',
    approvedBy: OWNER_CHECKED_TEXT,
  },
  {
    host: 'mths.be',
    whyInert:
      'address in the license notice comment of punycode, never requested',
    evidence: 'node_modules/punycode',
    approvedBy: OWNER_CHECKED_TEXT,
  },
  {
    host: 'bit.ly',
    whyInert:
      'address in the text of a Workbox precache message in the service worker (sw.js), never requested',
    evidence: 'node_modules/workbox-precaching (dist/sw.js)',
    approvedBy: OWNER_CHECKED_TEXT,
  },
];
