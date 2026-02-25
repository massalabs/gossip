//! Bordercrypt v2 on-device encrypted storage.
//!
//! Spec: <https://github.com/massalabs/gossip/discussions/380>

mod constants;
mod error;
mod types;

pub use constants::{AEAD_TAG_SIZE, BLOCK_SIZE, LENGTH_HDR_SIZE, PLAINTEXT_SIZE, SESSION_COUNT};
pub use error::{BordercryptError, Result};
pub use types::SessionIndex;
