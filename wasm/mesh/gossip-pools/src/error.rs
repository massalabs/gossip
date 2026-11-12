//! Error type.

/// Storage-level failure. Content problems are never errors: they are reported as
/// [`crate::InsertOutcome::Rejected`].
#[derive(Debug, thiserror::Error)]
pub enum PoolError {
    /// `redb` failure (I/O, lock, corruption detected by the engine).
    #[error("storage error: {0}")]
    Redb(#[source] Box<redb::Error>),
    /// An entry read back from the store does not decode.
    #[error("corrupted entry: {0}")]
    Corrupted(String),
    /// Filesystem failure outside `redb` (creating the parent directory).
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// The file was written by an incompatible version of this crate.
    #[error("unsupported pools schema version {found} (this build expects {expected})")]
    SchemaVersion {
        /// Version found in the file.
        found: u64,
        /// Version this crate writes.
        expected: u64,
    },
}

impl From<redb::Error> for PoolError {
    fn from(e: redb::Error) -> Self {
        PoolError::Redb(Box::new(e))
    }
}

macro_rules! from_redb {
    ($($t:ty),* $(,)?) => {
        $(impl From<$t> for PoolError {
            fn from(e: $t) -> Self {
                PoolError::from(redb::Error::from(e))
            }
        })*
    };
}

from_redb!(
    redb::DatabaseError,
    redb::TransactionError,
    redb::TableError,
    redb::StorageError,
    redb::CommitError,
);

impl PoolError {
    pub(crate) fn corrupted(what: impl Into<String>) -> Self {
        PoolError::Corrupted(what.into())
    }
}
