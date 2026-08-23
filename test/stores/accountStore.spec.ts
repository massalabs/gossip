import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  IncompleteOnboardingSlotCleanupError,
  useAccountStore,
} from '../../src/stores/accountStore';
import { SecureStorageRecoveryRequiredError } from '@massalabs/gossip-sdk';
import type { Account } from '@massalabs/massa-web3';

// Shared spy so individual test suites can assert on it
const skipHistoricalSpy = vi.fn();
const authSpy = vi.hoisted(() => vi.fn());
const configureBiometricSpy = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({ secureAccountCreationAllowed: true }));
const derivedAccountKeys = vi.hoisted(() => [] as Uint8Array[]);

// Shared SDK mock factory — returns a superset used by all test suites
const makeSdkMock = () => ({
  isSessionOpen: false,
  isSecureStorage: false,
  storageState: 'locked',
  usesSessionBlobNamespace: false,
  closeSession: vi.fn(),
  clearAllTables: vi.fn(),
  secureStorageUnlock: vi.fn(async () => false),
  secureStorageLock: vi.fn(async () => {}),
  secureStorageCreate: vi.fn(async () => {}),
  secureStorageDestroy: vi.fn(async () => {}),
  openSession: vi.fn(async () => {}),
  startPublicKeyPublication: vi.fn(),
  getEncryptedSession: vi.fn(() => new Uint8Array(0)),
  readSessionBlob: vi.fn(async () => null),
  persistSessionBlob: vi.fn(async () => {}),
  userId: 'mock-user-id',
  publicKeys: {},
  queries: {},
  auth: {
    publishPublicKey: vi.fn(async () => {}),
  },
  profiles: {
    get: vi.fn(async () => null),
    getAll: vi.fn(async () => []),
    getCount: vi.fn(async () => 0),
    save: vi.fn(async () => {}),
    createOrUpdate: vi.fn(async () => ({
      userId: 'mock-user-id',
      username: 'testuser',
      security: { authMethod: 'password', encKeySalt: new Uint8Array(0) },
    })),
  },
  announcements: {
    skipHistorical: skipHistoricalSpy,
  },
});

// getSdk is a vi.fn() so individual suites can call mockReturnValue if needed
const getSdkMock = vi.fn(makeSdkMock);

function mockProfile(session = new Uint8Array([9, 9])) {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    userId: 'mock-user-id',
    username: 'testuser',
    security: {
      authMethod: 'password' as const,
      encKeySalt: new Uint8Array(0),
      mnemonicBackup: {
        encryptedMnemonic: new Uint8Array(0),
        createdAt: now,
        backedUp: false,
      },
    },
    session,
    status: 'online' as const,
    lastSeen: now,
    createdAt: now,
    updatedAt: now,
  };
}

// Mock getSdk to avoid real SDK initialization
vi.mock('../../src/stores/sdkStore', () => ({
  getSdk: () => getSdkMock(),
}));

// Simple spies for store cleanup functions – shared instances so we can assert call counts
const discussionCleanup = vi.fn();
const messageCleanup = vi.fn();
const selfClearMessages = vi.fn();

vi.mock('../../src/stores/discussionStore', () => ({
  useDiscussionStore: {
    getState: () => ({
      cleanup: discussionCleanup,
    }),
  },
}));

vi.mock('../../src/stores/messageStore', () => ({
  useMessageStore: {
    getState: () => ({
      cleanup: messageCleanup,
    }),
  },
}));

vi.mock('../../src/stores/selfMessageStore', () => ({
  useSelfMessageStore: {
    getState: () => ({
      clearMessages: selfClearMessages,
    }),
  },
}));

// ── Mocks needed by initializeAccount ──

