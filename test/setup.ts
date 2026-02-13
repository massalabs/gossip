/**
 * Test Setup File (Node/jsdom environments)
 *
 * This file runs before all Node/jsdom tests and sets up:
 * - SQLite in-memory database for testing
 * - Global test utilities and mocks
 * - Shared setup from setup.shared.ts
 */

// Import shared setup (service worker mocks, etc.)
import './setup.shared';

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { createRequire } from 'module';
import { afterEach, beforeAll, afterAll, vi } from 'vitest';
import { initDb, closeSqlite, clearAllTables } from '@massalabs/gossip-sdk';

const require = createRequire(import.meta.url);
const waSqlitePath = dirname(require.resolve('wa-sqlite/package.json'));
const waSqliteWasm = readFileSync(resolve(waSqlitePath, 'dist/wa-sqlite.wasm'));

// Mock the notification service to prevent window access
vi.mock('../src/services/notifications', () => ({
  notificationService: {
    scheduleNotification: vi.fn(),
    cancelNotification: vi.fn(),
    requestPermission: vi.fn(),
    showNewDiscussionNotification: vi.fn(),
    showNewMessageNotification: vi.fn(),
  },
}));

// Initialize SQLite before all tests
beforeAll(async () => {
  const wasmBinary = waSqliteWasm.buffer.slice(
    waSqliteWasm.byteOffset,
    waSqliteWasm.byteOffset + waSqliteWasm.byteLength
  );
  await initDb({ wasmBinary });
});

// Clean up between tests to avoid state leakage
afterEach(async () => {
  try {
    await clearAllTables();
  } catch {
    // Ignore errors - database might already be closed
  }
});

afterAll(async () => {
  try {
    await closeSqlite();
  } catch {
    // SQLite might already be closed
  }
});

// Log setup completion
console.log('✓ Test setup complete: SQLite in-memory database initialized');
