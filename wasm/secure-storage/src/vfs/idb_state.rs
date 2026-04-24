//! Pure-Rust state for the IDB-backed block storage.
//!
//! This module owns the in-memory representation of secure-storage data
//! that lives behind an IndexedDB persistence layer. It contains:
//!
//!   * [`IdbKey`] — the typed key used in the IDB store, with a single
//!     source of truth for encoding and parsing
//!   * [`IdbStorageState`] — the in-memory storage + dirty tracking
//!     tracking that bridge sync VFS reads/writes with async IDB I/O
//!

use std::collections::{HashMap, HashSet};

use zeroize::Zeroizing;

use crate::constants::{BLOCK_SIZE, SESSION_COUNT};
use crate::error::{Result, SecureStorageError};

// ── Typed IDB key ──────────────────────────────────────────────────

/// A typed key in the secure-storage IndexedDB store.
///
/// String encoding (single source of truth for the on-disk schema):
///
///   * `Block { session: 0, namespace: 1, idx: 42 }` ⟶ `"s:0:n:1:b:42"`
///   * `Keypair { session: 0 }`                       ⟶ `"s:0:kp"`
///
/// Always go through [`IdbKey::encode`] / [`IdbKey::parse`]; never
/// build IDB key strings ad-hoc anywhere else in the codebase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IdbKey {
    Block {
        session: u8,
        namespace: u8,
        idx: u64,
    },
    Keypair {
        session: u8,
    },
}

impl IdbKey {
    /// Encode to the IDB string key.
    pub fn encode(&self) -> String {
        match self {
            IdbKey::Block {
                session,
                namespace,
                idx,
            } => format!("s:{session}:n:{namespace}:b:{idx}"),
            IdbKey::Keypair { session } => format!("s:{session}:kp"),
        }
    }

    /// Parse a string key. Returns `None` if malformed or session out of bounds.
    pub fn parse(s: &str) -> Option<Self> {
        let rest = s.strip_prefix("s:")?;
        let (session_str, rest) = rest.split_once(':')?;
        let session: u8 = session_str.parse().ok()?;
        if (session as usize) >= SESSION_COUNT {
            return None;
        }
        if rest == "kp" {
            return Some(IdbKey::Keypair { session });
        }
        let rest = rest.strip_prefix("n:")?;
        let (ns_str, rest) = rest.split_once(':')?;
        let namespace: u8 = ns_str.parse().ok()?;
        let idx: u64 = rest.strip_prefix("b:")?.parse().ok()?;
        Some(IdbKey::Block {
            session,
            namespace,
            idx,
        })
    }
}

// ── In-memory state ────────────────────────────────────────────────

/// In-memory state of the IDB-backed block storage.
///
/// **Storage layout**: per `(session, namespace)` pair, a contiguous `Vec` of
/// `Option<Box<[u8; BLOCK_SIZE]>>`. `None` slots represent gaps from sparse
/// writes (rare in practice — bordercrypt writes are append-dense). The `Vec`
/// length equals the highest used block index + 1, matching the semantics of
/// [`Self::block_count`].
///
/// Per session, namespaces are stored in a [`HashMap`] keyed by namespace
/// byte. Only namespaces that have been written to consume any memory.
///
/// **Why Vec instead of HashMap for blocks**: append-dense access pattern
/// + lower per-entry overhead (~24 bytes per HashMap bucket → 0 for Vec) +
/// O(1) indexed lookup (we always know the block index — no membership
/// scan, which would be O(n)). On a 10K-block DB, saves ~240 KB of bucket
/// overhead and one hash computation per read.
///
/// **Invariants** preserved by all methods:
///
///   1. `dirty_blocks ⊆ { (s,n,b) : blocks[s][n][b] = Some(_) }`
///      — never mark a missing/None block dirty
///   2. `block_count(s, n) == blocks[s][n].len()` (or 0 if absent)
///
/// **Plausible deniability**: this layer is symmetric across sessions —
/// it never differentiates "real" vs "decoy" slots. Symmetry of writes
/// across slots is the responsibility of the upper bordercrypt layer.
pub struct IdbStorageState {
    /// `blocks[session][namespace] = Vec<...>`. Lazy populated: only
    /// `(session, namespace)` pairs that have been touched get an entry.
    blocks: [HashMap<u8, Vec<Option<Box<[u8; BLOCK_SIZE]>>>>; SESSION_COUNT],
    /// `keypairs[session] = Some(serialized_keypair)` if allocated.
    keypairs: [Option<Zeroizing<Vec<u8>>>; SESSION_COUNT],
    /// `(session, namespace, block)` keys whose value must be PUT to IDB
    /// on next flush.
    dirty_blocks: HashSet<(u8, u8, u64)>,
    /// Sessions whose keypair must be PUT to IDB on next flush.
    dirty_keypairs: HashSet<u8>,
}

