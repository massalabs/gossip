//! Safe RAII wrappers around the sqlite-wasm-rs C bindings.
//!
//! Concentrates every `unsafe` C call required by the SQL execution path
//! into a small set of helper methods on [`SafeDb`] and [`SafeStmt`].
//! Callers (`wasm_api`) only see plain Rust values: `Result<_, String>`,
//! borrowed slices, and owned `String` / `Vec<u8>`. Resources are released
//! deterministically via `Drop` (sqlite3_close / sqlite3_finalize).

#![cfg(all(target_arch = "wasm32", feature = "wasm"))]

use std::ffi::{c_char, c_int, CStr, CString};
use std::marker::PhantomData;
use std::ptr;

use sqlite_wasm_rs::{
    sqlite3, sqlite3_bind_blob, sqlite3_bind_double, sqlite3_bind_int64, sqlite3_bind_null,
    sqlite3_bind_text, sqlite3_close, sqlite3_column_blob, sqlite3_column_bytes,
    sqlite3_column_count, sqlite3_column_double, sqlite3_column_int64, sqlite3_column_text,
    sqlite3_column_type, sqlite3_errmsg, sqlite3_exec, sqlite3_finalize, sqlite3_last_insert_rowid,
    sqlite3_open_v2, sqlite3_prepare_v2, sqlite3_step, sqlite3_stmt, SQLITE_BLOB, SQLITE_FLOAT,
    SQLITE_INTEGER, SQLITE_NULL, SQLITE_OK, SQLITE_OPEN_CREATE, SQLITE_OPEN_READWRITE, SQLITE_TEXT,
    SQLITE_TRANSIENT,
};

// ── Errors ─────────────────────────────────────────────────────────

pub type SqlResult<T> = Result<T, String>;

/// Read the last error message from a database handle.
///
/// Soundness: only ever called from inside [`SafeDb`] (which holds a valid
/// non-null handle) or as a one-off after a failed `sqlite3_open_v2` call,
/// in which case `db` is the handle SQLite passed back via the out parameter.
fn errmsg(db: *mut sqlite3) -> String {
    if db.is_null() {
        return "(null db)".into();
    }
    // SAFETY: db is non-null per the check above; sqlite3_errmsg accepts any
    // non-null sqlite3* handle. The returned C string is owned by SQLite and
    // valid until the next API call.
    unsafe {
        let p = sqlite3_errmsg(db);
        if p.is_null() {
            "(null errmsg)".into()
        } else {
            CStr::from_ptr(p).to_string_lossy().into_owned()
        }
    }
}

// ── Column types (re-exported as Rust enum) ────────────────────────

/// Decoded SQLite column value (returned by [`SafeStmt::column`]).
pub enum SqlValue {
    Null,
    Integer(i64),
    Float(f64),
    Text(String),
    Blob(Vec<u8>),
}

// ── Database handle ────────────────────────────────────────────────

/// Owned SQLite database handle. Closes the underlying handle on drop.
pub struct SafeDb {
    handle: *mut sqlite3,
}

impl SafeDb {
    /// Open a database via the named VFS with `READWRITE | CREATE` flags.
    pub fn open(name: &CStr, vfs_name: &CStr) -> SqlResult<Self> {
        let mut handle: *mut sqlite3 = ptr::null_mut();
        // SAFETY: name and vfs_name are valid non-null C strings (CStr
        // guarantees nul-termination). `&mut handle` is a writable out
        // pointer for SQLite to populate.
        let rc = unsafe {
            sqlite3_open_v2(
                name.as_ptr(),
                &mut handle,
                SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
                vfs_name.as_ptr(),
            )
        };
        if rc != SQLITE_OK {
            let msg = if handle.is_null() {
                format!("sqlite3_open_v2 failed: rc={rc}")
            } else {
                let m = errmsg(handle);
                // SAFETY: handle was set by sqlite3_open_v2; closing it
                // releases the partially-initialized state.
                unsafe { sqlite3_close(handle) };
                m
            };
            return Err(msg);
        }
        Ok(SafeDb { handle })
    }

    /// Run one or more PRAGMA / DDL statements with no parameters and no rows.
    pub fn exec(&self, sql: &CStr) -> SqlResult<()> {
        // SAFETY: self.handle is valid (invariant of SafeDb), sql is a valid
        // C string. The callback and pArg are null because we discard rows.
        let rc = unsafe {
            sqlite3_exec(
                self.handle,
                sql.as_ptr(),
                None,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if rc != SQLITE_OK {
            return Err(errmsg(self.handle));
        }
        Ok(())
    }

    /// `sqlite3_last_insert_rowid` on this handle.
    pub fn last_insert_rowid(&self) -> i64 {
        // SAFETY: self.handle is valid (invariant of SafeDb).
        unsafe { sqlite3_last_insert_rowid(self.handle) }
    }

    /// Prepare a statement. Returns `Ok(None)` if the SQL was empty/whitespace.
    pub fn prepare<'a>(&'a self, sql: &str) -> SqlResult<Option<SafeStmt<'a>>> {
        let sql_c = CString::new(sql).map_err(|_| "sql contains nul byte".to_string())?;
        let mut stmt: *mut sqlite3_stmt = ptr::null_mut();
        // SAFETY: self.handle is valid; sql_c is valid C string of given
        // length; &mut stmt is a writable out pointer.
        let rc = unsafe {
            sqlite3_prepare_v2(
                self.handle,
                sql_c.as_ptr(),
                sql.len() as c_int,
                &mut stmt,
                ptr::null_mut(),
            )
        };
        if rc != SQLITE_OK {
            return Err(errmsg(self.handle));
        }
        if stmt.is_null() {
            return Ok(None);
        }
        Ok(Some(SafeStmt {
            handle: stmt,
            _db: PhantomData,
        }))
    }
}

