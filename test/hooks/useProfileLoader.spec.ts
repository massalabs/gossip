import { afterEach, describe, expect, it } from 'vitest';
import {
  establishFirstInstallCreationGrant,
  shouldInitializeSecureStorage,
} from '../../src/hooks/useProfileLoader';
import { useAppStore } from '../../src/stores/appStore';

describe('secure-storage startup routing', () => {
  afterEach(() => {
    useAppStore.getState().setSecureAccountCreationAllowed(false);
    localStorage.removeItem('gossip:onboarding-storage-mode-v1');
  });

  it('persists the first-install grant as soon as empty storage is known', async () => {
    useAppStore.getState().setSecureAccountCreationAllowed(false);

    await establishFirstInstallCreationGrant({
      isSecureStorage: true,
      storageState: 'empty',
    });

    expect(useAppStore.getState().secureAccountCreationAllowed).toBe(true);
  });

  it('restores onboarding from authoritative empty generation state after local state loss', async () => {
    useAppStore.setState({
      isInitialized: true,
      secureAccountCreationAllowed: false,
    });

    await establishFirstInstallCreationGrant({
      isSecureStorage: true,
      storageState: 'locked',
      accountGenerationState: 'empty',
    } as Parameters<typeof establishFirstInstallCreationGrant>[0]);

    expect(useAppStore.getState()).toMatchObject({
      isInitialized: false,
      secureAccountCreationAllowed: true,
    });
  });

  it('clears an orphaned creation-mode lease after interrupted onboarding', async () => {
    localStorage.setItem(
      'gossip:onboarding-storage-mode-v1',
      JSON.stringify({ mode: 'create', owner: 'terminated-process' })
    );

    await establishFirstInstallCreationGrant({
      isSecureStorage: true,
      storageState: 'empty',
      accountGenerationState: 'empty',
    });

    expect(
      localStorage.getItem('gossip:onboarding-storage-mode-v1')
    ).toBeNull();
  });

  it('does not grant creation for locked storage', async () => {
    useAppStore.getState().setSecureAccountCreationAllowed(false);

    await establishFirstInstallCreationGrant({
      isSecureStorage: true,
      storageState: 'locked',
    });

    expect(useAppStore.getState().secureAccountCreationAllowed).toBe(false);
  });

  it('revokes a stale grant when the backend generation committed', async () => {
    useAppStore.setState({
      isInitialized: false,
      secureAccountCreationAllowed: true,
    });

    await establishFirstInstallCreationGrant({
      isSecureStorage: true,
      storageState: 'locked',
      accountGenerationState: 'committed',
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
