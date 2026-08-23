/* eslint-disable react-refresh/only-export-components -- test-only iframe harness exports its runner */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { generateMnemonic, GossipSdk } from '@massalabs/gossip-sdk';
import { useProfileLoader } from '../../src/hooks/useProfileLoader';
import { useAccountStore } from '../../src/stores/accountStore';
import { useAppStore } from '../../src/stores/appStore';
import { useSdkStore } from '../../src/stores/sdkStore';
import {
  preparePasswordAccount,
  wipePreparedPasswordAccount,
} from '../../src/stores/utils/auth';
import { STORAGE_KEYS } from '../../src/utils/localStorage';

export interface PrepareRollbackInput {
  domain: string;
  secureStorageWasmUrl: string;
  passwords: [string, string];
}

export interface PrepareRollbackResult {
  persistedAppStore: string;
  rollbackComplete: boolean;
  passwordsRejected: boolean;
}

export interface FreshRelaunchInput {
  domain: string;
  secureStorageWasmUrl: string;
  persistedAppStore: string;
  rejectedPasswords: string[];
  replacementPassword: string;
}

export interface FreshRelaunchResult {
  routedToOnboarding: boolean;
  grantRehydrated: boolean;
  rejectedPasswordsStayedRejected: boolean;
  replacementUsername: string | undefined;
  replacementReopened: boolean;
  stableUserId: boolean;
}

function StartupLoader(): null {
  useProfileLoader();
  return null;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('fresh startup loader did not settle');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function mountStartupLoader(): Promise<void> {
  const mount = document.createElement('div');
  document.body.append(mount);
  const root = createRoot(mount);
  // Force the opposite value first so completion proves the effect ran rather
  // than observing the store's default before React schedules it.
  useAccountStore.getState().setLoading(true);
  root.render(<StartupLoader />);
  await waitFor(() => !useAccountStore.getState().isLoading);
  root.unmount();
  mount.remove();
}

/** Prepare and completely roll back two accounts in the first page context. */
export async function prepareRolledBackAccounts(
  input: PrepareRollbackInput
): Promise<PrepareRollbackResult> {
  localStorage.clear();
  useAppStore.setState({
    isInitialized: true,
    secureAccountCreationAllowed: false,
  });
  const sdk = new GossipSdk();
  await sdk.init({
    protocolBaseUrl: 'http://127.0.0.1:1',
    storage: {
      type: 'secureStorage',
      domain: input.domain,
      secureStorageWasmUrl: input.secureStorageWasmUrl,
    },
  });
  useSdkStore.getState().setSdk(sdk);
  await mountStartupLoader();

  const prepared = await Promise.all([
    preparePasswordAccount(await generateMnemonic(), input.passwords[0]),
    preparePasswordAccount(await generateMnemonic(), input.passwords[1]),
  ]);
  try {
    await useAccountStore
      .getState()
      .initializePreparedAccount('alice', input.passwords[0], prepared[0]);
    await useAccountStore
      .getState()
      .initializePreparedAccount('decoy', input.passwords[1], prepared[1]);
    const rollback = await useAccountStore
      .getState()
      .rollbackInitializedAccounts(input.passwords);
    let passwordsRejected = true;
    for (const password of input.passwords) {
      if (await sdk.secureStorageUnlock(password)) {
        passwordsRejected = false;
        await sdk.secureStorageLock();
      }
    }
    const persistedAppStore = localStorage.getItem(STORAGE_KEYS.APP_STORE);
    if (!persistedAppStore) throw new Error('persisted rollback grant missing');
    return {
      persistedAppStore,
      rollbackComplete:
        rollback.failedPasswordIndexes.length === 0 && !rollback.lockFailed,
      passwordsRejected,
    };
  } finally {
    for (const account of prepared) wipePreparedPasswordAccount(account);
    if (sdk.isSessionOpen) {
      await useAccountStore.getState().logout({ lockedByUser: false });
    }
    await sdk.destroy();
  }
}

/**
 * Runs inside a same-origin iframe. That browsing context has a genuinely fresh
 * ESM graph and fresh Zustand/account-store module state while sharing the
 * parent's localStorage and IndexedDB, exactly like an application reload.
 */
export async function runFreshAccountRelaunchScenario(
  input: FreshRelaunchInput
): Promise<FreshRelaunchResult> {
  const persistedStore = useAppStore as typeof useAppStore & {
    persist: { rehydrate: () => Promise<void>; hasHydrated: () => boolean };
  };
  useAppStore.setState({
    isInitialized: true,
    secureAccountCreationAllowed: false,
  });
  // Setting the opposite state writes through Zustand persistence, so restore
  // the captured browser value only afterwards and then perform real hydration.
  localStorage.setItem(STORAGE_KEYS.APP_STORE, input.persistedAppStore);
  await persistedStore.persist.rehydrate();

  const sdk = new GossipSdk();
  await sdk.init({
    protocolBaseUrl: 'http://127.0.0.1:1',
    storage: {
      type: 'secureStorage',
      domain: input.domain,
      secureStorageWasmUrl: input.secureStorageWasmUrl,
    },
  });
  useSdkStore.getState().setSdk(sdk);

  await mountStartupLoader();

  const grantRehydrated =
    persistedStore.persist.hasHydrated() &&
    useAppStore.getState().secureAccountCreationAllowed;
  const routedToOnboarding =
    grantRehydrated && !useAppStore.getState().isInitialized;
  let rejectedPasswordsStayedRejected = true;
  for (const password of input.rejectedPasswords) {
    if (await sdk.secureStorageUnlock(password)) {
      rejectedPasswordsStayedRejected = false;
      await sdk.secureStorageLock();
    }
  }

  const replacement = await preparePasswordAccount(
    await generateMnemonic(),
    input.replacementPassword
  );
  try {
    await useAccountStore
      .getState()
      .initializePreparedAccount(
        'replacement',
        input.replacementPassword,
        replacement
      );
    const replacementUserId = sdk.userId;
    await useAccountStore.getState().logout({ lockedByUser: false });
    await useAccountStore.getState().loadAccount({
      type: 'password',
      password: input.replacementPassword,
    });

    return {
      routedToOnboarding,
      grantRehydrated,
      rejectedPasswordsStayedRejected,
      replacementUsername: useAccountStore.getState().userProfile?.username,
      replacementReopened:
        useAccountStore.getState().userProfile?.username === 'replacement',
      stableUserId: sdk.userId === replacementUserId,
    };
  } finally {
    if (sdk.isSessionOpen) {
      await useAccountStore.getState().logout({ lockedByUser: false });
    }
    wipePreparedPasswordAccount(replacement);
    await sdk.destroy();
  }
}
