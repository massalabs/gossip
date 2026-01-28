//! WASM bindings for browser environment
//!
//! This module provides:
//! - FileSystem implementation using JavaScript storage imports
//! - Session management API exposed to JavaScript
//! - VFS read/write operations for SQLite integration

use std::cell::RefCell;
use crate::fs::FileSystem;
use crate::session::{SessionManager, SessionState};
use wasm_bindgen::prelude::*;

// ============================================================
// STORAGE FILE SYSTEM (JS Imports)
// ============================================================

// Import JavaScript functions for file operations
// These are provided by the Storage class before WASM initialization
#[wasm_bindgen]
extern "C" {
    /// Read bytes from a file at the given offset
    /// Returns a Uint8Array with the data
    #[wasm_bindgen(js_name = "storageRead")]
    fn js_read(file_id: u32, offset: u64, len: u32) -> Vec<u8>;

    /// Write bytes to a file at the given offset
    #[wasm_bindgen(js_name = "storageWrite")]
    fn js_write(file_id: u32, offset: u64, data: &[u8]);

    /// Get the current size of a file
    #[wasm_bindgen(js_name = "storageGetSize")]
    fn js_get_size(file_id: u32) -> u64;

    /// Flush pending writes to disk
    #[wasm_bindgen(js_name = "storageFlush")]
    fn js_flush(file_id: u32);

    /// Log to console (for debugging)
    #[wasm_bindgen(js_namespace = console, js_name = "log")]
    fn js_log(s: &str);
}

/// Public log function for debugging from other modules
pub fn log(s: &str) {
    js_log(s);
}

/// Storage-backed filesystem using JS imports
#[derive(Clone, Copy)]
pub struct JsFileSystem;

impl JsFileSystem {
    pub fn new() -> Self {
        Self
    }
}

impl Default for JsFileSystem {
    fn default() -> Self {
        Self::new()
    }
}

impl FileSystem for JsFileSystem {
    fn read_bytes(&self, file_id: u32, offset: u64, len: u32) -> Vec<u8> {
        js_read(file_id, offset, len)
    }

    fn write_bytes(&mut self, file_id: u32, offset: u64, data: &[u8]) {
        js_write(file_id, offset, data);
    }

    fn get_size(&self, file_id: u32) -> u64 {
        js_get_size(file_id)
    }

    fn flush(&mut self, file_id: u32) {
        js_flush(file_id);
    }
}

// ============================================================
// GLOBAL SESSION MANAGER
// ============================================================

thread_local! {
    static SESSION_MANAGER: RefCell<Option<SessionManager<JsFileSystem>>> = RefCell::new(None);
}

/// Initialize the session manager (must be called first)
fn ensure_manager() {
    SESSION_MANAGER.with(|cell| {
        if cell.borrow().is_none() {
            let fs = JsFileSystem::new();
            *cell.borrow_mut() = Some(SessionManager::new(fs));
        }
    });
}

// ============================================================
// WASM EXPORTS - SESSION API
// ============================================================

/// Initialize panic hook for better error messages
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "wasm")]
    console_error_panic_hook::set_once();
}

/// Initialize storage with random data (2MB addressing blob)
/// Must be called before any session operations
#[wasm_bindgen(js_name = "initStorage")]
pub fn init_storage() {
    ensure_manager();
    SESSION_MANAGER.with(|cell| {
        if let Some(ref mut manager) = *cell.borrow_mut() {
            manager.init_storage();
            log("[WASM] Storage initialized");
        }
    });
}

/// Create a new session with the given password
/// Returns true on success, false on failure
#[wasm_bindgen(js_name = "createSession")]
pub fn create_session(password: &str) -> bool {
    ensure_manager();
    SESSION_MANAGER.with(|cell| {
        if let Some(ref mut manager) = *cell.borrow_mut() {
            match manager.create_session(password) {
                Ok(()) => {
                    log("[WASM] Session created");
                    true
                }
                Err(e) => {
                    log(&format!("[WASM] Failed to create session: {}", e));
                    false
                }
            }
        } else {
            false
        }
    })
}

