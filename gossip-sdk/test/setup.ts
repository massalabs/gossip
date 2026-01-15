/**
 * SDK Test Setup File
 *
 * This file runs before all SDK tests and sets up:
 * - fake-indexeddb for Dexie/IndexedDB testing in Node
 * - Global test utilities and mocks
 * - Mocks for platform-specific modules (biometrics, notifications, etc.)
 */

// Import fake-indexeddb to polyfill IndexedDB in Node environment
import 'fake-indexeddb/auto';

// Import IDBKeyRange polyfill
import { IDBKeyRange } from 'fake-indexeddb';
import { vi } from 'vitest';

// Make IDBKeyRange available globally (required for Dexie in Node)
if (typeof globalThis.IDBKeyRange === 'undefined') {
  (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange =
    IDBKeyRange;
}

// Mock the notification service (Node.js doesn't have notifications)
vi.mock('@/services/notifications', () => ({
  notificationService: {
    scheduleNotification: vi.fn(),
    cancelNotification: vi.fn(),
    requestPermission: vi.fn(),
    showNewDiscussionNotification: vi.fn(),
    showNewMessageNotification: vi.fn(),
  },
}));

// Mock service worker setup (Node.js doesn't have service workers)
vi.mock('@/services/serviceWorkerSetup', () => ({
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

// Mock capacitor preferences (used for storing active seekers)
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn().mockResolvedValue({ value: null }),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock capacitor app (used for app state detection)
vi.mock('@capacitor/app', () => ({
  App: {
    getState: vi.fn().mockResolvedValue({ isActive: true }),
    addListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
  },
}));

// Mock the biometric service
vi.mock('@/services/biometricService', () => ({
  biometricService: {
    checkAvailability: vi.fn().mockResolvedValue({ available: false }),
    createCredential: vi.fn(),
    authenticate: vi.fn(),
  },
}));

// Use MOCK message protocol for tests
import { MessageProtocolType } from '@/config/protocol';
vi.mock('@/api/messageProtocol', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/messageProtocol')>();
  const mockProtocol = actual.createMessageProtocol(MessageProtocolType.MOCK);
  return {
    ...actual,
    createMessageProtocol: vi.fn(() => mockProtocol),
    restMessageProtocol: mockProtocol,
  };
});

console.log('SDK test setup complete: fake-indexeddb initialized');
