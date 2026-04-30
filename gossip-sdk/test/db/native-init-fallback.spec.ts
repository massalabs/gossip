import { afterEach, describe, expect, it, vi } from 'vitest';

describe('DatabaseConnection native secure-storage init', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unmock('@capacitor/core');
    vi.unmock('../../src/db/secure-storage-native.js');
  });

  it('surfaces native storage init errors instead of falling back to the worker', async () => {
    vi.resetModules();
    vi.doMock('@capacitor/core', () => ({
      Capacitor: {
        isNativePlatform: () => true,
      },
    }));
    vi.doMock('../../src/db/secure-storage-native.js', () => ({
      SecureStorageNative: {
        initSecureStorage: vi.fn(async () => {
          throw new Error('native secure storage open failed');
        }),
        provisionStorage: vi.fn(),
        hasData: vi.fn(),
      },
    }));

    const { DatabaseConnection } = await import('../../src/db/sqlite');

    // Fallback is only allowed when the native plugin module is unavailable.
    // Once the plugin loaded, native storage operation failures must propagate
    // instead of being hidden by an attempted worker fallback.
    await expect(
      DatabaseConnection.create({
        storage: { type: 'secureStorage', domain: 'native-init-test' },
      })
    ).rejects.toThrow('native secure storage open failed');
  });
});
