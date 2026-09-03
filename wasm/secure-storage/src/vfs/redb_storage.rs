//! redb-backed block & keypair storage for native targets (iOS/Android).
//!
//! All blocks and keypairs are stored in a single `storage.redb` file.
//! Writes are buffered in RAM. On `commit()` every pending keypair,
//! blockstream reset, and block write is flushed as a single ACID
//! transaction; redb handles crash safety internally, so no custom WAL
//! is needed.
//!
//! Block keys are 10-byte composites: `[session, namespace, block_id(8)]`.
//! This maps directly to the `(SessionIndex, namespace: u8, block: u64)`
//! tuple in the [`BlockStorage`] trait.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use rand::RngCore;
use redb::{Database, ReadableTable, TableDefinition};
use zeroize::Zeroizing;

use crate::constants::{BLOCK_SIZE, SESSION_COUNT};
use crate::error::{Result, SecureStorageError};
use crate::portable::{
    MAX_PORTABLE_ARCHIVE_BYTES, PORTABLE_DIGEST_SIZE, PORTABLE_HEADER_SIZE, PortableArchiveReader,
    PortableArchiveWriter, PortableHeader, PortableRecord, PortableRecordKind,
    validate_portable_block_value, validate_portable_keypair_value,
};
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;

// ── redb table definitions ───────────────────────────────────────────

const BLOCKS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("blocks");
const KEYPAIRS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("keypairs");
const METADATA: TableDefinition<&[u8], &[u8]> = TableDefinition::new("metadata");
const LEGACY_PORTABLE_IMPORT_INSTALLED_KEY: &[u8] = b"portable-import-installed-v1";
const ACCOUNT_GENERATION_STATE_KEY: &[u8] = b"account-generation-state-v1";
const EMPTY_ACCOUNT_GENERATION: &[u8] = b"empty-v1";
const COMMITTED_ACCOUNT_GENERATION_PREFIX: &[u8] = b"committed-v1:";
const GENERATION_EPOCH_BYTES: usize = 16;
const GENERATION_EPOCH_HEX_BYTES: usize = GENERATION_EPOCH_BYTES * 2;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum AccountGenerationState {
    Empty,
    Committed,
}

impl AccountGenerationState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Committed => "committed",
        }
    }

    fn decode(value: &[u8]) -> Result<Self> {
        if value == EMPTY_ACCOUNT_GENERATION {
            return Ok(Self::Empty);
        }
        decode_committed_generation_epoch(value)?;
        Ok(Self::Committed)
    }
}

