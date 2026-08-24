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

  it('persists the first-install grant as soon as empty storage is known', () => {
    useAppStore.getState().setSecureAccountCreationAllowed(false);

    establishFirstInstallCreationGrant({
      isSecureStorage: true,
      storageState: 'empty',
    });

    expect(useAppStore.getState().secureAccountCreationAllowed).toBe(true);
  });

  it('does not grant creation for locked storage', () => {
    useAppStore.getState().setSecureAccountCreationAllowed(false);

    establishFirstInstallCreationGrant({
      isSecureStorage: true,
      storageState: 'locked',
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
