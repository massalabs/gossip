//! Bordercrypt v2 on-device encrypted storage.
//!
//! Spec: <https://github.com/massalabs/gossip/discussions/380>

mod block;
mod constants;
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
mod write;

pub use block::{create_cover_block, decrypt_block, encrypt_block, rerandomize_block};
pub use constants::{AEAD_TAG_SIZE, BLOCK_SIZE, LENGTH_HDR_SIZE, PLAINTEXT_SIZE, SESSION_COUNT};
pub use domain::{
    block_aead_aad, block_aead_key_label, block_kdf_salt, block_scope, password_kdf_salt, root,
    root_aead_key_label, root_kdf_salt, session_scope, sk_wrap_aad, sk_wrap_key_label,
};
pub use error::{BordercryptError, Result};
pub use kdf::derive_block_aead_key;
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
    repair_blockstream_lengths, write_session_data,
};
