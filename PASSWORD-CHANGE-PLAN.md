# Plan: set or change an account password

Status: draft for discussion. Nothing in this document is implemented.

## Goal

Let a logged-in user:

1. **Set a password** on an account created with biometrics only (its current
   "password" is a random 32-byte secret held in the device keystore).
2. **Change an existing password.**
3. **Refresh the encryption keys** without changing any password. Required
   for deniability (see "Snapshot analysis", rule R3).

All three are the same operation: re-encrypt the store, with the initiating
account's password replaced or kept.

## Design decision

No wrapping layer. The whole store is re-encrypted into a new generation:

- every slot gets a fresh public keypair, whether it is the account being
  changed, another account, or an unused slot;
- the changed account's blocks are re-encrypted under keys derived from the
  new password;
- accounts whose password is not changing are still re-encrypted under their
  fresh keypair, with fresh nonces;
- the new generation replaces the old one atomically.

The result is indistinguishable from a store created directly with the new
password, and an old copy of the storage plus the old password decrypts nothing
written afterwards.

## Independence from import/export (decided)

The portable import/export code may not survive, so this feature **does not
call it and does not depend on it**. It gets its own module at each layer and
can be tailored to the one job it has: re-encrypt the live store in place.

Allowed dependencies are the core of the storage layer only, which onboarding
and normal operation already need:

- block primitives: `encrypt_block`, `decrypt_block`, `rerandomize_block`,
  `create_cover_block` (`block.rs`);
- key derivation and keypair envelopes: `derive_session_keys`,
  `derive_block_aead_key`, `KeypairFile` (`kdf.rs`, `keypair.rs`, `pq.rs`);
- unlocking: `unlock_session_unique` (`unlock.rs`);
- storage traits (`storage.rs`);
- the account-generation marker and its atomic switch, as used by onboarding
  (`secureStorageBeginOnboardingCandidate` / `Commit` / `Abort`,
  `installOnboardingGenerationWeb`).

One caveat: the generation helpers currently live in
`gossip-sdk/src/db/secure-storage-portable-web.ts`, the same file as import
and export. If that file is removed, the generation helpers that onboarding
uses must stay; this feature relies on the same ones.

### Reference reading (inspiration only, not dependencies)

| Idea to borrow                                                                                                                                                                | Where it is shown                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Admit passwords one by one, generate fresh keypairs for all three slots, then transform complete three-slot block batches without ever revealing which slot a password opened | `wasm/secure-storage/src/outer_migration.rs`                                  |
| Build a new generation beside the live one, then switch the marker and erase the old one in a single transaction; cross-tab lease                                             | `PortableWebImport.install` in `secure-storage-portable-web.ts`               |
| Native switch that is not atomic with file removal, with a durable "cleanup pending" owner                                                                                    | `native_api.rs`, `src/services/portableBackupNative.ts`                       |
| Serialised operations with a revocable authorisation                                                                                                                          | `src/services/portableImportCoordinator.ts`, `portableImportAuthorization.ts` |
| Crash-safe per-account journal at first login after a switch                                                                                                                  | `privateMigration` phases in `loadAccount` (`src/stores/accountStore.ts`)     |
| Nothing visible until everything is durable                                                                                                                                   | onboarding candidate (`initializePreparedAccountsAtomically`)                 |
| The invariants worth keeping                                                                                                                                                  | `PORTABLE-BACKUP-FORMAT.md`, "Import semantics"                               |

## What to build

### 1. Storage crate: a dedicated `rekey` module

A new module (for example `wasm/secure-storage/src/rekey.rs`) with its own
types, written for this purpose rather than adapted from the migration code:

- `RekeyPlan::new(domain, keypairs)`.
- `admit_keep(password)`: an account that keeps its password.
- `admit_change(old, new)`: the account whose password changes. Unlock the
  source with `old`; derive the destination wrap key and root key from `new`.
