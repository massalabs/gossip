// Developer-path check: fails when a shipped file holds a home directory
// path (/home/..., /Users/..., C:\Users\...). Such a path gives away the
// builder's user name and machine layout to anyone who unpacks the app.
//
//   node scripts/audit-paths.mjs source   the committed wasm bundles
//   node scripts/audit-paths.mjs dist     every file of the built app
//
// Rust builds avoid these paths with scripts/rust-remap-flags.sh.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEVELOPER_PATH_MARKERS = ['/home/', '/Users/', 'C:\\Users\\'];

// Exact strings that start like a home directory but are not a path of any
// machine. Each one is a constant of a library, with the reason. Do not add
// an entry for a real user's path.
export const NOT_DEVELOPER_PATHS = [
  {
    text: '/home/web_user',
    why: 'the home directory of the Emscripten virtual file system, a constant of the zxing-wasm runtime (QR scanner)',
  },
];

/** The developer paths found in `bytes`, at most `limit` samples. */
export function findDeveloperPaths(bytes, limit = 5) {
  let text = Buffer.from(bytes).toString('latin1');
  for (const { text: known } of NOT_DEVELOPER_PATHS) {
    text = text.replaceAll(known, '');
  }
  const samples = [];
  let count = 0;
  for (const marker of DEVELOPER_PATH_MARKERS) {
    let index = text.indexOf(marker);
    while (index !== -1) {
      count++;
      if (samples.length < limit) {
        const end = text.slice(index).search(/[\0\s"'`<>]|$/);
        samples.push(text.slice(index, index + Math.min(end, 120)));
      }
      index = text.indexOf(marker, index + marker.length);
    }
  }
  return { count, samples };
}

/** `files` is a list of `{ path, bytes }`. */
export function auditPaths(files) {
  const violations = [];
  for (const { path, bytes } of files) {
    const { count, samples } = findDeveloperPaths(bytes);
    if (count > 0) violations.push({ path, count, samples });
  }
  return violations;
}

export function formatViolations(violations) {
  const lines = violations.flatMap(v => [
    `  - ${v.path}: ${v.count} path(s), for example:`,
    ...v.samples.map(sample => `      ${sample}`),
  ]);
  return [
    'Developer-path check FAILED: shipped files contain paths of the machine that built them.',
    '',
    'Found:',
    ...lines,
    '',
    "Why the build stopped: Gossip is a privacy-first messenger, and what it ships must not identify the people who build it. A home directory path such as /home/<name>/ or /Users/<name>/ gives away the builder's user name and the layout of their machine.",
    '',
    'The risk: anyone who unpacks the app or the web bundle reads these paths. They can tie a release to a person, or help to target their machine.',
    '',
    'What to do:',
    '  - For a Rust library (wasm, Android .so, iOS .a): build it through the npm',
    '    scripts or the scripts/build-*.sh scripts, which pass',
    '    --remap-path-prefix through scripts/rust-remap-flags.sh. A new Rust build',
    '    must pass the same --config. If paths remain, find which crate they come',
    '    from (strings <file> | grep /home/) and add the missing prefix to',
    '    scripts/rust-remap-flags.sh, or the matching C flag (-ffile-prefix-map).',
    '  - For JavaScript: find the source of the path (a dependency that inlines',
    '    __filename or a source map path) and remove it or configure it away.',
    '  - Do NOT weaken or skip this check to make the build pass. If a path is',
    '    truly needed, STOP and ask the project owner.',
  ].join('\n');
}

function walk(dir, root, accept, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, root, accept, files);
    } else if (accept(full)) {
      files.push({
        path: relative(root, full).replaceAll('\\', '/'),
        bytes: readFileSync(full),
      });
    }
  }
  return files;
}

function main() {
  const root = process.cwd();
  const mode = process.argv[2] ?? 'source';
  const files =
    mode === 'dist'
      ? walk('dist', root, () => true)
      : walk('gossip-sdk/src/assets/generated', root, file =>
          file.endsWith('.wasm')
        );
  if (files.length === 0) {
    process.stderr.write(
      `Developer-path check: no file to check in ${mode} mode.\n`
    );
    process.exit(1);
  }
  const violations = auditPaths(files);
  if (violations.length > 0) {
    process.stderr.write(`${formatViolations(violations)}\n`);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
