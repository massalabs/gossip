# Plan: add an account after onboarding

Status: implemented (17 November 2026); see "Implementation status" at the end.

Settings → Security → Hidden accounts has an "Add a hidden account" button
(to be renamed "Create another account (3 max in total)")
that only shows "Not yet implemented". Today the only way to get more than
one account is "Multiple deniable accounts" at onboarding.

## Goal

Let a logged-in user add a new account, with its own password, to a device
that already has accounts. Afterwards nothing on the device may show that an
account was added: a snapshot taken before and after must look like a key
refresh or a password change.

## The constraint that shapes everything

A free slot and a slot holding a hidden account look exactly the same, by
design. The app cannot tell them apart without the hidden account's
password. Writing a new account into a slot that "looks free" may therefore
destroy a hidden account, and nothing would warn about it.

So the app can only place a new account safely when it knows every account
that must survive, which means their passwords. That is exactly what the
rekey already asks for: every account to keep is entered, every other slot
is treated as free.

**Decision proposed: adding an account is a rekey that also creates one
account.** Same screen, same rule: accounts not entered are erased, and the
screen says so before anything starts.

This also gives the deniability property for free. Every key, nonce and
block changes, exactly as in "Refresh keys" or a password change, so the
new account's slot is indistinguishable from a regenerated empty slot.

## What to build

### 1. Storage crate (`wasm/secure-storage/src/rekey.rs`)

- `RekeyPlan::admit_new(password)`:
  - rejects, with the same generic error as every other admission, a
    password that opens any source slot or equals the final password of an
    admitted account;
  - does the same all-slot unlock work as the other admissions;
  - keeps the derived keys and reserves "one new account", without picking
    a slot yet. At most one new account per operation.
- `build()`:
  - picks the new account's slot uniformly at random (OS RNG) among the
    slots that were not admitted, and creates an empty session there under
    keys derived from the new password, instead of a dummy;
  - fails with the generic error when no slot is free (three accounts
    entered);
  - the slot index never leaves Rust. JavaScript only ever unlocks by
    password.
- Bindings: `admitRekeyNew` in `wasm_api.rs`, `native_api.rs` and
  `vfs/native_vfs.rs`; SDK `secureStorageAdmitRekeyNew(password)`.
- Rebuild the web bundle.

### 2. App: create the account inside the candidate

`setupAccount` (`src/stores/accountStore.ts`) does two things: allocate a
slot (`pickFreeSlot` + `secureStorageCreate`) and initialise the account in
it (migrations, profile, keys, recovery phrase, messaging session). Split
them, so the second part can run on a slot that the rekey already created:

- unlock the candidate with the new password;
- initialise the account exactly as onboarding does
  (`publishPublicKey: false`, `deferExternalSideEffects: true`);
- mark its login journal complete (`beginCompleted`), as for any account
  created in its own generation;
- lock.

The onboarding paths keep calling the full `setupAccount`, unchanged.

### 3. App: the operation (`src/services/accountRekey.ts`)

Same sequence as today's rekey, with one step added:

1. claim the rekey lock, log out, wait for other windows (unchanged);
2. admit the accounts to keep or change (unchanged);
3. admit the new account;
4. pad admissions to three (unchanged rule; the new account counts as one);
5. build the candidate;
6. rewrite the inner keys of every admitted account (unchanged);
7. initialise the new account (section 2);
8. pad the per-account rounds to three, counting the new account;
9. commit; carry the existing accounts' journals over (unchanged).

The new account publishes its public key at its first login, as accounts
created by "Multiple deniable accounts" do today.

### 4. UI

- Settings → Security → Hidden accounts → "Create another account (3 max in total)" opens its own
  form (decided: separate from the password form for now):
  - a keep list: every account to keep, with its current password or the
    fingerprint; the open account must be one of the entries. No password
    changes in this operation;
  - a "New account" section: password and confirmation (`validatePassword`,
    same rule as everywhere), username optional (default `user-xxxx`);
  - at most three accounts in total, the new one included; buttons stay
    visible and are disabled at the limit;
  - the existing erase warning and confirmation.
- No fingerprint for the new account. A hidden account behind the
  fingerprint can be opened by forcing a finger; the fingerprint entry stays
  with whichever account already has it (rule R2 of the password plan,
  unchanged).
- Progress screen, then the login screen. The new account is opened by
  typing its password; nothing in the UI lists it.

## Deniability review

| Observable                       | Add vs refresh                                     |
| -------------------------------- | -------------------------------------------------- |
| Public keys, nonces, every block | all fresh in both                                  |
| Which slot holds the new account | random, never stored or shown                      |
| Decoy contents                   | same treatment as any admitted account (R1)        |
| Fingerprint entry                | same rule as any rekey (R2)                        |
| Store size                       | **may differ, see below**                          |
| Duration                         | **longer, see below**                              |
| Server                           | the new account publishes a key at its first login |

