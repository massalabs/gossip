// Logging audit, run by `npm run build`:
//
//   node scripts/audit-logging.mjs source   before the build
//   node scripts/audit-logging.mjs dist     after the build
//
// A release build of Gossip writes no log: not in the browser console, not
// in logcat, not in the iOS unified log. A log line can be read by other
// apps, bug reports, a connected computer or anyone holding the phone, and
// can reveal who the user talks to and when. This audit fails the build when
// code could log in a release build, and says what to do.
//
// The exceptions below are each a single, known place. Do not add one to make
// the build pass: find the cause and remove it, or override the library
// default that brings it. If a log is truly needed in a release build, STOP
// and ask the project owner; add an exception only with their explicit
// approval.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();

const sourceRoots = ['src', 'gossip-sdk/src', 'public/runners'];
// The logging boundaries: the only app files that may touch `console`.
const sourceAllowConsole = new Set(['src/utils/logger.ts', 'src/sw.ts']);
const sourceIgnoredPathParts = [
  'node_modules',
  '.git',
  'dist',
  'gossip-sdk/dist',
  'assets/generated',
];

const distIgnoredPathParts = ['.git'];

// Any use of `console`: `console.<method>`, `console?.<method>`,
// `console[...]` and `console?.[...]`.
const CONSOLE_USE = /\bconsole\s*(?:\?\.\s*\[|\[|\??\.\s*[A-Za-z_$][\w$]*)/g;

/**
 * The known console uses left in the bundle, each matched exactly and with
 * the reason it is not a log of a release build.
 */
export const KNOWN_DIST_CONSOLE_USES = [
  {
    name: 'i18next console logger',
    pattern:
      /output\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{console\?\.\[\1\]\?\.apply\?\.\(console,\2\)\}/g,
    why: 'the default logger of i18next stays in the bundle, but src/i18n/index.ts gives i18next a logger that writes nothing unless debug logging is on, so it is never called in a release build',
  },
];

const RULE_HELP = {
  console: [
    'Why: a release build writes no log, and the browser console of the web',
    'view can be read on a connected computer or by a debugging tool.',
    'What to do: log through the logger of src/utils/logger.ts (or',
    'gossip-sdk/src/utils/logs.ts in the SDK), which is silent in a release',
    'build. If the call comes from a library, configure the library not to log',
    '(as src/i18n/index.ts does for i18next) rather than listing it here.',
  ],
  native: [
    'Why: a release build writes no log; logcat and the iOS unified log can be',
    'read by other apps with the permission, by bug reports and on a connected',
    'computer, and can show who the user talks to and when.',
    'What to do: on Android log through net.massa.gossip.DebugLog, which writes',
    'only in a debug build; on iOS put the line inside #if DEBUG ... #endif.',
    'Pass only plain values: the arguments must have no effect of their own.',
  ],
  debugLogs: [
    'Why: VITE_DEBUG_LOGS=true turns the app logger on, so a production build',
    'would write logs on every device it is installed on.',
    'What to do: unset VITE_DEBUG_LOGS (environment and .env files) for a',
    'production build. Use the dev server or a debug build to read logs.',
  ],
  patchTrust: [
    'Why: a change to certificate or trust handling can let anyone on the',
    "network read and change the app's traffic (a man in the middle), or let a",
    'computer inspect the web view of a release build.',
    'What to do: make the change exist only in debug builds, with the guard in',
    'the same hunk (#if DEBUG in Swift, BuildConfig.DEBUG or the app debuggable',
    'flag in Kotlin/Java), and keep the release behaviour of the library',
    'unchanged. If a release build truly needs it, STOP and ask the project',
    'owner.',
  ],
  fullDebug: [
    'Why: VITE_FULL_DEBUG=true builds the full debug app, which records',
    'everything (message content and keys included) and can send it to the',
    'developers. It must never be built as the real app.',
    'What to do: unset VITE_FULL_DEBUG (environment and .env files). Build the',
    'debug app with npm run build:full-debug / android:full-debug only.',
  ],
  capacitor: [
    'Why: the Capacitor bridge logs every plugin call and its data.',
    "What to do: keep loggingBehavior: 'none' in capacitor.config.ts.",
  ],
  legacy: [
    'Why: the legacy debug logger hook sends app logs to the console.',
    'What to do: remove it; use src/utils/logger.ts.',
  ],
};

function walk(dir, ignoredPathParts, accept, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(root, full).replaceAll('\\', '/');
    if (ignoredPathParts.some(part => rel.includes(part))) continue;

    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, ignoredPathParts, accept, files);
    } else if (accept(full)) {
      files.push(rel);
    }
  }
  return files;
}

