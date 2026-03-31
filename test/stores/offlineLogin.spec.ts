import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mock @capacitor/network before importing the store ---

// Captured listener so tests can simulate network changes
let networkChangeListener:
  | ((status: { connected: boolean; connectionType: string }) => void)
  | null = null;
let mockConnected = true;

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({
      connected: mockConnected,
      connectionType: mockConnected ? 'wifi' : 'none',
    })),
    addListener: vi.fn(
      (
        _event: string,
        cb: (status: { connected: boolean; connectionType: string }) => void
      ) => {
        networkChangeListener = cb;
        return { remove: vi.fn() };
      }
    ),
  },
}));

// We need to reset the module-level `listenersRegistered` guard between tests,
// so we use dynamic imports after resetting modules.

describe('useOnlineStore — offline login / connection detection', () => {
  beforeEach(() => {
    // Reset captured listener
    networkChangeListener = null;
    // Default to online
    mockConnected = true;
    // Reset modules so the module-level `listenersRegistered` flag is fresh
    vi.resetModules();
  });

  async function importStore() {
    const mod = await import('../../src/stores/useOnlineStore');
    return mod.useOnlineStoreBase;
  }

  it('defaults to online before initialization', async () => {
    const store = await importStore();
    expect(store.getState().isOnline).toBe(true);
  });

  it('reflects offline state after init when network is down', async () => {
    mockConnected = false;

    const store = await importStore();
    await store.getState().initOnlineStore();

    expect(store.getState().isOnline).toBe(false);
  });

  it('reflects online state after init when network is up', async () => {
    mockConnected = true;

    const store = await importStore();
    await store.getState().initOnlineStore();

    expect(store.getState().isOnline).toBe(true);
  });

  it('updates state when Capacitor fires a networkStatusChange event', async () => {
    mockConnected = true;

    const store = await importStore();
    await store.getState().initOnlineStore();

    expect(store.getState().isOnline).toBe(true);
    expect(networkChangeListener).not.toBeNull();

    // Simulate going offline
    networkChangeListener!({ connected: false, connectionType: 'none' });
    expect(store.getState().isOnline).toBe(false);

    // Simulate coming back online
    networkChangeListener!({ connected: true, connectionType: 'wifi' });
    expect(store.getState().isOnline).toBe(true);
  });

  it('transitions from offline to online correctly', async () => {
    // Start offline
    mockConnected = false;

    const store = await importStore();
    await store.getState().initOnlineStore();

    expect(store.getState().isOnline).toBe(false);

    // Simulate reconnection via Capacitor listener
    networkChangeListener!({ connected: true, connectionType: 'wifi' });
    expect(store.getState().isOnline).toBe(true);
  });

  it('registers listeners only once even if initOnlineStore is called twice', async () => {
    const store = await importStore();
    const { Network } = await import('@capacitor/network');

    // Clear any prior calls from other tests (the mock is shared)
    vi.mocked(Network.addListener).mockClear();
    vi.mocked(Network.getStatus).mockClear();

    await store.getState().initOnlineStore();
    await store.getState().initOnlineStore();

    // addListener should only have been called once for this module instance
    // because the listenersRegistered guard prevents duplicate registration
    expect(Network.addListener).toHaveBeenCalledTimes(1);
    expect(Network.getStatus).toHaveBeenCalledTimes(1);
  });

  it('setOnline manually overrides the connection state', async () => {
    const store = await importStore();

    store.getState().setOnline(false);
    expect(store.getState().isOnline).toBe(false);

    store.getState().setOnline(true);
    expect(store.getState().isOnline).toBe(true);
  });

  it('falls back to navigator.onLine when Network.getStatus throws', async () => {
    const store = await importStore();
    const { Network } = await import('@capacitor/network');

    // Make getStatus throw
    vi.mocked(Network.getStatus).mockRejectedValueOnce(
      new Error('plugin unavailable')
    );

    // Set navigator.onLine to false to verify fallback
    Object.defineProperty(window.navigator, 'onLine', {
      value: false,
      writable: true,
      configurable: true,
    });

    await store.getState().initOnlineStore();
    expect(store.getState().isOnline).toBe(false);

    // Restore
    Object.defineProperty(window.navigator, 'onLine', {
      value: true,
      writable: true,
      configurable: true,
    });
  });
});
