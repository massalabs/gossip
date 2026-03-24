//! wasm-bindgen exports for the bordercrypt database.

use wasm_bindgen::prelude::*;

use crate::db::{self, SqlValue};
use crate::vfs::{encrypted_vfs, idb_vfs, memory_vfs};

// ── Non-encrypted database (memory / idb) ────────────────────────────

/// Initialise a non-encrypted database on the given backend.
///
/// `backend`: `"memory"` or `"idb"`.
#[wasm_bindgen(js_name = initDatabase)]
pub async fn init_database(backend: &str) -> Result<(), JsValue> {
    console_error_panic_hook::set_once();

    match backend {
        "memory" => {
            memory_vfs::register();
            db::open(memory_vfs::VFS_NAME).map_err(|e| JsValue::from_str(&e.to_string()))
        }
        "idb" => {
            idb_vfs::restore().await?;
            idb_vfs::register();
            db::open(idb_vfs::VFS_NAME).map_err(|e| JsValue::from_str(&e.to_string()))
        }
        _ => Err(JsValue::from_str(&format!("unknown backend: {backend}"))),
    }
}

// ── Encrypted database (bordercrypt) ─────────────────────────────────

/// Initialise bordercrypt encrypted storage.
///
/// `backend`: `"memory"` (no persistence), `"idb"`, or `"opfs"`.
#[wasm_bindgen(js_name = initBordercrypt)]
pub async fn init_bordercrypt(domain: &str, backend: &str) -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    match backend {
        "memory" => {
            encrypted_vfs::init_memory(domain);
        }
        "idb" => encrypted_vfs::init_idb(domain).await?,
        "opfs" => encrypted_vfs::init_opfs(domain).await?,
        _ => return Err(JsValue::from_str(&format!("unknown backend: {backend}"))),
    }
    // Register VFS once during init — it persists across open/close cycles.
    encrypted_vfs::register();
    Ok(())
}

/// Provision all 5 session slots.
#[wasm_bindgen(js_name = provisionStorage)]
pub fn provision_storage() -> Result<(), JsValue> {
    encrypted_vfs::provision()
}

/// Allocate a session in `slot` with `password`, open SQLite.
#[wasm_bindgen(js_name = allocateSession)]
pub fn allocate_session(slot: u8, password: &[u8]) -> Result<(), JsValue> {
    // Close any existing DB before switching sessions to avoid leaking handles.
    let _ = db::close();
    encrypted_vfs::allocate(slot, password)?;
    db::open(encrypted_vfs::VFS_NAME).map_err(|e| {
        encrypted_vfs::lock();
        JsValue::from_str(&e.to_string())
    })
}

/// Unlock a session by password, open SQLite. Returns false if wrong password.
#[wasm_bindgen(js_name = unlockSession)]
pub fn unlock_session(password: &[u8]) -> Result<bool, JsValue> {
    // Close any existing DB before opening a new one.
    let _ = db::close();
    let ok = encrypted_vfs::unlock(password)?;
    if ok {
        db::open(encrypted_vfs::VFS_NAME).map_err(|e| {
            encrypted_vfs::lock();
            JsValue::from_str(&e.to_string())
        })?;
    }
    Ok(ok)
}

/// Lock the session: close SQLite, flush to backing store, zeroize keys.
#[wasm_bindgen(js_name = lockSession)]
pub async fn lock_session() -> Result<(), JsValue> {
    db::close().map_err(|e| JsValue::from_str(&e.to_string()))?;
    encrypted_vfs::flush().await?;
    encrypted_vfs::lock();
    Ok(())
}

/// Run one round of cover traffic.
#[wasm_bindgen(js_name = coverTrafficTick)]
pub fn cover_traffic_tick() -> Result<(), JsValue> {
    encrypted_vfs::cover_tick()
}

// ── Shared: SQL execution ────────────────────────────────────────────

/// Execute a SQL statement with bind parameters.
///
/// `params` is a JS `Array` of values (null, number, string, Uint8Array).
/// Returns `{ columns, rows, lastInsertRowId, changes }`.
#[wasm_bindgen]
pub fn execute(sql: &str, params: JsValue) -> Result<JsValue, JsValue> {
    let ps = parse_params(&params)?;
    let result = db::execute(sql, &ps).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(result_to_js(&result))
}

