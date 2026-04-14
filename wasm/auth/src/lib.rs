//! Authentication primitives for user key management.
//!
//! This module provides cryptographic primitives for deriving and managing user authentication keys.
//! It includes support for multiple key types: DSA signing keys, KEM (Key Encapsulation Mechanism)
//! keys, Massa blockchain keys, and secondary keys.
//!
//! # Key Derivation
//!
//! The module uses a hierarchical key derivation scheme:
//! 1. A passphrase is converted to a `StaticRootSecret` using password-based KDF
//! 2. The `StaticRootSecret` is used to deterministically derive all user keys
//! 3. A unique `UserId` is derived from the public keys
//!
//! # Authentication Blob
//!
//! The `AuthBlob` type provides single-round sender authentication for Agraphon announcements,
//! allowing a receiver to immediately verify the sender's identity without additional round trips.
//!
//! # Security
//!
//! All secret key material is protected using `zeroize` to ensure sensitive data is
//! securely erased from memory when no longer needed.

mod auth_blob;
mod types;

pub use auth_blob::AuthBlob;
pub use types::{
    STATIC_ROOT_SECRET_SIZE, StaticRootSecret, USER_ID_SIZE, UserId, UserPublicKeys,
    UserSecretKeys, derive_keys_from_static_root_secret,
};
