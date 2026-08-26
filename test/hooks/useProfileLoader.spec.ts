import { afterEach, describe, expect, it } from 'vitest';
import {
  establishFirstInstallCreationGrant,
  shouldInitializeSecureStorage,
} from '../../src/hooks/useProfileLoader';
import { useAppStore } from '../../src/stores/appStore';

describe('secure-storage startup routing', () => {
  afterEach(() => {
    useAppStore.getState().setSecureAccountCreationAllowed(false);
  });

  it('persists the first-install grant as soon as empty storage is known', async () => {
    useAppStore.getState().setSecureAccountCreationAllowed(false);

    await establishFirstInstallCreationGrant({
      isSecureStorage: true,
      storageState: 'empty',
    });

    expect(useAppStore.getState().secureAccountCreationAllowed).toBe(true);
  });

  it('does not grant creation for locked storage', async () => {
    useAppStore.getState().setSecureAccountCreationAllowed(false);

    await establishFirstInstallCreationGrant({
      isSecureStorage: true,
      storageState: 'locked',
    });

    expect(useAppStore.getState().secureAccountCreationAllowed).toBe(false);
  });

  it('revokes a stale grant when the backend proves import committed', async () => {
    useAppStore.getState().setSecureAccountCreationAllowed(true);
    await establishFirstInstallCreationGrant({
      isSecureStorage: true,
      storageState: 'locked',
      wasPortableImportInstalled: async () => true,
    });
    expect(useAppStore.getState().secureAccountCreationAllowed).toBe(false);
  });

  it('keeps a dummy-only rolled-back store in onboarding after relaunch', () => {
    expect(shouldInitializeSecureStorage('locked', true)).toBe(false);
  });

  it('routes a completed account store to login after relaunch', () => {
    expect(shouldInitializeSecureStorage('locked', false)).toBe(true);
  });

  it('never treats empty or unlocked startup state as logged out', () => {
    expect(shouldInitializeSecureStorage('empty', false)).toBe(false);
    expect(shouldInitializeSecureStorage('unlocked', false)).toBe(false);
    expect(shouldInitializeSecureStorage(null, false)).toBe(false);
  });
});
