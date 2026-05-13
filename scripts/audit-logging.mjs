import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const mode = process.argv[2] ?? 'source';
const root = process.cwd();

const sourceRoots = ['src', 'gossip-sdk/src', 'public/runners'];
const sourceAllowConsole = new Set(['src/utils/logger.ts']);
const sourceIgnoredPathParts = [
  'node_modules',
  '.git',
  'dist',
  'gossip-sdk/dist',
  'assets/generated',
];

const distIgnoredPathParts = ['.git'];

const sourceForbidden = [
  {
    name: 'direct console call',
    pattern: /\bconsole\.(log|debug|info|warn|error)\s*\(/g,
    allow: sourceAllowConsole,
  },
];

const distForbidden = [
  {
    name: 'direct console call',
    pattern: /\bconsole\.(log|debug|info|warn|error)\s*\(/g,
  },
  {
    name: 'legacy debug logger hook',
    pattern: /\benableDebugLogger\b/g,
  },
];

function walk(dir, ignoredPathParts, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(root, full).replaceAll('\\', '/');
    if (ignoredPathParts.some(part => rel.includes(part))) continue;

    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, ignoredPathParts, files);
    } else if (/\.(js|mjs|ts|tsx)$/.test(full)) {
      files.push(rel);
    }
  }
  return files;
}

function lineNumberFor(text, index) {
  return text.slice(0, index).split('\n').length;
}

function auditFiles(files, rules) {
  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const rule of rules) {
      if (rule.allow?.has(file)) continue;
      for (const match of text.matchAll(rule.pattern)) {
        violations.push({
          file,
          line: lineNumberFor(text, match.index ?? 0),
          rule: rule.name,
        });
      }
    }
  }
  return violations;
}

const files =
  mode === 'dist'
    ? walk('dist', distIgnoredPathParts)
    : sourceRoots.flatMap(sourceRoot =>
        walk(sourceRoot, sourceIgnoredPathParts)
      );

const violations = auditFiles(
  files,
  mode === 'dist' ? distForbidden : sourceForbidden
);

if (violations.length > 0) {
  for (const violation of violations) {
    process.stderr.write(
      `${violation.file}:${violation.line}: ${violation.rule}\n`
    );
  }
  process.exit(1);
}
