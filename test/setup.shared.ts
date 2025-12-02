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
