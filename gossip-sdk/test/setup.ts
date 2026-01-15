/**
 * SDK Test Setup File
 *
 * This file runs before all SDK tests and sets up:
 * - fake-indexeddb for Dexie/IndexedDB testing in Node
 * - Global test utilities and mocks
 * - Mocks for platform-specific modules (biometrics, notifications, etc.)
 * - Real WASM modules loaded from filesystem
 */

// Import fake-indexeddb to polyfill IndexedDB in Node environment
import 'fake-indexeddb/auto';

// Ensure API base URL points to production for tests
if (typeof process !== 'undefined') {
  process.env.GOSSIP_API_URL = 'https://api.usegossip.com';
  process.env.VITE_GOSSIP_API_URL = 'https://api.usegossip.com';
}

// Import IDBKeyRange polyfill
import { IDBKeyRange } from 'fake-indexeddb';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import type { Account } from '@massalabs/massa-web3';
import type { AccountStoreState } from '../src/utils';
import type { WalletStoreState } from '../src/wallet';
import type { UserProfile } from '../src/db';
import { db } from '../src/db';
import { setAccountStore } from '../src/utils';
import { setWalletStore } from '../src/wallet';
import { generateUserKeys } from '../src/wasm/userKeys';
import { ensureWasmInitialized } from '../src/wasm/loader';
import { SessionModule } from '../src/wasm/session';
import { generateNonce } from '../src/wasm/encryption';
import { deriveKey, encrypt } from '../src/crypto/encryption';

const defaultAccountState: AccountStoreState = {
  userProfile: null,
  encryptionKey: null,
  session: null,
  isLoading: false,
  account: null,
};

let accountState: AccountStoreState = { ...defaultAccountState };
let accountProfiles: UserProfile[] = [];
let accountExists = false;
let lastBackupInfo: { createdAt: Date; backedUp: boolean } | null = null;
let walletState: Pick<WalletStoreState, 'tokens' | 'feeConfig'> = {
  tokens: [
    {
      address: 'MASSA',
      name: 'Massa',
      ticker: 'MAS',
      icon: 'mas-icon',
      balance: null,
      priceUsd: null,
      valueUsd: null,
      isNative: true,
      decimals: 9,
    },
  ],
  feeConfig: {
    type: 'preset',
    preset: 'standard',
  },
};

async function createSessionModule(): Promise<{
  session: AccountStoreState['session'];
  encryptionKey: AccountStoreState['encryptionKey'];
  security: UserProfile['security'];
}> {
  await ensureWasmInitialized();
  const mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const keys = await generateUserKeys(mnemonic);
  const session = new SessionModule(keys, () => undefined);
  const salt = (await generateNonce()).to_bytes();
  const encryptionKey = await deriveKey('testpassword123', salt);
  const { encryptedData: encryptedMnemonic } = await encrypt(
    mnemonic,
    encryptionKey,
    salt
  );

  return {
    session: session as unknown as AccountStoreState['session'],
    encryptionKey,
    security: {
      authMethod: 'password',
      encKeySalt: salt,
      mnemonicBackup: {
        encryptedMnemonic,
        createdAt: new Date(),
        backedUp: false,
      },
    },
  };
}

// Make IDBKeyRange available globally (required for Dexie in Node)
if (typeof globalThis.IDBKeyRange === 'undefined') {
  (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange =
    IDBKeyRange;
}

// Mock localStorage for zustand persist middleware
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
})();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// Mock the notification service (Node.js doesn't have notifications)
// Note: SDK doesn't import this directly, but React app code might via transitive imports
vi.mock('@/services/notifications', () => ({
  notificationService: {
    scheduleNotification: vi.fn(),
    cancelNotification: vi.fn(),
    requestPermission: vi.fn(),
    showNewDiscussionNotification: vi.fn(),
    showNewMessageNotification: vi.fn(),
  },
}));

// Mock service worker setup (Node.js doesn't have service workers)
vi.mock('@/services/serviceWorkerSetup', () => ({
  setupServiceWorker: vi.fn().mockResolvedValue(undefined),
}));

// Mock capacitor biometric auth (Node.js doesn't have biometrics)
vi.mock('@aparajita/capacitor-biometric-auth', () => {
  const mockFn = vi.fn();
  class BiometryError extends Error {}
  const BiometryType = {
    NONE: 'none',
    TOUCH_ID: 'touchId',
    FACE_ID: 'faceId',
    FINGERPRINT: 'fingerprint',
  };
  const BiometryErrorType = BiometryType;

  return {
    BiometricAuth: {
      isAvailable: mockFn,
      verify: mockFn,
      getAvailableMethods: mockFn,
      getEnrolledLevel: mockFn,
    },
    BiometryError,
    BiometryType,
    BiometryErrorType,
  };
});

