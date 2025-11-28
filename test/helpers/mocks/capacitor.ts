/**
 * Capacitor Mocks for Testing
 *
 * Provides mock implementations for Capacitor plugins and platform detection.
 * These mocks are essential for testing native mobile functionality in a Node/jsdom environment.
 *
 * Usage:
 * ```ts
 * // Setup all mocks at once
 * const mocks = setupCapacitorMocks('web'); // or 'native'
 *
 * // Or setup individual mocks
 * mockCapacitorWeb();
 * const appPlugin = mockAppPlugin();
 * ```
 *
 * Note: These mocks are necessary because Capacitor plugins don't have test equivalents
 * in standard testing libraries.
 */

import { vi } from 'vitest';

// ============================================================================
// Platform Detection Mocks
// ============================================================================

/**
 * Mock Capacitor as native platform (iOS/Android)
 * Use this when testing native-specific features
 */
export const mockCapacitorNative = () => {
  vi.mock('@capacitor/core', () => ({
    Capacitor: {
      isNativePlatform: vi.fn(() => true),
      getPlatform: vi.fn(() => 'ios'),
      isPluginAvailable: vi.fn(() => true),
    },
  }));
};

/**
 * Mock Capacitor as web platform
 * Use this for most tests (default behavior)
 */
export const mockCapacitorWeb = () => {
  vi.mock('@capacitor/core', () => ({
    Capacitor: {
      isNativePlatform: vi.fn(() => false),
      getPlatform: vi.fn(() => 'web'),
      isPluginAvailable: vi.fn(() => false),
    },
  }));
};

// ============================================================================
// App Plugin Mock (Deep Links & Lifecycle)
// ============================================================================

/**
 * Create a mock App plugin with event listener support
 * Returns a mock with helpers for triggering events in tests
 *
 * @example
 * ```ts
 * const appPlugin = createMockAppPlugin();
 * mockAppPlugin(appPlugin);
 *
 * // In test: Trigger a deep link
 * appPlugin.triggerEvent('appUrlOpen', { url: 'https://app.gossip.com/invite/abc' });
 * ```
 */
export const createMockAppPlugin = () => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();

  return {
    addListener: vi.fn(
      (eventName: string, callback: (event: unknown) => void) => {
        if (!listeners.has(eventName)) {
          listeners.set(eventName, new Set());
        }
        listeners.get(eventName)!.add(callback);

        return Promise.resolve({
          remove: vi.fn(() => {
            listeners.get(eventName)?.delete(callback);
          }),
        });
      }
    ),
    removeAllListeners: vi.fn(() => {
      listeners.clear();
      return Promise.resolve();
    }),
    // Test helper: Trigger events
    triggerEvent: (eventName: string, event: unknown) => {
      listeners.get(eventName)?.forEach(callback => callback(event));
    },
    // Test helper: Inspect listeners (for debugging)
    getListeners: () => listeners,
  };
};

/**
 * Mock the App plugin globally
 * @param mockPlugin Optional custom mock (uses createMockAppPlugin() by default)
 * @returns The mock plugin for use in tests
 */
export const mockAppPlugin = (mockPlugin = createMockAppPlugin()) => {
  vi.mock('@capacitor/app', () => ({
    App: mockPlugin,
  }));
  return mockPlugin;
};

// ============================================================================
// Biometric Auth Plugin Mock
// ============================================================================

/**
 * Create a mock BiometricAuth plugin
 * Defaults to available FaceID
 */
export const mockBiometricAuthPlugin = () => {
  return {
    checkBiometry: vi.fn().mockResolvedValue({
      isAvailable: true,
      biometryType: 2, // FaceID
      biometryTypes: [2],
      strongBiometryIsAvailable: true,
    }),
    authenticate: vi.fn().mockResolvedValue({
      verified: true,
    }),
  };
};

// ============================================================================
// Secure Storage Plugin Mock
// ============================================================================

