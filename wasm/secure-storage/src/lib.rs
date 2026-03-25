//! SecureStorage v2 on-device encrypted storage.
//!
//! Spec: <https://github.com/massalabs/gossip/discussions/380>

mod block;
pub mod constants;
mod domain;
mod error;
mod kdf;
mod keypair;
mod lifecycle;
mod pq;
mod read;
pub mod storage;
mod types;
mod unlock;
pub mod wal;
mod write;

#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub(crate) mod vfs;
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub(crate) mod db;
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
mod wasm_api;

#[cfg(feature = "native")]
uniffi::setup_scaffolding!();

#[cfg(feature = "native")]
mod native_api;

pub use block::{create_cover_block, decrypt_block, encrypt_block, rerandomize_block};
pub use constants::{
    AEAD_TAG_SIZE, BLOCK_SIZE, LENGTH_HDR_SIZE, PLAINTEXT_SIZE, ROOT_BLOCK_KEY_SIZE, SESSION_COUNT,
};
pub use domain::{
    block_aead_aad, block_aead_key_label, block_kdf_salt, block_scope, password_kdf_salt, root,
    root_aead_key_label, root_kdf_salt, session_scope, sk_wrap_aad, sk_wrap_key_label,
};
pub use error::{SecureStorageError, Result};
pub use kdf::{SessionKeys, derive_block_aead_key, derive_session_keys};
pub use keypair::{KeypairFile, read_session_keypair, read_session_version_and_pk};
pub use lifecycle::{allocate_session, cover_traffic_tick, provision_storage};
pub use pq::{
    PQ_CT_SIZE, PQ_MSG_SIZE, PqPublicKey, PqSecretKey, pq_decrypt, pq_encrypt, pq_keygen, pq_rerand,
};
pub use read::{decrypt_session_data_block, read_session_data, read_total_length};
pub use types::SessionIndex;
pub use unlock::{UnlockedSession, unlock_session};
pub use write::{
    encrypt_session_data_block, ensure_block_count, get_global_block_count,
    repair_blockstream_lengths, shrink_session_data, write_session_data,
};

/// Run a test closure on a thread with a 4 MiB stack.
///
/// PQ (ML-KEM) operations use large stack allocations that can overflow
/// the default Rust test thread stack (~2 MiB on macOS).
#[cfg(test)]
pub(crate) fn run_with_stack<F: FnOnce() + Send + 'static>(f: F) {
    std::thread::Builder::new()
        .stack_size(4 * 1024 * 1024)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap();
}
