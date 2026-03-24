//! SQLite database operations.
//!
//! Opens a database on a registered VFS, executes parameterised SQL,
//! and returns results as Rust types.

use std::cell::RefCell;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};

use sqlite_wasm_rs::*;

use crate::BordercryptError;

thread_local! {
    static DB: RefCell<Option<*mut sqlite3>> = const { RefCell::new(None) };
}

// ── Public types ─────────────────────────────────────────────────────

/// SQL bind / result value.
#[derive(Debug, Clone)]
pub enum SqlValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

/// Result of a single SQL statement execution.
#[derive(Debug)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<SqlValue>>,
    pub last_insert_rowid: i64,
    pub changes: i32,
}

// ── Public API ───────────────────────────────────────────────────────

/// Open a SQLite database on the given VFS and run default PRAGMAs.
pub fn open(vfs_name: &str) -> Result<(), BordercryptError> {
    // Use a unique name per open to avoid SQLite's internal file cache
    // after close/reopen cycles. The VFS handles all persistence.
    static OPEN_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = OPEN_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let c_name = CString::new(format!("bordercrypt_{n}.db"))
        .map_err(|e| BordercryptError::Sqlite(e.to_string()))?;
    let c_vfs = CString::new(vfs_name).map_err(|e| BordercryptError::Sqlite(e.to_string()))?;

    let mut db: *mut sqlite3 = std::ptr::null_mut();
    let rc = unsafe {
        sqlite3_open_v2(
            c_name.as_ptr(),
            &mut db,
            (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) as c_int,
            c_vfs.as_ptr(),
        )
    };

    if rc != SQLITE_OK as c_int {
        let msg = unsafe { errmsg(db) };
        if !db.is_null() {
            unsafe { sqlite3_close(db) };
        }
        return Err(BordercryptError::Sqlite(msg));
    }

    exec_pragma(db, "PRAGMA page_size = 8192")?;
    exec_pragma(db, "PRAGMA journal_mode = MEMORY")?;
    // OFF: no xSync calls from SQLite. Persistence is handled by a
    // periodic flush timer in the worker (every 2s) plus explicit
    // flushes on lock and visibility-change. This avoids the cost
    // of a full 5-session IDB snapshot on every COMMIT.
    exec_pragma(db, "PRAGMA synchronous = OFF")?;
    exec_pragma(db, "PRAGMA cache_size = -8000")?;
    exec_pragma(db, "PRAGMA locking_mode = EXCLUSIVE")?;
    exec_pragma(db, "PRAGMA trusted_schema = OFF")?;

    DB.with(|cell| *cell.borrow_mut() = Some(db));
    Ok(())
}

/// Execute a SQL statement with bind parameters.
pub fn execute(sql: &str, params: &[SqlValue]) -> Result<QueryResult, BordercryptError> {
    DB.with(|cell| {
        let borrow = cell.borrow();
        match *borrow {
            Some(db) => execute_on(db, sql, params),
            None => Err(BordercryptError::Sqlite("database not open".into())),
        }
    })
}

/// Close the database. No-op if already closed.
pub fn close() -> Result<(), BordercryptError> {
    DB.with(|cell| {
        if let Some(db) = cell.borrow_mut().take() {
            let rc = unsafe { sqlite3_close(db) };
            if rc != SQLITE_OK as c_int {
                return Err(BordercryptError::Sqlite(format!("close failed: {rc}")));
            }
        }
        Ok(())
    })
}

// ── Internal ─────────────────────────────────────────────────────────

