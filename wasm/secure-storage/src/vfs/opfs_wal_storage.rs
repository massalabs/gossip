//! OPFS + WAL block & keypair storage.
//!
//! Writes are buffered in an in-memory WAL. On `fsync` the WAL is flushed
//! to a dedicated OPFS file, then applied to the main data file, then the
//! WAL file is truncated. This provides crash-safe persistence: on open we
//! replay any valid WAL entries found on disk.
//!
//! Reads check the WAL first (dirty-block overlay), then fall back to OPFS.

use std::cell::RefCell;

use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::constants::{BLOCK_SIZE, SESSION_COUNT};
use crate::error::{SecureStorageError, Result};
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;
use crate::wal::Wal;

// ── Inline JS helpers (same API as opfs_storage.rs) ──────────────────

#[wasm_bindgen(inline_js = "
export async function walOpfsOpenDir(name) {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(name, { create: true });
}

export async function walOpfsOpenSync(dir, fileName) {
    const file = await dir.getFileHandle(fileName, { create: true });
    return file.createSyncAccessHandle();
}

export function walOpfsRead(handle, offset, length) {
    const buf = new Uint8Array(length);
    handle.read(buf, { at: offset });
    return buf;
}

export function walOpfsWrite(handle, offset, data) {
    handle.write(data, { at: offset });
}

export function walOpfsFlush(handle) {
    handle.flush();
}

export function walOpfsGetSize(handle) {
    return handle.getSize();
}

export function walOpfsTruncate(handle, size) {
    handle.truncate(size);
}

export function walOpfsClose(handle) {
    handle.close();
}
")]
extern "C" {
    #[wasm_bindgen(catch)]
    async fn walOpfsOpenDir(name: &str) -> std::result::Result<JsValue, JsValue>;

    #[wasm_bindgen(catch)]
    async fn walOpfsOpenSync(
        dir: &JsValue,
        file_name: &str,
    ) -> std::result::Result<JsValue, JsValue>;

    fn walOpfsRead(handle: &JsValue, offset: f64, length: f64) -> JsValue;
    fn walOpfsWrite(handle: &JsValue, offset: f64, data: &JsValue);
    fn walOpfsFlush(handle: &JsValue);
    fn walOpfsGetSize(handle: &JsValue) -> f64;
    fn walOpfsTruncate(handle: &JsValue, size: f64);
    fn walOpfsClose(handle: &JsValue);
}

// ── Storage implementation ───────────────────────────────────────────

/// OPFS backend with WAL-based crash safety.
///
/// Each session has:
/// - A blocks file (`session_N.blocks`) — the main data file.
/// - A WAL file (`session_N.wal`) — serialized WAL entries flushed on commit.
/// - A keypair file (`session_N.keypair`) — written once, no WAL needed.
pub struct OpfsWalStorage {
    block_handles: Vec<JsValue>,
    wal_handles: Vec<JsValue>,
    keypair_handles: Vec<JsValue>,
    /// Per-session in-memory WAL buffers.
    /// `RefCell` because `fsync` (from `BlockStorage`) takes `&self`.
    wals: RefCell<Vec<Wal>>,
    /// Per-session block counts (tracked in memory to avoid OPFS size queries).
    block_counts: RefCell<Vec<u64>>,
}

impl OpfsWalStorage {
    /// Open OPFS directory, acquire handles, and run crash recovery.
    pub async fn open(dir_name: &str) -> std::result::Result<Self, JsValue> {
        let dir = walOpfsOpenDir(dir_name).await?;
        let mut block_handles = Vec::with_capacity(SESSION_COUNT);
        let mut wal_handles = Vec::with_capacity(SESSION_COUNT);
        let mut keypair_handles = Vec::with_capacity(SESSION_COUNT);

        for i in 0..SESSION_COUNT {
            block_handles.push(walOpfsOpenSync(&dir, &format!("session_{i}.blocks")).await?);
            wal_handles.push(walOpfsOpenSync(&dir, &format!("session_{i}.wal")).await?);
            keypair_handles.push(walOpfsOpenSync(&dir, &format!("session_{i}.keypair")).await?);
        }

        let storage = Self {
            block_handles,
            wal_handles,
            keypair_handles,
            wals: RefCell::new((0..SESSION_COUNT).map(|_| Wal::new()).collect()),
            block_counts: RefCell::new(vec![0; SESSION_COUNT]),
        };

        // Crash recovery + rebuild block counts for each session.
        for i in 0..SESSION_COUNT {
            storage.recover(i)?;
            storage.block_counts.borrow_mut()[i] = storage.read_block_count_from_opfs(i);
        }

        Ok(storage)
    }

