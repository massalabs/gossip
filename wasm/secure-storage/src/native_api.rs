//! UniFFI exports for native (iOS/Android) targets.
//!
//! Single JSON-in / JSON-out dispatcher: the plugin side only knows one
//! method name (`native_call`) and passes through `(method, args_json)`.
//! All argument parsing and result encoding happens here in Rust via
//! serde, which keeps the Kotlin/Swift layer trivial (~25 lines each)
//! and means adding a new native method is a one-match-arm change.
//!
//! Binary payloads (passwords, namespace blobs, SQL BLOBs) cross the
//! bridge as base64 strings rather than `number[]`, which saved a ~×8
//! overhead per byte on the Capacitor bridge.

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::SecureStorageError;
use crate::vfs::native_vfs;

// ── Global DB connection ────────────────────────────────────────────

static DB: OnceLock<Mutex<Option<rusqlite::Connection>>> = OnceLock::new();

fn db_mutex() -> &'static Mutex<Option<rusqlite::Connection>> {
    DB.get_or_init(|| Mutex::new(None))
}

// ── UniFFI error ────────────────────────────────────────────────────

#[derive(Debug, uniffi::Error, thiserror::Error)]
pub enum SecureStorageException {
    #[error("{msg}")]
    Error { msg: String },
}

impl SecureStorageException {
    fn msg(s: impl Into<String>) -> Self {
        Self::Error { msg: s.into() }
    }
}

impl From<SecureStorageError> for SecureStorageException {
    fn from(e: SecureStorageError) -> Self {
        Self::msg(e.to_string())
    }
}

impl From<rusqlite::Error> for SecureStorageException {
    fn from(e: rusqlite::Error) -> Self {
        Self::msg(e.to_string())
    }
}

impl From<serde_json::Error> for SecureStorageException {
    fn from(e: serde_json::Error) -> Self {
        Self::msg(format!("json: {e}"))
    }
}

impl From<base64::DecodeError> for SecureStorageException {
    fn from(e: base64::DecodeError) -> Self {
        Self::msg(format!("base64: {e}"))
    }
}

type Result<T> = std::result::Result<T, SecureStorageException>;

// ── Serde types mirroring the TS wrapper ────────────────────────────

#[derive(Deserialize)]
struct InitArgs {
    path: String,
    domain: String,
}

#[derive(Deserialize)]
struct AllocateArgs {
    slot: u8,
    /// base64-encoded password bytes
    password: String,
}

#[derive(Deserialize)]
struct UnlockArgs {
    /// base64-encoded password bytes
    password: String,
}

#[derive(Deserialize)]
struct ExecSqlArgs {
    sql: String,
    #[serde(default)]
    params: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct WriteNamespaceArgs {
    namespace: u8,
    offset: u64,
    /// base64-encoded data bytes
    data: String,
}

#[derive(Deserialize)]
struct ReadNamespaceArgs {
    namespace: u8,
    offset: u64,
    len: u64,
}

#[derive(Deserialize)]
struct NamespaceArgs {
    namespace: u8,
}

/// SQL values flow as raw JSON primitives; the one exception is BLOB,
/// which cannot be represented as a JSON scalar and is carried as the
/// sentinel object `{"blob": "<base64>"}` in both directions.
#[derive(Serialize)]
struct QueryResultJson {
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    #[serde(rename = "lastInsertRowId")]
    last_insert_rowid: i64,
    changes: i64,
}

/// Decode a blob sentinel `{"blob": "<base64>"}` if `v` matches; else `None`.
fn as_blob_sentinel(v: &serde_json::Value) -> Option<&str> {
    v.as_object()
        .and_then(|o| (o.len() == 1).then_some(()))
        .and_then(|_| v.get("blob"))
        .and_then(|b| b.as_str())
}

// ── Path validation ─────────────────────────────────────────────────

fn validate_storage_path(path: &str) -> Result<()> {
    if path.bytes().any(|b| b == 0) {
        return Err(SecureStorageException::msg("path contains interior NUL"));
    }
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(SecureStorageException::msg("path must be absolute"));
    }
    for comp in p.components() {
        if matches!(comp, std::path::Component::ParentDir) {
            return Err(SecureStorageException::msg("path must not contain '..'"));
        }
    }
    Ok(())
}

// ── Dispatcher ──────────────────────────────────────────────────────

