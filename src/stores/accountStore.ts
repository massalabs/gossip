import { logger } from '../utils/logger.ts';
import { create } from 'zustand';
import {
  generateMnemonic,
  EncryptionKey,
  encodeUserId,
  UserProfile,
  SecureStorageRecoveryRequiredError,
  MessagingSessionRecoveryRequiredError,
  SELF_CONTACT_ID,
  UnreadableMessagingSessionError,
} from '@massalabs/gossip-sdk';

import { validateUsernameFormat } from '../utils/validation';
import { getSdk } from './sdkStore';
import { configureBiometricLogin as storeBiometricPassword } from '../services/biometricService';
import { finalizeCommittedAccountGenerationAuthority } from '../services/portableImportAuthorization';
import { resetAllAccountStorage } from '../services/unsupportedStorageReset';

import { Provider, Account } from '@massalabs/massa-web3';
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
import { registerAccountStoreSubscriptions } from './accountStore.subscriptions';

export type PrivateMigrationPhase = 1 | 2 | 3 | 4 | 5;

export type LoginMethod = {
  type: 'password';
  password: string;
  userId?: string;
  resetMessagingSessions?: boolean;
  /**
   * Only for the automatic login that immediately follows creating this
   * account in this app run. Carries what creation already proved and
   * derived, so login does not derive the password key again, and marks the
   * account as having nothing to carry over from an older generation.
   * `loadAccount` takes ownership of `encryptionKey`.
   */
  fresh?: { mnemonic: string; encryptionKey: EncryptionKey };
};

export interface PreparedOnboardingAccount {
  username: string;
  password: string;
  /**
   * The prepared account, or a function that prepares it. A function is
   * invoked once the account's storage slot is being allocated, so its
   * cryptography overlaps with the native storage work instead of preceding
   * it; `mnemonic` must then be supplied here.
   */
  prepared: PreparedPasswordAccount | (() => Promise<PreparedPasswordAccount>);
  mnemonic?: string;
}

/** An onboarding generation built in memory, not yet durable. */
export interface OnboardingCandidateHandle {
  /** Make every account in the candidate durable, atomically. */
  commit: () => Promise<void>;
  /** Discard the candidate. Nothing durable has changed. */
  abort: () => Promise<void>;
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
  buildOnboardingCandidate: (
    accounts: readonly PreparedOnboardingAccount[]
  ) => Promise<OnboardingCandidateHandle>;
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
  const sample = new Uint8Array(1);
  const unbiasedLimit = 256 - (256 % free.length);
  do {
    crypto.getRandomValues(sample);
  } while (sample[0] >= unbiasedLimit);
  return free[sample[0] % free.length];
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
      provider: null,
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
    prepared?:
      | PreparedPasswordAccount
      | (() => Promise<PreparedPasswordAccount>);
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

    // Requested now, consumed when the account exists: the round trip
    // overlaps with everything below instead of being waited for.
    const bulletinCounter = skipHistorical
      ? sdk.prefetchBulletinCounter()
      : undefined;

    interface AccountMaterial {
      encryptionKey: EncryptionKey;
      security: UserProfile['security'];
      encryptedSession?: Uint8Array;
    }
    const resolveMaterial = async (): Promise<AccountMaterial> => {
      if (!prepared) {
        const created = await createPasswordSecurity(mnemonic, password);
        return {
          encryptionKey: created.encryptionKey,
          security: created.security,
        };
      }
      const resolved =
        typeof prepared === 'function' ? await prepared() : prepared;
      if (new TextDecoder().decode(resolved.mnemonicBytes) !== mnemonic) {
        throw new Error('Prepared account identity mismatch');
      }
      if (resolved.encryptionKey) {
        // Preparation already proved this password decrypts this identity
        // and kept the key it derived; take it instead of deriving again.
        const encryptionKey = resolved.encryptionKey;
        resolved.encryptionKey = undefined;
        return {
          encryptionKey,
          security: resolved.security,
          encryptedSession: resolved.encryptedSession,
        };
      }
      const recovered = await auth(
        { security: resolved.security } as UserProfile,
        password
      );
      if (recovered.mnemonic !== mnemonic) {
        freeEncryptionKey(recovered.encryptionKey);
        throw new Error('Prepared account identity mismatch');
      }
      return {
        encryptionKey: recovered.encryptionKey,
        security: resolved.security,
        encryptedSession: resolved.encryptedSession,
      };
    };
    let materialPromise: Promise<AccountMaterial> | null = null;
    let material: AccountMaterial | null = null;
    const discardMaterial = async (): Promise<void> => {
      const pending = materialPromise;
      materialPromise = null;
      const owned =
        material ?? (pending ? await pending.catch(() => null) : null);
      material = null;
      if (owned) freeEncryptionKey(owned.encryptionKey);
    };