fn new_generation_epoch() -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut bytes = [0_u8; GENERATION_EPOCH_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let mut epoch = String::with_capacity(GENERATION_EPOCH_HEX_BYTES);
    for byte in bytes {
        epoch.push(HEX[usize::from(byte >> 4)] as char);
        epoch.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    epoch
}

fn committed_generation_value(epoch: &str) -> Vec<u8> {
    let mut value =
        Vec::with_capacity(COMMITTED_ACCOUNT_GENERATION_PREFIX.len() + GENERATION_EPOCH_HEX_BYTES);
    value.extend_from_slice(COMMITTED_ACCOUNT_GENERATION_PREFIX);
    value.extend_from_slice(epoch.as_bytes());
    value
}

fn decode_committed_generation_epoch(value: &[u8]) -> Result<String> {
    let epoch = value
        .strip_prefix(COMMITTED_ACCOUNT_GENERATION_PREFIX)
        .filter(|epoch| {
            epoch.len() == GENERATION_EPOCH_HEX_BYTES
                && epoch.iter().all(u8::is_ascii_hexdigit)
                && epoch.iter().all(|byte| !byte.is_ascii_uppercase())
        })
        .ok_or(SecureStorageError::UnsupportedAccountGenerationState)?;
    String::from_utf8(epoch.to_vec())
        .map_err(|_| SecureStorageError::UnsupportedAccountGenerationState)
}

// ── Buffered write ───────────────────────────────────────────────────

/// Block-key layout: 1 byte session + 1 byte namespace + 8 bytes block_id BE.
const BLOCK_KEY_LEN: usize = 10;
type BlockKey = [u8; BLOCK_KEY_LEN];

/// Closure factory for `.map_err`. Wraps any `Display`-able redb error
/// into a `SecureStorageError::Storage(format!("redb {ctx}: {e}"))`,
/// dropping ~20 characters per call site versus an inline closure.
fn redb_err<E: std::fmt::Display>(ctx: &'static str) -> impl FnOnce(E) -> SecureStorageError {
    move |e| SecureStorageError::Storage(format!("redb {ctx}: {e}"))
}

struct BufferedWrite {
    session: u8,
    namespace: u8,
    block_id: u64,
    data: Box<[u8; BLOCK_SIZE]>,
}

// ── RedbStorage ──────────────────────────────────────────────────────

/// Single-file storage backend using redb.
pub struct RedbStorage {
    db: Database,
    /// Pending keypair writes, drained at `commit()` time so keypair
    /// rotations can be atomic with the block rewrites that depend on
    /// them (notably `destroy_session`).
    pending_keypairs: HashMap<u8, Zeroizing<Vec<u8>>>,
    ram_buffer: Vec<BufferedWrite>,
    /// Overlay index: maps a (session, namespace, block_id) key to the
    /// position in `ram_buffer` of the last buffered write at that key.
    ///
    /// Replaces the previous O(buffer_len) linear scan in `read_block`
    /// with an O(1) lookup. Stays in sync with `ram_buffer`: every
    /// `write_block` / `append_block` updates this map; `commit` and
    /// `reset_blockstream` invalidate the affected entries.
    ram_overlay: HashMap<BlockKey, usize>,
    /// Pending `(session, namespace)` blockstream resets. Drained at
    /// `commit()` time, fused into the same redb txn as `ram_buffer`
    /// inserts. Lets a "clear + write" pair finish in **one** fsync
    /// instead of two — critical for the session-blob persist path,
    /// where back-to-back clear+write was the hot fsync waterfall.
    pending_deletes: Vec<(u8, u8)>,
    /// `block_counts[session][namespace] = count`. Lazy: only populated
    /// namespaces appear in the inner map.
    block_counts: Vec<HashMap<u8, u64>>,
}

impl RedbStorage {
    /// Open (or create) a redb database at `base/storage.redb`.
    pub fn open(base: &Path) -> Result<Self> {
        fs::create_dir_all(base)?;
        let db_path = base.join("storage.redb");
        let db = Database::create(&db_path).map_err(redb_err("open"))?;

        let mut storage = Self {
            db,
            pending_keypairs: HashMap::new(),
            ram_buffer: Vec::new(),
            ram_overlay: HashMap::new(),
            pending_deletes: Vec::new(),
            block_counts: (0..SESSION_COUNT).map(|_| HashMap::new()).collect(),
        };
        storage.rebuild_block_counts()?;
        Ok(storage)
    }

    /// Scan the BLOCKS table and count entries per `(session, namespace)`.
    fn rebuild_block_counts(&mut self) -> Result<()> {
        let txn = self.db.begin_read().map_err(redb_err("read txn"))?;

        let table = match txn.open_table(BLOCKS) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(()),
            Err(e) => return Err(SecureStorageError::Storage(format!("redb open table: {e}"))),
        };

        for counts in &mut self.block_counts {
            counts.clear();
        }

        let iter = table.iter().map_err(redb_err("iter"))?;
        for entry in iter {
            let (key, _val) = entry.map_err(redb_err("entry"))?;
            let key_bytes = key.value();
            if key_bytes.len() == BLOCK_KEY_LEN {
                let session = key_bytes[0] as usize;
                let namespace = key_bytes[1];
                if session < SESSION_COUNT {
                    *self.block_counts[session].entry(namespace).or_insert(0) += 1;
                }
            }
        }
        Ok(())
    }

    /// Encode `(session, namespace, block_id)` as a 10-byte key.
    fn make_block_key(session: u8, namespace: u8, block_id: u64) -> BlockKey {
        let mut key = [0u8; BLOCK_KEY_LEN];
        key[0] = session;
        key[1] = namespace;
        key[2..10].copy_from_slice(&block_id.to_be_bytes());
        key
    }

    /// Return true if the on-disk database already has any keypair
    /// entries; used to gate `provision` at boot so we don't wipe
    /// existing slots by re-provisioning random throwaway keys.
    #[cfg(test)]
    pub fn legacy_portable_import_marker_exists(&self) -> Result<bool> {
        let txn = self.db.begin_read().map_err(redb_err("read txn"))?;
        let table = match txn.open_table(METADATA) {
            Ok(table) => table,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(false),
            Err(error) => return Err(redb_err("metadata table")(error)),
        };
        Ok(table
            .get(LEGACY_PORTABLE_IMPORT_INSTALLED_KEY)
            .map_err(redb_err("metadata read"))?
            .is_some())
    }

    pub fn has_data(&self) -> Result<bool> {
        let txn = self.db.begin_read().map_err(redb_err("read txn"))?;
        let table = match txn.open_table(KEYPAIRS) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(false),
            Err(e) => return Err(SecureStorageError::Storage(format!("redb open table: {e}"))),
        };
        let mut iter = table.iter().map_err(redb_err("iter"))?;
        Ok(iter.next().is_some())
    }

    pub fn account_generation_state(&self) -> Result<Option<AccountGenerationState>> {
        let txn = self.db.begin_read().map_err(redb_err("read txn"))?;
        let table = match txn.open_table(METADATA) {
            Ok(table) => table,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(error) => return Err(redb_err("metadata table")(error)),
        };
        table
            .get(ACCOUNT_GENERATION_STATE_KEY)
            .map_err(redb_err("account generation state read"))?
            .map(|value| AccountGenerationState::decode(value.value()))
            .transpose()
    }

    pub fn account_generation_epoch(&self) -> Result<Option<String>> {
        let txn = self.db.begin_read().map_err(redb_err("read txn"))?;
        let table = match txn.open_table(METADATA) {
            Ok(table) => table,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(error) => return Err(redb_err("metadata table")(error)),
        };
        let Some(value) = table
            .get(ACCOUNT_GENERATION_STATE_KEY)
            .map_err(redb_err("account generation epoch read"))?
        else {
            return Ok(None);
        };
        if value.value() == EMPTY_ACCOUNT_GENERATION {
            return Ok(None);
        }
        decode_committed_generation_epoch(value.value()).map(Some)
    }

    pub fn initialize_empty_account_generation(&mut self) -> Result<AccountGenerationState> {
        if let Some(state) = self.account_generation_state()? {
            return Ok(state);
        }
        if self.has_data()? {
            return Err(SecureStorageError::UnsupportedVersion(0));
        }
        let txn = self.db.begin_write().map_err(redb_err("write txn"))?;
        {
            let mut metadata = txn
                .open_table(METADATA)
                .map_err(redb_err("metadata table"))?;
            metadata
                .insert(ACCOUNT_GENERATION_STATE_KEY, EMPTY_ACCOUNT_GENERATION)
                .map_err(redb_err("account generation state insert"))?;
        }
        txn.commit()
            .map_err(redb_err("account generation state commit"))?;
        Ok(AccountGenerationState::Empty)
    }

    /// Batch-flush pending keypairs, deletes, and inserts in a single
    /// ACID transaction (one redb commit = one fsync). Multi-phase to fuse
    /// "clear + write" patterns (e.g. session-blob persist) into one
    /// fsync instead of two:
    ///
    ///   - Phase A: write `pending_keypairs` (session keypair rotations
    ///     staged by `write_keypair` since the last commit).
    ///   - Phase B: drain `pending_deletes` (blockstream resets staged
    ///     by `reset_blockstream` since the last commit).
    ///   - Phase C: insert `ram_buffer` writes, deduped via
    ///     `ram_overlay` (a hot path can buffer multiple writes for the
    ///     same key when the SQLite page cache flushes a page that was
    ///     rewritten in the same txn, etc.) — only the last-written
    ///     value per key reaches redb.
    ///
    /// Order matters: deletes run BEFORE inserts inside the same txn so
    /// a "replace namespace" pattern that targets overlapping keys
    /// keeps the new bytes — even though in practice the sets are
    /// disjoint, since clears wipe the whole `(session, namespace)`
    /// stream and the new writes start fresh from block 0.
    ///
    /// PD: we always run the redb write transaction, even when all
    /// queues are empty. Skipping would leak "no cover work this tick"
    /// via the absence of an fsync on disk — an attacker watching I/O
    /// timing could distinguish ticks where the scheduler had real work
    /// to do from ticks where it did not. An empty redb txn still
    /// produces a uniform fsync, keeping the on-disk timing pattern
    /// indistinguishable.
    pub fn commit(&mut self) -> Result<()> {
        let txn = self.db.begin_write().map_err(redb_err("write txn"))?;
        {
            let mut table = txn.open_table(KEYPAIRS).map_err(redb_err("open table"))?;
            // Phase A: drain pending keypair writes.
            for (session, data) in &self.pending_keypairs {
                let key = [*session];
                table
                    .insert(key.as_slice(), data.as_slice())
                    .map_err(redb_err("insert"))?;
            }
        }
        {
            let mut table = txn.open_table(BLOCKS).map_err(redb_err("open table"))?;
            // Phase B: drain pending blockstream deletes.
            for (session, namespace) in &self.pending_deletes {
                let prefix_start = Self::make_block_key(*session, *namespace, 0);
                let prefix_end = Self::make_block_key(*session, *namespace, u64::MAX);
                table
                    .retain_in(prefix_start.as_slice()..=prefix_end.as_slice(), |_k, _v| {
                        false
                    })
                    .map_err(redb_err("retain_in"))?;
            }
            // Phase C: insert ram_buffer writes, deduped via ram_overlay.
            // Iterate in original buffer order so on-disk write order
            // matches the order in which the application made the
            // writes, but using each key's last-buffered value.
            for (i, bw) in self.ram_buffer.iter().enumerate() {
                let key = Self::make_block_key(bw.session, bw.namespace, bw.block_id);
                if self.ram_overlay.get(&key) != Some(&i) {
                    continue;
                }
                table
                    .insert(key.as_slice(), bw.data.as_slice())
                    .map_err(redb_err("insert"))?;
            }
        }
        txn.commit().map_err(redb_err("commit"))?;
        self.pending_keypairs.clear();
        self.ram_buffer.clear();
        self.ram_overlay.clear();
        self.pending_deletes.clear();
        Ok(())
    }

    fn portable_layout(&self) -> Result<(PortableHeader, [u64; 2])> {
        let txn = self
            .db
            .begin_read()
            .map_err(redb_err("portable read txn"))?;
        let keypairs = txn
            .open_table(KEYPAIRS)
            .map_err(redb_err("portable keypairs"))?;
        let blocks = txn
            .open_table(BLOCKS)
            .map_err(redb_err("portable blocks"))?;

        let mut keypairs_seen = [false; SESSION_COUNT];
        let mut record_count = 0_u64;
        let mut record_section_length = 0_u64;
        for entry in keypairs.iter().map_err(redb_err("portable keypair iter"))? {
            let (key, value) = entry.map_err(redb_err("portable keypair entry"))?;
            let key = key.value();
            if key.len() != 1 || usize::from(key[0]) >= SESSION_COUNT {
                return Err(SecureStorageError::InvalidPortableArchive);
            }
            let slot = usize::from(key[0]);
            if keypairs_seen[slot] {
                return Err(SecureStorageError::InvalidPortableArchive);
            }
            validate_portable_keypair_value(value.value())?;
            keypairs_seen[slot] = true;
            record_count = record_count
                .checked_add(1)
                .ok_or(SecureStorageError::Overflow)?;
            record_section_length = record_section_length
                .checked_add(26)
                .and_then(|length| length.checked_add(value.value().len() as u64))
                .ok_or(SecureStorageError::Overflow)?;
            if record_section_length
                > MAX_PORTABLE_ARCHIVE_BYTES - PORTABLE_HEADER_SIZE - PORTABLE_DIGEST_SIZE
            {
                return Err(SecureStorageError::PortableArchiveTooLarge);
            }
        }
        if keypairs_seen.iter().any(|seen| !seen) {
            return Err(SecureStorageError::InvalidPortableArchive);
        }

        let mut counts = [[0_u64; 2]; SESSION_COUNT];
        for entry in blocks.iter().map_err(redb_err("portable block iter"))? {
            let (key, value) = entry.map_err(redb_err("portable block entry"))?;
            let key = key.value();
            if key.len() != BLOCK_KEY_LEN || usize::from(key[0]) >= SESSION_COUNT || key[1] > 1 {
                return Err(SecureStorageError::InvalidPortableArchive);
            }
            let slot = usize::from(key[0]);
            let namespace = usize::from(key[1]);
            let block_index = u64::from_be_bytes(
                key[2..10]
                    .try_into()
                    .map_err(|_| SecureStorageError::InvalidPortableArchive)?,
            );
            if block_index != counts[slot][namespace] {
                return Err(SecureStorageError::InvalidPortableArchive);
            }
            validate_portable_block_value(value.value())?;
            counts[slot][namespace] = counts[slot][namespace]
                .checked_add(1)
                .ok_or(SecureStorageError::Overflow)?;
            record_count = record_count
                .checked_add(1)
                .ok_or(SecureStorageError::Overflow)?;
            record_section_length = record_section_length
                .checked_add(26 + BLOCK_SIZE as u64)
                .ok_or(SecureStorageError::Overflow)?;
            if record_section_length
                > MAX_PORTABLE_ARCHIVE_BYTES - PORTABLE_HEADER_SIZE - PORTABLE_DIGEST_SIZE
            {
                return Err(SecureStorageError::PortableArchiveTooLarge);
            }
        }

        if counts[0][0] == 0
            || counts[1] != counts[0]
            || counts[2] != counts[0]
            || (counts[0][1] > 0 && counts[0][0] == 0)
        {
            return Err(SecureStorageError::InvalidPortableArchive);
        }

        Ok((
            PortableHeader {
                record_count,
                record_section_length,
            },
            counts[0],
        ))
    }

    /// Flush and stream a strict canonical snapshot of all logical records.
    pub fn export_portable<W: Write>(&mut self, output: W) -> Result<W> {
        self.commit()?;
        let (header, block_counts) = self.portable_layout()?;
        let txn = self
            .db
            .begin_read()
            .map_err(redb_err("portable read txn"))?;
        let keypairs = txn
            .open_table(KEYPAIRS)
            .map_err(redb_err("portable keypairs"))?;
        let blocks = txn
            .open_table(BLOCKS)
            .map_err(redb_err("portable blocks"))?;
        let mut writer = PortableArchiveWriter::new(output, header)?;

        for slot in 0..SESSION_COUNT as u8 {
            let key = [slot];
            let value = keypairs
                .get(key.as_slice())
                .map_err(redb_err("portable keypair get"))?
                .ok_or(SecureStorageError::InvalidPortableArchive)?;
            writer.write_record(&PortableRecord::keypair(slot, value.value().to_vec()))?;
        }
        for (namespace, count) in block_counts.into_iter().enumerate() {
            for block_index in 0..count {
                for slot in 0..SESSION_COUNT as u8 {
                    let key = Self::make_block_key(slot, namespace as u8, block_index);
                    let value = blocks
                        .get(key.as_slice())
                        .map_err(redb_err("portable block get"))?
                        .ok_or(SecureStorageError::InvalidPortableArchive)?;
                    writer.write_record(&PortableRecord::block(
                        slot,
                        namespace as u8,
                        block_index,
                        value.value().to_vec(),
                    ))?;
                }
            }
        }
        writer.finish()
    }

    /// Atomically replace all logical records from a validated canonical stream.
    ///
    /// redb keeps the prior installation visible until the complete archive,
    /// including its digest, has validated and the write transaction commits.
    pub fn import_portable<R: Read>(&mut self, input: R) -> Result<R> {
        self.commit()?;
        let generation_epoch = new_generation_epoch();
        let committed_generation = committed_generation_value(&generation_epoch);
        let mut reader = PortableArchiveReader::new(input)?;
        let txn = self
            .db
            .begin_write()
            .map_err(redb_err("portable write txn"))?;
        let mut imported_counts = [[0_u64; 2]; SESSION_COUNT];
        {
            let mut keypairs = txn
                .open_table(KEYPAIRS)
                .map_err(redb_err("portable keypairs"))?;
            let mut blocks = txn
                .open_table(BLOCKS)
                .map_err(redb_err("portable blocks"))?;
            let mut metadata = txn
                .open_table(METADATA)
                .map_err(redb_err("portable metadata"))?;
            keypairs
                .retain(|_, _| false)
                .map_err(redb_err("portable clear keypairs"))?;
            blocks
                .retain(|_, _| false)
                .map_err(redb_err("portable clear blocks"))?;
            metadata
                .remove(LEGACY_PORTABLE_IMPORT_INSTALLED_KEY)
                .map_err(redb_err("legacy portable metadata removal"))?;
            metadata
                .insert(
                    ACCOUNT_GENERATION_STATE_KEY,
                    committed_generation.as_slice(),
                )
                .map_err(redb_err("account generation state marker"))?;

            while let Some(record) = reader.read_record()? {
                match record.kind {
                    PortableRecordKind::Keypair => {
                        let key = [record.slot];
                        keypairs
                            .insert(key.as_slice(), record.value.as_slice())
                            .map_err(redb_err("portable insert keypair"))?;
                    }
                    PortableRecordKind::Block => {
                        let namespace = u8::try_from(record.namespace)
                            .map_err(|_| SecureStorageError::InvalidPortableArchive)?;
                        let key = Self::make_block_key(record.slot, namespace, record.block_index);
                        imported_counts[usize::from(record.slot)][usize::from(namespace)] += 1;
                        blocks
                            .insert(key.as_slice(), record.value.as_slice())
                            .map_err(redb_err("portable insert block"))?;
                    }
                }
            }
        }
        let input = reader.finish()?;
        txn.commit().map_err(redb_err("portable commit"))?;
        self.block_counts = imported_counts
            .into_iter()
            .map(|counts| {
                counts
                    .into_iter()
                    .enumerate()
                    .filter(|(_, count)| *count > 0)
                    .map(|(namespace, count)| (namespace as u8, count))
                    .collect()
            })
            .collect();
        Ok(input)
    }

    /// Drop every staged operation that has not yet been flushed by
    /// [`commit`], leaving the on-disk state untouched.
    ///
    /// Used by callers that need to roll back a multi-step operation
    /// halfway through (for example, [`crate::destroy_session`] when one
    /// of its block-rewriting steps errors): without this, the staged
    /// writes would silently ride along on the next caller's `commit()`
    /// and corrupt the on-disk state.
    ///
    /// **Caveat**: this clears `pending_keypairs` (keypair stages),
    /// `ram_buffer` (write-block stages), `ram_overlay` (the write-block
    /// index), and `pending_deletes` (reset-blockstream stages). It does
    /// NOT undo direct mutations to `block_counts`, which
    /// `reset_blockstream` and `append_block` apply immediately. Callers
    /// that mutate counts (i.e., call `reset_blockstream` or
    /// `append_block`) cannot fully roll back with this primitive alone;
    /// they must avoid those calls or do their own count-snapshotting.
    pub fn discard_pending(&mut self) {
        self.pending_keypairs.clear();
        self.ram_buffer.clear();
        self.ram_overlay.clear();
        self.pending_deletes.clear();
    }
}

