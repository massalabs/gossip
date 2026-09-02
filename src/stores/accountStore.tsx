import { logger } from '../utils/logger.ts';
import { create } from 'zustand';
import {
  encodeUserId,
  UserProfile,
  SecureStorageRecoveryRequiredError,
  MessagingSessionRecoveryRequiredError,
  SELF_CONTACT_ID,
  UnreadableMessagingSessionError,
} from '@massalabs/gossip-sdk';

import { generateMnemonic, EncryptionKey } from '@massalabs/gossip-sdk';
import { validateUsernameFormat } from '../utils/validation';
import { getSdk } from './sdkStore';
import { configureBiometricLogin as storeBiometricPassword } from '../services/biometricService';
import { finalizeCommittedAccountGenerationAuthority } from '../services/portableImportAuthorization';
import { resetAllAccountStorage } from '../services/unsupportedStorageReset';

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
import {
  auth,
  createPasswordSecurity,
  type PreparedPasswordAccount,
} from './utils/auth';
import { useDiscussionStore } from './discussionStore';
import { useMessageStore } from './messageStore';
import { useSelfMessageStore } from './selfMessageStore';
import {
  deriveAccountFromMnemonic,
  fetchMnsDomainsIfEnabled,
  wipeAccountPrivateKey,
} from './utils/accountHelpers';

export type PrivateMigrationPhase = 1 | 2 | 3 | 4 | 5;

export type LoginMethod = {
  type: 'password';
  password: string;
  userId?: string;
  resetMessagingSessions?: boolean;
};

export interface PreparedOnboardingAccount {
  username: string;
  password: string;
  prepared: PreparedPasswordAccount;
}

export class IncompleteOnboardingSlotCleanupError extends Error {
  readonly originalCause: unknown;

  constructor(cause: unknown) {
    super(
      cause instanceof Error ? cause.message : 'Account persistence failed'
    );
    this.name = 'IncompleteOnboardingSlotCleanupError';
    this.originalCause = cause;
  }
}

function freeEncryptionKey(key: EncryptionKey): void {
  const pointer = (key as unknown as { __wbg_ptr?: number }).__wbg_ptr;
  if (pointer === undefined || pointer !== 0) {
    key.free();
  }
}

interface AccountState {
  userProfile: UserProfile | null;
  encryptionKey: EncryptionKey | null;
  isLoading: boolean;
  privateMigrationPhase: PrivateMigrationPhase | null;
  lockedByUser: boolean;
  account: Account | null;
  evmAddress: string | null;
  provider: Provider | null;
  initializeAccount: (username: string, password: string) => Promise<void>;
  initializePreparedAccountsAtomically: (
    accounts: readonly PreparedOnboardingAccount[]
  ) => Promise<void>;
  loadAccount: (method: LoginMethod) => Promise<void>;
  logout: (options?: { lockedByUser?: boolean }) => Promise<void>;
  finalizeOnboarding: () => Promise<void>;
  configureBiometricLogin: (
    password: string,
    syncToICloud?: boolean
  ) => Promise<void>;
  resetAccount: () => Promise<void>;
  setLoading: (loading: boolean) => void;

