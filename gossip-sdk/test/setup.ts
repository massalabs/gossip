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

// Mock the notification service to prevent window access
vi.mock('../../src/services/notifications', () => ({
  notificationService: {
    scheduleNotification: vi.fn(),
    cancelNotification: vi.fn(),
    requestPermission: vi.fn(),
    showNewDiscussionNotification: vi.fn(),
    showNewMessageNotification: vi.fn(),
  },
}));

// Mock the WASM module - must be inline, not imported, due to hoisting
vi.mock('../../src/assets/generated/wasm/gossip_wasm', async importOriginal => {
  const actual =
    await importOriginal<
      typeof import('../../src/assets/generated/wasm/gossip_wasm')
    >();
  const { MockUserPublicKeys, MockUserSecretKeys } = await import(
    '../../src/wasm/mock'
  );
  return {
    ...actual,
    UserPublicKeys: MockUserPublicKeys,
    UserSecretKeys: MockUserSecretKeys,
  };
});

// Mock service worker setup
vi.mock('../../src/services/serviceWorkerSetup', () => ({
  setupServiceWorker: vi.fn().mockResolvedValue(undefined),
}));

// Mock capacitor biometric auth
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

// Clean up between tests to avoid state leakage
afterEach(async () => {
  // Clean up database using Dexie's delete method which properly handles closing
  try {
    await db.delete();
  } catch (_) {
    // Ignore errors - database might already be deleted or closed
  }
});

// Log setup completion
console.log('✓ SDK test setup complete: fake-indexeddb initialized');
