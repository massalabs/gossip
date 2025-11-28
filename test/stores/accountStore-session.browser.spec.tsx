import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAccountStore } from '../../src/stores/accountStore';
import { db } from '../../src/db';
import { ensureWasmInitialized } from '../../src/wasm';

// Note: db is NOT mocked - we use the real db with fake-indexeddb from setup.ts

vi.mock('../../src/crypto/encryption', async () => {
  const actual = await vi.importActual('../../src/crypto/encryption');
  const { EncryptionKey } = await import('../../src/wasm/encryption');
  return {
    ...actual,
    encrypt: vi.fn(async () => {
      // Return proper structure expected by the code
      return {
        encryptedData: new Uint8Array(64),
        nonce: new Uint8Array(32),
      };
    }),
    decrypt: vi.fn(),
    deriveKey: vi.fn(async (seedString: string, salt: Uint8Array) => {
      // Use real WASM to derive key
      await ensureWasmInitialized();
      return EncryptionKey.from_seed(seedString, salt);
    }),
  };
});

vi.mock('../../src/crypto/bip39', () => ({
  generateMnemonic: vi.fn(
    () => 'test mnemonic phrase with enough words to be valid'
  ),
  validateMnemonic: vi.fn(() => true),
}));

vi.mock('../../src/crypto/webauthn', () => ({
  isWebAuthnSupported: vi.fn(() => false),
  isPlatformAuthenticatorAvailable: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../src/services/biometricService', () => ({
  biometricService: {
    checkAvailability: vi.fn(),
    createCredential: vi.fn(),
    authenticate: vi.fn(),
    removeEncryptionKey: vi.fn(),
  },
}));

// Don't mock WASM - we need real WASM for browser tests

vi.mock('../../src/services/auth', () => ({
  authService: {
    ensurePublicKeyPublished: vi.fn(),
  },
}));

vi.mock('../../src/stores/discussionStore', () => ({
  useDiscussionStore: {
    getState: vi.fn(() => ({
      reset: vi.fn(),
      cleanup: vi.fn(),
    })),
  },
}));

vi.mock('../../src/stores/messageStore', () => ({
  useMessageStore: {
    getState: vi.fn(() => ({
      reset: vi.fn(),
      cleanup: vi.fn(),
    })),
  },
}));

vi.mock('../../src/stores/appStore', () => ({
  useAppStore: {
    getState: vi.fn(() => ({
      navigate: vi.fn(),
      setIsInitialized: vi.fn(),
      isInitialized: false,
    })),
  },
}));

vi.mock('@massalabs/massa-web3', () => ({
  Account: {
    fromPrivateKey: vi.fn(),
  },
  PrivateKey: {
    fromBytes: vi.fn(),
  },
  Provider: vi.fn(),
}));

