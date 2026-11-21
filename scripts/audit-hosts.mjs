// Allowed-hosts check: fails the build when the bundle names a host that is
// not in scripts/allowed-hosts.ts. Run by `npm run build` after `vite build`.
//
// Read the warning at the top of scripts/allowed-hosts.ts before changing
// the allowlist: a host is added only with the project owner's approval.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALLOWED_HOSTS, KNOWN_INERT_HOSTS } from './allowed-hosts.ts';

const ALLOWLIST_FILE = 'scripts/allowed-hosts.ts';
const SHIPPED_FILE = /\.(js|mjs|html|json|webmanifest)$/;

// Network schemes only. Custom schemes of the app or of libraries
// (gossip://share, file://localhost, server://singlefetch) name no host on
// the network. `git+https` and the like end with a network scheme.
const NETWORK_SCHEME = /(?:^|\+)(?:https?|wss?|ftp)$/i;
const SCHEME_URL =
  /\b([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^\s/"'`<>\\@]*@)?(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9_%-]+(?:\.[a-zA-Z0-9_%-]+)*)/g;
// A protocol-relative URL: `//host.tld` right after a quote, a bracket, `=`,
// `,` or white space, so that `//` comments and regular expressions do not
// match.
const PROTOCOL_RELATIVE_URL =
  /(?<=["'`(=,\s])\/\/((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})(?=[/:"'`?#)\s])/g;

/** Every host named by a network URL in `text`, with where it was found. */
export function findHosts(text) {
  const found = [];
  for (const match of text.matchAll(SCHEME_URL)) {
    if (!NETWORK_SCHEME.test(match[1])) continue;
    found.push({ host: match[2].toLowerCase(), index: match.index ?? 0 });
  }
  for (const match of text.matchAll(PROTOCOL_RELATIVE_URL)) {
    found.push({ host: match[1].toLowerCase(), index: match.index ?? 0 });
  }
  return found;
}

/** The host of the build's API URL, or null. */
export function hostOfUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Checks shipped files. `files` is a list of `{ path, text }`. Returns the
 * hosts that are in neither section of the allowlist.
 */
export function auditHosts(
  files,
  {
    allowed = ALLOWED_HOSTS,
    knownInert = KNOWN_INERT_HOSTS,
    apiUrl = undefined,
  } = {}
) {
  const permitted = new Set([
    ...allowed.map(entry => entry.host),
    ...knownInert.map(entry => entry.host),
  ]);
  const apiHost = hostOfUrl(apiUrl);
  if (apiHost) permitted.add(apiHost);

  const violations = [];
  const seen = new Set();
  for (const { path, text } of files) {
    for (const { host, index } of findHosts(text)) {
      if (permitted.has(host)) continue;
      const key = `${host}\u0000${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const start = Math.max(0, index - 40);
      violations.push({
        host,
        path,
        context: text.slice(start, index + 80).replace(/\s+/g, ' '),
      });
    }
  }
  return violations;
}

/** The message shown when the check fails. */
export function formatViolations(violations) {
  const lines = violations.map(
    v => `  - ${v.host}\n      in ${v.path}\n      near: ...${v.context}...`
  );
  return [
    'Allowed-hosts check FAILED: the built app names hosts that are not on the allowlist.',
    '',
    'Found:',
    ...lines,
    '',
    `Why the build stopped: Gossip is a privacy-first messenger. The app may contact only the Gossip backend, mesh peers, and the short list of hosts the project owner approved (${ALLOWLIST_FILE}). Every other host in the shipped code is a place the app could send requests to.`,
    '',
    "The risk: a request to another host tells that host the user's IP address and when they use the app, and often what they are doing. The user never chose to talk to it.",
    '',
    'What to do:',
    '  1. Find where each host comes from: search the source and node_modules for it',
    '     (for example: grep -rn "<host>" src gossip-sdk/src node_modules), or read the',
    '     shipped file named above around the URL shown.',
    '  2. If our code brings it, remove it. If a library brings it as a default (a CDN,',
    '     telemetry, an update or font server), override that default so the library',
    '     uses a local file or nothing.',
    `  3. Do NOT add the host to ${ALLOWLIST_FILE} to make the build pass. If the host is`,
    '     truly needed, STOP and ask the project owner. Add it only with their explicit',
    '     approval, with a comment saying what it is for and who approved it.',
  ].join('\n');
}

function walk(dir, root, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, root, files);
    } else if (SHIPPED_FILE.test(full)) {
      files.push({
        path: relative(root, full).replaceAll('\\', '/'),
        text: readFileSync(full, 'utf8'),
      });
    }
  }
  return files;
}

async function buildApiUrl(root) {
  if (process.env.VITE_GOSSIP_API_URL) return process.env.VITE_GOSSIP_API_URL;
  // `vite build` also reads .env files: read them the same way.
  const { loadEnv } = await import('vite');
  return loadEnv('production', root, 'VITE_').VITE_GOSSIP_API_URL;
}

async function main() {
  const root = process.cwd();
  const dir = process.argv[2] ?? 'dist';
  if (!existsSync(dir)) {
    process.stderr.write(
      `Allowed-hosts check: ${dir}/ does not exist. Run it after vite build.\n`
    );
    process.exit(1);
  }
  const files = walk(dir, root);
  const violations = auditHosts(files, { apiUrl: await buildApiUrl(root) });
  if (violations.length > 0) {
    process.stderr.write(`${formatViolations(violations)}\n`);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
