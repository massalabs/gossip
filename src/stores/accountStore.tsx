import { create } from 'zustand';
import { encodeUserId, UserProfile } from '@massalabs/gossip-sdk';

import {
  encrypt,
  deriveKey,
  generateMnemonic,
  validateMnemonic,
  EncryptionKey,
  generateNonce,
  encodeToBase64,
} from '@massalabs/gossip-sdk';
import { validateUsernameFormat } from '../utils/validation';
import { getSdk } from './sdkStore';
import { isWebAuthnSupported } from '../crypto/webauthn';
import {
  checkBiometricAvailability,
  createCredential,
  clearLoginBiometricCredentials,
  hasExistingCredential,
} from '../services/biometricService';
import {
  BIOMETRIC_STORAGE_KEY,
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
  finalizeOnboarding: () => Promise<void>;
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
    // Lock secure-storage too, otherwise storageState stays 'unlocked'
    // and the next login would skip the unlock step and read whichever
    // slot was current when the session closed — leaking the wrong
    // account's data to the caller.
    if (sdk.isSecureStorage && sdk.storageState === 'unlocked') {
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

    const sdk = getSdk();
    if (sdk.isSecureStorage && provisionOpts.useBiometrics) {
      // SecureLogin intentionally has one fixed biometric discovery
      // credential for PD: the login screen must not expose an account or
      // slot inventory. A second biometric account would overwrite that
      // singleton and make the earlier biometric slot unreachable.
      const hasBiometricAccount = await hasExistingCredential(
        BIOMETRIC_STORAGE_KEY
      );
      if (hasBiometricAccount) {
        throw new Error('Only one biometric secure-storage account is allowed');
      }
    }

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
    if (sdk.isSecureStorage) {
      const secret = provisionOpts.useBiometrics
        ? encodeToBase64(encryptionKey.to_bytes())
        : (provisionOpts.password ?? '');
      if (!secret) {
        throw new Error('Secure storage requires a password or biometric key');
      }
      // Reject duplicate passwords across slots. The KDF takes only
      // (domain, password) — no slot index — so the same password on
      // two slots would derive the same wrap key and unlock both. The
      // first slot in the (randomized) probe order would win and the
      // other becomes effectively unreachable. `storageState === 'empty'`
      // means no slot has ever been allocated, so the check is moot.
      if (sdk.storageState === 'locked') {
        const collides = await sdk.secureStorageUnlock(secret);
        if (collides) {
          await sdk.secureStorageLock();
          throw new Error('Password already in use by another account');
        }
        // unlock returned false → state stays 'locked', nothing to undo.
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
      let unlockedThisCall = false;
      try {
        set({ isLoading: true });

        // Defensive: in dev, HMR can hot-replace this module while the
        // SDK keeps its session open. The fresh store has no profile so
        // App routes to login, but `openSession` below would throw
        // "Session already open" against the surviving SDK state. Mirror
        // what `setupAccount` does at its entry — cleanup any leftover
        // session before re-opening.
        await cleanupSession();

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
        if (sdk.storageState === 'locked') {
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
          unlockedThisCall = true;
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
        // If we unlocked the slot during this call but failed before
        // openSession, re-lock so the next attempt re-probes from
        // 'locked'. Without this, an attempt that lands on a deleted
        // slot's surviving keypair (its secret still unlocks an empty
        // DB) leaves storageState='unlocked' and every subsequent
        // login skips the unlock step (state-machine guard) and keeps
        // reading the wrong slot until the app is restarted.
        if (unlockedThisCall) {
          const sdk = getSdk();
          if (sdk.isSecureStorage && sdk.storageState === 'unlocked') {
            try {
              if (sdk.isSessionOpen) {
                await sdk.closeSession();
              }
              await sdk.secureStorageLock();
            } catch (lockErr) {
              console.error(
                'Failed to re-lock after loadAccount error:',
                lockErr
              );
            }
          }
        }
        console.error('Error loading account:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    resetAccount: async () => {
      try {
        set({ isLoading: true });

        const sdk = getSdk();
        let accountUserId: string | undefined;
        try {
          accountUserId = sdk.userId;
        } catch {
          // Session may already be closed
        }

        // Close the SDK session first (Olm cleanup, drain background
        // persists). secureStorageDestroy below has the same
        // "no SESSION_OPEN" precondition as secureStorageLock.
        if (sdk.isSessionOpen) {
          await sdk.closeSession();
        }

        useDiscussionStore.getState().cleanup();
        useMessageStore.getState().cleanup();
        useSelfMessageStore.getState().cleanup();

        if (sdk.isSecureStorage) {
          // Atomic destroy: rotates the slot's keypair to a dummy and
          // overwrites every block of [SQL_NAMESPACE, SESSION_BLOB_NAMESPACE]
          // with cover blocks under the new PK, in a single backing-store
          // transaction. After this resolves, the old secret no longer
          // unlocks the slot — fixing the trap where biometric login
          // would land on the deleted slot's still-valid keypair and
          // leave the SDK in 'unlocked' over an empty DB.
          //
          // Block-count parity is preserved (cover repad), so snapshots
          // before/after look like a routine cover-traffic burst.
          // Process killed mid-destroy: backing-store rolls back, slot
          // intact, user retries.
          try {
            await sdk.secureStorageDestroy();
          } catch (e) {
            console.error('secureStorageDestroy failed:', e);
            // Best-effort lock so we don't leave the storage in
            // 'unlocked' after a partial wipe.
            if (sdk.storageState === 'unlocked') {
              try {
                await sdk.secureStorageLock();
              } catch (lockErr) {
                console.error('Recovery lock also failed:', lockErr);
              }
            }
            throw e;
          }
          // Drop the SecureLogin-discovery credentials. Without this,
          // the biometric button reappears for the deleted account but
          // the slot's wrap key has been rotated → unlock fails and the
          // user dead-ends on the password screen with no password.
          await clearLoginBiometricCredentials();
        } else {
          // wa-sqlite (non-secure-storage) path: shared SQL DB, no
          // per-slot ciphertext to wipe. Clear rows the old way.
          let nbAccounts = 0;
          try {
            if (accountUserId) {
              await sdk.clearAccountData(accountUserId);
            } else {
              await sdk.clearAllTables();
            }
            await sdk.clearSessionBlob();
            nbAccounts = await sdk.profiles.getCount();
          } catch (e) {
            console.error('Error clearing account data:', e);
          }
          useAppStore.getState().setIsInitialized(nbAccounts > 0);
          set(clearAccountState());
          return;
        }

        // Secure-storage post-destroy routing: storageState is 'locked'
        // and the SDK can't tell from JS whether other slots hold real
        // accounts (PD by design). Default to the login screen — if no
        // slot unlocks, the user can fall through to onboarding via
        // the import button.
        set(clearAccountState());
        useAppStore.getState().setIsInitialized(true);
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
        useSelfMessageStore.getState().cleanup();
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

    finalizeOnboarding: async () => {
      // Onboarding opens its session with `autoStartPolling: false` and
      // skips the side-effects normally tied to login (lastSeen update).
      // Patch those onto the existing session — we can't re-run the full
      // `loadAccount` path because the secure-storage slot was wrapped
      // with the user's auth credential (password or biometric-derived
      // bytes), and `finalizeOnboarding` doesn't have access to it after
      // setupAccount drops it from scope.
      //
      // Multi-account flows that already called `logout` (handleFinalize)
      // hit the no-op branch: `userProfile` is null and the user is on
      // the login screen path where polling will start via `loadAccount`.
      const { userProfile } = get();
      if (!userProfile) return;

      const sdk = getSdk();
      if (!sdk.isSessionOpen) return;

      sdk.polling.start();

      const updated = { ...userProfile, lastSeen: new Date() };
      await sdk.profiles.save(updated);
      set({ userProfile: updated });
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
          skipHistorical: true,
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
      // Secure-storage profile queries require an unlocked session.
      // Before unlock we can read storageState directly: 'locked' means
      // there is data, 'empty' means there isn't. Touching `profiles`
      // here would throw and pollute the console on every back-button
      // press from SecureLogin.
      const sdk = getSdk();
      if (sdk.isSecureStorage && sdk.storageState !== 'unlocked') {
        return sdk.storageState === 'locked';
      }
      try {
        const count = await sdk.profiles.getCount();
        return count > 0;
      } catch (error) {
        console.error('Error checking for existing account:', error);
        return false;
      }
    },

    getExistingAccountInfo: async () => {
      const sdk = getSdk();
      if (sdk.isSecureStorage && sdk.storageState !== 'unlocked') {
        return null;
      }
      try {
        return await getActiveOrFirstProfile();
      } catch (error) {
        console.error('Error getting existing account info:', error);
        return null;
      }
    },

    getAllAccounts: async () => {
      const sdk = getSdk();
      if (sdk.isSecureStorage && sdk.storageState !== 'unlocked') {
        return [];
      }
      try {
        return await sdk.profiles.getAll();
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
