/**
 * Shared Test Setup
 *
 * This file contains setup that should be shared across all test environments:
 * - Service worker mocks
 * - Other shared utilities and mocks
 */

import { vi } from 'vitest';

// Mock service worker setup to prevent registration attempts in tests
// Service workers don't work well in test environments and cause errors
vi.mock('../src/services/serviceWorkerSetup', () => ({
  setupServiceWorker: vi.fn().mockResolvedValue(undefined),
}));

// Mock capacitor biometric auth which is not available in test environments
vi.mock('@aparajita/capacitor-biometric-auth', () => {
  const mockFn = vi.fn();
  class BiometryError extends Error {}
  const BiometryType = {
    NONE: 'none',
    TOUCH_ID: 'touchId',
    FACE_ID: 'faceId',
    FINGERPRINT: 'fingerprint',
  };
  // Some consumers expect BiometryErrorType; mirror BiometryType for compatibility
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
