/* eslint-disable react-refresh/only-export-components -- test-only iframe harness exports its runner */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { GossipSdk, generateMnemonic } from '@massalabs/gossip-sdk';
import { AppContent } from '../../src/App';
import i18n from '../../src/i18n';
import SecureAccountSetup from '../../src/components/account/SecureAccountSetup';
import { stageAccount } from '../../src/components/account/stagedAccount';
import { useProfileLoader } from '../../src/hooks/useProfileLoader';
import { useAccountStore } from '../../src/stores/accountStore';
import { useAppStore } from '../../src/stores/appStore';
import { useSdkStore } from '../../src/stores/sdkStore';
import { claimOnboardingStorageMode } from '../../src/services/portableImportAuthorization';
import { STORAGE_KEYS } from '../../src/utils/localStorage';
import {
  preparePasswordAccount,
  wipePreparedPasswordAccount,
} from '../../src/stores/utils/auth';

export interface PrepareAbortedCandidateInput {
  domain: string;
  secureStorageWasmUrl: string;
  passwords: [string, string];
}

export interface PrepareAbortedCandidateResult {
  persistedAppStore: string;
  candidateAborted: boolean;
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
  grantRevoked: boolean;
  persistedRevokedAppStore: string;
}

export interface RevokedGrantRelaunchInput {
  domain: string;
  secureStorageWasmUrl: string;
  persistedAppStore: string;
  replacementPassword: string;
}

export interface RevokedGrantRelaunchResult {
  grantStayedRevoked: boolean;
  routedToLogin: boolean;
  replacementPasswordStillUnlocks: boolean;
}

export interface PrepareLostCommitResponseInput {
  domain: string;
  secureStorageWasmUrl: string;
  passwords: [string, string];
}

export interface PrepareLostCommitResponseResult {
  persistedAppStore: string;
  commitResponseLost: boolean;
}

export interface VerifyLostCommitResponseInput extends PrepareLostCommitResponseInput {
  persistedAppStore: string;
}

export interface VerifyLostCommitResponseResult {
  routedToLogin: boolean;
  grantRevoked: boolean;
  bothAccountsUsable: boolean;
  sourceSpecificMarkersRemoved: boolean;
}

