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

/**
 * Licenses for native dependencies.
 *
 * Android artifacts are resolved from remote Maven repositories and iOS pods
 * from the CocoaPods trunk, so unlike npm and Cargo there is no local checkout
 * to harvest a LICENSE file from. Recording the license here keeps the
 * inventory honest, and the assertion below makes the record mandatory: a new
 * native dependency fails this script until someone looks up its terms.
 *
 * Keyed by coordinate without version, because a version bump does not
 * normally change the license.
 */
const nativeLicenses = new Map([
  // AndroidX: Apache-2.0 across the board.
  ['androidx.activity:activity', 'Apache-2.0'],
  ['androidx.activity:activity-compose', 'Apache-2.0'],
  ['androidx.activity:activity-ktx', 'Apache-2.0'],
  ['androidx.appcompat:appcompat', 'Apache-2.0'],
  ['androidx.biometric:biometric', 'Apache-2.0'],
  ['androidx.camera:camera-camera2', 'Apache-2.0'],
  ['androidx.camera:camera-lifecycle', 'Apache-2.0'],
  ['androidx.camera:camera-view', 'Apache-2.0'],
  ['androidx.compose.material3:material3', 'Apache-2.0'],
  ['androidx.compose.material3:material3-window-size-class', 'Apache-2.0'],
  ['androidx.coordinatorlayout:coordinatorlayout', 'Apache-2.0'],
  ['androidx.core:core', 'Apache-2.0'],
  ['androidx.core:core-ktx', 'Apache-2.0'],
  ['androidx.core:core-splashscreen', 'Apache-2.0'],
  ['androidx.fragment:fragment', 'Apache-2.0'],
  ['androidx.webkit:webkit', 'Apache-2.0'],
  ['androidx.work:work-runtime', 'Apache-2.0'],
  ['androidx.work:work-runtime-ktx', 'Apache-2.0'],
  // Kotlin and Cordova runtimes.
  ['org.jetbrains.kotlinx:kotlinx-coroutines-android', 'Apache-2.0'],
  ['org.jetbrains.kotlinx:kotlinx-coroutines-core', 'Apache-2.0'],
  ['org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm', 'Apache-2.0'],
  ['org.apache.cordova:framework', 'Apache-2.0'],
  // JNA is dual-licensed; Gossip uses it under Apache-2.0 for the UniFFI
  // Kotlin bindings.
  ['net.java.dev.jna:jna', 'Apache-2.0 OR LGPL-2.1-or-later'],
  // Google. ML Kit is NOT open source: it ships under Google's ML Kit Terms
  // of Service, which permit Google to collect usage and diagnostic data from
  // the device. It reaches the APK transitively through
  // @capacitor/barcode-scanner -> io.ionic.libs:ionbarcode-android, and pulls
  // in Play Services base, Firebase components, and the Google
  // datatransport/Clearcut logging pipeline with it.
  [
    'com.google.mlkit:barcode-scanning',
    'NOASSERTION (Google ML Kit Terms of Service)',
  ],
  ['com.google.zxing:core', 'Apache-2.0'],
  ['com.google.android.material:material', 'Apache-2.0'],
  // Ionic / OutSystems support libraries.
  ['io.ionic.libs:ionbarcode-android', 'Apache-2.0'],
  ['io.ionic.libs:ionfilesystem-android', 'Apache-2.0'],
  // iOS pods resolved from the CocoaPods trunk.
  ['IONFilesystemLib', 'Apache-2.0'],
  ['KeychainSwift', 'MIT'],
  ['OSBarcodeLib', 'Apache-2.0'],
]);

/** Gradle configurations whose dependencies are packaged into the shipped APK. */
const shippedGradleConfigurations = new Set([
  'implementation',
  'api',
  'compileOnly',
  'runtimeOnly',
]);

/**
 * Maven coordinates that Gradle substitutes with a local project already
 * inventoried through npm. Capacitor plugins compile against
 * com.capacitorjs:core, which resolves to the :capacitor-android module inside
 * node_modules/@capacitor/android rather than to a Maven artifact. Listing it
 * would double-count the same code under two ecosystems — the same reason the
 * iOS side skips :path pods.
 */
