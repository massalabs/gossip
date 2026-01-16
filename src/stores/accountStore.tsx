import { create } from 'zustand';
import { db, UserProfile } from '../db';

import {
  encrypt,
  deriveKey,
  generateMnemonic,
  validateMnemonic,
} from 'gossip-sdk';
import { isWebAuthnSupported } from '../crypto/webauthn';
import { biometricService } from '../services/biometricService';
import {
  Provider,
  Account,
  PrivateKey,
  JsonRpcProvider,
  PublicApiUrl,
  NetworkName,
} from '@massalabs/massa-web3';
import { useAppStore } from './appStore';
import { createSelectors } from './utils/createSelectors';
import {
  generateUserKeys,
  EncryptionKey,
  generateNonce,
  SessionModule,
  validateUsernameFormat,
  ensureWasmInitialized,
} from 'gossip-sdk';
import { authService } from '../services';
import { getActiveOrFirstProfile } from './utils/getAccount';
import { auth } from './utils/auth';
import { useDiscussionStore } from './discussionStore';
import { useMessageStore } from './messageStore';

async function createProfileFromAccount(
  username: string,
  userId: string,
  security: UserProfile['security'],
  session: Uint8Array
): Promise<UserProfile> {
  const existing = await db.userProfile.get(userId);
  if (existing) {
    // Merge with existing profile; prefer newly provided security fields when present
    const mergedSecurity: UserProfile['security'] = {
      ...existing.security,
      ...security,
      webauthn: security.webauthn ?? existing.security.webauthn,
      encKeySalt: security.encKeySalt ?? existing.security.encKeySalt,
      mnemonicBackup: security.mnemonicBackup,
    };

    const updatedProfile: UserProfile = {
      ...existing,
      // Preserve existing username if already set; do not silently overwrite
      username: existing.username || username,
      security: mergedSecurity,
      session,
      status: existing.status ?? 'online',
      lastSeen: new Date(),
      updatedAt: new Date(),
    };
    await db.userProfile.put(updatedProfile);
    return updatedProfile;
  }

  const newProfile: UserProfile = {
    userId,
    username,
    security,
    session,
    status: 'online',
    lastSeen: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.userProfile.add(newProfile);
  return newProfile;
}

async function provisionAccount(
  username: string,
  mnemonic: string | undefined,
  opts: { useBiometrics: boolean; password?: string; iCloudSync?: boolean },
  session: SessionModule
): Promise<{ profile: UserProfile; encryptionKey: EncryptionKey }> {
  let built:
    | { security: UserProfile['security']; encryptionKey: EncryptionKey }
    | undefined;

  if (opts.useBiometrics) {
    built = await buildSecurityFromBiometrics(
      mnemonic,
      username,
      session.userId,
      opts.iCloudSync ?? false
    );
  } else {
    const password = opts.password?.trim();
    if (!password) {
      throw new Error('Password is required');
    }
    built = await buildSecurityFromPassword(mnemonic, password);
  }

  // Serialize and encrypt the session
  const sessionBlob = session.toEncryptedBlob(built.encryptionKey);

  const profile = await createProfileFromAccount(
    username,
    session.userIdEncoded,
    built.security,
    sessionBlob
  );
  return { profile, encryptionKey: built.encryptionKey };
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
  // Encrypt mnemonic with derived key using biometric credentials
  if (!mnemonic) {
    throw new Error('Mnemonic is required for account creation');
  }

  const salt = (await generateNonce()).to_bytes();
  // Use the unified biometric service to create credentials
  const credentialResult = await biometricService.createCredential(
    `Gossip:${username}`,
    userIdBytes,
    salt,
    iCloudSync
  );

  if (!credentialResult.success || !credentialResult.data) {
    throw new Error(
      credentialResult.error || 'Failed to create biometric credential'
    );
  }

  const { credentialId, encryptionKey, authMethod } = credentialResult.data;

  const { encryptedData } = await encrypt(mnemonic, encryptionKey, salt);

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
    encKeySalt: salt,
    mnemonicBackup,
  };

  return { security, encryptionKey };
}

interface AccountState {
  userProfile: UserProfile | null;
  encryptionKey: EncryptionKey | null;
  isLoading: boolean;
  webauthnSupported: boolean;
  platformAuthenticatorAvailable: boolean;
  account: Account | null;
  provider: Provider | null;
  // WASM session module
  session: SessionModule | null;
  initializeAccountWithBiometrics: (
    username: string,
    iCloudSync?: boolean
  ) => Promise<void>;
  initializeAccount: (username: string, password: string) => Promise<void>;
  loadAccount: (password?: string, userId?: string) => Promise<void>;
  restoreAccountFromMnemonic: (
    username: string,
    mnemonic: string,
    opts: { useBiometrics: boolean; password?: string }
  ) => Promise<void>;
  logout: () => Promise<void>;
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
  const cleanupSession = () => {
    const state = get();
    if (state.session) {
      state.session.cleanup();
    }
  };

  // Helper function to clear account state
  const clearAccountState = () => {
    return {
      account: null,
      userProfile: null,
      encryptionKey: null,
      session: null,
      isLoading: false,
    };
  };