/// Single UniFFI export — the plugin layer passes through a method
/// name and a JSON args blob. All result shapes are JSON strings too.
#[uniffi::export]
pub fn native_call(method: String, args_json: String) -> Result<String> {
    dispatch(&method, &args_json)
}

fn dispatch(method: &str, args: &str) -> Result<String> {
    // Helper: parse args as T.
    fn parse<'a, T: Deserialize<'a>>(s: &'a str) -> Result<T> {
        Ok(serde_json::from_str(s)?)
    }

    match method {
        "initSecureStorage" => {
            let a: InitArgs = parse(args)?;
            init_secure_storage(&a.path, &a.domain)?;
            Ok("null".into())
        }
        "provisionStorage" => {
            native_vfs::provision()?;
            Ok("null".into())
        }
        "hasData" => {
            let has = native_vfs::has_data()?;
            Ok(serde_json::to_string(&has)?)
        }
        "allocateSession" => {
            let a: AllocateArgs = parse(args)?;
            let password = Zeroizing::new(B64.decode(a.password)?);
            allocate(a.slot, &password)?;
            Ok("null".into())
        }
        "unlockSession" => {
            let a: UnlockArgs = parse(args)?;
            let password = Zeroizing::new(B64.decode(a.password)?);
            let ok = unlock(&password)?;
            Ok(serde_json::to_string(&ok)?)
        }
        "lockSession" => {
            lock()?;
            Ok("null".into())
        }
        "isUnlocked" => {
            let ok = native_vfs::is_unlocked()?;
            Ok(serde_json::to_string(&ok)?)
        }
        "coverTrafficTick" => {
            native_vfs::cover_tick()?;
            Ok("null".into())
        }
        "flush" => {
            native_vfs::flush()?;
            Ok("null".into())
        }
        "close" => {
            close()?;
            Ok("null".into())
        }
        "rayonThreadCount" => {
            let n = rayon::current_num_threads() as u32;
            Ok(serde_json::to_string(&n)?)
        }
        "execSql" => {
            let a: ExecSqlArgs = parse(args)?;
            let qr = exec_sql(&a.sql, &a.params)?;
            Ok(serde_json::to_string(&qr)?)
        }
        "writeNamespaceData" => {
            let a: WriteNamespaceArgs = parse(args)?;
            // Session blobs may contain key material — zeroize on return.
            let data = Zeroizing::new(B64.decode(a.data)?);
            native_vfs::write_namespace_data(a.namespace, a.offset, &data)?;
            Ok("null".into())
        }
        "readNamespaceData" => {
            let a: ReadNamespaceArgs = parse(args)?;
            let bytes = native_vfs::read_namespace_data(a.namespace, a.offset, a.len as usize)?;
            Ok(serde_json::to_string(&B64.encode(bytes))?)
        }
        "namespaceDataLength" => {
            let a: NamespaceArgs = parse(args)?;
            let len = native_vfs::namespace_data_length(a.namespace)?;
            Ok(serde_json::to_string(&len)?)
        }
        "clearNamespace" => {
            let a: NamespaceArgs = parse(args)?;
            native_vfs::clear_namespace(a.namespace)?;
            Ok("null".into())
        }
        _ => Err(SecureStorageException::msg(format!(
            "unknown method: {method}"
        ))),
    }
}

// ── Per-method bodies ───────────────────────────────────────────────

fn init_secure_storage(path: &str, domain: &str) -> Result<()> {
    validate_storage_path(path)?;
    native_vfs::init_native(path, domain)?;
    native_vfs::register()?;
    // Warm rayon's global pool so the first PQ op doesn't pay spawn cost.
    let _ = rayon::ThreadPoolBuilder::new().build_global();
    eprintln!(
        "secureStorage: rayon pool = {} threads",
        rayon::current_num_threads()
    );
    Ok(())
}

fn allocate(slot: u8, password: &[u8]) -> Result<()> {
    // Drop the previous rusqlite connection BEFORE switching sessions.
    // SQLite flushes dirty pages via `xWrite` during `sqlite3_close`,
    // and that flush must land on the OLD session's slot, not the new
    // one — otherwise the previous account's in-cache data would be
    // re-encrypted with the new session's key and written to the new
    // slot, corrupting both accounts.
    {
        let mut guard = db_mutex()
            .lock()
            .map_err(|_| SecureStorageError::LockPoisoned)?;
        *guard = None;
    }
    native_vfs::allocate(slot, password)?;
    let conn = native_vfs::open_db()?;
    let mut guard = db_mutex()
        .lock()
        .map_err(|_| SecureStorageError::LockPoisoned)?;
    *guard = Some(conn);
    Ok(())
}

