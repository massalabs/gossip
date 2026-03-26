//! UniFFI exports for the secure-storage native plugin.
//!
//! Delegates storage/session operations to `native_vfs` and exposes
//! SQL execution via a `rusqlite::Connection` opened through the
//! encrypted VFS.

use std::sync::{Mutex, OnceLock};

use zeroize::Zeroize;

use crate::error::SecureStorageError;
use crate::vfs::native_vfs;

// ── DB connection state ─────────────────────────────────────────────

static DB_CONN: OnceLock<Mutex<Option<rusqlite::Connection>>> = OnceLock::new();

fn db() -> &'static Mutex<Option<rusqlite::Connection>> {
    DB_CONN.get_or_init(|| Mutex::new(None))
}

// ── SQL types ───────────────────────────────────────────────────────

#[derive(uniffi::Enum)]
pub enum SqlParam {
    Null,
    Integer { value: i64 },
    Real { value: f64 },
    Text { value: String },
    Blob { value: Vec<u8> },
}

#[derive(uniffi::Enum, Debug, PartialEq)]
pub enum SqlValue {
    Null,
    Integer { value: i64 },
    Real { value: f64 },
    Text { value: String },
    Blob { value: Vec<u8> },
}

#[derive(uniffi::Record, Debug)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<SqlValue>>,
    pub last_insert_rowid: i64,
    pub changes: i32,
}

// ── PRAGMAs ─────────────────────────────────────────────────────────

fn set_pragmas(conn: &rusqlite::Connection) -> Result<(), SecureStorageError> {
    let map_err = |e: rusqlite::Error| SecureStorageError::Sqlite(e.to_string());
    conn.pragma_update(None, "page_size", 8192).map_err(map_err)?;
    // NORMAL: x_sync fires at each COMMIT, draining the plaintext buffer
    // and encrypting each dirty block once (coalesced writes within a tx).
    conn.pragma_update(None, "synchronous", "NORMAL").map_err(map_err)?;
    conn.pragma_update(None, "cache_size", -8000).map_err(map_err)?;
    conn.pragma_update(None, "locking_mode", "EXCLUSIVE")
        .map_err(map_err)?;
    conn.pragma_update(None, "trusted_schema", "OFF")
        .map_err(map_err)?;
    Ok(())
}

// ── Exported functions ──────────────────────────────────────────────

/// Initialise secure-storage with a filesystem path and domain string.
#[uniffi::export]
pub fn init_secure_storage(path: String, domain: String) -> Result<(), SecureStorageError> {
    native_vfs::init_native(&path, &domain)?;
    native_vfs::register()?;
    Ok(())
}

/// Provision all 5 session slots. Returns true if fresh, false if already provisioned.
#[uniffi::export]
pub fn provision_storage_native() -> Result<bool, SecureStorageError> {
    native_vfs::provision()
}

/// Allocate a session in `slot` with the given `password`.
#[uniffi::export]
pub fn allocate_session_native(slot: u8, mut password: Vec<u8>) -> Result<(), SecureStorageError> {
    let result = native_vfs::allocate(slot, &password);
    if result.is_ok() {
        let conn = native_vfs::open_db()?;
        set_pragmas(&conn)?;
        *db().lock().map_err(|_| SecureStorageError::LockPoisoned)? = Some(conn);
    }
    password.zeroize();
    result
}

/// Unlock a session by password. Returns `false` if the password is wrong.
#[uniffi::export]
pub fn unlock_session_native(mut password: Vec<u8>) -> Result<bool, SecureStorageError> {
    let result = native_vfs::unlock(&password);
    if let Ok(true) = &result {
        let conn = native_vfs::open_db()?;
        set_pragmas(&conn)?;
        *db().lock().map_err(|_| SecureStorageError::LockPoisoned)? = Some(conn);
    }
    password.zeroize();
    result
}

/// Lock the current session: flush, close DB, zeroize keys.
#[uniffi::export]
pub fn lock_session_native() -> Result<(), SecureStorageError> {
    // Flush WAL to disk before closing (otherwise data in memory is lost).
    native_vfs::flush()?;
    // Close DB (can't query without session keys)
    let mut conn_guard = db().lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    *conn_guard = None;
    drop(conn_guard);
    // Then lock (zeroizes keys)
    native_vfs::lock();
    Ok(())
}

/// Check whether a session is currently unlocked.
#[uniffi::export]
pub fn is_unlocked_native() -> Result<bool, SecureStorageError> {
    native_vfs::is_unlocked()
}

/// Run one round of cover traffic (rerandomize a random block).
#[uniffi::export]
pub fn cover_traffic_tick_native() -> Result<(), SecureStorageError> {
    native_vfs::cover_tick()
}

/// Flush encrypted data to backing store.
#[uniffi::export]
pub fn flush_native() -> Result<(), SecureStorageError> {
    native_vfs::flush()
}