  // Helper function to fetch MNS domains if MNS is enabled
  const fetchMnsDomainsIfEnabled = (profile: UserProfile) => {
    const { mnsEnabled } = useAppStore.getState();
    if (!mnsEnabled) return;

    const state = get();
    if (!state.provider) return;

    useAppStore
      .getState()
      .fetchMnsDomains(profile, state.provider)
      .catch(error => {
        console.error('Error fetching MNS domains:', error);
      });
  };

  return {
    // Initial state
    userProfile: null,
    encryptionKey: null,
    isLoading: true,
    webauthnSupported: isWebAuthnSupported(),
    platformAuthenticatorAvailable: false,
    account: null,
    provider: null,
    session: null,
    // Actions
    initializeAccount: async (username: string, password: string) => {
      try {
        set({ isLoading: true });

        const mnemonic = generateMnemonic(256);
        const keys = await generateUserKeys(mnemonic);
        const userSecretKeys = keys.secret_keys();

        const account = await Account.fromPrivateKey(
          PrivateKey.fromBytes(userSecretKeys.massa_secret_key)
        );

        // Initialize WASM and create session
        await ensureWasmInitialized();
        const session = new SessionModule(keys, () => {
          get().persistSession();
        });

        const { profile, encryptionKey } = await provisionAccount(
          username,
          mnemonic,
          {
            useBiometrics: false,
            password,
          },
          session
        );

        useAppStore.getState().setIsInitialized(true);
        set({
          userProfile: profile,
          encryptionKey,
          account,
          session,
          isLoading: false,
        });

        // Fetch MNS domains if MNS is enabled
        fetchMnsDomainsIfEnabled(profile);
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

        // Validate mnemonic
        if (!validateMnemonic(mnemonic)) {
          throw new Error('Invalid mnemonic phrase');
        }

        const keys = await generateUserKeys(mnemonic);

        const massaSecretKey = keys.secret_keys().massa_secret_key;
        const account = await Account.fromPrivateKey(
          PrivateKey.fromBytes(massaSecretKey)
        );

        // Initialize WASM and create session
        await ensureWasmInitialized();
        const session = new SessionModule(keys, () => {
          get().persistSession();
        });

        const { profile, encryptionKey } = await provisionAccount(
          username,
          mnemonic,
          opts,
          session
        );

        useAppStore.getState().setIsInitialized(true);
        set({
          account,
          userProfile: profile,
          encryptionKey,
          session,
          isLoading: false,
        });

        // Fetch MNS domains if MNS is enabled
        fetchMnsDomainsIfEnabled(profile);
      } catch (error) {
        console.error('Error restoring account from mnemonic:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    loadAccount: async (password?: string, userId?: string) => {
      try {
        set({ isLoading: true });

        // If userId is provided, load that specific account, otherwise use active or first
        let profile: UserProfile | null;
        if (userId) {
          profile = (await db.userProfile.get(userId)) || null;
        } else {
          profile = await getActiveOrFirstProfile();
        }

        if (!profile) {
          throw new Error('No user profile found');
        }

        const { mnemonic, encryptionKey } = await auth(profile, password);

        const keys = await generateUserKeys(mnemonic);

        // Initialize WASM and load session from profile
        await ensureWasmInitialized();
        const session = new SessionModule(keys, () => {
          get().persistSession();
        });

        const account = await Account.fromPrivateKey(
          PrivateKey.fromBytes(session.ourSk.massa_secret_key)
        );

        session.load(profile, encryptionKey);

        // Update lastSeen timestamp for the logged-in user
        const lastSeen = new Date();
        const updatedProfile = {
          ...profile,
          lastSeen,
        };
        await db.userProfile.update(profile.userId, { lastSeen });

        useAppStore.getState().setIsInitialized(true);
        set({
          userProfile: updatedProfile,
          account,
          encryptionKey,
          session,
          isLoading: false,
        });

        // Fetch MNS domains if MNS is enabled
        fetchMnsDomainsIfEnabled(updatedProfile);

        try {
          session.refresh();
        } catch (e) {
          console.error('Session refresh after login failed:', e);
        }
      } catch (error) {
        console.error('Error loading account:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    resetAccount: async () => {
      try {
        set({ isLoading: true });

        // Cleanup session
        cleanupSession();
        useDiscussionStore.getState().cleanup();
        useMessageStore.getState().cleanup();

        // Delete only the current account, not all accounts
        const currentProfile = await getActiveOrFirstProfile();
        if (currentProfile?.userId != null) {
          await db.userProfile.delete(currentProfile.userId);
        }

        set(clearAccountState());
        const nbAccounts = await db.userProfile.count();
        useAppStore.getState().setIsInitialized(nbAccounts > 0);
      } catch (error) {
        console.error('Error resetting account:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    logout: async () => {
      try {
        set({ isLoading: true });

        // Cleanup session
        cleanupSession();
        useDiscussionStore.getState().cleanup();
        useMessageStore.getState().cleanup();
        // Clear in-memory state but keep data in database
        // Keep isInitialized true so user goes to login screen
        set(clearAccountState());
      } catch (error) {
        console.error('Error logging out:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    setLoading: (loading: boolean) => {
      set({ isLoading: loading });
    },

    // Biometric-based account initialization
    initializeAccountWithBiometrics: async (
      username: string,
      iCloudSync = false
    ) => {
      try {
        set({ isLoading: true });

        // Check biometric support using unified service
        const availability = await biometricService.checkAvailability();
        if (!availability.available) {
          throw new Error(
            'Biometric authentication is not available on this device'
          );
        }

        // Generate a BIP39 mnemonic and create account from it
        const mnemonic = generateMnemonic(256);
        const keys = await generateUserKeys(mnemonic);

        const account = await Account.fromPrivateKey(
          PrivateKey.fromBytes(keys.secret_keys().massa_secret_key)
        );

        // Initialize WASM and create session
        await ensureWasmInitialized();
        const session = new SessionModule(keys, () => {
          get().persistSession();
        });

        const { profile, encryptionKey } = await provisionAccount(
          username,
          mnemonic,
          {
            useBiometrics: true,
            iCloudSync,
          },
          session
        );

        useAppStore.getState().setIsInitialized(true);
        set({
          userProfile: profile,
          encryptionKey,
          account,
          session,
          isLoading: false,
          platformAuthenticatorAvailable: availability.available,
        });

        // Fetch MNS domains if MNS is enabled
        fetchMnsDomainsIfEnabled(profile);
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
        if (!profile || !state.session) {
          throw new Error('No authenticated user');
        }

        const { mnemonic } = await auth(profile, password);

        const massaSecretKey = state.session.ourSk.massa_secret_key;
        const account = await Account.fromPrivateKey(
          PrivateKey.fromBytes(massaSecretKey)
        );

        const backupInfo = {
          mnemonic,
          account,
        };

        return backupInfo;
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

        await db.userProfile.update(profile.userId, updatedProfile);
        set({ userProfile: updatedProfile });
      } catch (error) {
        console.error('Error marking mnemonic backup as complete:', error);
        throw error;
      }
    },

    // Account detection methods
    hasExistingAccount: async () => {
      try {
        // Ensure database is ready
        await db.open();
        const count = await db.userProfile.count();
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
        // Ensure database is ready
        await db.open();
        const profiles = await db.userProfile.toCollection().toArray();
        return profiles;
      } catch (error) {
        console.error('Error getting all accounts:', error);
        return [];
      }
    },

    persistSession: async () => {
      const state = get();
      const { session, userProfile, encryptionKey } = state;

      if (!session || !userProfile || !encryptionKey) {
        console.warn(
          'No session, user profile, or encryption key to persist, skipping persistence'
        );
        return; // Nothing to persist
      }

      try {
        // Serialize the session
        const sessionBlob = session.toEncryptedBlob(encryptionKey);

        // Update the profile with the new session blob
        const updatedProfile = {
          ...userProfile,
          session: sessionBlob,
          updatedAt: new Date(),
        };

        await db.userProfile.update(userProfile.userId, updatedProfile);

        // Update the store with the new profile
        set({ userProfile: updatedProfile });
      } catch (error) {
        console.error('Error persisting session:', error);
        // Don't throw - persistence failures shouldn't break the app
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

        // Validate username format (consistency with account creation)
        const formatResult = validateUsernameFormat(trimmedUsername);
        if (!formatResult.valid) {
          throw new Error(formatResult.error || 'Invalid username format');
        }

        const updatedProfile = {
          ...profile,
          username: trimmedUsername,
          updatedAt: new Date(),
        };

        await db.userProfile.update(profile.userId, updatedProfile);

        // Update the store with the new profile
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

  if (!current || !state.session) return;
  if (current === previous) return;
  if (previous && current.userId === previous.userId) return;

  try {
    await authService.ensurePublicKeyPublished(
      state.session.ourPk,
      current.userId
    );
  } catch (error) {
    console.error('Error publishing public key:', error);
  }
});

// Subscribe to account changes to initialize provider
useAccountStoreBase.subscribe(async (state, prevState) => {
  // Compare account addresses to detect actual account changes
  const currentAddress = state.account?.address?.toString();
  const prevAddress = prevState.account?.address?.toString();

  // Only proceed if account address actually changed
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
  // Only proceed if provider actually changed (became available)
  if (state.provider === prevState.provider) return;

  // Fetch MNS domains if provider is available and user profile exists
  if (state.provider && state.userProfile) {
    fetchMnsDomainsIfEnabled(state.userProfile, state.provider);
  }
});

// Helper function to fetch MNS domains if MNS is enabled
// Used in subscriptions where we have explicit provider
function fetchMnsDomainsIfEnabled(
  profile: UserProfile,
  provider: Provider
): void {
  const { mnsEnabled } = useAppStore.getState();
  if (!mnsEnabled) return;

  useAppStore
    .getState()
    .fetchMnsDomains(profile, provider)
    .catch(error => {
      console.error('Error fetching MNS domains:', error);
    });
}

export const useAccountStore = createSelectors(useAccountStoreBase);
