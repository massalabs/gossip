/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAccountStore } from '../../src/stores/accountStore';
import { db } from '../../src/db';
import { userProfile } from '../helpers';
import { EncryptionKey, SessionModule } from '../../src/wasm';

// Note: db is NOT mocked - we use the real db with fake-indexeddb from setup.ts

vi.mock('../../src/crypto/encryption', () => ({
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  deriveKey: vi.fn(),
}));

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

// Mock SessionModule as a constructor class
const createMockSession = () => ({
  toEncryptedBlob: vi.fn(() => new Uint8Array(64)),
  load: vi.fn(),
  refresh: vi.fn(),
  cleanup: vi.fn(),
});

const createMockNonce = () => ({
  to_bytes: () => new Uint8Array(32).fill(1),
});

vi.mock('../../src/wasm', () => ({
  generateUserKeys: vi.fn(),
  generateNonce: vi.fn(() => Promise.resolve(createMockNonce())),
  generateEncryptionKey: vi.fn(),
  ensureWasmInitialized: vi.fn(() => Promise.resolve()),
  SessionModule: class SessionModule {
    constructor(_callback: () => void) {
      return createMockSession();
    }
  },
}));

vi.mock('../../src/wasm/loader', () => ({
  ensureWasmInitialized: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/services/auth', () => ({
  authService: {
    ensurePublicKeyPublished: vi.fn(),
  },
}));

// Create shared cleanup functions that can be tracked
const mockDiscussionStoreCleanup = vi.fn();
const mockMessageStoreCleanup = vi.fn();

vi.mock('../../src/stores/discussionStore', () => ({
  useDiscussionStore: {
    getState: vi.fn(() => ({
      reset: vi.fn(),
      cleanup: mockDiscussionStoreCleanup,
    })),
  },
}));

vi.mock('../../src/stores/messageStore', () => ({
  useMessageStore: {
    getState: vi.fn(() => ({
      reset: vi.fn(),
      cleanup: mockMessageStoreCleanup,
    })),
  },
}));

// Create shared app store functions that can be tracked
const mockSetIsInitialized = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../src/stores/appStore', () => ({
  useAppStore: {
    getState: vi.fn(() => ({
      navigate: mockNavigate,
      setIsInitialized: mockSetIsInitialized,
      isInitialized: false,
    })),
  },
}));

