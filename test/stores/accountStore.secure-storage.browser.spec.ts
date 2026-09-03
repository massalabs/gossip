import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeUserId,
  generateMnemonic,
  generateUserKeys,
  GossipSdk,
  type UserProfile,
} from '@massalabs/gossip-sdk';
import { SECURE_STORAGE_IDB_NAME } from '@massalabs/gossip-sdk/db/secure-storage-namespaces';
import secureStorageWasmUrlRaw from '@massalabs/gossip-sdk/assets/generated/wasm-secureStorage/secureStorage_bg.wasm?url';

const mocks = vi.hoisted(() => ({
  sdk: null as GossipSdk | null,
  deriveAccount: vi.fn(),
}));

vi.mock('../../src/stores/sdkStore', () => ({
  getSdk: () => {
    if (!mocks.sdk) throw new Error('SDK not initialized');
    return mocks.sdk;
  },
}));

vi.mock('../../src/stores/utils/accountHelpers', () => ({
  deriveAccountFromMnemonic: mocks.deriveAccount,
  fetchMnsDomainsIfEnabled: vi.fn(),
  wipeAccountPrivateKey: vi.fn(),
}));

vi.mock('../../src/stores/discussionStore', () => ({
  useDiscussionStore: { getState: () => ({ cleanup: vi.fn() }) },
}));

vi.mock('../../src/stores/messageStore', () => ({
  useMessageStore: { getState: () => ({ cleanup: vi.fn() }) },
}));

vi.mock('../../src/stores/selfMessageStore', () => ({
  useSelfMessageStore: {
    getState: () => ({ clearMessages: vi.fn() }),
  },
}));

import { useAccountStore } from '../../src/stores/accountStore';
import { useAppStore } from '../../src/stores/appStore';
import { shouldInitializeSecureStorage } from '../../src/hooks/useProfileLoader';
import { STORAGE_KEYS } from '../../src/utils/localStorage';
import {
  preparePasswordAccount,
  wipePreparedPasswordAccount,
} from '../../src/stores/utils/auth';

const secureStorageWasmUrl = new URL(
  secureStorageWasmUrlRaw,
  window.location.href
).href;

const persistedAppStore = useAppStore as typeof useAppStore & {
  persist: { rehydrate: () => Promise<void> };
};

async function rehydrateCreationGrant(
  persistedValue: string,
  expected: boolean
): Promise<void> {
  useAppStore.setState({ secureAccountCreationAllowed: !expected });
  localStorage.setItem(STORAGE_KEYS.APP_STORE, persistedValue);
  await persistedAppStore.persist.rehydrate();
  expect(useAppStore.getState().secureAccountCreationAllowed).toBe(expected);
}

async function destroySdkWorker(sdk: GossipSdk): Promise<void> {
  await sdk.destroy();
  // Let the browser observe Worker.terminate()/IDB connection release before a
  // fresh SDK worker opens the same database.
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function reopenSecureStorage(domain: string): Promise<GossipSdk> {
  const reopened = new GossipSdk();
  await reopened.init({
    protocolBaseUrl: 'http://127.0.0.1:1',
    storage: {
      type: 'secureStorage',
      domain,
      secureStorageWasmUrl,
    },
  });
  return reopened;
}

async function clearSecureStorageIdb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SECURE_STORAGE_IDB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(
        new Error('IDB deletion blocked by an open secure-storage handle')
      );
  });
}

async function userIdFromMnemonic(mnemonic: string): Promise<string> {
  const keys = await generateUserKeys(mnemonic);
  const publicKeys = keys.public_keys();
  try {
    return encodeUserId(publicKeys.derive_id());
  } finally {
    publicKeys.free();
    keys.free();
  }
}

