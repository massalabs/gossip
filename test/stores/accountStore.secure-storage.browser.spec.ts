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
}));

vi.mock('../../src/stores/sdkStore', () => ({
  getSdk: () => {
    if (!mocks.sdk) throw new Error('SDK not initialized');
    return mocks.sdk;
  },
}));

vi.mock('../../src/stores/utils/accountHelpers', () => ({
  deriveAccountFromMnemonic: vi.fn(async () => ({
    account: null,
    userIdBytes: new Uint8Array(32),
    evmAddress: '0x0000000000000000000000000000000000000000',
    massaAddress: 'AU1test',
  })),
  fetchMnsDomainsIfEnabled: vi.fn(),
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
import {
  createPasswordSecurity,
  preparePasswordAccount,
  wipePreparedPasswordAccount,
} from '../../src/stores/utils/auth';

const secureStorageWasmUrl = new URL(
  secureStorageWasmUrlRaw,
  window.location.href
).href;

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
  const { security, encryptionKey } = await createPasswordSecurity(
    mnemonic,
    password
  );
  const now = new Date();
  const profile: UserProfile = {
    userId,
    username,
    security,
    session: new Uint8Array(0),
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
    encryptionKey.free();
  }
}

describe('secure biometric account-store login integration', () => {
  beforeEach(async () => {
    mocks.sdk = null;
    useAppStore.getState().setSecureAccountCreationAllowed(true);
    await clearSecureStorageIdb();
  }, 60_000);

  afterEach(async () => {
    const sdk = mocks.sdk;
    if (sdk?.isSessionOpen) {
      await sdk.closeSession();
    }
    if (sdk?.storageState === 'unlocked') {
      await sdk.secureStorageLock();
    }
    const connection = (
      sdk as unknown as { _conn?: { close: () => Promise<void> } }
    )?._conn;
    await connection?.close();
    mocks.sdk = null;
    useAppStore.getState().setSecureAccountCreationAllowed(false);
    await clearSecureStorageIdb();
  }, 60_000);

  it('persists a prepared identity, wipes its source, and reopens it normally', async () => {
    const sdk = new GossipSdk();
    mocks.sdk = sdk;
    await sdk.init({
      protocolBaseUrl: 'http://127.0.0.1:1',
      storage: {
        type: 'secureStorage',
        domain: 'account-store-prepared-integration',
        secureStorageWasmUrl,
      },
    });

    const mnemonic = await generateMnemonic();
    const prepared = await preparePasswordAccount(
      mnemonic,
      'prepared-password'
    );
    await useAccountStore
      .getState()
      .initializePreparedAccount(
        'prepared-alice',
        'prepared-password',
        prepared
      );
    const stableUserId = sdk.userId;

    wipePreparedPasswordAccount(prepared);
    await useAccountStore.getState().logout({ lockedByUser: false });
    await useAccountStore.getState().loadAccount({
      type: 'password',
      password: 'prepared-password',
    });

    expect(useAccountStore.getState().userProfile?.username).toBe(
      'prepared-alice'
    );
    expect(sdk.userId).toBe(stableUserId);
  }, 180_000);

  it('makes every committed batch password undiscoverable after rollback', async () => {
    const sdk = new GossipSdk();
    mocks.sdk = sdk;
    await sdk.init({
      protocolBaseUrl: 'http://127.0.0.1:1',
      storage: {
        type: 'secureStorage',
        domain: 'account-store-rollback-integration',
        secureStorageWasmUrl,
      },
    });

    const alice = await preparePasswordAccount(
      await generateMnemonic(),
      'alice-password'
    );
    const decoy = await preparePasswordAccount(
      await generateMnemonic(),
      'decoy-password'
    );
    await useAccountStore
      .getState()
      .initializePreparedAccount('alice', 'alice-password', alice);
    await useAccountStore
      .getState()
      .initializePreparedAccount('decoy', 'decoy-password', decoy);

    const rollback = await useAccountStore
      .getState()
      .rollbackInitializedAccounts(['alice-password', 'decoy-password']);
    wipePreparedPasswordAccount(alice);
    wipePreparedPasswordAccount(decoy);

    expect(rollback).toEqual({
      failedPasswordIndexes: [],
      lockFailed: false,
    });
    expect(sdk.storageState).toBe('locked');
    expect(await sdk.secureStorageUnlock('alice-password')).toBe(false);
    expect(await sdk.secureStorageUnlock('decoy-password')).toBe(false);
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

    await provisionProfile(sdk, 0, 'alice', 'alice-password');
    await provisionProfile(sdk, 1, 'decoy', 'decoy-password');
    await sdk.secureStorageCreate(2, 'empty-slot-password');
    await sdk.flush();
    await sdk.secureStorageLock();

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
