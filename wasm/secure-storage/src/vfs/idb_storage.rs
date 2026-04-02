//! IndexedDB-backed block storage for secure-storage (WASM).
//!
//! In-memory HashMap for sync VFS reads/writes, async IDB persistence
//! via flush timer. Same key-value model as redb on native.
//!
//! IDB schema: database "secureStorage", object store "blocks"
//!   Key: "s:{session}:b:{block}" → Uint8Array[BLOCK_SIZE]
//!   Key: "s:{session}:kp"       → Uint8Array (keypair)

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::constants::{BLOCK_SIZE, SESSION_COUNT};
use crate::error::{Result, SecureStorageError};
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;

// ── Inline JS helpers ───────────────────────────────────────────────

#[wasm_bindgen(inline_js = "
let _db = null;

export async function idbOpen() {
    if (_db) return _db;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('secureStorage', 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore('blocks');
        };
        req.onsuccess = () => { _db = req.result; resolve(_db); };
        req.onerror = () => reject(req.error);
    });
}

export async function idbGetAll() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('blocks', 'readonly');
        const store = tx.objectStore('blocks');
        const keys = store.getAllKeys();
        const vals = store.getAll();
        tx.oncomplete = () => resolve({ keys: keys.result, vals: vals.result });
        tx.onerror = () => reject(tx.error);
    });
}

export async function idbPutBatch(entries) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('blocks', 'readwrite');
        const store = tx.objectStore('blocks');
        for (const [key, value] of entries) {
            store.put(value, key);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function idbDeleteAll() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('blocks', 'readwrite');
        const store = tx.objectStore('blocks');
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function idbHasAnyData() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('blocks', 'readonly');
        const store = tx.objectStore('blocks');
        const req = store.count();
        req.onsuccess = () => resolve(req.result > 0);
        req.onerror = () => reject(req.error);
    });
}
")]
extern "C" {
    #[wasm_bindgen(catch)]
    async fn idbOpen() -> std::result::Result<JsValue, JsValue>;

    #[wasm_bindgen(catch)]
    async fn idbGetAll() -> std::result::Result<JsValue, JsValue>;

    #[wasm_bindgen(catch)]
    async fn idbPutBatch(entries: JsValue) -> std::result::Result<(), JsValue>;

    #[wasm_bindgen(catch)]
    async fn idbDeleteAll() -> std::result::Result<(), JsValue>;

    #[wasm_bindgen(catch)]
    async fn idbHasAnyData() -> std::result::Result<JsValue, JsValue>;
}

// ── Storage implementation ──────────────────────────────────────────

/// IndexedDB-backed storage with in-memory cache.
///
/// All reads/writes go to the in-memory HashMap synchronously.
/// Dirty blocks are persisted to IDB asynchronously via `persist_dirty()`.
pub struct IdbBlockStorage {
    blocks: RefCell<HashMap<(u8, u64), Box<[u8; BLOCK_SIZE]>>>,
    keypairs: RefCell<HashMap<u8, Zeroizing<Vec<u8>>>>,
    block_counts: RefCell<[u64; SESSION_COUNT]>,
    dirty_blocks: RefCell<HashSet<(u8, u64)>>,
    dirty_keypairs: RefCell<HashSet<u8>>,
}

impl IdbBlockStorage {
    /// Open IDB and load all data into memory.
    pub async fn open() -> std::result::Result<Self, JsValue> {
        idbOpen().await?;

        let mut blocks = HashMap::new();
        let mut keypairs = HashMap::new();
        let mut block_counts = [0u64; SESSION_COUNT];

        // Load all entries from IDB into memory.
        let result = idbGetAll().await?;
        let keys = js_sys::Reflect::get(&result, &"keys".into())?;
        let vals = js_sys::Reflect::get(&result, &"vals".into())?;
        let keys_arr = js_sys::Array::from(&keys);
        let vals_arr = js_sys::Array::from(&vals);

        for i in 0..keys_arr.length() {
            let key: String = keys_arr.get(i).as_string().unwrap_or_default();
            let val = vals_arr.get(i);

            if let Some(rest) = key.strip_prefix("s:") {
                let parts: Vec<&str> = rest.splitn(2, ':').collect();
                if parts.len() < 2 {
                    continue;
                }
                let session: u8 = match parts[0].parse() {
                    Ok(s) if s < SESSION_COUNT as u8 => s,
                    _ => continue,
                };

                if let Some(block_str) = parts[1].strip_prefix("b:") {
                    // Block entry
                    if let Ok(block_idx) = block_str.parse::<u64>() {
                        let arr = Uint8Array::new(&val);
                        if arr.length() as usize == BLOCK_SIZE {
                            let mut data = Box::new([0u8; BLOCK_SIZE]);
                            arr.copy_to(&mut data[..]);
                            blocks.insert((session, block_idx), data);
                            let count = &mut block_counts[session as usize];
                            if block_idx + 1 > *count {
                                *count = block_idx + 1;
                            }
                        }
                    }
                } else if parts[1] == "kp" {
                    // Keypair entry
                    let arr = Uint8Array::new(&val);
                    let mut data = vec![0u8; arr.length() as usize];
                    arr.copy_to(&mut data);
                    keypairs.insert(session, Zeroizing::new(data));
                }
            }
        }

        Ok(Self {
            blocks: RefCell::new(blocks),
            keypairs: RefCell::new(keypairs),
            block_counts: RefCell::new(block_counts),
            dirty_blocks: RefCell::new(HashSet::new()),
            dirty_keypairs: RefCell::new(HashSet::new()),
        })
    }