describe('stores/accountStore.tsx - Session Management (Browser)', () => {
  beforeEach(async () => {
    // Ensure WASM is initialized before each test
    await ensureWasmInitialized();

    // Reset store state
    useAccountStore.setState({
      userProfile: null,
      encryptionKey: null,
      isLoading: false,
      account: null,
      ourPk: null,
      ourSk: null,
      session: null,
    });

    // Ensure DB is open and clear any existing data
    if (!db.isOpen()) {
      await db.open();
    }
    await db.userProfile.clear();

    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up database
    await db.userProfile.clear();
    // Close the database to avoid "connection wants to delete" warnings
    db.close();
  });

  describe('session.refresh()', () => {
    it('should refresh session and return peer IDs needing keep-alive', async () => {
      const { generateMnemonic } = await import('../../src/crypto/bip39');
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');

      const mockMnemonic = 'test mnemonic phrase with enough words to be valid';
      vi.mocked(generateMnemonic).mockReturnValue(mockMnemonic);
      vi.mocked(PrivateKey.fromBytes).mockReturnValue(
        {} as unknown as import('@massalabs/massa-web3').PrivateKey
      );
      vi.mocked(Account.fromPrivateKey).mockResolvedValue({
        address: 'test-address',
      } as unknown as import('@massalabs/massa-web3').Account);

      // Create a fresh account with a valid session
      await useAccountStore
        .getState()
        .initializeAccount('testuser', 'password123');

      const state = useAccountStore.getState();
      expect(state.session).toBeDefined();

      // Call refresh on the session
      if (state.session) {
        const peerIds = state.session.refresh();

        // refresh() should return an array (may be empty if no peers)
        expect(Array.isArray(peerIds)).toBe(true);

        // Session should still be valid after refresh
        expect(state.session).toBeDefined();
      } else {
        throw new Error('Session was not created');
      }
    });

    it('should trigger persistence callback after refresh', async () => {
      const { generateMnemonic } = await import('../../src/crypto/bip39');
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');

      const mockMnemonic = 'test mnemonic phrase with enough words to be valid';
      vi.mocked(generateMnemonic).mockReturnValue(mockMnemonic);
      vi.mocked(PrivateKey.fromBytes).mockReturnValue(
        {} as unknown as import('@massalabs/massa-web3').PrivateKey
      );
      vi.mocked(Account.fromPrivateKey).mockResolvedValue({
        address: 'test-address',
      } as unknown as import('@massalabs/massa-web3').Account);

      // Create a fresh account with a valid session
      await useAccountStore
        .getState()
        .initializeAccount('testuser', 'password123');

      const state = useAccountStore.getState();
      expect(state.session).toBeDefined();
      expect(state.userProfile).toBeDefined();

      // Call refresh - this should trigger persistSession via callback
      if (state.session && state.userProfile) {
        state.session.refresh();

        // Wait a bit for async persistence
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify database was updated
        const updatedProfile = await db.userProfile.get(
          state.userProfile.userId
        );
        expect(updatedProfile?.session).toBeInstanceOf(Uint8Array);
        expect(updatedProfile?.updatedAt).toBeInstanceOf(Date);

        // Session should still be valid (not cleaned up)
        expect(state.session).toBeDefined();
      } else {
        throw new Error('Session was not created');
      }
    });

    it('should handle refresh when session has no peers', async () => {
      const { generateMnemonic } = await import('../../src/crypto/bip39');
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');

      const mockMnemonic = 'test mnemonic phrase with enough words to be valid';
      vi.mocked(generateMnemonic).mockReturnValue(mockMnemonic);
      vi.mocked(PrivateKey.fromBytes).mockReturnValue(
        {} as unknown as import('@massalabs/massa-web3').PrivateKey
      );
      vi.mocked(Account.fromPrivateKey).mockResolvedValue({
        address: 'test-address',
      } as unknown as import('@massalabs/massa-web3').Account);

      // Create a fresh account with a valid session
      await useAccountStore
        .getState()
        .initializeAccount('testuser', 'password123');

      const state = useAccountStore.getState();
      expect(state.session).toBeDefined();

      // Call refresh on a new session (should have no peers)
      if (state.session) {
        const peerIds = state.session.refresh();

        // Should return empty array for new session with no peers
        expect(peerIds).toEqual([]);
        expect(Array.isArray(peerIds)).toBe(true);
      } else {
        throw new Error('Session was not created');
      }
    });
  });

  describe('session expiration handling', () => {
    it('should handle expired session gracefully', async () => {
      const { generateMnemonic } = await import('../../src/crypto/bip39');
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');

      const mockMnemonic = 'test mnemonic phrase with enough words to be valid';
      vi.mocked(generateMnemonic).mockReturnValue(mockMnemonic);
      vi.mocked(PrivateKey.fromBytes).mockReturnValue(
        {} as unknown as import('@massalabs/massa-web3').PrivateKey
      );
      vi.mocked(Account.fromPrivateKey).mockResolvedValue({
        address: 'test-address',
      } as unknown as import('@massalabs/massa-web3').Account);

      // Create a fresh account with a valid session
      await useAccountStore
        .getState()
        .initializeAccount('testuser', 'password123');

      const state = useAccountStore.getState();
      expect(state.session).toBeDefined();
      expect(state.encryptionKey).toBeDefined();

      if (state.session && state.encryptionKey) {
        // Session should be able to handle refresh even if internally
        // some sessions have expired (WASM handles this internally)
        const peerIds = state.session.refresh();

        // Should not throw even if sessions are expired
        expect(Array.isArray(peerIds)).toBe(true);

        // Session should still be usable after refresh
        const sessionBlob = state.session.toEncryptedBlob(state.encryptionKey);
        expect(sessionBlob).toBeInstanceOf(Uint8Array);
        expect(sessionBlob.length).toBeGreaterThan(0);
      } else {
        throw new Error('Session was not created');
      }
    });

    it('should persist session state after refresh handles expiration', async () => {
      const { generateMnemonic } = await import('../../src/crypto/bip39');
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');

      const mockMnemonic = 'test mnemonic phrase with enough words to be valid';
      vi.mocked(generateMnemonic).mockReturnValue(mockMnemonic);
      vi.mocked(PrivateKey.fromBytes).mockReturnValue(
        {} as unknown as import('@massalabs/massa-web3').PrivateKey
      );
      vi.mocked(Account.fromPrivateKey).mockResolvedValue({
        address: 'test-address',
      } as unknown as import('@massalabs/massa-web3').Account);

      // Create a fresh account with a valid session
      await useAccountStore
        .getState()
        .initializeAccount('testuser', 'password123');

      const state = useAccountStore.getState();
      expect(state.session).toBeDefined();
      expect(state.encryptionKey).toBeDefined();
      expect(state.userProfile).toBeDefined();

      if (state.session && state.encryptionKey && state.userProfile) {
        // Call refresh - expiration handling happens internally
        state.session.refresh();

        // Wait for persistence callback
        await new Promise(resolve => setTimeout(resolve, 100));

        // Session should still be serializable after expiration handling
        const sessionBlob = state.session.toEncryptedBlob(state.encryptionKey);
        expect(sessionBlob).toBeInstanceOf(Uint8Array);

        // Verify database was updated with session
        const updatedProfile = await db.userProfile.get(
          state.userProfile.userId
        );
        expect(updatedProfile?.session).toBeInstanceOf(Uint8Array);

        // The session state should be persisted (via callback)
        // We verify the session is still valid and can be serialized
        expect(state.session).toBeDefined();
      } else {
        throw new Error('Session or encryption key was not created');
      }
    });

    it('should allow session to be reloaded after expiration handling', async () => {
      const { generateMnemonic } = await import('../../src/crypto/bip39');
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');

      const mockMnemonic = 'test mnemonic phrase with enough words to be valid';
      vi.mocked(generateMnemonic).mockReturnValue(mockMnemonic);
      vi.mocked(PrivateKey.fromBytes).mockReturnValue(
        {} as unknown as import('@massalabs/massa-web3').PrivateKey
      );
      vi.mocked(Account.fromPrivateKey).mockResolvedValue({
        address: 'test-address',
      } as unknown as import('@massalabs/massa-web3').Account);

      // Create a fresh account with a valid session
      await useAccountStore
        .getState()
        .initializeAccount('testuser', 'password123');

      const state = useAccountStore.getState();
      expect(state.session).toBeDefined();
      expect(state.encryptionKey).toBeDefined();
      expect(state.userProfile).toBeDefined();

      if (state.session && state.encryptionKey && state.userProfile) {
        // Call refresh to handle any expiration
        state.session.refresh();

        // Session should still be serializable
        const newSessionBlob = state.session.toEncryptedBlob(
          state.encryptionKey
        );
        expect(newSessionBlob).toBeInstanceOf(Uint8Array);

        // The session should be reloadable from the blob
        // (This tests that expiration handling doesn't break session state)
        const { SessionModule } = await import('../../src/wasm');
        const reloadedSession = new SessionModule(() => {
          useAccountStore.getState().persistSession();
        });

        // Update profile with new session blob
        const updatedProfile = {
          ...state.userProfile,
          session: newSessionBlob,
        };

        // Should be able to load the session from the blob
        reloadedSession.load(updatedProfile, state.encryptionKey);

        // Verify the reloaded session is valid
        const reloadedBlob = reloadedSession.toEncryptedBlob(
          state.encryptionKey
        );
        expect(reloadedBlob).toBeInstanceOf(Uint8Array);
        expect(reloadedBlob.length).toBeGreaterThan(0);

        // Cleanup
        reloadedSession.cleanup();
      } else {
        throw new Error('Required state was not created');
      }
    });
  });
});
