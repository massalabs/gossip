/**
 * SDK Test Setup File
 *
 * This file runs before all SDK tests and sets up:
 * - fake-indexeddb for Dexie/IndexedDB testing in Node
 * - Global test utilities and mocks
 * - Shared setup from parent project
 */

// Import fake-indexeddb to polyfill IndexedDB in Node environment
import 'fake-indexeddb/auto';

// Import IDBKeyRange polyfill if needed
import { IDBKeyRange } from 'fake-indexeddb';
import { afterEach, vi } from 'vitest';
import { db } from '../../src/db';

// Make IDBKeyRange available globally
if (typeof globalThis.IDBKeyRange === 'undefined') {
  (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange =
    IDBKeyRange;
}

// Mock the notification service to prevent window access (Node.js doesn't have notifications)
vi.mock('../../src/services/notifications', () => ({
  notificationService: {
    scheduleNotification: vi.fn(),
    cancelNotification: vi.fn(),
    requestPermission: vi.fn(),
    showNewDiscussionNotification: vi.fn(),
    showNewMessageNotification: vi.fn(),
  },
}));

// Use real WASM - configure it to load from filesystem in Node.js
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Override WASM initialization to use filesystem in Node.js instead of fetch
vi.mock('../../src/assets/generated/wasm/gossip_wasm', async () => {
  const actual = await import('../../src/assets/generated/wasm/gossip_wasm');
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const wasmPath = join(
    __dirname,
    '../../src/assets/generated/wasm/gossip_wasm_bg.wasm'
  );

  return {
    ...actual,
    default: async () => {
      // In Node.js, read the WASM file from filesystem and pass as Uint8Array
      const wasmBytes = await readFile(wasmPath);
      return actual.default(wasmBytes);
    },
  };
});

// Mock service worker setup (Node.js doesn't have service workers)
vi.mock('../../src/services/serviceWorkerSetup', () => ({
  setupServiceWorker: vi.fn().mockResolvedValue(undefined),
}));

// Mock capacitor biometric auth (Node.js doesn't have biometrics)
vi.mock('@aparajita/capacitor-biometric-auth', () => {
  const mockFn = vi.fn();
  class BiometryError extends Error {}
  const BiometryType = {
    NONE: 'none',
    TOUCH_ID: 'touchId',
    FACE_ID: 'faceId',
    FINGERPRINT: 'fingerprint',
  };
  const BiometryErrorType = BiometryType;

  return {
    BiometricAuth: {
      isAvailable: mockFn,
      verify: mockFn,
      getAvailableMethods: mockFn,
      getEnrolledLevel: mockFn,
    },
    BiometryError,
    BiometryType,
    BiometryErrorType,
  };
});

// Use MOCK message protocol for tests (like parent project)
import { MessageProtocolType } from '../../src/config/protocol';
vi.mock('../../src/api/messageProtocol', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/api/messageProtocol')>();
  const mockProtocol = actual.createMessageProtocol(MessageProtocolType.MOCK);
  return {
    ...actual,
    createMessageProtocol: vi.fn(() => mockProtocol),
    // Also export the mock protocol as restMessageProtocol so authService uses it
    restMessageProtocol: mockProtocol,
  };
});

// Clean up between tests to avoid state leakage
// Note: Individual test files should open the database in their beforeEach
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
console.log('✓ SDK test setup complete: fake-indexeddb initialized');