    /// Check if IDB has any data (for needsUnlock detection).
    pub async fn has_data() -> std::result::Result<bool, JsValue> {
        idbOpen().await?;
        let result = idbHasAnyData().await?;
        Ok(result.as_bool().unwrap_or(false))
    }

    /// Persist dirty blocks/keypairs to IDB. Called from flush timer.
    pub async fn persist_dirty(&self) -> std::result::Result<(), JsValue> {
        let entries = {
            let blocks = self.blocks.borrow();
            let keypairs = self.keypairs.borrow();
            let mut dirty_b = self.dirty_blocks.borrow_mut();
            let mut dirty_k = self.dirty_keypairs.borrow_mut();

            if dirty_b.is_empty() && dirty_k.is_empty() {
                return Ok(());
            }

            let arr = js_sys::Array::new();

            for &(session, block_idx) in dirty_b.iter() {
                if let Some(data) = blocks.get(&(session, block_idx)) {
                    let key = format!("s:{session}:b:{block_idx}");
                    let val = Uint8Array::from(&data[..]);
                    let entry = js_sys::Array::of2(&key.into(), &val.into());
                    arr.push(&entry);
                }
            }

            for &session in dirty_k.iter() {
                if let Some(data) = keypairs.get(&session) {
                    let key = format!("s:{session}:kp");
                    let val = Uint8Array::from(data.as_slice());
                    let entry = js_sys::Array::of2(&key.into(), &val.into());
                    arr.push(&entry);
                }
            }

            dirty_b.clear();
            dirty_k.clear();
            arr.into()
        };

        idbPutBatch(entries).await
    }

    /// No-op commit (writes already in memory). Used for API compatibility.
    pub fn commit(&self, _session: SessionIndex) -> Result<()> {
        Ok(())
    }

    /// No-op commit_all.
    pub fn commit_all(&self) -> Result<()> {
        Ok(())
    }
}

// ── BlockStorage ────────────────────────────────────────────────────

impl BlockStorage for IdbBlockStorage {
    fn read_block(&self, session: SessionIndex, block: u64) -> Result<Box<[u8; BLOCK_SIZE]>> {
        let si = session.as_usize() as u8;
        let blocks = self.blocks.borrow();
        match blocks.get(&(si, block)) {
            Some(data) => Ok(data.clone()),
            None => Err(SecureStorageError::Storage(format!(
                "block not found: session={si}, block={block}"
            ))),
        }
    }

    fn write_block(
        &mut self,
        session: SessionIndex,
        block: u64,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()> {
        let si = session.as_usize() as u8;
        self.blocks
            .borrow_mut()
            .insert((si, block), Box::new(*data));
        self.dirty_blocks.borrow_mut().insert((si, block));
        Ok(())
    }

    fn append_block(&mut self, session: SessionIndex, data: &[u8; BLOCK_SIZE]) -> Result<()> {
        let si = session.as_usize() as u8;
        let block_idx = self.block_counts.borrow()[si as usize];
        self.blocks
            .borrow_mut()
            .insert((si, block_idx), Box::new(*data));
        self.dirty_blocks.borrow_mut().insert((si, block_idx));
        self.block_counts.borrow_mut()[si as usize] = block_idx + 1;
        Ok(())
    }

    fn block_count(&self, session: SessionIndex) -> Result<u64> {
        Ok(self.block_counts.borrow()[session.as_usize()])
    }

    fn fsync(&self, _session: SessionIndex) -> Result<()> {
        Ok(())
    }

    fn init_blockstream(&mut self, session: SessionIndex) -> Result<()> {
        let si = session.as_usize() as u8;
        let count = self.block_counts.borrow()[si as usize];
        let mut blocks = self.blocks.borrow_mut();
        for b in 0..count {
            blocks.remove(&(si, b));
        }
        self.block_counts.borrow_mut()[si as usize] = 0;
        Ok(())
    }
}

// ── KeypairStorage ──────────────────────────────────────────────────

impl KeypairStorage for IdbBlockStorage {
    fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>> {
        let si = session.as_usize() as u8;
        let keypairs = self.keypairs.borrow();
        match keypairs.get(&si) {
            Some(data) => Ok(data.clone()),
            None => Err(SecureStorageError::Storage(format!(
                "keypair not found: session={si}"
            ))),
        }
    }

    fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> Result<()> {
        let si = session.as_usize() as u8;
        self.keypairs
            .borrow_mut()
            .insert(si, Zeroizing::new(data.to_vec()));
        self.dirty_keypairs.borrow_mut().insert(si);
        Ok(())
    }
}