/// Close the DB connection (without locking the session).
#[uniffi::export]
pub fn close_native() -> Result<(), SecureStorageError> {
    let mut guard = db().lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    *guard = None;
    Ok(())
}

/// Execute a SQL statement and return results.
#[uniffi::export]
pub fn exec_sql_native(
    sql: String,
    params: Vec<SqlParam>,
) -> Result<QueryResult, SecureStorageError> {
    let guard = db().lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| SecureStorageError::Sqlite("database not open".into()))?;

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| SecureStorageError::Sqlite(e.to_string()))?;

    // Bind params
    for (i, param) in params.iter().enumerate() {
        let idx = i + 1;
        match param {
            SqlParam::Null => stmt.raw_bind_parameter(idx, rusqlite::types::Null),
            SqlParam::Integer { value } => stmt.raw_bind_parameter(idx, value),
            SqlParam::Real { value } => stmt.raw_bind_parameter(idx, value),
            SqlParam::Text { value } => stmt.raw_bind_parameter(idx, value.as_str()),
            SqlParam::Blob { value } => stmt.raw_bind_parameter(idx, value.as_slice()),
        }
        .map_err(|e| SecureStorageError::Sqlite(e.to_string()))?;
    }

    // Collect column names
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    // Step through rows
    let mut rows = Vec::new();
    let mut raw_rows = stmt.raw_query();
    while let Some(row) = raw_rows
        .next()
        .map_err(|e| SecureStorageError::Sqlite(e.to_string()))?
    {
        let mut vals = Vec::new();
        for i in 0..columns.len() {
            let val = match row
                .get_ref(i)
                .map_err(|e| SecureStorageError::Sqlite(e.to_string()))?
            {
                rusqlite::types::ValueRef::Null => SqlValue::Null,
                rusqlite::types::ValueRef::Integer(v) => SqlValue::Integer { value: v },
                rusqlite::types::ValueRef::Real(v) => SqlValue::Real { value: v },
                rusqlite::types::ValueRef::Text(s) => SqlValue::Text {
                    value: String::from_utf8_lossy(s).into_owned(),
                },
                rusqlite::types::ValueRef::Blob(b) => SqlValue::Blob {
                    value: b.to_vec(),
                },
            };
            vals.push(val);
        }
        rows.push(vals);
    }
    drop(raw_rows);

    let last_insert_rowid = conn.last_insert_rowid();
    let changes = conn.changes() as i32;

    Ok(QueryResult {
        columns,
        rows,
        last_insert_rowid,
        changes,
    })
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_with_stack;

    /// Serialise tests that share global state.
    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn test_mutex() -> &'static Mutex<()> {
        TEST_LOCK.get_or_init(|| Mutex::new(()))
    }

    /// Reset global state so tests don't leak into each other.
    fn reset_state() {
        native_vfs::reset_state();
        if let Ok(mut guard) = db().lock() {
            *guard = None;
        }
    }

    fn setup() -> tempfile::TempDir {
        reset_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap().to_string();
        init_secure_storage(path, "test".into()).unwrap();
        provision_storage_native().unwrap();
        dir
    }

    #[test]
    fn test_native_lifecycle() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            let _dir = setup();

            // not unlocked yet
            assert!(!is_unlocked_native().unwrap());

            // allocate slot 2
            allocate_session_native(2, b"my-password".to_vec()).unwrap();

            // now unlocked
            assert!(is_unlocked_native().unwrap());

            // DB should be open -- basic SQL works
            let result = exec_sql_native("SELECT 1".into(), vec![]).unwrap();
            assert_eq!(result.rows.len(), 1);

            // lock
            lock_session_native().unwrap();
            assert!(!is_unlocked_native().unwrap());

            // DB closed -- SQL should fail
            assert!(exec_sql_native("SELECT 1".into(), vec![]).is_err());

            // unlock with correct password
            assert!(unlock_session_native(b"my-password".to_vec()).unwrap());
            assert!(is_unlocked_native().unwrap());

            // DB re-opened
            let result = exec_sql_native("SELECT 1".into(), vec![]).unwrap();
            assert_eq!(result.rows.len(), 1);

            // wrong password returns false
            lock_session_native().unwrap();
            assert!(!unlock_session_native(b"wrong".to_vec()).unwrap());
            assert!(!is_unlocked_native().unwrap());
        });
    }

    #[test]
    fn test_native_sql_roundtrip() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            let _dir = setup();

            allocate_session_native(0, b"pw".to_vec()).unwrap();

            // Create table
            exec_sql_native(
                "CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)".into(),
                vec![],
            )
            .unwrap();

            // Insert rows
            exec_sql_native(
                "INSERT INTO t VALUES (?, ?)".into(),
                vec![
                    SqlParam::Integer { value: 1 },
                    SqlParam::Text {
                        value: "hello".into(),
                    },
                ],
            )
            .unwrap();
            exec_sql_native(
                "INSERT INTO t VALUES (?, ?)".into(),
                vec![
                    SqlParam::Integer { value: 2 },
                    SqlParam::Text {
                        value: "world".into(),
                    },
                ],
            )
            .unwrap();

            // Select and verify
            let result =
                exec_sql_native("SELECT id, val FROM t ORDER BY id".into(), vec![]).unwrap();
            assert_eq!(result.columns, vec!["id", "val"]);
            assert_eq!(result.rows.len(), 2);
            assert_eq!(
                result.rows[0],
                vec![
                    SqlValue::Integer { value: 1 },
                    SqlValue::Text {
                        value: "hello".into()
                    }
                ]
            );
            assert_eq!(
                result.rows[1],
                vec![
                    SqlValue::Integer { value: 2 },
                    SqlValue::Text {
                        value: "world".into()
                    }
                ]
            );

            // Verify last_insert_rowid
            let insert_result = exec_sql_native(
                "INSERT INTO t VALUES (?, ?)".into(),
                vec![
                    SqlParam::Integer { value: 42 },
                    SqlParam::Text {
                        value: "test".into(),
                    },
                ],
            )
            .unwrap();
            assert_eq!(insert_result.last_insert_rowid, 42);
            assert_eq!(insert_result.changes, 1);
        });
    }

    #[test]
    fn test_native_sql_params() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            let _dir = setup();

            allocate_session_native(0, b"pw".to_vec()).unwrap();

            exec_sql_native(
                "CREATE TABLE types (n, i INTEGER, r REAL, t TEXT, b BLOB)".into(),
                vec![],
            )
            .unwrap();

            // Insert all param types
            exec_sql_native(
                "INSERT INTO types VALUES (?, ?, ?, ?, ?)".into(),
                vec![
                    SqlParam::Null,
                    SqlParam::Integer { value: 42 },
                    SqlParam::Real { value: 3.14 },
                    SqlParam::Text {
                        value: "hello".into(),
                    },
                    SqlParam::Blob {
                        value: vec![0xDE, 0xAD],
                    },
                ],
            )
            .unwrap();

            // Read back and verify types
            let result =
                exec_sql_native("SELECT n, i, r, t, b FROM types".into(), vec![]).unwrap();
            assert_eq!(result.rows.len(), 1);
            let row = &result.rows[0];
            assert_eq!(row[0], SqlValue::Null);
            assert_eq!(row[1], SqlValue::Integer { value: 42 });
            assert_eq!(row[2], SqlValue::Real { value: 3.14 });
            assert_eq!(
                row[3],
                SqlValue::Text {
                    value: "hello".into()
                }
            );
            assert_eq!(
                row[4],
                SqlValue::Blob {
                    value: vec![0xDE, 0xAD]
                }
            );
        });
    }

    #[test]
    fn test_native_cover_traffic() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            let _dir = setup();

            allocate_session_native(0, b"pw".to_vec()).unwrap();

            // Write data via SQL so there are blocks to rerandomize
            exec_sql_native(
                "CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB)".into(),
                vec![],
            )
            .unwrap();
            exec_sql_native(
                "INSERT INTO t VALUES (1, ?)".into(),
                vec![SqlParam::Blob {
                    value: vec![0xCD; 50],
                }],
            )
            .unwrap();

            // cover traffic should succeed
            cover_traffic_tick_native().unwrap();

            // data still intact after cover traffic
            lock_session_native().unwrap();
            assert!(unlock_session_native(b"pw".to_vec()).unwrap());
            let result =
                exec_sql_native("SELECT data FROM t WHERE id = 1".into(), vec![]).unwrap();
            assert_eq!(result.rows.len(), 1);
            assert_eq!(
                result.rows[0][0],
                SqlValue::Blob {
                    value: vec![0xCD; 50]
                }
            );
        });
    }

    #[test]
    fn test_native_close() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            let _dir = setup();

            allocate_session_native(0, b"pw".to_vec()).unwrap();

            // DB works
            exec_sql_native("SELECT 1".into(), vec![]).unwrap();

            // Flush pending writes then close without locking
            flush_native().unwrap();
            close_native().unwrap();

            // DB closed -- SQL should fail
            assert!(exec_sql_native("SELECT 1".into(), vec![]).is_err());

            // Session still unlocked
            assert!(is_unlocked_native().unwrap());
        });
    }

    #[test]
    fn test_native_flush() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            let _dir = setup();

            allocate_session_native(0, b"pw".to_vec()).unwrap();

            exec_sql_native(
                "CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)".into(),
                vec![],
            )
            .unwrap();
            exec_sql_native(
                "INSERT INTO t VALUES (1, 'flushed')".into(),
                vec![],
            )
            .unwrap();

            // Flush should succeed
            flush_native().unwrap();
        });
    }
}
