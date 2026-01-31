/**
 * Gossip Storage Test Setup
 *
 * Uses the Storage class with NodeFileSystem for real file I/O testing.
 */

import { beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { rmdirSync } from 'fs';

import { Storage, NodeFileSystem } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// TEST CONFIGURATION
// ============================================================

const TEST_DIR = resolve(tmpdir(), 'gossip-storage-test-' + process.pid);

// ============================================================
// GLOBAL TEST INSTANCES
// ============================================================

let storage: Storage | null = null;
let nodeFs: NodeFileSystem | null = null;

/**
 * Get the Storage instance (throws if not initialized).
 */
export function getStorage(): Storage {
  if (!storage) {
    throw new Error('Storage not initialized. Tests must run after beforeAll.');
  }
  return storage;
}

/**
 * Get the underlying NodeFileSystem (for test verification).
 */
export function getNodeFs(): NodeFileSystem {
  if (!nodeFs) {
    throw new Error('NodeFileSystem not initialized.');
  }
  return nodeFs;
}

// ============================================================
// TEST LIFECYCLE HOOKS
// ============================================================

beforeAll(async () => {
  console.log(`[Setup] Test directory: ${TEST_DIR}`);

  // Create NodeFileSystem
  nodeFs = new NodeFileSystem(TEST_DIR);

  // Create Storage with NodeFileSystem
  storage = new Storage(nodeFs);

  // Load WASM bytes for Node.js
  const gossipWasmPath = resolve(
    __dirname,
    '../generated/gossip_storage_bg.wasm'
  );
  const gossipWasmBytes = readFileSync(gossipWasmPath);

  const waSqliteWasmPath = resolve(
    __dirname,
    '../node_modules/wa-sqlite/dist/wa-sqlite.wasm'
  );
  const waSqliteWasmBytes = readFileSync(waSqliteWasmPath);

  console.log('[Setup] Initializing storage...');
  await storage.init({
    gossipWasmBytes,
    waSqliteWasmBytes,
  });
  console.log(`[Setup] Storage initialized: ${storage.getWasmVersion()}`);
});

beforeEach(async () => {
  // Lock any existing session before resetting filesystem
  if (storage && storage.isInitialized()) {
    try {
      if (storage.isUnlocked()) {
        await storage.lockSession();
      }
    } catch {
      // Ignore errors
    }
  }

  // Reset filesystem between tests for isolation
  if (nodeFs) {
    nodeFs.reset();
  }

  // Reinitialize storage (recreates 2MB addressing blob)
  if (storage && storage.isInitialized()) {
    storage.reinitializeStorage();
  }
});

afterAll(async () => {
  // Close storage (cleanup filesystem)
  if (storage) {
    await storage.close();
  }

  // Remove test directory
  try {
    rmdirSync(TEST_DIR);
  } catch {
    // Ignore errors
  }

  console.log('[Teardown] Test files cleaned up');
});
