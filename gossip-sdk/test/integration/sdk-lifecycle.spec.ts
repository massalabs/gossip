/**
 * GossipSdk lifecycle tests
 *
 * Uses real WASM SessionModule with real crypto.
 * Only mocks network-dependent protocols (auth, message).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { type EncryptionKey } from '../../src/wasm/encryption';
import { GossipSdk } from '../../src/gossip';
import { DatabaseConnection } from '../../src/db/sqlite';
import { clearAllTables, getTestStorageConfig } from '../testDb';
import { generateMnemonic } from '../../src/crypto/bip39';
import { MockMessageProtocol } from '../mocks';
import {
  configureLogging,
  resetLoggingForTests,
  setLogSinks,
  type LogSink,
} from '../../src/utils/logs';

vi.mock('../../src/api/messageProtocol', () => ({
  createMessageProtocol: () => new MockMessageProtocol(),
}));

vi.mock('../../src/api/authProtocol', () => ({
  createAuthProtocol: () => ({
    fetchPublicKeyByUserId: vi.fn().mockRejectedValue(new Error('not found')),
    postPublicKey: vi.fn().mockResolvedValue('ok'),
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
    vi.restoreAllMocks();
    resetLoggingForTests();
  });

  it('initializes once and exposes auth service', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    expect(sdk.isInitialized).toBe(true);
    expect(() => sdk.auth).not.toThrow();

    await sdk.init({ storage: getTestStorageConfig() });
    expect(emittedWarnings.length).toBeGreaterThan(0);
  });

  it('dedupes concurrent init() calls into a single database open', async () => {
    const createSpy = vi.spyOn(DatabaseConnection, 'create');

    // Two callers race on the same instance: both must await the one
    // in-flight init instead of each opening the DB — the native
    // secure-storage backend rejects a second open (DatabaseAlreadyOpen).
    const [a, b] = await Promise.all([
      sdk.init({ storage: getTestStorageConfig() }),
      sdk.init({ storage: getTestStorageConfig() }),
    ]);

    expect(a).toBe(sdk);
    expect(b).toBe(sdk);
    expect(sdk.isInitialized).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('allows retrying init() after a failed attempt', async () => {
    vi.spyOn(DatabaseConnection, 'create').mockRejectedValueOnce(
      new Error('transient storage failure')
    );

    await expect(sdk.init({ storage: getTestStorageConfig() })).rejects.toThrow(
      'transient storage failure'
    );
    expect(sdk.isInitialized).toBe(false);

    // The failed attempt must clear the single-flight latch so the retry
    // runs a fresh init instead of being handed the rejected promise.
    await sdk.init({ storage: getTestStorageConfig() });
    expect(sdk.isInitialized).toBe(true);
  });

  it('releases the connection when init() fails after the database opened', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    // A connection whose first post-open step blows up: `_doInit` reads
    // `isOpen` right after `create()` resolves.
    const createSpy = vi
      .spyOn(DatabaseConnection, 'create')
      .mockResolvedValueOnce({
        get isOpen(): boolean {
          throw new Error('post-open failure');
        },
        close,
      } as unknown as DatabaseConnection);

    await expect(sdk.init({ storage: getTestStorageConfig() })).rejects.toThrow(
      'post-open failure'
    );

    // The half-open handle must be released — otherwise the retry's
    // create() hits DatabaseAlreadyOpen on native secure storage.
    expect(close).toHaveBeenCalledTimes(1);

    await sdk.init({ storage: getTestStorageConfig() });
    expect(sdk.isInitialized).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(2);
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
