/**
 * GossipSdk lifecycle tests
 *
 * Uses real WASM SessionModule with real crypto.
 * Only mocks network-dependent protocols (auth, message).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EncryptionKey } from '../../src/wasm/encryption';
import { UserPublicKeys, UserSecretKeys } from '../../src/wasm/bindings';
import { GossipSdk, SdkStatus } from '../../src/gossip';
import { clearAllTables, getTestStorageConfig } from '../testDb';
import { generateMnemonic } from '../../src/crypto/bip39';
import { MockMessageProtocol } from '../mocks';
import { PUBLIC_KEY_REPUBLISH_INTERVAL_MS } from '../../src/services/auth';
import {
  configureLogging,
  resetLoggingForTests,
  setLogSinks,
  type LogSink,
} from '../../src/utils/logs';

vi.mock('../../src/api/messageProtocol', () => ({
  createMessageProtocol: () => new MockMessageProtocol(),
}));

const postPublicKey = vi.hoisted(() => vi.fn().mockResolvedValue('ok'));

vi.mock('../../src/api/authProtocol', () => ({
  createAuthProtocol: () => ({
    fetchPublicKeyByUserId: vi.fn().mockRejectedValue(new Error('not found')),
    postPublicKey,
  }),
}));

describe('GossipSdk lifecycle', () => {
  let sdk: GossipSdk;
  const emittedWarnings: unknown[] = [];
  const testSink: LogSink = (level, message) => {
    if (level === 'warn') {
      emittedWarnings.push(message);
    }
  };

  beforeEach(async () => {
    await clearAllTables();
    vi.clearAllMocks();
    emittedWarnings.length = 0;
    configureLogging({ enabled: true, minLevel: 'debug', persist: false });
    setLogSinks([testSink]);
    sdk = new GossipSdk();
  });

  afterEach(async () => {
    try {
      await sdk.closeSession();
    } catch {
      // may not be open
    }
    resetLoggingForTests();
  });

  it('initializes once and exposes auth service', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    expect(sdk.isInitialized).toBe(true);
    expect(() => sdk.auth).not.toThrow();

    await sdk.init({ storage: getTestStorageConfig() });
    expect(emittedWarnings.length).toBeGreaterThan(0);
  });

  it('invalidates query readiness before a retryable lock failure', async () => {
    const lockError = new Error('lock flush failed');
    const connection = {
      isOpen: true,
      isSecureStorage: true,
      storageState: 'unlocked' as const,
      secureStorageLock: vi.fn().mockImplementationOnce(async () => {
        connection.isOpen = false;
        throw lockError;
      }),
    };
    const internals = sdk as unknown as {
      state: { status: SdkStatus };
      _conn: typeof connection;
      _queries: object | null;
      _profile: object | null;
    };
    internals.state = { status: SdkStatus.INITIALIZED };
    internals._conn = connection;
    internals._queries = {};
    internals._profile = {};
    expect(sdk.dbReady).toBe(true);

    await expect(sdk.secureStorageLock()).rejects.toBe(lockError);

    expect(sdk.storageState).toBe('unlocked');
    expect(sdk.dbReady).toBe(false);
    expect(() => sdk.queries).toThrow();
    expect(() => sdk.profiles).toThrow();

    connection.secureStorageLock.mockResolvedValueOnce(undefined);
    await expect(sdk.secureStorageLock()).resolves.toBeUndefined();
  });

  it('throws on openSession before init', async () => {
    await expect(
      sdk.openSession({ mnemonic: generateMnemonic() })
    ).rejects.toThrow('SDK not initialized');
  });

  it('opens and closes session with getters wired', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    await sdk.openSession({ mnemonic: generateMnemonic() });

    expect(sdk.isSessionOpen).toBe(true);
    expect(sdk.userIdBytes).toBeInstanceOf(Uint8Array);
    expect(sdk.userIdBytes.length).toBe(32);
    expect(sdk.publicKeys).toBeDefined();

    await sdk.closeSession();
    expect(sdk.isSessionOpen).toBe(false);
    expect(() => sdk.messages).toThrow('No session open');
  });

  it('disposes identity wrappers and its derived key on normal close', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    const publicFree = vi.spyOn(UserPublicKeys.prototype, 'free');
    const secretFree = vi.spyOn(UserSecretKeys.prototype, 'free');
    const encryptionFree = vi.spyOn(EncryptionKey.prototype, 'free');

    try {
      await sdk.openSession({
        mnemonic: generateMnemonic(),
        autoStartPolling: false,
        publishPublicKey: false,
      });
      await sdk.closeSession();

      expect(publicFree).toHaveBeenCalledOnce();
      expect(secretFree).toHaveBeenCalledOnce();
      expect(encryptionFree).toHaveBeenCalledOnce();
    } finally {
      publicFree.mockRestore();
      secretFree.mockRestore();
      encryptionFree.mockRestore();
    }
  });

  it('disposes constructed identity state when session opening rejects', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    const publicFree = vi.spyOn(UserPublicKeys.prototype, 'free');
    const secretFree = vi.spyOn(UserSecretKeys.prototype, 'free');
    const encryptionFree = vi.spyOn(EncryptionKey.prototype, 'free');
    const internals = sdk as unknown as {
      resetStuckSendingMessages: (userId: string) => Promise<void>;
    };
    const reset = vi
      .spyOn(internals, 'resetStuckSendingMessages')
      .mockRejectedValue(new Error('database reset failed'));

    try {
      await expect(
        sdk.openSession({
          mnemonic: generateMnemonic(),
          autoStartPolling: false,
        })
      ).rejects.toThrow('database reset failed');

      expect(sdk.isSessionOpen).toBe(false);
      expect(postPublicKey).not.toHaveBeenCalled();
      expect(publicFree).toHaveBeenCalledOnce();
      expect(secretFree).toHaveBeenCalledOnce();
      expect(encryptionFree).toHaveBeenCalledOnce();
    } finally {
      reset.mockRestore();
      publicFree.mockRestore();
      secretFree.mockRestore();
      encryptionFree.mockRestore();
    }
  });

  it('frees an internally derived key when session validation rejects', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    const encryptionFree = vi.spyOn(EncryptionKey.prototype, 'free');

    try {
      await expect(
        sdk.openSession({
          mnemonic: generateMnemonic(),
          encryptedSession: new Uint8Array([1, 2, 3]),
          autoStartPolling: false,
        })
      ).rejects.toThrow('Failed to load encrypted session');
      expect(encryptionFree).toHaveBeenCalledOnce();
    } finally {
      encryptionFree.mockRestore();
    }
  });

  it('can defer public-key publication until a later real login', async () => {
    const mnemonic = generateMnemonic();
    await sdk.init({ storage: getTestStorageConfig() });

    await sdk.openSession({
      mnemonic,
      autoStartPolling: false,
      publishPublicKey: false,
    });
    await Promise.resolve();
    expect(postPublicKey).not.toHaveBeenCalled();

    await sdk.closeSession();
    await sdk.openSession({ mnemonic, autoStartPolling: false });
    await vi.waitFor(() => expect(postPublicKey).toHaveBeenCalledOnce());
  });

  it('unrefs publication timers in Node without cancelling them', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    await sdk.openSession({
      mnemonic: generateMnemonic(),
      autoStartPolling: false,
      publishPublicKey: false,
    });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    try {
      sdk.startPublicKeyPublication();
      await vi.waitFor(() => {
        const timerIndex = setTimeoutSpy.mock.calls.findIndex(
          ([, delay]) => delay === 60_000
        );
        expect(timerIndex).toBeGreaterThanOrEqual(0);

        const timer = setTimeoutSpy.mock.results[timerIndex]?.value as {
          hasRef?: () => boolean;
        };
        expect(timer.hasRef?.()).toBe(false);
      });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('retries failed publication and republishes when refresh is due', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    await sdk.openSession({
      mnemonic: generateMnemonic(),
      autoStartPolling: false,
      publishPublicKey: false,
    });
    postPublicKey
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('ok');
    vi.useFakeTimers();

    try {
      sdk.startPublicKeyPublication();
      await vi.waitFor(() => expect(postPublicKey).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(postPublicKey).toHaveBeenCalledTimes(2));

      await vi.advanceTimersByTimeAsync(PUBLIC_KEY_REPUBLISH_INTERVAL_MS);
      await vi.waitFor(() => expect(postPublicKey).toHaveBeenCalledTimes(3));
    } finally {
      await sdk.closeSession();
      vi.useRealTimers();
    }
  });

  it('restores encrypted session when provided', async () => {
    const mnemonic = generateMnemonic();

    await sdk.init({ storage: getTestStorageConfig() });
    await sdk.openSession({ mnemonic });

    const encryptedSession = sdk.getEncryptedSession();
    await sdk.closeSession();

    await sdk.openSession({
      mnemonic,
      encryptedSession,
    });
  });

  it('throws an error when encryptedSession cannot be loaded with the provided encryptionKey', async () => {
    const mnemonic = generateMnemonic();

    await sdk.init({ storage: getTestStorageConfig() });
    await sdk.openSession({ mnemonic });

    const encryptedSession = sdk.getEncryptedSession();
    await sdk.closeSession();

    await expect(
      sdk.openSession({
        mnemonic,
        encryptedSession,
        encryptionKey: { keyId: 'bad-key' } as unknown as EncryptionKey,
      })
    ).rejects.toThrow(
      'Failed to load encrypted session. Please provide a valid encryptedSession and encryptionKey.'
    );
  });
});
