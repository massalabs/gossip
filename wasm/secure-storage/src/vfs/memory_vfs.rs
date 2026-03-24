//! In-memory VFS for testing and development.
//!
//! All file data lives in thread-local storage. No persistence.
//! Used for unit tests and as a template for `IdbVfs` / `OpfsVfs`.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::mem::size_of;
use std::os::raw::{c_char, c_int, c_void};
use std::sync::OnceLock;

use sqlite_wasm_rs::{
    sqlite3_file, sqlite3_io_methods, sqlite3_vfs, sqlite3_vfs_find, sqlite3_vfs_register,
    SQLITE_IOERR_SHORT_READ, SQLITE_NOTFOUND, SQLITE_OK, SQLITE_OPEN_CREATE,
};

/// VFS name used for registration with SQLite.
pub const VFS_NAME: &str = "bordercrypt-mem";

thread_local! {
    static NEXT_ID: Cell<u32> = const { Cell::new(0) };
    static NAMES: RefCell<HashMap<u32, String>> = RefCell::new(HashMap::new());
    static DATA: RefCell<HashMap<String, Vec<u8>>> = RefCell::new(HashMap::new());
}

/// Our file handle, extending `sqlite3_file` with an ID for name lookup.
#[repr(C)]
struct MemFile {
    base: sqlite3_file,
    id: u32,
}

/// Resolve the filename for a file handle.
fn file_name(file: *const MemFile) -> String {
    let id = unsafe { (*file).id };
    NAMES.with(|n| n.borrow().get(&id).cloned().unwrap_or_default())
}

static IO: OnceLock<sqlite3_io_methods> = OnceLock::new();

fn io_methods() -> &'static sqlite3_io_methods {
    IO.get_or_init(|| sqlite3_io_methods {
        iVersion: 1,
        xClose: Some(x_close),
        xRead: Some(x_read),
        xWrite: Some(x_write),
        xTruncate: Some(x_truncate),
        xSync: Some(x_sync),
        xFileSize: Some(x_file_size),
        xLock: Some(x_lock),
        xUnlock: Some(x_unlock),
        xCheckReservedLock: Some(x_check_reserved_lock),
        xFileControl: Some(x_file_control),
        xSectorSize: Some(x_sector_size),
        xDeviceCharacteristics: Some(x_device_characteristics),
        xShmMap: None,
        xShmLock: None,
        xShmBarrier: None,
        xShmUnmap: None,
        xFetch: None,
        xUnfetch: None,
    })
}

/// Register the in-memory VFS with SQLite (non-default).
pub fn register() {
    unsafe {
        let default = sqlite3_vfs_find(std::ptr::null());
        assert!(!default.is_null(), "default VFS not found");

        let mut vfs = *default;
        let name = CString::new(VFS_NAME).unwrap();
        vfs.zName = name.into_raw();
        vfs.szOsFile = size_of::<MemFile>() as c_int;
        vfs.xOpen = Some(x_open);
        vfs.xDelete = Some(x_delete);
        vfs.xAccess = Some(x_access);
        vfs.xFullPathname = Some(x_full_pathname);

        let ptr = Box::into_raw(Box::new(vfs));
        let rc = sqlite3_vfs_register(ptr, 0);
        assert_eq!(rc, SQLITE_OK as c_int, "VFS registration failed");
    }
}

/// Reset all in-memory file data.
#[cfg(test)]
pub fn clear() {
    DATA.with(|d| d.borrow_mut().clear());
    NAMES.with(|n| n.borrow_mut().clear());
}

// ── VFS-level callbacks ──────────────────────────────────────────────

unsafe extern "C" fn x_open(
    _vfs: *mut sqlite3_vfs,
    z_name: *const c_char,
    file: *mut sqlite3_file,
    flags: c_int,
    out_flags: *mut c_int,
) -> c_int {
    unsafe {
        let name = if z_name.is_null() {
            format!("__anon_{}", NEXT_ID.with(|id| id.get()))
        } else {
            CStr::from_ptr(z_name).to_string_lossy().into_owned()
        };

        let id = NEXT_ID.with(|next| {
            let v = next.get();
            next.set(v + 1);
            v
        });
        NAMES.with(|n| n.borrow_mut().insert(id, name.clone()));

        if flags & SQLITE_OPEN_CREATE as c_int != 0 {
            DATA.with(|d| {
                d.borrow_mut().entry(name).or_default();
            });
        }

        let mem = &mut *(file as *mut MemFile);
        mem.base.pMethods = io_methods();
        mem.id = id;

        if !out_flags.is_null() {
            *out_flags = flags;
        }
        SQLITE_OK as c_int
    }
}