async function provisionProfile(
  sdk: GossipSdk,
  slot: number,
  username: string,
  password: string
): Promise<void> {
  const mnemonic = await generateMnemonic();
  const userId = await userIdFromMnemonic(mnemonic);
  const prepared = await preparePasswordAccount(mnemonic, password);
  const now = new Date();
  const profile: UserProfile = {
    userId,
    username,
    security: prepared.security,
    session: prepared.encryptedSession.slice(),
    status: 'online',
    lastSeen: now,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await sdk.secureStorageCreate(slot, password);
    await sdk.profiles.save(profile);
    await sdk.flush();
    await sdk.secureStorageLock();
  } finally {
    wipePreparedPasswordAccount(prepared);
  }
}

describe('secure biometric account-store login integration', () => {
  beforeEach(async () => {
    mocks.sdk = null;
    mocks.deriveAccount.mockImplementation(async (mnemonic: string) => {
      const keys = await generateUserKeys(mnemonic);
      const publicKeys = keys.public_keys();
      try {
        return {
          account: null,
          userIdBytes: publicKeys.derive_id(),
          evmAddress: '0x0000000000000000000000000000000000000000',
          massaAddress: 'AU1test',
        };
      } finally {
        publicKeys.free();
        keys.free();
      }
    });
    useAppStore.getState().setSecureAccountCreationAllowed(true);
    await clearSecureStorageIdb();
  }, 60_000);

  afterEach(async () => {
    const sdk = mocks.sdk;
    if (sdk) await destroySdkWorker(sdk);
    mocks.sdk = null;
    useAppStore.getState().setSecureAccountCreationAllowed(false);
    await clearSecureStorageIdb();
  }, 60_000);

  it('preserves a completed account and revoked grant across real relaunch', async () => {
    const domain = 'account-store-prepared-integration';
    const sdk = new GossipSdk();
    mocks.sdk = sdk;
    await sdk.init({
      protocolBaseUrl: 'http://127.0.0.1:1',
      storage: {
        type: 'secureStorage',
        domain,
        secureStorageWasmUrl,
      },
    });

    const mnemonic = await generateMnemonic();
    const prepared = await preparePasswordAccount(
      mnemonic,
      'prepared-password'
    );
    await useAccountStore.getState().initializePreparedAccountsAtomically([
      {
        username: 'prepared-alice',
        password: 'prepared-password',
        prepared,
      },
    ]);

    wipePreparedPasswordAccount(prepared);
    await useAccountStore.getState().loadAccount({
      type: 'password',
      password: 'prepared-password',
    });

    expect(useAccountStore.getState().userProfile?.username).toBe(
      'prepared-alice'
    );
    const stableUserId = sdk.userId;
    await useAccountStore.getState().logout({ lockedByUser: false });
    await useAccountStore.getState().loadAccount({
      type: 'password',
      password: 'prepared-password',
    });
    expect(sdk.userId).toBe(stableUserId);

    await useAccountStore.getState().logout({ lockedByUser: false });
    useAppStore.getState().setSecureAccountCreationAllowed(false);
    const persistedValue = localStorage.getItem(STORAGE_KEYS.APP_STORE);
    if (!persistedValue) throw new Error('persisted revoked grant missing');
    await destroySdkWorker(sdk);
    const reopened = await reopenSecureStorage(domain);
    mocks.sdk = reopened;
    await rehydrateCreationGrant(persistedValue, false);

    expect(reopened.storageState).toBe('locked');
    expect(
      shouldInitializeSecureStorage(
        reopened.storageState,
        useAppStore.getState().secureAccountCreationAllowed
      )
    ).toBe(true);
    await expect(
      useAccountStore
        .getState()
        .initializeAccount('unauthorized', 'unauthorized-password')
    ).rejects.toThrow('Secure account creation is not currently authorized');
    expect(await reopened.secureStorageUnlock('prepared-password')).toBe(true);
  }, 180_000);

  it('discards a failed account batch and permits a clean retry after relaunch', async () => {
    const domain = 'account-store-rollback-integration';
    const sdk = new GossipSdk();
    mocks.sdk = sdk;
    await sdk.init({
      protocolBaseUrl: 'http://127.0.0.1:1',
      storage: {
        type: 'secureStorage',
        domain,
        secureStorageWasmUrl,
      },
    });

    const alice = await preparePasswordAccount(
      await generateMnemonic(),
      'shared-password'
    );
    const decoy = await preparePasswordAccount(
      await generateMnemonic(),
      'shared-password'
    );
    await expect(
      useAccountStore.getState().initializePreparedAccountsAtomically([
        { username: 'alice', password: 'shared-password', prepared: alice },
        { username: 'decoy', password: 'shared-password', prepared: decoy },
      ])
    ).rejects.toThrow('Password already in use by another account');
    wipePreparedPasswordAccount(alice);
    wipePreparedPasswordAccount(decoy);

    expect(sdk.accountGenerationState).toBe('empty');
    expect(sdk.storageState).toBe('empty');

    const persistedValue = localStorage.getItem(STORAGE_KEYS.APP_STORE);
    if (!persistedValue) throw new Error('persisted creation grant missing');
    await destroySdkWorker(sdk);
    const reopened = await reopenSecureStorage(domain);
    mocks.sdk = reopened;
    await rehydrateCreationGrant(persistedValue, true);

    expect(reopened.accountGenerationState).toBe('empty');
    expect(reopened.storageState).toBe('empty');
    expect(
      shouldInitializeSecureStorage(
        reopened.storageState,
        useAppStore.getState().secureAccountCreationAllowed
      )
    ).toBe(false);

    const replacement = await preparePasswordAccount(
      await generateMnemonic(),
      'replacement-password'
    );
    try {
      await useAccountStore.getState().initializePreparedAccountsAtomically([
        {
          username: 'replacement',
          password: 'replacement-password',
          prepared: replacement,
        },
      ]);
      expect(reopened.accountGenerationState).toBe('committed');
      await useAccountStore.getState().loadAccount({
        type: 'password',
        password: 'replacement-password',
      });
      expect(useAccountStore.getState().userProfile?.username).toBe(
        'replacement'
      );
    } finally {
      if (reopened.isSessionOpen) {
        await useAccountStore.getState().logout({ lockedByUser: false });
      }
      wipePreparedPasswordAccount(replacement);
    }
  }, 180_000);

  it('discovers the matching locked slot by password and re-locks an empty slot', async () => {
    const sdk = new GossipSdk();
    mocks.sdk = sdk;
    await sdk.init({
      protocolBaseUrl: 'http://127.0.0.1:1',
      storage: {
        type: 'secureStorage',
        domain: 'account-store-biometric-integration',
        secureStorageWasmUrl,
      },
    });

    await sdk.secureStorageBeginOnboardingCandidate();
    await provisionProfile(sdk, 0, 'alice', 'alice-password');
    await provisionProfile(sdk, 1, 'decoy', 'decoy-password');
    await sdk.secureStorageCreate(2, 'empty-slot-password');
    await sdk.flush();
    await sdk.secureStorageLock();
    await sdk.secureStorageCommitOnboardingCandidate();

    expect(sdk.storageState).toBe('locked');
    await useAccountStore.getState().loadAccount({
      type: 'password',
      password: 'decoy-password',
    });

    expect(useAccountStore.getState().userProfile?.username).toBe('decoy');
    expect(sdk.isSessionOpen).toBe(true);
    expect(sdk.storageState).toBe('unlocked');

    await useAccountStore.getState().logout({ lockedByUser: false });
    expect(sdk.storageState).toBe('locked');

    await expect(
      useAccountStore.getState().loadAccount({
        type: 'password',
        password: 'empty-slot-password',
      })
    ).rejects.toThrow('No user profile found for this password');
    expect(sdk.isSessionOpen).toBe(false);
    expect(sdk.storageState).toBe('locked');
  }, 180_000);
});
