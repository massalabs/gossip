/// Number of independent session slots.
pub const SESSION_COUNT: usize = 5;

/// AEAD authentication tag size in bytes.
pub const AEAD_TAG_SIZE: usize = 16;

/// Application payload capacity per block after AEAD framing.
pub const PLAINTEXT_SIZE: usize =
    pq_rerand::params::SLOT_BYTES - crypto_aead::NONCE_SIZE - AEAD_TAG_SIZE;

/// Size of the u64 big-endian length header in block 0.
pub const LENGTH_HDR_SIZE: usize = 8;

/// On-disk block size (identical to pq-rerand ciphertext size).
pub const BLOCK_SIZE: usize = pq_rerand::serialize::SLOT_CT_BYTES;
