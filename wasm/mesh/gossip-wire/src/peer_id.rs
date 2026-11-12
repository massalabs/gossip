//! Peer identity: a Massa ed25519 public key.
//!
//! Vendored from massa: `massa-protocol-exports/src/peer_id.rs` (rev d193d9ff89).
//! `ProtocolError` is replaced by [`WireError`].

use std::{fmt::Display, hash::Hash, str::FromStr};

use massa_hash::Hash as MassaHash;
use massa_serialization::{Deserializer, Serializer};
use massa_signature::{KeyPair, PublicKey, PublicKeyDeserializer, Signature};

use crate::error::WireError;

/// Identity of a peer on the network: its public key.
///
/// Wire form: the Massa `PublicKey` bytes (version varint + 32 raw bytes, see
/// [`crate::primitives::PUBLIC_KEY_DESER_SIZE`]). Textual form: `P` + base58check.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Copy)]
pub struct PeerId {
    public_key: PublicKey,
}

impl PeerId {
    /// Builds a peer id from a public key.
    pub fn from_public_key(public_key: PublicKey) -> Self {
        Self { public_key }
    }

    /// The underlying public key.
    pub fn get_public_key(&self) -> PublicKey {
        self.public_key
    }

    /// Serialized public key bytes (the exact wire form of the peer id).
    pub fn to_bytes(&self) -> Vec<u8> {
        self.public_key.to_bytes()
    }

    /// Checks that `signature` over `hash` was produced by this peer's keypair.
    pub fn verify_signature(
        &self,
        hash: &MassaHash,
        signature: &Signature,
    ) -> Result<(), WireError> {
        self.public_key
            .verify_signature(hash, signature)
            .map_err(WireError::Signature)
    }
}

impl From<PublicKey> for PeerId {
    fn from(public_key: PublicKey) -> Self {
        Self { public_key }
    }
}

impl FromStr for PeerId {
    type Err = WireError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let public_key = PublicKey::from_str(s).map_err(WireError::Signature)?;
        Ok(Self { public_key })
    }
}

impl Display for PeerId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.public_key.fmt(f)
    }
}

impl PeerId {
    /// A peer id over a fresh random key.
    pub fn generate() -> Self {
        Self {
            public_key: KeyPair::generate(0).unwrap().get_public_key(),
        }
    }
}

/// Serializer for [`PeerId`] (the public key bytes).
#[derive(Default, Clone)]
pub struct PeerIdSerializer {}

impl PeerIdSerializer {
    /// Creates a `PeerIdSerializer`
    pub fn new() -> Self {
        Self {}
    }
}

impl Serializer<PeerId> for PeerIdSerializer {
    fn serialize(
        &self,
        value: &PeerId,
        buffer: &mut Vec<u8>,
    ) -> Result<(), massa_serialization::SerializeError> {
        buffer.extend_from_slice(&value.public_key.to_bytes());
        Ok(())
    }
}

/// Deserializer for [`PeerId`]. Fixed size, no bound needed.
#[derive(Default, Clone)]
pub struct PeerIdDeserializer {
    public_key_deserializer: PublicKeyDeserializer,
}

impl PeerIdDeserializer {
    /// Creates a `PeerIdDeserializer`
    pub fn new() -> Self {
        PeerIdDeserializer {
            public_key_deserializer: PublicKeyDeserializer::new(),
        }
    }
}

impl Deserializer<PeerId> for PeerIdDeserializer {
    fn deserialize<'a, E: nom::error::ParseError<&'a [u8]> + nom::error::ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> nom::IResult<&'a [u8], PeerId, E> {
        self.public_key_deserializer
            .deserialize(buffer)
            .map(|(buffer, public_key)| (buffer, PeerId { public_key }))
    }
}

impl ::serde::Serialize for PeerId {
    /// `::serde::Serialize` trait for `PeerId`
    ///
    fn serialize<S: ::serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(&self.to_string())
    }
}

impl<'de> ::serde::Deserialize<'de> for PeerId {
    /// `::serde::Deserialize` trait for `PeerId`
    fn deserialize<D: ::serde::Deserializer<'de>>(d: D) -> Result<PeerId, D::Error> {
        struct Base58CheckVisitor;

        impl ::serde::de::Visitor<'_> for Base58CheckVisitor {
            type Value = PeerId;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("an ASCII base58check string")
            }

            fn visit_bytes<E>(self, v: &[u8]) -> Result<Self::Value, E>
            where
                E: ::serde::de::Error,
            {
                if let Ok(v_str) = std::str::from_utf8(v) {
                    PeerId::from_str(v_str).map_err(E::custom)
                } else {
                    Err(E::invalid_value(::serde::de::Unexpected::Bytes(v), &self))
                }
            }

            fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
            where
                E: ::serde::de::Error,
            {
                PeerId::from_str(v).map_err(E::custom)
            }
        }
        d.deserialize_str(Base58CheckVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::primitives::PUBLIC_KEY_DESER_SIZE;
    use massa_serialization::DeserializeError;

    #[test]
    fn wire_roundtrip() {
        let keypair = KeyPair::generate(0).unwrap();
        let peer_id = PeerId::from_public_key(keypair.get_public_key());
        let mut buf = Vec::new();
        PeerIdSerializer::new()
            .serialize(&peer_id, &mut buf)
            .unwrap();
        assert_eq!(buf.len(), PUBLIC_KEY_DESER_SIZE);
        assert_eq!(buf, peer_id.to_bytes());
        let (rest, back) = PeerIdDeserializer::new()
            .deserialize::<DeserializeError>(&buf)
            .unwrap();
        assert!(rest.is_empty());
        assert_eq!(back, peer_id);
        assert_eq!(back.get_public_key(), keypair.get_public_key());
        assert!(PeerIdDeserializer::new()
            .deserialize::<DeserializeError>(&buf[..buf.len() - 1])
            .is_err());
    }

    #[test]
    fn string_and_serde_roundtrip() {
        let peer_id = PeerId::generate();
        let s = peer_id.to_string();
        assert!(s.starts_with('P'));
        assert_eq!(PeerId::from_str(&s).unwrap(), peer_id);
        assert!(PeerId::from_str("Pnope").is_err());
        let json = serde_json::to_string(&peer_id).unwrap();
        assert_eq!(json, format!("\"{}\"", s));
        let back: PeerId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, peer_id);
    }

    #[test]
    fn verify_signature() {
        let keypair = KeyPair::generate(0).unwrap();
        let peer_id = PeerId::from(keypair.get_public_key());
        let hash = MassaHash::compute_from(b"hello");
        let signature = keypair.sign(&hash).unwrap();
        assert!(peer_id.verify_signature(&hash, &signature).is_ok());
        let other = MassaHash::compute_from(b"world");
        assert!(peer_id.verify_signature(&other, &signature).is_err());
        let stranger = PeerId::generate();
        assert!(stranger.verify_signature(&hash, &signature).is_err());
    }
}
