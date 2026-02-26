//! WASM API — `#[wasm_bindgen]` exports for JavaScript consumption.

use std::cell::RefCell;

use wasm_bindgen::prelude::*;

use crate::lifecycle::{allocate_session, cover_traffic_tick, provision_storage};
use crate::read::read_session_data;
use crate::storage::WasmStorage;
use crate::types::SessionIndex;
use crate::unlock::{UnlockedSession, unlock_session};
use crate::write::write_session_data;

struct BordecryptState {
    storage: WasmStorage,
    domain: String,
    session: Option<UnlockedSession>,
}

thread_local! {
    static STATE: RefCell<Option<BordecryptState>> = const { RefCell::new(None) };
}

fn map_err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Initialize bordercrypt with a domain string for KDF separation.
///
/// Must be called before any other bordercrypt function.
#[wasm_bindgen(js_name = "initBordercrypt")]
pub fn init_bordercrypt(domain: &str) {
    STATE.with(|s| {
        *s.borrow_mut() = Some(BordecryptState {
            storage: WasmStorage::new(),
            domain: domain.to_string(),
            session: None,
        });
    });
}

/// Provision all 5 session slots with valid but non-unlockable keypairs.
#[wasm_bindgen(js_name = "provisionStorage")]
pub fn provision() -> Result<(), JsValue> {
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let state = state
            .as_mut()
            .ok_or_else(|| JsValue::from_str("not initialized"))?;
        provision_storage(&mut state.storage).map_err(map_err)
    })
}

/// Allocate a session in the given slot with a password.
///
/// The session is automatically unlocked after allocation.
#[wasm_bindgen(js_name = "allocateSession")]
pub fn allocate(slot: u8, password: &[u8]) -> Result<(), JsValue> {
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let state = state
            .as_mut()
            .ok_or_else(|| JsValue::from_str("not initialized"))?;
        let idx = SessionIndex::new(slot).map_err(map_err)?;
        let session =
            allocate_session(&mut state.storage, &state.domain, idx, password).map_err(map_err)?;
        state.session = Some(session);
        Ok(())
    })
}

/// Try to unlock a session with the given password.
///
/// Returns `true` if a session was unlocked, `false` if no matching session.
#[wasm_bindgen(js_name = "unlockSession")]
pub fn unlock(password: &[u8]) -> Result<bool, JsValue> {
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let state = state
            .as_mut()
            .ok_or_else(|| JsValue::from_str("not initialized"))?;
        match unlock_session(&state.storage, &state.domain, password) {
            Ok(session) => {
                state.session = Some(session);
                Ok(true)
            }
            Err(_) => Ok(false),
        }
    })
}

/// Lock the current session, zeroizing all secret key material.
#[wasm_bindgen(js_name = "lockSession")]
pub fn lock() {
    STATE.with(|s| {
        if let Some(ref mut state) = *s.borrow_mut() {
            state.session = None;
        }
    });
}

/// Check if a session is currently unlocked.
#[wasm_bindgen(js_name = "isUnlocked")]
pub fn is_unlocked() -> bool {
    STATE.with(|s| s.borrow().as_ref().is_some_and(|st| st.session.is_some()))
}

/// Read decrypted data at the given byte offset.
#[wasm_bindgen(js_name = "readData")]
pub fn read_data(offset: u32, len: u32) -> Result<Vec<u8>, JsValue> {
    STATE.with(|s| {
        let state = s.borrow();
        let state = state
            .as_ref()
            .ok_or_else(|| JsValue::from_str("not initialized"))?;
        let session = state
            .session
            .as_ref()
            .ok_or_else(|| JsValue::from_str("not unlocked"))?;
        let data = read_session_data(
            &state.storage,
            &state.domain,
            session,
            u64::from(offset),
            len as usize,
        )
        .map_err(map_err)?;
        Ok(data.to_vec())
    })
}

/// Write data at the given byte offset (encrypts all sessions).
#[wasm_bindgen(js_name = "writeData")]
pub fn write_data(offset: u32, data: &[u8]) -> Result<(), JsValue> {
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let state = state
            .as_mut()
            .ok_or_else(|| JsValue::from_str("not initialized"))?;
        let session = state
            .session
            .as_mut()
            .ok_or_else(|| JsValue::from_str("not unlocked"))?;
        write_session_data(
            &mut state.storage,
            &state.domain,
            session,
            u64::from(offset),
            data,
        )
        .map_err(map_err)
    })
}

/// Run one round of cover traffic (rerandomize a random block).
#[wasm_bindgen(js_name = "coverTrafficTick")]
pub fn cover_tick() -> Result<(), JsValue> {
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let state = state
            .as_mut()
            .ok_or_else(|| JsValue::from_str("not initialized"))?;
        cover_traffic_tick(&mut state.storage, &state.domain).map_err(map_err)
    })
}

/// Get the total stored data size in bytes.
#[wasm_bindgen(js_name = "getDataSize")]
pub fn get_data_size() -> Result<u32, JsValue> {
    STATE.with(|s| {
        let state = s.borrow();
        let state = state
            .as_ref()
            .ok_or_else(|| JsValue::from_str("not initialized"))?;
        let session = state
            .session
            .as_ref()
            .ok_or_else(|| JsValue::from_str("not unlocked"))?;
        u32::try_from(session.total_data_length).map_err(map_err)
    })
}