impl Default for IdbStorageState {
    fn default() -> Self {
        Self::new()
    }
}

impl IdbStorageState {
    /// Construct an empty state.
    pub fn new() -> Self {
        Self {
            blocks: std::array::from_fn(|_| HashMap::new()),
            keypairs: std::array::from_fn(|_| None),
            dirty_blocks: HashSet::new(),
            dirty_keypairs: HashSet::new(),
        }
    }

    /// Reconstruct state from a list of `(key, value)` entries loaded from IDB.
    ///
    /// Entries are silently skipped (counted in the returned `usize`) when:
    ///   - the key fails to parse via [`IdbKey::parse`] (malformed legacy key
    ///     or future-version data we don't yet understand);
    ///   - the value's length doesn't match `BLOCK_SIZE` (block entries only);
    ///   - the block index is `>= 1_000_000` — a DoS guard against a corrupted
    ///     or malicious IDB causing pathological `Vec::resize_with` allocations
    ///     (1M blocks × ~16 KB = 16 GB per session, well beyond any real use).
    ///
    /// Skipped count is returned for diagnostics, never logged here. Loaded
    /// entries are NOT marked dirty.
    pub fn from_entries<'a, I>(entries: I) -> (Self, usize)
    where
        I: IntoIterator<Item = (&'a str, &'a [u8])>,
    {
        let mut state = Self::new();
        let mut skipped = 0usize;
        for (key_str, val) in entries {
            match IdbKey::parse(key_str) {
                Some(IdbKey::Block {
                    session,
                    namespace,
                    idx,
                }) if val.len() == BLOCK_SIZE && idx < 1_000_000 => {
                    let mut data = Box::new([0u8; BLOCK_SIZE]);
                    data.copy_from_slice(val);
                    // `or_default()` lazily inserts an empty Vec the first
                    // time we see this (session, namespace) pair — expected.
                    let vec = state.blocks[session as usize].entry(namespace).or_default();
                    let i = idx as usize;
                    // `resize_with(i + 1, ..)` makes the Vec exactly `i + 1`
                    // long, so `vec[i]` is always valid afterwards regardless
                    // of how far `i` exceeds the current length (not just the
                    // `i == len` boundary).
                    if i >= vec.len() {
                        vec.resize_with(i + 1, || None);
                    }
                    vec[i] = Some(data);
                }
                Some(IdbKey::Keypair { session }) => {
                    state.keypairs[session as usize] = Some(Zeroizing::new(val.to_vec()));
                }
                _ => {
                    // Unmatched entry: see the doc above for the categories.
                    skipped += 1;
                }
            }
        }
        (state, skipped)
    }

    /// True if there is nothing to flush to IDB.
    #[cfg(test)]
    pub fn is_clean(&self) -> bool {
        self.dirty_blocks.is_empty() && self.dirty_keypairs.is_empty()
    }

    // ── Block ops ──────────────────────────────────────────────

