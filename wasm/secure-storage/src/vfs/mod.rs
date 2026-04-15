//! Storage backend modules for secure-storage.

pub(crate) mod file_core;
pub(crate) mod pending;

pub(crate) mod idb_state;

#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub mod idb_storage;

#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub mod sqlite_vfs;