/**
 * Create a mock SecureStorage plugin with in-memory storage
 * Includes helper to inspect storage contents in tests
 *
 * @example
 * ```ts
 * const storage = mockSecureStoragePlugin();
 * await storage.set('key', 'value');
 * expect(storage.getStorage().get('key')).toBe('value');
 * ```
 */
export const mockSecureStoragePlugin = () => {
  const storage = new Map<string, string>();

  return {
    get: vi.fn((key: string) => {
      const value = storage.get(key);
      return Promise.resolve(value ? { value } : { value: null });
    }),
    set: vi.fn((key: string, value: string) => {
      storage.set(key, value);
      return Promise.resolve();
    }),
    remove: vi.fn((key: string) => {
      storage.delete(key);
      return Promise.resolve();
    }),
    clear: vi.fn(() => {
      storage.clear();
      return Promise.resolve();
    }),
    keys: vi.fn(() => {
      return Promise.resolve({ keys: Array.from(storage.keys()) });
    }),
    // Test helper: Inspect storage
    getStorage: () => storage,
  };
};

// ============================================================================
// Other Plugin Mocks
// ============================================================================

/**
 * Mock StatusBar plugin
 */
export const mockStatusBarPlugin = () => {
  return {
    setStyle: vi.fn().mockResolvedValue(undefined),
    setBackgroundColor: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
  };
};

/**
 * Mock BarcodeScanner plugin
 */
export const mockBarcodeScannerPlugin = () => {
  return {
    scan: vi.fn().mockResolvedValue({
      hasContent: true,
      content: 'https://app.gossip.com/invite/abc123',
    }),
    isSupported: vi.fn().mockResolvedValue({ supported: true }),
    checkPermissions: vi.fn().mockResolvedValue({ camera: 'granted' }),
    requestPermissions: vi.fn().mockResolvedValue({ camera: 'granted' }),
  };
};

// ============================================================================
// Setup & Helpers
// ============================================================================

/**
 * Setup all Capacitor mocks at once
 * Convenience function for common test setup
 *
 * @param platform 'native' for iOS/Android, 'web' for browser (default)
 * @returns Object with all plugin mocks for test assertions
 *
 * @example
 * ```ts
 * beforeEach(() => {
 *   const mocks = setupCapacitorMocks('web');
 *   // Use mocks in tests
 * });
 * ```
 */
export const setupCapacitorMocks = (platform: 'native' | 'web' = 'web') => {
  if (platform === 'native') {
    mockCapacitorNative();
  } else {
    mockCapacitorWeb();
  }

  return {
    app: mockAppPlugin(),
    biometric: mockBiometricAuthPlugin(),
    storage: mockSecureStoragePlugin(),
    statusBar: mockStatusBarPlugin(),
    scanner: mockBarcodeScannerPlugin(),
  };
};

/**
 * Reset all Capacitor mocks
 * Call this in afterEach for cleanup
 */
export const resetCapacitorMocks = () => {
  vi.clearAllMocks();
};

/**
 * Test helper: Trigger a native deep link event
 *
 * @example
 * ```ts
 * const appPlugin = createMockAppPlugin();
 * triggerNativeDeepLink(appPlugin, 'https://app.gossip.com/invite/abc123');
 * // Assert your app handled the deep link
 * ```
 */
export const triggerNativeDeepLink = (
  appPlugin: ReturnType<typeof createMockAppPlugin>,
  url: string
) => {
  appPlugin.triggerEvent('appUrlOpen', { url });
};

/**
 * Test helper: Mock page visibility as hidden
 * Useful for testing app backgrounding behavior
 */
export const mockPageVisibilityHidden = () => {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => true,
  });

  document.dispatchEvent(new Event('visibilitychange'));
};

/**
 * Test helper: Mock page visibility as visible
 * Useful for testing app foregrounding behavior
 */
export const mockPageVisibilityVisible = () => {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => false,
  });

  document.dispatchEvent(new Event('visibilitychange'));
};
