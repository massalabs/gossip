/**
 * GossipSdk lifecycle tests
 *
 * Uses real WASM SessionModule with real crypto.
 * Only mocks network-dependent protocols (auth, message).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { type EncryptionKey } from '../../src/wasm/encryption';
import { GossipSdk } from '../../src/gossip';
import { clearAllTables } from '../../src/db/sqlite';
import { generateMnemonic } from '../../src/crypto/bip39';
import { MockMessageProtocol } from '../mocks';

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

  beforeEach(async () => {
    await clearAllTables();
    vi.clearAllMocks();
    sdk = new GossipSdk();
  });

  afterEach(async () => {
    try {
      await sdk.closeSession();
    } catch {
      // may not be open
    }
  });

  it('initializes once and exposes auth service', async () => {
    await sdk.init({});
    expect(sdk.isInitialized).toBe(true);
    expect(() => sdk.auth).not.toThrow();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sdk.init({});
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('throws on openSession before init', async () => {
    await expect(
      sdk.openSession({ mnemonic: generateMnemonic() })
    ).rejects.toThrow('SDK not initialized');
  });

  it('opens and closes session with getters wired', async () => {
    await sdk.init({});
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

    await sdk.init({});
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

    await sdk.init({});
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
