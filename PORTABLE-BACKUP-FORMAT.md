# Gossip portable backup format

## Status

This document defines portable backup container version 1 for official Gossip secure-storage builds.
It describes logical secure-storage records, not IndexedDB, redb, SQLite, or filesystem internals.

Container version 1 is intentionally incompatible with stores outside the approved secure-storage
baseline. Readers reject unknown top-level and nested versions rather than guessing compatibility.

## Security properties

A backup contains all three encrypted secure-storage slots, including cover records. It contains no
account identifier, profile, username, occupied-slot marker, active-account count, network name,
source app version, build identifier, or export timestamp.

Version 1 has no independent backup password and no outer payload encryption. Each real slot remains
protected by its account password, but possession of a backup permits offline password guessing
against wrapped slot keypairs. The final SHA-256 digest detects accidental corruption only. An
attacker who can replace a backup can recompute it.

Biometric credentials and destination-local application state are not records in this format.

## Integer encoding

All multi-byte integers are unsigned and encoded in big-endian byte order. Arithmetic during parsing
uses checked operations. Writers emit the unique canonical representation described below.

## Container layout

|                       Offset |    Width | Field                 | Version 1 value      |
| ---------------------------: | -------: | --------------------- | -------------------- |
|                            0 |        8 | Magic                 | ASCII `GOSSIPBK`     |
|                            8 |        8 | Container version     | `1`                  |
|                           16 |        8 | Slot capacity         | `3`                  |
|                           24 |        8 | Record count          | Number of records    |
|                           32 |        8 | Record-section length | Encoded record bytes |
|                           40 | variable | Record section        | Canonical records    |
| `40 + record-section length` |       32 | Digest                | SHA-256              |

The complete artifact, including its digest, must not exceed 64 GiB
(`68,719,476,736` bytes). The file length must equal `40 + record-section length + 32`; trailing or
missing bytes are invalid.

There are no flags, reserved bytes, algorithm selectors, source metadata, or extension fields in
version 1. A semantic or framing change requires a new top-level container version.

## Record framing

Every record uses this uniform frame:

| Relative offset |          Width | Field                      |
| --------------: | -------------: | -------------------------- |
|               0 |              1 | Record kind                |
|               1 |              1 | Slot                       |
|               2 |              8 | Namespace                  |
|              10 |              8 | Block index                |
|              18 |              8 | Value length               |
|              26 | `value length` | Exact logical record value |

### Record kinds

- `0`: keypair. Slot is `0`, `1`, or `2`; namespace and block index must both be zero. The value is
  the exact logical keypair record.
- `1`: encrypted block. Slot is `0`, `1`, or `2`; namespace is `0` or `1`; block index is the
  logical numeric block index. The value is exactly 65,536 bytes for the version-1 secure-storage
  baseline.

A version-0 keypair value is exactly 98,340 bytes:

| Relative offset |  Width | Field                                                |
| --------------: | -----: | ---------------------------------------------------- |
|               0 |      4 | Keypair version, `0`                                 |
|               4 | 65,536 | Canonical pq-rerand `9a5a48b` public key             |
|          65,540 |     16 | Secret-key wrapping nonce                            |
|          65,556 | 32,784 | Wrapped 32,768-byte secret key plus 16-byte AEAD tag |

A version-1 keypair value is exactly 98,352 bytes:

| Relative offset |  Width | Field                                                |
| --------------: | -----: | ---------------------------------------------------- |
|               0 |      4 | Keypair version, `1`                                 |
|               4 |      4 | Public-key length, `65,536`                          |
|               8 |      4 | Wrapping-nonce length, `16`                          |
|              12 |      4 | Wrapped-secret length, `32,784`                      |
|              16 | 65,536 | Canonical pq-rerand `9a5a48b` public key             |
|          65,552 |     16 | Secret-key wrapping nonce                            |
|          65,568 | 32,784 | Wrapped 32,768-byte secret key plus 16-byte AEAD tag |

Version 1 binds `GOSSIPKP`, the bounded domain, slot, version, all three lengths, and the complete
public key into the wrapping AEAD. It selects the current block KDF/AAD suite with explicit session
version `1`. New storage emits version 1; the frozen version-0 reader exists only to migrate the
initial portable baseline.

The keypair version is read before applying version-specific lengths or parsers. The public key and
every encrypted block must pass pq-rerand's strict canonical parsers. All other kinds, slots,
namespaces, versions, or value sizes are invalid or unsupported as applicable.

## Canonical ordering and completeness

Records have exactly this order:

1. Keypair records for slots `0`, `1`, and `2`.
2. Block records ordered numerically by `(namespace, block index, slot)`.

For each present `(namespace, block index)`, all three slot records must occur consecutively. Block
indices in each namespace begin at zero and are contiguous. Namespace `0`, block `0` is mandatory.
Namespace `1` may be absent; if present, it also begins at block `0`.

These rules require identical logical block-coordinate sets for all three slots. They detect omitted
records and preserve fixed-capacity plausible deniability without encoding occupancy.

The record count therefore equals `3 + 3 × block-coordinate count`.

## Digest