- Every admission does equal work on all slots and fails with one generic
  error, whether the password matched nothing, matched twice, or `new`
  collides with another admitted password or opens any source slot.
- `finalize()`: fresh keypair for all three slots. Admitted slots have their
  new secret key wrapped under the destination key (fresh nonce);
  non-admitted slots become dummies.
- `rekey_block_batch(namespace, index, [3 blocks])`: for admitted slots,
  decrypt with the source keys, encrypt with the destination root key under
  the new public key, then rerandomise; cover blocks elsewhere. Block nonces
  are random per encryption already (`encrypt_block`).
- Exposed through `wasm_api.rs`, `native_api.rs` and the UniFFI bindings under
  its own names.

Tailoring this allows, compared with the import path:

- no archive framing, digest or record validation, since the source is the
  live store and not an untrusted file;
- no version migration: source and destination are both the current suite;
- the destination can be designed from the start to be opened for writing
  before it becomes active, which section 4 needs.

### 2. SDK: a dedicated in-place rekey operation

An SDK entry point of its own (for example `sdk.rekeyAccounts(...)`), with its
own worker messages and its own native calls:

1. Take the exclusive storage lease; refuse if a session is doing I/O.
2. Create a staged generation beside the active one.
3. Read the active generation's keypairs and blocks directly, coordinate by
   coordinate, feed them through the `rekey` module, write the results into
   the staged generation.
4. Open the staged generation for the inner-key rewrite (section 4).
5. Switch the generation marker and erase the old generation: one IndexedDB
   transaction on web; on native, a durable "cleanup pending" owner so a failed
   erase is retried before storage is used again.
6. A leftover staged generation found at startup is discarded.

Cost: about twice the storage for the duration, and every block is
re-encrypted and rerandomised.

### 3. Authorisation

A password change runs from a logged-in session, so it has its own
authorisation, separate from the onboarding grant:

- granted only from an authenticated session that has just re-verified the
  current password (or passed the biometric prompt);
- valid for one operation, and revoked if the session locks or another tab
  takes over;
- backed by an exclusive lease, so two tabs or a background sync cannot
  interleave.

### 4. Inner keys (inside the account database)

Two things inside the account are encrypted with a second password-derived key
(`createPasswordSecurity` in `src/stores/utils/auth.ts`, with its own random
salt): the recovery phrase, and the messaging session blob. The block-level
rekey treats them as opaque bytes, so they must be re-encrypted separately.

The hazard is a crash that leaves an account whose storage opens with the new
password but whose contents still need the old one.

**Decided: no hand-off record, if the storage layer allows it.** Rewrite the
inner keys inside the staged generation, before it becomes active:

1. Build the new generation next to the live one (sections 1 and 2).
   The live store is untouched and still opens with the old password.
2. Open **every admitted account** in the staged generation, one after the
   other, whether or not its password changes. All passwords are still in
   memory at this point. For each: decrypt the recovery phrase and the session
   blob with its old inner key, write them back under a fresh inner key (new
   random salt) derived from its password after the operation.
3. Switch generations atomically.

Treating every admitted account the same way is a deniability requirement,
not a convenience: see "Snapshot analysis", rule R1. For the same reason this
step must not write anything that only the initiating account would get (no
"last changed" timestamp, no journal row, no `updatedAt` bump).

A crash before step 3 discards the staged generation: the account is entirely
old. A crash after step 3 leaves it entirely new. There is no intermediate
state, no journal step and no extra record.

Because the staged generation is ours to design (section 2), it is built to be
openable for writing before the switch. Onboarding already writes a complete
account into a not-yet-committed candidate, which shows the storage layer can
do it; whether the same primitive can be reused as is, or needs extending, is
the first thing to prove.

Fallback only if that turns out impossible: a temporary record inside the
encrypted database holding the old inner key encrypted under the new one,
consumed and deleted at the first login after the switch.

### 5. Other accounts on the device

**Decided: every slot gets a new keypair, and all passwords are collected up
front, before anything is modified.**

