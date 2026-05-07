import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAccountStore } from '../../src/stores/accountStore';

// Shared spy so individual test suites can assert on it
const skipHistoricalSpy = vi.fn();
const hasExistingCredentialSpy = vi.hoisted(() => vi.fn(async () => false));

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
  openSession: vi.fn(async () => {}),
  getEncryptedSession: vi.fn(() => new Uint8Array(0)),
  persistSessionBlob: vi.fn(async () => {}),
  userId: 'mock-user-id',
  publicKeys: {},
  queries: {},
  auth: {
    publishPublicKey: vi.fn(async () => {}),
  },
  profiles: {
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
      cleanup: selfClearMessages,
    }),
  },
}));

// ── Mocks needed by initializeAccount / restoreAccountFromMnemonic / initializeAccountWithBiometrics ──

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
      }),
      public_keys: () => ({
        derive_id: () => new Uint8Array(32),
      }),
      evm_address: () => '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
      massa_address: () =>
        'AU1CKrPb3a1Aj3JJkeTuHJoMswGVDSdgg1ynK7QMMMKHVYjinBfq',
    })),
    encodeUserId: vi.fn(() => 'mock-user-id'),
    generateNonce: vi.fn(async () => ({
      to_bytes: () => new Uint8Array(16),
    })),
    deriveKey: vi.fn(async () => ({ type: 'mock-key' })),
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
      fromPrivateKey: vi.fn(async () => ({
        address: { toString: () => 'AU1mock' },
      })),
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
  checkBiometricAvailability: vi.fn(async () => ({
    available: true,
    biometryType: 'none',
  })),
  createCredential: vi.fn(async () => ({
    success: true,
    data: {
      credentialId: 'mock-cred-id',
      encryptionKey: {
        type: 'mock-key',
        to_bytes: vi.fn(() => new Uint8Array([1, 2, 3])),
      },
      authMethod: 'webauthn',
    },
  })),
  hasExistingCredential: hasExistingCredentialSpy,
}));

vi.mock('../../src/stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      mnsEnabled: false,
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
  auth: vi.fn(async () => ({
    mnemonic: 'word '.repeat(24).trim(),
    encryptionKey: {},
  })),
}));

describe('AccountStore session cleanup', () => {
  beforeEach(() => {
    discussionCleanup.mockClear();
    messageCleanup.mockClear();
    selfClearMessages.mockClear();
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
    getSdkMock.mockImplementation(makeSdkMock);
  });

  it('initializeAccount calls skipHistorical()', async () => {
    await useAccountStore
      .getState()
      .initializeAccount('testuser', 'password123');

    expect(skipHistoricalSpy).toHaveBeenCalledTimes(1);
  });

  it('restoreAccountFromMnemonic does NOT call skipHistorical()', async () => {
    await useAccountStore
      .getState()
      .restoreAccountFromMnemonic('testuser', 'word '.repeat(24).trim(), {
        useBiometrics: false,
        password: 'password123',
      });

    expect(skipHistoricalSpy).not.toHaveBeenCalled();
  });

  it('initializeAccountWithBiometrics calls skipHistorical()', async () => {
    await useAccountStore
      .getState()
      .initializeAccountWithBiometrics('testuser');

    expect(skipHistoricalSpy).toHaveBeenCalledTimes(1);
  });
});

describe('AccountStore secure-storage biometric singleton', () => {
  beforeEach(() => {
    hasExistingCredentialSpy.mockReset();
    hasExistingCredentialSpy.mockResolvedValue(false);
    getSdkMock.mockImplementation(makeSdkMock);
    useAccountStore.setState({
      userProfile: null,
      encryptionKey: null,
      isLoading: false,
    });
  });

  it('rejects a second biometric secure-storage account', async () => {
    const sdk = makeSdkMock();
    sdk.isSecureStorage = true;
    sdk.storageState = 'locked';
    getSdkMock.mockReturnValue(sdk);
    hasExistingCredentialSpy.mockResolvedValue(true);

    await expect(
      useAccountStore.getState().initializeAccountWithBiometrics('testuser')
    ).rejects.toThrow('Only one biometric secure-storage account is allowed');

    expect(sdk.secureStorageCreate).not.toHaveBeenCalled();
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