    pub fn read_block(
        &self,
        session: u8,
        namespace: u8,
        block: u64,
    ) -> Result<Box<[u8; BLOCK_SIZE]>> {
        let stream = self.blocks[session as usize]
            .get(&namespace)
            .ok_or_else(|| {
                SecureStorageError::Storage(format!(
                    "block not found: session={session}, namespace={namespace}, block={block}"
                ))
            })?;
        match stream.get(block as usize).and_then(|opt| opt.as_ref()) {
            Some(data) => Ok(data.clone()),
            None => Err(SecureStorageError::Storage(format!(
                "block not found: session={session}, namespace={namespace}, block={block}"
            ))),
        }
    }

    pub fn write_block(&mut self, session: u8, namespace: u8, block: u64, data: &[u8; BLOCK_SIZE]) {
        let stream = self.blocks[session as usize].entry(namespace).or_default();
        let i = block as usize;
        // `resize_with(i + 1, ..)` extends to exactly `i + 1` elements, so
        // `stream[i]` is valid for any `i >= stream.len()` (not only the
        // `i == len` boundary).
        if i >= stream.len() {
            stream.resize_with(i + 1, || None);
        }
        stream[i] = Some(Box::new(*data));
        self.dirty_blocks.insert((session, namespace, block));
    }

    pub fn append_block(&mut self, session: u8, namespace: u8, data: &[u8; BLOCK_SIZE]) {
        let stream = self.blocks[session as usize].entry(namespace).or_default();
        let block = stream.len() as u64;
        stream.push(Some(Box::new(*data)));
        self.dirty_blocks.insert((session, namespace, block));
    }

    pub fn block_count(&self, session: u8, namespace: u8) -> u64 {
        self.blocks[session as usize]
            .get(&namespace)
            .map_or(0, |v| v.len() as u64)
    }

    /// Wipe all blocks of a `(session, namespace)` pair and queue them for
    /// IDB deletion.
    ///
    /// **Critical for plausible deniability**: leftover blocks in IDB
    /// would let an attacker observe per-slot block-count asymmetry.
    /// This method tombstones every existing block of the namespace so
    /// the next flush physically deletes them from IndexedDB. Other
    /// namespaces of the same session are untouched.
    pub fn reset_blockstream(&mut self, session: u8, namespace: u8) {
        let session_streams = &mut self.blocks[session as usize];
        // Remove old blocks from cache and dirty set. No tombstones needed:
        // the global block count never decreases (spec §14), so every old
        // index will be overwritten by repair_blockstream_lengths or
        // encrypt_session_data_block before the next flush.
        let old = session_streams.remove(&namespace).unwrap_or_default();
        for (b, slot) in old.into_iter().enumerate() {
            if slot.is_some() {
                self.dirty_blocks.remove(&(session, namespace, b as u64));
            }
        }
        // Re-insert an empty vector so the namespace exists with length 0
        // (matches MemoryStorage::reset_blockstream semantics).
        session_streams.insert(namespace, Vec::new());
    }

    // ── Keypair ops ────────────────────────────────────────────

    pub fn read_keypair(&self, session: u8) -> Result<Zeroizing<Vec<u8>>> {
        let slot = self.keypairs.get(session as usize).ok_or_else(|| {
            SecureStorageError::Storage(format!(
                "invalid session: {session} (max {})",
                SESSION_COUNT - 1
            ))
        })?;
        match slot {
            Some(data) => Ok(data.clone()),
            None => Err(SecureStorageError::Storage(format!(
                "keypair not found: session={session}"
            ))),
        }
    }

    pub fn write_keypair(&mut self, session: u8, data: &[u8]) -> Result<()> {
        let slot = self.keypairs.get_mut(session as usize).ok_or_else(|| {
            SecureStorageError::Storage(format!(
                "invalid session: {session} (max {})",
                SESSION_COUNT - 1
            ))
        })?;
        *slot = Some(Zeroizing::new(data.to_vec()));
        self.dirty_keypairs.insert(session);
        Ok(())
    }

    // ── Drain / restore for async persistence ──────────────────

