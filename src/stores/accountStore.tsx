import { create } from 'zustand';
import { encodeUserId, UserProfile } from '@massalabs/gossip-sdk';

import {
  encrypt,
  deriveKey,
  generateMnemonic,
  validateMnemonic,
  EncryptionKey,
  generateNonce,
  validateUsernameFormat,
} from '@massalabs/gossip-sdk';
import { getSdk } from './sdkStore';
import { isWebAuthnSupported } from '../crypto/webauthn';
import {
  checkBiometricAvailability,
  createCredential,
} from '../services/biometricService';
import {
  getBiometricSalt,
  WEBAUTHN_CREDENTIAL_ID_KEY,
} from '../constants/biometric';
import {
  Provider,
  Account,
  JsonRpcProvider,
  PublicApiUrl,
  NetworkName,
} from '@massalabs/massa-web3';
import { useAppStore } from './appStore';
import { createSelectors } from './utils/createSelectors';

import { getActiveOrFirstProfile } from './utils/getAccount';
import { auth } from './utils/auth';
import { useDiscussionStore } from './discussionStore';
import { useMessageStore } from './messageStore';
import { useSelfMessageStore } from './selfMessageStore';
import {
  deriveAccountFromMnemonic,
  fetchMnsDomainsIfEnabled,
} from './utils/accountHelpers';

export type LoginMethod =
  | { type: 'password'; password: string; userId?: string }
  | { type: 'biometric'; userId?: string }
  | { type: 'encryptionKey'; encryptionKey: EncryptionKey };

type accountProvisionResult = {
  encryptionKey: EncryptionKey;
  security: UserProfile['security'];
};

async function provisionAccount(
  username: string,
  mnemonic: string | undefined,
  userIdBytes: Uint8Array,
  opts: { useBiometrics: boolean; password?: string; iCloudSync?: boolean }
): Promise<accountProvisionResult> {
  if (opts.useBiometrics) {
    return await buildSecurityFromBiometrics(
      mnemonic,
      username,
      userIdBytes,
      opts.iCloudSync ?? false
    );
  } else {
    const password = opts.password?.trim();
    if (!password) {
      throw new Error('Password is required');
    }
    return await buildSecurityFromPassword(mnemonic, password);
  }
}

// Helpers to build security blobs and in-memory keys
async function buildSecurityFromPassword(
  mnemonic: string | undefined,
  password: string
): Promise<{
  security: UserProfile['security'];
  encryptionKey: EncryptionKey;
}> {
  const salt = (await generateNonce()).to_bytes();
  const key = await deriveKey(password, salt);

  if (!mnemonic) {
    throw new Error('Mnemonic is required for account creation');
  }

  const { encryptedData: encryptedMnemonic } = await encrypt(
    mnemonic,
    key,
    salt
  );
  const mnemonicBackup: UserProfile['security']['mnemonicBackup'] = {
    encryptedMnemonic,
    createdAt: new Date(),
    backedUp: false,
  };

  const security: UserProfile['security'] = {
    authMethod: 'password',
    encKeySalt: salt,
    mnemonicBackup,
  };

  return { security, encryptionKey: key };
}

async function buildSecurityFromBiometrics(
  mnemonic: string | undefined,
  username: string,
  userIdBytes: Uint8Array,
  iCloudSync = false
): Promise<{
  security: UserProfile['security'];
  encryptionKey: EncryptionKey;
}> {
  if (!mnemonic) {
    throw new Error('Mnemonic is required for account creation');
  }

  // WebAuthn PRF needs the fixed biometric salt; Capacitor ignores it.
  // Mnemonic encryption uses a separate random salt.
  const prfSalt = await getBiometricSalt();
  const encSalt = (await generateNonce()).to_bytes();

  const credentialResult = await createCredential(
    `Gossip:${username}`,
    userIdBytes,
    prfSalt,
    iCloudSync
  );

  if (!credentialResult.success || !credentialResult.data) {
    throw new Error(
      credentialResult.error || 'Failed to create biometric credential'
    );
  }

  const { credentialId, encryptionKey, authMethod } = credentialResult.data;

  // Persist WebAuthn credential ID for login discovery
  if (credentialId) {
    localStorage.setItem(WEBAUTHN_CREDENTIAL_ID_KEY, credentialId);
  }

  const { encryptedData } = await encrypt(mnemonic, encryptionKey, encSalt);

  const mnemonicBackup: UserProfile['security']['mnemonicBackup'] = {
    encryptedMnemonic: encryptedData,
    createdAt: new Date(),
    backedUp: false,
  };

  const security: UserProfile['security'] = {
    authMethod,
    webauthn: credentialId
      ? {
          credentialId,
        }
      : undefined,
    iCloudSync,
    encKeySalt: encSalt,
    mnemonicBackup,
  };

  return { security, encryptionKey };
}