A slot cannot be given a new keypair without its password, so any account
whose password is not entered is replaced by an empty slot and permanently
erased. The import code makes the same choice for accounts left out of a
restore.

Flow:

1. One screen collects everything first: the current credential, the new
   password (twice), and the passwords of the other accounts to keep.
2. All of them are admitted to the migration plan. Any wrong password, any
   duplicate, or a new password that collides with another account stops the
   operation here, with nothing written.
3. Only then does the re-encryption start.

Rules for that screen:

- It looks the same for every user: it never shows how many accounts exist,
  and a wrong entry gets one generic error that does not say which password
  failed or whether it matched a slot.
- It states plainly that accounts whose password is not entered will be
  erased, and asks for an explicit confirmation before starting.
- Up to two additional password fields, always offered, since the device holds
  at most three accounts.
- **Keeping a biometric-only account.** Its password is a random secret that
  cannot be typed, so it is entered by fingerprint: when the device has
  biometrics, the screen always shows a "keep the account unlocked by
  biometrics" step, whether or not such an account exists (same rule as the
  biometric button on the login screen). The secret read from the keystore is
  admitted like any other password to keep. Declining the prompt means that
  account is not entered and will be erased, and the confirmation says so.
  This prompt is the same one used to update the biometric entry (section 6),
  so there is still only one fingerprint prompt per operation.
- A kept biometric-only account stays biometric-only: same secret, "no
  password yet" marker untouched, fresh keys and inner salt like every other
  admitted account.

### 6. App work

- **Settings → Security**: replace the "Set or change password" stub with the
  real flow: verify current credential → new password + confirm → other
  accounts' passwords → progress screen that cannot be cancelled once the
  install starts → back to login.
- **Biometric-only accounts**: the "old password" is read from the keystore
  through the biometric prompt (`authenticateBiometricLogin`).
- **Biometric login afterwards (decided)**: the end state must be exactly
  what "create with a password, then enable biometrics" produces today, which
  is the user's password stored in the keystore behind the biometric prompt
  (`configureBiometricLoginWithRollback`). So after a successful switch the
  new password replaces the stored secret.
  - Do it after the generation switch, never before. If the keystore write
    fails, the account still opens with the typed password; reuse the existing
    "accounts saved, biometrics could not be enabled, retry or continue"
    screen.
  - Aim for one biometric prompt for the whole operation: the prompt that
    reads the old secret at the start should also authorise storing the new
    one. Today the store function raises its own prompt, so this needs a small
    addition to `biometricService.ts` (native: write under the same
    authenticated flow; WebAuthn: re-encrypt under the key already obtained).
  - The app does not know which account the device's single biometric
    credential belongs to, and must not reveal it. Always run the same step
    when biometrics are available: prompt, read the stored secret, compare it
    in memory with the old passwords of all admitted accounts. If it matches
    one, store that account's password as it is after the operation (even if
    unchanged, so the stored entry is rewritten either way). If it matches
    none, leave it untouched. Show the same result in every case. See rule R2.
  - Post-commit steps are this feature's own short list (biometric credential,
    in-memory session state). Nothing else account-linked needs clearing,
    since the accounts are the same ones.
- **"No password yet" marker**: record inside the encrypted account data that
  the account was created with biometrics only, so export can require a
  password (see below) and Settings can say "Set" versus "Change". Write it at
  biometric creation and **remove** it when a password is set, so that
  afterwards the account is indistinguishable from one created with a
  password. Absent means "has a password", which covers every existing
  account. The profile security envelope has a strict parser, so the marker
  probably belongs in account settings rather than there; to check.
- **Stop background activity** for the duration: polling, the Android
  foreground service and the background runner.
- **Password strength (decided)**: the same rule as everywhere else,
  `validatePassword` from the SDK (currently at least 8 characters). No
  special rule for this screen.

### 7. Backup export gating (only while export exists)

A backup file exported from a biometric-only account cannot be restored
anywhere, because the secret that opens it never leaves the phone.