    /// Atomically drain all pending writes/deletes into a [`DirtySnapshot`].
    ///
    /// After this call, the state is "clean": dirty sets and tombstones
    /// are empty. New writes that arrive while the caller is busy
    /// persisting the snapshot will be re-marked dirty naturally and
    /// captured at the next drain — **no race, no data loss**.
    ///
    /// The caller MUST handle the snapshot:
    ///   * On IDB write success: drop the snapshot. Done.
    ///   * On IDB write failure: call [`Self::restore_pending`] to
    ///     re-mark the entries dirty for the next retry.
    ///
    /// This pattern (drain + restore) replaces the older snapshot+commit
    /// pattern, which had a subtle bug where overwriting a block during
    /// the in-flight flush would silently lose the new value.
    pub fn drain_pending(&mut self) -> DirtySnapshot {
        let dirty_blocks = std::mem::take(&mut self.dirty_blocks);
        let dirty_keypairs = std::mem::take(&mut self.dirty_keypairs);

        // Build the snapshot by reading current cache values for each
        // drained dirty key. Filter out any entries whose cache slot
        // is missing (defensive — shouldn't happen given invariant 1).
        let block_puts: Vec<((u8, u8, u64), Box<[u8; BLOCK_SIZE]>)> = dirty_blocks
            .iter()
            .filter_map(|&(s, n, b)| {
                self.blocks[s as usize]
                    .get(&n)
                    .and_then(|vec| vec.get(b as usize))
                    .and_then(|opt| opt.as_ref())
                    .map(|d| ((s, n, b), d.clone()))
            })
            .collect();

        let keypair_puts: Vec<(u8, Zeroizing<Vec<u8>>)> = dirty_keypairs
            .iter()
            .filter_map(|&s| {
                self.keypairs[s as usize]
                    .as_ref()
                    .map(|d| (s, Zeroizing::new(d.to_vec())))
            })
            .collect();

        DirtySnapshot {
            block_puts,
            keypair_puts,
        }
    }

    /// Restore a drained snapshot (called only on IDB write failure).
    ///
    /// Re-marks each entry as dirty so it will be retried at the next
    /// drain. Entries whose cache slot has been wiped since the drain
    /// (e.g., by [`Self::reset_blockstream`]) are silently skipped —
    /// there is nothing to retry.
    pub fn restore_pending(&mut self, snap: DirtySnapshot) {
        for ((s, n, b), _data) in snap.block_puts {
            // Only restore if the block is still in cache.
            if self.blocks[s as usize]
                .get(&n)
                .and_then(|vec| vec.get(b as usize))
                .and_then(|o| o.as_ref())
                .is_some()
            {
                self.dirty_blocks.insert((s, n, b));
            }
        }
        for (s, _data) in snap.keypair_puts {
            if self.keypairs[s as usize].is_some() {
                self.dirty_keypairs.insert(s);
            }
        }
    }
}

/// A snapshot of pending IDB operations to be committed atomically.
pub struct DirtySnapshot {
    pub block_puts: Vec<((u8, u8, u64), Box<[u8; BLOCK_SIZE]>)>,
    pub keypair_puts: Vec<(u8, Zeroizing<Vec<u8>>)>,
}

impl DirtySnapshot {
    pub fn is_empty(&self) -> bool {
        self.block_puts.is_empty() && self.keypair_puts.is_empty()
    }
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DEFAULT_NAMESPACE;

    const NS: u8 = DEFAULT_NAMESPACE;

    fn block(b: u8) -> [u8; BLOCK_SIZE] {
        [b; BLOCK_SIZE]
    }

    // ── IdbKey: encode ──

    #[test]
    fn key_encode_block() {
        assert_eq!(
            IdbKey::Block {
                session: 0,
                namespace: 0,
                idx: 0,
            }
            .encode(),
            "s:0:n:0:b:0"
        );
        assert_eq!(
            IdbKey::Block {
                session: 2,
                namespace: 1,
                idx: 1234,
            }
            .encode(),
            "s:2:n:1:b:1234"
        );
    }

    #[test]
    fn key_encode_keypair() {
        assert_eq!(IdbKey::Keypair { session: 0 }.encode(), "s:0:kp");
        assert_eq!(IdbKey::Keypair { session: 2 }.encode(), "s:2:kp");
    }