SHA-256 is computed over the exact bytes beginning with the first `G` in `GOSSIPBK` and ending
with the final record value byte. This includes the complete fixed header and every record field and
value.
The 32-byte digest is appended and does not include itself.

Readers validate framing, bounds, canonical order, completeness, and the digest before installing a
candidate. They must stream parsing and hashing and must not allocate based solely on an
attacker-controlled count or total length.

## Import semantics

Import is whole-store replacement, never merge. Initial candidate validation preserves every exact
record value and never mutates the user-owned source file. No initial-stage operation decrypts,
classifies, trims, regenerates, or coalesces records.

After password authentication, finalization creates one separate complete current-suite generation.
It generates fresh public keypairs for all three slots, re-encrypts authenticated selected-account
logical blocks, replaces unselected slots with fresh dummy keypairs and cover blocks, and performs an
additional pq-rerand on every output block. Transformation processes complete three-slot coordinates
and emits no intermediate per-password generation, slot match, occupancy marker, or account count.
The exact validated source remains retryable until the complete destination is sealed and switched
atomically. Omission independence begins only after whole-archive framing, digest, canonical PQ, and
record validation; malformed records are rejected before password admission regardless of which
account they may contain. Authenticated inner corruption in an unselected slot is ignored because
that payload is replaced rather than decrypted.

A successful browser switch erases the staged source and previous active generation in the same
IndexedDB transaction as the marker update. Native redb replacement cannot be atomic with file
removal, so a failed source-spool erase retains cleanup ownership and blocks ordinary storage access
until retry succeeds. Success must never leave omitted source accounts available to normal runtime
operation.

## Profile security envelope

The namespace-`0` SQLite `userProfile.security` JSON object carries four mandatory numeric dispatch
fields before any account-password operation:

- `formatVersion: 1`
- `passwordKdfVersion: 1`
- `mnemonicEncryptionVersion: 1`
- `identityDerivationVersion: 1`

The row parser rejects absent or unknown values before reconstructing salts/ciphertext, and account
authentication rechecks them before password KDF work. The initial values freeze the current
Argon2id profile-key derivation, AES-256-SIV mnemonic envelope, and mnemonic-to-identity derivation.
A change to any operation requires a new corresponding version and retained historical decoder.
Pre-envelope profiles remain outside the approved compatibility baseline. The browser compatibility
test freezes password `profile-v1-vector`, salt bytes `00..0f`, the standard `abandon … about` BIP39
mnemonic, its deterministic ciphertext, and these identity outputs:

```text
gossip1ywzkutgadznd0509tsl4gs4xjvsudhzgjuxc46ytngvq0lacx5es2xyz5s
0xd30d988A4F82A21C03aD5497E6b950beB5408538
AU1XfQoXydwZEcS2UF32PSjL8BwyHWruvDNZYCA5mhCnfZ5Daiyo
```

## SessionManager nested envelope

Namespace `1` contains a separately encrypted SessionManager blob. The Phase 3 baseline begins with
this clear, outer-secure-storage-protected header:

| Offset |    Width | Field                          | Initial value                      |
| -----: | -------: | ------------------------------ | ---------------------------------- |
|      0 |        8 | Magic                          | ASCII `GOSSIPSM`                   |
|      8 |        8 | Envelope version               | `1`                                |
|     16 |        8 | SessionManager payload version | `1`                                |
|     24 |        8 | Ciphertext length              | Bounded length                     |
|     32 |       16 | AES-256-SIV nonce              | Random nonce                       |
|     48 | variable | Ciphertext                     | Versioned bincode payload plus tag |

The first 32 bytes are nested AEAD additional authenticated data. Ciphertext is limited to 64 MiB,
framing must consume the exact blob, and bincode must consume the complete decrypted plaintext.
Pre-envelope nonce-only blobs are outside the approved compatibility baseline. The committed
`sessions/tests/fixtures/session-manager-v1.bin` fixture contains an active nested ratchet/session
encrypted by the fixed 64-byte key `0x42`; its SHA-256 is:

```text
901297e4f54fcd1fc672406298427408554dd18d3d9565e49ba4a98a6aa4e1ee
```

Future schema work must keep a version-1 decoder that opens this fixture before emitting another
payload version.

## Compatibility rules

Top-level version dispatch occurs before any version-specific header field is interpreted. Nested
versions must be visible before the operation they control, including keypair/KDF/PQ, block crypto,
namespace payload,
SQLite migration ledger, profile security, identity derivation, session envelope, and SessionManager
serialization.

A reader rejects an unsupported version at the earliest visible layer. Supporting a historical
version requires retaining its decoder and frozen compatibility fixtures. Source application SemVer
must never control migration.

## Version-1 test vector

The committed `portable-v1-minimal.gossipbackup` fixture contains three deterministic keypairs and
namespace `0`, block `0` for all three slots. Its final SHA-256 value is:

```text
8de78659f333802ba39696c4d2d9ed0b822ba374d5f204383dbce083a33d9e8f
```

The reader decodes the committed bytes independently before the writer must reproduce them exactly.
Changing any frozen header, record framing, baseline size, ordering, fixture byte, or digest
coverage changes this value and requires deliberate compatibility adjudication.
