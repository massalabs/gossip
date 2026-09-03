import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { useProfileLoader } from '../../src/hooks/useProfileLoader';
import { useAppStore } from '../../src/stores/appStore';
import { STORAGE_KEYS } from '../../src/utils/localStorage';

const sdkState = vi.hoisted(() => ({
  storageState: 'empty' as 'empty' | 'locked' | 'unlocked',
}));

vi.mock('../../src/stores/sdkStore', () => ({
  getSdk: () => ({
    isSecureStorage: true,
    storageState: sdkState.storageState,
  }),
}));

const persistedAppStore = useAppStore as typeof useAppStore & {
  persist: { rehydrate: () => Promise<void> };
};

function ProfileLoaderHarness() {
  useProfileLoader();
  return null;
}

async function simulateAppStoreRelaunch(persistedValue: string): Promise<void> {
  useAppStore.setState({
    isInitialized: false,
    secureAccountCreationAllowed: false,
  });
  localStorage.setItem(STORAGE_KEYS.APP_STORE, persistedValue);
  await persistedAppStore.persist.rehydrate();
}

describe('secure-storage startup grant integration', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      isInitialized: false,
      secureAccountCreationAllowed: false,
    });
    sdkState.storageState = 'empty';
  });

  it('creates and rehydrates a first-install grant only from empty storage', async () => {
    await render(<ProfileLoaderHarness />);

    await vi.waitFor(() => {
      expect(useAppStore.getState().secureAccountCreationAllowed).toBe(true);
      expect(useAppStore.getState().isInitialized).toBe(false);
    });
    const persistedValue = localStorage.getItem(STORAGE_KEYS.APP_STORE);
    expect(persistedValue).not.toBeNull();

    await simulateAppStoreRelaunch(persistedValue!);
    expect(useAppStore.getState().secureAccountCreationAllowed).toBe(true);
  });

  it('keeps a persisted rollback grant in onboarding for locked dummy storage', async () => {
    useAppStore.getState().setSecureAccountCreationAllowed(true);
    const persistedValue = localStorage.getItem(STORAGE_KEYS.APP_STORE);
    if (!persistedValue) throw new Error('persisted grant missing');
    await simulateAppStoreRelaunch(persistedValue);
    sdkState.storageState = 'locked';

    await render(<ProfileLoaderHarness />);

    await vi.waitFor(() => {
      expect(useAppStore.getState().secureAccountCreationAllowed).toBe(true);
      expect(useAppStore.getState().isInitialized).toBe(false);
    });
  });

  it('routes an unknown locked store without a grant to login', async () => {
    sdkState.storageState = 'locked';

    await render(<ProfileLoaderHarness />);

    await vi.waitFor(() => {
      expect(useAppStore.getState().secureAccountCreationAllowed).toBe(false);
      expect(useAppStore.getState().isInitialized).toBe(true);
    });
    const persistedValue = localStorage.getItem(STORAGE_KEYS.APP_STORE);
    expect(persistedValue).not.toBeNull();
    await simulateAppStoreRelaunch(persistedValue!);
    expect(useAppStore.getState().secureAccountCreationAllowed).toBe(false);
  });
});
