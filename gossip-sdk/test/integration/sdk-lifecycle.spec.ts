/**
 * GossipSdk lifecycle tests
 *
 * Uses real WASM SessionModule with real crypto.
 * Only mocks network-dependent protocols (auth, message).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EncryptionKey } from '../../src/wasm/encryption';
import { UserPublicKeys, UserSecretKeys } from '../../src/wasm/bindings';
import { GossipSdk } from '../../src/gossip';
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
