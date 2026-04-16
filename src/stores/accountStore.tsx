import { create } from 'zustand';
import { encodeUserId, UserProfile } from '@massalabs/gossip-sdk';

import {
  encrypt,
  deriveKey,
  generateMnemonic,
  validateMnemonic,
  EncryptionKey,
  generateNonce,
} from '@massalabs/gossip-sdk';
import { validateUsernameFormat } from '../utils/validation';
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

// Tracks which secure-storage slots have been allocated during the
// current onboarding session. Kept in module scope (not zustand) since
// it's pure RAM and must never hit disk — leaking the allocated slot
// indices would break plausible deniability. Cleared on logout.
//
// Range matches the Rust crate's `SESSION_COUNT = 3`; each onboarding
// allocates up to 3 accounts (main + 2 decoys), each to a distinct
// randomly-picked free slot.
const SECURE_SLOT_COUNT = 3;
const onboardingAllocatedSlots = new Set<number>();

function pickFreeSlot(): number {
  const free: number[] = [];
  for (let i = 0; i < SECURE_SLOT_COUNT; i++) {
    if (!onboardingAllocatedSlots.has(i)) free.push(i);
  }
  if (free.length === 0) {
    throw new Error('No free secure-storage slot');
  }
  const rand = crypto.getRandomValues(new Uint8Array(1))[0];
  return free[rand % free.length];
}

