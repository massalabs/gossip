#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function log(msg) {
  console.log(`[run-ios-device] ${msg}`);
}

function fail(msg) {
  console.error(`[run-ios-device] ERROR: ${msg}`);
  process.exit(1);
}

function getDeviceArg() {
  const device = process.argv[2];
  if (!device) {
    fail(
      'Missing device name or target ID argument.\n' +
        'Usage: npm run cap:run:ios:device -- "Device Name"\n' +
        '   or: npm run cap:run:ios:device -- <target-id>\n\n' +
        'First, list available devices with: npm run cap:list:ios'
    );
  }
  return device;
}

function main() {
  const device = getDeviceArg();
  log(`Building and running on device: ${device}`);

  try {
    // Build
    log('Building web assets...');
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });

    // Sync
    log('Syncing to iOS...');
    execSync('cap sync ios', { cwd: ROOT, stdio: 'inherit' });

    // Run on device
    log(`Running on device: ${device}`);
    execSync(`cap run ios --target-name "${device}"`, {
      cwd: ROOT,
      stdio: 'inherit',
    });
  } catch (error) {
    fail(`Failed to run on device: ${error.message}`);
  }
}

main();
