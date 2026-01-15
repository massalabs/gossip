/**
 * SDK Test Setup File
 *
 * This file runs before all SDK tests and sets up:
 * - fake-indexeddb for Dexie/IndexedDB testing in Node
 * - Global test utilities and mocks
 *
 * Note: Additional mocks for WASM, notifications, biometrics, etc.
 * will be added in Step 3 when tests are implemented.
 */

// Import fake-indexeddb to polyfill IndexedDB in Node environment
import 'fake-indexeddb/auto';

// Import IDBKeyRange polyfill
import { IDBKeyRange } from 'fake-indexeddb';

// Make IDBKeyRange available globally (required for Dexie in Node)
if (typeof globalThis.IDBKeyRange === 'undefined') {
  (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange =
    IDBKeyRange;
}

console.log('SDK test setup complete: fake-indexeddb initialized');