interface AccountState {
  userProfile: UserProfile | null;
  encryptionKey: EncryptionKey | null;
  isLoading: boolean;
  lockedByUser: boolean;
  webauthnSupported: boolean;
  platformAuthenticatorAvailable: boolean;
  account: Account | null;
  evmAddress: string | null;
  provider: Provider | null;
  initializeAccountWithBiometrics: (
    username: string,
    iCloudSync?: boolean
  ) => Promise<void>;
  initializeAccount: (username: string, password: string) => Promise<void>;
  loadAccount: (method: LoginMethod) => Promise<void>;
  restoreAccountFromMnemonic: (
    username: string,
    mnemonic: string,
    opts: { useBiometrics: boolean; password?: string }
  ) => Promise<void>;
  logout: (options?: { lockedByUser?: boolean }) => Promise<void>;
  resetAccount: () => Promise<void>;
  setLoading: (loading: boolean) => void;

  // Mnemonic backup methods
  showBackup: (password?: string) => Promise<{
    mnemonic: string;
    account: Account;
  }>;
  getMnemonicBackupInfo: () => { createdAt: Date; backedUp: boolean } | null;
  markMnemonicBackupComplete: () => Promise<void>;

  // Account detection methods
  hasExistingAccount: () => Promise<boolean>;
  getExistingAccountInfo: () => Promise<UserProfile | null>;
  getAllAccounts: () => Promise<UserProfile[]>;

  // Session persistence
  persistSession: () => Promise<void>;

  // Username update
  updateUsername: (newUsername: string) => Promise<void>;
}

