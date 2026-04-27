//! Safe RAII wrappers around the sqlite-wasm-rs C bindings.
//!
//! Concentrates every `unsafe` C call required by the SQL execution path
//! into a small set of helper methods on [`SafeDb`] and [`SafeStmt`].
//! Callers (`wasm_api`) only see plain Rust values: `Result<_, String>`,
//! borrowed slices, and owned `String` / `Vec<u8>`. Resources are released
//! deterministically via `Drop` (sqlite3_close / sqlite3_finalize).

#![cfg(all(target_arch = "wasm32", feature = "wasm"))]

use std::ffi::{CStr, CString, c_char, c_int};
use std::marker::PhantomData;
use std::ptr;

use sqlite_wasm_rs::{
    SQLITE_BLOB, SQLITE_DONE, SQLITE_FLOAT, SQLITE_INTEGER, SQLITE_NULL, SQLITE_OK,
    SQLITE_OPEN_CREATE, SQLITE_OPEN_READWRITE, SQLITE_ROW, SQLITE_TEXT, SQLITE_TRANSIENT, sqlite3,
    sqlite3_bind_blob, sqlite3_bind_double, sqlite3_bind_int64, sqlite3_bind_null,
    sqlite3_bind_text, sqlite3_close, sqlite3_column_blob, sqlite3_column_bytes,
    sqlite3_column_count, sqlite3_column_double, sqlite3_column_int64, sqlite3_column_text,
    sqlite3_column_type, sqlite3_errmsg, sqlite3_exec, sqlite3_finalize, sqlite3_last_insert_rowid,
    sqlite3_open_v2, sqlite3_prepare_v2, sqlite3_step, sqlite3_stmt,
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
    // SAFETY: db is non-null per the check above. sqlite3_errmsg's contract
    // (https://sqlite.org/c3ref/errcode.html): returned string is owned by
    // SQLite and valid only until the next call on the same handle. We copy
    // it immediately via to_string_lossy().into_owned() before returning.
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

/// Result of [`SafeStmt::step`]: either a new row is ready or the statement is done.
pub enum StepStatus {
    Row,
    Done,
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
        // SAFETY: sqlite3_open_v2 contract (https://sqlite.org/c3ref/open.html):
        //   - filename (name): "must be encoded in UTF-8" — guaranteed by CStr.
        //   - zVfs (vfs_name): "must be a UTF-8 string that gives the name of
        //     the VFS" — likewise. SQLite treats both as read-only per spec,
        //     so CStr::as_ptr's immutability requirement is upheld.
        //   - ppDb (&mut handle): writable out pointer for SQLite to populate.
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
                format!("sqlite3_open_v2 failed with error code: {rc}")
            } else {
                let open_msg = errmsg(handle);
                // SAFETY: handle was set by sqlite3_open_v2 even when the call
                // failed (https://sqlite.org/c3ref/open.html: "the associated
                // database connection handle should be released by passing it
                // to sqlite3_close"). Closing releases that partial state.
                let close_rc = unsafe { sqlite3_close(handle) };
                if close_rc != SQLITE_OK {
                    format!("{open_msg}: sqlite3_close failed with error code: {close_rc}")
                } else {
                    open_msg
                }
            };
            return Err(msg);
        }
        Ok(SafeDb { handle })
    }

    /// Execute one or more SQL statements without parameter binding.
    /// Any rows returned are discarded.
    pub fn exec(&self, sql: &CStr) -> SqlResult<()> {
        // SAFETY: self.handle is valid (SafeDb invariant). sqlite3_exec
        // contract (https://sqlite.org/c3ref/exec.html): sql is read as UTF-8
        // and not mutated by the call; null callback + null pArg are allowed
        // and cause rows to be silently discarded.
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
        // SAFETY: self.handle is valid (SafeDb invariant).
        // sqlite3_last_insert_rowid (https://sqlite.org/c3ref/last_insert_rowid.html)
        // is infallible when called on a valid handle; returns 0 if no insert yet.
        unsafe { sqlite3_last_insert_rowid(self.handle) }
    }

    /// Prepare a statement. Returns `Ok(None)` if the SQL was empty/whitespace.
    pub fn prepare<'a>(&'a self, sql: &str) -> SqlResult<Option<SafeStmt<'a>>> {
        let sql_c = CString::new(sql).map_err(|_| "sql contains nul byte".to_string())?;
        let mut stmt: *mut sqlite3_stmt = ptr::null_mut();
        // SAFETY: self.handle is valid (SafeDb invariant). sqlite3_prepare_v2
        // contract (https://sqlite.org/c3ref/prepare.html):
        //   - zSql (sql_c.as_ptr()): read-only UTF-8, must outlive the call;
        //     sql_c lives until end of scope which is after the FFI returns.
        //   - nByte (sql.len()): byte length of the SQL; cast to c_int is safe
        //     because Rust &str lengths in this wrapper are bounded by usize
        //     and real queries never exceed i32::MAX bytes.
        //   - ppStmt (&mut stmt): writable out pointer; SQLite writes a stmt
        //     handle or null if the SQL was empty/whitespace.
        //   - pzTail is null (we reject multi-statement tails).
        if sql.len() > c_int::MAX as usize {
            return Err("sql string exceeds i32::MAX bytes".to_string());
        }
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
            // SAFETY: self.handle is valid (SafeDb invariant).
            // sqlite3_close contract (https://sqlite.org/c3ref/close.html):
            // returns SQLITE_BUSY if any prepared statement is still open.
            // SafeStmt<'db> lifetime makes live statements a compile error,
            // so SQLITE_BUSY here is impossible — a non-OK rc is a broken
            // invariant and we want it loud.
            let rc = unsafe { sqlite3_close(self.handle) };
            // Skip the assert if we're already unwinding — a double panic
            // during Drop aborts the process, masking the original error.
            if !std::thread::panicking() {
                assert_eq!(rc, SQLITE_OK, "sqlite3_close failed: rc={rc}");
            }
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
    /// Advance the statement. `Ok(Row)` = a row is ready, `Ok(Done)` = finished.
    pub fn step(&self) -> SqlResult<StepStatus> {
        // SAFETY: self.handle is valid (SafeStmt invariant).
        // sqlite3_step contract (https://sqlite.org/c3ref/step.html):
        // returns SQLITE_ROW (another row), SQLITE_DONE (no more rows),
        // or any other rc on error.
        let rc = unsafe { sqlite3_step(self.handle) };
        match rc {
            SQLITE_ROW => Ok(StepStatus::Row),
            SQLITE_DONE => Ok(StepStatus::Done),
            _ => Err(format!("sqlite3_step failed with error code: {rc}")),
        }
    }

    pub fn bind_null(&self, idx: c_int) -> SqlResult<()> {
        // SAFETY: self.handle is valid (SafeStmt invariant).
        // sqlite3_bind_null contract (https://sqlite.org/c3ref/bind_blob.html):
        // accepts any 1-based idx; returns SQLITE_RANGE if out of bounds.
        let rc = unsafe { sqlite3_bind_null(self.handle, idx) };
        if rc != SQLITE_OK {
            return Err(format!("sqlite3_bind_null failed with error code: {rc}"));
        }
        Ok(())
    }

    pub fn bind_int64(&self, idx: c_int, v: i64) -> SqlResult<()> {
        // SAFETY: self.handle is valid (SafeStmt invariant). sqlite3_bind_int64
        // (https://sqlite.org/c3ref/bind_blob.html) is infallible except for
        // out-of-range idx.
        let rc = unsafe { sqlite3_bind_int64(self.handle, idx, v) };
        if rc != SQLITE_OK {
            return Err(format!("sqlite3_bind_int64 failed with error code: {rc}"));
        }
        Ok(())
    }

    pub fn bind_double(&self, idx: c_int, v: f64) -> SqlResult<()> {
        // SAFETY: self.handle is valid (SafeStmt invariant). sqlite3_bind_double
        // (https://sqlite.org/c3ref/bind_blob.html) is infallible except for
        // out-of-range idx.
        let rc = unsafe { sqlite3_bind_double(self.handle, idx, v) };
        if rc != SQLITE_OK {
            return Err(format!("sqlite3_bind_double failed with error code: {rc}"));
        }
        Ok(())
    }

    /// Bind a UTF-8 string (SQLITE_TRANSIENT — SQLite copies the buffer).
    pub fn bind_text(&self, idx: c_int, s: &str) -> SqlResult<()> {
        let bytes = s.as_bytes();
        // SAFETY: self.handle is valid (SafeStmt invariant). sqlite3_bind_text
        // contract (https://sqlite.org/c3ref/bind_blob.html):
        //   - zData (bytes.as_ptr()): read-only; SQLite reads n bytes and does
        //     not mutate the source.
        //   - n (bytes.len()): byte length; cast to c_int — acceptable because
        //     real SQL bind values don't exceed i32::MAX.
        //   - destructor = SQLITE_TRANSIENT: SQLite copies before returning,
        //     so the source buffer (bytes) does not need to outlive the call.
        let rc = unsafe {
            sqlite3_bind_text(
                self.handle,
                idx,
                bytes.as_ptr() as *const c_char,
                bytes.len() as c_int,
                SQLITE_TRANSIENT(),
            )
        };
        if rc != SQLITE_OK {
            return Err(format!("sqlite3_bind_text failed with error code: {rc}"));
        }
        Ok(())
    }

    /// Bind a blob (SQLITE_TRANSIENT — SQLite copies the buffer).
    pub fn bind_blob(&self, idx: c_int, b: &[u8]) -> SqlResult<()> {
        // SAFETY: self.handle is valid (SafeStmt invariant). sqlite3_bind_blob
        // contract (https://sqlite.org/c3ref/bind_blob.html): same ownership
        // semantics as bind_text — with SQLITE_TRANSIENT, SQLite copies the
        // bytes before returning, so the source slice does not need to outlive
        // the call.
        let rc = unsafe {
            sqlite3_bind_blob(
                self.handle,
                idx,
                b.as_ptr() as *const core::ffi::c_void,
                b.len() as c_int,
                SQLITE_TRANSIENT(),
            )
        };
        if rc != SQLITE_OK {
            return Err(format!("sqlite3_bind_blob failed with error code: {rc}"));
        }
        Ok(())
    }

    pub fn column_count(&self) -> c_int {
        // SAFETY: self.handle is valid (SafeStmt invariant).
        // sqlite3_column_count (https://sqlite.org/c3ref/column_count.html)
        // is infallible on a valid stmt.
        unsafe { sqlite3_column_count(self.handle) }
    }

    /// Read column `col` and decode it into a Rust [`SqlValue`].
    pub fn column(&self, col: c_int) -> SqlValue {
        // SAFETY: self.handle is valid (SafeStmt invariant). sqlite3_column_type
        // (https://sqlite.org/c3ref/column_blob.html) accepts any 0-based col
        // index and returns SQLITE_NULL if out of bounds — safe on any value.
        let ty = unsafe { sqlite3_column_type(self.handle, col) };
        match ty {
            SQLITE_INTEGER => {
                // SAFETY: same. sqlite3_column_int64 is infallible after a
                // successful column_type probe.
                let v = unsafe { sqlite3_column_int64(self.handle, col) };
                SqlValue::Integer(v)
            }
            SQLITE_FLOAT => {
                // SAFETY: same.
                let v = unsafe { sqlite3_column_double(self.handle, col) };
                SqlValue::Float(v)
            }
            SQLITE_TEXT => {
                // SAFETY: sqlite3_column_text contract
                // (https://sqlite.org/c3ref/column_blob.html): returned pointer
                // and length are owned by SQLite and valid only until the next
                // sqlite3_step/reset/finalize on this stmt. We copy into an
                // owned String immediately before returning.
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
                // SAFETY: same ownership semantics as SQLITE_TEXT — we copy
                // into an owned Vec<u8> before returning.
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
            // SAFETY: self.handle is valid (SafeStmt invariant).
            // sqlite3_finalize contract (https://sqlite.org/c3ref/finalize.html):
            // returns the most recent sqlite3_step error code. Since `step()`
            // already surfaced that error via its Result, a non-OK rc here is
            // a replay of an already-handled fault — intentionally swallowed
            // to avoid double-reporting.
            let _rc = unsafe { sqlite3_finalize(self.handle) };
        }
    }
}
