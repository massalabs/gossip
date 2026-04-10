//! UniFFI exports for native (iOS/Android) targets.
//!
//! Thin wrappers around [`crate::vfs::native_vfs`] functions, exposed to
//! Swift/Kotlin via UniFFI proc macros. Each function maps 1:1 to a
//! `SecureStoragePlugin` method on the mobile side.
//!
//! The SQL execution path uses a global `rusqlite::Connection` stored
//! behind the same `Mutex` as the VFS state.

use std::sync::{Mutex, OnceLock};

use crate::error::SecureStorageError;
use crate::vfs::native_vfs;

// ── Global DB connection ────────────────────────────────────────────

static DB: OnceLock<Mutex<Option<rusqlite::Connection>>> = OnceLock::new();

fn db_mutex() -> &'static Mutex<Option<rusqlite::Connection>> {
    DB.get_or_init(|| Mutex::new(None))
}

// ── UniFFI type definitions ─────────────────────────────────────────

#[derive(uniffi::Enum)]
pub enum SqlParam {
    Null,
    Integer { value: i64 },
    Real { value: f64 },
    Text { value: String },
    Blob { value: Vec<u8> },
}

#[derive(uniffi::Enum)]
pub enum SqlValue {
    Null,
    Integer { value: i64 },
    Real { value: f64 },
    Text { value: String },
    Blob { value: Vec<u8> },
}

#[derive(uniffi::Record)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<SqlValue>>,
    pub last_insert_rowid: i64,
    pub changes: i64,
}

#[derive(Debug, uniffi::Error, thiserror::Error)]
pub enum SecureStorageException {
    #[error("{msg}")]
    Error { msg: String },
}

impl From<SecureStorageError> for SecureStorageException {
    fn from(e: SecureStorageError) -> Self {
        SecureStorageException::Error {
            msg: e.to_string(),
        }
    }
}

impl From<rusqlite::Error> for SecureStorageException {
    fn from(e: rusqlite::Error) -> Self {
        SecureStorageException::Error {
            msg: e.to_string(),
        }
    }
}

// ── Lifecycle exports ───────────────────────────────────────────────

#[uniffi::export]
pub fn init_secure_storage(path: String, domain: String) -> Result<(), SecureStorageException> {
    native_vfs::init_native(&path, &domain)?;
    native_vfs::register()?;
    Ok(())
}

#[uniffi::export]
pub fn provision_storage_native() -> Result<(), SecureStorageException> {
    native_vfs::provision()?;
    Ok(())
}

#[uniffi::export]
pub fn allocate_session_native(slot: u8, password: Vec<u8>) -> Result<(), SecureStorageException> {
    native_vfs::allocate(slot, &password)?;
    // Auto-open the database after allocation.
    let conn = native_vfs::open_db()?;
    let mut guard = db_mutex().lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    *guard = Some(conn);
    Ok(())
}

#[uniffi::export]
pub fn unlock_session_native(password: Vec<u8>) -> Result<bool, SecureStorageException> {
    let ok = native_vfs::unlock(&password)?;
    if ok {
        let conn = native_vfs::open_db()?;
        let mut guard = db_mutex().lock().map_err(|_| SecureStorageError::LockPoisoned)?;
        *guard = Some(conn);
    }
    Ok(ok)
}

#[uniffi::export]
pub fn lock_session_native() -> Result<(), SecureStorageException> {
    // Close the DB connection first, then lock the VFS state.
    let mut guard = db_mutex().lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    *guard = None;
    native_vfs::lock();
    Ok(())
}

#[uniffi::export]
pub fn is_unlocked_native() -> Result<bool, SecureStorageException> {
    Ok(native_vfs::is_unlocked()?)
}

#[uniffi::export]
pub fn cover_traffic_tick_native() -> Result<(), SecureStorageException> {
    Ok(native_vfs::cover_tick()?)
}

#[uniffi::export]
pub fn flush_native() -> Result<(), SecureStorageException> {
    Ok(native_vfs::flush()?)
}

#[uniffi::export]
pub fn close_native() -> Result<(), SecureStorageException> {
    let mut guard = db_mutex().lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    *guard = None;
    native_vfs::flush().ok();
    native_vfs::lock();
    Ok(())
}

// ── SQL execution ───────────────────────────────────────────────────

#[uniffi::export]
pub fn exec_sql_native(
    sql: String,
    params: Vec<SqlParam>,
) -> Result<QueryResult, SecureStorageException> {
    let guard = db_mutex().lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| SecureStorageError::Storage("database not open".into()))?;

    let mut stmt = conn.prepare(&sql)?;
    let column_count = stmt.column_count();
    let columns: Vec<String> = (0..column_count)
        .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
        .collect();

    // Bind parameters.
    for (i, param) in params.iter().enumerate() {
        let idx = i + 1;
        match param {
            SqlParam::Null => stmt.raw_bind_parameter(idx, rusqlite::types::Null)?,
            SqlParam::Integer { value } => stmt.raw_bind_parameter(idx, value)?,
            SqlParam::Real { value } => stmt.raw_bind_parameter(idx, value)?,
            SqlParam::Text { value } => stmt.raw_bind_parameter(idx, value.as_str())?,
            SqlParam::Blob { value } => stmt.raw_bind_parameter(idx, value.as_slice())?,
        }
    }

    // Execute and collect rows.
    let mut rows_out: Vec<Vec<SqlValue>> = Vec::new();
    let mut raw_rows = stmt.raw_query();
    while let Some(row) = raw_rows.next()? {
        let mut row_out = Vec::with_capacity(column_count);
        for col in 0..column_count {
            let val = match row.get_ref(col)? {
                rusqlite::types::ValueRef::Null => SqlValue::Null,
                rusqlite::types::ValueRef::Integer(v) => SqlValue::Integer { value: v },
                rusqlite::types::ValueRef::Real(v) => SqlValue::Real { value: v },
                rusqlite::types::ValueRef::Text(v) => SqlValue::Text {
                    value: String::from_utf8_lossy(v).into_owned(),
                },
                rusqlite::types::ValueRef::Blob(v) => SqlValue::Blob {
                    value: v.to_vec(),
                },
            };
            row_out.push(val);
        }
        rows_out.push(row_out);
    }
    drop(raw_rows);

    let last_insert_rowid = conn.last_insert_rowid();
    let changes = conn.changes() as i64;

    Ok(QueryResult {
        columns,
        rows: rows_out,
        last_insert_rowid,
        changes,
    })
}

// ── Namespace data (session blob persist) ───────────────────────────

#[uniffi::export]
pub fn write_namespace_data_native(
    namespace: u8,
    offset: u64,
    data: Vec<u8>,
) -> Result<(), SecureStorageException> {
    Ok(native_vfs::write_namespace_data(namespace, offset, &data)?)
}

#[uniffi::export]
pub fn read_namespace_data_native(
    namespace: u8,
    offset: u64,
    len: u64,
) -> Result<Vec<u8>, SecureStorageException> {
    Ok(native_vfs::read_namespace_data(namespace, offset, len as usize)?)
}

#[uniffi::export]
pub fn namespace_data_length_native(namespace: u8) -> Result<u64, SecureStorageException> {
    Ok(native_vfs::namespace_data_length(namespace)?)
}

// Note: `uniffi::setup_scaffolding!()` is in lib.rs (crate root),
// not here, because UniFFI requires the scaffolding in the root module.
