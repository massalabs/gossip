//! UniFFI exports for the secure-storage native plugin.
//!
//! Mirrors the WASM API but uses filesystem-backed storage and
//! thread-safe global state instead of wasm-bindgen.

use std::sync::{Mutex, OnceLock};

use zeroize::Zeroize;

use crate::error::SecureStorageError;
use crate::lifecycle::{allocate_session, cover_traffic_tick, provision_storage};
use crate::read::read_session_data;
use crate::storage::FsStorage;
use crate::types::SessionIndex;
use crate::unlock::{self, UnlockedSession};
use crate::write::write_session_data;

// ── Global state ────────────────────────────────────────────────────

struct NativeState {
    domain: String,
    storage: FsStorage,
    session: Option<UnlockedSession>,
}

static STATE: OnceLock<Mutex<Option<NativeState>>> = OnceLock::new();

fn with_state<F, R>(f: F) -> Result<R, SecureStorageError>
where
    F: FnOnce(&mut NativeState) -> Result<R, SecureStorageError>,
{
    let mutex = STATE.get().ok_or_else(|| {
        SecureStorageError::Storage("not initialised — call init_secure_storage first".into())
    })?;
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let state = guard.as_mut().ok_or_else(|| {
        SecureStorageError::Storage("not initialised — call init_secure_storage first".into())
    })?;
    f(state)
}

// ── Exported functions ──────────────────────────────────────────────

/// Initialise secure-storage with a filesystem path and domain string.
#[uniffi::export]
pub fn init_secure_storage(path: String, domain: String) -> Result<(), SecureStorageError> {
    let storage = FsStorage::new(std::path::Path::new(&path))?;
    let state = NativeState {
        domain,
        storage,
        session: None,
    };
    let mutex = STATE.get_or_init(|| Mutex::new(None));
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    *guard = Some(state);
    Ok(())
}

/// Provision all 5 session slots with dummy keypairs.
#[uniffi::export]
pub fn provision_storage_native() -> Result<(), SecureStorageError> {
    with_state(|s| provision_storage(&mut s.storage))
}

/// Allocate a session in `slot` with the given `password`.
#[uniffi::export]
pub fn allocate_session_native(slot: u8, mut password: Vec<u8>) -> Result<(), SecureStorageError> {
    let result = with_state(|s| {
        let idx = SessionIndex::new(slot)?;
        let session = allocate_session(&mut s.storage, &s.domain, idx, &password)?;
        s.session = Some(session);
        Ok(())
    });
    password.zeroize();
    result
}

/// Unlock a session by password. Returns `false` if the password is wrong.
#[uniffi::export]
pub fn unlock_session_native(mut password: Vec<u8>) -> Result<bool, SecureStorageError> {
    let result = with_state(|s| {
        match unlock::unlock_session(&s.storage, &s.domain, &password) {
            Ok(session) => {
                s.session = Some(session);
                Ok(true)
            }
            Err(SecureStorageError::InvalidPassword) => Ok(false),
            Err(e) => Err(e),
        }
    });
    password.zeroize();
    result
}

/// Lock the current session: zeroize keys and drop the unlocked state.
#[uniffi::export]
pub fn lock_session_native() -> Result<(), SecureStorageError> {
    with_state(|s| {
        // `UnlockedSession` derives `ZeroizeOnDrop`, so dropping it
        // zeroizes the key material automatically.
        s.session = None;
        Ok(())
    })
}

/// Check whether a session is currently unlocked.
#[uniffi::export]
pub fn is_unlocked_native() -> Result<bool, SecureStorageError> {
    with_state(|s| Ok(s.session.is_some()))
}

/// Read data from the unlocked session at the given offset.
#[uniffi::export]
pub fn read_data_native(offset: u32, len: u32) -> Result<Vec<u8>, SecureStorageError> {
    with_state(|s| {
        let session = s
            .session
            .as_ref()
            .ok_or(SecureStorageError::Storage("no unlocked session".into()))?;
        let data = read_session_data(
            &s.storage,
            &s.domain,
            session,
            u64::from(offset),
            len as usize,
        )?;
        // `data` is `Zeroizing<Vec<u8>>` — unwrap into a plain Vec for UniFFI.
        // The caller (Kotlin/Swift) owns the copy from here on.
        Ok(data.to_vec())
    })
}

