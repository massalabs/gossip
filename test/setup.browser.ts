/**
 * Browser Test Setup File
 *
 * This file runs before all browser tests and sets up:
 * - All shared setup from setup.shared.ts (mocks, utilities, etc.)
 * - Browser-specific service worker mocks
 *
 * Note: Browser tests use real IndexedDB (no fake-indexeddb needed),
 * so we import setup.shared.ts instead of setup.ts to avoid Node-specific polyfills.
 */

// Import shared setup first (includes service worker mock and other utilities)
import './setup.shared';

// Add browser-specific service worker API mocks
// This provides a fallback in case the module mock doesn't catch everything
import { vi } from 'vitest';

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  const mockRegistration = {
    active: null,
    installing: null,
    waiting: null,
    update: vi.fn(),
    unregister: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as ServiceWorkerRegistration;

  const mockRegister = vi.fn().mockResolvedValue(mockRegistration);
  const mockGetRegistration = vi.fn().mockResolvedValue(null);
  const mockGetRegistrations = vi.fn().mockResolvedValue([]);
  const mockReady = Promise.resolve(mockRegistration);

  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      register: mockRegister,
      getRegistration: mockGetRegistration,
      getRegistrations: mockGetRegistrations,
      ready: mockReady,
      controller: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    },
    writable: true,
    configurable: true,
  });
}