vi.mock('@massalabs/gossip-sdk', async () => {
  const actual = await vi.importActual<typeof import('@massalabs/gossip-sdk')>(
    '@massalabs/gossip-sdk'
  );
  return {
    ...actual,
    generateMnemonic: vi.fn(() => 'word '.repeat(24).trim()),
    validateMnemonic: vi.fn(() => true),
    generateUserKeys: vi.fn(async () => ({
      secret_keys: () => ({
        massa_secret_key: new Uint8Array(32),
        free: vi.fn(),
      }),
      public_keys: () => ({
        derive_id: () => new Uint8Array(32),
        free: vi.fn(),
      }),
      free: vi.fn(),
      evm_address: () => '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
      massa_address: () =>
        'AU1CKrPb3a1Aj3JJkeTuHJoMswGVDSdgg1ynK7QMMMKHVYjinBfq',
    })),
    encodeUserId: vi.fn(() => 'mock-user-id'),
    generateNonce: vi.fn(async () => ({
      to_bytes: () => new Uint8Array(16),
    })),
    deriveKey: vi.fn(async () => ({
      type: 'mock-key',
      __wbg_ptr: 1,
      free: vi.fn(),
    })),
    encrypt: vi.fn(async () => ({ encryptedData: new Uint8Array(0) })),
  };
});

vi.mock('../../src/utils/validation', () => ({
  validateUsernameFormat: vi.fn(() => ({ valid: true })),
}));

vi.mock('@massalabs/massa-web3', async () => {
  const actual = await vi.importActual<typeof import('@massalabs/massa-web3')>(
    '@massalabs/massa-web3'
  );
  return {
    ...actual,
    Account: {
      fromPrivateKey: vi.fn(async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        derivedAccountKeys.push(bytes);
        return {
          address: { toString: () => 'AU1mock' },
          privateKey: { toBytes: () => bytes, toString: () => 'P1test' },
        };
      }),
    },
    PrivateKey: {
      fromBytes: vi.fn(() => ({})),
    },
  };
});

vi.mock('../../src/crypto/webauthn', () => ({
  isWebAuthnSupported: vi.fn(() => false),
}));

vi.mock('../../src/services/biometricService', () => ({
  configureBiometricLogin: configureBiometricSpy,
}));

vi.mock('../../src/stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      mnsEnabled: false,
      secureAccountCreationAllowed: appState.secureAccountCreationAllowed,
      setIsInitialized: vi.fn(),
      fetchMnsDomains: vi.fn(async () => {}),
      networkName: 'mainnet',
    }),
  },
}));

vi.mock('../../src/stores/utils/getAccount', () => ({
  getActiveOrFirstProfile: vi.fn(async () => null),
}));

vi.mock('../../src/stores/utils/auth', () => ({
  auth: authSpy,
  createPasswordSecurity: vi.fn(async () => ({
    security: {
      authMethod: 'password',
      encKeySalt: new Uint8Array(16),
      mnemonicBackup: {
        encryptedMnemonic: new Uint8Array(0),
        createdAt: new Date(),
        backedUp: false,
      },
    },
    encryptionKey: {
      type: 'mock-key',
      __wbg_ptr: 1,
      free: vi.fn(),
    },
  })),
}));

beforeEach(() => {
  derivedAccountKeys.length = 0;
});