/// Unlock an existing session with the given password
/// Returns true on success, false on failure (wrong password)
#[wasm_bindgen(js_name = "unlockSession")]
pub fn unlock_session(password: &str) -> bool {
    ensure_manager();
    SESSION_MANAGER.with(|cell| {
        if let Some(ref mut manager) = *cell.borrow_mut() {
            match manager.unlock_session(password) {
                Ok(()) => {
                    // Debug: log root block info and allocation table
                    if let Some(session) = manager.session() {
                        log(&format!(
                            "[WASM] Session unlocked: root_address={}, root_length={}, logical_size={}",
                            session.root_address(),
                            session.root_length(),
                            session.logical_size()
                        ));
                        // Log allocation table details
                        log(&session.debug_allocation_info());
                    } else {
                        log("[WASM] Session unlocked");
                    }
                    true
                }
                Err(e) => {
                    log(&format!("[WASM] Failed to unlock session: {}", e));
                    false
                }
            }
        } else {
            false
        }
    })
}

/// Lock the current session (zeroizes keys)
#[wasm_bindgen(js_name = "lockSession")]
pub fn lock_session() {
    SESSION_MANAGER.with(|cell| {
        if let Some(ref mut manager) = *cell.borrow_mut() {
            // Debug: log root block info before lock
            if let Some(session) = manager.session() {
                log(&format!(
                    "[WASM] Locking session: root_address={}, root_length={}, logical_size={}",
                    session.root_address(),
                    session.root_length(),
                    session.logical_size()
                ));
            }
            manager.lock();
            log("[WASM] Session locked");
        }
    });
}

/// Check if a session is currently unlocked
#[wasm_bindgen(js_name = "isSessionUnlocked")]
pub fn is_session_unlocked() -> bool {
    SESSION_MANAGER.with(|cell| {
        if let Some(ref manager) = *cell.borrow() {
            manager.state() == SessionState::Unlocked
        } else {
            false
        }
    })
}

/// Get the root block address (for debugging)
#[wasm_bindgen(js_name = "getRootAddress")]
pub fn get_root_address() -> u64 {
    SESSION_MANAGER.with(|cell| {
        if let Some(ref manager) = *cell.borrow() {
            manager.session().map(|s| s.root_address()).unwrap_or(0)
        } else {
            0
        }
    })
}

/// Get the root block length (for debugging)
#[wasm_bindgen(js_name = "getRootLength")]
pub fn get_root_length() -> u32 {
    SESSION_MANAGER.with(|cell| {
        if let Some(ref manager) = *cell.borrow() {
            manager.session().map(|s| s.root_length()).unwrap_or(0)
        } else {
            0
        }
    })
}

// ============================================================
// WASM EXPORTS - VFS DATA OPERATIONS
// ============================================================

/// Read bytes from the data blob at the given offset
/// Used by Custom VFS for SQLite page reads
/// Returns empty array if session is locked
#[wasm_bindgen(js_name = "readData")]
pub fn read_data(offset: u64, len: u32) -> Vec<u8> {
    SESSION_MANAGER.with(|cell| {
        if let Some(ref mut manager) = *cell.borrow_mut() {
            manager.read_data(offset, len).unwrap_or_default()
        } else {
            vec![]
        }
    })
}

/// Write bytes to the data blob at the given offset
/// Used by Custom VFS for SQLite page writes
/// Returns true on success, false if session is locked
#[wasm_bindgen(js_name = "writeData")]
pub fn write_data(offset: u64, data: &[u8]) -> bool {
    SESSION_MANAGER.with(|cell| {
        if let Some(ref mut manager) = *cell.borrow_mut() {
            manager.write_data(offset, data).is_ok()
        } else {
            false
        }
    })
}

/// Flush data blob to disk
#[wasm_bindgen(js_name = "flushData")]
pub fn flush_data() -> bool {
    SESSION_MANAGER.with(|cell| {
        if let Some(ref mut manager) = *cell.borrow_mut() {
            manager.flush_data().is_ok()
        } else {
            false
        }
    })
}

/// Get the current size of the data blob
#[wasm_bindgen(js_name = "getDataSize")]
pub fn get_data_size() -> u64 {
    SESSION_MANAGER.with(|cell| {
        if let Some(ref manager) = *cell.borrow() {
            manager.data_size().unwrap_or(0)
        } else {
            0
        }
    })
}

/// Get WASM module version (for verification)
#[wasm_bindgen(js_name = "getWasmVersion")]
pub fn get_wasm_version() -> String {
    "gossip-storage-v1.0.6".to_string()
}