fn unlock(password: &[u8]) -> Result<bool> {
    let ok = native_vfs::unlock(password)?;
    if ok {
        let conn = native_vfs::open_db()?;
        let mut guard = db_mutex()
            .lock()
            .map_err(|_| SecureStorageError::LockPoisoned)?;
        *guard = Some(conn);
    }
    Ok(ok)
}

fn lock() -> Result<()> {
    let mut guard = db_mutex()
        .lock()
        .map_err(|_| SecureStorageError::LockPoisoned)?;
    *guard = None;
    native_vfs::lock();
    Ok(())
}

fn close() -> Result<()> {
    let mut guard = db_mutex()
        .lock()
        .map_err(|_| SecureStorageError::LockPoisoned)?;
    *guard = None;
    native_vfs::flush().ok();
    native_vfs::lock();
    Ok(())
}

fn exec_sql(sql: &str, params: &[serde_json::Value]) -> Result<QueryResultJson> {
    use serde_json::Value as V;

    let guard = db_mutex()
        .lock()
        .map_err(|_| SecureStorageError::LockPoisoned)?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| SecureStorageError::Storage("database not open".into()))?;

    let mut stmt = conn.prepare(sql)?;
    let column_count = stmt.column_count();
    let columns: Vec<String> = (0..column_count)
        .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
        .collect();

    // Bind parameters. SQLite distinguishes INTEGER/REAL; JS numbers don't.
    // Convention: integers if the JSON number fits losslessly in i64, else REAL.
    // Blobs arrive as `{"blob": "<base64>"}`.
    for (i, param) in params.iter().enumerate() {
        let idx = i + 1;
        if let Some(b64) = as_blob_sentinel(param) {
            stmt.raw_bind_parameter(idx, B64.decode(b64)?)?;
            continue;
        }
        match param {
            V::Null => stmt.raw_bind_parameter(idx, rusqlite::types::Null)?,
            V::Bool(b) => stmt.raw_bind_parameter(idx, if *b { 1i64 } else { 0 })?,
            V::Number(n) => {
                if let Some(i) = n.as_i64() {
                    stmt.raw_bind_parameter(idx, i)?
                } else if let Some(f) = n.as_f64() {
                    stmt.raw_bind_parameter(idx, f)?
                } else {
                    return Err(SecureStorageException::msg("unsupported number"));
                }
            }
            V::String(s) => stmt.raw_bind_parameter(idx, s.as_str())?,
            other => {
                return Err(SecureStorageException::msg(format!(
                    "unsupported SQL param: {other}"
                )));
            }
        }
    }

    let mut rows_out: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut raw_rows = stmt.raw_query();
    while let Some(row) = raw_rows.next()? {
        let mut row_out = Vec::with_capacity(column_count);
        for col in 0..column_count {
            let val = match row.get_ref(col)? {
                rusqlite::types::ValueRef::Null => V::Null,
                rusqlite::types::ValueRef::Integer(v) => V::from(v),
                rusqlite::types::ValueRef::Real(v) => serde_json::Number::from_f64(v)
                    .map(V::Number)
                    .unwrap_or(V::Null),
                // TEXT may carry non-UTF-8 if the caller bound raw bytes
                // into a TEXT column — fall back to the blob sentinel so
                // callers can recover the raw bytes.
                rusqlite::types::ValueRef::Text(v) => match std::str::from_utf8(v) {
                    Ok(s) => V::from(s),
                    Err(_) => serde_json::json!({ "blob": B64.encode(v) }),
                },
                rusqlite::types::ValueRef::Blob(v) => {
                    serde_json::json!({ "blob": B64.encode(v) })
                }
            };
            row_out.push(val);
        }
        rows_out.push(row_out);
    }
    drop(raw_rows);

    let last_insert_rowid = conn.last_insert_rowid();
    let changes = conn.changes() as i64;

    Ok(QueryResultJson {
        columns,
        rows: rows_out,
        last_insert_rowid,
        changes,
    })
}

// Note: `uniffi::setup_scaffolding!()` lives in lib.rs (crate root).
