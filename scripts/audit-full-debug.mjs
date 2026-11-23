// Full-debug check, run by `npm run build` after `vite build`: fails when the
// built app holds anything of the full debug build (src/fullDebug/,
// VITE_FULL_DEBUG, the wasm bundle built with the cargo feature `full-debug`).
// That build records everything, message content and keys included, and sends
// it to the developers: it must never ship as the real app. See
// docs/PRIVACY-CHECKS.md.
//
// With `--expect-debug-wasm` (run by `npm run build:full-debug`) it checks the
// opposite for the wasm bundle: the full debug app must hold the group engine's
// debug events, so that a renamed marker or a normal bundle cannot pass
// silently.

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

/**
 * Names of the group engine's debug events: only a wasm bundle built with the
 * cargo feature `full-debug` (wasm/groups/src/debug.rs) holds them.
 */
export const FULL_DEBUG_WASM_MARKERS = [
  'engine.event.in',
  'engine.retrieval.ask',
];

const SHIPPED_FILE = /\.(js|mjs|html|json|webmanifest)$/;
const WASM_FILE = /\.wasm$/;

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

/**
 * `files` is a list of `{ path, bytes }` of wasm modules; returns the debug
 * event names found where (their strings are kept as UTF-8 in the module).
 */
export function auditFullDebugWasm(files, markers = FULL_DEBUG_WASM_MARKERS) {
  const found = [];
  for (const { path, bytes } of files) {
    for (const marker of markers) {
      if (Buffer.from(bytes).includes(marker)) found.push({ path, marker });
    }
  }
  return found;
}

function walk(dir, root, files = [], pattern = SHIPPED_FILE) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, root, files, pattern);
    else if (pattern.test(full)) {
      const path = relative(root, full).replaceAll('\\', '/');
      files.push(
        pattern === WASM_FILE
          ? { path, bytes: readFileSync(full) }
          : { path, text: readFileSync(full, 'utf8') }
      );
    }
  }
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const expectDebugWasm = args.includes('--expect-debug-wasm');
  const dir = args.find(a => !a.startsWith('--')) ?? 'dist';
  if (!existsSync(dir)) {
    process.stderr.write(`Full-debug check: ${dir}/ does not exist.\n`);
    process.exit(1);
  }
  const wasm = auditFullDebugWasm(walk(dir, process.cwd(), [], WASM_FILE));
  if (expectDebugWasm) {
    const seen = new Set(wasm.map(v => v.marker));
    const missing = FULL_DEBUG_WASM_MARKERS.filter(m => !seen.has(m));
    // Every copy of the main bundle must be the debug one: a normal copy beside
    // it means the app may still load the normal module.
    const normal = walk(dir, process.cwd(), [], WASM_FILE)
      .filter(f => /(^|\/)gossip_wasm_bg[^/]*\.wasm$/.test(f.path))
      .filter(f => auditFullDebugWasm([f]).length === 0)
      .map(f => `the normal bundle ${f.path}`);
    missing.push(...normal);
    if (missing.length > 0) {
      process.stderr.write(
        [
          'Full-debug check FAILED: the full debug app lacks the group engine debug events.',
          '',
          ...missing.map(m =>
            m.startsWith('the normal bundle')
              ? `  - ${m}`
              : `  - "${m}" in no .wasm file of ${dir}/`
          ),
          '',
          'What to do: build the wasm bundle with `npm run wasm:build:main:full-debug`',
          '(cargo feature full-debug) before the app; if an event was renamed, update',
          'FULL_DEBUG_WASM_MARKERS.',
        ].join('\n') + '\n'
      );
      process.exit(1);
    }
    return;
  }
  const violations = [...auditFullDebug(walk(dir, process.cwd())), ...wasm];
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
        'behind FULL_DEBUG (src/config/fullDebug.ts) so that it is dropped. A .wasm',
        'file with engine debug events was built with the cargo feature full-debug:',
        'rebuild it with `npm run wasm:build:main` (the committed bundle must be that one).',
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