  // Mnemonic backup methods
  showBackup: (password: string) => Promise<{
    mnemonic: string;
    privateKey: string;
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
    const current = get();
    wipeAccountPrivateKey(current.account);
    const key = current.encryptionKey;
    if (key) freeEncryptionKey(key);
    return {
      account: null,
      evmAddress: null,
      userProfile: null,
      encryptionKey: null,
      isLoading: false,
      privateMigrationPhase: null,
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
    password: string;
    skipHistorical?: boolean;
    prepared?: PreparedPasswordAccount;
    publishPublicKey?: boolean;
    deferExternalSideEffects?: boolean;
  }

  const setupAccount = async ({
    username,
    mnemonic,
    password,
    skipHistorical = false,
    prepared,
    publishPublicKey = true,
    deferExternalSideEffects = false,
  }: SetupAccountParams): Promise<void> => {
    await cleanupSession();

    const sdk = getSdk();
    if (!password.trim()) {
      throw new Error('Password is required');
    }

    let encryptionKey: EncryptionKey;
    let security: UserProfile['security'];
    if (prepared) {
      const recovered = await auth(
        { security: prepared.security } as UserProfile,
        password
      );
      if (recovered.mnemonic !== mnemonic) {
        freeEncryptionKey(recovered.encryptionKey);
        throw new Error('Prepared account identity mismatch');
      }
      encryptionKey = recovered.encryptionKey;
      security = prepared.security;
    } else {
      ({ encryptionKey, security } = await createPasswordSecurity(
        mnemonic,
        password
      ));
    }

    // Passwords must identify exactly one account because the global biometric
    // credential deliberately stores no profile ID. Secure storage checks this
    // by probing slots below; classic storage checks existing profiles here.
    if (!sdk.isSecureStorage) {
      let profiles: UserProfile[];
      try {
        profiles = await sdk.profiles.getAll();
      } catch (error) {
        freeEncryptionKey(encryptionKey);
        throw error;
      }
      for (const profile of profiles) {
        try {
          const existing = await auth(profile, password);
          const pointer = (
            existing.encryptionKey as unknown as { __wbg_ptr?: number }
          ).__wbg_ptr;
          if (pointer === undefined || pointer !== 0) {
            existing.encryptionKey.free();
          }
          freeEncryptionKey(encryptionKey);
          throw new Error('Password already in use by another account');
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === 'Password already in use by another account'
          ) {
            throw error;
          }
          // Authentication failure means this password belongs to neither
          // this profile nor its mnemonic backup; continue checking.
        }
      }
    }

    let allocatedSlot: number | null = null;

    // Secure-storage mode: create the slot with the user's password before
    // any DB access. Queries created by openSession need the backend unlocked.
    if (sdk.isSecureStorage) {
      if (
        sdk.storageState !== 'empty' &&
        !useAppStore.getState().secureAccountCreationAllowed
      ) {
        freeEncryptionKey(encryptionKey);
        throw new Error('Secure account creation is not currently authorized');
      }
      const secret = password;
      // Reject duplicate passwords across slots. The KDF takes only
      // (domain, password) — no slot index — so the same password on
      // two slots would derive the same wrap key and unlock both. The
      // first slot in the (randomized) probe order would win and the
      // other becomes effectively unreachable. `storageState === 'empty'`
      // means no slot has ever been allocated, so the check is moot.
      if (sdk.storageState === 'locked') {
        let collides: boolean;
        try {
          collides = await sdk.secureStorageUnlock(secret);
        } catch (error) {
          freeEncryptionKey(encryptionKey);
          throw error;
        }
        if (collides) {
          try {
            await sdk.secureStorageLock();
          } finally {
            // The candidate key is still caller-owned. A rejected re-lock must
            // not strand it while the existing slot remains retryably unlocked.
            freeEncryptionKey(encryptionKey);
          }
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
      let slot: number;
      try {
        slot = pickFreeSlot();
      } catch (error) {
        freeEncryptionKey(encryptionKey);
        throw error;
      }
      allocatedSlot = slot;
      try {
        await sdk.secureStorageCreate(slot, secret);
        onboardingAllocatedSlots.add(slot);
      } catch (error) {
        let cleanupIncomplete =
          error instanceof SecureStorageRecoveryRequiredError;

        try {
          if (sdk.storageState === 'unlocked') {
            await sdk.secureStorageDestroy();
            cleanupIncomplete = false;
          }
        } catch (destroyError) {
          cleanupIncomplete = true;
          logger.error(
            'Failed to destroy interrupted secure account:',
            destroyError
          );
        }

        // A rejected lifecycle RPC may have committed or rolled back before
        // its response was lost. Probe with the known in-flight password: a
        // miss proves the tentative slot is already absent.
        if (cleanupIncomplete && sdk.storageState === 'locked') {
          try {
            const unlocked = await sdk.secureStorageUnlock(secret);
            if (!unlocked) {
              cleanupIncomplete = false;
            } else {
              await sdk.secureStorageDestroy();
              cleanupIncomplete = false;
            }
          } catch (cleanupError) {
            logger.error(
              'Failed to verify interrupted secure account cleanup:',
              cleanupError
            );
          }
        }

        freeEncryptionKey(encryptionKey);
        if (cleanupIncomplete) {
          throw new IncompleteOnboardingSlotCleanupError(error);
        }
        throw error;
      }
    }

    let sessionOpened = false;
    let derivedAccount: Account | undefined;
    let accountTransferred = false;
    try {
      const derived = await deriveAccountFromMnemonic(
        mnemonic,
        security.identityDerivationVersion
      );
      derivedAccount = derived.account;
      const userId = encodeUserId(derived.userIdBytes);

      await sdk.openSession({
        mnemonic,
        identityDerivationVersion: security.identityDerivationVersion,
        encryptedSession: prepared?.encryptedSession,
        encryptionKey,
        onPersist: createOnPersist(userId),
        // Don't poll during onboarding — we may open the session just to
        // write the profile and then close it again to create another
        // account in a different slot. Polling is re-enabled on the real
        // login (loadAccount), which defaults to `autoStartPolling: true`.
        autoStartPolling: false,
        publishPublicKey,
      });
      sessionOpened = true;

      const session = sdk.getEncryptedSession();
      let profileSession = session;
      if (sdk.usesSessionBlobNamespace) {
        await sdk.persistSessionBlob(session);
        profileSession = new Uint8Array(0);
      }

      const profile = await sdk.profiles.createOrUpdate(
        username,
        userId,
        security,
        profileSession
      );
      const accountSettings = await sdk.queries.accountSettings.create(userId);

      if (skipHistorical) {
        await getSdk().announcements.skipHistorical();
      }

      useAppStore.getState().hydrateAccountSettings(accountSettings);
      wipeAccountPrivateKey(get().account);
      set({
        userProfile: profile,
        encryptionKey,
        account: derivedAccount,
        evmAddress: derived.evmAddress,
        isLoading: false,
      });
      accountTransferred = true;

      if (!deferExternalSideEffects) {
        fetchMnsDomainsIfEnabled(profile, get().provider);
      }
    } catch (error) {
      let sessionClosed = !sdk.isSessionOpen;
      let allocatedSlotRemoved = allocatedSlot === null;

      // Account provisioning is a commit point for staged onboarding. If any
      // later write fails, destroy the newly allocated secure slot so a retry
      // cannot leave an unreachable partial account or overwrite it after the
      // in-memory slot reservation is cleared.
      if (sdk.isSessionOpen) {
        try {
          await sdk.closeSession();
          sessionClosed = true;
        } catch (closeError) {
          logger.error('Failed to close partial account session:', closeError);
        }
      } else if (!sessionOpened) {
        freeEncryptionKey(encryptionKey);
      }

      if (allocatedSlot !== null && sessionClosed) {
        try {
          if (sdk.storageState === 'locked') {
            const unlocked = await sdk.secureStorageUnlock(password);
            if (!unlocked) {
              throw new Error('Failed to reopen partial onboarding account');
            }
          }
          if (sdk.storageState !== 'unlocked') {
            throw new Error('Partial onboarding account is not unlocked');
          }
          await sdk.secureStorageDestroy();
          onboardingAllocatedSlots.delete(allocatedSlot);
          allocatedSlotRemoved = true;
        } catch (destroyError) {
          logger.error(
            'Failed to destroy partial secure account:',
            destroyError
          );
          try {
            if (sdk.storageState === 'unlocked') {
              await sdk.secureStorageLock();
            }
          } catch (lockError) {
            logger.error('Failed to lock partial secure account:', lockError);
          }
        }
      }

      if (!allocatedSlotRemoved) {
        throw new IncompleteOnboardingSlotCleanupError(error);
      }
      throw error;
    } finally {
      if (!accountTransferred) wipeAccountPrivateKey(derivedAccount);
    }
  };

  return {
    // Initial state
    userProfile: null,
    encryptionKey: null,
    isLoading: true,
    privateMigrationPhase: null,
    lockedByUser: false,
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
          password,
          skipHistorical: true,
        });
      } catch (error) {
        logger.error('Error creating user profile:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    initializePreparedAccountsAtomically: async accounts => {
      const sdk = getSdk();
      if (!sdk.isSecureStorage || accounts.length === 0) {
        throw new Error('Atomic onboarding requires secure account data');
      }

      let candidateActive = false;
      try {
        set({ isLoading: true });
        onboardingAllocatedSlots.clear();
        await sdk.secureStorageBeginOnboardingCandidate();
        candidateActive = true;

        for (const account of accounts) {
          const mnemonic = new TextDecoder().decode(
            account.prepared.mnemonicBytes
          );
          await setupAccount({
            username: account.username,
            mnemonic,
            password: account.password,
            skipHistorical: true,
            prepared: account.prepared,
            publishPublicKey: false,
            deferExternalSideEffects: true,
          });
          await cleanupSession();
        }

        await sdk.secureStorageCommitOnboardingCandidate();
        candidateActive = false;
        finalizeCommittedAccountGenerationAuthority();
        onboardingAllocatedSlots.clear();
        useAppStore.getState().resetAccountSettings();
        set(clearAccountState());
      } catch (error) {
        try {
          await cleanupSession();
        } catch (cleanupError) {
          logger.error(
            'Failed to close onboarding candidate session:',
            cleanupError
          );
        }
        if (candidateActive) {
          try {
            await sdk.secureStorageAbortOnboardingCandidate();
          } catch (abortError) {
            logger.error('Failed to discard onboarding candidate:', abortError);
          }
        }
        onboardingAllocatedSlots.clear();
        useAppStore.getState().resetAccountSettings();
        set({ ...clearAccountState(), isLoading: false });
        throw error;
      }
    },

    loadAccount: async (method: LoginMethod) => {
      let unlockedThisCall = false;
      let callerOwnedEncryptionKey: EncryptionKey | null = null;
      let derivedAccount: Account | null = null;
      let accountTransferred = false;
      let sessionOpenedThisCall = false;
      try {
        set({ isLoading: true });

        // Defensive: in dev, HMR can hot-replace this module while the
        // SDK keeps its session open. The fresh store has no profile so
        // App routes to login, but `openSession` below would throw
        // "Session already open" against the surviving SDK state. Mirror
        // what `setupAccount` does at its entry — cleanup any leftover
        // session before re-opening.
        await cleanupSession();

        // Secure-storage mode: unlock the slot first. Profile queries fail
        // while the database is locked, so manual and biometric login both
        // supply a password and let native slot probing discover the match.
        const sdk = getSdk();
        if (sdk.storageState === 'locked') {
          const ok = await sdk.secureStorageUnlock(method.password);
          if (!ok) {
            throw new Error('Secure storage unlock failed');
          }
          unlockedThisCall = true;
        }

        const migrationEpoch = sdk.isSecureStorage
          ? sdk.accountGenerationEpoch
          : null;
        if (
          sdk.isSecureStorage &&
          sdk.accountGenerationState === 'committed' &&
          !migrationEpoch
        ) {
          throw new Error('Account generation epoch is unavailable');
        }
        let migrationState = migrationEpoch
          ? await sdk.queries.privateMigration.begin(migrationEpoch)
          : null;
        const migrationActive =
          migrationState !== null && migrationState.completedPhase < 5;
        const messagingResetAuthorizedAtStart =
          migrationState?.completedPhase === 3;
        if (migrationState && migrationState.completedPhase < 5) {
          set({
            privateMigrationPhase: (migrationState.completedPhase +
              1) as PrivateMigrationPhase,
          });
        }
        const completeMigrationPhase = async (
          phase: PrivateMigrationPhase
        ): Promise<void> => {
          if (!migrationEpoch || !migrationState) return;
          if (migrationState.completedPhase < phase) {
            migrationState = await sdk.queries.privateMigration.completePhase(
              migrationEpoch,
              phase
            );
          }
          if (migrationState.completedPhase === phase) {
            set({
              privateMigrationPhase:
                phase === 5 ? null : ((phase + 1) as PrivateMigrationPhase),
            });
          }
        };

        let profile: UserProfile | null = null;
        let authResult: Awaited<ReturnType<typeof auth>> | null = null;

        if (method.userId) {
          profile = await sdk.profiles.get(method.userId);
        } else if (sdk.isSecureStorage) {
          profile = await getActiveOrFirstProfile();
        } else {
          // A global biometric credential contains only a password, never an
          // account ID. Probe classic profiles in memory and retain only the
          // matching result so classic and secure-storage login share the same
          // account-association privacy model.
          const profiles = await sdk.profiles.getAll();
          for (const candidate of profiles) {
            try {
              authResult = await auth(candidate, method.password);
              profile = candidate;
              break;
            } catch {
              // Wrong profile for this password; keep probing.
            }
          }
        }

        if (!profile) {
          throw new Error('No user profile found for this password');
        }
        authResult ??= await auth(profile, method.password);
        const { mnemonic, encryptionKey } = authResult;
        callerOwnedEncryptionKey = encryptionKey;

        const derived = await deriveAccountFromMnemonic(
          mnemonic,
          profile.security.identityDerivationVersion
        );
        derivedAccount = derived.account;
        if (encodeUserId(derived.userIdBytes) !== profile.userId) {
          throw new Error('Authenticated profile identity mismatch');
        }
        if (migrationActive) await completeMigrationPhase(1);

        // Authentication succeeds before the retained versionless decoder is
        // rewritten by the profile save below.
        if (migrationActive) await completeMigrationPhase(2);

        const appState = useAppStore.getState();
        const legacyAccountSettings = sdk.isSecureStorage
          ? null
          : appState.legacyAccountSettingsMigration;
        const accountSettings = await sdk.queries.accountSettings.getOrCreate(
          profile.userId,
          legacyAccountSettings ?? undefined
        );
        if (legacyAccountSettings) {
          appState.clearLegacyAccountSettingsMigration();
        }
        if (migrationActive) await completeMigrationPhase(3);

        const sessionMigrationPending = migrationState?.completedPhase === 3;
        if (
          method.resetMessagingSessions &&
          (!sessionMigrationPending || !messagingResetAuthorizedAtStart)
        ) {
          throw new Error(
            'Messaging session reset is not currently authorized'
          );
        }

        let encryptedSession: Uint8Array | undefined;
        let usedLegacySessionFallback = false;
        if (sdk.usesSessionBlobNamespace) {
          if (method.resetMessagingSessions) {
            await sdk.queries.messagingSessionRecovery.prepareReset();
          } else {
            const ns = await sdk.readSessionBlob();
            if (!ns || ns.length === 0) {
              encryptedSession =
                profile.session && profile.session.length > 0
                  ? profile.session
                  : undefined;
              usedLegacySessionFallback = encryptedSession !== undefined;
              if (!encryptedSession && sessionMigrationPending) {
                throw new MessagingSessionRecoveryRequiredError('missing');
              }
            } else {
              encryptedSession = ns;
            }
          }
        } else {
          encryptedSession =
            profile.session && profile.session.length > 0
              ? profile.session
              : undefined;
        }

        const persistOpenedSession = createOnPersist(profile.userId);
        let sessionPersistenceEnabled = !method.resetMessagingSessions;
        try {
          await sdk.openSession({
            mnemonic,
            identityDerivationVersion:
              profile.security.identityDerivationVersion,
            encryptedSession,
            encryptionKey,
            onPersist: async (blob, key) => {
              if (sessionPersistenceEnabled) {
                await persistOpenedSession(blob, key);
              }
            },
            // Start only after the migration journal and lastSeen save commit.
            publishPublicKey: false,
            autoStartPolling: migrationActive ? false : undefined,
          });
        } catch (error) {
          if (
            sessionMigrationPending &&
            !method.resetMessagingSessions &&
            error instanceof UnreadableMessagingSessionError
          ) {
            throw new MessagingSessionRecoveryRequiredError('unreadable');
          }
          throw error;
        }
        sessionOpenedThisCall = true;

        if (method.resetMessagingSessions) {
          const discussions = await sdk.queries.discussions.getByOwner(
            profile.userId
          );
          for (const discussion of discussions) {
            if (
              !discussion.weAccepted ||
              discussion.contactUserId === SELF_CONTACT_ID
            ) {
              continue;
            }
            const reopened = await sdk.discussions.createSessionForContact(
              discussion.contactUserId,
              new Uint8Array(0),
              { resetQueue: false, triggerRefresh: false }
            );
            if (!reopened.success) throw reopened.error;
          }
          await sdk.persistSessionBlob(sdk.getEncryptedSession());
          sessionPersistenceEnabled = true;
        } else if (migrationActive && usedLegacySessionFallback) {
          // Promote the readable legacy SQL fallback before clearing it. A
          // crash after this atomic namespace write simply resumes phase 4.
          await sdk.persistSessionBlob(sdk.getEncryptedSession());
        }

        if (migrationActive) await completeMigrationPhase(4);
        callerOwnedEncryptionKey = null;

        const lastSeen = new Date();
        const updatedProfile = {
          ...profile,
          session: migrationState ? new Uint8Array(0) : profile.session,
          lastSeen,
        };
        await getSdk().profiles.save(updatedProfile);
        if (migrationActive) await completeMigrationPhase(5);
        sdk.startPublicKeyPublication();
        if (migrationActive) sdk.polling.start();

        useAppStore.getState().setIsInitialized(true);
        wipeAccountPrivateKey(get().account);
        useAppStore.getState().hydrateAccountSettings(accountSettings);
        set({
          userProfile: updatedProfile,
          account: derivedAccount,
          evmAddress: derived.evmAddress,
          encryptionKey,
          isLoading: false,
          lockedByUser: false,
        });
        accountTransferred = true;

        fetchMnsDomainsIfEnabled(updatedProfile, get().provider);
      } catch (error) {
        const sdk = getSdk();
        if (sessionOpenedThisCall && sdk.isSessionOpen) {
          try {
            await sdk.closeSession();
          } catch (closeError) {
            logger.error('Failed to close rejected login session:', closeError);
          }
        } else if (callerOwnedEncryptionKey) {
          freeEncryptionKey(callerOwnedEncryptionKey);
          callerOwnedEncryptionKey = null;
        }
        if (!accountTransferred) wipeAccountPrivateKey(derivedAccount);

        // If we unlocked the slot during this call but failed before
        // openSession, re-lock so the next attempt re-probes from
        // 'locked'. Without this, an attempt that lands on a deleted
        // slot's surviving keypair (its secret still unlocks an empty
        // DB) leaves storageState='unlocked' and every subsequent
        // login skips the unlock step (state-machine guard) and keeps
        // reading the wrong slot until the app is restarted.
        if (unlockedThisCall) {
          if (sdk.isSecureStorage && sdk.storageState === 'unlocked') {
            try {
              if (sdk.isSessionOpen) {
                await sdk.closeSession();
              }
              await sdk.secureStorageLock();
            } catch (lockErr) {
              logger.error(
                'Failed to re-lock after loadAccount error:',
                lockErr
              );
            }
          }
        }
        logger.error('Error loading account:', error);
        set({ isLoading: false, privateMigrationPhase: null });
        throw error;
      }
    },

    resetAccount: async () => {
      set({ isLoading: true });
      try {
        await resetAllAccountStorage();
      } catch (error) {
        logger.error('Error resetting all accounts:', error);
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
        useAppStore.getState().resetAccountSettings();

        set({
          ...clearAccountState(),
          lockedByUser: options?.lockedByUser ?? true,
        });
      } catch (error) {
        logger.error('Error logging out:', error);
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
      // with the user's password, and `finalizeOnboarding` doesn't have
      // access to it after setupAccount drops it from scope.
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

    configureBiometricLogin: async (password: string, syncToICloud = false) => {
      const profile = get().userProfile;
      if (!profile || !getSdk().isSessionOpen) {
        throw new Error('No authenticated user');
      }

      // Verify against the active profile before replacing the singleton. This
      // action intentionally does not inspect which account the existing
      // credential opens, so Settings cannot become an association oracle.
      const verified = await auth(profile, password);
      freeEncryptionKey(verified.encryptionKey);

      const result = await storeBiometricPassword(password, syncToICloud);
      if (!result.success) {
        throw new Error(result.error || 'Biometric setup failed');
      }
    },

    showBackup: async (
      password: string
    ): Promise<{
      mnemonic: string;
      privateKey: string;
    }> => {
      try {
        const state = get();
        const profile = state.userProfile;
        if (!profile || !getSdk().isSessionOpen) {
          throw new Error('No authenticated user');
        }

        const authenticated = await auth(profile, password);
        let backupAccount: Account | undefined;
        try {
          const derived = await deriveAccountFromMnemonic(
            authenticated.mnemonic,
            profile.security.identityDerivationVersion
          );
          backupAccount = derived.account;
          return {
            mnemonic: authenticated.mnemonic,
            privateKey: backupAccount.privateKey.toString(),
          };
        } finally {
          wipeAccountPrivateKey(backupAccount);
          freeEncryptionKey(authenticated.encryptionKey);
        }
      } catch (error) {
        logger.error('Error showing mnemonic backup:', error);
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
        logger.error('Error marking mnemonic backup as complete:', error);
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
        logger.error('Error checking for existing account:', error);
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
        logger.error('Error getting existing account info:', error);
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
        logger.error('Error getting all accounts:', error);
        return [];
      }
    },

    persistSession: async () => {
      const state = get();
      const { userProfile } = state;

      if (!getSdk().isSessionOpen || !userProfile) {
        logger.warn(
          'No session, user profile, or encryption key to persist, skipping persistence'
        );
        return;
      }

      try {
        const sessionBlob = getSdk().getEncryptedSession();
        if (!sessionBlob) {
          logger.warn('Failed to get encrypted session');
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
        logger.error('Error persisting session:', error);
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
        logger.error('Error updating username:', error);
        throw error;
      }
    },
  };
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
    logger.error('Error initializing provider:', error);
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