// Mock capacitor preferences (used for storing active seekers)
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn().mockResolvedValue({ value: null }),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock capacitor app (used for app state detection)
vi.mock('@capacitor/app', () => ({
  App: {
    getState: vi.fn().mockResolvedValue({ isActive: true }),
    addListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
  },
}));

// Mock the biometric service
vi.mock('@/services/biometricService', () => ({
  biometricService: {
    checkAvailability: vi.fn().mockResolvedValue({ available: false }),
    createCredential: vi.fn(),
    authenticate: vi.fn(),
  },
}));

// Mock price fetching to avoid CoinGecko rate limits
vi.mock('@/utils/fetchPrice', async () => {
  const actual = await import('@/utils/fetchPrice');
  return {
    ...actual,
    priceFetcher: {
      getTokenPrice: vi.fn().mockResolvedValue(0.01),
      getTokenPrices: vi.fn().mockImplementation(async (bases: string[]) => {
        return Object.fromEntries(
          bases.map(base => [base.toUpperCase(), 0.01])
        );
      }),
      getUsdPrice: vi.fn().mockResolvedValue(0.01),
      getUsdPrices: vi.fn().mockImplementation(async (bases: string[]) => {
        return Object.fromEntries(
          bases.map(base => [base.toUpperCase(), 0.01])
        );
      }),
    },
  };
});

// Use real WASM - configure it to load from filesystem in Node.js instead of fetch
vi.mock('@/assets/generated/wasm/gossip_wasm', async () => {
  const actual = await import('@/assets/generated/wasm/gossip_wasm');
  const { readFile } = await import('fs/promises');
  const { fileURLToPath } = await import('url');
  const { dirname, join } = await import('path');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const wasmPath = join(
    __dirname,
    '../../src/assets/generated/wasm/gossip_wasm_bg.wasm'
  );

  return {
    ...actual,
    default: async () => {
      // In Node.js, read the WASM file from filesystem and pass as Uint8Array
      const wasmBytes = await readFile(wasmPath);
      return actual.default(wasmBytes);
    },
  };
});

async function clearDatabase(): Promise<void> {
  await Promise.all(db.tables.map(table => table.clear()));
}

