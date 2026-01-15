/**
 * SDK Test Setup File
 *
 * This file runs before all SDK tests and sets up:
 * - fake-indexeddb for Dexie/IndexedDB testing in Node
 * - Global test utilities and mocks
 * - Mocks for platform-specific modules (biometrics, notifications, etc.)
 * - Real WASM modules loaded from filesystem
 */

// Import fake-indexeddb to polyfill IndexedDB in Node environment
import 'fake-indexeddb/auto';

// Ensure API base URL points to production for tests
if (typeof process !== 'undefined') {
  process.env.GOSSIP_API_URL = 'https://api.usegossip.com';
  process.env.VITE_GOSSIP_API_URL = 'https://api.usegossip.com';
}

// Import IDBKeyRange polyfill
import { IDBKeyRange } from 'fake-indexeddb';
import { afterEach, vi } from 'vitest';
import { db } from '../src/db';

// Make IDBKeyRange available globally (required for Dexie in Node)
if (typeof globalThis.IDBKeyRange === 'undefined') {
  (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange =
    IDBKeyRange;
}

// Mock localStorage for zustand persist middleware
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
})();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// Mock the notification service (Node.js doesn't have notifications)
// Note: SDK doesn't import this directly, but React app code might via transitive imports
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

// Mock price fetching to avoid CoinGecko rate limits
vi.mock('@/utils/fetchPrice', async () => {
  const actual = await import('@/utils/fetchPrice');
  return {
    ...actual,
    priceFetcher: {
      getTokenPrice: vi.fn().mockResolvedValue(0.01),
      getTokenPrices: vi.fn().mockImplementation(async (bases: string[]) => {
        return Object.fromEntries(
          bases.map(base => [base.toUpperCase(), 0.01])
        );
      }),
      getUsdPrice: vi.fn().mockResolvedValue(0.01),
      getUsdPrices: vi.fn().mockImplementation(async (bases: string[]) => {
        return Object.fromEntries(
          bases.map(base => [base.toUpperCase(), 0.01])
        );
      }),
    },
  };
});

// Use real WASM - configure it to load from filesystem in Node.js instead of fetch
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

vi.mock('@/assets/generated/wasm/gossip_wasm', async () => {
  const actual = await import('@/assets/generated/wasm/gossip_wasm');
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

// Clean up between tests to avoid state leakage
afterEach(async () => {
  try {
    // Dexie's delete() method automatically closes the connection if open
    await db.delete();
  } catch (_) {
    // Ignore errors - database might already be deleted or closed
  }
});

console.log('SDK test setup complete: fake-indexeddb initialized');
