//! OPFS-backed block & keypair storage via `SyncAccessHandle`.
//!
//! Reads and writes are **synchronous** (SyncAccessHandle API, Worker only).
//! Setup (`open`) is async (getting directory/file handles).

use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::constants::{BLOCK_SIZE, SESSION_COUNT};
use crate::error::{BordercryptError, Result};
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;

// ── Inline JS helpers ────────────────────────────────────────────────

#[wasm_bindgen(inline_js = "
export async function opfsOpenDir(name) {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(name, { create: true });
}

export async function opfsOpenSync(dir, fileName) {
    const file = await dir.getFileHandle(fileName, { create: true });
    return file.createSyncAccessHandle();
}

export function opfsRead(handle, offset, length) {
    const buf = new Uint8Array(length);
    handle.read(buf, { at: offset });
    return buf;
}

export function opfsWrite(handle, offset, data) {
    handle.write(data, { at: offset });
}

export function opfsFlush(handle) {
    handle.flush();
}

export function opfsGetSize(handle) {
    return handle.getSize();
}

export function opfsTruncate(handle, size) {
    handle.truncate(size);
}

export function opfsClose(handle) {
    handle.close();
}
")]
extern "C" {
    #[wasm_bindgen(catch)]
    async fn opfsOpenDir(name: &str) -> std::result::Result<JsValue, JsValue>;

    #[wasm_bindgen(catch)]
    async fn opfsOpenSync(dir: &JsValue, file_name: &str) -> std::result::Result<JsValue, JsValue>;

    fn opfsRead(handle: &JsValue, offset: f64, length: f64) -> JsValue;
    fn opfsWrite(handle: &JsValue, offset: f64, data: &JsValue);
    fn opfsFlush(handle: &JsValue);
    fn opfsGetSize(handle: &JsValue) -> f64;
    fn opfsTruncate(handle: &JsValue, size: f64);
    fn opfsClose(handle: &JsValue);
}

// ── Storage implementation ───────────────────────────────────────────

pub struct OpfsBlockStorage {
    block_handles: Vec<JsValue>,
    keypair_handles: Vec<JsValue>,
}

impl OpfsBlockStorage {
    /// Open OPFS directory and acquire sync access handles for all sessions.
    pub async fn open(dir_name: &str) -> std::result::Result<Self, JsValue> {
        let dir = opfsOpenDir(dir_name).await?;
        let mut block_handles = Vec::with_capacity(SESSION_COUNT);
        let mut keypair_handles = Vec::with_capacity(SESSION_COUNT);
        for i in 0..SESSION_COUNT {
            block_handles.push(opfsOpenSync(&dir, &format!("session_{i}.blocks")).await?);
            keypair_handles
                .push(opfsOpenSync(&dir, &format!("session_{i}.keypair")).await?);
        }
        Ok(Self {
            block_handles,
            keypair_handles,
        })
    }

}

impl BlockStorage for OpfsBlockStorage {
    fn read_block(&self, session: SessionIndex, block: u64) -> Result<Box<[u8; BLOCK_SIZE]>> {
        let handle = &self.block_handles[session.as_usize()];
        let offset = block
            .checked_mul(BLOCK_SIZE as u64)
            .ok_or(BordercryptError::Overflow)?;
        let file_size = opfsGetSize(handle) as u64;
        if offset + BLOCK_SIZE as u64 > file_size {
            return Err(BordercryptError::OutOfBounds);
        }
        let data = opfsRead(handle, offset as f64, BLOCK_SIZE as f64);
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
        let handle = &self.block_handles[session.as_usize()];
        let offset = block
            .checked_mul(BLOCK_SIZE as u64)
            .ok_or(BordercryptError::Overflow)?;
        let arr = js_sys::Uint8Array::new_with_length(BLOCK_SIZE as u32);
        arr.copy_from(data);
        opfsWrite(handle, offset as f64, &arr);
        Ok(())
    }

    fn append_block(&mut self, session: SessionIndex, data: &[u8; BLOCK_SIZE]) -> Result<()> {
        let handle = &self.block_handles[session.as_usize()];
        let size = opfsGetSize(handle);
        let arr = js_sys::Uint8Array::new_with_length(BLOCK_SIZE as u32);
        arr.copy_from(data);
        opfsWrite(handle, size, &arr);
        Ok(())
    }

    fn block_count(&self, session: SessionIndex) -> Result<u64> {
        let handle = &self.block_handles[session.as_usize()];
        let size = opfsGetSize(handle) as u64;
        if size % BLOCK_SIZE as u64 != 0 {
            return Err(BordercryptError::CorruptedBlock);
        }
        Ok(size / BLOCK_SIZE as u64)
    }

    fn fsync(&self, session: SessionIndex) -> Result<()> {
        opfsFlush(&self.block_handles[session.as_usize()]);
        Ok(())
    }

    fn init_blockstream(&mut self, session: SessionIndex) -> Result<()> {
        opfsTruncate(&self.block_handles[session.as_usize()], 0.0);
        Ok(())
    }
}

impl KeypairStorage for OpfsBlockStorage {
    fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>> {
        let handle = &self.keypair_handles[session.as_usize()];
        let size = opfsGetSize(handle) as usize;
        if size == 0 {
            return Err(BordercryptError::Storage("keypair not found".into()));
        }
        let data = opfsRead(handle, 0.0, size as f64);
        let arr = js_sys::Uint8Array::new(&data);
        Ok(Zeroizing::new(arr.to_vec()))
    }

    fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> Result<()> {
        let handle = &self.keypair_handles[session.as_usize()];
        opfsTruncate(handle, 0.0);
        let arr = js_sys::Uint8Array::new_with_length(data.len() as u32);
        arr.copy_from(data);
        opfsWrite(handle, 0.0, &arr);
        opfsFlush(handle);
        Ok(())
    }
}
