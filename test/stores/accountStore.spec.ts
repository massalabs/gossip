import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAccountStore } from '../../src/stores/accountStore';

// Shared spy so individual test suites can assert on it
const skipHistoricalSpy = vi.fn();

// Shared SDK mock factory — returns a superset used by all test suites
const makeSdkMock = () => ({
  isSessionOpen: false,
  closeSession: vi.fn(),
  clearAllTables: vi.fn(),
  openSession: vi.fn(async () => {}),
  getEncryptedSession: vi.fn(() => new Uint8Array(0)),
  userId: 'mock-user-id',
  profiles: {
    getCount: vi.fn(async () => 0),
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

// Mock getSdk to avoid real SDK initialization
vi.mock('../../src/stores/sdkStore', () => ({
  getSdk: (...args: unknown[]) => getSdkMock(...args),
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
    })),
    encodeUserId: vi.fn(() => 'mock-user-id'),
    generateNonce: vi.fn(async () => ({
      to_bytes: () => new Uint8Array(16),
    })),
    deriveKey: vi.fn(async () => ({ type: 'mock-key' })),
    encrypt: vi.fn(async () => ({ encryptedData: new Uint8Array(0) })),
    validateUsernameFormat: vi.fn(() => ({ valid: true })),
  };
});

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
  biometricService: {
    checkAvailability: vi.fn(async () => ({
      available: true,
      biometryType: 'none',
    })),
    createCredential: vi.fn(async () => ({
      success: true,
      data: {
        credentialId: 'mock-cred-id',
        encryptionKey: { type: 'mock-key' },
        authMethod: 'webauthn',
      },
    })),
  },
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
