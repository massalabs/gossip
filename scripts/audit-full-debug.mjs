// Full-debug check, run by `npm run build` after `vite build`: fails when the
// built app holds anything of the full debug build (src/fullDebug/,
// VITE_FULL_DEBUG). That build records everything, message content and keys
// included, and sends it to the developers: it must never ship as the real
// app. See docs/PRIVACY-CHECKS.md.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Text that only the full debug build carries. */
export const FULL_DEBUG_MARKERS = [
  // the upload path of the debug logs on the backend
  '/debug-logs',
  // the native plugin of the record
  'DebugLogFile',
  // its storage keys and overlay
  'gossip-full-debug',
  'full-debug-overlay',
];

const SHIPPED_FILE = /\.(js|mjs|html|json|webmanifest)$/;

/** `files` is a list of `{ path, text }`; returns what was found where. */
export function auditFullDebug(files, markers = FULL_DEBUG_MARKERS) {
  const violations = [];
  for (const { path, text } of files) {
    for (const marker of markers) {
      if (text.includes(marker)) violations.push({ path, marker });
    }
  }
  return violations;
}

function walk(dir, root, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, root, files);
    else if (SHIPPED_FILE.test(full)) {
      files.push({
        path: relative(root, full).replaceAll('\\', '/'),
        text: readFileSync(full, 'utf8'),
      });
    }
  }
  return files;
}

async function main() {
  const dir = process.argv[2] ?? 'dist';
  if (!existsSync(dir)) {
    process.stderr.write(`Full-debug check: ${dir}/ does not exist.\n`);
    process.exit(1);
  }
  const violations = auditFullDebug(walk(dir, process.cwd()));
  if (violations.length > 0) {
    process.stderr.write(
      [
        'Full-debug check FAILED: the built app holds code of the full debug build.',
        '',
        ...violations.map(v => `  - "${v.marker}" in ${v.path}`),
        '',
        'Why: the full debug build records everything, message content and keys',
        'included, and sends it to the developers. It must never ship.',
        'What to do: build without VITE_FULL_DEBUG; keep every use of src/fullDebug/',
        'behind FULL_DEBUG (src/config/fullDebug.ts) so that it is dropped.',
      ].join('\n') + '\n'
    );
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