// ── BlockStorage ─────────────────────────────────────────────────────

impl BlockStorage for RedbStorage {
    fn read_block(
        &self,
        session: SessionIndex,
        namespace: u8,
        block: u64,
    ) -> Result<Box<[u8; BLOCK_SIZE]>> {
        let si = session.as_u8();
        let count = self.block_counts[session.as_usize()]
            .get(&namespace)
            .copied()
            .unwrap_or(0);
        if block >= count {
            return Err(SecureStorageError::OutOfBounds);
        }

        // Check RAM buffer first (last-write-wins) via the overlay index.
        let key = Self::make_block_key(si, namespace, block);
        if let Some(&idx) = self.ram_overlay.get(&key) {
            return Ok(self.ram_buffer[idx].data.clone());
        }

        // Fall back to redb.
        let txn = self.db.begin_read().map_err(redb_err("read txn"))?;
        let table = txn.open_table(BLOCKS).map_err(redb_err("open table"))?;
        let entry = table.get(key.as_slice()).map_err(redb_err("get"))?;
        match entry {
            Some(val) => {
                let val_bytes = val.value();
                if val_bytes.len() != BLOCK_SIZE {
                    return Err(SecureStorageError::CorruptedBlock);
                }
                // SAFETY: `Box::new_uninit` returns a `Box<MaybeUninit<[u8; N]>>`
                // and we initialise every byte via `copy_from_slice` before
                // calling `assume_init`. `val_bytes.len() == BLOCK_SIZE` is
                // checked just above, so the copy fully fills the array.
                // Skipping the `[0u8; BLOCK_SIZE]` zero-init avoids 64 KiB
                // of useless memset per redb read on the hot path.
                let mut buf: Box<std::mem::MaybeUninit<[u8; BLOCK_SIZE]>> = Box::new_uninit();
                let buf_ref: &mut [u8; BLOCK_SIZE] = unsafe { &mut *buf.as_mut_ptr() };
                buf_ref.copy_from_slice(val_bytes);
                Ok(unsafe { buf.assume_init() })
            }
            None => Err(SecureStorageError::OutOfBounds),
        }
    }