    /// Close all sync access handles.
    pub fn close(&self) {
        for h in &self.block_handles {
            walOpfsClose(h);
        }
        for h in &self.wal_handles {
            walOpfsClose(h);
        }
        for h in &self.keypair_handles {
            walOpfsClose(h);
        }
    }

    /// Read the block count from the OPFS file size.
    fn read_block_count_from_opfs(&self, session_idx: usize) -> u64 {
        let size = walOpfsGetSize(&self.block_handles[session_idx]) as u64;
        size / BLOCK_SIZE as u64
    }

    /// Crash recovery for one session: replay valid WAL entries, then truncate WAL.
    fn recover(&self, session_idx: usize) -> std::result::Result<(), JsValue> {
        let wal_handle = &self.wal_handles[session_idx];
        let db_handle = &self.block_handles[session_idx];
        let wal_size = walOpfsGetSize(wal_handle) as usize;
        let db_size = walOpfsGetSize(db_handle) as u64;

        web_sys::console::log_1(
            &format!(
                "[WAL recovery] session {session_idx}: wal_size={wal_size}, db_size={db_size}"
            )
            .into(),
        );

        if wal_size == 0 {
            return Ok(());
        }

        // Read entire WAL file.
        let wal_data_js = walOpfsRead(wal_handle, 0.0, wal_size as f64);
        let wal_data_arr = js_sys::Uint8Array::new(&wal_data_js);
        let wal_data = wal_data_arr.to_vec();

        // Parse valid entries.
        let entries = Wal::parse_wal_bytes(&wal_data);

        web_sys::console::log_1(
            &format!(
                "[WAL recovery] session {session_idx}: parsed {}/{wal_size} bytes → {} valid entries",
                entries.iter().map(|e| 24 + e.payload.len()).sum::<usize>(),
                entries.len(),
            )
            .into(),
        );

        // Apply to DB file — block 0 last (same ordering as flush_session).
        let mut block0_entry = None;
        for entry in &entries {
            if entry.file_offset == 0 {
                block0_entry = Some(entry);
                continue;
            }
            let arr = js_sys::Uint8Array::new_with_length(entry.length);
            arr.copy_from(&entry.payload);
            walOpfsWrite(db_handle, entry.file_offset as f64, &arr);
        }
        if !entries.is_empty() {
            if let Some(entry) = block0_entry {
                walOpfsFlush(db_handle);
                let arr = js_sys::Uint8Array::new_with_length(entry.length);
                arr.copy_from(&entry.payload);
                walOpfsWrite(db_handle, 0.0, &arr);
            }
            walOpfsFlush(db_handle);
            let new_db_size = walOpfsGetSize(db_handle) as u64;
            web_sys::console::log_1(
                &format!(
                    "[WAL recovery] session {session_idx}: applied {} entries, db_size {db_size} → {new_db_size}",
                    entries.len(),
                )
                .into(),
            );
        }

        // Truncate WAL.
        walOpfsTruncate(wal_handle, 0.0);
        walOpfsFlush(wal_handle);

        Ok(())
    }

    /// Three-phase flush for one session.
    fn flush_session(&self, session_idx: usize) -> Result<()> {
        let wals = self.wals.borrow();
        if wals[session_idx].is_empty() {
            return Ok(());
        }

        let n_entries = wals[session_idx].entries().len();
        let wal_handle = &self.wal_handles[session_idx];
        let db_handle = &self.block_handles[session_idx];

        // Phase 1: Write WAL to OPFS.
        let wal_bytes = wals[session_idx].to_bytes();
        let arr = js_sys::Uint8Array::new_with_length(wal_bytes.len() as u32);
        arr.copy_from(&wal_bytes);
        walOpfsTruncate(wal_handle, 0.0);
        walOpfsWrite(wal_handle, 0.0, &arr);
        walOpfsFlush(wal_handle);

        // Phase 2: Apply entries to DB file.
        // Write block 0 LAST — it contains total_data_length and is required
        // for unlock. If we crash mid-apply, the old block 0 remains valid
        // and the session can still be unlocked (we just lose this transaction).
        let entries = wals[session_idx].entries();
        let mut block0_entry = None;
        for entry in entries {
            if entry.file_offset == 0 {
                block0_entry = Some(entry);
                continue;
            }
            let arr = js_sys::Uint8Array::new_with_length(entry.length);
            arr.copy_from(&entry.payload);
            walOpfsWrite(db_handle, entry.file_offset as f64, &arr);
        }
        // Flush non-block-0 writes first, then write block 0.
        if let Some(entry) = block0_entry {
            walOpfsFlush(db_handle);
            let arr = js_sys::Uint8Array::new_with_length(entry.length);
            arr.copy_from(&entry.payload);
            walOpfsWrite(db_handle, 0.0, &arr);
        }
        walOpfsFlush(db_handle);

        // Drop borrow before mutating.
        drop(wals);

        // Phase 3: Truncate WAL + clear in-memory state.
        walOpfsTruncate(wal_handle, 0.0);
        walOpfsFlush(wal_handle);
        self.wals.borrow_mut()[session_idx].clear();

        web_sys::console::log_1(
            &format!(
                "[WAL flush] session {session_idx}: {n_entries} entries, {} bytes",
                n_entries * BLOCK_SIZE,
            )
            .into(),
        );

        Ok(())
    }