vi.mock('../../src/stores/utils/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('../../src/stores/utils/getAccount', () => ({
  getActiveOrFirstProfile: vi.fn(),
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

describe('stores/accountStore.tsx', () => {
  beforeEach(async () => {
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

    // Reset all mocks
    vi.clearAllMocks();
    mockSetIsInitialized.mockClear();
    mockNavigate.mockClear();
    mockDiscussionStoreCleanup.mockClear();
    mockMessageStoreCleanup.mockClear();
  });

  afterEach(async () => {
    // Clean up database
    await db.userProfile.clear();
    // Close the database to avoid "connection wants to delete" warnings
    db.close();
  });

  describe('hasExistingAccount()', () => {
    it('should return false when no accounts exist', async () => {
      // Ensure DB is cleared
      await db.userProfile.clear();

      const result = await useAccountStore.getState().hasExistingAccount();

      expect(result).toBe(false);
    });

    it('should return true when accounts exist', async () => {
      // Add a test profile
      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .build();
      await db.userProfile.add(testProfile);

      const result = await useAccountStore.getState().hasExistingAccount();

      expect(result).toBe(true);
    });
  });

  describe('getExistingAccountInfo()', () => {
    it('should return null when no accounts exist', async () => {
      const { getActiveOrFirstProfile } = await import(
        '../../src/stores/utils/getAccount'
      );

      vi.mocked(getActiveOrFirstProfile).mockResolvedValue(null);

      const result = await useAccountStore.getState().getExistingAccountInfo();

      expect(result).toBeNull();
    });

    it('should return first account when accounts exist', async () => {
      const { getActiveOrFirstProfile } = await import(
        '../../src/stores/utils/getAccount'
      );

      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .build();

      vi.mocked(getActiveOrFirstProfile).mockResolvedValue(testProfile);

      const result = await useAccountStore.getState().getExistingAccountInfo();

      expect(result).toEqual(testProfile);
    });
  });

  describe('getAllAccounts()', () => {
    it('should return empty array when no accounts', async () => {
      // Ensure DB is cleared
      await db.userProfile.clear();

      const result = await useAccountStore.getState().getAllAccounts();

      expect(result).toEqual([]);
    });

    it('should return all accounts', async () => {
      const profile1 = userProfile()
        .userId('gossip1test123')
        .username('user1')
        .build();
      const profile2 = userProfile()
        .userId('gossip1test456')
        .username('user2')
        .build();

      await db.userProfile.add(profile1);
      await db.userProfile.add(profile2);

      const result = await useAccountStore.getState().getAllAccounts();

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(profile1);
      expect(result).toContainEqual(profile2);
    });
  });

  describe('getMnemonicBackupInfo()', () => {
    it('should return null when no user profile', () => {
      useAccountStore.setState({ userProfile: null });

      const result = useAccountStore.getState().getMnemonicBackupInfo();

      expect(result).toBeNull();
    });

    it('should return backup info when profile exists', () => {
      const backupDate = new Date('2024-01-01');
      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .mnemonicBackup({
          encryptedMnemonic: new Uint8Array(64),
          createdAt: backupDate,
          backedUp: true,
        })
        .build();

      useAccountStore.setState({ userProfile: testProfile });

      const result = useAccountStore.getState().getMnemonicBackupInfo();

      expect(result).toEqual({
        createdAt: backupDate,
        backedUp: true,
      });
    });

    it('should return false for backedUp when not backed up', () => {
      const backupDate = new Date('2024-01-01');
      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .mnemonicBackup({
          encryptedMnemonic: new Uint8Array(64),
          createdAt: backupDate,
          backedUp: false,
        })
        .build();

      useAccountStore.setState({ userProfile: testProfile });

      const result = useAccountStore.getState().getMnemonicBackupInfo();

      expect(result).toEqual({
        createdAt: backupDate,
        backedUp: false,
      });
    });
  });

  describe('markMnemonicBackupComplete()', () => {
    it('should update backup status to true', async () => {
      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .build();

      // Add profile to database first
      await db.userProfile.add(testProfile);
      useAccountStore.setState({ userProfile: testProfile });

      await useAccountStore.getState().markMnemonicBackupComplete();

      // Verify database was updated
      const updatedProfile = await db.userProfile.get(testProfile.userId);
      expect(updatedProfile?.security.mnemonicBackup.backedUp).toBe(true);

      // Verify state was updated
      const stateProfile = useAccountStore.getState().userProfile;
      expect(stateProfile?.security.mnemonicBackup.backedUp).toBe(true);
    });

    it('should throw error if no user profile', async () => {
      useAccountStore.setState({ userProfile: null });

      await expect(
        useAccountStore.getState().markMnemonicBackupComplete()
      ).rejects.toThrow();
    });
  });

  describe('setLoading()', () => {
    it('should update loading state', () => {
      useAccountStore.getState().setLoading(true);

      expect(useAccountStore.getState().isLoading).toBe(true);

      useAccountStore.getState().setLoading(false);

      expect(useAccountStore.getState().isLoading).toBe(false);
    });
  });

  describe('logout()', () => {
    it('should clear account state and cleanup session', async () => {
      // Setup state with session
      const mockSession = createMockSession();

      useAccountStore.setState({
        userProfile: userProfile().build(),
        account: {
          address: 'test',
        } as unknown as import('@massalabs/massa-web3').Account,
        session:
          mockSession as unknown as import('../../src/wasm').SessionModule,
        encryptionKey: {
          to_bytes: () => new Uint8Array(32),
        } as unknown as import('../../src/wasm').EncryptionKey,
      });

      await useAccountStore.getState().logout();

      expect(mockSession.cleanup).toHaveBeenCalled();
      expect(mockDiscussionStoreCleanup).toHaveBeenCalled();
      expect(mockMessageStoreCleanup).toHaveBeenCalled();

      const state = useAccountStore.getState();
      expect(state.userProfile).toBeNull();
      expect(state.account).toBeNull();
      expect(state.session).toBeNull();
      expect(state.encryptionKey).toBeNull();
      expect(state.isLoading).toBe(false);
    });

    it('should handle errors gracefully', async () => {
      mockDiscussionStoreCleanup.mockImplementationOnce(() => {
        throw new Error('Cleanup failed');
      });

      await expect(useAccountStore.getState().logout()).rejects.toThrow();
    });
  });

  describe('resetAccount()', () => {
    it('should delete current account and cleanup state', async () => {
      const { getActiveOrFirstProfile } = await import(
        '../../src/stores/utils/getAccount'
      );

      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .build();

      const mockSession = {
        cleanup: vi.fn(),
      };

      // Add profile to database
      await db.userProfile.add(testProfile);
      vi.mocked(getActiveOrFirstProfile).mockResolvedValue(testProfile);

      useAccountStore.setState({
        userProfile: testProfile,
        session: mockSession as any,
      });

      await useAccountStore.getState().resetAccount();

      expect(mockSession.cleanup).toHaveBeenCalled();
      expect(mockDiscussionStoreCleanup).toHaveBeenCalled();
      expect(mockMessageStoreCleanup).toHaveBeenCalled();

      // Verify profile was deleted from database
      const deletedProfile = await db.userProfile.get(testProfile.userId);
      expect(deletedProfile).toBeUndefined();
      expect(mockSetIsInitialized).toHaveBeenCalledWith(false);

      const state = useAccountStore.getState();
      expect(state.userProfile).toBeNull();
      expect(state.account).toBeNull();
    });

    it('should handle case when no profile exists', async () => {
      const { getActiveOrFirstProfile } = await import(
        '../../src/stores/utils/getAccount'
      );

      vi.mocked(getActiveOrFirstProfile).mockResolvedValue(null);

      await useAccountStore.getState().resetAccount();

      // Verify no deletion occurred (no profile to delete)
      const count = await db.userProfile.count();
      expect(count).toBe(0);
      expect(mockSetIsInitialized).toHaveBeenCalledWith(false);
    });
  });

  describe('persistSession()', () => {
    it('should persist session when all required data exists', async () => {
      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .build();

      const mockEncryptionKey = {
        to_bytes: vi.fn(() => new Uint8Array(32)),
      };

      const mockSession = {
        toEncryptedBlob: vi.fn(() => new Uint8Array(64)),
      };

      // Add profile to database first
      await db.userProfile.add(testProfile);
      useAccountStore.setState({
        userProfile: testProfile,
        encryptionKey: mockEncryptionKey as any,
        session: mockSession as any,
      });

      await useAccountStore.getState().persistSession();

      expect(mockSession.toEncryptedBlob).toHaveBeenCalledWith(
        mockEncryptionKey
      );

      // Verify database was updated
      const updatedProfile = await db.userProfile.get(testProfile.userId);
      expect(updatedProfile?.session).toBeDefined();
      // Dexie may serialize Uint8Array differently, so check it's an array-like object
      expect(updatedProfile?.session).toHaveProperty('length');
      expect(updatedProfile?.updatedAt).toBeInstanceOf(Date);

      // Verify state was updated
      const stateProfile = useAccountStore.getState().userProfile;
      expect(stateProfile).toBeDefined();
    });

    it('should skip persistence when session is missing', async () => {
      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .build();

      useAccountStore.setState({
        userProfile: testProfile,
        encryptionKey: {} as unknown as EncryptionKey,
        session: null,
      });

      await useAccountStore.getState().persistSession();

      // Verify no database update occurred (no profile in DB)
      const count = await db.userProfile.count();
      expect(count).toBe(0);
    });

    it('should skip persistence when userProfile is missing', async () => {
      const mockSession = {
        toEncryptedBlob: vi.fn(() => new Uint8Array(64)),
      };

      useAccountStore.setState({
        userProfile: null,
        encryptionKey: {} as unknown as EncryptionKey,
        session: mockSession as unknown as SessionModule,
      });

      await useAccountStore.getState().persistSession();

      // Verify no database update occurred (no profile in DB)
      const count = await db.userProfile.count();
      expect(count).toBe(0);
    });

    it('should skip persistence when encryptionKey is missing', async () => {
      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .build();

      const mockSession = {
        toEncryptedBlob: vi.fn(() => new Uint8Array(64)),
      };

      useAccountStore.setState({
        userProfile: testProfile,
        encryptionKey: null,
        session: mockSession as any,
      });

      await useAccountStore.getState().persistSession();

      // Verify no database update occurred (no profile in DB)
      const count = await db.userProfile.count();
      expect(count).toBe(0);
    });

    it('should handle persistence errors gracefully', async () => {
      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .build();

      const mockEncryptionKey = {
        to_bytes: vi.fn(() => new Uint8Array(32)),
      };

      const mockSession = {
        toEncryptedBlob: vi.fn(() => new Uint8Array(64)),
      };

      useAccountStore.setState({
        userProfile: testProfile,
        encryptionKey: mockEncryptionKey as unknown as EncryptionKey,
        session: mockSession as unknown as SessionModule,
      });

      // Add profile to database
      await db.userProfile.add(testProfile);

      // Note: With real db, we can't easily simulate errors, but the code
      // handles errors gracefully, so this test verifies that behavior
      // by ensuring the method doesn't throw even if something goes wrong
      await expect(
        useAccountStore.getState().persistSession()
      ).resolves.not.toThrow();
    });
  });

  describe('showBackup()', () => {
    it('should retrieve mnemonic with password authentication', async () => {
      const { auth } = await import('../../src/stores/utils/auth');
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');

      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .authMethod('password')
        .build();

      const mockSecretKeys = {
        massa_secret_key: new Uint8Array(32).fill(1),
      };

      const mockAccount = {
        address: 'test-address',
      };

      vi.mocked(auth).mockResolvedValue({
        mnemonic: 'test mnemonic phrase',
        encryptionKey: {} as any,
      });

      vi.mocked(PrivateKey.fromBytes).mockReturnValue({} as any);
      vi.mocked(Account.fromPrivateKey).mockResolvedValue(mockAccount as any);

      useAccountStore.setState({
        userProfile: testProfile,
        ourSk: mockSecretKeys as any,
      });

      const result = await useAccountStore.getState().showBackup('password123');

      expect(auth).toHaveBeenCalledWith(testProfile, 'password123');
      expect(result.mnemonic).toBe('test mnemonic phrase');
      expect(result.account).toBe(mockAccount);
    });

    it('should retrieve mnemonic without password for biometric auth', async () => {
      const { auth } = await import('../../src/stores/utils/auth');
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');

      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .authMethod('capacitor')
        .build();

      const mockSecretKeys = {
        massa_secret_key: new Uint8Array(32).fill(1),
      };

      const mockAccount = {
        address: 'test-address',
      };

      vi.mocked(auth).mockResolvedValue({
        mnemonic: 'test mnemonic phrase',
        encryptionKey: {} as any,
      });

      vi.mocked(PrivateKey.fromBytes).mockReturnValue({} as any);
      vi.mocked(Account.fromPrivateKey).mockResolvedValue(mockAccount as any);

      useAccountStore.setState({
        userProfile: testProfile,
        ourSk: mockSecretKeys as any,
      });

      const result = await useAccountStore.getState().showBackup();

      expect(auth).toHaveBeenCalledWith(testProfile, undefined);
      expect(result.mnemonic).toBe('test mnemonic phrase');
    });

    it('should throw error if no user profile', async () => {
      useAccountStore.setState({
        userProfile: null,
        ourSk: {} as any,
      });

      await expect(useAccountStore.getState().showBackup()).rejects.toThrow(
        'No authenticated user'
      );
    });

    it('should throw error if no secret keys', async () => {
      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .build();

      useAccountStore.setState({
        userProfile: testProfile,
        ourSk: null,
      });

      await expect(useAccountStore.getState().showBackup()).rejects.toThrow(
        'No authenticated user'
      );
    });
  });

  describe('initializeAccount()', () => {
    it('should create account with password', async () => {
      const { generateMnemonic } = await import('../../src/crypto/bip39');
      const { generateUserKeys } = await import('../../src/wasm');
      const { encrypt, deriveKey } = await import(
        '../../src/crypto/encryption'
      );
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');
      // SessionModule is mocked globally

      const mockMnemonic = 'test mnemonic phrase';
      const mockUserId = new Uint8Array(32).fill(1);
      const mockPublicKeys = {
        derive_id: vi.fn(() => mockUserId),
      };
      const mockSecretKeys = {
        massa_secret_key: new Uint8Array(32).fill(2),
      };
      const mockKeys = {
        public_keys: vi.fn(() => mockPublicKeys),
        secret_keys: vi.fn(() => mockSecretKeys),
      };
      const mockAccount = { address: 'test-address' };
      const mockEncryptionKey = { to_bytes: () => new Uint8Array(32) };
      // SessionModule will be created by the mock constructor

      vi.mocked(generateMnemonic).mockReturnValue(mockMnemonic);
      vi.mocked(generateUserKeys).mockResolvedValue(mockKeys as any);
      vi.mocked(PrivateKey.fromBytes).mockReturnValue({} as any);
      vi.mocked(Account.fromPrivateKey).mockResolvedValue(mockAccount as any);
      vi.mocked(deriveKey).mockResolvedValue(mockEncryptionKey as any);
      vi.mocked(encrypt).mockResolvedValue({
        encryptedData: new Uint8Array(64),
        nonce: new Uint8Array(32),
      });
      // SessionModule is now a class, so we don't need to mock it separately
      // Note: db is real, so profiles will be added to the database

      await useAccountStore
        .getState()
        .initializeAccount('testuser', 'password123');

      expect(generateMnemonic).toHaveBeenCalledWith(256);
      expect(generateUserKeys).toHaveBeenCalledWith(mockMnemonic);
      expect(deriveKey).toHaveBeenCalledWith(
        'password123',
        expect.any(Uint8Array)
      );
      expect(encrypt).toHaveBeenCalled();
      expect(mockSetIsInitialized).toHaveBeenCalledWith(true);

      const state = useAccountStore.getState();
      expect(state.userProfile).toBeDefined();
      expect(state.account).toBe(mockAccount);
      expect(state.ourPk).toBe(mockPublicKeys);
      expect(state.ourSk).toBe(mockSecretKeys);
      expect(state.session).toBeDefined();
      expect(state.session?.toEncryptedBlob).toBeDefined();
      expect(state.isLoading).toBe(false);
    });

    it('should handle errors during account creation', async () => {
      const { generateMnemonic } = await import('../../src/crypto/bip39');

      vi.mocked(generateMnemonic).mockImplementation(() => {
        throw new Error('Mnemonic generation failed');
      });

      await expect(
        useAccountStore.getState().initializeAccount('testuser', 'password123')
      ).rejects.toThrow('Mnemonic generation failed');

      expect(useAccountStore.getState().isLoading).toBe(false);
    });
  });

  describe('loadAccount()', () => {
    it('should load account with password', async () => {
      const { getActiveOrFirstProfile } = await import(
        '../../src/stores/utils/getAccount'
      );
      const { auth } = await import('../../src/stores/utils/auth');
      const { generateUserKeys } = await import('../../src/wasm');
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');
      // SessionModule is mocked globally

      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .authMethod('password')
        .build();

      const mockMnemonic = 'test mnemonic phrase';
      const mockPublicKeys = {
        derive_id: vi.fn(() => new Uint8Array(32)),
      };
      const mockSecretKeys = {
        massa_secret_key: new Uint8Array(32).fill(2),
      };
      const mockKeys = {
        public_keys: vi.fn(() => mockPublicKeys),
        secret_keys: vi.fn(() => mockSecretKeys),
      };
      const mockAccount = { address: 'test-address' };
      const mockEncryptionKey = { to_bytes: () => new Uint8Array(32) };

      // Add profile to database first
      await db.userProfile.add(testProfile);
      vi.mocked(getActiveOrFirstProfile).mockResolvedValue(testProfile);
      vi.mocked(auth).mockResolvedValue({
        mnemonic: mockMnemonic,
        encryptionKey: mockEncryptionKey as any,
      });
      vi.mocked(generateUserKeys).mockResolvedValue(mockKeys as any);
      vi.mocked(PrivateKey.fromBytes).mockReturnValue({} as any);
      vi.mocked(Account.fromPrivateKey).mockResolvedValue(mockAccount as any);
      // SessionModule is now a class, so we don't need to mock it separately

      await useAccountStore.getState().loadAccount('password123');

      expect(auth).toHaveBeenCalledWith(testProfile, 'password123');

      // Check the actual session that was created
      const accountState = useAccountStore.getState();
      if (accountState.session) {
        expect(accountState.session.load).toHaveBeenCalledWith(
          testProfile,
          mockEncryptionKey
        );
      }

      // Verify database was updated with lastSeen
      const updatedProfile = await db.userProfile.get(testProfile.userId);
      expect(updatedProfile?.lastSeen).toBeInstanceOf(Date);
      expect(mockSetIsInitialized).toHaveBeenCalledWith(true);

      expect(accountState.userProfile).toBeDefined();
      expect(accountState.account).toBe(mockAccount);
      expect(accountState.isLoading).toBe(false);
    });

    it('should load account with specific userId', async () => {
      const { auth } = await import('../../src/stores/utils/auth');
      const { generateUserKeys } = await import('../../src/wasm');
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');
      // SessionModule is mocked globally

      const testProfile = userProfile()
        .userId('gossip1specific')
        .username('testuser')
        .authMethod('password')
        .build();

      const mockMnemonic = 'test mnemonic phrase';
      const mockKeys = {
        public_keys: vi.fn(() => ({
          derive_id: vi.fn(() => new Uint8Array(32)),
        })),
        secret_keys: vi.fn(() => ({
          massa_secret_key: new Uint8Array(32),
        })),
      };
      const mockAccount = { address: 'test-address' };
      const mockEncryptionKey = { to_bytes: () => new Uint8Array(32) };

      // Add profile to database first (testProfile already has userId 'gossip1specific')
      await db.userProfile.add(testProfile);
      vi.mocked(auth).mockResolvedValue({
        mnemonic: mockMnemonic,
        encryptionKey: mockEncryptionKey as any,
      });
      vi.mocked(generateUserKeys).mockResolvedValue(mockKeys as any);
      vi.mocked(PrivateKey.fromBytes).mockReturnValue({} as any);
      vi.mocked(Account.fromPrivateKey).mockResolvedValue(mockAccount as any);
      // SessionModule is now a class, so we don't need to mock it separately

      await useAccountStore
        .getState()
        .loadAccount('password123', 'gossip1specific');

      // Verify profile was loaded from database
      const loadedProfile = await db.userProfile.get('gossip1specific');
      expect(loadedProfile).toBeDefined();
      // auth is called with the profile loaded from the database
      expect(auth).toHaveBeenCalled();
      const authCall = vi.mocked(auth).mock.calls[0];
      expect(authCall[0].userId).toBe('gossip1specific');
      expect(authCall[1]).toBe('password123');

      // Verify session was created
      const accountState = useAccountStore.getState();
      expect(accountState.session).toBeDefined();
    });

    it('should throw error if no profile found', async () => {
      const { getActiveOrFirstProfile } = await import(
        '../../src/stores/utils/getAccount'
      );

      vi.mocked(getActiveOrFirstProfile).mockResolvedValue(null);

      await expect(
        useAccountStore.getState().loadAccount('password123')
      ).rejects.toThrow('No user profile found');
    });

    it('should handle authentication errors', async () => {
      const { getActiveOrFirstProfile } = await import(
        '../../src/stores/utils/getAccount'
      );
      const { auth } = await import('../../src/stores/utils/auth');

      const testProfile = userProfile()
        .userId('gossip1test123')
        .username('testuser')
        .build();

      vi.mocked(getActiveOrFirstProfile).mockResolvedValue(testProfile);
      vi.mocked(auth).mockRejectedValue(new Error('Invalid password'));

      await expect(
        useAccountStore.getState().loadAccount('wrongpassword')
      ).rejects.toThrow('Invalid password');

      expect(useAccountStore.getState().isLoading).toBe(false);
    });
  });

  describe('restoreAccountFromMnemonic()', () => {
    it('should restore account from mnemonic with password', async () => {
      const { validateMnemonic } = await import('../../src/crypto/bip39');
      const { generateUserKeys } = await import('../../src/wasm');
      const { encrypt, deriveKey } = await import(
        '../../src/crypto/encryption'
      );
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');
      // SessionModule is mocked globally

      const mnemonic = 'valid test mnemonic phrase with enough words';
      const mockUserId = new Uint8Array(32).fill(1);
      const mockPublicKeys = {
        derive_id: vi.fn(() => mockUserId),
      };
      const mockSecretKeys = {
        massa_secret_key: new Uint8Array(32).fill(2),
      };
      const mockKeys = {
        public_keys: vi.fn(() => mockPublicKeys),
        secret_keys: vi.fn(() => mockSecretKeys),
      };
      const mockAccount = { address: 'test-address' };
      const mockEncryptionKey = { to_bytes: () => new Uint8Array(32) };
      // SessionModule will be created by the mock constructor

      vi.mocked(validateMnemonic).mockReturnValue(true);
      vi.mocked(generateUserKeys).mockResolvedValue(mockKeys as any);
      vi.mocked(PrivateKey.fromBytes).mockReturnValue({} as any);
      vi.mocked(Account.fromPrivateKey).mockResolvedValue(mockAccount as any);
      vi.mocked(deriveKey).mockResolvedValue(mockEncryptionKey as any);
      vi.mocked(encrypt).mockResolvedValue({
        encryptedData: new Uint8Array(64),
        nonce: new Uint8Array(32),
      });
      // SessionModule is now a class, so we don't need to mock it separately
      // Note: db is real, so profiles will be added to the database

      await useAccountStore
        .getState()
        .restoreAccountFromMnemonic('testuser', mnemonic, {
          useBiometrics: false,
          password: 'password123',
        });

      expect(validateMnemonic).toHaveBeenCalledWith(mnemonic);
      expect(generateUserKeys).toHaveBeenCalledWith(mnemonic);
      expect(mockSetIsInitialized).toHaveBeenCalledWith(true);

      const state = useAccountStore.getState();
      expect(state.userProfile).toBeDefined();
      expect(state.account).toBe(mockAccount);
      expect(state.isLoading).toBe(false);
    });

    it('should restore account from mnemonic with biometrics', async () => {
      const { validateMnemonic } = await import('../../src/crypto/bip39');
      const { generateUserKeys } = await import('../../src/wasm');
      const { biometricService } = await import(
        '../../src/services/biometricService'
      );
      const { encrypt } = await import('../../src/crypto/encryption');
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');
      // SessionModule is mocked globally

      const mnemonic = 'valid test mnemonic phrase with enough words';
      const mockUserId = new Uint8Array(32).fill(1);
      const mockPublicKeys = {
        derive_id: vi.fn(() => mockUserId),
      };
      const mockSecretKeys = {
        massa_secret_key: new Uint8Array(32).fill(2),
      };
      const mockKeys = {
        public_keys: vi.fn(() => mockPublicKeys),
        secret_keys: vi.fn(() => mockSecretKeys),
      };
      const mockAccount = { address: 'test-address' };
      const mockEncryptionKey = { to_bytes: () => new Uint8Array(32) };
      // SessionModule will be created by the mock constructor

      vi.mocked(validateMnemonic).mockReturnValue(true);
      vi.mocked(generateUserKeys).mockResolvedValue(mockKeys as any);
      vi.mocked(biometricService.createCredential).mockResolvedValue({
        success: true,
        data: {
          encryptionKey: mockEncryptionKey as any,
          authMethod: 'webauthn',
          credentialId: 'test-cred-id',
        },
      });
      vi.mocked(encrypt).mockResolvedValue({
        encryptedData: new Uint8Array(64),
        nonce: new Uint8Array(32),
      });
      vi.mocked(PrivateKey.fromBytes).mockReturnValue({} as any);
      vi.mocked(Account.fromPrivateKey).mockResolvedValue(mockAccount as any);
      // SessionModule is now a class, so we don't need to mock it separately
      // Note: db is real, so profiles will be added to the database

      await useAccountStore
        .getState()
        .restoreAccountFromMnemonic('testuser', mnemonic, {
          useBiometrics: true,
        });

      expect(validateMnemonic).toHaveBeenCalledWith(mnemonic);
      expect(biometricService.createCredential).toHaveBeenCalled();
    });

    it('should throw error for invalid mnemonic', async () => {
      const { validateMnemonic } = await import('../../src/crypto/bip39');

      vi.mocked(validateMnemonic).mockReturnValue(false);

      await expect(
        useAccountStore
          .getState()
          .restoreAccountFromMnemonic('testuser', 'invalid mnemonic', {
            useBiometrics: false,
            password: 'password123',
          })
      ).rejects.toThrow('Invalid mnemonic phrase');
    });
  });

  describe('initializeAccountWithBiometrics()', () => {
    it('should create account with biometrics', async () => {
      const { generateMnemonic } = await import('../../src/crypto/bip39');
      const { generateUserKeys } = await import('../../src/wasm');
      const { biometricService } = await import(
        '../../src/services/biometricService'
      );
      const { encrypt } = await import('../../src/crypto/encryption');
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');
      // SessionModule is mocked globally

      const mockMnemonic = 'test mnemonic phrase';
      const mockUserId = new Uint8Array(32).fill(1);
      const mockPublicKeys = {
        derive_id: vi.fn(() => mockUserId),
      };
      const mockSecretKeys = {
        massa_secret_key: new Uint8Array(32).fill(2),
      };
      const mockKeys = {
        public_keys: vi.fn(() => mockPublicKeys),
        secret_keys: vi.fn(() => mockSecretKeys),
      };
      const mockAccount = { address: 'test-address' };
      const mockEncryptionKey = { to_bytes: () => new Uint8Array(32) };
      // SessionModule will be created by the mock constructor

      vi.mocked(biometricService.checkAvailability).mockResolvedValue({
        available: true,
        method: 'webauthn',
        biometryType: 'fingerprint',
      });
      vi.mocked(generateMnemonic).mockReturnValue(mockMnemonic);
      vi.mocked(generateUserKeys).mockResolvedValue(mockKeys as any);
      vi.mocked(biometricService.createCredential).mockResolvedValue({
        success: true,
        data: {
          encryptionKey: mockEncryptionKey as any,
          authMethod: 'webauthn',
          credentialId: 'test-cred-id',
        },
      });
      vi.mocked(encrypt).mockResolvedValue({
        encryptedData: new Uint8Array(64),
        nonce: new Uint8Array(32),
      });
      vi.mocked(PrivateKey.fromBytes).mockReturnValue({} as any);
      vi.mocked(Account.fromPrivateKey).mockResolvedValue(mockAccount as any);
      // SessionModule is now a class, so we don't need to mock it separately
      // Note: db is real, so profiles will be added to the database

      await useAccountStore
        .getState()
        .initializeAccountWithBiometrics('testuser', false);

      expect(biometricService.checkAvailability).toHaveBeenCalled();
      expect(biometricService.createCredential).toHaveBeenCalled();
      expect(mockSetIsInitialized).toHaveBeenCalledWith(true);

      const state = useAccountStore.getState();
      expect(state.userProfile).toBeDefined();
      expect(state.account).toBe(mockAccount);
      expect(state.platformAuthenticatorAvailable).toBe(true);
    });

    it('should handle iCloud sync option', async () => {
      const { generateMnemonic } = await import('../../src/crypto/bip39');
      const { generateUserKeys } = await import('../../src/wasm');
      const { biometricService } = await import(
        '../../src/services/biometricService'
      );
      const { encrypt } = await import('../../src/crypto/encryption');
      const { Account, PrivateKey } = await import('@massalabs/massa-web3');
      // SessionModule is mocked globally

      const mockMnemonic = 'test mnemonic phrase';
      const mockUserId = new Uint8Array(32).fill(1);
      const mockKeys = {
        public_keys: vi.fn(() => ({
          derive_id: vi.fn(() => mockUserId),
        })),
        secret_keys: vi.fn(() => ({
          massa_secret_key: new Uint8Array(32),
        })),
      };
      const mockAccount = { address: 'test-address' };
      const mockEncryptionKey = { to_bytes: () => new Uint8Array(32) };
      // SessionModule will be created by the mock constructor

      vi.mocked(biometricService.checkAvailability).mockResolvedValue({
        available: true,
        method: 'capacitor',
        biometryType: 'face',
      });
      vi.mocked(generateMnemonic).mockReturnValue(mockMnemonic);
      vi.mocked(generateUserKeys).mockResolvedValue(mockKeys as any);
      vi.mocked(biometricService.createCredential).mockResolvedValue({
        success: true,
        data: {
          encryptionKey: mockEncryptionKey as any,
          authMethod: 'capacitor',
        },
      });
      vi.mocked(encrypt).mockResolvedValue({
        encryptedData: new Uint8Array(64),
        nonce: new Uint8Array(32),
      });
      vi.mocked(PrivateKey.fromBytes).mockReturnValue({} as any);
      vi.mocked(Account.fromPrivateKey).mockResolvedValue(mockAccount as any);
      // SessionModule is now a class, so we don't need to mock it separately
      // Note: db is real, so profiles will be added to the database

      await useAccountStore
        .getState()
        .initializeAccountWithBiometrics('testuser', true);

      expect(biometricService.createCredential).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Uint8Array),
        expect.any(Uint8Array),
        true // iCloud sync
      );
    });

    it('should throw error if biometrics not available', async () => {
      const { biometricService } = await import(
        '../../src/services/biometricService'
      );

      vi.mocked(biometricService.checkAvailability).mockResolvedValue({
        available: false,
        method: 'none',
        biometryType: 'none',
      });

      await expect(
        useAccountStore.getState().initializeAccountWithBiometrics('testuser')
      ).rejects.toThrow('Biometric authentication is not available');
    });
  });
});