unsafe extern "C" fn x_delete(
    _vfs: *mut sqlite3_vfs,
    z_name: *const c_char,
    _sync_dir: c_int,
) -> c_int {
    unsafe {
        if !z_name.is_null() {
            let name = CStr::from_ptr(z_name).to_string_lossy().into_owned();
            DATA.with(|d| d.borrow_mut().remove(&name));
        }
        SQLITE_OK as c_int
    }
}

unsafe extern "C" fn x_access(
    _vfs: *mut sqlite3_vfs,
    z_name: *const c_char,
    _flags: c_int,
    result: *mut c_int,
) -> c_int {
    unsafe {
        if z_name.is_null() {
            *result = 0;
        } else {
            let name = CStr::from_ptr(z_name).to_string_lossy().into_owned();
            *result = DATA.with(|d| if d.borrow().contains_key(&name) { 1 } else { 0 });
        }
        SQLITE_OK as c_int
    }
}

unsafe extern "C" fn x_full_pathname(
    _vfs: *mut sqlite3_vfs,
    z_name: *const c_char,
    n_out: c_int,
    z_out: *mut c_char,
) -> c_int {
    unsafe {
        if !z_name.is_null() {
            let bytes = CStr::from_ptr(z_name).to_bytes_with_nul();
            let len = bytes.len().min(n_out as usize);
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), z_out as *mut u8, len);
        }
        SQLITE_OK as c_int
    }
}

// ── File-level callbacks ─────────────────────────────────────────────

unsafe extern "C" fn x_close(file: *mut sqlite3_file) -> c_int {
    unsafe {
        let id = (*(file as *const MemFile)).id;
        NAMES.with(|n| n.borrow_mut().remove(&id));
        SQLITE_OK as c_int
    }
}

unsafe extern "C" fn x_read(
    file: *mut sqlite3_file,
    buf: *mut c_void,
    amt: c_int,
    offset: i64,
) -> c_int {
    unsafe {
        let name = file_name(file as *const MemFile);
        let off = offset as usize;
        let n = amt as usize;
        let dst = std::slice::from_raw_parts_mut(buf as *mut u8, n);

        DATA.with(|d| {
            let data = d.borrow();
            match data.get(&name) {
                Some(file_data) if off + n <= file_data.len() => {
                    dst.copy_from_slice(&file_data[off..off + n]);
                    SQLITE_OK as c_int
                }
                Some(file_data) if off < file_data.len() => {
                    let avail = file_data.len() - off;
                    dst[..avail].copy_from_slice(&file_data[off..]);
                    dst[avail..].fill(0);
                    SQLITE_IOERR_SHORT_READ as c_int
                }
                _ => {
                    dst.fill(0);
                    SQLITE_IOERR_SHORT_READ as c_int
                }
            }
        })
    }
}

unsafe extern "C" fn x_write(
    file: *mut sqlite3_file,
    buf: *const c_void,
    amt: c_int,
    offset: i64,
) -> c_int {
    unsafe {
        let name = file_name(file as *const MemFile);
        let off = offset as usize;
        let n = amt as usize;
        let src = std::slice::from_raw_parts(buf as *const u8, n);

        DATA.with(|d| {
            let mut data = d.borrow_mut();
            let file_data = data.entry(name).or_default();
            if off + n > file_data.len() {
                file_data.resize(off + n, 0);
            }
            file_data[off..off + n].copy_from_slice(src);
            SQLITE_OK as c_int
        })
    }
}

unsafe extern "C" fn x_truncate(file: *mut sqlite3_file, size: i64) -> c_int {
    let name = file_name(file as *const MemFile);
    DATA.with(|d| {
        if let Some(v) = d.borrow_mut().get_mut(&name) {
            v.truncate(size as usize);
        }
    });
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_sync(_file: *mut sqlite3_file, _flags: c_int) -> c_int {
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_file_size(file: *mut sqlite3_file, size: *mut i64) -> c_int {
    let name = file_name(file as *const MemFile);
    unsafe {
        *size = DATA.with(|d| d.borrow().get(&name).map_or(0, |v| v.len() as i64));
    }
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_lock(_file: *mut sqlite3_file, _lock: c_int) -> c_int {
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_unlock(_file: *mut sqlite3_file, _lock: c_int) -> c_int {
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_check_reserved_lock(
    _file: *mut sqlite3_file,
    result: *mut c_int,
) -> c_int {
    unsafe { *result = 0 };
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_file_control(
    _file: *mut sqlite3_file,
    _op: c_int,
    _arg: *mut c_void,
) -> c_int {
    SQLITE_NOTFOUND as c_int
}

unsafe extern "C" fn x_sector_size(_file: *mut sqlite3_file) -> c_int {
    4096
}

unsafe extern "C" fn x_device_characteristics(_file: *mut sqlite3_file) -> c_int {
    0
}
