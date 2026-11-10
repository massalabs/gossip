import {
  type EncryptionKey,
  type GossipSdk,
  type UserProfile,
  generateUserKeys,
  SessionModule,
} from '@massalabs/gossip-sdk';
import { getSdk } from '../stores/sdkStore';
import { useAccountStore } from '../stores/accountStore';
import { useRekeyStore } from '../stores/rekeyStore';
import { auth, createPasswordSecurity } from '../stores/utils/auth';
import { logger } from '../utils/logger.ts';
import type { BiometricUpdateHandle } from './biometricService';

/**
 * In-place rekey of the whole secure store: set or change the current
 * account's password, or refresh every key without changing any password.
 *
 * What it guarantees (see PASSWORD-CHANGE-PLAN.md, "Snapshot analysis"):
 *
 * - Nothing durable changes until the final commit. Any failure before it
 *   leaves every account exactly as it was.
 * - Every account whose password is supplied is treated identically: new
 *   storage keys, and its recovery phrase and messaging session re-encrypted
 *   under a fresh inner key. Nothing is written for the account that started
 *   the operation that is not written for the others.
 * - Accounts whose password is not supplied are erased.
 */

export interface RekeyRequest {
  /** Credential of the account that is logged in right now. */
  currentPassword: string;
  /** New password for that account. Omit to keep it ("refresh keys"). */
  newPassword?: string;
  /** Passwords of the other accounts to keep. */
  otherPasswords: string[];
  /**
   * Result of the single biometric prompt, when the device has biometrics
   * and the user accepted it. Its secret is admitted as an account to keep
   * (unless it is the current account's own credential) and the stored
   * secret is rewritten afterwards.
   */
  biometric: BiometricUpdateHandle | null;
}

/** A supplied password was not accepted. Nothing was changed. */
export class RekeyRejectedError extends Error {
  constructor() {
    super('A password was not accepted');
    this.name = 'RekeyRejectedError';
  }
}

interface AdmittedAccount {
  oldPassword: string;
  finalPassword: string;
  /** A typed password replaces a device-generated secret. */
  clearsPasswordless: boolean;
}

function freeKey(key: EncryptionKey | undefined): void {
  if (!key) return;
  const pointer = (key as unknown as { __wbg_ptr?: number }).__wbg_ptr;
  if (pointer === undefined || pointer !== 0) key.free();
}

/**
 * Re-encrypt everything held under the profile key of the account that is
 * currently unlocked in the rekey candidate: the recovery phrase, the
 * messaging session and the notes-to-self.
 */
async function rewriteInnerKeys(
  sdk: GossipSdk,
  account: AdmittedAccount
): Promise<void> {
  const profile = await sdk.profiles.getMostRecent();
  if (!profile) throw new Error('Rekey candidate has no profile');

  let oldKey: EncryptionKey | undefined;
  let newKey: EncryptionKey | undefined;
  let verifyKey: EncryptionKey | undefined;
  let session: SessionModule | undefined;
  let userKeys: Awaited<ReturnType<typeof generateUserKeys>> | undefined;
  try {
    const authenticated = await auth(profile, account.oldPassword);
    oldKey = authenticated.encryptionKey;
    const fresh = await createPasswordSecurity(
      authenticated.mnemonic,
      account.finalPassword
    );
    newKey = fresh.encryptionKey;

    const security: UserProfile['security'] = {
      ...profile.security,
      encKeySalt: fresh.security.encKeySalt,
      mnemonicBackup: {
        ...profile.security.mnemonicBackup,
        encryptedMnemonic: fresh.security.mnemonicBackup.encryptedMnemonic,
      },
    };
    if (account.clearsPasswordless) delete security.passwordless;

    const usesNamespace = sdk.usesSessionBlobNamespace;
    const namespaceBlob = usesNamespace ? await sdk.readSessionBlob() : null;
    const legacyBlob =
      profile.session && profile.session.length > 0 ? profile.session : null;
    const sessionBlob = namespaceBlob ?? legacyBlob;

    let rewrittenBlob: Uint8Array | null = null;
    if (sessionBlob) {
      userKeys = await generateUserKeys(authenticated.mnemonic);
      session = new SessionModule(userKeys);
      userKeys.free();
      userKeys = undefined;
      session.load(sessionBlob, oldKey);
      rewrittenBlob = session.toEncryptedBlob(newKey);
      // Prove the rewritten blob opens under the new key before it replaces
      // the only copy in this candidate.
      session.load(rewrittenBlob, newKey);
    }

    // Notes-to-self are encrypted under the profile key itself, so they
    // must move to the new key together with it.
    const notes = await sdk.reencryptSelfMessages(
      profile.userId,
      oldKey,
      newKey
    );
    if (notes.unreadable > 0) {
      logger.warn(
        `${notes.unreadable} note(s) were already unreadable and were left as they are`
      );
    }

    const updated: UserProfile = { ...profile, security };
    if (rewrittenBlob) {
      if (namespaceBlob) {
        // `persistSessionBlob` detaches its argument.
        await sdk.persistSessionBlob(rewrittenBlob.slice());
      } else {
        updated.session = rewrittenBlob;
      }
    }
    await sdk.profiles.save(updated);

    // Read back what a later login will read, and prove the final password
    // opens it.
    const saved = await sdk.profiles.getMostRecent();
    if (!saved) throw new Error('Rekey candidate lost its profile');
    const verified = await auth(saved, account.finalPassword);
    verifyKey = verified.encryptionKey;
    if (verified.mnemonic !== authenticated.mnemonic) {
      throw new Error('Rekey candidate identity mismatch');
    }
  } finally {
    userKeys?.free();
    session?.dispose();
    freeKey(oldKey);
    freeKey(newKey);
    freeKey(verifyKey);
  }
}