    /// Compute the file offset for a block in a given session.
    fn block_offset(block: u64) -> Result<u64> {
        block
            .checked_mul(BLOCK_SIZE as u64)
            .ok_or(SecureStorageError::Overflow)
    }
}

impl BlockStorage for OpfsWalStorage {
    fn read_block(&self, session: SessionIndex, block: u64) -> Result<Box<[u8; BLOCK_SIZE]>> {
        let si = session.as_usize();
        let offset = Self::block_offset(block)?;

        // Check WAL first (last-write-wins).
        let wals = self.wals.borrow();
        for entry in wals[si].entries().iter().rev() {
            if entry.file_offset == offset && entry.payload.len() == BLOCK_SIZE {
                let mut buf = Box::new([0u8; BLOCK_SIZE]);
                buf.copy_from_slice(&entry.payload);
                return Ok(buf);
            }
        }
        drop(wals);

        // Fall back to OPFS.
        let handle = &self.block_handles[si];
        let file_size = walOpfsGetSize(handle) as u64;
        if offset + BLOCK_SIZE as u64 > file_size {
            return Err(SecureStorageError::OutOfBounds);
        }
        let data = walOpfsRead(handle, offset as f64, BLOCK_SIZE as f64);
        let arr = js_sys::Uint8Array::new(&data);
        let mut buf = Box::new([0u8; BLOCK_SIZE]);
        arr.copy_to(buf.as_mut());
        Ok(buf)
    }

    fn write_block(
        &mut self,
        session: SessionIndex,
        block: u64,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()> {
        let si = session.as_usize();
        if block >= self.block_counts.borrow()[si] {
            return Err(SecureStorageError::OutOfBounds);
        }
        let offset = Self::block_offset(block)?;
        self.wals.borrow_mut()[si].record_write(offset, data);
        Ok(())
    }

    fn append_block(&mut self, session: SessionIndex, data: &[u8; BLOCK_SIZE]) -> Result<()> {
        let si = session.as_usize();
        let block = self.block_counts.borrow()[si];
        let offset = Self::block_offset(block)?;
        self.wals.borrow_mut()[si].record_write(offset, data);
        self.block_counts.borrow_mut()[si] += 1;
        Ok(())
    }

    fn block_count(&self, session: SessionIndex) -> Result<u64> {
        Ok(self.block_counts.borrow()[session.as_usize()])
    }

    fn fsync(&self, session: SessionIndex) -> Result<()> {
        self.flush_session(session.as_usize())
    }

    fn init_blockstream(&mut self, session: SessionIndex) -> Result<()> {
        let si = session.as_usize();
        walOpfsTruncate(&self.block_handles[si], 0.0);
        walOpfsTruncate(&self.wal_handles[si], 0.0);
        self.wals.borrow_mut()[si].clear();
        self.block_counts.borrow_mut()[si] = 0;
        Ok(())
    }
}

impl KeypairStorage for OpfsWalStorage {
    fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>> {
        let handle = &self.keypair_handles[session.as_usize()];
        let size = walOpfsGetSize(handle) as usize;
        if size == 0 {
            return Err(SecureStorageError::Storage("keypair not found".into()));
        }
        let data = walOpfsRead(handle, 0.0, size as f64);
        let arr = js_sys::Uint8Array::new(&data);
        Ok(Zeroizing::new(arr.to_vec()))
    }

    fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> Result<()> {
        let handle = &self.keypair_handles[session.as_usize()];
        walOpfsTruncate(handle, 0.0);
        let arr = js_sys::Uint8Array::new_with_length(data.len() as u32);
        arr.copy_from(data);
        walOpfsWrite(handle, 0.0, &arr);
        walOpfsFlush(handle);
        Ok(())
    }
}