impl Drop for SafeDb {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            // SAFETY: self.handle is valid (invariant of SafeDb). Drop
            // cannot propagate errors; sqlite3_close returns SQLITE_BUSY
            // only if statements are still open, which the lifetime of
            // SafeStmt prevents at compile time.
            unsafe { sqlite3_close(self.handle) };
        }
    }
}

// SAFETY: SafeDb owns the C handle and is single-threaded by construction
// (used inside a thread_local). We do not implement Send/Sync.

// ── Prepared statement ─────────────────────────────────────────────

/// Owned prepared statement, tied to its parent [`SafeDb`] by lifetime.
/// Finalizes the statement on drop.
pub struct SafeStmt<'db> {
    handle: *mut sqlite3_stmt,
    _db: PhantomData<&'db SafeDb>,
}

impl<'db> SafeStmt<'db> {
    /// `sqlite3_step` returning the raw rc (SQLITE_ROW / SQLITE_DONE / err).
    pub fn step(&self) -> c_int {
        // SAFETY: self.handle is valid (invariant of SafeStmt).
        unsafe { sqlite3_step(self.handle) }
    }

    pub fn bind_null(&self, idx: c_int) -> c_int {
        // SAFETY: self.handle is valid; sqlite3_bind_null accepts any 1-based idx.
        unsafe { sqlite3_bind_null(self.handle, idx) }
    }

    pub fn bind_int64(&self, idx: c_int, v: i64) -> c_int {
        // SAFETY: self.handle is valid.
        unsafe { sqlite3_bind_int64(self.handle, idx, v) }
    }

    pub fn bind_double(&self, idx: c_int, v: f64) -> c_int {
        // SAFETY: self.handle is valid.
        unsafe { sqlite3_bind_double(self.handle, idx, v) }
    }

    /// Bind a UTF-8 string (SQLITE_TRANSIENT — SQLite copies the buffer).
    pub fn bind_text(&self, idx: c_int, s: &str) -> c_int {
        let bytes = s.as_bytes();
        // SAFETY: self.handle is valid; bytes is a valid slice of len
        // bytes; SQLITE_TRANSIENT instructs SQLite to copy before returning.
        unsafe {
            sqlite3_bind_text(
                self.handle,
                idx,
                bytes.as_ptr() as *const c_char,
                bytes.len() as c_int,
                SQLITE_TRANSIENT(),
            )
        }
    }

    /// Bind a blob (SQLITE_TRANSIENT — SQLite copies the buffer).
    pub fn bind_blob(&self, idx: c_int, b: &[u8]) -> c_int {
        // SAFETY: self.handle is valid; b is a valid slice of len bytes;
        // SQLITE_TRANSIENT instructs SQLite to copy before returning.
        unsafe {
            sqlite3_bind_blob(
                self.handle,
                idx,
                b.as_ptr() as *const core::ffi::c_void,
                b.len() as c_int,
                SQLITE_TRANSIENT(),
            )
        }
    }

    pub fn column_count(&self) -> c_int {
        // SAFETY: self.handle is valid.
        unsafe { sqlite3_column_count(self.handle) }
    }

    /// Read column `col` and decode it into a Rust [`SqlValue`].
    pub fn column(&self, col: c_int) -> SqlValue {
        // SAFETY: self.handle is valid; sqlite3_column_type accepts any
        // 0-based col index (returns SQLITE_NULL if out of bounds).
        let ty = unsafe { sqlite3_column_type(self.handle, col) };
        match ty {
            SQLITE_INTEGER => {
                // SAFETY: same.
                let v = unsafe { sqlite3_column_int64(self.handle, col) };
                SqlValue::Integer(v)
            }
            SQLITE_FLOAT => {
                // SAFETY: same.
                let v = unsafe { sqlite3_column_double(self.handle, col) };
                SqlValue::Float(v)
            }
            SQLITE_TEXT => {
                // SAFETY: ptr/len are owned by SQLite and valid until the
                // next sqlite3_step / sqlite3_finalize on this stmt.
                unsafe {
                    let ptr = sqlite3_column_text(self.handle, col);
                    let len = sqlite3_column_bytes(self.handle, col) as usize;
                    if ptr.is_null() {
                        SqlValue::Null
                    } else {
                        let slice = core::slice::from_raw_parts(ptr, len);
                        SqlValue::Text(String::from_utf8_lossy(slice).into_owned())
                    }
                }
            }
            SQLITE_BLOB => {
                // SAFETY: same as SQLITE_TEXT branch.
                unsafe {
                    let ptr = sqlite3_column_blob(self.handle, col) as *const u8;
                    let len = sqlite3_column_bytes(self.handle, col) as usize;
                    if ptr.is_null() || len == 0 {
                        SqlValue::Blob(Vec::new())
                    } else {
                        let slice = core::slice::from_raw_parts(ptr, len);
                        SqlValue::Blob(slice.to_vec())
                    }
                }
            }
            SQLITE_NULL => SqlValue::Null,
            _ => SqlValue::Null,
        }
    }
}

impl<'db> Drop for SafeStmt<'db> {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            // SAFETY: self.handle is valid (invariant of SafeStmt).
            unsafe { sqlite3_finalize(self.handle) };
        }
    }
}

// ── Step result helpers (re-exported constants for callers) ────────

pub use sqlite_wasm_rs::SQLITE_DONE as DONE;
pub use sqlite_wasm_rs::SQLITE_OK as OK;
pub use sqlite_wasm_rs::SQLITE_ROW as ROW;
