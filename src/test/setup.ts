/**
 * Test Setup File
 *
 * This file runs before all tests and sets up:
 * - fake-indexeddb for Dexie/IndexedDB testing in Node
 * - Global test utilities and mocks
 */

// Import fake-indexeddb to polyfill IndexedDB in Node environment
import 'fake-indexeddb/auto';

// Import IDBKeyRange polyfill if needed
import { IDBKeyRange } from 'fake-indexeddb';

// Make IDBKeyRange available globally
if (typeof globalThis.IDBKeyRange === 'undefined') {
  (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange =
    IDBKeyRange;
}

// Optional: Add custom matchers or global test utilities here
// Example: expect.extend({ ... })

// Clean up between tests to avoid state leakage
import { afterEach } from 'vitest';
import { indexedDB } from 'fake-indexeddb';

afterEach(async () => {
  // Clean up all IndexedDB databases after each test
  const dbs = await indexedDB.databases();
  await Promise.all(
    dbs.map(db => {
      if (db.name) {
        return new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(db.name!);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      }
    })
  );
});

// Log setup completion
console.log('✓ Test setup complete: fake-indexeddb initialized');
