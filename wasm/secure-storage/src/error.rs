/// Unified error type for all secureStorage operations.
///
/// Display messages are deliberately generic to avoid leaking internal
/// state (session indices, versions, block positions) to callers.
/// Use the `Debug` representation for diagnostics.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum SecureStorageError {
    #[error("invalid password")]
    InvalidPassword,

    #[error("out of bounds")]
    OutOfBounds,

    #[error("unsupported version")]
    UnsupportedVersion(u32),

    #[error("corrupted data")]
    CorruptedBlock,

    #[error("invalid parameter")]
    InvalidSessionIndex(u8),

    #[error("overflow")]
    Overflow,

    #[error("storage error")]
    Storage(String),

    #[error("database error")]
    Sqlite(String),

    #[error("io error")]
    Io(#[from] std::io::Error),

    #[error("lock poisoned")]
    LockPoisoned,

    #[error("internal error")]
    ThreadPanic,
}

/// Convenience alias used throughout the crate.
pub type Result<T> = core::result::Result<T, SecureStorageError>;
