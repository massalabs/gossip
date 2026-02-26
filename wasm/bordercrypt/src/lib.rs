//! Bordercrypt v2 on-device encrypted storage.
//!
//! Spec: <https://github.com/massalabs/gossip/discussions/380>

mod constants;
mod domain;
mod error;
pub mod storage;
mod types;

pub use constants::{AEAD_TAG_SIZE, BLOCK_SIZE, LENGTH_HDR_SIZE, PLAINTEXT_SIZE, SESSION_COUNT};
pub use domain::{
    block_aead_aad, block_aead_key_label, block_kdf_salt, block_scope, password_kdf_salt, root,
    root_aead_key_label, root_kdf_salt, session_scope, sk_wrap_aad, sk_wrap_key_label,
};
pub use error::{BordercryptError, Result};
pub use types::SessionIndex;