beforeAll(async () => {
  if (!db.isOpen()) {
    await db.open();
  }
  await clearDatabase();

  accountState = { ...defaultAccountState };
  accountProfiles = [];
  accountExists = false;
  lastBackupInfo = null;
  walletState = {
    tokens: [
      {
        address: 'MASSA',
        name: 'Massa',
        ticker: 'MAS',
        icon: 'mas-icon',
        balance: null,
        priceUsd: null,
        valueUsd: null,
        isNative: true,
        decimals: 9,
      },
    ],
    feeConfig: {
      type: 'preset',
      preset: 'standard',
    },
  };

  setAccountStore({
    getState: () => accountState,
    initializeAccount: vi
      .fn()
      .mockImplementation(async (username, password) => {
        if (!password) {
          throw new Error('Password is required');
        }

        const profile: UserProfile = {
          userId: 'gossip1test',
          username,
          security: {
            encKeySalt: new Uint8Array(),
            authMethod: 'password',
            mnemonicBackup: {
              encryptedMnemonic: new Uint8Array(),
              createdAt: new Date(),
              backedUp: false,
            },
          },
          session: new Uint8Array(),
          status: 'online',
          lastSeen: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const { session, encryptionKey, security } =
          await createSessionModule();
        if (!encryptionKey) {
          throw new Error('Encryption key not initialized');
        }

        const sessionModule = session as unknown as SessionModule;
        const sessionBlob = sessionModule.toEncryptedBlob(encryptionKey);
        const userId = sessionModule.userIdEncoded;

        const userProfile: UserProfile = {
          ...profile,
          userId,
          security,
          session: sessionBlob,
        };

        accountState = {
          ...accountState,
          userProfile,
          encryptionKey,
          session,
          isLoading: false,
        };

        await db.userProfile.put(userProfile);
        accountProfiles.push(userProfile);
        accountExists = true;
        lastBackupInfo = {
          createdAt: new Date(),
          backedUp: false,
        };
      }),
    initializeAccountWithBiometrics: vi
      .fn()
      .mockImplementation(async username => {
        const profile: UserProfile = {
          userId: 'gossip1test',
          username,
          security: {
            encKeySalt: new Uint8Array(),
            authMethod: 'webauthn',
            mnemonicBackup: {
              encryptedMnemonic: new Uint8Array(),
              createdAt: new Date(),
              backedUp: false,
            },
          },
          session: new Uint8Array(),
          status: 'online',
          lastSeen: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const { session, encryptionKey, security } =
          await createSessionModule();
        if (!encryptionKey) {
          throw new Error('Encryption key not initialized');
        }

        const sessionModule = session as unknown as SessionModule;
        const sessionBlob = sessionModule.toEncryptedBlob(encryptionKey);
        const userId = sessionModule.userIdEncoded;

        const userProfile: UserProfile = {
          ...profile,
          userId,
          security,
          session: sessionBlob,
        };

        accountState = {
          ...accountState,
          userProfile,
          encryptionKey,
          session,
          isLoading: false,
        };

        await db.userProfile.put(userProfile);

        accountProfiles.push(userProfile);
        accountExists = true;
        lastBackupInfo = {
          createdAt: new Date(),
          backedUp: false,
        };
      }),

    loadAccount: vi.fn().mockImplementation(async () => {
      if (!accountExists) {
        throw new Error('No user profile found');
      }
    }),
    restoreAccountFromMnemonic: vi.fn().mockImplementation(async username => {
      const profile: UserProfile = {
        userId: 'gossip1restored',
        username,
        security: {
          encKeySalt: new Uint8Array(),
          authMethod: 'password',
          mnemonicBackup: {
            encryptedMnemonic: new Uint8Array(),
            createdAt: new Date(),
            backedUp: false,
          },
        },
        session: new Uint8Array(),
        status: 'online',
        lastSeen: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const { session, encryptionKey, security } = await createSessionModule();
      if (!encryptionKey) {
        throw new Error('Encryption key not initialized');
      }

      accountState = {
        ...accountState,
        userProfile: {
          ...profile,
          security,
        },
        encryptionKey,
        session,
        isLoading: false,
      };

      const sessionModule = session as unknown as SessionModule;
      await db.userProfile.put({
        ...profile,
        security,
        session: sessionModule.toEncryptedBlob(encryptionKey),
      });

      accountProfiles.push({
        ...profile,
        security,
      });
      accountExists = true;
      lastBackupInfo = {
        createdAt: new Date(),
        backedUp: false,
      };
    }),

    logout: vi.fn().mockImplementation(async () => {
      accountState = {
        ...accountState,
        userProfile: null,
        session: null,
        encryptionKey: null,
        account: null,
      };
    }),
    resetAccount: vi.fn().mockImplementation(async () => {
      accountProfiles = [];
      accountExists = false;
      accountState = {
        ...defaultAccountState,
      };
    }),
    showBackup: vi.fn().mockResolvedValue({
      mnemonic: '',
      account: {} as Account,
    }),
    getMnemonicBackupInfo: vi.fn().mockImplementation(() => lastBackupInfo),
    markMnemonicBackupComplete: vi.fn().mockImplementation(async () => {
      if (lastBackupInfo) {
        lastBackupInfo = {
          ...lastBackupInfo,
          backedUp: true,
        };
      }
    }),
    getAllAccounts: vi.fn().mockImplementation(async () => accountProfiles),
    hasExistingAccount: vi.fn().mockImplementation(async () => accountExists),
  });

  setWalletStore({
    getState: () => ({
      tokens: walletState.tokens,
      isLoading: false,
      isInitialized: false,
      error: null,
      feeConfig: walletState.feeConfig,
      initializeTokens: vi.fn(),
      getTokenBalances: vi.fn().mockResolvedValue([]),
      refreshBalances: vi.fn(),
      refreshBalance: vi.fn(),
      setFeeConfig: vi.fn().mockImplementation(config => {
        walletState = {
          ...walletState,
          feeConfig: config,
        };
      }),
      getFeeConfig: vi.fn().mockImplementation(() => walletState.feeConfig),
    }),
  });
});

beforeEach(async () => {
  if (!db.isOpen()) {
    await db.open();
  }
  await clearDatabase();

  accountState = { ...defaultAccountState };
  accountProfiles = [];
  accountExists = false;
  lastBackupInfo = null;
  walletState = {
    tokens: [
      {
        address: 'MASSA',
        name: 'Massa',
        ticker: 'MAS',
        icon: 'mas-icon',
        balance: null,
        priceUsd: null,
        valueUsd: null,
        isNative: true,
        decimals: 9,
      },
    ],
    feeConfig: {
      type: 'preset',
      preset: 'standard',
    },
  };
});

afterAll(async () => {
  try {
    await clearDatabase();
    await db.close();
  } catch (_) {
    // Ignore errors - database might already be closed
  }
});

console.log('SDK test setup complete: fake-indexeddb initialized');