const gradleLocalSubstitutions = new Set(['com.capacitorjs:core']);

/**
 * Resolve `ext` variables from a Gradle file.
 *
 * Capacitor modules declare their own defaults with
 * `name = project.hasProperty('name') ? rootProject.ext.name : 'default'`, and
 * the root android/variables.gradle overrides them. Root values therefore win.
 */
function gradleVariables(source) {
  const variables = new Map();

  const withDefault =
    /(\w+)\s*=\s*project\.hasProperty\([^)]*\)\s*\?[^:]*:\s*'([^']*)'/g;
  for (const match of source.matchAll(withDefault)) {
    variables.set(match[1], match[2]);
  }

  const plain = /^\s*(\w+)\s*=\s*'([^']*)'\s*$/gm;
  for (const match of source.matchAll(plain)) {
    variables.set(match[1], match[2]);
  }

  return variables;
}

/** Gradle modules that contribute code to the shipped APK. */
function androidModuleGradleFiles() {
  const files = [join(root, 'android/app/build.gradle')];
  const settings = readFileSync(
    join(root, 'android/capacitor.settings.gradle'),
    'utf8'
  );

  for (const match of settings.matchAll(
    /projectDir\s*=\s*new File\('([^']+)'\)/g
  )) {
    files.push(resolve(root, 'android', match[1], 'build.gradle'));
  }

  return files.filter(file => existsSync(file));
}

