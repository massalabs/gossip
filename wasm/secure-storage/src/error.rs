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

    #[error("not initialized")]
    NotInitialized,

    #[error("database not open")]
    DatabaseNotOpen,

    #[error("database error")]
    Sqlite(String),

    #[error("io error")]
    Io(#[from] std::io::Error),

    // TODO: Check if this can be removed
    #[error("lock poisoned")]
    LockPoisoned,

    #[error("internal error")]
    ThreadPanic,
}

impl SecureStorageError {
    /// Stable, machine-discriminable code for this error variant. Used at
    /// the FFI boundary so JS / Swift / Kotlin callers can switch on the
    /// failure mode without parsing user-facing strings (whose wording is
    /// allowed to drift).
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidPassword => "INVALID_PASSWORD",
            Self::OutOfBounds => "OUT_OF_BOUNDS",
            Self::UnsupportedVersion(_) => "UNSUPPORTED_VERSION",
            Self::CorruptedBlock => "CORRUPTED_DATA",
            Self::InvalidSessionIndex(_) => "INVALID_SESSION_INDEX",
            Self::Overflow => "OVERFLOW",
            Self::Storage(_) => "STORAGE",
            Self::NotInitialized => "NOT_INITIALIZED",
            Self::DatabaseNotOpen => "DATABASE_NOT_OPEN",
            Self::Sqlite(_) => "SQLITE",
            Self::Io(_) => "IO",
            Self::LockPoisoned => "LOCK_POISONED",
            Self::ThreadPanic => "THREAD_PANIC",
        }
    }
}

/// Convenience alias used throughout the crate.
pub type Result<T> = core::result::Result<T, SecureStorageError>;
