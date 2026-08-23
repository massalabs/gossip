import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateMnemonic,
  GossipSdk,
  SdkEventType,
  SdkStatus,
} from '@massalabs/gossip-sdk';
import { SECURE_STORAGE_IDB_NAME } from '@massalabs/gossip-sdk/db/secure-storage-namespaces';
import secureStorageWasmUrlRaw from '@massalabs/gossip-sdk/assets/generated/wasm-secureStorage/secureStorage_bg.wasm?url';
import { AuthService } from '../../gossip-sdk/src/services/auth';
import { userProfile } from '../helpers/factories/userProfile';

describe('browser public-key reconnect publication', () => {
  let sdk: GossipSdk;
  let postPublicKey: ReturnType<typeof vi.fn>;
  let updatePublicKeyTimestamp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sdk = new GossipSdk();
    postPublicKey = vi.fn();
    updatePublicKeyTimestamp = vi.fn().mockResolvedValue(true);
    const auth = new AuthService({
      fetchPublicKeyByUserId: vi.fn(),
      postPublicKey,
    });
    const queries = {
      userProfiles: {
        getById: vi.fn().mockResolvedValue(null),
        updateById: updatePublicKeyTimestamp,
      },
    };
    const internals = sdk as unknown as {
      state: unknown;
      _auth: AuthService;
      _queries: unknown;
    };
    internals.state = {
      status: SdkStatus.SESSION_OPEN,
      messageProtocol: {},
      config: {},
      session: {
        ourPk: { to_bytes: () => new Uint8Array([1, 2, 3]) },
        userIdEncoded: 'gossip1browserpublication',
        dispose: vi.fn(),
      },
    };
    internals._auth = auth;
    internals._queries = queries;
  });

  afterEach(async () => {
    if (sdk.isSessionOpen) await sdk.closeSession();
  });

  it('retries timestamp persistence online without repeating a confirmed post', async () => {
    updatePublicKeyTimestamp.mockRejectedValueOnce(
      new Error('timestamp persistence failed')
    );
    const publicationFailed = new Promise<void>(resolve => {
      sdk.on(SdkEventType.ERROR, event => {
        if (event.context === 'publishPublicKey') resolve();
      });
    });

    sdk.startPublicKeyPublication();
    await publicationFailed;
    expect(postPublicKey).toHaveBeenCalledOnce();
    expect(updatePublicKeyTimestamp).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() =>
      expect(updatePublicKeyTimestamp).toHaveBeenCalledTimes(2)
    );
    expect(postPublicKey).toHaveBeenCalledOnce();
  });

  it('retries on online once and removes the listener on close', async () => {
    let resolveReconnect!: (value: string) => void;
    const reconnectPost = new Promise<string>(resolve => {
      resolveReconnect = resolve;
    });
    postPublicKey
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(reconnectPost);
    const publicationFailed = new Promise<void>(resolve => {
      sdk.on(SdkEventType.ERROR, event => {
        if (event.context === 'publishPublicKey') resolve();
      });
    });
    const removeListener = vi.spyOn(globalThis, 'removeEventListener');

    try {
      sdk.startPublicKeyPublication();
      await publicationFailed;
      expect(postPublicKey).toHaveBeenCalledOnce();

      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(() => expect(postPublicKey).toHaveBeenCalledTimes(2));

      resolveReconnect('ok');
      await reconnectPost;
      await sdk.closeSession();
      expect(removeListener).toHaveBeenCalledWith(
        'online',
        expect.any(Function)
      );

      window.dispatchEvent(new Event('online'));
      await new Promise(resolve => requestAnimationFrame(resolve));
      expect(postPublicKey).toHaveBeenCalledTimes(2);
    } finally {
      resolveReconnect('ok');
      removeListener.mockRestore();
    }
  });
});

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
      reject(new Error('secure-storage IndexedDB deletion was blocked'));
  });
}