/**
 * Run the storage part of a rekey. The caller has already closed the
 * session and locked storage.
 *
 * Resolves `true` when the new generation is durable but this runtime
 * could not switch to it cleanly and must reload.
 */
export async function rekeyLockedStore(
  sdk: GossipSdk,
  accounts: AdmittedAccount[],
  bestEffortKeep: string[] = []
): Promise<{ reloadRequired: boolean; kept: AdmittedAccount[] }> {
  const epochBefore = sdk.accountGenerationEpoch;
  await sdk.secureStorageBeginRekey();
  let candidateBuilt = false;
  const admitted: AdmittedAccount[] = [];
  try {
    // Admit everything before judging, so the work done does not depend on
    // which password (if any) was wrong.
    let rejected = false;
    for (const account of accounts) {
      const ok = await sdk.secureStorageAdmitRekey(
        account.oldPassword,
        account.finalPassword === account.oldPassword
          ? undefined
          : account.finalPassword
      );
      if (ok) admitted.push(account);
      else rejected = true;
    }
    // The biometric secret may belong to no account at all (a stale
    // credential). That must not fail the operation, nor be reported.
    for (const password of bestEffortKeep) {
      if (await sdk.secureStorageAdmitRekey(password)) {
        admitted.push({
          oldPassword: password,
          finalPassword: password,
          clearsPasswordless: false,
        });
      }
    }
    if (rejected || admitted.length === 0) throw new RekeyRejectedError();

    await sdk.secureStorageBuildRekeyCandidate();
    candidateBuilt = true;

    for (const account of admitted) {
      if (!(await sdk.secureStorageUnlock(account.finalPassword))) {
        throw new Error('Rekey candidate does not open with its password');
      }
      try {
        await rewriteInnerKeys(sdk, account);
      } finally {
        await sdk.secureStorageLock();
      }
    }
  } catch (error) {
    try {
      if (candidateBuilt && sdk.storageState === 'unlocked') {
        await sdk.secureStorageLock();
      }
      await sdk.secureStorageAbortRekey();
    } catch (abortError) {
      logger.error('Failed to abandon rekey cleanly:', abortError);
    }
    throw error;
  }

  try {
    await sdk.secureStorageCommitRekeyCandidate();
    return { reloadRequired: false, kept: admitted };
  } catch (commitError) {
    // The commit is atomic but its answer can be lost. Ask storage which
    // generation is active instead of guessing.
    logger.error('Rekey commit did not report success:', commitError);
    let epochAfter: string | null = epochBefore;
    try {
      await sdk.refreshAccountGenerationState();
      epochAfter = sdk.accountGenerationEpoch;
    } catch (refreshError) {
      logger.error('Could not re-read the account generation:', refreshError);
      // Unknown outcome: the only safe continuation is a fresh runtime.
      return { reloadRequired: true, kept: admitted };
    }
    if (epochAfter !== epochBefore) {
      return { reloadRequired: true, kept: admitted };
    }
    try {
      await sdk.secureStorageAbortRekey();
    } catch (abortError) {
      logger.error('Failed to abandon rekey cleanly:', abortError);
    }
    throw commitError;
  }
}

/**
 * Full operation, started from Settings while logged in.
 *
 * Verifies the current credential against the open account, logs out, runs
 * the rekey, then updates the biometric credential. Progress is published
 * through `useRekeyStore` because the calling screen unmounts at logout.
 * Rejects only for problems found before anything was started.
 */
export async function startRekey(request: RekeyRequest): Promise<void> {
  const sdk = getSdk();
  const profile = useAccountStore.getState().userProfile;
  if (!sdk.isSecureStorage || !profile || !sdk.isSessionOpen) {
    throw new Error('No authenticated secure-storage account');
  }
  const store = useRekeyStore.getState();
  if (store.status === 'running') throw new Error('Rekey already running');

  // A wrong current password is reported plainly: the user is inside this
  // account, so there is nothing to conceal about it.
  const verified = await auth(profile, request.currentPassword);
  freeKey(verified.encryptionKey);

  const finalPassword = request.newPassword ?? request.currentPassword;
  const accounts: AdmittedAccount[] = [
    {
      oldPassword: request.currentPassword,
      finalPassword,
      clearsPasswordless:
        request.newPassword !== undefined &&
        profile.security.passwordless === true,
    },
    ...request.otherPasswords
      .filter(password => password.length > 0)
      .map(password => ({
        oldPassword: password,
        finalPassword: password,
        clearsPasswordless: false,
      })),
  ];
  const biometricSecret = request.biometric?.password;
  const bestEffortKeep =
    biometricSecret !== undefined &&
    !accounts.some(account => account.oldPassword === biometricSecret)
      ? [biometricSecret]
      : [];

  store.setStatus('running');
  try {
    await useAccountStore.getState().logout({ lockedByUser: false });
    const { reloadRequired, kept } = await rekeyLockedStore(
      sdk,
      accounts,
      bestEffortKeep
    );

    // Same rule whoever started the operation: if the stored biometric
    // secret belongs to an account that was kept, store that account's
    // password as it is now, changed or not. Otherwise leave it alone.
    if (request.biometric) {
      const owner = kept.find(
        account => account.oldPassword === biometricSecret
      );
      if (owner) {
        try {
          await request.biometric.replace(owner.finalPassword);
        } catch (error) {
          // The account still opens with its password; biometrics can be
          // re-enabled from Settings.
          logger.error('Biometric credential update failed:', error);
        }
      }
    }
    useRekeyStore.getState().setStatus('success', reloadRequired);
  } catch (error) {
    logger.error('Rekey failed:', error);
    useRekeyStore.getState().setStatus('error');
  } finally {
    request.biometric?.dispose();
  }
}
