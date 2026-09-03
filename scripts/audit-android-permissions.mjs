/**
 * Android permission audit.
 *
 * Capacitor plugins ship their own AndroidManifest.xml, and the Android manifest
 * merger unions every permission they declare into the shipped APK. A plugin can
 * therefore add a user-visible permission during a routine dependency bump with
 * no change to this repository's own manifest. That already happened once:
 * @capacitor/background-runner contributed three location permissions, and only
 * ACCESS_BACKGROUND_LOCATION was being stripped.
 *
 * This script reproduces the union offline, applies the app manifest's
 * tools:node="remove" directives, and compares the result against an explicit
 * allowlist. It runs from committed sources, so it needs no Android SDK and no
 * prior Gradle build.
 *
 * It is deliberately strict in both directions:
 *   - a permission that survives but is not allowlisted fails the audit;
 *   - an allowlist entry no longer contributed by anything also fails, so the
 *     allowlist cannot rot into a list of permissions nobody grants any more.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appManifestPath = join(root, 'android/app/src/main/AndroidManifest.xml');
const settingsGradlePath = join(root, 'android/capacitor.settings.gradle');

/**
 * Permissions the shipped APK is allowed to declare, each with the reason it
 * exists. Adding an entry here is a deliberate product decision: every one of
 * these is visible to users on the store listing and to anyone examining an
 * installed APK, which matters for an app whose threat model includes device
 * inspection.
 */
const allowedPermissions = new Map([
  ['android.permission.INTERNET', 'Core messaging and blockchain RPC.'],
  [
    'android.permission.ACCESS_NETWORK_STATE',
    'Connectivity detection for sync and offline handling.',
  ],
  ['android.permission.CAMERA', 'QR code scanning for contacts and invites.'],
  [
    'android.permission.POST_NOTIFICATIONS',
    'Local notifications for received messages.',
  ],
  [
    'android.permission.USE_BIOMETRIC',
    'Optional biometric unlock of the stored password.',
  ],
  [
    'android.permission.USE_FINGERPRINT',
    'Legacy biometric API for API levels below 28.',
  ],
  [
    'android.permission.FOREGROUND_SERVICE',
    'Background message sync via @capacitor/background-runner.',
  ],
  [
    'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
    'Required service type declaration for the sync foreground service.',
  ],
  [
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'Re-register background sync after reboot.',
  ],
  [
    'android.permission.SCHEDULE_EXACT_ALARM',
    'Background sync scheduling via @capacitor/background-runner.',
  ],
  [
    'android.permission.WAKE_LOCK',
    'Hold the CPU awake for the duration of a background sync tick.',
  ],
  [
    'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    'Prompt to exempt background sync from Doze on aggressive OEM builds.',
  ],
]);

/** Matches <uses-permission .../>, capturing the attribute block. */
const usesPermissionPattern = /<uses-permission\b([^>]*)>/g;

function attribute(attributes, name) {
  const match = attributes.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return match?.[1];
}

/**
 * Reads one manifest and splits its <uses-permission> entries into those it
 * contributes and those it removes via tools:node="remove".
 */
function readManifestPermissions(path) {
  const declared = new Set();
  const removed = new Set();
  if (!existsSync(path)) return { declared, removed };

  const xml = readFileSync(path, 'utf8');
  for (const match of xml.matchAll(usesPermissionPattern)) {
    const attributes = match[1];
    const name = attribute(attributes, 'android:name');
    if (!name) continue;

    // The merger also understands "removeAll" and "replace"; this project only
    // uses "remove", so anything else is treated as a contribution.
    if (attribute(attributes, 'tools:node') === 'remove') removed.add(name);
    else declared.add(name);
  }

  return { declared, removed };
}

/**
 * Native module manifests, discovered from the generated Capacitor settings
 * file rather than a hardcoded list, so a newly synced plugin is audited
 * automatically instead of silently escaping the audit.
 */
function pluginManifestPaths() {
  const settings = readFileSync(settingsGradlePath, 'utf8');
  const pattern = /projectDir\s*=\s*new File\('([^']+)'\)/g;
  const paths = [];

  for (const match of settings.matchAll(pattern)) {
    // Paths in capacitor.settings.gradle are relative to the android/ directory.
    const moduleDir = resolve(root, 'android', match[1]);
    paths.push({
      module: match[1].replace(/^\.\.\/node_modules\//, ''),
      manifest: join(moduleDir, 'src/main/AndroidManifest.xml'),
    });
  }

  return paths;
}

const app = readManifestPermissions(appManifestPath);
const contributors = new Map();

for (const [permission] of app.declared.entries()) {
  contributors.set(permission, ['android/app/src/main/AndroidManifest.xml']);
}

for (const { module, manifest } of pluginManifestPaths()) {
  const { declared } = readManifestPermissions(manifest);
  for (const permission of declared) {
    const existing = contributors.get(permission) ?? [];
    existing.push(module);
    contributors.set(permission, existing);
  }
}

// The merged result: everything contributed, minus what the app removes.
const merged = new Map(
  [...contributors.entries()].filter(
    ([permission]) => !app.removed.has(permission)
  )
);

const unexpected = [...merged.entries()]
  .filter(([permission]) => !allowedPermissions.has(permission))
  .sort(([a], [b]) => a.localeCompare(b));

const stale = [...allowedPermissions.keys()]
  .filter(permission => !merged.has(permission))
  .sort();

// A remove directive for a permission nothing declares is dead weight that
// hides the fact the upstream dependency changed shape.
const unusedRemovals = [...app.removed]
  .filter(permission => !contributors.has(permission))
  .sort();

const problems = [];

if (unexpected.length > 0) {
  problems.push(
    'Permissions reach the merged manifest but are not allowlisted:\n' +
      unexpected
        .map(
          ([permission, sources]) =>
            `  ${permission}\n    contributed by: ${sources.join(', ')}`
        )
        .join('\n') +
      '\n\n  Either strip it with tools:node="remove" in\n' +
      '  android/app/src/main/AndroidManifest.xml, or add it to\n' +
      '  allowedPermissions in this script with the reason it is needed.'
  );
}

if (stale.length > 0) {
  problems.push(
    'Allowlisted permissions that nothing declares any more:\n' +
      stale.map(permission => `  ${permission}`).join('\n') +
      '\n\n  Remove them from allowedPermissions so the allowlist keeps\n' +
      '  describing what actually ships.'
  );
}

if (unusedRemovals.length > 0) {
  problems.push(
    'tools:node="remove" directives with nothing to remove:\n' +
      unusedRemovals.map(permission => `  ${permission}`).join('\n') +
      '\n\n  The contributing dependency no longer declares these. Drop the\n' +
      '  directives, and re-check whether the dependency changed in other ways.'
  );
}

if (problems.length > 0) {
  console.error(`Android permission audit failed.\n\n${problems.join('\n\n')}`);
  process.exit(1);
}

console.log(
  `Android permission audit passed: ${merged.size} permission(s) allowlisted, ` +
    `${app.removed.size} stripped.`
);