const useAccountStoreBase = create<AccountState>((set, get) => {
  // Helper function to cleanup session
  const cleanupSession = async () => {
    const sdk = getSdk();
    if (sdk.isSessionOpen) {
      await sdk.closeSession();
    }
    // Lock secure-storage too, otherwise `needsUnlock` stays false and
    // the next login would skip the unlock step and read whichever
    // slot was current when the session closed — leaking the wrong
    // account's data to the caller.
    if (sdk.isSecureStorage && !sdk.needsUnlock) {
      await sdk.secureStorageLock();
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

  // Helper to persist session blob.
  //
  // On the secureStorage backend, the blob is written directly into a
  // dedicated namespace stream (bypassing SQLite/Drizzle/page-management).
  // The SQL `userProfile.session` column and in-memory profile session
  // are left unchanged on this path: namespace writes transfer/detach the
  // blob, and the SQL column is only a legacy fallback for wa-sqlite data.
  const createOnPersist = (_userId: string) => {
    return async (blob: Uint8Array, _key: EncryptionKey) => {
      const sdk = getSdk();
      const current = get().userProfile;
      if (!current) return;
      const updatedAt = new Date();

      if (sdk.usesSessionBlobNamespace) {
        // Fast path: write the blob to the secure-storage namespace.
        await sdk.persistSessionBlob(blob);
        set({ userProfile: { ...current, updatedAt } });
      } else {
        // Legacy path: round-trip through the SQL profile row.
        const updated = { ...current, session: blob, updatedAt };
        await sdk.profiles.save(updated);
        set({ userProfile: updated });
      }
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

    // Secure-storage mode: create the slot with the user's credential
    // before any DB access. Queries created by openSession need the
    // backend unlocked. In the password path we use the password
    // directly; in the biometric path we use the biometric-derived
    // encryption key bytes (base64'd) - deterministic, so a later
    // unlock with the same biometric yields the same secret.
    const sdk = getSdk();
    if (sdk.isSecureStorage) {
      const secret = provisionOpts.useBiometrics
        ? encodeToBase64(encryptionKey.to_bytes())
        : (provisionOpts.password ?? '');
      if (!secret) {
        throw new Error('Secure storage requires a password or biometric key');
      }
      // Pick a random free slot among the 3 available. `unlock`
      // probes every slot, so we don't need to persist the choice -
      // but within an onboarding session we must not collide with a
      // previously-allocated slot (that would silently overwrite the
      // earlier account). The in-memory `onboardingAllocatedSlots`
      // set guards against that.
      const slot = pickFreeSlot();
      await sdk.secureStorageCreate(slot, secret);
      onboardingAllocatedSlots.add(slot);
    }

    await sdk.openSession({
      mnemonic,
      encryptionKey,
      onPersist: createOnPersist(userId),
      // Don't poll during onboarding — we may open the session just to
      // write the profile and then close it again to create another
      // account in a different slot. Polling is re-enabled on the real
      // login (loadAccount), which defaults to `autoStartPolling: true`.
      autoStartPolling: false,
    });

    const sdk = getSdk();
    const session = sdk.getEncryptedSession();
    let profileSession = session;
    if (sdk.usesSessionBlobNamespace) {
      await sdk.persistSessionBlob(session);
      profileSession = new Uint8Array(0);
    }

    const profile = await sdk.profiles.createOrUpdate(
      username,
      encodeUserId(userIdBytes),
      security,
      profileSession
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

        // Secure-storage mode: unlock the slot FIRST. Profile queries
        // fail (DB locked) until we provide the secret, so we can't
        // fetch the profile before this. Password path uses the
        // user-typed password; encryptionKey path uses the biometric-
        // derived key bytes, which were computed outside of the DB
        // (WebAuthn PRF / Capacitor Keychain) so no profile lookup is
        // needed to get them. The legacy 'biometric' branch is used
        // only by ClassicLogin (non-secure-storage), which can still
        // read the profile without unlocking.
        const sdk = getSdk();
        if (sdk.needsUnlock) {
          const secret =
            method.type === 'password'
              ? method.password
              : method.type === 'encryptionKey'
                ? encodeToBase64(method.encryptionKey.to_bytes())
                : null;
          if (!secret) {
            throw new Error(
              'Secure storage requires password or encryption-key login'
            );
          }
          const ok = await sdk.secureStorageUnlock(secret);
          if (!ok) {
            throw new Error('Secure storage unlock failed');
          }
        }

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

        // Prefer the secure-storage namespace blob when available; fall
        // back to the SQL profile column on the wa-sqlite backend. When
        // both are empty (fresh allocate pre-first-persist) leave
        // `encryptedSession` undefined so `openSession` generates a new
        // session instead of trying to decrypt zero bytes.
        //
        // Invariant (PD): when `usesSessionBlobNamespace` is true, the
        // SQL `profile.session` fallback is read-only legacy data left
        // over from the wa-sqlite era; writers in `createOnPersist`
        // already gate on this flag and never persist into the SQL
        // column. A future writer that forgets the gate would inject
        // stale-or-stolen bytes into the namespace fallback path here.
        // If you change `createOnPersist` to write to SQL again, you
        // must also drop this fallback or it can resurrect the wrong
        // session blob (regression worth a debug assertion).
        const sdk = getSdk();
        let encryptedSession: Uint8Array | undefined;
        if (sdk.usesSessionBlobNamespace) {
          const ns = await sdk.readSessionBlob();
          encryptedSession =
            ns && ns.length > 0
              ? ns
              : profile.session && profile.session.length > 0
                ? profile.session
                : undefined;
        } else {
          encryptedSession =
            profile.session && profile.session.length > 0
              ? profile.session
              : undefined;
        }

        await sdk.openSession({
          mnemonic,
          encryptedSession,
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
          // The session blob lives in a secure-storage namespace outside
          // SQL — clear it too so the next login doesn't try to decrypt
          // stale bytes with a fresh key. No-op on non-secure-storage.
          await getSdk().clearSessionBlob();
        } catch {
          // SQLite or secure storage might not be initialized
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
        onboardingAllocatedSlots.clear();

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

        const sdk = getSdk();
        const updatedAt = new Date();
        if (sdk.usesSessionBlobNamespace) {
          await sdk.persistSessionBlob(sessionBlob);
          set({ userProfile: { ...userProfile, updatedAt } });
        } else {
          const updatedProfile = {
            ...userProfile,
            session: sessionBlob,
            updatedAt,
          };
          await sdk.profiles.save(updatedProfile);
          set({ userProfile: updatedProfile });
        }
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