- In Settings, when the "no password yet" marker is present: require setting
  a password before exporting.
- On the login screen ("Back up all accounts"), where no account is open and
  nothing may be revealed: a generic warning that accounts without a password
  cannot be restored from the file.
- Until this feature ships: block export from biometric-only accounts.

## Snapshot analysis

Adversary: has a copy of the device storage from before the operation and one
from after, and obtains the decoy account's password afterwards. If the decoy
password did not change, that also opens the decoy in the "before" copy.
Question: can they tell how many accounts exist, or that any account exists
besides the decoy?

### What the two copies show

| Observable                                  | Before vs after                                  | Depends on the number of accounts?        |
| ------------------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| The three public keys                       | all three differ                                 | No: dummies get fresh keys too            |
| The three wrapped secret keys               | all differ, same size                            | No                                        |
| Every block of every slot and namespace     | all differ (fresh encryption, then rerandomised) | No                                        |
| Block count per namespace                   | unchanged                                        | No: the operation never grows or compacts |
| Generation marker                           | new random 32-hex value, no timestamp or counter | No                                        |
| Decoy contents (readable with its password) | see rules below                                  | Only if the rules below are broken        |
| Biometric credential entry                  | see rule R2                                      | Only if R2 is broken                      |

A slot that held a hidden account and a slot that was always empty look the
same before, and the same after, whether the hidden account was kept or
erased.

### Scenarios

| Who starts it  | What changes                               | Decoy admitted? | What the adversary sees in the decoy   | Verdict                                                         |
| -------------- | ------------------------------------------ | --------------- | -------------------------------------- | --------------------------------------------------------------- |
| Decoy          | decoy password                             | n/a             | new password, fresh inner salt         | Safe: "I changed my password"                                   |
| Decoy          | nothing ("refresh keys")                   | n/a             | same password, fresh inner salt        | Safe: "I refreshed my keys"                                     |
| Decoy          | decoy password, hidden account kept        | n/a             | as first row                           | Safe: hidden slot is indistinguishable from a regenerated dummy |
| Decoy          | decoy password, hidden account not entered | n/a             | as first row                           | Safe for deniability; the hidden account is erased              |
| Hidden account | hidden password                            | yes             | same password, fresh inner salt        | **Safe only with R1 and R3**, otherwise a leak (below)          |
| Hidden account | hidden password                            | no              | decoy is erased                        | No leak, but the user no longer has a decoy to hand over        |
| Any            | interrupted before the switch              | any             | old state, plus a leftover staged copy | Safe: shows an operation was started, nothing about accounts    |

### The leak in the earlier draft, and the rules that close it

The earlier draft rewrote the inner keys of the changing account only, and
offered the operation only as a password change. Then, when a **hidden**
account changes its password with the decoy kept: every public key and the
generation marker change, yet the decoy opens with the same password in both
copies and its contents are byte-for-byte unchanged. The only explanation is
that some other account changed its password, which proves a second account
exists.

- **R1. Every admitted account is treated identically.** Fresh keypair, fresh
  outer nonces, fresh inner salt, recovery phrase and session blob
  re-encrypted. Nothing is written for the initiating account that is not
  written for the others. After the operation, a kept decoy looks exactly like
  a decoy that ran the operation itself.
- **R2. The biometric entry is updated by a rule that does not depend on who
  started the operation** (section 6): rewritten whenever its secret matches
  any admitted account, untouched otherwise.
- **R3. The operation must be available without changing any password**
  ("Refresh encryption keys"), from any account, as an ordinary action. This
  gives the innocent explanation for "everything changed but my password did
  not". Without it, R1 alone is not enough.
- **R4. No durable marker written by this feature names an account, a slot or
  a count**: lease, authorisation, staged-generation and cleanup-pending
  markers carry only random identifiers.
- **R5. Block counts are copied as they are.** No compaction and no padding
  during the operation.

