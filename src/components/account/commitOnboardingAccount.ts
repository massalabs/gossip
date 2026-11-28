import { type EncryptionKey, generateMnemonic } from '@massalabs/gossip-sdk';
import {
  type OnboardingCandidateHandle,
  useAccountStore,
} from '../../stores/accountStore';
import { useAppStore } from '../../stores/appStore';
import {
  consumeOnboardingCreationAuthority,
  restoreOnboardingCreationAuthorityAfterRollback,
  type OnboardingStorageModeLease,
} from '../../services/portableImportAuthorization';
import {
  preparePasswordAccount,
  type PreparedPasswordAccount,
  wipePreparedPasswordAccount,
} from '../../stores/utils/auth';
import { logger } from '../../utils/logger.ts';
import {
  readStagedMnemonic,
  readStagedPassword,
  type StagedAccount,
} from './stagedAccount';

/** What the automatic login needs so it does not redo creation's work. */
export interface FreshAccountLogin {
  mnemonic: string;
  /** Owned by whoever receives this object. */
  encryptionKey: EncryptionKey;
}

/** The single onboarding account, fully built in memory and not yet durable. */
export interface OnboardingAccountBuild {
  /**
   * Make the account durable. On success the one-time creation grant is
   * revoked and storage is locked. On failure the grant is restored, nothing
   * of the account remains, and the error is rethrown.
   */
  commit: (
    creationModeLease: OnboardingStorageModeLease | undefined
  ) => Promise<FreshAccountLogin | undefined>;
  /** Throw the account away. Nothing durable has changed. */
  abort: () => Promise<void>;
}

/**
 * Build the single onboarding account in memory.
 *
 * Nothing here is durable, so this can run before the user has committed to
 * anything, for example while a biometric prompt is on screen. Storage setup
 * runs natively while this thread prepares the account's keys; preparation
 * still proves that the password decrypts and reopens the exact identity and
 * session before `commit` can be reached.
 *
 * The caller owns (and wipes) `account`.
 */
export async function buildOnboardingAccount(
  account: StagedAccount
): Promise<OnboardingAccountBuild> {
  const importedMnemonic = readStagedMnemonic(account);
  const mnemonic = importedMnemonic ?? generateMnemonic(256);
  let preparation: Promise<PreparedPasswordAccount> | null = null;
  const prepare = (): Promise<PreparedPasswordAccount> =>
    (preparation ??= preparePasswordAccount(
      mnemonic,
      readStagedPassword(account),
      importedMnemonic !== null
    ).then(prepared => {
      if (account.passwordless) prepared.security.passwordless = true;
      return prepared;
    }));
  const wipePrepared = async (): Promise<void> => {
    const prepared = preparation ? await preparation.catch(() => null) : null;
    if (prepared) wipePreparedPasswordAccount(prepared);
  };

  let candidate: OnboardingCandidateHandle;
  try {
    candidate = await useAccountStore.getState().buildOnboardingCandidate([
      {
        username: account.username,
        password: readStagedPassword(account),
        mnemonic,
        prepared: prepare,
      },
    ]);
  } catch (error) {
    logger.error('Error building onboarding account:', error);
    await wipePrepared();
    useAppStore.getState().setIsInitialized(false);
    throw error;
  }

  return {
    commit: async creationModeLease => {
      let creationAuthorityOwner: string | null = null;
      try {
        creationAuthorityOwner =
          consumeOnboardingCreationAuthority(creationModeLease);
        await candidate.commit();
      } catch (error) {
        logger.error('Error creating onboarding account:', error);
        // A rejected authority check leaves the candidate alive.
        await candidate.abort();
        try {
          restoreOnboardingCreationAuthorityAfterRollback(
            creationAuthorityOwner
          );
        } catch (restoreError) {
          logger.error('Failed to restore onboarding authority:', restoreError);
        }
        await wipePrepared();
        useAppStore.getState().setIsInitialized(false);
        throw error;
      }

      useAppStore.getState().setSecureAccountCreationAllowed(false);
      const prepared = preparation ? await preparation.catch(() => null) : null;
      let login: FreshAccountLogin | undefined;
      if (prepared?.loginKey) {
        login = { mnemonic, encryptionKey: prepared.loginKey };
        prepared.loginKey = undefined;
      }
      if (prepared) wipePreparedPasswordAccount(prepared);
      return login;
    },
    abort: async () => {
      await candidate.abort();
      await wipePrepared();
    },
  };
}

/**
 * Build and durably create the single onboarding account in one call.
 * The caller logs in with the same password afterwards.
 */
export async function commitOnboardingAccount(
  account: StagedAccount,
  creationModeLease: OnboardingStorageModeLease | undefined
): Promise<void> {
  const build = await buildOnboardingAccount(account);
  const login = await build.commit(creationModeLease);
  if (login) {
    const pointer = (login.encryptionKey as unknown as { __wbg_ptr?: number })
      .__wbg_ptr;
    if (pointer === undefined || pointer !== 0) login.encryptionKey.free();
  }
}
