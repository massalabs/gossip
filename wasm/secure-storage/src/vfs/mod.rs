//! SQLite VFS implementations for secure-storage.

#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub mod encrypted_vfs;
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub mod opfs_wal_storage;

#[cfg(feature = "native")]
pub mod fs_wal_storage;
#[cfg(feature = "native")]
pub mod native_vfs;
