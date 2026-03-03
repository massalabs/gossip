/// Unified error type for all bordercrypt operations.
///
/// Error messages are deliberately generic to avoid leaking information
/// to an adversary (e.g. no distinction between "bad nonce" and "bad tag").
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum BordercryptError {
    #[error("invalid password")]
    InvalidPassword,

    #[error("read out of bounds")]
    OutOfBounds,

    #[error("unsupported version: {0}")]
    UnsupportedVersion(u32),

    #[error("corrupted block")]
    CorruptedBlock,

    #[error("invalid session index: {0}")]
    InvalidSessionIndex(u8),

    #[error("arithmetic overflow")]
    Overflow,

    #[error("storage error: {0}")]
    Storage(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Convenience alias used throughout the crate.
pub type Result<T> = core::result::Result<T, BordercryptError>;