### Outside this operation (not changed by it, not audited here)

- **Store growth over time.** The block count only ever grows. With the decoy
  password an adversary knows how much the decoy needs; if the store grew
  between two copies while the decoy did not, something else wrote. Freed
  blocks are kept as cover, so "I deleted data" is a possible explanation, but
  this channel exists today regardless of password changes.
- **Biometrics bound to a hidden account.** A forced fingerprint then opens
  it. Unchanged by this feature.
- **Per-account data kept outside the encrypted store** (background-sync
  state, notifications, logs). I have not audited what the last-used account
  leaves there.
- **Deleted data on flash storage.** Erasing the old generation is a logical
  delete; forensic recovery of old blocks is out of scope.

## Things to verify before starting

- **Can the onboarding candidate primitive be opened for writing on a store
  that already has a committed generation?** Section 4 depends on a writable
  staged generation. Check on web and native; extend it if not.
- **Does a generation switch disturb messaging sessions?** At the first login
  after a new generation, `loadAccount` runs journal phases written for
  restored backups, including a "messaging session recovery" path. An in-place
  change must not reset sessions or re-announce to contacts, so the new
  generation must be recognisable as a rekey, or must not trigger that journal
  at all.
- **Duration and storage on a real phone.** Every block is decrypted,
  re-encrypted and PQ-rerandomised. Measure on a large account, on Android and
  iOS, in a release build of the Rust library.
- **Native crash windows.** A native switch is not atomic with file removal;
  design and test the "cleanup pending" recovery for this operation.
- **Why biometric-only creation was removed** in commit `25dc6559`
  (22 August 2026), since "New account" now reintroduces a form of it.

## Suggested order of work

1. Storage crate: `rekey` module with tests and frozen test vectors; wasm and
   native bindings.
2. SDK (web first): writable staged generation, direct read of the active
   generation, atomic switch, startup discard of leftovers. Prove the
   inner-key rewrite inside the staged generation here.
3. App: authorisation, Settings flow with all passwords collected up front,
   biometric credential update, "no password yet" marker.
4. Native (Android, then iOS): same operation, crash-recovery testing.
5. Export gating, if export still exists by then.

## Test plan

- Rust: change one of three accounts; old password fails, new password opens
  identical data; the other admitted accounts open with unchanged passwords;
  all three public keys differ from the source; non-admitted slot is a dummy.
- Rust: new password equal to another account's password is rejected with the
  generic error.
- SDK (browser, real storage): crash injected during staging, after the
  inner-key rewrite but before install, and between install and
  old-generation erase. Before install the account must be entirely old; after
  it, entirely new.
- App: a wrong or duplicate password on the collection screen stops the
  operation with nothing written and one generic error.
- App: an account whose password was not entered is gone afterwards, and the
  screen said so before starting.
- App: set a password on a biometric-only account, relaunch, log in with the
  password and with biometrics; recovery phrase still shows; an existing
  conversation still sends and receives. Compare the stored profile and
  keystore entry with those of an account created with the same password and
  then given biometrics: same shape, no leftover marker.
- App: export is refused before a password is set and works after.
- Devices: full run on Android and iOS with a large account.

## Decisions taken

1. **Other accounts**: all public keys change. All passwords are collected on
   one screen before anything starts; accounts not entered are erased.
2. **Inner keys**: no hand-off record. Rewrite them inside the staged
   generation before the switch, provided the storage layer allows it.
3. **Biometric login**: after the change the new password is stored behind
   the fingerprint, giving the same end state as "password first, biometrics
   second" today.
4. **Independence**: own modules at every layer; import/export code is
   reference reading only. The source is read directly from the live store,
   not through an export stream.
5. **Password strength**: the usual rule (`validatePassword`), nothing
   stricter.

6. **Deniability rules R1–R5** from "Snapshot analysis" are requirements:
   all admitted accounts are treated identically, and the operation is also
   offered without a password change ("Refresh encryption keys").

## Open decisions

None.
