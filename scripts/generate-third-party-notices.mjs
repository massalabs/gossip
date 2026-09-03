import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const evidenceNames = /^(licen[cs]e|copying|copyright|notice)([-_.].*)?$/i;

const unresolvedRust = new Map([
  [
    'massa_hash@4.0.0',
    'No package-level license declaration; pinned Massa repository terms require legal compatibility review.',
  ],
  [
    'massa_serialization@4.0.0',
    'No package-level license declaration; pinned Massa repository terms require legal compatibility review.',
  ],
  [
    'massa_signature@4.0.0',
    'No package-level license declaration; pinned Massa repository terms require legal compatibility review.',
  ],
  [
    'pq-rerand@0.2.0',
    'No license declaration or license file was found at the pinned revision.',
  ],
  [
    'transition@0.1.0',
    'No license declaration or license file was found at the pinned revision.',
  ],
  [
    'transition-macros@0.1.0',
    'No license declaration or license file was found at the pinned revision.',
  ],
]);

function normalizeText(value) {
  return (
    value
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
      .trimEnd() + '\n'
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function packageEvidence(directory) {
  if (
    !directory ||
    !existsSync(directory) ||
    !statSync(directory).isDirectory()
  ) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && evidenceNames.test(entry.name))
    .map(entry => {
      const path = join(directory, entry.name);
      const text = normalizeText(readFileSync(path, 'utf8'));
      return { name: entry.name, text, hash: sha256(text) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function findInstalledNpmPackage(
  lockDirectory,
  packagePath,
  expectedName,
  expectedVersion
) {
  const candidates = [
    join(lockDirectory, packagePath),
    join(root, packagePath),
  ];

  for (const candidate of candidates) {
    const manifest = join(candidate, 'package.json');
    if (!existsSync(manifest)) continue;

    const installed = readJson(manifest);
    if (
      installed.name === expectedName &&
      installed.version === expectedVersion
    ) {
      return candidate;
    }
  }

  return undefined;
}

function npmPackageName(packagePath) {
  const marker = 'node_modules/';
  const index = packagePath.lastIndexOf(marker);
  return index === -1 ? undefined : packagePath.slice(index + marker.length);
}

function npmPackages(lockRelativePath, excludedPaths = new Set()) {
  const lockPath = join(root, lockRelativePath);
  const lockDirectory = dirname(lockPath);
  const lock = readJson(lockPath);
  const packages = [];
  const bundledPackageNames = new Set(
    Object.values(lock.packages ?? {}).flatMap(entry =>
      Array.isArray(entry.bundleDependencies) ? entry.bundleDependencies : []
    )
  );

  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    if (!packagePath || entry.dev === true || excludedPaths.has(packagePath))
      continue;
    const name = entry.name ?? npmPackageName(packagePath);
    if (!name || !entry.version) continue;

    // npm versions differ on whether bundled packages also appear at the root.
    // Without integrity, those root files cannot be tied to a locked artifact.
    const installedDirectory =
      entry.optional !== true ||
      entry.integrity ||
      !bundledPackageNames.has(name)
        ? findInstalledNpmPackage(
            lockDirectory,
            packagePath,
            name,
            entry.version
          )
        : undefined;
    const installedManifest = installedDirectory
      ? readJson(join(installedDirectory, 'package.json'))
      : {};

    packages.push({
      ecosystem: 'npm',
      name,
      version: entry.version,
      license: entry.license ?? installedManifest.license ?? 'NOASSERTION',
      source: entry.resolved ?? packagePath,
      integrity: entry.integrity,
      evidence: packageEvidence(installedDirectory),
    });
  }

  return deduplicatePackages(packages);
}

function cargoRepositoryRoot(manifestPath) {
  let current = dirname(manifestPath);

  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirname(manifestPath);
}

function cargoPackages() {
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--manifest-path',
        'wasm/Cargo.toml',
        '--locked',
        '--format-version',
        '1',
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 }
    )
  );

  return metadata.packages
    .filter(pkg => pkg.source)
    .map(pkg => {
      const packageDirectory = dirname(pkg.manifest_path);
      let evidence = packageEvidence(packageDirectory);

      if (evidence.length === 0 && String(pkg.source).startsWith('git+')) {
        evidence = packageEvidence(cargoRepositoryRoot(pkg.manifest_path));
      }

      if (pkg.license_file) {
        const licenseFile = resolve(packageDirectory, pkg.license_file);
        if (existsSync(licenseFile)) {
          const text = normalizeText(readFileSync(licenseFile, 'utf8'));
          const item = {
            name: relative(packageDirectory, licenseFile),
            text,
            hash: sha256(text),
          };
          if (!evidence.some(existing => existing.hash === item.hash)) {
            evidence.push(item);
          }
        }
      }

      const key = `${pkg.name}@${pkg.version}`;
      const unresolved = unresolvedRust.get(key);

      return {
        ecosystem: 'Cargo',
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? 'NOASSERTION',
        source: String(pkg.source),
        unresolved,
        evidence: evidence.sort((a, b) => a.name.localeCompare(b.name)),
      };
    })
    .sort(comparePackages);
}

function comparePackages(a, b) {
  return (
    a.ecosystem.localeCompare(b.ecosystem) ||
    a.name.localeCompare(b.name) ||
    a.version.localeCompare(b.version) ||
    a.source.localeCompare(b.source)
  );
}

function deduplicatePackages(packages) {
  const unique = new Map();
  for (const pkg of packages) {
    const key = `${pkg.ecosystem}\0${pkg.name}\0${pkg.version}\0${pkg.source}`;
    if (!unique.has(key)) unique.set(key, pkg);
  }
  return [...unique.values()].sort(comparePackages);
}

function renderNotice(title, npm, cargo) {
  const packages = [...npm, ...cargo].sort(comparePackages);
  const texts = new Map();

  for (const pkg of packages) {
    for (const evidence of pkg.evidence) {
      const existing = texts.get(evidence.hash) ?? {
        text: evidence.text,
        packages: new Set(),
        names: new Set(),
      };
      existing.packages.add(`${pkg.ecosystem}:${pkg.name}@${pkg.version}`);
      existing.names.add(evidence.name);
      texts.set(evidence.hash, existing);
    }
  }

  const lines = [
    title,
    '='.repeat(title.length),
    '',
    'This file lists third-party packages identified from the committed npm',
    'lockfiles and Cargo metadata. It does not change their licenses. Package',
    'authors retain their copyrights and other rights.',
    '',
    'IMPORTANT: entries marked NOASSERTION or UNRESOLVED require legal review.',
    'Inclusion of available upstream text is evidence for review, not a conclusion',
    'that its terms are compatible with AGPL-3.0-or-later.',
    '',
    'COMPONENT INVENTORY',
    '-------------------',
    '',
  ];

  for (const pkg of packages) {
    const evidence = pkg.evidence
      .map(item => item.hash.slice(0, 16))
      .join(', ');
    lines.push(`${pkg.ecosystem}: ${pkg.name}@${pkg.version}`);
    lines.push(
      `License: ${pkg.license}${pkg.unresolved ? ' (UNRESOLVED)' : ''}`
    );
    lines.push(`Source: ${pkg.source}`);
    if (pkg.integrity) lines.push(`Integrity: ${pkg.integrity}`);
    lines.push(`License text references: ${evidence || 'none found'}`);
    if (pkg.unresolved) lines.push(`Review note: ${pkg.unresolved}`);
    lines.push('');
  }

  lines.push('LICENSE AND NOTICE TEXTS', '------------------------', '');

  for (const [hash, item] of [...texts.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    lines.push(`Text reference: ${hash.slice(0, 16)}`);
    lines.push(`SHA-256: ${hash}`);
    lines.push(`File names: ${[...item.names].sort().join(', ')}`);
    lines.push(`Used by: ${[...item.packages].sort().join(', ')}`);
    lines.push('');
    lines.push(item.text.trimEnd());
    lines.push('', '-'.repeat(78), '');
  }

  return normalizeText(lines.join('\n'));
}

function updateOutput(relativePath, content) {
  const path = join(root, relativePath);
  if (checkOnly) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
      throw new Error(`${relativePath} is not up to date`);
    }
    return;
  }

  writeFileSync(path, content);
}

const cargo = cargoPackages();
const unexpectedUnresolved = cargo.filter(
  pkg => pkg.license === 'NOASSERTION' && !pkg.unresolved
);

if (unexpectedUnresolved.length > 0) {
  throw new Error(
    `Unexpected Cargo packages without a license: ${unexpectedUnresolved
      .map(pkg => `${pkg.name}@${pkg.version}`)
      .join(', ')}`
  );
}

for (const [key] of unresolvedRust) {
  if (!cargo.some(pkg => `${pkg.name}@${pkg.version}` === key)) {
    throw new Error(`Expected unresolved Cargo package is absent: ${key}`);
  }
}

const rootNpm = npmPackages('package-lock.json', new Set(['gossip-sdk']));
const sdkNpm = npmPackages('gossip-sdk/package-lock.json');

updateOutput(
  'public/THIRD_PARTY_NOTICES.txt',
  renderNotice('Gossip Third-Party Notices', rootNpm, cargo)
);
updateOutput(
  'gossip-sdk/THIRD_PARTY_NOTICES.txt',
  renderNotice('Gossip SDK Third-Party Notices', sdkNpm, cargo)
);

console.log(
  checkOnly
    ? 'Third-party notices are up to date.'
    : 'Third-party notices generated.'
);
