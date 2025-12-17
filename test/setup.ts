/**
 * Test Setup File (Node/jsdom environments)
 *
 * This file runs before all Node/jsdom tests and sets up:
 * - fake-indexeddb for Dexie/IndexedDB testing in Node
 * - Global test utilities and mocks
 * - Shared setup from setup.shared.ts
 */

// Import shared setup (service worker mocks, etc.)
import './setup.shared';

// Import fake-indexeddb to polyfill IndexedDB in Node environment
import 'fake-indexeddb/auto';

// Import IDBKeyRange polyfill if needed
import { IDBKeyRange } from 'fake-indexeddb';
import { afterEach, vi } from 'vitest';
import { db } from '../src/db';
import { MessageProtocolType } from '../src/config/protocol';

// Make IDBKeyRange available globally
if (typeof globalThis.IDBKeyRange === 'undefined') {
  (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange =
    IDBKeyRange;
}

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

// Mock the WASM module - must be inline, not imported, due to hoisting
vi.mock('../src/assets/generated/wasm/gossip_wasm', async importOriginal => {
  const actual =
    await importOriginal<
      typeof import('../src/assets/generated/wasm/gossip_wasm')
    >();
  const { MockUserPublicKeys, MockUserSecretKeys } = await import(
    '../src/wasm/mock'
  );
  return {
    ...actual,
    UserPublicKeys: MockUserPublicKeys,
    UserSecretKeys: MockUserSecretKeys,
  };
});

// Mock the message protocol factory to always return mock protocol
vi.mock('../src/api/messageProtocol', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/api/messageProtocol')>();
  return {
    ...actual,
    createMessageProtocol: vi.fn(() =>
      actual.createMessageProtocol(MessageProtocolType.MOCK)
    ),
  };
});

// Optional: Add custom matchers or global test utilities here
// Example: expect.extend({ ... })

// Clean up between tests to avoid state leakage

afterEach(async () => {
  // Clean up database using Dexie's delete method which properly handles closing
  // This avoids "Another connection wants to delete" warnings
  try {
    // Dexie's delete() method automatically closes the connection if open
    // and handles all cleanup properly
    await db.delete();
  } catch (_) {
    // Ignore errors - database might already be deleted or closed
  }
});

// Log setup completion
console.log('✓ Test setup complete: fake-indexeddb initialized');
