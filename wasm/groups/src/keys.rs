//! Identity keys and ML-DSA-65 signatures over 32-byte IDs (§4.3, Appendix A).
//!
//! Keys are the existing `auth::UserPublicKeys`, serialized with bincode by `auth` itself, and
//! the GossipID is `auth`'s own derivation (`UserPublicKeys::derive_id`). Signing and
//! verification use `crypto-dsa`.

use core::fmt;

use auth::UserPublicKeys;
use crypto_dsa::SIGNATURE_SIZE;

use crate::error::{Error, Result};
use crate::ids::GossipId;

/// Parses `bincode(UserPublicKeys)` and returns the keys with their GossipID.
///
/// The bytes must be exactly the encoding `auth` produces for the keys: `auth`'s decoder
/// accepts trailing bytes and other encodings of the same keys, whose hash would then differ
/// from the GossipID (§3). Refusing them keeps one byte string per identity, so that the bytes
/// hashed into a root ID are the bytes that hash to the owner's GossipID.
///
/// # Errors
///
/// [`Error::InvalidKeys`] if the bytes do not decode, [`Error::NonCanonicalKeys`] if they
/// decode but are not the canonical encoding.
pub fn parse_user_public_keys(bytes: &[u8]) -> Result<(UserPublicKeys, GossipId)> {
    let keys = UserPublicKeys::from_bytes(bytes).map_err(|_| Error::InvalidKeys)?;
    if keys.to_bytes() != bytes {
        return Err(Error::NonCanonicalKeys);
    }
    let id = GossipId::of_keys(&keys);
    Ok((keys, id))
}

/// Checks a key answer (§4.3, §12.9): the keys must parse and hash to the requested GossipID.
///
/// # Errors
///
/// As [`parse_user_public_keys`], or [`Error::KeysMismatch`] for keys of another identity.
pub fn check_key_answer(bytes: &[u8], requested: &GossipId) -> Result<UserPublicKeys> {
    let (keys, id) = parse_user_public_keys(bytes)?;
    if &id != requested {
        return Err(Error::KeysMismatch);
    }
    Ok(keys)
}

/// An ML-DSA-65 signature as carried on the wire: exactly [`SIGNATURE_SIZE`] bytes.
#[derive(Clone, PartialEq, Eq)]
pub struct SignatureBytes(Box<[u8; SIGNATURE_SIZE]>);

impl SignatureBytes {
    /// Parses a signature field.
    ///
    /// # Errors
    ///
    /// [`Error::BadLength`] unless the field is exactly [`SIGNATURE_SIZE`] bytes.
    pub fn from_slice(bytes: &[u8]) -> Result<Self> {
        let array: Box<[u8; SIGNATURE_SIZE]> = bytes
            .to_vec()
            .into_boxed_slice()
            .try_into()
            .map_err(|_| Error::BadLength {
                field: "signature",
                expected: SIGNATURE_SIZE,
                got: bytes.len(),
            })?;
        Ok(Self(array))
    }

    /// The raw bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; SIGNATURE_SIZE] {
        &self.0
    }
}

impl fmt::Debug for SignatureBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SignatureBytes({:02x}{:02x}..)", self.0[0], self.0[1])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::identity;

    #[test]
    fn parses_canonical_keys_to_the_auth_gossip_id() {
        let alice = identity(1);
        let bytes = alice.public.to_bytes();
        let (keys, id) = parse_user_public_keys(&bytes).unwrap();
        assert_eq!(keys.to_bytes(), bytes);
        assert_eq!(id.as_bytes(), alice.public.derive_id().as_bytes());
        // The GossipID is BLAKE3 of these very bytes (§3).
        assert_eq!(id.as_bytes(), blake3::hash(&bytes).as_bytes());
    }

    #[test]
    fn rejects_trailing_bytes_and_garbage() {
        let mut bytes = identity(1).public.to_bytes();
        bytes.push(0);
        assert_eq!(
            parse_user_public_keys(&bytes).map(|_| ()),
            Err(Error::NonCanonicalKeys)
        );
        assert_eq!(
            parse_user_public_keys(&[1, 2, 3]).map(|_| ()),
            Err(Error::InvalidKeys)
        );
        assert_eq!(
            parse_user_public_keys(&[]).map(|_| ()),
            Err(Error::InvalidKeys)
        );
    }

    #[test]
    fn key_answer_must_match_the_requested_id() {
        let alice = identity(1);
        let bob = identity(2);
        let bytes = alice.public.to_bytes();
        assert!(check_key_answer(&bytes, &alice.id).is_ok());
        assert_eq!(
            check_key_answer(&bytes, &bob.id).map(|_| ()),
            Err(Error::KeysMismatch)
        );
    }

    #[test]
    fn signature_field_has_an_exact_length() {
        assert!(SignatureBytes::from_slice(&[0; SIGNATURE_SIZE]).is_ok());
        assert_eq!(
            SignatureBytes::from_slice(&[0; SIGNATURE_SIZE - 1]),
            Err(Error::BadLength {
                field: "signature",
                expected: SIGNATURE_SIZE,
                got: SIGNATURE_SIZE - 1
            })
        );
        assert!(SignatureBytes::from_slice(&[]).is_err());
    }
}
