/**
 * SDK Test Setup File
 *
 * Minimal environment setup for SDK tests:
 * - fake-indexeddb for Dexie/IndexedDB in Node
 * - IDBKeyRange polyfill
 * - WASM initialization
 * - Shared database cleanup
 */

import 'fake-indexeddb/auto';
import { IDBKeyRange } from 'fake-indexeddb';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../src/db.js';
import { initializeWasm } from '../src/wasm/loader.js';

if (typeof process !== 'undefined') {
  process.env.GOSSIP_API_URL = 'https://api.usegossip.com';
  process.env.VITE_GOSSIP_API_URL = 'https://api.usegossip.com';
}

if (typeof globalThis.IDBKeyRange === 'undefined') {
  (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange =
    IDBKeyRange;
}

async function clearDatabase(): Promise<void> {
  const db = getDb();
  await Promise.all(db.tables.map(table => table.clear()));
}

beforeAll(async () => {
  // Initialize WASM before any tests run
  await initializeWasm();

  const db = getDb();
  if (!db.isOpen()) {
    await db.open();
  }
  await clearDatabase();
});

beforeEach(async () => {
  const db = getDb();
  if (!db.isOpen()) {
    await db.open();
  }
  await clearDatabase();
});

afterAll(async () => {
  try {
    await clearDatabase();
    await getDb().close();
  } catch (_) {
    // Ignore errors - database might already be closed
  }
});

console.log('SDK test setup complete: fake-indexeddb initialized');
