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
import { createPasswordSecurity } from '../../src/stores/utils/auth';

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
  return encodeUserId(keys.public_keys().derive_id());
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
    await clearSecureStorageIdb();
  }, 60_000);

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