describe('AccountStore classic password discovery', () => {
  beforeEach(() => {
    getSdkMock.mockImplementation(makeSdkMock);
    authSpy.mockReset();
    useAccountStore.setState({
      userProfile: null,
      encryptionKey: null,
      isLoading: false,
    });
  });

  afterEach(() => {
    useAccountStore.setState({
      userProfile: null,
      encryptionKey: null,
      isLoading: false,
    });
  });

  it('rejects duplicate passwords that would make discovery ambiguous', async () => {
    const sdk = makeSdkMock();
    const free = vi.fn();
    sdk.storageState = 'unlocked';
    sdk.profiles.getAll.mockResolvedValue([mockProfile()]);
    getSdkMock.mockReturnValue(sdk);
    authSpy.mockResolvedValue({
      mnemonic: 'word '.repeat(24).trim(),
      encryptionKey: { __wbg_ptr: 1, free },
    });

    await expect(
      useAccountStore.getState().initializeAccount('second', 'shared-password')
    ).rejects.toThrow('Password already in use by another account');

    expect(free).toHaveBeenCalledOnce();
    expect(sdk.openSession).not.toHaveBeenCalled();
  });

  it('probes profiles when a global biometric password has no user ID', async () => {
    const first = mockProfile();
    const second = {
      ...mockProfile(),
      userId: 'second-user-id',
      username: 'second',
    };
    const encryptionKey = { type: 'mock-key' };
    const sdk = makeSdkMock();
    sdk.storageState = 'unlocked';
    sdk.profiles.getAll.mockResolvedValue([first, second]);
    getSdkMock.mockReturnValue(sdk);
    authSpy
      .mockRejectedValueOnce(new Error('wrong profile'))
      .mockResolvedValueOnce({
        mnemonic: 'word '.repeat(24).trim(),
        encryptionKey,
      });

    await useAccountStore.getState().loadAccount({
      type: 'password',
      password: 'global-password',
    });

    expect(authSpy).toHaveBeenNthCalledWith(1, first, 'global-password');
    expect(authSpy).toHaveBeenNthCalledWith(2, second, 'global-password');
    expect(useAccountStore.getState().userProfile?.userId).toBe(
      'second-user-id'
    );
    expect(sdk.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ publishPublicKey: false })
    );
    expect(sdk.startPublicKeyPublication).toHaveBeenCalledOnce();
  });

  it('frees caller-owned keys and derived accounts before session open', async () => {
    const sdk = makeSdkMock();
    const encryptionKey = { __wbg_ptr: 1, free: vi.fn() };
    sdk.storageState = 'unlocked';
    sdk.usesSessionBlobNamespace = true;
    sdk.profiles.get.mockResolvedValue(mockProfile());
    sdk.readSessionBlob.mockRejectedValue(new Error('blob read failed'));
    getSdkMock.mockReturnValue(sdk);
    authSpy.mockResolvedValue({
      mnemonic: 'word '.repeat(24).trim(),
      encryptionKey,
    });

    await expect(
      useAccountStore.getState().loadAccount({
        type: 'password',
        password: 'account-password',
        userId: 'mock-user-id',
      })
    ).rejects.toThrow('blob read failed');

    expect(encryptionKey.free).toHaveBeenCalledOnce();
    expect(derivedAccountKeys.at(-1)?.every(byte => byte === 0)).toBe(true);
  });

  it('frees caller-owned keys when SDK session opening rejects', async () => {
    const sdk = makeSdkMock();
    const encryptionKey = { __wbg_ptr: 1, free: vi.fn() };
    sdk.storageState = 'unlocked';
    sdk.profiles.get.mockResolvedValue(mockProfile());
    sdk.openSession.mockRejectedValue(new Error('open failed'));
    getSdkMock.mockReturnValue(sdk);
    authSpy.mockResolvedValue({
      mnemonic: 'word '.repeat(24).trim(),
      encryptionKey,
    });

    await expect(
      useAccountStore.getState().loadAccount({
        type: 'password',
        password: 'account-password',
        userId: 'mock-user-id',
      })
    ).rejects.toThrow('open failed');

    expect(encryptionKey.free).toHaveBeenCalledOnce();
    expect(derivedAccountKeys.at(-1)?.every(byte => byte === 0)).toBe(true);
  });

  it('closes SDK-owned keys when finalization fails after session open', async () => {
    const sdk = makeSdkMock();
    const encryptionKey = { __wbg_ptr: 1, free: vi.fn() };
    sdk.storageState = 'unlocked';
    sdk.profiles.get.mockResolvedValue(mockProfile());
    sdk.openSession.mockImplementation(async () => {
      sdk.isSessionOpen = true;
    });
    sdk.profiles.save.mockRejectedValue(new Error('profile save failed'));
    sdk.closeSession.mockImplementation(async () => {
      sdk.isSessionOpen = false;
      encryptionKey.free();
    });
    getSdkMock.mockReturnValue(sdk);
    authSpy.mockResolvedValue({
      mnemonic: 'word '.repeat(24).trim(),
      encryptionKey,
    });

    await expect(
      useAccountStore.getState().loadAccount({
        type: 'password',
        password: 'account-password',
        userId: 'mock-user-id',
      })
    ).rejects.toThrow('profile save failed');

    expect(sdk.closeSession).toHaveBeenCalledOnce();
    expect(encryptionKey.free).toHaveBeenCalledOnce();
    expect(derivedAccountKeys.at(-1)?.every(byte => byte === 0)).toBe(true);
  });
});

