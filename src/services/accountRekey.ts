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
import { claimRekey, waitForOtherWindows } from './rekeyTabs';

/**
 * In-place rekey of the whole secure store: set or change the password of
 * one or several accounts, or refresh every key without changing any.
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
 * - The key-derivation work is the same whatever the number of accounts
 *   supplied: missing ones are made up with padding rounds, so the duration
 *   of the operation does not count accounts. Work that depends on how much
 *   an account holds (notes, messaging session) is not padded.
 */

export interface RekeyEntry {
  /** What opens the account today: its password or its biometric secret. */
  credential: string;
  /** New password for that account. Omit to keep the current one. */
  newPassword?: string;
}

export interface RekeyRequest {
  /**
   * Every account to keep, in any order. The account that is logged in right
   * now must be one of them. Any number of them may change password in the
   * same operation; none at all is "refresh keys".
   */
  accounts: RekeyEntry[];
  /**
   * Result of the single biometric prompt, when the user accepted it. An
   * entry whose credential is this secret is dropped silently if the secret
   * opens no account (a stale credential), and the stored secret is rewritten
   * afterwards.
   */
  biometric: BiometricUpdateHandle | null;
  /**
   * Create one new account in the same operation, in a free slot that is
   * never reported. Accounts not listed in `accounts` are still erased.
   */
  newAccount?: NewAccountRequest;
}

export interface NewAccountRequest {
  password: string;
  username: string;
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
  /**
   * The credential may open no account at all (a stale biometric secret).
   * That must not fail the operation, nor be reported.
   */
  bestEffort?: boolean;
}

/** A device holds at most three accounts. */
const ROUNDS = 3;

/** Syntactically valid recovery phrase used only to pad timing. */
const PADDING_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** A password that opens nothing. */
function paddingPassword(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
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
    // A typed password replacing a device-generated secret leaves an account
    // indistinguishable from one created with a password.
    if (account.finalPassword !== account.oldPassword) {
      delete security.passwordless;
    }

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
 * The fixed work of `rewriteInnerKeys` for an account that does not exist:
 * one storage unlock attempt, one fresh profile key, two profile
 * authentications. Never fails the operation.
 */
async function paddingRewrite(sdk: GossipSdk): Promise<void> {
  const password = paddingPassword();
  try {
    await sdk.secureStorageUnlock(password);
    const made = await createPasswordSecurity(PADDING_MNEMONIC, password);
    freeKey(made.encryptionKey);
    const profile = { security: made.security } as UserProfile;
    for (let pass = 0; pass < 2; pass++) {
      freeKey((await auth(profile, password)).encryptionKey);
    }
  } catch (error) {
    logger.warn('Rekey padding round did not complete:', error);
  }
}

/**
 * After the switch: tell each kept account that its login journal, finished
 * in the previous generation, is finished in this one too, and record the
 * new account's journal as complete (it was created in this generation).
 * The journal exists to carry data over from a restored backup; these
 * accounts have nothing to carry over. One unlock and one journal write per
 * account, padded like the rest.
 *
 * This is not atomic with the switch. An account that misses it walks the
 * journal at its next login, which is what happened before this existed.
 */
async function carryJournalsOver(
  sdk: GossipSdk,
  kept: AdmittedAccount[],
  newAccount: NewAccountRequest | undefined,
  epochBefore: string | null
): Promise<void> {
  const epochAfter = sdk.accountGenerationEpoch;
  if (!epochBefore || !epochAfter || epochAfter === epochBefore) return;
  const rounds: Array<{ password: string; created: boolean }> = [
    ...kept.map(account => ({
      password: account.finalPassword,
      created: false,
    })),
    ...(newAccount ? [{ password: newAccount.password, created: true }] : []),
  ];
  for (let round = 0; round < Math.max(ROUNDS, rounds.length); round++) {
    const account = rounds[round];
    try {
      if (!account) {
        await sdk.secureStorageUnlock(paddingPassword());
        continue;
      }
      if (!(await sdk.secureStorageUnlock(account.password))) continue;
      try {
        if (account.created) {
          await sdk.queries.privateMigration.beginCompleted(epochAfter);
        } else {
          await sdk.queries.privateMigration.carryOver(epochBefore, epochAfter);
        }
      } finally {
        await sdk.secureStorageLock();
      }
    } catch (error) {
      logger.warn('Could not carry a login journal over:', error);
    }
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
  newAccount?: NewAccountRequest
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
      else if (!account.bestEffort) rejected = true;
    }
    if (newAccount) {
      if (!(await sdk.secureStorageAdmitRekeyNew(newAccount.password))) {
        rejected = true;
      }
    }
    // Always the work of three admissions.
    const entries = accounts.length + (newAccount ? 1 : 0);
    for (let round = entries; round < ROUNDS; round++) {
      await sdk.secureStorageAdmitRekey(paddingPassword());
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
    if (newAccount) {
      await useAccountStore
        .getState()
        .createAccountInRekeyCandidate(
          newAccount.username,
          newAccount.password
        );
    }
    const filled = admitted.length + (newAccount ? 1 : 0);
    for (let round = filled; round < ROUNDS; round++) {
      await paddingRewrite(sdk);
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
    await carryJournalsOver(sdk, admitted, newAccount, epochBefore);
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

  const biometricSecret = request.biometric?.password;
  const accounts: AdmittedAccount[] = request.accounts
    .filter(entry => entry.credential.length > 0)
    .map(entry => ({
      oldPassword: entry.credential,
      finalPassword: entry.newPassword ?? entry.credential,
    }));

  // The open account must be among the entries, or it would erase itself.
  // This is reported plainly: the user is inside this account, so there is
  // nothing to conceal about it.
  let current: AdmittedAccount | undefined;
  for (const account of accounts) {
    try {
      const verified = await auth(profile, account.oldPassword);
      freeKey(verified.encryptionKey);
      current = account;
      break;
    } catch {
      // Not this one.
    }
  }
  if (!current) throw new Error('The open account was not entered');

  for (const account of accounts) {
    account.bestEffort =
      account !== current && account.oldPassword === biometricSecret;
  }
  // A biometric secret that no entry uses is still kept if it opens an
  // account, so accepting the prompt never erases anything.
  if (
    biometricSecret !== undefined &&
    !accounts.some(account => account.oldPassword === biometricSecret)
  ) {
    accounts.push({
      oldPassword: biometricSecret,
      finalPassword: biometricSecret,
      bestEffort: true,
    });
  }

  store.setStatus('running');
  let releaseRekey: (() => void) | null = null;
  let releaseOtherWindows: (() => void) | null = null;
  try {
    // Other windows of the app log out and stay out until this is over
    // (see services/rekeyTabs.ts). Nothing has been touched if this fails.
    releaseRekey = await claimRekey();
    await useAccountStore.getState().logout({ lockedByUser: false });
    releaseOtherWindows = await waitForOtherWindows();
    const { reloadRequired, kept } = await rekeyLockedStore(
      sdk,
      accounts,
      request.newAccount
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
    releaseOtherWindows?.();
    releaseRekey?.();
    request.biometric?.dispose();
  }
}