describe('durable public-key publication timestamp', () => {
  beforeEach(async () => {
    await clearSecureStorageIdb();
  }, 60_000);

  afterEach(async () => {
    await clearSecureStorageIdb();
  }, 60_000);

  it('persists a pre-profile confirmation without reposting after relaunch', async () => {
    const domain = 'publication-before-profile';
    const password = 'publication-password';
    const mnemonic = await generateMnemonic();
    let resolveFirstPost!: (value: string) => void;
    let markFirstPostStarted!: () => void;
    const firstPostStarted = new Promise<void>(resolve => {
      markFirstPostStarted = resolve;
    });
    const firstPost = vi.fn(() => {
      markFirstPostStarted();
      return new Promise<string>(resolve => {
        resolveFirstPost = resolve;
      });
    });
    const first = new GossipSdk();
    await first.init({
      protocolBaseUrl: 'http://127.0.0.1:1',
      storage: {
        type: 'secureStorage',
        domain,
        secureStorageWasmUrl,
      },
    });
    await first.secureStorageCreate(0, password);

    const firstInternals = first as unknown as {
      _auth: AuthService;
      _queries: {
        userProfiles: {
          getById: (userId: string) => Promise<{
            lastPublicKeyPush: Date | null;
          } | null>;
          updateById: ReturnType<typeof vi.fn>;
        };
      };
    };
    firstInternals._auth = new AuthService({
      fetchPublicKeyByUserId: vi.fn(),
      postPublicKey: firstPost,
    });
    const originalUpdate = firstInternals._queries.userProfiles.updateById.bind(
      firstInternals._queries.userProfiles
    );
    const update = vi
      .fn(originalUpdate)
      .mockName('real profile timestamp update');
    firstInternals._queries.userProfiles.updateById = update;

    const postStartTime = 1_700_000_000_000;
    const publicationTime = postStartTime + 60_000;
    let currentTime = postStartTime;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    let confirmedAt: number | undefined;
    try {
      await first.openSession({ mnemonic, autoStartPolling: false });
      await firstPostStarted;
      expect(update).not.toHaveBeenCalled();
      currentTime = publicationTime;
      resolveFirstPost('published');
      await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
      await expect(update.mock.results[0].value).resolves.toBe(false);
      expect(firstPost).toHaveBeenCalledOnce();

      currentTime += 5 * 60 * 1000;
      const profile = userProfile()
        .userId(first.userId)
        .username('publisher')
        .build();
      await first.profiles.createOrUpdate(
        profile.username,
        profile.userId,
        profile.security,
        profile.session
      );
      expect(update).toHaveBeenCalledTimes(2);
      const saved = await firstInternals._queries.userProfiles.getById(
        first.userId
      );
      confirmedAt = saved?.lastPublicKeyPush?.getTime();
      expect(confirmedAt).toBe(publicationTime);
      expect(firstPost).toHaveBeenCalledOnce();
    } finally {
      now.mockRestore();
    }

    await first.closeSession();
    await first.secureStorageLock();
    await first.destroy();
    await new Promise(resolve => setTimeout(resolve, 0));

    const secondPost = vi.fn().mockResolvedValue('duplicate');
    const second = new GossipSdk();
    try {
      await second.init({
        protocolBaseUrl: 'http://127.0.0.1:1',
        storage: {
          type: 'secureStorage',
          domain,
          secureStorageWasmUrl,
        },
      });
      expect(await second.secureStorageUnlock(password)).toBe(true);
      const secondInternals = second as unknown as { _auth: AuthService };
      secondInternals._auth = new AuthService({
        fetchPublicKeyByUserId: vi.fn(),
        postPublicKey: secondPost,
      });
      await second.openSession({ mnemonic, autoStartPolling: false });
      await new Promise(resolve => requestAnimationFrame(resolve));

      expect(secondPost).not.toHaveBeenCalled();
      expect(
        (await second.profiles.get(second.userId))?.lastPublicKeyPush?.getTime()
      ).toBe(confirmedAt);
    } finally {
      await second.destroy();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }, 180_000);
});
