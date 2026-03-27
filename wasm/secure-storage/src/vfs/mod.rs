//! SQLite VFS implementations for secure-storage.

#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub mod encrypted_vfs;
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub mod opfs_wal_storage;