    fn write_block(
        &mut self,
        session: SessionIndex,
        namespace: u8,
        block: u64,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()> {
        let count = self.block_counts[session.as_usize()]
            .get(&namespace)
            .copied()
            .unwrap_or(0);
        if block >= count {
            return Err(SecureStorageError::OutOfBounds);
        }
        let key = Self::make_block_key(session.as_u8(), namespace, block);
        self.ram_buffer.push(BufferedWrite {
            session: session.as_u8(),
            namespace,
            block_id: block,
            data: Box::new(*data),
        });
        self.ram_overlay.insert(key, self.ram_buffer.len() - 1);
        Ok(())
    }

    fn append_block(
        &mut self,
        session: SessionIndex,
        namespace: u8,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()> {
        let count = self.block_counts[session.as_usize()]
            .entry(namespace)
            .or_insert(0);
        let block_id = *count;
        let key = Self::make_block_key(session.as_u8(), namespace, block_id);
        self.ram_buffer.push(BufferedWrite {
            session: session.as_u8(),
            namespace,
            block_id,
            data: Box::new(*data),
        });
        self.ram_overlay.insert(key, self.ram_buffer.len() - 1);
        *count += 1;
        Ok(())
    }

    fn block_count(&self, session: SessionIndex, namespace: u8) -> Result<u64> {
        Ok(self.block_counts[session.as_usize()]
            .get(&namespace)
            .copied()
            .unwrap_or(0))
    }

    fn fsync(&self, _session: SessionIndex, _namespace: u8) -> Result<()> {
        // No-op: real flush happens via commit().
        Ok(())
    }

    fn reset_blockstream(&mut self, session: SessionIndex, namespace: u8) -> Result<()> {
        let si = session.as_usize();
        let su8 = session.as_u8();

        // Remove buffered writes for this (session, namespace) and the
        // matching overlay entries. The overlay's index values point into
        // ram_buffer, so we must rebuild it after the retain rather than
        // try to fix indices in place.
        self.ram_buffer
            .retain(|bw| !(bw.session == su8 && bw.namespace == namespace));
        self.ram_overlay.clear();
        for (i, bw) in self.ram_buffer.iter().enumerate() {
            let k = Self::make_block_key(bw.session, bw.namespace, bw.block_id);
            self.ram_overlay.insert(k, i);
        }

        // Stage the redb-side delete for the next `commit()` call. This
        // lets a subsequent `write_block` + `commit` fuse the wipe and
        // the rewrite into a single redb transaction (one fsync) — the
        // hot path for session-blob persistence. Idempotent: enqueue
        // only if not already pending.
        if !self
            .pending_deletes
            .iter()
            .any(|(s, n)| *s == su8 && *n == namespace)
        {
            self.pending_deletes.push((su8, namespace));
        }

        self.block_counts[si].remove(&namespace);
        Ok(())
    }

    fn namespaces_with_data(&self, session: SessionIndex) -> Result<Vec<u8>> {
        // `block_counts` is the in-memory authoritative count; entries with
        // count == 0 (which `reset_blockstream` removes) and never-written
        // namespaces both correctly map to "no data". Also account for
        // un-committed writes still in `ram_buffer` for newly-written
        // namespaces that don't yet appear in `block_counts`.
        let si = session.as_usize();
        let su8 = session.as_u8();
        let mut out: Vec<u8> = self.block_counts[si]
            .iter()
            .filter(|(_, count)| **count > 0)
            .map(|(ns, _)| *ns)
            .collect();
        for bw in &self.ram_buffer {
            if bw.session == su8 && !out.contains(&bw.namespace) {
                out.push(bw.namespace);
            }
        }
        Ok(out)
    }
}

// ── KeypairStorage ───────────────────────────────────────────────────

impl KeypairStorage for RedbStorage {
    fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>> {
        if let Some(data) = self.pending_keypairs.get(&session.as_u8()) {
            return Ok(Zeroizing::new((**data).clone()));
        }

        let txn = self.db.begin_read().map_err(redb_err("read txn"))?;
        let table = match txn.open_table(KEYPAIRS) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => {
                return Err(SecureStorageError::Storage("keypair not found".into()));
            }
            Err(e) => {
                return Err(SecureStorageError::Storage(format!("redb open table: {e}")));
            }
        };
        let key = [session.as_u8()];
        let entry = table.get(key.as_slice()).map_err(redb_err("get"))?;
        match entry {
            Some(val) => Ok(Zeroizing::new(val.value().to_vec())),
            None => Err(SecureStorageError::Storage("keypair not found".into())),
        }
    }

    fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> Result<()> {
        self.pending_keypairs
            .insert(session.as_u8(), Zeroizing::new(data.to_vec()));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DEFAULT_NAMESPACE as SQL_NAMESPACE;
    use tempfile::TempDir;

    const NS: u8 = SQL_NAMESPACE;

    fn make_storage() -> (RedbStorage, TempDir) {
        let dir = TempDir::new().unwrap();
        let storage = RedbStorage::open(dir.path()).unwrap();
        (storage, dir)
    }

    fn make_block(fill: u8) -> Box<[u8; BLOCK_SIZE]> {
        let mut b = Box::new([0u8; BLOCK_SIZE]);
        b.fill(fill);
        b
    }

    // ── Basics ───────────────────────────────────────────────────────

    #[test]
    fn account_generation_state_is_versioned_and_fails_closed() {
        let (mut storage, _dir) = make_storage();
        assert_eq!(storage.account_generation_state().unwrap(), None);
        assert_eq!(
            storage.initialize_empty_account_generation().unwrap(),
            AccountGenerationState::Empty
        );
        assert_eq!(
            storage.account_generation_state().unwrap(),
            Some(AccountGenerationState::Empty)
        );
        assert_eq!(storage.account_generation_epoch().unwrap(), None);

        let txn = storage.db.begin_write().unwrap();
        {
            let mut metadata = txn.open_table(METADATA).unwrap();
            metadata
                .insert(ACCOUNT_GENERATION_STATE_KEY, b"future-state".as_slice())
                .unwrap();
        }
        txn.commit().unwrap();
        assert!(matches!(
            storage.account_generation_state(),
            Err(SecureStorageError::UnsupportedAccountGenerationState)
        ));
    }

    #[test]
    fn portable_fixture_import_export_roundtrip() {
        let (mut storage, _dir) = make_storage();
        let fixture = include_bytes!("../../tests/fixtures/portable-v1-minimal.gossipbackup");

        storage
            .import_portable(std::io::Cursor::new(fixture.as_slice()))
            .unwrap();
        let exported = storage.export_portable(Vec::new()).unwrap();

        assert_eq!(
            storage.account_generation_state().unwrap(),
            Some(AccountGenerationState::Committed)
        );
        let epoch = storage.account_generation_epoch().unwrap().unwrap();
        assert_eq!(epoch.len(), GENERATION_EPOCH_HEX_BYTES);
        assert!(epoch.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(!storage.legacy_portable_import_marker_exists().unwrap());
        assert_eq!(exported, fixture);
        assert_eq!(storage.block_counts[0].get(&0), Some(&1));
        assert_eq!(storage.block_counts[1].get(&0), Some(&1));
        assert_eq!(storage.block_counts[2].get(&0), Some(&1));
    }

    #[test]
    fn failed_portable_import_keeps_previous_installation() {
        let (mut storage, dir) = make_storage();
        let fixture = include_bytes!("../../tests/fixtures/portable-v1-minimal.gossipbackup");
        storage
            .import_portable(std::io::Cursor::new(fixture.as_slice()))
            .unwrap();
        let original_epoch = storage.account_generation_epoch().unwrap();

        let mut corrupted = fixture.to_vec();
        let wrapped_secret = 40 + 26 + 4 + 65_536 + 16;
        corrupted[wrapped_secret] ^= 1;
        assert!(matches!(
            storage.import_portable(std::io::Cursor::new(corrupted)),
            Err(SecureStorageError::PortableChecksumMismatch)
        ));
        assert_eq!(storage.account_generation_epoch().unwrap(), original_epoch);

        drop(storage);
        let mut reopened = RedbStorage::open(dir.path()).unwrap();
        assert_eq!(reopened.export_portable(Vec::new()).unwrap(), fixture);
    }

    #[test]
    fn portable_import_replaces_larger_two_namespace_store() {
        let (mut storage, dir) = make_storage();
        let fixture = include_bytes!("../../tests/fixtures/portable-v1-minimal.gossipbackup");
        storage
            .import_portable(std::io::Cursor::new(fixture.as_slice()))
            .unwrap();

        for slot in 0..SESSION_COUNT as u8 {
            let session = SessionIndex::new(slot).unwrap();
            storage.append_block(session, 0, &make_block(slot)).unwrap();
            storage.append_block(session, 1, &make_block(slot)).unwrap();
        }
        let larger = storage.export_portable(Vec::new()).unwrap();
        let reader = PortableArchiveReader::new(std::io::Cursor::new(larger.as_slice())).unwrap();
        assert_eq!(reader.header().record_count, 12);

        storage
            .import_portable(std::io::Cursor::new(fixture.as_slice()))
            .unwrap();
        drop(storage);

        let mut reopened = RedbStorage::open(dir.path()).unwrap();
        assert_eq!(reopened.export_portable(Vec::new()).unwrap(), fixture);
        for counts in &reopened.block_counts {
            assert_eq!(counts.get(&0), Some(&1));
            assert_eq!(counts.get(&1), None);
        }
    }

    #[test]
    fn portable_export_rejects_unknown_physical_namespace() {
        let (mut storage, _dir) = make_storage();
        let fixture = include_bytes!("../../tests/fixtures/portable-v1-minimal.gossipbackup");
        storage
            .import_portable(std::io::Cursor::new(fixture.as_slice()))
            .unwrap();

        let txn = storage.db.begin_write().unwrap();
        {
            let mut blocks = txn.open_table(BLOCKS).unwrap();
            let key = RedbStorage::make_block_key(0, 2, 0);
            blocks
                .insert(key.as_slice(), &[0_u8; BLOCK_SIZE][..])
                .unwrap();
        }
        txn.commit().unwrap();

        assert!(matches!(
            storage.export_portable(Vec::new()),
            Err(SecureStorageError::InvalidPortableArchive)
        ));
    }

    #[test]
    fn test_open_creates_db() {
        let dir = TempDir::new().unwrap();
        let _storage = RedbStorage::open(dir.path()).unwrap();
        assert!(dir.path().join("storage.redb").exists());
    }

    #[test]
    fn test_append_and_read() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        let block = make_block(0xAB);
        s.append_block(si, NS, &block).unwrap();
        let got = s.read_block(si, NS, 0).unwrap();
        assert_eq!(*got, *block);
    }

    #[test]
    fn test_write_overwrites() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.append_block(si, NS, &make_block(0xAA)).unwrap();
        s.write_block(si, NS, 0, &make_block(0xBB)).unwrap();
        let got = s.read_block(si, NS, 0).unwrap();
        assert_eq!(got[0], 0xBB);
    }

    #[test]
    fn test_ram_buffer_last_write_wins() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.append_block(si, NS, &make_block(0xAA)).unwrap();
        s.write_block(si, NS, 0, &make_block(0xBB)).unwrap();
        s.write_block(si, NS, 0, &make_block(0xCC)).unwrap();
        let got = s.read_block(si, NS, 0).unwrap();
        assert_eq!(got[0], 0xCC);
    }

