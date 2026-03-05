use zeroize::Zeroize;

use crate::constants::SESSION_COUNT;
use crate::error::{BordercryptError, Result};

const _: () = assert!(SESSION_COUNT <= u8::MAX as usize + 1);

/// Validated index into the session array (0..SESSION_COUNT).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Zeroize)]
pub struct SessionIndex(u8);

impl SessionIndex {
    /// Create a new session index, validating it is within bounds.
    pub fn new(index: u8) -> Result<Self> {
        if (index as usize) < SESSION_COUNT {
            Ok(Self(index))
        } else {
            Err(BordercryptError::InvalidSessionIndex(index))
        }
    }

    /// Return the raw index as `u8`.
    #[inline]
    #[must_use]
    pub const fn as_u8(self) -> u8 {
        self.0
    }

    /// Return the index as `usize` for array indexing.
    #[inline]
    #[must_use]
    pub const fn as_usize(self) -> usize {
        self.0 as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_index_valid() {
        for i in 0..SESSION_COUNT as u8 {
            let idx = SessionIndex::new(i).unwrap();
            assert_eq!(idx.as_usize(), i as usize);
            assert_eq!(idx.as_u8(), i);
        }
    }

    #[test]
    fn session_index_invalid() {
        assert!(SessionIndex::new(SESSION_COUNT as u8).is_err());
        assert!(SessionIndex::new(255).is_err());
    }
}