**Store size.** Each namespace has as many blocks as its largest slot.
Measured in a browser on 17 November 2026: a freshly created account takes
11 blocks in namespace 0 (its database) and 1 block in namespace 1 (its
messaging session), 64 KiB each on disk; after 20 notes, 12 and 1. Any
device that already holds an account therefore has at least as many blocks
as a new account needs, so adding one should not grow the store, and the
snapshot shows no difference with a refresh.

Decided: check the actual block counts before and after an add once it is
implemented (tests below), and leave any mitigation for later. **Note for
later:** if a future schema makes a new account larger than an existing one
(for example a device created with an older, smaller schema), the store
grows during an add while a refresh never grows it (rule R5). The fix then
is to make every rekey grow each namespace to at least the size of a new
account, so growth no longer depends on whether an account was added.

**Duration.** Creating the account adds roughly the time of one account
creation (about 2–4 s on the test phone) to the operation. Only someone
watching the screen would see it. Decided: accept for now. **Note for
later:** to remove it, make refresh and password change run one dummy account
initialisation too, alongside the existing padding to three accounts.

## Tests

- Rust: `admit_new` on stores with zero, one and two other accounts admitted;
  the new account opens with its password and is empty; the slot is random
  across runs; every public value changes; the new password colliding with
  any source slot or admitted final password gives the generic error; no
  free slot gives the generic error.
- Rust: an account that was not entered is erased, as in the rekey tests.
- App service: call order, padding counts identical for add and refresh, the
  new account's journal is complete.
- Browser, real storage: add an account next to an existing one; both open,
  the old one's note and conversation survive; the new account logs in,
  publishes its key and can exchange a message.
- Browser and phone: block counts per namespace before and after an add
  equal those of a refresh (see "Store size"); duration recorded.

## Order of work

1. Storage crate and bindings, with tests; rebuild the web bundle.
2. Split `setupAccount`; the `add` step in `accountRekey.ts`.
3. The add form, the Settings entry renamed "Create another account (3 max in total)",
   translations (four languages).
4. Browser end-to-end with block counts, then phone.

## Decisions taken (17 November 2026)

1. **Store size:** measured (see "Store size"); no growth expected. Check
   after implementation, mitigation left for later with a note.
2. **Duration difference with refresh:** accepted for now, with a note.
3. **Password changes in the same operation:** no. Adding an account has its
   own form for now.
4. **Button label:** "Create another account (3 max in total)". The limit is shown to everyone, so it reveals
   nothing about how many accounts exist.

## Open decisions

None.

## Implementation status

### What exists

| Layer          | Where                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage core   | `RekeyPlan::admit_new` and the end of `RekeyPlan::build` in `wasm/secure-storage/src/rekey.rs` (creates the account with `allocate_session` in a random free slot)                  |
| Bindings       | `admitRekeyNew` in `wasm_api.rs`, `native_api.rs`, `vfs/native_vfs.rs`; SDK `secureStorageAdmitRekeyNew`                                                                            |
| Account filler | `slotAlreadyCreated` option of `setupAccount`, store action `createAccountInRekeyCandidate` (`src/stores/accountStore.ts`)                                                          |
| Operation      | `newAccount` in `RekeyRequest` (`src/services/accountRekey.ts`): admitted, filled after the build, counted in every padding round, journal recorded complete after the commit       |
| UI             | `mode="add"` of `src/components/settings/RekeyForm.tsx`; Settings → Security → "Create another account (3 max in total)", shown only with secure storage; strings in four languages |

### How it differs from the plan

- The account is filled through the same `setupAccount` as onboarding, with
  an option to unlock the slot the rekey created instead of creating one,
  rather than splitting the function in two.
- The new account's login journal is recorded as complete right after the
  commit, in the same padded pass that carries the kept accounts' journals
  over, so its first login is a normal one.

### Verified

- Storage core: the new account opens with its password and is empty and
  writable; it takes a random free slot (both free slots seen); an omitted
  account is erased; a password that opens any account or that an admitted
  account ends up with is refused generically; a full device refuses; also
  through the native command bridge.
- App service: call order; an add with one kept account does exactly the
  same padded work as a refresh with two; a refused new password changes
  nothing.
- Browser, real storage (automated): an account added next to two kept ones
  survives a restart, all three open.
- Browser end-to-end (17 November 2026):
  - store size: 11 + 1 blocks before, after a refresh and after an add;
  - durations: refresh 9.9 s, add 15.4 s and 16.7 s;
  - the kept account's note survives; the new account is empty, publishes
    its key at its first login, accepts a contact request and exchanges
    messages both ways;
  - a third account can be added; the form then allows no more; a new
    password equal to an existing account's is refused and nothing changes.
- Phone (Galaxy S20 FE, debug build, 17 November 2026): an account created
  with the fingerprint only, holding a note; "Create another account" with
  that account kept through the fingerprint (one prompt) and a new account
  `carol` with a password:
  - the add took about 10–12 s, a refresh keeping both accounts about
    9.7 s (both measured with 1–2 s polling);
  - carol opens with her password, under her own name, with empty notes;
  - the fingerprint still opens the first account, whose note survived.
- Rust: every CI suite passes, including the native one. App suites pass
  apart from the four `portableImportAuthorization` tests that also fail on
  `dev` locally.