const useAccountStoreBase = create<AccountState>((set, get) => {
  // Helper function to cleanup session
  const cleanupSession = async () => {
    const sdk = getSdk();
    if (sdk.isSessionOpen) {
      await sdk.closeSession();
    }
  };

  // Helper function to clear account state
  const clearAccountState = () => {
    // Free the WASM EncryptionKey to zero its memory before dropping.
    // Guard against double-free: closeSession() may have already freed it,
    // leaving __wbg_ptr === 0 which would pass a null pointer to WASM.
    const key = get().encryptionKey;
    if (key && (key as unknown as { __wbg_ptr: number }).__wbg_ptr !== 0) {
      key.free();
    }
    return {
      account: null,
      evmAddress: null,
      userProfile: null,
      encryptionKey: null,
      isLoading: false,
    };
  };

  // Helper to persist session blob to DB
  const createOnPersist = (_userId: string) => {
    return async (blob: Uint8Array, _key: EncryptionKey) => {
      const current = get().userProfile;
      if (!current) return;
      const updated = { ...current, session: blob, updatedAt: new Date() };
      await getSdk().profiles.save(updated);
      set({ userProfile: updated });
    };
  };

  // Shared scaffold for account creation / restoration
  interface SetupAccountParams {
    username: string;
    mnemonic: string;
    provisionOpts: {
      useBiometrics: boolean;
      password?: string;
      iCloudSync?: boolean;
    };
    extraState?: Partial<AccountState>;
    skipHistorical?: boolean;
  }

  const setupAccount = async ({
    username,
    mnemonic,
    provisionOpts,
    extraState = {},
    skipHistorical = false,
  }: SetupAccountParams): Promise<void> => {
    await cleanupSession();

    const { account, userIdBytes, evmAddress } =
      await deriveAccountFromMnemonic(mnemonic);
    const userId = encodeUserId(userIdBytes);

    const { encryptionKey, security } = await provisionAccount(
      username,
      mnemonic,
      userIdBytes,
      provisionOpts
    );

    await getSdk().openSession({
      mnemonic,
      encryptionKey,
      onPersist: createOnPersist(userId),
    });

    const session = getSdk().getEncryptedSession();

    const profile = await getSdk().profiles.createOrUpdate(
      username,
      encodeUserId(userIdBytes),
      security,
      session
    );

    if (skipHistorical) {
      await getSdk().announcements.skipHistorical();
    }

    set({
      userProfile: profile,
      encryptionKey,
      account,
      evmAddress,
      isLoading: false,
      ...extraState,
    });

    fetchMnsDomainsIfEnabled(profile, get().provider);
  };

  return {
    // Initial state
    userProfile: null,
    encryptionKey: null,
    isLoading: true,
    lockedByUser: false,
    webauthnSupported: isWebAuthnSupported(),
    platformAuthenticatorAvailable: false,
    account: null,
    evmAddress: null,
    provider: null,

    // Actions
    initializeAccount: async (username: string, password: string) => {
      try {
        set({ isLoading: true });
        const mnemonic = generateMnemonic(256);
        await setupAccount({
          username,
          mnemonic,
          provisionOpts: { useBiometrics: false, password },
          skipHistorical: true,
        });
      } catch (error) {
        console.error('Error creating user profile:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    restoreAccountFromMnemonic: async (
      username: string,
      mnemonic: string,
      opts: { useBiometrics: boolean; password?: string }
    ) => {
      try {
        set({ isLoading: true });
        if (!validateMnemonic(mnemonic)) {
          throw new Error('Invalid mnemonic phrase');
        }
        await setupAccount({
          username,
          mnemonic,
          provisionOpts: opts,
        });
      } catch (error) {
        console.error('Error restoring account from mnemonic:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    loadAccount: async (method: LoginMethod) => {
      try {
        set({ isLoading: true });

        const userId =
          method.type !== 'encryptionKey' ? method.userId : undefined;
        let profile: UserProfile | null;
        if (userId) {
          profile = await getSdk().profiles.get(userId);
        } else {
          profile = await getActiveOrFirstProfile();
        }

        if (!profile) {
          throw new Error('No user profile found');
        }

        let mnemonic: string;
        let encryptionKey: EncryptionKey;

        switch (method.type) {
          case 'password': {
            const result = await auth(profile, method.password);
            mnemonic = result.mnemonic;
            encryptionKey = result.encryptionKey;
            break;
          }
          case 'biometric': {
            const result = await auth(profile);
            mnemonic = result.mnemonic;
            encryptionKey = result.encryptionKey;
            break;
          }
          case 'encryptionKey': {
            const result = await auth(profile, undefined, method.encryptionKey);
            mnemonic = result.mnemonic;
            encryptionKey = result.encryptionKey;
            break;
          }
        }

        const { account, evmAddress } =
          await deriveAccountFromMnemonic(mnemonic);

        await getSdk().openSession({
          mnemonic,
          encryptedSession: profile.session,
          encryptionKey,
          onPersist: createOnPersist(profile.userId),
        });

        const lastSeen = new Date();
        const updatedProfile = {
          ...profile,
          lastSeen,
        };
        await getSdk().profiles.save(updatedProfile);

        useAppStore.getState().setIsInitialized(true);
        set({
          userProfile: updatedProfile,
          account,
          evmAddress,
          encryptionKey,
          isLoading: false,
          lockedByUser: false,
        });

        fetchMnsDomainsIfEnabled(updatedProfile, get().provider);
      } catch (error) {
        console.error('Error loading account:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    resetAccount: async () => {
      try {
        set({ isLoading: true });

        let accountUserId: string | undefined;
        try {
          accountUserId = getSdk().userId;
        } catch {
          // Session may already be closed
        }

        await cleanupSession();
        useDiscussionStore.getState().cleanup();
        useMessageStore.getState().cleanup();
        useSelfMessageStore.getState().clearMessages();

        try {
          if (accountUserId) {
            await getSdk().clearAccountData(accountUserId);
          } else {
            await getSdk().clearAllTables();
          }
        } catch {
          // SQLite might not be initialized
        }

        set(clearAccountState());
        const nbAccounts = await getSdk().profiles.getCount();
        useAppStore.getState().setIsInitialized(nbAccounts > 0);
      } catch (error) {
        console.error('Error resetting account:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    logout: async (options?: { lockedByUser?: boolean }) => {
      try {
        set({ isLoading: true });

        await cleanupSession();
        useDiscussionStore.getState().cleanup();
        useMessageStore.getState().cleanup();
        useSelfMessageStore.getState().clearMessages();

        set({
          ...clearAccountState(),
          lockedByUser: options?.lockedByUser ?? true,
        });
      } catch (error) {
        console.error('Error logging out:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    setLoading: (loading: boolean) => {
      set({ isLoading: loading });
    },

    initializeAccountWithBiometrics: async (
      username: string,
      iCloudSync = false
    ) => {
      try {
        set({ isLoading: true });

        const availability = await checkBiometricAvailability();
        if (!availability.available) {
          throw new Error(
            'Biometric authentication is not available on this device'
          );
        }

        const mnemonic = generateMnemonic(256);
        await setupAccount({
          username,
          mnemonic,
          provisionOpts: { useBiometrics: true, iCloudSync },
          extraState: {
            platformAuthenticatorAvailable: availability.available,
          },
        });
      } catch (error) {
        console.error('Error creating user profile with biometrics:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    showBackup: async (
      password?: string
    ): Promise<{
      mnemonic: string;
      account: Account;
    }> => {
      try {
        const state = get();
        const profile = state.userProfile;
        if (!profile || !getSdk().isSessionOpen) {
          throw new Error('No authenticated user');
        }

        const { mnemonic } = await auth(profile, password);
        const { account } = await deriveAccountFromMnemonic(mnemonic);

        return { mnemonic, account };
      } catch (error) {
        console.error('Error showing mnemonic backup:', error);
        throw error;
      }
    },

    getMnemonicBackupInfo: () => {
      const state = get();
      const mnemonicBackup = state.userProfile?.security.mnemonicBackup;
      if (!mnemonicBackup) return null;

      return {
        createdAt: mnemonicBackup.createdAt,
        backedUp: mnemonicBackup.backedUp,
      };
    },

    markMnemonicBackupComplete: async () => {
      try {
        const state = get();
        const profile = state.userProfile;
        if (!profile) {
          throw new Error('No user profile found');
        }

        const updatedProfile = {
          ...profile,
          security: {
            ...profile.security,
            mnemonicBackup: {
              ...profile.security.mnemonicBackup,
              backedUp: true,
            },
          },
        };

        await getSdk().profiles.save({
          ...updatedProfile,
          updatedAt: new Date(),
        });
        set({ userProfile: updatedProfile });
      } catch (error) {
        console.error('Error marking mnemonic backup as complete:', error);
        throw error;
      }
    },

    hasExistingAccount: async () => {
      try {
        const count = await getSdk().profiles.getCount();
        return count > 0;
      } catch (error) {
        console.error('Error checking for existing account:', error);
        return false;
      }
    },

    getExistingAccountInfo: async () => {
      try {
        return await getActiveOrFirstProfile();
      } catch (error) {
        console.error('Error getting existing account info:', error);
        return null;
      }
    },

    getAllAccounts: async () => {
      try {
        return await getSdk().profiles.getAll();
      } catch (error) {
        console.error('Error getting all accounts:', error);
        return [];
      }
    },

    persistSession: async () => {
      const state = get();
      const { userProfile } = state;

      if (!getSdk().isSessionOpen || !userProfile) {
        console.warn(
          'No session, user profile, or encryption key to persist, skipping persistence'
        );
        return;
      }

      try {
        const sessionBlob = getSdk().getEncryptedSession();
        if (!sessionBlob) {
          console.warn('Failed to get encrypted session');
          return;
        }

        const updatedProfile = {
          ...userProfile,
          session: sessionBlob,
          updatedAt: new Date(),
        };

        await getSdk().profiles.save(updatedProfile);
        set({ userProfile: updatedProfile });
      } catch (error) {
        console.error('Error persisting session:', error);
      }
    },

    updateUsername: async (newUsername: string) => {
      try {
        const state = get();
        const profile = state.userProfile;

        if (!profile) {
          throw new Error('No user profile found');
        }

        const trimmedUsername = newUsername.trim();

        const formatResult = validateUsernameFormat(trimmedUsername);
        if (!formatResult.valid) {
          throw new Error(formatResult.error || 'Invalid username format');
        }

        const updatedProfile = {
          ...profile,
          username: trimmedUsername,
          updatedAt: new Date(),
        };

        await getSdk().profiles.save(updatedProfile);
        set({ userProfile: updatedProfile });
      } catch (error) {
        console.error('Error updating username:', error);
        throw error;
      }
    },
  };
});

useAccountStoreBase.subscribe(async (state, prevState) => {
  const current = state.userProfile;
  const previous = prevState.userProfile;

  const sdk = getSdk();
  if (!current || !sdk.isSessionOpen) return;
  if (current === previous) return;
  if (previous && current.userId === previous.userId) return;

  try {
    await sdk.auth.publishPublicKey(sdk.publicKeys, sdk.userId, sdk.queries);
  } catch (error) {
    console.error('Error publishing public key:', error);
  }
});

// Subscribe to account changes to initialize provider
useAccountStoreBase.subscribe(async (state, prevState) => {
  const currentAddress = state.account?.address?.toString();
  const prevAddress = prevState.account?.address?.toString();

  if (currentAddress === prevAddress) return;

  try {
    const networkName = useAppStore.getState().networkName;
    const publicApiUrl =
      networkName === NetworkName.Buildnet
        ? PublicApiUrl.Buildnet
        : PublicApiUrl.Mainnet;

    if (state.account) {
      const provider = await JsonRpcProvider.fromRPCUrl(
        publicApiUrl,
        state.account
      );

      useAccountStoreBase.setState({ provider });
    } else {
      useAccountStoreBase.setState({ provider: null });
    }
  } catch (error) {
    console.error('Error initializing provider:', error);
  }
});

// Subscribe to provider changes to fetch MNS domains when provider becomes available
useAccountStoreBase.subscribe(async (state, prevState) => {
  if (state.provider === prevState.provider) return;

  if (state.provider && state.userProfile) {
    fetchMnsDomainsIfEnabled(state.userProfile, state.provider);
  }
});

export const useAccountStore = createSelectors(useAccountStoreBase);