function androidPackages() {
  const rootVariables = gradleVariables(
    readFileSync(join(root, 'android/variables.gradle'), 'utf8')
  );
  const packages = [];

  // group:name:version, optionally with an @aar/@jar artifact-type suffix.
  const dependencyPattern =
    /^\s*(\w+)\s*[( ]\s*["']([^"':]+):([^"':]+):([^"'@]+)(@\w+)?["']/gm;

  for (const file of androidModuleGradleFiles()) {
    const source = readFileSync(file, 'utf8');
    const variables = new Map([
      ...gradleVariables(source),
      ...rootVariables, // root overrides module defaults
    ]);

    for (const match of source.matchAll(dependencyPattern)) {
      const [, configuration, group, name, rawVersion] = match;
      if (!shippedGradleConfigurations.has(configuration)) continue;
      if (gradleLocalSubstitutions.has(`${group}:${name}`)) continue;

      // Interpolated versions ("$var" / "${var}") resolve from the ext maps.
      const version = rawVersion.replace(
        /\$\{?(\w+)\}?/g,
        (whole, variable) => variables.get(variable) ?? whole
      );

      packages.push({
        ecosystem: 'Android',
        name: `${group}:${name}`,
        version,
        license: nativeLicenses.get(`${group}:${name}`) ?? 'NOASSERTION',
        source: `maven:${group}:${name}:${version}`,
        origin: relative(root, file),
        evidence: [],
      });
    }
  }

  return deduplicatePackages(packages);
}

function iosPackages() {
  const lockPath = join(root, 'ios/App/Podfile.lock');
  if (!existsSync(lockPath)) return [];

  const lock = readFileSync(lockPath, 'utf8');

  // Pods sourced from a spec repo are genuinely third party. Pods listed under
  // EXTERNAL SOURCES resolve to :path entries inside node_modules and are
  // already inventoried as npm packages, so listing them again would
  // double-count the same code.
  // Capture the indented block under the heading. An `$`-terminated lazy match
  // would stop at the first line end under the /m flag.
  const specRepoSection = lock.match(/^SPEC REPOS:\n((?: +.*\n?)*)/m);
  const externalPods = new Set(
    [...lock.matchAll(/^ {2}(\S+):\n {4}:path:/gm)].map(match => match[1])
  );

  const remotePods = specRepoSection
    ? [...specRepoSection[1].matchAll(/^ {4}- (\S+)$/gm)].map(match => match[1])
    : [];

  const checksums = new Map(
    [...lock.matchAll(/^ {2}(\S+): ([0-9a-f]{40})$/gm)].map(match => [
      match[1],
      match[2],
    ])
  );
  const versions = new Map(
    [...lock.matchAll(/^ {2}- (\S+) \(([^)]+)\)/gm)].map(match => [
      match[1],
      match[2],
    ])
  );

  return remotePods
    .filter(pod => !externalPods.has(pod))
    .map(pod => ({
      ecosystem: 'CocoaPods',
      name: pod,
      version: versions.get(pod) ?? 'unknown',
      license: nativeLicenses.get(pod) ?? 'NOASSERTION',
      source: `cocoapods:trunk:${pod}`,
      // CocoaPods records a SHA-1 of the podspec, which pins the resolved
      // artifact the same way npm's integrity field does.
      integrity: checksums.has(pod) ? `sha1-${checksums.get(pod)}` : undefined,
      evidence: [],
    }))
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

function renderNotice(title, groups, { includesNative = false } = {}) {
  const packages = groups.flat().sort(comparePackages);
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

  const scope = includesNative
    ? [
        'This file lists third-party packages identified from the committed npm',
        'lockfiles, Cargo metadata, the Android Gradle build files, and the',
        'CocoaPods lockfile. It does not change their licenses. Package authors',
        'retain their copyrights and other rights.',
        '',
        'SCOPE LIMITATION (Android): Gradle entries are the coordinates this',
        'repository and its Capacitor plugins declare directly. Artifacts pulled',
        'in transitively by those coordinates are not individually enumerated,',
        'because resolving the full Maven graph requires a network fetch and an',
        'Android SDK. The most significant transitive closure is the one under',
        'com.google.mlkit:barcode-scanning, which adds Google Play Services base,',
        'Firebase components, and the Google datatransport ("Clearcut") logging',
        'pipeline to the shipped APK.',
      ]
    : [
        'This file lists third-party packages identified from the committed npm',
        'lockfiles and Cargo metadata. It does not change their licenses. Package',
        'authors retain their copyrights and other rights.',
      ];

  const lines = [
    title,
    '='.repeat(title.length),
    '',
    ...scope,
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
    if (pkg.origin) lines.push(`Declared in: ${pkg.origin}`);
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

// Native dependencies apply to the application only: gossip-sdk is a
// JavaScript package with no Gradle or CocoaPods surface of its own.
const android = androidPackages();
const ios = iosPackages();

// Force a deliberate decision on every native dependency. Without this, a new
// Capacitor plugin would quietly land in the APK and be published as
// NOASSERTION, which is how the ML Kit dependency went undisclosed.
const unrecordedNative = [...android, ...ios].filter(
  pkg => !nativeLicenses.has(pkg.name)
);

if (unrecordedNative.length > 0) {
  throw new Error(
    `Native dependencies without a recorded license: ${unrecordedNative
      .map(pkg => `${pkg.ecosystem}:${pkg.name}@${pkg.version}`)
      .join(', ')}\n` +
      'Look up the terms and add them to nativeLicenses in this script.'
  );
}

for (const coordinate of nativeLicenses.keys()) {
  if (![...android, ...ios].some(pkg => pkg.name === coordinate)) {
    throw new Error(
      `nativeLicenses records ${coordinate}, but nothing declares it any more. ` +
        'Remove the entry so the record keeps describing what actually ships.'
    );
  }
}

updateOutput(
  'public/THIRD_PARTY_NOTICES.txt',
  renderNotice('Gossip Third-Party Notices', [rootNpm, cargo, android, ios], {
    includesNative: true,
  })
);
updateOutput(
  'gossip-sdk/THIRD_PARTY_NOTICES.txt',
  renderNotice('Gossip SDK Third-Party Notices', [sdkNpm, cargo])
);

console.log(
  checkOnly
    ? 'Third-party notices are up to date.'
    : 'Third-party notices generated.'
);