describe('AccountStore biometric settings', () => {
  beforeEach(() => {
    authSpy.mockReset();
    configureBiometricSpy.mockReset();
    configureBiometricSpy.mockResolvedValue({ success: true });
    getSdkMock.mockImplementation(makeSdkMock);
    useAccountStore.setState({
      userProfile: null,
      encryptionKey: null,
      isLoading: false,
    });
  });

  afterEach(() => {
    useAccountStore.setState({
      userProfile: null,
      encryptionKey: null,
      isLoading: false,
    });
  });

  it('verifies the active account password before replacing biometrics', async () => {
    const sdk = makeSdkMock();
    const profile = mockProfile();
    const free = vi.fn();
    sdk.isSessionOpen = true;
    getSdkMock.mockReturnValue(sdk);
    useAccountStore.setState({ userProfile: profile });
    authSpy.mockResolvedValue({
      mnemonic: 'word '.repeat(24).trim(),
      encryptionKey: { __wbg_ptr: 1, free },
    });

    await useAccountStore
      .getState()
      .configureBiometricLogin('current-password', true);

    expect(authSpy).toHaveBeenCalledWith(profile, 'current-password');
    expect(free).toHaveBeenCalledOnce();
    expect(configureBiometricSpy).toHaveBeenCalledWith(
      'current-password',
      true
    );
  });

  it('does not replace biometrics when password verification fails', async () => {
    const sdk = makeSdkMock();
    sdk.isSessionOpen = true;
    getSdkMock.mockReturnValue(sdk);
    useAccountStore.setState({ userProfile: mockProfile() });
    authSpy.mockRejectedValue(new Error('Authentication failed'));

    await expect(
      useAccountStore.getState().configureBiometricLogin('wrong-password')
    ).rejects.toThrow('Authentication failed');

    expect(configureBiometricSpy).not.toHaveBeenCalled();
  });

  it('serializes and wipes the temporary backup account key', async () => {
    const sdk = makeSdkMock();
    const encryptionFree = vi.fn();
    sdk.isSessionOpen = true;
    getSdkMock.mockReturnValue(sdk);
    useAccountStore.setState({ userProfile: mockProfile() });
    authSpy.mockResolvedValue({
      mnemonic: 'word '.repeat(24).trim(),
      encryptionKey: { __wbg_ptr: 1, free: encryptionFree },
    });

    const backup = await useAccountStore
      .getState()
      .showBackup('account-password');

    expect(backup.privateKey).toBe('P1test');
    expect(encryptionFree).toHaveBeenCalledOnce();
    expect(derivedAccountKeys.at(-1)?.every(byte => byte === 0)).toBe(true);
  });
});

