import { generateMnemonic } from '@massalabs/gossip-sdk';
import { useAccountStore } from '../../stores/accountStore';
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

/**
 * Durably create the single onboarding account.
 *
 * Nothing reaches durable account storage until the password has decrypted
 * and reopened its exact identity/session in RAM. The atomic installer then
 * either exposes no candidate account or the whole committed generation, so
 * a failure here never leaves a partially created account behind.
 *
 * On success the one-time creation grant is revoked and storage is locked;
 * the caller logs in with the same password. On failure the grant is restored
 * and the error is rethrown. The caller owns (and wipes) `account`.
 */
export async function commitOnboardingAccount(
  account: StagedAccount,
  creationModeLease: OnboardingStorageModeLease | undefined
): Promise<void> {
  let prepared: PreparedPasswordAccount | null = null;
  let creationAuthorityOwner: string | null = null;

  try {
    const importedMnemonic = readStagedMnemonic(account);
    prepared = await preparePasswordAccount(
      importedMnemonic ?? generateMnemonic(256),
      readStagedPassword(account),
      importedMnemonic !== null
    );
    if (account.passwordless) prepared.security.passwordless = true;

    creationAuthorityOwner =
      consumeOnboardingCreationAuthority(creationModeLease);
    await useAccountStore.getState().initializePreparedAccountsAtomically([
      {
        username: account.username,
        password: readStagedPassword(account),
        prepared,
      },
    ]);
  } catch (error) {
    logger.error('Error creating onboarding account:', error);
    try {
      restoreOnboardingCreationAuthorityAfterRollback(creationAuthorityOwner);
    } catch (restoreError) {
      logger.error('Failed to restore onboarding authority:', restoreError);
    }
    useAppStore.getState().setIsInitialized(false);
    throw error;
  } finally {
    if (prepared) wipePreparedPasswordAccount(prepared);
  }

  useAppStore.getState().setSecureAccountCreationAllowed(false);
}