    // ── IdbKey: parse ──

    #[test]
    fn key_parse_block() {
        assert_eq!(
            IdbKey::parse("s:0:n:0:b:0"),
            Some(IdbKey::Block {
                session: 0,
                namespace: 0,
                idx: 0,
            })
        );
        assert_eq!(
            IdbKey::parse("s:2:n:7:b:1234567890"),
            Some(IdbKey::Block {
                session: 2,
                namespace: 7,
                idx: 1234567890,
            })
        );
    }

    #[test]
    fn key_parse_keypair() {
        assert_eq!(
            IdbKey::parse("s:0:kp"),
            Some(IdbKey::Keypair { session: 0 })
        );
    }

    #[test]
    fn key_parse_rejects_malformed() {
        assert_eq!(IdbKey::parse(""), None);
        assert_eq!(IdbKey::parse("s:"), None);
        assert_eq!(IdbKey::parse("s:0"), None);
        assert_eq!(IdbKey::parse("foo:0:n:0:b:0"), None);
        assert_eq!(IdbKey::parse("s:abc:n:0:b:0"), None);
        assert_eq!(IdbKey::parse("s:0:n:abc:b:0"), None);
        assert_eq!(IdbKey::parse("s:0:n:0:b:abc"), None);
        assert_eq!(IdbKey::parse("s:0:x:0:b:0"), None);
        assert_eq!(IdbKey::parse("s:0:n:0:b"), None);
        // Old (pre-namespace) encoding must no longer parse.
        assert_eq!(IdbKey::parse("s:0:b:0"), None);
    }

    #[test]
    fn key_parse_rejects_session_out_of_bounds() {
        assert_eq!(IdbKey::parse(&format!("s:{}:kp", SESSION_COUNT)), None);
        assert_eq!(
            IdbKey::parse(&format!("s:{}:n:0:b:0", SESSION_COUNT + 10)),
            None
        );
    }

    #[test]
    fn key_roundtrip() {
        for k in [
            IdbKey::Block {
                session: 0,
                namespace: 0,
                idx: 0,
            },
            IdbKey::Block {
                session: (SESSION_COUNT - 1) as u8,
                namespace: 255,
                idx: u64::MAX,
            },
            IdbKey::Keypair { session: 1 },
            IdbKey::Keypair {
                session: (SESSION_COUNT - 1) as u8,
            },
        ] {
            assert_eq!(IdbKey::parse(&k.encode()), Some(k));
        }
    }

    // ── State: basics ──

    #[test]
    fn empty_state_is_clean() {
        let mut s = IdbStorageState::new();
        assert!(s.is_clean());
        assert!(s.drain_pending().is_empty());
    }

