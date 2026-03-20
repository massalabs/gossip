import { create } from 'zustand';
import { encodeUserId, UserProfile } from '@massalabs/gossip-sdk';

import {
  encrypt,
  deriveKey,
  generateMnemonic,
  validateMnemonic,
  generateUserKeys,
  EncryptionKey,
  generateNonce,
  validateUsernameFormat,
} from '@massalabs/gossip-sdk';
import { getSdk } from './sdkStore';
import { isWebAuthnSupported } from '../crypto/webauthn';
import { biometricService } from '../services/biometricService';
import {
  BIOMETRIC_STORAGE_KEY,
  BIOMETRIC_SALT,
  WEBAUTHN_CREDENTIAL_ID_KEY,
} from '../constants/biometric';
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

import { getActiveOrFirstProfile } from './utils/getAccount';
import { auth } from './utils/auth';
import { useDiscussionStore } from './discussionStore';
import { useMessageStore } from './messageStore';
import { useSelfMessageStore } from './selfMessageStore';

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
  // Encrypt mnemonic with derived key using biometric credentials
  if (!mnemonic) {
    throw new Error('Mnemonic is required for account creation');
  }

  const mnemonicSalt = (await generateNonce()).to_bytes();
  // Use fixed BIOMETRIC_SALT for WebAuthn PRF — must match login.
  // The random mnemonicSalt is only for mnemonic encryption (stored in security.encKeySalt).
  const credentialResult = await biometricService.createCredential(
    `Gossip:${username}`,
    userIdBytes,
    BIOMETRIC_SALT,
    iCloudSync,
    BIOMETRIC_STORAGE_KEY
  );

  if (!credentialResult.success || !credentialResult.data) {
    throw new Error(
      credentialResult.error || 'Failed to create biometric credential'
    );
  }

  const { credentialId, encryptionKey, authMethod } = credentialResult.data;

  // Persist credential ID outside secure storage so Login can use it before unlock
  if (credentialId) {
    localStorage.setItem(WEBAUTHN_CREDENTIAL_ID_KEY, credentialId);
  }

  const { encryptedData } = await encrypt(
    mnemonic,
    encryptionKey,
    mnemonicSalt
  );

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
    encKeySalt: mnemonicSalt,
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
  provider: Provider | null;
  initializeAccountWithBiometrics: (
    username: string,
    iCloudSync?: boolean,
    opts?: { setInitialized?: boolean }
  ) => Promise<void>;
  initializeAccount: (
    username: string,
    password: string,
    opts?: { setInitialized?: boolean }
  ) => Promise<void>;
  createHiddenAccount: (
    slot: number,
    username: string,
    password: string
  ) => Promise<void>;
  loadAccount: (
    password?: string,
    userId?: string,
    biometricKey?: EncryptionKey
  ) => Promise<void>;
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
  const cleanupSession = async () => {
    const sdk = getSdk();
    if (sdk.isSessionOpen) {
      await sdk.closeSession();
    }
  };

  // Helper function to clear account state
  const clearAccountState = () => {
    return {
      account: null,
      userProfile: null,
      encryptionKey: null,
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

  // Helper to persist session blob to DB.
  // Leading-edge coalescing: the FIRST call flushes immediately (no delay),
  // rapid subsequent calls within the window share that same flush.
  // This avoids the 200ms wait on single sends while still batching bursts.
  const PERSIST_COALESCE_MS = 150;
  const createOnPersist = (_userId: string) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latestBlob: Uint8Array | null = null;
    let pendingResolves: (() => void)[] = [];
    let flushInProgress = false;

    const flush = async () => {
      timer = null;
      if (flushInProgress) return; // another flush will pick up latestBlob
      flushInProgress = true;

      const blob = latestBlob;
      const resolves = pendingResolves;
      latestBlob = null;
      pendingResolves = [];

      const current = get().userProfile;
      if (!current || !blob) {
        resolves.forEach(r => r());
        flushInProgress = false;
        return;
      }
      const updated = { ...current, session: blob, updatedAt: new Date() };
      await getSdk().profiles.save(updated);
      set({ userProfile: updated });
      resolves.forEach(r => r());
      flushInProgress = false;

      // If new blobs arrived during flush, schedule another
      if (latestBlob) {
        timer = setTimeout(flush, PERSIST_COALESCE_MS);
      }
    };

    return async (blob: Uint8Array, _key: EncryptionKey) => {
      latestBlob = blob;
      return new Promise<void>(resolve => {
        pendingResolves.push(resolve);
        if (!timer && !flushInProgress) {
          // Leading edge: flush immediately on first call
          void flush();
        } else if (!timer) {
          // Flush in progress: schedule coalesced follow-up
          timer = setTimeout(flush, PERSIST_COALESCE_MS);
        }
        // else: timer already scheduled, blob will be picked up
      });
    };
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
    provider: null,
    // Actions
    initializeAccount: async (
      username: string,
      password: string,
      opts?: { setInitialized?: boolean }
    ) => {
      try {
        set({ isLoading: true });

        // Ensure any existing session is closed before creating new account
        await cleanupSession();

        // Initialize encrypted storage with this password
        const sdk = getSdk();
        await sdk.secureStorageAllocate(0, password);

        const mnemonic = generateMnemonic(256);

        // Generate keys for Massa wallet (SDK generates its own internally)
        const keys = await generateUserKeys(mnemonic);
        const account = await Account.fromPrivateKey(
          PrivateKey.fromBytes(keys.secret_keys().massa_secret_key)
        );

        const userIdBytes = keys.public_keys().derive_id();
        const userId = encodeUserId(userIdBytes);

        const { encryptionKey, security } = await provisionAccount(
          username,
          mnemonic,
          userIdBytes,
          {
            useBiometrics: false,
            password,
          }
        );

        // Open SDK session
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

        // Skip historical announcements AFTER profile is persisted
        await getSdk().announcements.skipHistorical();

        if (opts?.setInitialized !== false) {
          useAppStore.getState().setIsInitialized(true);
        }
        set({
          userProfile: profile,
          encryptionKey,
          account,
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

    createHiddenAccount: async (
      slot: number,
      username: string,
      password: string
    ) => {
      const sdk = getSdk();

      if (sdk.isSessionOpen) {
        await sdk.closeSession();
      }

      // Drain pending DB queries from async subscribers before switching slots.
      // No dedicated awaitDbIdle() exists; profiles.getCount() is a cheap read
      // that serialises behind the dbLock, guaranteeing all prior writes have
      // settled before we switch secure storage slots.
      try {
        await sdk.profiles.getCount();
      } catch {
        // Ignore — the goal is to serialise against dbLock, not use the result.
      }

      await sdk.secureStorageAllocate(slot, password, true);

      const mnemonic = generateMnemonic(256);
      const keys = await generateUserKeys(mnemonic);
      const userIdBytes = keys.public_keys().derive_id();
      const userId = encodeUserId(userIdBytes);

      const { encryptionKey, security } = await provisionAccount(
        username,
        mnemonic,
        userIdBytes,
        { useBiometrics: false, password }
      );

      // No-op onPersist is safe: this session is ephemeral — we only open it to
      // write the profile, then closeSession() handles the final persist.
      // No markDirty()/persistIfNeeded() calls occur between open and close.
      await sdk.openSession({
        mnemonic,
        encryptionKey,
        onPersist: async () => {},
      });
      const session = sdk.getEncryptedSession();

      await sdk.profiles.createOrUpdate(username, userId, security, session);
      await sdk.announcements.skipHistorical();

      await sdk.closeSession();
    },

    restoreAccountFromMnemonic: async (
      username: string,
      mnemonic: string,
      opts: { useBiometrics: boolean; password?: string }
    ) => {
      try {
        set({ isLoading: true });

        // Ensure any existing session is closed before restoring account
        await cleanupSession();

        // Validate mnemonic
        if (!validateMnemonic(mnemonic)) {
          throw new Error('Invalid mnemonic phrase');
        }

        // Generate keys for Massa wallet
        const keys = await generateUserKeys(mnemonic);
        const account = await Account.fromPrivateKey(
          PrivateKey.fromBytes(keys.secret_keys().massa_secret_key)
        );

        const userIdBytes = keys.public_keys().derive_id();
        const userId = encodeUserId(userIdBytes);

        // Provision the account
        const { encryptionKey, security } = await provisionAccount(
          username,
          mnemonic,
          userIdBytes,
          opts
        );

        // Open SDK session
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

        // Skip historical announcements AFTER profile is persisted
        await getSdk().announcements.skipHistorical();

        useAppStore.getState().setIsInitialized(true);
        set({
          account,
          userProfile: profile,
          encryptionKey,
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

    loadAccount: async (
      password?: string,
      userId?: string,
      biometricKey?: EncryptionKey
    ) => {
      try {
        set({ isLoading: true });

        const sdk = getSdk();

        // Unlock encrypted storage first — DB may be deferred until after unlock
        if (sdk.needsUnlock) {
          let unlockPassword: string | undefined;
          if (biometricKey) {
            const { encodeToBase64 } = await import('@massalabs/gossip-sdk');
            unlockPassword = encodeToBase64(biometricKey.to_bytes());
            console.log(
              '[BC-DEBUG] unlock password length:',
              unlockPassword.length,
              'first8:',
              unlockPassword.slice(0, 8)
            );
          } else if (password) {
            unlockPassword = password;
          }
          if (unlockPassword) {
            const unlocked = await sdk.secureStorageUnlock(unlockPassword);
            if (!unlocked) {
              throw new Error('Failed to unlock encrypted storage');
            }
          }
        }

        // If userId is provided, load that specific account, otherwise use active or first
        let profile: UserProfile | null;
        if (userId) {
          profile = await sdk.profiles.get(userId);
        } else {
          profile = await getActiveOrFirstProfile();
        }

        if (!profile) {
          throw new Error('No user profile found');
        }

        const { mnemonic, encryptionKey } = await auth(
          profile,
          password,
          biometricKey
        );

        // Generate keys for Massa wallet
        const keys = await generateUserKeys(mnemonic);
        const account = await Account.fromPrivateKey(
          PrivateKey.fromBytes(keys.secret_keys().massa_secret_key)
        );

        // Open SDK session with existing encrypted session state
        await getSdk().openSession({
          mnemonic,
          encryptedSession: profile.session,
          encryptionKey,
          onPersist: createOnPersist(profile.userId),
        });

        // Update lastSeen timestamp for the logged-in user
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
          encryptionKey,
          isLoading: false,
          lockedByUser: false,
        });

        // Fetch MNS domains if MNS is enabled
        fetchMnsDomainsIfEnabled(updatedProfile);

        // TODO: Add session refresh via SDK if needed
      } catch (error) {
        console.error('Error loading account:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    resetAccount: async () => {
      try {
        set({ isLoading: true });

        // Cleanup session and in-memory stores
        await cleanupSession();
        useDiscussionStore.getState().cleanup();
        useMessageStore.getState().cleanup();
        useSelfMessageStore.getState().clearMessages();

        // Clear all DB tables (conversations, contacts, profiles, seekers, etc.)
        try {
          await getSdk().clearAllTables();
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

    logout: async () => {
      try {
        set({ isLoading: true });

        // Cleanup session and in-memory stores
        await cleanupSession();
        useDiscussionStore.getState().cleanup();
        useMessageStore.getState().cleanup();
        // Lock encrypted storage
        try {
          await getSdk().secureStorageLock();
        } catch {
          // Secure storage not initialized — ignore
        }
        // Clear in-memory state but keep data in database
        // Keep isInitialized true so user goes to login screen
        // Set lockedByUser to skip biometric auto-login on the login screen
        set({ ...clearAccountState(), lockedByUser: true });
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
      iCloudSync = false,
      opts?: { setInitialized?: boolean }
    ) => {
      try {
        set({ isLoading: true });

        // Ensure any existing session is closed before creating new account
        await cleanupSession();

        // Check biometric support using unified service
        const availability = await biometricService.checkAvailability();
        if (!availability.available) {
          throw new Error(
            'Biometric authentication is not available on this device'
          );
        }

        // Generate a BIP39 mnemonic
        const mnemonic = generateMnemonic(256);

        // Generate keys for Massa wallet
        const keys = await generateUserKeys(mnemonic);
        const account = await Account.fromPrivateKey(
          PrivateKey.fromBytes(keys.secret_keys().massa_secret_key)
        );
        const userIdBytes = keys.public_keys().derive_id();
        const userId = encodeUserId(userIdBytes);
        const { encryptionKey, security } = await provisionAccount(
          username,
          mnemonic,
          userIdBytes,
          {
            useBiometrics: true,
            iCloudSync,
          }
        );

        // Convert biometric key to secure storage password
        const { encodeToBase64 } = await import('@massalabs/gossip-sdk');
        const biometricPassword = encodeToBase64(encryptionKey.to_bytes());
        console.log(
          '[BC-DEBUG] allocate password length:',
          biometricPassword.length,
          'first8:',
          biometricPassword.slice(0, 8)
        );
        await getSdk().secureStorageAllocate(0, biometricPassword);

        // Open SDK session
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

        // Skip historical announcements AFTER profile is persisted
        await getSdk().announcements.skipHistorical();

        if (opts?.setInitialized !== false) {
          useAppStore.getState().setIsInitialized(true);
        }
        useAppStore.getState().setBiometricEnabled(true);
        set({
          userProfile: profile,
          encryptionKey,
          account,
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
        if (!profile || !getSdk().isSessionOpen) {
          throw new Error('No authenticated user');
        }

        const { mnemonic } = await auth(profile, password);

        // Derive Massa account from mnemonic (SDK doesn't expose secret keys)
        const keys = await generateUserKeys(mnemonic);
        const account = await Account.fromPrivateKey(
          PrivateKey.fromBytes(keys.secret_keys().massa_secret_key)
        );

        return {
          mnemonic,
          account,
        };
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

    // Account detection methods
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
        return; // Nothing to persist
      }

      try {
        // Serialize the session via SDK
        const sessionBlob = getSdk().getEncryptedSession();
        if (!sessionBlob) {
          console.warn('Failed to get encrypted session');
          return;
        }

        // Update the profile with the new session blob
        const updatedProfile = {
          ...userProfile,
          session: sessionBlob,
          updatedAt: new Date(),
        };

        await getSdk().profiles.save(updatedProfile);
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
