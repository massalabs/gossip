/// Unified error type for all secureStorage operations.
///
/// Error messages are deliberately generic to avoid leaking information
/// to an adversary (e.g. no distinction between "bad nonce" and "bad tag").
#[derive(Debug, thiserror::Error)]
#[cfg_attr(feature = "native", derive(uniffi::Error))]
#[cfg_attr(feature = "native", uniffi(flat_error))]
#[non_exhaustive]
pub enum SecureStorageError {
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

    #[error("sqlite error: {0}")]
    Sqlite(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("lock poisoned")]
    LockPoisoned,

    #[error("worker thread panicked")]
    ThreadPanic,
}

/// Convenience alias used throughout the crate.
pub type Result<T> = core::result::Result<T, SecureStorageError>;