function lineNumberFor(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** Console uses in app source (`files` is a list of `{ path, text }`). */
export function auditSourceConsole(files, allow = sourceAllowConsole) {
  const violations = [];
  for (const { path, text } of files) {
    if (allow.has(path)) continue;
    for (const match of text.matchAll(CONSOLE_USE)) {
      violations.push({
        file: path,
        line: lineNumberFor(text, match.index ?? 0),
        rule: `console use \`${match[0]}\` outside the logger`,
        help: 'console',
      });
    }
  }
  return violations;
}

/** Console uses and legacy hooks in the built bundle. */
export function auditDistConsole(files, known = KNOWN_DIST_CONSOLE_USES) {
  const violations = [];
  for (const { path, text } of files) {
    let rest = text;
    for (const entry of known) rest = rest.replace(entry.pattern, '');
    for (const match of rest.matchAll(CONSOLE_USE)) {
      violations.push({
        file: path,
        line: lineNumberFor(rest, match.index ?? 0),
        rule: `console use \`${match[0]}\` in the bundle`,
        help: 'console',
      });
    }
    for (const match of text.matchAll(/\benableDebugLogger\b/g)) {
      violations.push({
        file: path,
        line: lineNumberFor(text, match.index ?? 0),
        rule: 'legacy debug logger hook',
        help: 'legacy',
      });
    }
  }
  return violations;
}

// Native log calls of the app's own Kotlin, Java and Swift.
const KOTLIN_JAVA_LOGS = [
  /(?<![\w.])Log\.[a-z]+\s*\(/g,
  /(?<![\w.])Logger\.(?:verbose|debug|info|warn|error)\s*\(/g,
  /(?<![\w.])(?:println|print)\s*\(/g,
  /\.printStackTrace\s*\(/g,
  /\bSystem\.(?:out|err)\b/g,
];
const SWIFT_LOGS = [
  /(?<![\w.])(?:NSLog|os_log|print|debugPrint|dump)\s*\(/g,
  /(?<![\w.])Logger\s*\(/g,
  /\bCAPLog\.print\s*\(/g,
];
const DEBUG_LOG_HELPER =
  'android/app/src/main/java/net/massa/gossip/DebugLog.kt';

/** Blanks comments and string literals, keeping line breaks. */
function stripCommentsAndStrings(text) {
  return text.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"/g,
    match => (match.startsWith('"') ? '""' : match.replace(/[^\n]/g, ' '))
  );
}

/** Blanks the code inside `#if DEBUG ... #endif` (an `#else` ends it). */
function blankSwiftDebugBlocks(text) {
  const lines = text.split('\n');
  const stack = [];
  return lines
    .map(line => {
      const directive = line.trim();
      if (/^#if\b/.test(directive)) {
        stack.push(/^#if\s+DEBUG\s*$/.test(directive));
        return line;
      }
      if (/^#else\b|^#elseif\b/.test(directive)) {
        if (stack.length) stack[stack.length - 1] = false;
        return line;
      }
      if (/^#endif\b/.test(directive)) {
        stack.pop();
        return line;
      }
      return stack.includes(true) ? '' : line;
    })
    .join('\n');
}

/** Native log calls outside the debug-only helper or `#if DEBUG`. */
export function auditNativeLogs(files) {
  const violations = [];
  for (const { path, text } of files) {
    if (path === DEBUG_LOG_HELPER) continue;
    const swift = path.endsWith('.swift');
    let code = stripCommentsAndStrings(text);
    if (swift) code = blankSwiftDebugBlocks(code);
    for (const pattern of swift ? SWIFT_LOGS : KOTLIN_JAVA_LOGS) {
      for (const match of code.matchAll(pattern)) {
        violations.push({
          file: path,
          line: lineNumberFor(code, match.index ?? 0),
          rule: `native log call \`${match[0].trim()}\` that is not debug-only`,
          help: 'native',
        });
      }
    }
  }
  return violations;
}

/** A production build must not turn the app logger on. */
export function auditDebugLogsSetting(values) {
  return values
    .filter(({ value }) => String(value).trim().toLowerCase() === 'true')
    .map(({ source }) => ({
      file: source,
      line: 1,
      rule: 'VITE_DEBUG_LOGS=true in a production build',
      help: 'debugLogs',
    }));
}

/** A production build must not be the full debug build. */
export function auditFullDebugSetting(values) {
  return values
    .filter(({ value }) => String(value).trim().toLowerCase() === 'true')
    .map(({ source }) => ({
      file: source,
      line: 1,
      rule: 'VITE_FULL_DEBUG=true in a production build',
      help: 'fullDebug',
    }));
}

const TRUST_MARKERS =
  /ServerTrust|URLCredential\(trust|rejectProtectionSpace|TrustManager|HostnameVerifier|onReceivedSslError|setWebContentsDebuggingEnabled/;
const DEBUG_GUARD = /#if\s+DEBUG\b|BuildConfig\.DEBUG\b|FLAG_DEBUGGABLE\b/;

/** Patch hunks that touch trust handling without a debug-only guard. */
export function auditPatches(files) {
  const violations = [];
  for (const { path, text } of files) {
    const lines = text.split('\n');
    let target = '';
    let hunk = null;
    const finish = () => {
      if (!hunk) return;
      const touched = hunk.changed.find(line => TRUST_MARKERS.test(line.text));
      const guarded = hunk.lines.some(line => DEBUG_GUARD.test(line));
      if (touched && !guarded) {
        violations.push({
          file: path,
          line: touched.line,
          rule: `patch of ${target} changes trust handling (\`${touched.text.trim()}\`) with no debug-only guard in the hunk`,
          help: 'patchTrust',
        });
      }
      hunk = null;
    };
    lines.forEach((line, index) => {
      if (line.startsWith('diff --git ')) {
        finish();
        target = line.split(' b/')[1] ?? line;
      } else if (line.startsWith('@@')) {
        finish();
        hunk = { lines: [], changed: [] };
      } else if (hunk && !line.startsWith('+++') && !line.startsWith('---')) {
        hunk.lines.push(line);
        if (line.startsWith('+') || line.startsWith('-')) {
          hunk.changed.push({ text: line.slice(1), line: index + 1 });
        }
      }
    });
    finish();
  }
  return violations;
}

/** The message shown when the audit fails. */
export function formatViolations(violations) {
  const out = [
    'Logging audit FAILED: code could write logs in a release build.',
    '',
    'Found:',
  ];
  for (const v of violations) out.push(`  - ${v.file}:${v.line}: ${v.rule}`);
  const helps = [...new Set(violations.map(v => v.help))];
  for (const help of helps) out.push('', ...RULE_HELP[help]);
  out.push(
    '',
    'Gossip is a privacy-first messenger: a release build writes no log.',
    'Do NOT add an exception to scripts/audit-logging.mjs to make the build',
    'pass. Find the cause and remove it, or override the library default. If',
    'it is truly needed, STOP and ask the project owner, and add it only with',
    'their explicit approval.'
  );
  return out.join('\n');
}

const read = path => ({ path, text: readFileSync(path, 'utf8') });

async function envValues(key) {
  const values = [];
  if (process.env[key] !== undefined) {
    values.push({
      source: `environment (${key})`,
      value: process.env[key],
    });
    // Vite gives the environment precedence over .env files.
    return values;
  }
  // `vite build` runs in production mode and reads these .env files.
  const { loadEnv } = await import('vite');
  const env = loadEnv('production', root, key);
  if (env[key] !== undefined) {
    values.push({
      source: `.env files of production mode (${key})`,
      value: env[key],
    });
  }
  return values;
}

const debugLogsValues = () => envValues('VITE_DEBUG_LOGS');

async function main() {
  const mode = process.argv[2] ?? 'source';
  const scriptFile = full => /\.(js|mjs|ts|tsx)$/.test(full);
  const violations = [];

  if (mode === 'dist') {
    violations.push(
      ...auditDistConsole(
        walk('dist', distIgnoredPathParts, scriptFile).map(read)
      )
    );
  } else {
    violations.push(
      ...auditSourceConsole(
        sourceRoots
          .flatMap(dir => walk(dir, sourceIgnoredPathParts, scriptFile))
          .map(read)
      )
    );

    const nativeIgnored = ['/generated/', 'android/app/src/main/java/uniffi/'];
    const nativeFiles = [
      ...walk('android/app/src/main', nativeIgnored, full =>
        /\.(kt|java)$/.test(full)
      ),
      ...walk('android/app/src/meshffi/java', nativeIgnored, full =>
        /\.(kt|java)$/.test(full)
      ),
      ...walk('ios/App', [...nativeIgnored, 'ios/App/Pods'], full =>
        full.endsWith('.swift')
      ),
    ];
    violations.push(...auditNativeLogs(nativeFiles.map(read)));

    violations.push(...auditDebugLogsSetting(await debugLogsValues()));
    violations.push(
      ...auditFullDebugSetting(await envValues('VITE_FULL_DEBUG'))
    );

    violations.push(
      ...auditPatches(
        walk('patches', [], full => full.endsWith('.patch')).map(read)
      )
    );

    const capacitorConfig = readFileSync('capacitor.config.ts', 'utf8');
    const loggingBehaviors = [
      ...capacitorConfig.matchAll(
        /\bloggingBehavior\s*:\s*(['"])(?<behavior>[^'"]+)\1/g
      ),
    ];
    if (
      loggingBehaviors.length !== 1 ||
      loggingBehaviors[0].groups?.behavior !== 'none'
    ) {
      violations.push({
        file: 'capacitor.config.ts',
        line: 1,
        rule: 'Capacitor bridge logging must be globally disabled',
        help: 'capacitor',
      });
    }
  }

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