describe('AccountStore session cleanup', () => {
  beforeEach(() => {
    discussionCleanup.mockClear();
    messageCleanup.mockClear();
    selfClearMessages.mockClear();
  });

  it('wipes the active Massa signing key on logout', async () => {
    const privateKeyBytes = new Uint8Array([7, 8, 9]);
    getSdkMock.mockImplementation(makeSdkMock);
    useAccountStore.setState({
      account: {
        privateKey: { toBytes: () => privateKeyBytes },
      } as unknown as Account,
    });

    await useAccountStore.getState().logout();

    expect(Array.from(privateKeyBytes)).toEqual([0, 0, 0]);
    expect(useAccountStore.getState().account).toBeNull();
  });

  it('clears discussion, message, and selfMessage stores on logout', async () => {
    const logout = useAccountStore.getState().logout;
    await logout();

    expect(discussionCleanup).toHaveBeenCalledTimes(1);
    expect(messageCleanup).toHaveBeenCalledTimes(1);
    expect(selfClearMessages).toHaveBeenCalledTimes(1);
  });

  it('clears discussion, message, and selfMessage stores on resetAccount', async () => {
    const resetAccount = useAccountStore.getState().resetAccount;
    await resetAccount();

    expect(discussionCleanup).toHaveBeenCalledTimes(1);
    expect(messageCleanup).toHaveBeenCalledTimes(1);
    expect(selfClearMessages).toHaveBeenCalledTimes(1);
  });
});

describe('AccountStore logout lockedByUser', () => {
  it('sets lockedByUser to true by default (manual lock)', async () => {
    await useAccountStore.getState().logout();

    expect(useAccountStore.getState().lockedByUser).toBe(true);
  });

  it('sets lockedByUser to false when explicitly passed (auto-lock)', async () => {
    await useAccountStore.getState().logout({ lockedByUser: false });

    expect(useAccountStore.getState().lockedByUser).toBe(false);
  });

  it('sets lockedByUser to true when explicitly passed', async () => {
    await useAccountStore.getState().logout({ lockedByUser: true });

    expect(useAccountStore.getState().lockedByUser).toBe(true);
  });
});

describe('AccountStore skipHistorical behavior', () => {
  beforeEach(() => {
    skipHistoricalSpy.mockClear();
    authSpy.mockResolvedValue({
      mnemonic: 'word '.repeat(24).trim(),
      encryptionKey: {},
    });
    getSdkMock.mockImplementation(makeSdkMock);
  });

  it('initializeAccount calls skipHistorical()', async () => {
    await useAccountStore
      .getState()
      .initializeAccount('testuser', 'password123');

    expect(skipHistoricalSpy).toHaveBeenCalledTimes(1);
  });
});