fn execute_on(
    db: *mut sqlite3,
    sql: &str,
    params: &[SqlValue],
) -> Result<QueryResult, BordercryptError> {
    let c_sql = CString::new(sql).map_err(|e| BordercryptError::Sqlite(e.to_string()))?;
    let mut stmt: *mut sqlite3_stmt = std::ptr::null_mut();
    let mut tail: *const c_char = std::ptr::null();

    let rc =
        unsafe { sqlite3_prepare_v2(db, c_sql.as_ptr(), -1, &mut stmt, &mut tail) };
    if rc != SQLITE_OK as c_int {
        return Err(BordercryptError::Sqlite(unsafe { errmsg(db) }));
    }

    // Bind — keep CStrings alive until finalize.
    let mut _text_keep: Vec<CString> = Vec::new();
    for (i, param) in params.iter().enumerate() {
        let idx = (i + 1) as c_int;
        let rc = unsafe {
            match param {
                SqlValue::Null => sqlite3_bind_null(stmt, idx),
                SqlValue::Integer(v) => sqlite3_bind_int64(stmt, idx, *v),
                SqlValue::Real(v) => sqlite3_bind_double(stmt, idx, *v),
                SqlValue::Text(s) => {
                    let cs =
                        CString::new(s.as_str()).map_err(|e| BordercryptError::Sqlite(e.to_string()))?;
                    let r = sqlite3_bind_text(stmt, idx, cs.as_ptr(), -1, SQLITE_TRANSIENT());
                    _text_keep.push(cs);
                    r
                }
                SqlValue::Blob(b) => sqlite3_bind_blob(
                    stmt,
                    idx,
                    b.as_ptr() as *const c_void,
                    b.len() as c_int,
                    SQLITE_TRANSIENT(),
                ),
            }
        };
        if rc != SQLITE_OK as c_int {
            unsafe { sqlite3_finalize(stmt) };
            return Err(BordercryptError::Sqlite(unsafe { errmsg(db) }));
        }
    }

    // Column names.
    let col_count = unsafe { sqlite3_column_count(stmt) };
    let columns: Vec<String> = (0..col_count)
        .map(|i| unsafe {
            let p = sqlite3_column_name(stmt, i);
            if p.is_null() {
                String::new()
            } else {
                CStr::from_ptr(p).to_string_lossy().into_owned()
            }
        })
        .collect();

    // Step through rows.
    let mut rows = Vec::new();
    loop {
        let rc = unsafe { sqlite3_step(stmt) };
        if rc == SQLITE_ROW as c_int {
            let row: Vec<SqlValue> = (0..col_count).map(|i| unsafe { read_col(stmt, i) }).collect();
            rows.push(row);
        } else if rc == SQLITE_DONE as c_int {
            break;
        } else {
            let msg = unsafe { errmsg(db) };
            unsafe { sqlite3_finalize(stmt) };
            return Err(BordercryptError::Sqlite(msg));
        }
    }

    let last_insert_rowid = unsafe { sqlite3_last_insert_rowid(db) };
    let changes = unsafe { sqlite3_changes(db) };
    unsafe { sqlite3_finalize(stmt) };

    Ok(QueryResult {
        columns,
        rows,
        last_insert_rowid,
        changes,
    })
}

unsafe fn read_col(stmt: *mut sqlite3_stmt, idx: c_int) -> SqlValue {
    unsafe {
        let col_type = sqlite3_column_type(stmt, idx);
        if col_type == SQLITE_NULL as c_int {
            SqlValue::Null
        } else if col_type == SQLITE_INTEGER as c_int {
            SqlValue::Integer(sqlite3_column_int64(stmt, idx))
        } else if col_type == SQLITE_FLOAT as c_int {
            SqlValue::Real(sqlite3_column_double(stmt, idx))
        } else if col_type == SQLITE_TEXT as c_int || col_type == SQLITE3_TEXT as c_int {
            let p = sqlite3_column_text(stmt, idx);
            if p.is_null() {
                SqlValue::Null
            } else {
                SqlValue::Text(
                    CStr::from_ptr(p as *const c_char)
                        .to_string_lossy()
                        .into_owned(),
                )
            }
        } else if col_type == SQLITE_BLOB as c_int {
            let p = sqlite3_column_blob(stmt, idx);
            let len = sqlite3_column_bytes(stmt, idx) as usize;
            if p.is_null() || len == 0 {
                SqlValue::Blob(Vec::new())
            } else {
                SqlValue::Blob(std::slice::from_raw_parts(p as *const u8, len).to_vec())
            }
        } else {
            SqlValue::Null
        }
    }
}

fn exec_pragma(db: *mut sqlite3, sql: &str) -> Result<(), BordercryptError> {
    let c = CString::new(sql).map_err(|e| BordercryptError::Sqlite(e.to_string()))?;
    let rc = unsafe { sqlite3_exec(db, c.as_ptr(), None, std::ptr::null_mut(), std::ptr::null_mut()) };
    if rc != SQLITE_OK as c_int {
        return Err(BordercryptError::Sqlite(unsafe { errmsg(db) }));
    }
    Ok(())
}

unsafe fn errmsg(db: *mut sqlite3) -> String {
    unsafe {
        if db.is_null() {
            return "unknown error".into();
        }
        let p = sqlite3_errmsg(db);
        if p.is_null() {
            "unknown error".into()
        } else {
            CStr::from_ptr(p).to_string_lossy().into_owned()
        }
    }
}