function StartupLoader(): null {
  useProfileLoader();
  return null;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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

async function mountProductionAppUntilLogin(): Promise<() => void> {
  const mount = document.createElement('div');
  document.body.append(mount);
  const root = createRoot(mount);
  useAccountStore.getState().setLoading(true);
  root.render(
    <MemoryRouter initialEntries={['/']}>
      <AppContent />
    </MemoryRouter>
  );
  try {
    await waitFor(() => {
      const loginLabel = i18n.t('login.login', { ns: 'auth' });
      const usernamePlaceholder = i18n.t('create.enter_username', {
        ns: 'auth',
      });
      const loginAction = Array.from(mount.querySelectorAll('button')).some(
        button => button.textContent?.trim() === loginLabel
      );
      const onboardingUsername = Array.from(
        mount.querySelectorAll('input')
      ).some(input => input.placeholder === usernamePlaceholder);
      return loginAction && !onboardingUsername;
    }, 30_000);
    return () => {
      root.unmount();
      mount.remove();
    };
  } catch (error) {
    root.unmount();
    mount.remove();
    throw error;
  }
}

/** Prepare and abort a two-account in-memory candidate in the first page context. */
export async function prepareAbortedCandidate(
  input: PrepareAbortedCandidateInput
): Promise<PrepareAbortedCandidateResult> {
  localStorage.clear();
  useAppStore.setState({
    isInitialized: false,
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

  try {
    await sdk.secureStorageBeginOnboardingCandidate();
    await sdk.secureStorageCreate(0, input.passwords[0]);
    await sdk.secureStorageLock();
    await sdk.secureStorageCreate(1, input.passwords[1]);
    await sdk.secureStorageLock();
    await sdk.secureStorageAbortOnboardingCandidate();
    const persistedAppStore = localStorage.getItem(STORAGE_KEYS.APP_STORE);
    if (!persistedAppStore) throw new Error('persisted creation grant missing');
    return {
      persistedAppStore,
      candidateAborted: sdk.accountGenerationState === 'empty',
      passwordsRejected: true,
    };
  } finally {
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
    try {
      if (await sdk.secureStorageUnlock(password)) {
        rejectedPasswordsStayedRejected = false;
        await sdk.secureStorageLock();
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('no session to unlock')
      ) {
        throw error;
      }
    }
  }

  const stagedReplacement = stageAccount(
    'replacement',
    input.replacementPassword
  );
  const mount = document.createElement('div');
  document.body.append(mount);
  const root = createRoot(mount);
  let completed = false;
  let restartError: string | null = null;
  const creationModeLease = await claimOnboardingStorageMode('create');
  root.render(
    <SecureAccountSetup
      initialAccount={stagedReplacement}
      onComplete={() => {
        completed = true;
      }}
      onRestart={message => {
        restartError = message;
      }}
      creationModeLease={creationModeLease}
    />
  );

  try {
    await waitFor(() => mount.querySelectorAll('button').length >= 2);
    const buttons = mount.querySelectorAll('button');
    buttons[buttons.length - 1].click();
    await waitFor(() => {
      if (restartError) throw new Error(restartError);
      return completed;
    }, 60_000);

    const grantRevoked = !useAppStore.getState().secureAccountCreationAllowed;
    const persistedRevokedAppStore = localStorage.getItem(
      STORAGE_KEYS.APP_STORE
    );
    if (!persistedRevokedAppStore) {
      throw new Error('persisted revoked grant missing');
    }

    await useAccountStore.getState().loadAccount({
      type: 'password',
      password: input.replacementPassword,
    });
    const replacementUserId = sdk.userId;
    const replacementUsername =
      useAccountStore.getState().userProfile?.username;
    await useAccountStore.getState().logout({ lockedByUser: false });
    await useAccountStore.getState().loadAccount({
      type: 'password',
      password: input.replacementPassword,
    });

    return {
      routedToOnboarding,
      grantRehydrated,
      rejectedPasswordsStayedRejected,
      replacementUsername,
      replacementReopened:
        useAccountStore.getState().userProfile?.username === 'replacement',
      stableUserId: sdk.userId === replacementUserId,
      grantRevoked,
      persistedRevokedAppStore,
    };
  } finally {
    root.unmount();
    mount.remove();
    await creationModeLease.release();
    if (sdk.isSessionOpen) {
      await useAccountStore.getState().logout({ lockedByUser: false });
    }
    await sdk.destroy();
  }
}

/** Commit both accounts, then emulate losing the successful RPC response. */
export async function prepareLostCommitResponse(
  input: PrepareLostCommitResponseInput
): Promise<PrepareLostCommitResponseResult> {
  localStorage.clear();
  useAppStore.setState({
    isInitialized: false,
    secureAccountCreationAllowed: true,
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
  const prepared = await Promise.all(
    input.passwords.map(password =>
      preparePasswordAccount(generateMnemonic(256), password)
    )
  );
  const commit = sdk.secureStorageCommitOnboardingCandidate.bind(sdk);
  sdk.secureStorageCommitOnboardingCandidate = async () => {
    await commit();
    throw new Error('simulated lost commit response');
  };

  let commitResponseLost = false;
  try {
    await useAccountStore.getState().initializePreparedAccountsAtomically([
      {
        username: 'first-committed',
        password: input.passwords[0],
        prepared: prepared[0],
      },
      {
        username: 'second-committed',
        password: input.passwords[1],
        prepared: prepared[1],
      },
    ]);
  } catch (error) {
    commitResponseLost =
      error instanceof Error &&
      error.message === 'simulated lost commit response';
  } finally {
    for (const account of prepared) wipePreparedPasswordAccount(account);
    await sdk.destroy();
  }
  const persistedAppStore = localStorage.getItem(STORAGE_KEYS.APP_STORE);
  if (!persistedAppStore) throw new Error('persisted app state missing');
  return { persistedAppStore, commitResponseLost };
}

/** Relaunch from stale local authority and prove the backend generation wins. */
export async function verifyLostCommitResponseAfterRelaunch(
  input: VerifyLostCommitResponseInput
): Promise<VerifyLostCommitResponseResult> {
  const persistedStore = useAppStore as typeof useAppStore & {
    persist: { rehydrate: () => Promise<void> };
  };
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
  const unmount = await mountProductionAppUntilLogin();
  try {
    const usernames: string[] = [];
    for (const password of input.passwords) {
      await useAccountStore.getState().loadAccount({
        type: 'password',
        password,
      });
      usernames.push(useAccountStore.getState().userProfile?.username ?? '');
      await useAccountStore.getState().logout({ lockedByUser: false });
    }
    return {
      routedToLogin: useAppStore.getState().isInitialized,
      grantRevoked: !useAppStore.getState().secureAccountCreationAllowed,
      bothAccountsUsable:
        usernames[0] === 'first-committed' &&
        usernames[1] === 'second-committed',
      sourceSpecificMarkersRemoved: [
        'gossip:portable-import-authority-consumed-v1',
        'gossip:onboarding-creation-committed-v1',
        'gossip:onboarding-storage-mode-v1',
        'gossip:portable-import-private-migration-epoch-v1',
      ].every(key => localStorage.getItem(key) === null),
    };
  } finally {
    unmount();
    if (sdk.isSessionOpen) {
      await useAccountStore.getState().logout({ lockedByUser: false });
    }
    await sdk.destroy();
  }
}

/** Verify revoked authorization from a third, independently loaded page. */
export async function verifyRevokedGrantAfterRelaunch(
  input: RevokedGrantRelaunchInput
): Promise<RevokedGrantRelaunchResult> {
  const persistedStore = useAppStore as typeof useAppStore & {
    persist: { rehydrate: () => Promise<void>; hasHydrated: () => boolean };
  };
  useAppStore.setState({
    isInitialized: false,
    secureAccountCreationAllowed: true,
  });
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
  let unmountApp = () => {};
  try {
    unmountApp = await mountProductionAppUntilLogin();
    const grantStayedRevoked =
      persistedStore.persist.hasHydrated() &&
      !useAppStore.getState().secureAccountCreationAllowed;
    const routedToLogin =
      grantStayedRevoked && useAppStore.getState().isInitialized;
    const replacementPasswordStillUnlocks = await sdk.secureStorageUnlock(
      input.replacementPassword
    );
    if (replacementPasswordStillUnlocks) await sdk.secureStorageLock();
    return {
      grantStayedRevoked,
      routedToLogin,
      replacementPasswordStillUnlocks,
    };
  } finally {
    unmountApp();
    await sdk.destroy();
  }
}