/// Write data to the unlocked session at the given offset.
#[uniffi::export]
pub fn write_data_native(offset: u32, mut data: Vec<u8>) -> Result<(), SecureStorageError> {
    let result = with_state(|s| {
        let session = s
            .session
            .as_mut()
            .ok_or(SecureStorageError::Storage("no unlocked session".into()))?;
        write_session_data(&mut s.storage, &s.domain, session, u64::from(offset), &data)
    });
    data.zeroize();
    result
}

/// Run one round of cover traffic (rerandomize a random block).
#[uniffi::export]
pub fn cover_traffic_tick_native() -> Result<(), SecureStorageError> {
    with_state(|s| cover_traffic_tick(&mut s.storage, &s.domain))
}

/// Return the total data size for the unlocked session.
#[uniffi::export]
pub fn get_data_size_native() -> Result<u32, SecureStorageError> {
    with_state(|s| {
        let session = s
            .session
            .as_ref()
            .ok_or(SecureStorageError::Storage("no unlocked session".into()))?;
        u32::try_from(session.total_data_length).map_err(|_| SecureStorageError::Overflow)
    })
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_with_stack;

    /// Reset global state so tests don't leak into each other.
    fn reset_state() {
        if let Some(mutex) = STATE.get() {
            let mut guard = mutex.lock().unwrap();
            *guard = None;
        }
    }

    #[test]
    fn test_native_lifecycle() {
        run_with_stack(|| {
            reset_state();

            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().to_str().unwrap().to_string();

            // init
            init_secure_storage(path, "test".into()).unwrap();

            // provision
            provision_storage_native().unwrap();

            // not unlocked yet
            assert!(!is_unlocked_native().unwrap());

            // allocate slot 2
            allocate_session_native(2, b"my-password".to_vec()).unwrap();

            // now unlocked
            assert!(is_unlocked_native().unwrap());

            // data size is 0 for fresh session
            assert_eq!(get_data_size_native().unwrap(), 0);

            // lock
            lock_session_native().unwrap();
            assert!(!is_unlocked_native().unwrap());

            // unlock with correct password
            assert!(unlock_session_native(b"my-password".to_vec()).unwrap());
            assert!(is_unlocked_native().unwrap());

            // wrong password returns false
            lock_session_native().unwrap();
            assert!(!unlock_session_native(b"wrong".to_vec()).unwrap());
            assert!(!is_unlocked_native().unwrap());
        });
    }

    #[test]
    fn test_native_read_write() {
        run_with_stack(|| {
            reset_state();

            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().to_str().unwrap().to_string();

            init_secure_storage(path, "test".into()).unwrap();
            provision_storage_native().unwrap();
            allocate_session_native(0, b"pw".to_vec()).unwrap();

            // write some data
            let payload = vec![0xAB; 100];
            write_data_native(0, payload.clone()).unwrap();

            // data size updated
            assert_eq!(get_data_size_native().unwrap(), 100);

            // read it back
            let read_back = read_data_native(0, 100).unwrap();
            assert_eq!(read_back, payload);
        });
    }

    #[test]
    fn test_native_cover_traffic() {
        run_with_stack(|| {
            reset_state();

            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().to_str().unwrap().to_string();

            init_secure_storage(path, "test".into()).unwrap();
            provision_storage_native().unwrap();
            allocate_session_native(0, b"pw".to_vec()).unwrap();

            // write data so there are blocks to rerandomize
            write_data_native(0, vec![0xCD; 50]).unwrap();

            // cover traffic should succeed
            cover_traffic_tick_native().unwrap();

            // data still intact after cover traffic
            lock_session_native().unwrap();
            assert!(unlock_session_native(b"pw".to_vec()).unwrap());
            let data = read_data_native(0, 50).unwrap();
            assert_eq!(data, vec![0xCD; 50]);
        });
    }
}