    #[test]
    fn write_block_marks_dirty() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 0, &block(1));
        assert!(!s.is_clean());
        let snap = s.drain_pending();
        assert_eq!(snap.block_puts.len(), 1);
        assert_eq!(snap.keypair_puts.len(), 0);
    }

    #[test]
    fn write_block_updates_count() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 5, &block(1));
        assert_eq!(s.block_count(0, NS), 6);
        assert_eq!(s.block_count(1, NS), 0);
    }

    #[test]
    fn write_block_count_does_not_decrease() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 5, &block(1));
        s.write_block(0, NS, 2, &block(2));
        // Writing to a lower index must not shrink the count.
        assert_eq!(s.block_count(0, NS), 6);
    }

    #[test]
    fn write_block_at_higher_index_creates_gap() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 5, &block(1));
        // Block 5 is present, blocks 0-4 are gaps (None).
        assert_eq!(s.block_count(0, NS), 6);
        assert!(s.read_block(0, NS, 5).is_ok());
        assert!(s.read_block(0, NS, 0).is_err());
        assert!(s.read_block(0, NS, 4).is_err());
    }

    #[test]
    fn append_block_increments_count() {
        let mut s = IdbStorageState::new();
        s.append_block(2, NS, &block(1));
        s.append_block(2, NS, &block(2));
        s.append_block(2, NS, &block(3));
        assert_eq!(s.block_count(2, NS), 3);
        assert_eq!(s.read_block(2, NS, 1).unwrap()[0], 2);
    }

    #[test]
    fn read_block_returns_data() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 0, &block(42));
        let read = s.read_block(0, NS, 0).unwrap();
        assert_eq!(read[0], 42);
        assert_eq!(read.len(), BLOCK_SIZE);
    }

    #[test]
    fn read_missing_block_errors() {
        let s = IdbStorageState::new();
        assert!(s.read_block(0, NS, 0).is_err());
    }

    #[test]
    fn read_block_out_of_bounds_errors() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 0, &block(1));
        assert!(s.read_block(0, NS, 100).is_err());
    }

    #[test]
    fn write_keypair_marks_dirty() {
        let mut s = IdbStorageState::new();
        s.write_keypair(0, b"my keypair").unwrap();
        let snap = s.drain_pending();
        assert_eq!(snap.keypair_puts.len(), 1);
    }

    #[test]
    fn read_keypair_returns_data() {
        let mut s = IdbStorageState::new();
        s.write_keypair(0, b"hello").unwrap();
        assert_eq!(&*s.read_keypair(0).unwrap(), b"hello");
    }

    #[test]
    fn read_missing_keypair_errors() {
        let s = IdbStorageState::new();
        assert!(s.read_keypair(0).is_err());
    }

    // ── Namespace independence ──

    #[test]
    fn namespaces_are_independent() {
        let mut s = IdbStorageState::new();
        s.write_block(0, 0, 0, &block(0xAA));
        s.write_block(0, 1, 0, &block(0xBB));
        s.write_block(0, 1, 1, &block(0xCC));

        assert_eq!(s.block_count(0, 0), 1);
        assert_eq!(s.block_count(0, 1), 2);
        assert_eq!(s.block_count(0, 2), 0);

        assert_eq!(s.read_block(0, 0, 0).unwrap()[0], 0xAA);
        assert_eq!(s.read_block(0, 1, 0).unwrap()[0], 0xBB);
        assert_eq!(s.read_block(0, 1, 1).unwrap()[0], 0xCC);

        // dirty entries are tagged per (session, namespace, block)
        let snap = s.drain_pending();
        assert_eq!(snap.block_puts.len(), 3);
    }

    #[test]
    fn reset_blockstream_only_wipes_target_namespace() {
        let mut s = IdbStorageState::new();
        s.write_block(0, 0, 0, &block(0xAA));
        s.write_block(0, 1, 0, &block(0xBB));
        let _ = s.drain_pending();

        s.reset_blockstream(0, 0);

        assert!(s.read_block(0, 0, 0).is_err());
        assert!(s.read_block(0, 1, 0).is_ok());

        // No tombstones — old IDB entries will be overwritten by
        // repair_blockstream_lengths before next flush.
        assert!(s.is_clean());
    }

    // ── State: drain / restore semantics ──

    #[test]
    fn drain_pending_clears_dirty() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 0, &block(1));
        s.write_keypair(0, b"kp").unwrap();
        assert!(!s.is_clean());

        let snap = s.drain_pending();
        assert_eq!(snap.block_puts.len(), 1);
        assert_eq!(snap.keypair_puts.len(), 1);

        // Drain leaves the state clean — no need for a separate commit step.
        assert!(s.is_clean());
    }

    #[test]
    fn drain_pending_does_not_clear_cache() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 0, &block(42));
        let _snap = s.drain_pending();

        // Cache is still readable after drain — drain only clears dirty,
        // not the actual data.
        assert_eq!(s.read_block(0, NS, 0).unwrap()[0], 42);
    }

    #[test]
    fn write_to_different_block_during_pending_flush_is_not_lost() {
        // The classic case: drain captures (0,NS,0), then a new write to a
        // DIFFERENT block (0,NS,1) arrives. After the simulated flush
        // succeeds (snapshot dropped), (0,NS,1) must still be dirty.
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 0, &block(1));
        let snap = s.drain_pending();
        assert!(s.is_clean());

        // New write on a different key while "flush in flight"
        s.write_block(0, NS, 1, &block(2));

        // Flush completes — drop snapshot, no restore
        drop(snap);

        // The new write must still be dirty
        assert!(!s.is_clean());
        let next = s.drain_pending();
        assert_eq!(next.block_puts.len(), 1);
        assert_eq!(next.block_puts[0].0, (0, NS, 1));
    }

    #[test]
    fn overwrite_same_block_during_pending_flush_is_not_lost() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 0, &block(1)); // D1
        let snap = s.drain_pending();
        assert!(s.is_clean());
        assert_eq!(snap.block_puts.len(), 1);
        assert_eq!(snap.block_puts[0].1[0], 1);

        // OVERWRITE the same block while "flush in flight"
        s.write_block(0, NS, 0, &block(2)); // D2

        // Flush completes — D1 is in IDB. Drop snap.
        drop(snap);

        // D2 must still be dirty — otherwise it would never reach IDB
        // and would be lost on next reload.
        assert!(!s.is_clean());
        let next = s.drain_pending();
        assert_eq!(next.block_puts.len(), 1);
        assert_eq!(next.block_puts[0].1[0], 2); // D2, not D1
    }

    #[test]
    fn restore_pending_after_idb_failure() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 0, &block(1));
        s.write_block(0, NS, 1, &block(2));
        s.write_keypair(0, b"kp").unwrap();

        let snap = s.drain_pending();
        assert!(s.is_clean());

        // Simulate IDB failure
        s.restore_pending(snap);

        // All three entries are dirty again
        assert!(!s.is_clean());
        let next = s.drain_pending();
        assert_eq!(next.block_puts.len(), 2);
        assert_eq!(next.keypair_puts.len(), 1);
    }

    #[test]
    fn restore_pending_skips_blocks_wiped_since_drain() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 0, &block(1));
        s.write_block(0, NS, 1, &block(2));
        s.write_block(1, NS, 0, &block(3));

        let snap = s.drain_pending();
        assert_eq!(snap.block_puts.len(), 3);

        // Wipe session 0 namespace NS between drain and restore
        s.reset_blockstream(0, NS);

        // Restore the failed snapshot
        s.restore_pending(snap);

        // Session 0 entries are gone (cache wiped), only session 1 is back.
        let next = s.drain_pending();
        assert_eq!(next.block_puts.len(), 1); // session 1, NS, block 0
        assert_eq!(next.block_puts[0].0, (1, NS, 0));
    }

    #[test]
    fn restore_pending_keypair_skips_wiped() {
        let mut s = IdbStorageState::new();
        s.write_keypair(0, b"kp").unwrap();
        let snap = s.drain_pending();

        // Manually clear the keypair (simulating a hypothetical wipe)
        s.keypairs[0] = None;

        s.restore_pending(snap);
        // Keypair was wiped — restore is skipped.
        assert!(s.dirty_keypairs.is_empty());
    }

    // ── reset_blockstream without tombstones ──
    //
    // Since the global block count never decreases (spec §14), old IDB
    // entries are always overwritten by repair_blockstream_lengths or
    // encrypt_session_data_block before the next flush. No deletes needed.

    #[test]
    fn reset_blockstream_clears_ram_and_dirty() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 0, &block(1));
        s.write_block(0, NS, 1, &block(2));
        s.write_block(0, NS, 2, &block(3));
        assert_eq!(s.block_count(0, NS), 3);

        s.reset_blockstream(0, NS);

        // Blocks gone from RAM.
        assert!(s.read_block(0, NS, 0).is_err());
        assert!(s.read_block(0, NS, 1).is_err());
        assert!(s.read_block(0, NS, 2).is_err());
        assert_eq!(s.block_count(0, NS), 0);

        // No dirty, no deletes — state is clean.
        assert!(s.is_clean());
    }

    #[test]
    fn reset_blockstream_then_write_is_dirty() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 0, &block(1));
        let _ = s.drain_pending();

        s.reset_blockstream(0, NS);
        s.write_block(0, NS, 0, &block(42));

        let snap = s.drain_pending();
        assert_eq!(snap.block_puts.len(), 1);
        assert_eq!(snap.block_puts[0].1[0], 42);
    }

    #[test]
    fn reset_blockstream_clears_dirty_for_wiped_blocks() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 0, &block(1));
        // Don't drain — block is still dirty
        s.reset_blockstream(0, NS);

        // The dirty marker for (0,NS,0) must be gone.
        assert!(s.is_clean());
    }

    #[test]
    fn reset_blockstream_does_not_affect_other_sessions() {
        let mut s = IdbStorageState::new();
        s.write_block(0, NS, 0, &block(1));
        s.write_block(1, NS, 0, &block(2));
        let _ = s.drain_pending();

        s.reset_blockstream(0, NS);

        // Session 1 untouched.
        assert!(s.read_block(1, NS, 0).is_ok());
        assert_eq!(s.block_count(1, NS), 1);

        // Only session 0 was wiped, no pending ops.
        assert!(s.is_clean());
    }

    // ── from_entries ──

    #[test]
    fn from_entries_loads_blocks() {
        let data = block(9);
        let entries: Vec<(&str, &[u8])> = vec![
            ("s:0:n:0:b:0", &data[..]),
            ("s:0:n:0:b:5", &data[..]),
            ("s:0:n:1:b:0", &data[..]),
        ];
        let (s, skipped) = IdbStorageState::from_entries(entries);
        assert_eq!(skipped, 0);
        assert_eq!(s.block_count(0, 0), 6);
        assert_eq!(s.block_count(0, 1), 1);
        assert!(s.read_block(0, 0, 0).is_ok());
        assert!(s.read_block(0, 0, 5).is_ok());
        assert!(s.read_block(0, 1, 0).is_ok());
        // Loaded entries are NOT dirty.
        assert!(s.is_clean());
    }

    #[test]
    fn from_entries_loads_keypair() {
        let kp = vec![1u8, 2, 3, 4];
        let entries: Vec<(&str, &[u8])> = vec![("s:0:kp", &kp[..])];
        let (s, skipped) = IdbStorageState::from_entries(entries);
        assert_eq!(skipped, 0);
        assert_eq!(&*s.read_keypair(0).unwrap(), &[1, 2, 3, 4]);
    }

    #[test]
    fn from_entries_skips_malformed() {
        let data = block(0);
        let entries: Vec<(&str, &[u8])> = vec![
            ("garbage", &data[..]),
            ("s:99:n:0:b:0", &data[..]),
            ("s:0:n:0:b:0", &data[..]),
        ];
        let (s, skipped) = IdbStorageState::from_entries(entries);
        assert_eq!(skipped, 2);
        assert_eq!(s.block_count(0, NS), 1);
    }

    #[test]
    fn from_entries_skips_wrong_block_size() {
        let short = vec![0u8; BLOCK_SIZE - 1];
        let entries: Vec<(&str, &[u8])> = vec![("s:0:n:0:b:0", &short[..])];
        let (s, skipped) = IdbStorageState::from_entries(entries);
        assert_eq!(skipped, 1);
        assert_eq!(s.block_count(0, NS), 0);
    }

    // ── Session range safety ──

    /// Regression: raw indexing `self.keypairs[session as usize]` panics for
    /// `session >= SESSION_COUNT`. The method must return an error instead.
    #[test]
    fn read_keypair_invalid_session_returns_error() {
        let s = IdbStorageState::new();
        assert!(s.read_keypair(SESSION_COUNT as u8).is_err());
        assert!(s.read_keypair(u8::MAX).is_err());
    }

    /// Regression: same expectation on the write side.
    #[test]
    fn write_keypair_invalid_session_returns_error() {
        let mut s = IdbStorageState::new();
        assert!(s.write_keypair(SESSION_COUNT as u8, b"kp").is_err());
        assert!(s.write_keypair(u8::MAX, b"kp").is_err());
    }
}
