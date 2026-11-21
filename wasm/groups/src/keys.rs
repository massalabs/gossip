//! Identity keys and ML-DSA-65 signatures over 32-byte IDs (§4.3, Appendix A).
//!
//! Keys are the existing `auth::UserPublicKeys`, serialized with bincode by `auth` itself, and
//! the GossipID is `auth`'s own derivation (`UserPublicKeys::derive_id`). Signing and
//! verification use `crypto-dsa`.

use core::fmt;

use auth::UserPublicKeys;
use crypto_dsa::{SIGNATURE_SIZE, SIGNING_RANDOMNESS_SIZE, SigningKey};

use crate::error::{Error, Result};
use crate::ids::GossipId;

/// Parses `bincode(UserPublicKeys)` and returns the keys with their GossipID.
///
/// The bytes must be exactly the encoding `auth` produces for the keys: trailing bytes or
/// another encoding of the same keys would hash to another value than the GossipID (§3).
/// Refusing them keeps one byte string per identity, so that the bytes hashed into a root ID
/// are the bytes that hash to the owner's GossipID. `auth`'s decoder now enforces the same
/// rule; the check here stays as a second line of defence.
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

/// What signs with an identity's ML-DSA-65 key (§4.1, §5.1, Appendix A).
///
/// The engine never holds key material: it asks a signer, which the caller supplies for the
/// operations that sign (creating a root, a kick, a dissolve message or a leave). The signer
/// signs exactly the 32-byte ID it is given, under the given signing context, with the given
/// signing randomness.
pub trait Signer {
    /// The ML-DSA-65 signature of `id` under `context`.
    fn sign_id(
        &self,
        context: &'static str,
        id: &[u8; 32],
        randomness: [u8; SIGNING_RANDOMNESS_SIZE],
    ) -> SignatureBytes;
}

impl Signer for SigningKey {
    fn sign_id(
        &self,
        context: &'static str,
        id: &[u8; 32],
        randomness: [u8; SIGNING_RANDOMNESS_SIZE],
    ) -> SignatureBytes {
        sign_id(self, context, id, randomness)
    }
}

/// A signer that also knows the identity's public keys: what the engine needs to create a
/// root (the owner field) or to recognise its own leave.
pub trait IdentitySigner: Signer {
    /// The identity's complete public keys.
    fn public_keys(&self) -> &UserPublicKeys;
}

/// An [`IdentitySigner`] over a signing key held by the caller (tests, tools, or a caller
/// that keeps its key in memory). Production callers may implement the trait over a key
/// kept elsewhere.
pub struct KeySigner<'a> {
    /// The identity's public keys.
    pub public: UserPublicKeys,
    /// Its ML-DSA-65 signing key.
    pub signing_key: &'a SigningKey,
}

impl Signer for KeySigner<'_> {
    fn sign_id(
        &self,
        context: &'static str,
        id: &[u8; 32],
        randomness: [u8; SIGNING_RANDOMNESS_SIZE],
    ) -> SignatureBytes {
        sign_id(self.signing_key, context, id, randomness)
    }
}

impl IdentitySigner for KeySigner<'_> {
    fn public_keys(&self) -> &UserPublicKeys {
        &self.public
    }
}

/// Signs a 32-byte ID under a signing context. The randomness is supplied by the caller.
pub(crate) fn sign_id(
    signing_key: &SigningKey,
    context: &str,
    id: &[u8; 32],
    randomness: [u8; SIGNING_RANDOMNESS_SIZE],
) -> SignatureBytes {
    let signature = crypto_dsa::sign(signing_key, id, context.as_bytes(), randomness);
    SignatureBytes(Box::new(*signature.as_bytes()))
}

/// Verifies a signature over a 32-byte ID under a signing context, with the ML-DSA-65 key of
/// `keys`.
pub(crate) fn verify_id(
    keys: &UserPublicKeys,
    context: &str,
    id: &[u8; 32],
    signature: &SignatureBytes,
) -> Result<()> {
    let signature = crypto_dsa::Signature::from(*signature.as_bytes());
    if crypto_dsa::verify(
        &keys.dsa_verification_key,
        id,
        context.as_bytes(),
        &signature,
    ) {
        Ok(())
    } else {
        Err(Error::InvalidSignature)
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
            Err(Error::InvalidKeys)
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

    #[test]
    fn verify_fails_on_wrong_context_key_or_id() {
        let alice = identity(1);
        let bob = identity(2);
        let id = [7u8; 32];
        let sig = sign_id(&alice.secret.dsa_signing_key, "ctx.a", &id, [9; 32]);
        assert!(verify_id(&alice.public, "ctx.a", &id, &sig).is_ok());
        assert_eq!(
            verify_id(&alice.public, "ctx.b", &id, &sig),
            Err(Error::InvalidSignature)
        );
        assert!(verify_id(&bob.public, "ctx.a", &id, &sig).is_err());
        assert!(verify_id(&alice.public, "ctx.a", &[8u8; 32], &sig).is_err());
    }
}