    #[test]
    fn test_block_count() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        assert_eq!(s.block_count(si, NS).unwrap(), 0);
        s.append_block(si, NS, &make_block(1)).unwrap();
        assert_eq!(s.block_count(si, NS).unwrap(), 1);
        s.append_block(si, NS, &make_block(2)).unwrap();
        assert_eq!(s.block_count(si, NS).unwrap(), 2);
    }

    #[test]
    fn test_sessions_independent() {
        let (mut s, _dir) = make_storage();
        let s0 = SessionIndex::new(0).unwrap();
        let s1 = SessionIndex::new(1).unwrap();
        s.append_block(s0, NS, &make_block(0xAA)).unwrap();
        assert_eq!(s.block_count(s0, NS).unwrap(), 1);
        assert_eq!(s.block_count(s1, NS).unwrap(), 0);
    }

    #[test]
    fn test_namespaces_independent() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.append_block(si, 0, &make_block(0xAA)).unwrap();
        s.append_block(si, 1, &make_block(0xBB)).unwrap();
        assert_eq!(s.block_count(si, 0).unwrap(), 1);
        assert_eq!(s.block_count(si, 1).unwrap(), 1);
        assert_eq!(s.read_block(si, 0, 0).unwrap()[0], 0xAA);
        assert_eq!(s.read_block(si, 1, 0).unwrap()[0], 0xBB);
    }

    #[test]
    fn test_read_oob() {
        let (s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        assert!(s.read_block(si, NS, 0).is_err());
    }

    #[test]
    fn test_write_oob() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        assert!(s.write_block(si, NS, 0, &make_block(0)).is_err());
    }

    // ── Keypair ──────────────────────────────────────────────────────

    #[test]
    fn test_keypair_roundtrip() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.write_keypair(si, b"fake-keypair-data").unwrap();
        let got = s.read_keypair(si).unwrap();
        assert_eq!(&*got, b"fake-keypair-data");
    }

    #[test]
    fn test_keypair_write_is_pending_until_commit() {
        // Keypair writes must share commit() atomicity with staged block
        // rewrites. destroy_session relies on this so a process kill
        // before commit leaves both the old keypair and old blocks on disk.
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        let si = SessionIndex::new(0).unwrap();

        let mut s = RedbStorage::open(&path).unwrap();
        s.write_keypair(si, b"pending-keypair").unwrap();
        assert_eq!(&*s.read_keypair(si).unwrap(), b"pending-keypair");

        drop(s);
        let s = RedbStorage::open(&path).unwrap();
        assert!(
            s.read_keypair(si).is_err(),
            "uncommitted keypair write must not survive reopen"
        );
    }

    #[test]
    fn test_discard_pending_drops_staged_keypair_writes() {
        // A failed multi-step destroy must be able to discard the dummy
        // keypair together with any staged block rewrites.
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        let si = SessionIndex::new(0).unwrap();

        {
            let mut s = RedbStorage::open(&path).unwrap();
            s.write_keypair(si, b"committed-keypair").unwrap();
            s.commit().unwrap();
        }

        let mut s = RedbStorage::open(&path).unwrap();
        s.write_keypair(si, b"discarded-keypair").unwrap();
        assert_eq!(&*s.read_keypair(si).unwrap(), b"discarded-keypair");

        s.discard_pending();
        assert_eq!(&*s.read_keypair(si).unwrap(), b"committed-keypair");

        s.commit().unwrap();
        drop(s);

        let s = RedbStorage::open(&path).unwrap();
        assert_eq!(&*s.read_keypair(si).unwrap(), b"committed-keypair");
    }

    #[test]
    fn test_keypair_not_found() {
        let (s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        assert!(s.read_keypair(si).is_err());
    }

    // ── Persistence ──────────────────────────────────────────────────

    #[test]
    fn test_commit_persists_across_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        {
            let mut s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            s.append_block(si, NS, &make_block(0xCD)).unwrap();
            s.commit().unwrap();
        }
        {
            let s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            assert_eq!(s.block_count(si, NS).unwrap(), 1);
            assert_eq!(s.read_block(si, NS, 0).unwrap()[0], 0xCD);
        }
    }

    #[test]
    fn test_uncommitted_writes_lost_on_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        {
            let mut s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            s.append_block(si, NS, &make_block(0xEE)).unwrap();
            // No commit: drop.
        }
        {
            let s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            assert_eq!(s.block_count(si, NS).unwrap(), 0);
        }
    }

    #[test]
    fn test_reset_blockstream_clears_namespace() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.append_block(si, NS, &make_block(0xAA)).unwrap();
        s.append_block(si, 1, &make_block(0xBB)).unwrap();
        s.commit().unwrap();

        s.reset_blockstream(si, NS).unwrap();
        assert_eq!(s.block_count(si, NS).unwrap(), 0);
        // Other namespace untouched.
        assert_eq!(s.block_count(si, 1).unwrap(), 1);
    }

    #[test]
    fn test_namespace_persists_across_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        {
            let mut s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            s.append_block(si, 0, &make_block(0x11)).unwrap();
            s.append_block(si, 1, &make_block(0x22)).unwrap();
            s.commit().unwrap();
        }
        {
            let s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            assert_eq!(s.block_count(si, 0).unwrap(), 1);
            assert_eq!(s.block_count(si, 1).unwrap(), 1);
            assert_eq!(s.read_block(si, 0, 0).unwrap()[0], 0x11);
            assert_eq!(s.read_block(si, 1, 0).unwrap()[0], 0x22);
        }
    }

    #[test]
    fn test_discard_pending_drops_staged_writes() {
        // Regression: a multi-step operation that stages writes via
        // write_block must be able to roll them back without
        // committing, otherwise the staged bytes silently ride along
        // on the next caller's commit. See native_vfs::destroy_session
        // for the wrapper that uses this on error.
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        let si = SessionIndex::new(0).unwrap();

        // Establish a baseline on disk: one committed block.
        {
            let mut s = RedbStorage::open(&path).unwrap();
            s.append_block(si, NS, &make_block(0xAA)).unwrap();
            s.commit().unwrap();
        }

        // Stage an overwrite of that block in RAM, then discard.
        // The on-disk byte must still be the baseline 0xAA.
        let mut s = RedbStorage::open(&path).unwrap();
        s.write_block(si, NS, 0, &make_block(0xBB)).unwrap();
        // The in-RAM read returns the staged overwrite.
        assert_eq!(s.read_block(si, NS, 0).unwrap()[0], 0xBB);

        s.discard_pending();
        // After discard, reads fall back to the on-disk value.
        assert_eq!(s.read_block(si, NS, 0).unwrap()[0], 0xAA);

        // A subsequent commit must NOT carry the discarded write.
        s.commit().unwrap();

        // Reopen from disk and confirm the staged byte never landed.
        drop(s);
        let s = RedbStorage::open(&path).unwrap();
        assert_eq!(s.read_block(si, NS, 0).unwrap()[0], 0xAA);
    }
}
