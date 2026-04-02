//! SQLite VFS implementations for secure-storage.

pub(crate) mod pending;

#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub mod encrypted_vfs;
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub mod idb_storage;