/// Close the database and release resources.
#[wasm_bindgen(js_name = closeDatabase)]
pub fn close_database() -> Result<(), JsValue> {
    db::close().map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Flush pending writes to IndexedDB (non-encrypted IDB VFS).
#[wasm_bindgen(js_name = flushIdb)]
pub async fn flush_idb() -> Result<(), JsValue> {
    idb_vfs::flush().await
}

/// Flush encrypted data to backing store (IDB or OPFS).
#[wasm_bindgen(js_name = flushEncrypted)]
pub async fn flush_encrypted() -> Result<(), JsValue> {
    encrypted_vfs::flush().await
}

// ── JS ↔ Rust conversion ────────────────────────────────────────────

/// SQLite default limit for bind parameters.
const MAX_PARAMS: u32 = 999;
/// Maximum blob/text size accepted from JS (16 MB).
const MAX_PARAM_BYTES: usize = 16 * 1024 * 1024;

fn parse_params(val: &JsValue) -> Result<Vec<SqlValue>, JsValue> {
    if val.is_null() || val.is_undefined() {
        return Ok(Vec::new());
    }
    let arr = js_sys::Array::from(val);
    if arr.length() > MAX_PARAMS {
        return Err(JsValue::from_str("too many parameters"));
    }
    let mut out = Vec::with_capacity(arr.length() as usize);
    for i in 0..arr.length() {
        out.push(js_to_sql(&arr.get(i))?);
    }
    Ok(out)
}

fn js_to_sql(v: &JsValue) -> Result<SqlValue, JsValue> {
    if v.is_null() || v.is_undefined() {
        Ok(SqlValue::Null)
    } else if let Some(s) = v.as_string() {
        if s.len() > MAX_PARAM_BYTES {
            return Err(JsValue::from_str("text param too large"));
        }
        Ok(SqlValue::Text(s))
    } else if let Some(n) = v.as_f64() {
        if n.is_nan() || n.is_infinite() {
            return Err(JsValue::from_str("NaN/Infinity not supported"));
        }
        if n.fract() == 0.0 && (i64::MIN as f64..=i64::MAX as f64).contains(&n) {
            Ok(SqlValue::Integer(n as i64))
        } else {
            Ok(SqlValue::Real(n))
        }
    } else if v.is_instance_of::<js_sys::Uint8Array>() {
        let a = js_sys::Uint8Array::new(v);
        if a.length() as usize > MAX_PARAM_BYTES {
            return Err(JsValue::from_str("blob param too large"));
        }
        Ok(SqlValue::Blob(a.to_vec()))
    } else {
        Err(JsValue::from_str("unsupported param type"))
    }
}

fn result_to_js(r: &db::QueryResult) -> JsValue {
    let obj = js_sys::Object::new();

    let cols = js_sys::Array::new();
    for c in &r.columns {
        cols.push(&JsValue::from_str(c));
    }
    js_sys::Reflect::set(&obj, &"columns".into(), &cols).unwrap();

    let rows = js_sys::Array::new();
    for row in &r.rows {
        let js_row = js_sys::Array::new();
        for val in row {
            js_row.push(&sql_to_js(val));
        }
        rows.push(&js_row);
    }
    js_sys::Reflect::set(&obj, &"rows".into(), &rows).unwrap();

    js_sys::Reflect::set(
        &obj,
        &"lastInsertRowId".into(),
        &JsValue::from_f64(r.last_insert_rowid as f64),
    )
    .unwrap();

    js_sys::Reflect::set(&obj, &"changes".into(), &JsValue::from_f64(r.changes as f64)).unwrap();

    obj.into()
}

fn sql_to_js(v: &SqlValue) -> JsValue {
    match v {
        SqlValue::Null => JsValue::NULL,
        // JS Number loses precision for |n| > 2^53. Acceptable: Drizzle
        // ORM only uses integers within safe JS range.
        SqlValue::Integer(n) => JsValue::from_f64(*n as f64),
        SqlValue::Real(f) => JsValue::from_f64(*f),
        SqlValue::Text(s) => JsValue::from_str(s),
        SqlValue::Blob(b) => {
            let a = js_sys::Uint8Array::new_with_length(b.len() as u32);
            a.copy_from(b);
            a.into()
        }
    }
}
