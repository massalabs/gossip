//! `Debug` output that hides secrets and message content: only their sizes are shown.

use core::fmt;

/// Formats as `<N bytes>`, standing for a value that must not be printed.
pub(crate) struct Bytes(pub usize);

impl fmt::Debug for Bytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "<{} bytes>", self.0)
    }
}

/// Formats as `<N entries>`, standing for a map whose keys and values must not be printed.
pub(crate) struct Entries(pub usize);

impl fmt::Debug for Entries {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "<{} entries>", self.0)
    }
}