    // Passwords must identify exactly one account because the global biometric
    // credential deliberately stores no profile ID. Secure storage checks this
    // by probing slots below; classic storage checks existing profiles here.
    if (!sdk.isSecureStorage) {
      material = await resolveMaterial();
      const encryptionKey = material.encryptionKey;
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
      allocatedSlot = slot;
      // The native call is dispatched synchronously here. Slot allocation
      // and schema setup then run on the storage thread while this thread
      // prepares the account's keys, instead of one after the other.
      const creation = sdk.secureStorageCreate(slot, secret);
      materialPromise = resolveMaterial();
      materialPromise.catch(() => {});
      try {
        await creation;
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

        await discardMaterial();
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
      // Inside the try: a preparation failure must destroy the slot that
      // was just allocated for this account.
      material ??= await (materialPromise ?? resolveMaterial());
      materialPromise = null;
      const { encryptionKey, security } = material;
      const derived = await deriveAccountFromMnemonic(
        mnemonic,
        security.identityDerivationVersion
      );
      derivedAccount = derived.account;
      const userId = encodeUserId(derived.userIdBytes);

      await sdk.openSession({
        mnemonic,
        identityDerivationVersion: security.identityDerivationVersion,
        encryptedSession: material.encryptedSession,
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
        await getSdk().announcements.skipHistorical(bulletinCounter);
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
        await discardMaterial();
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

    buildOnboardingCandidate: async accounts => {
      const sdk = getSdk();
      if (!sdk.isSecureStorage || accounts.length === 0) {
        throw new Error('Atomic onboarding requires secure account data');
      }

      let candidateActive = false;
      let settled = false;
      const discard = async (): Promise<void> => {
        try {
          await cleanupSession();
        } catch (cleanupError) {
          logger.error(
            'Failed to close onboarding candidate session:',
            cleanupError
          );
        }
        if (candidateActive) {
          candidateActive = false;
          try {
            await sdk.secureStorageAbortOnboardingCandidate();
          } catch (abortError) {
            logger.error('Failed to discard onboarding candidate:', abortError);
          }
        }
        onboardingAllocatedSlots.clear();
        useAppStore.getState().resetAccountSettings();
        set({ ...clearAccountState(), isLoading: false });
      };

      try {
        set({ isLoading: true });
        onboardingAllocatedSlots.clear();
        await sdk.secureStorageBeginOnboardingCandidate();
        candidateActive = true;

        for (const account of accounts) {
          const mnemonic =
            typeof account.prepared === 'function'
              ? account.mnemonic
              : new TextDecoder().decode(account.prepared.mnemonicBytes);
          if (!mnemonic) {
            throw new Error('Lazily prepared account needs its mnemonic');
          }
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
      } catch (error) {
        settled = true;
        await discard();
        throw error;
      }

      return {
        commit: async () => {
          if (settled) throw new Error('Onboarding candidate is settled');
          settled = true;
          try {
            await sdk.secureStorageCommitOnboardingCandidate();
            candidateActive = false;
            finalizeCommittedAccountGenerationAuthority();
            onboardingAllocatedSlots.clear();
            useAppStore.getState().resetAccountSettings();
            set(clearAccountState());
          } catch (error) {
            await discard();
            throw error;
          }
        },
        abort: async () => {
          if (settled) return;
          settled = true;
          await discard();
        },
      };
    },

    initializePreparedAccountsAtomically: async accounts => {
      const candidate = await get().buildOnboardingCandidate(accounts);
      await candidate.commit();
    },

    loadAccount: async (method: LoginMethod) => {
      let unlockedThisCall = false;
      let callerOwnedEncryptionKey: EncryptionKey | null = null;
      let derivedAccount: Account | null = null;
      let accountTransferred = false;
      let sessionOpenedThisCall = false;
      let freshKeyTaken = false;
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
        // An account this app run just created has nothing to carry over
        // from an older generation: its journal is complete by construction.
        // Record that once, after the user is in (see the end of this
        // function), instead of walking six transactions now. If the write
        // never lands, the next login simply walks the journal as usual.
        const freshAccount =
          method.fresh !== undefined && migrationEpoch !== null;
        let migrationState = freshAccount
          ? {
              formatVersion: 1 as const,
              installationEpoch: migrationEpoch,
              completedPhase: 5,
            }
          : migrationEpoch
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
        if (method.fresh && !authResult) {
          authResult = method.fresh;
          freshKeyTaken = true;
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

        // Creation wrote this profile, with its last-seen time, moments ago.
        const updatedProfile = freshAccount
          ? profile
          : {
              ...profile,
              session: migrationState ? new Uint8Array(0) : profile.session,
              lastSeen: new Date(),
            };
        if (!freshAccount) await getSdk().profiles.save(updatedProfile);
        if (migrationActive) await completeMigrationPhase(5);
        sdk.startPublicKeyPublication();
        if (migrationActive) sdk.polling.start();
        if (freshAccount && migrationEpoch) {
          // Not awaited: the user is let in now and this finishes behind
          // them. Database access is serialized, so it cannot interleave
          // with another statement.
          void sdk.queries.privateMigration
            .beginCompleted(migrationEpoch)
            .catch(error => {
              logger.error('Failed to record the completed journal:', error);
            });
        }

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
        // `fresh.encryptionKey` is ours from the moment of the call.
        if (method.fresh && !freshKeyTaken) {
          freeEncryptionKey(method.fresh.encryptionKey);
        }

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

        const savedProfile = { ...updatedProfile, updatedAt: new Date() };
        await getSdk().profiles.save(savedProfile);
        set({ userProfile: savedProfile });
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

export type AccountStoreApi = typeof useAccountStoreBase;

registerAccountStoreSubscriptions(useAccountStoreBase);

export const useAccountStore = createSelectors(useAccountStoreBase);