describe('AccountStore secure-storage account provisioning', () => {
  beforeEach(() => {
    authSpy.mockReset();
    appState.secureAccountCreationAllowed = true;
    getSdkMock.mockImplementation(makeSdkMock);
    useAccountStore.setState({
      userProfile: null,
      encryptionKey: null,
      isLoading: false,
    });
  });

  it('persists a prepared session without publishing its tentative key', async () => {
    const sdk = makeSdkMock();
    const mnemonic = 'word '.repeat(24).trim();
    const encryptedSession = new Uint8Array([4, 5, 6]);
    const encryptionKey = { __wbg_ptr: 1, free: vi.fn() };
    const prepared = {
      mnemonicBytes: new TextEncoder().encode(mnemonic),
      security: mockProfile().security,
      encryptedSession,
    };
    authSpy.mockResolvedValue({ mnemonic, encryptionKey });
    sdk.isSecureStorage = true;
    sdk.storageState = 'empty';
    sdk.secureStorageCreate.mockImplementation(async () => {
      sdk.storageState = 'unlocked';
    });
    sdk.openSession.mockImplementation(async () => {
      sdk.isSessionOpen = true;
    });
    getSdkMock.mockReturnValue(sdk);

    try {
      await useAccountStore
        .getState()
        .initializePreparedAccount('alice', 'alice-password', prepared);
      await Promise.resolve();

      expect(sdk.openSession).toHaveBeenCalledWith(
        expect.objectContaining({
          mnemonic,
          encryptedSession,
          encryptionKey,
          publishPublicKey: false,
        })
      );
      expect(sdk.auth.publishPublicKey).not.toHaveBeenCalled();
    } finally {
      await useAccountStore.getState().logout();
    }
  });

  it('retains the in-flight password when rejected creation cleanup is unproved', async () => {
    const sdk = makeSdkMock();
    sdk.isSecureStorage = true;
    sdk.storageState = 'empty';
    sdk.secureStorageCreate.mockImplementation(async () => {
      sdk.storageState = 'unlocked';
      throw new SecureStorageRecoveryRequiredError(
        new Error('create recovery failed')
      );
    });
    sdk.secureStorageDestroy.mockRejectedValue(new Error('destroy failed'));
    getSdkMock.mockReturnValue(sdk);

    await expect(
      useAccountStore.getState().initializeAccount('alice', 'alice-password')
    ).rejects.toBeInstanceOf(IncompleteOnboardingSlotCleanupError);
    expect(sdk.secureStorageDestroy).toHaveBeenCalledOnce();
  });

  it('does not overwrite hidden slots without a first-install creation grant', async () => {
    const sdk = makeSdkMock();
    sdk.isSecureStorage = true;
    sdk.storageState = 'locked';
    appState.secureAccountCreationAllowed = false;
    getSdkMock.mockReturnValue(sdk);

    await expect(
      useAccountStore.getState().initializeAccount('alice', 'alice-password')
    ).rejects.toThrow('Secure account creation is not currently authorized');
    expect(sdk.secureStorageCreate).not.toHaveBeenCalled();
  });

  it('destroys every committed batch account in reverse order', async () => {
    const sdk = makeSdkMock();
    sdk.isSecureStorage = true;
    sdk.storageState = 'locked';
    sdk.secureStorageUnlock.mockResolvedValue(true);
    getSdkMock.mockReturnValue(sdk);

    const result = await useAccountStore
      .getState()
      .rollbackInitializedAccounts(['alice-password', 'decoy-password']);

    expect(result).toEqual({ failedPasswordIndexes: [], lockFailed: false });

    expect(sdk.secureStorageUnlock.mock.calls).toEqual([
      ['decoy-password'],
      ['alice-password'],
    ]);
    expect(sdk.secureStorageDestroy).toHaveBeenCalledTimes(2);
    expect(useAccountStore.getState().userProfile).toBeNull();
  });

  it('treats an undiscoverable batch password as already rolled back', async () => {
    const sdk = makeSdkMock();
    sdk.isSecureStorage = true;
    sdk.storageState = 'locked';
    sdk.secureStorageUnlock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    getSdkMock.mockReturnValue(sdk);

    const result = await useAccountStore
      .getState()
      .rollbackInitializedAccounts(['alice-password', 'decoy-password']);

    expect(result).toEqual({
      failedPasswordIndexes: [],
      lockFailed: false,
    });

    expect(sdk.secureStorageUnlock.mock.calls).toEqual([
      ['decoy-password'],
      ['alice-password'],
    ]);
    expect(sdk.secureStorageDestroy).toHaveBeenCalledOnce();
  });

  it('allocates all onboarding accounts to distinct secure-storage slots', async () => {
    const sdk = makeSdkMock();
    const allocations: Array<{ slot: number; password: string }> = [];
    sdk.isSecureStorage = true;
    sdk.storageState = 'empty';
    sdk.secureStorageCreate.mockImplementation(async (slot, password) => {
      allocations.push({ slot, password });
      sdk.storageState = 'unlocked';
    });
    sdk.openSession.mockImplementation(async () => {
      sdk.isSessionOpen = true;
    });
    sdk.closeSession.mockImplementation(async () => {
      sdk.isSessionOpen = false;
    });
    sdk.secureStorageLock.mockImplementation(async () => {
      sdk.storageState = 'locked';
    });
    getSdkMock.mockReturnValue(sdk);

    try {
      await useAccountStore
        .getState()
        .initializeAccount('alice', 'alice-password');
      await useAccountStore
        .getState()
        .initializeAccount('decoy', 'decoy-password');
      await useAccountStore
        .getState()
        .initializeAccount('backup', 'backup-password');

      expect(allocations.map(({ slot }) => slot).sort()).toEqual([0, 1, 2]);
      expect(allocations.map(({ password }) => password)).toEqual([
        'alice-password',
        'decoy-password',
        'backup-password',
      ]);
      expect(sdk.secureStorageLock).toHaveBeenCalledTimes(2);
    } finally {
      await useAccountStore.getState().logout();
    }
  });

  it('marks the in-flight slot for recovery when immediate cleanup fails', async () => {
    const sdk = makeSdkMock();
    sdk.isSecureStorage = true;
    sdk.storageState = 'empty';
    sdk.secureStorageCreate.mockImplementation(async () => {
      sdk.storageState = 'unlocked';
    });
    sdk.openSession.mockImplementation(async () => {
      sdk.isSessionOpen = true;
    });
    sdk.profiles.createOrUpdate.mockRejectedValue(
      new Error('profile persistence failed')
    );
    sdk.closeSession.mockRejectedValue(new Error('close failed'));
    getSdkMock.mockReturnValue(sdk);

    await expect(
      useAccountStore.getState().initializeAccount('alice', 'alice-password')
    ).rejects.toBeInstanceOf(IncompleteOnboardingSlotCleanupError);

    expect(sdk.secureStorageDestroy).not.toHaveBeenCalled();
    expect(sdk.storageState).toBe('unlocked');

    sdk.closeSession.mockImplementation(async () => {
      sdk.isSessionOpen = false;
    });
    sdk.secureStorageLock.mockImplementation(async () => {
      sdk.storageState = 'locked';
    });
    sdk.secureStorageUnlock.mockImplementation(async () => {
      sdk.storageState = 'unlocked';
      return true;
    });
    sdk.secureStorageDestroy.mockImplementation(async () => {
      sdk.storageState = 'locked';
    });
    await useAccountStore
      .getState()
      .rollbackInitializedAccounts(['alice-password']);
  });

  it('marks the in-flight slot for recovery when immediate destroy fails', async () => {
    const sdk = makeSdkMock();
    sdk.isSecureStorage = true;
    sdk.storageState = 'empty';
    sdk.secureStorageCreate.mockImplementation(async () => {
      sdk.storageState = 'unlocked';
    });
    sdk.openSession.mockImplementation(async () => {
      sdk.isSessionOpen = true;
    });
    sdk.profiles.createOrUpdate.mockRejectedValue(
      new Error('profile persistence failed')
    );
    sdk.closeSession.mockImplementation(async () => {
      sdk.isSessionOpen = false;
    });
    sdk.secureStorageDestroy.mockRejectedValue(new Error('destroy failed'));
    sdk.secureStorageLock.mockImplementation(async () => {
      sdk.storageState = 'locked';
    });
    getSdkMock.mockReturnValue(sdk);

    await expect(
      useAccountStore.getState().initializeAccount('alice', 'alice-password')
    ).rejects.toBeInstanceOf(IncompleteOnboardingSlotCleanupError);

    expect(sdk.secureStorageDestroy).toHaveBeenCalledOnce();

    sdk.secureStorageUnlock.mockImplementation(async () => {
      sdk.storageState = 'unlocked';
      return true;
    });
    sdk.secureStorageDestroy.mockImplementation(async () => {
      sdk.storageState = 'locked';
    });
    await useAccountStore
      .getState()
      .rollbackInitializedAccounts(['alice-password']);
  });

  it('releases a slot after post-open persistence failure so retry can reuse it', async () => {
    const sdk = makeSdkMock();
    const allocatedSlots: number[] = [];
    const randomSpy = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array[0] = 0;
        return array;
      });
    sdk.isSecureStorage = true;
    sdk.storageState = 'empty';
    sdk.secureStorageCreate.mockImplementation(async slot => {
      allocatedSlots.push(slot);
      sdk.storageState = 'unlocked';
    });
    sdk.openSession.mockImplementation(async () => {
      sdk.isSessionOpen = true;
    });
    sdk.closeSession.mockImplementation(async () => {
      sdk.isSessionOpen = false;
    });
    sdk.secureStorageDestroy.mockImplementation(async () => {
      sdk.storageState = 'locked';
    });
    sdk.secureStorageLock.mockImplementation(async () => {
      sdk.storageState = 'locked';
    });
    sdk.profiles.createOrUpdate
      .mockRejectedValueOnce(new Error('profile persistence failed'))
      .mockResolvedValueOnce(mockProfile());
    getSdkMock.mockReturnValue(sdk);

    try {
      await expect(
        useAccountStore.getState().initializeAccount('alice', 'alice-password')
      ).rejects.toThrow('profile persistence failed');

      expect(sdk.closeSession).toHaveBeenCalledOnce();
      expect(sdk.secureStorageDestroy).toHaveBeenCalledOnce();
      expect(sdk.closeSession.mock.invocationCallOrder[0]).toBeLessThan(
        sdk.secureStorageDestroy.mock.invocationCallOrder[0]
      );
      expect(sdk.storageState).toBe('locked');

      await useAccountStore
        .getState()
        .initializeAccount('alice', 'alice-password');

      expect(allocatedSlots).toEqual([0, 0]);
      expect(sdk.profiles.createOrUpdate).toHaveBeenCalledTimes(2);
    } finally {
      randomSpy.mockRestore();
      await useAccountStore.getState().logout();
    }
  });

  it('destroys a newly allocated slot when account persistence fails', async () => {
    const sdk = makeSdkMock();
    sdk.isSecureStorage = true;
    sdk.storageState = 'empty';
    sdk.secureStorageCreate.mockImplementation(async () => {
      sdk.storageState = 'unlocked';
    });
    sdk.secureStorageDestroy.mockImplementation(async () => {
      sdk.storageState = 'locked';
    });
    sdk.openSession.mockRejectedValue(new Error('session setup failed'));
    getSdkMock.mockReturnValue(sdk);

    await expect(
      useAccountStore.getState().initializeAccount('testuser', 'password123')
    ).rejects.toThrow('session setup failed');

    expect(sdk.secureStorageCreate).toHaveBeenCalledOnce();
    expect(sdk.secureStorageDestroy).toHaveBeenCalledOnce();
    expect(derivedAccountKeys.at(-1)?.every(byte => byte === 0)).toBe(true);
  });
});

describe('AccountStore secure-storage session persistence', () => {
  beforeEach(() => {
    getSdkMock.mockImplementation(makeSdkMock);
    useAccountStore.setState({
      userProfile: null,
      encryptionKey: null,
      isLoading: false,
    });
  });

  it('routes manual session persistence through namespace without saving SQL profile', async () => {
    const sdk = makeSdkMock();
    const originalSession = new Uint8Array([7, 7]);
    const sessionBlob = new Uint8Array([1, 2, 3]);
    sdk.isSessionOpen = true;
    sdk.usesSessionBlobNamespace = true;
    sdk.getEncryptedSession.mockReturnValue(sessionBlob);
    getSdkMock.mockReturnValue(sdk);

    useAccountStore.setState({ userProfile: mockProfile(originalSession) });

    await useAccountStore.getState().persistSession();

    expect(sdk.persistSessionBlob).toHaveBeenCalledWith(sessionBlob);
    expect(sdk.profiles.save).not.toHaveBeenCalled();
    expect(useAccountStore.getState().userProfile?.session).toBe(
      originalSession
    );
  });
});
