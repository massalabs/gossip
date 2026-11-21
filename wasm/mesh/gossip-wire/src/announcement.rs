//! Signed listener announcement a peer sends about itself.
//!
//! Vendored from massa: `massa-protocol-worker/src/handlers/peer_handler/announcement.rs`
//! (rev d193d9ff89). `MassaTime` is replaced by [`UnixMillis`], `PeerNetError` by
//! [`WireError`], and the listener encoding is shared with
//! [`crate::primitives::ListenersSerializer`].
//!
//! Wire form:
//!
//! ```text
//! listeners (see ListenersSerializer) ‖ u64 BE timestamp_ms ‖ signature (65 bytes)
//! ```
//!
//! `hash = blake3(listeners ‖ timestamp)` and `signature = Sign(keypair, hash)`.

use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
};

use crate::TransportType;
use massa_hash::Hash;
use massa_signature::{KeyPair, Signature, SignatureDeserializer};
use nom::{
    error::{context, ContextError, ParseError},
    sequence::tuple,
    IResult, Parser,
};

use massa_serialization::{DeserializeError, Deserializer, SerializeError, Serializer};

use crate::error::WireError;
use crate::primitives::{ListenersDeserializer, ListenersSerializer, UnixMillis};

/// Maximum tolerated clock skew between our local clock and the timestamp carried by a
/// remote peer's announcement. The timestamp is attacker-controlled and is used as the peer
/// freshness signal, so an announcement dated arbitrarily far in the future would otherwise
/// stay "fresh" (and thus eligible for peer sharing and bootstrap responses) forever.
pub const MAX_ANNOUNCEMENT_CLOCK_SKEW_MS: u64 = 5 * 60 * 1_000;

/// A peer's signed statement of where it can be reached and when it said so.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Announcement {
    /// Listeners
    pub listeners: HashMap<SocketAddr, TransportType>,
    /// Timestamp
    pub timestamp: UnixMillis,
    /// Hash
    pub hash: Hash,
    /// serialized version
    serialized: Vec<u8>,
    /// Signature
    pub signature: Signature,
}

/// Serializer for [`Announcement`].
#[derive(Clone, Default)]
pub struct AnnouncementSerializer;

impl AnnouncementSerializer {
    /// Creates an `AnnouncementSerializer`
    pub fn new() -> Self {
        Self
    }
}

impl Serializer<Announcement> for AnnouncementSerializer {
    fn serialize(&self, value: &Announcement, buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        buffer.extend(value.serialized.clone());
        buffer.extend(value.signature.to_bytes());
        Ok(())
    }
}

/// Bounded deserializer for [`Announcement`].
#[derive(Clone)]
pub struct AnnouncementDeserializer {
    listeners_deserializer: ListenersDeserializer,
}

/// Limits used in the deserialization of [`Announcement`].
pub struct AnnouncementDeserializerArgs {
    /// Maximum number of listeners in one announcement.
    pub max_listeners: u64,
}

impl AnnouncementDeserializer {
    /// Creates an `AnnouncementDeserializer` with the given limits.
    pub fn new(args: AnnouncementDeserializerArgs) -> Self {
        Self {
            listeners_deserializer: ListenersDeserializer::new(args.max_listeners),
        }
    }
}

impl Deserializer<Announcement> for AnnouncementDeserializer {
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], Announcement, E> {
        let (rest, (listeners, timestamp)) = context(
            "Failed announcement deserialization",
            tuple((
                context("Failed listeners deserialization", |buffer| {
                    self.listeners_deserializer.deserialize(buffer)
                }),
                context("Failed timestamp deserialization", |buffer: &'a [u8]| {
                    let (rest, timestamp) = nom::number::complete::be_u64(buffer)?;
                    Ok((rest, UnixMillis(timestamp)))
                }),
            )),
        )
        .parse(buffer)?;
        let serialized = buffer[..buffer.len() - rest.len()].to_vec();
        let hash = Hash::compute_from(&serialized);
        let signature_deserializer = SignatureDeserializer::new();
        let (rest, signature) = signature_deserializer
            .deserialize::<DeserializeError>(rest)
            .map_err(|_| {
                nom::Err::Error(ParseError::from_error_kind(
                    rest,
                    nom::error::ErrorKind::Verify,
                ))
            })?;
        Ok((
            rest,
            Announcement {
                listeners,
                hash,
                timestamp,
                serialized,
                signature,
            },
        ))
    }
}

impl Announcement {
    /// Check the announcement timestamp against the local clock: a peer cannot legitimately
    /// announce more than `MAX_ANNOUNCEMENT_CLOCK_SKEW_MS` ahead of us.
    pub fn is_future_dated(&self, now: UnixMillis) -> bool {
        self.timestamp > now.saturating_add(MAX_ANNOUNCEMENT_CLOCK_SKEW_MS)
    }

    /// The bytes covered by [`Self::hash`] and [`Self::signature`]
    /// (`listeners ‖ timestamp`).
    pub fn signed_bytes(&self) -> &[u8] {
        &self.serialized
    }

    /// Builds and signs an announcement dated now.
    ///
    /// Build the canonical listener set that gets serialized, hashed and signed:
    /// when a routable IP is provided, advertise every listener under that IP;
    /// otherwise advertise no listeners. Storing this same map in the returned
    /// struct keeps `listeners`, `serialized`, `hash` and `signature` describing
    /// the exact same listener set (so a serialize/deserialize round trip is stable).
    pub fn new(
        listeners: HashMap<SocketAddr, TransportType>,
        routable_ip: Option<IpAddr>,
        keypair: &KeyPair,
    ) -> Result<Self, WireError> {
        let mut buf: Vec<u8> = vec![];
        //TODO: Hacky to fix and adapt to support multiple ip/listeners
        let listeners: HashMap<SocketAddr, TransportType> = match routable_ip {
            Some(ip) => listeners
                .into_iter()
                .map(|(addr, transport)| (SocketAddr::new(ip, addr.port()), transport))
                .collect(),
            None => HashMap::default(),
        };
        ListenersSerializer::new().serialize(&listeners, &mut buf)?;
        let timestamp = UnixMillis::now();
        buf.extend(timestamp.as_millis().to_be_bytes());
        let hash = Hash::compute_from(&buf);
        Ok(Self {
            listeners,
            timestamp,
            hash,
            signature: keypair.sign(&hash).map_err(WireError::Signature)?,
            serialized: buf,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Announcement, AnnouncementDeserializer, AnnouncementDeserializerArgs,
        AnnouncementSerializer, MAX_ANNOUNCEMENT_CLOCK_SKEW_MS,
    };
    use crate::peer_id::PeerId;
    use crate::primitives::{UnixMillis, SIGNATURE_DESER_SIZE};
    use crate::TransportType;
    use massa_serialization::{DeserializeError, Deserializer, Serializer};
    use massa_signature::KeyPair;
    use std::collections::HashMap;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    #[test]
    fn test_ser_deser() {
        let mut listeners = HashMap::new();
        listeners.insert("127.0.0.1:8081".parse().unwrap(), TransportType::Tcp);
        listeners.insert("127.0.0.1:8082".parse().unwrap(), TransportType::Quic);
        let announcement =
            Announcement::new(listeners, None, &KeyPair::generate(0).unwrap()).unwrap();
        let announcement_serializer = AnnouncementSerializer::new();
        let announcement_deserializer =
            AnnouncementDeserializer::new(AnnouncementDeserializerArgs { max_listeners: 100 });
        let mut buf: Vec<u8> = vec![];
        announcement_serializer
            .serialize(&announcement, &mut buf)
            .unwrap();
        let (_, announcement_deserialized) = announcement_deserializer
            .deserialize::<DeserializeError>(&buf)
            .unwrap();
        assert_eq!(announcement, announcement_deserialized);
    }

    #[test]
    fn test_ser_deser_with_routable_ip() {
        let mut listeners = HashMap::new();
        listeners.insert("127.0.0.1:8081".parse().unwrap(), TransportType::Tcp);
        listeners.insert("127.0.0.1:8082".parse().unwrap(), TransportType::Quic);
        let routable_ip = IpAddr::V4(Ipv4Addr::new(1, 2, 3, 4));
        let announcement =
            Announcement::new(listeners, Some(routable_ip), &KeyPair::generate(0).unwrap())
                .unwrap();

        // The in-memory listeners map must advertise the routable IP (same ports),
        // so it matches the serialized/hashed/signed payload.
        let mut expected_listeners = HashMap::new();
        expected_listeners.insert(SocketAddr::new(routable_ip, 8081), TransportType::Tcp);
        expected_listeners.insert(SocketAddr::new(routable_ip, 8082), TransportType::Quic);
        assert_eq!(announcement.listeners, expected_listeners);

        // And a serialize -> deserialize round trip must preserve the whole struct.
        let announcement_serializer = AnnouncementSerializer::new();
        let announcement_deserializer =
            AnnouncementDeserializer::new(AnnouncementDeserializerArgs { max_listeners: 100 });
        let mut buf: Vec<u8> = vec![];
        announcement_serializer
            .serialize(&announcement, &mut buf)
            .unwrap();
        let (rest, announcement_deserialized) = announcement_deserializer
            .deserialize::<DeserializeError>(&buf)
            .unwrap();
        assert!(rest.is_empty());
        assert_eq!(announcement, announcement_deserialized);
        // listeners(1 + 2 * (1+4+2+1)) + timestamp(8) + signature
        assert_eq!(buf.len(), 1 + 16 + 8 + SIGNATURE_DESER_SIZE);
    }

    #[test]
    fn signature_binds_listeners_and_timestamp() {
        let keypair = KeyPair::generate(0).unwrap();
        let peer_id = PeerId::from_public_key(keypair.get_public_key());
        let mut listeners = HashMap::new();
        listeners.insert("0.0.0.0:31244".parse().unwrap(), TransportType::Tcp);
        let announcement = Announcement::new(
            listeners,
            Some(IpAddr::V4(Ipv4Addr::new(5, 6, 7, 8))),
            &keypair,
        )
        .unwrap();
        assert!(peer_id
            .verify_signature(&announcement.hash, &announcement.signature)
            .is_ok());
        assert_eq!(
            massa_hash::Hash::compute_from(announcement.signed_bytes()),
            announcement.hash
        );

        let mut buf = vec![];
        AnnouncementSerializer::new()
            .serialize(&announcement, &mut buf)
            .unwrap();
        // flip the port: the deserialized hash no longer matches the signature
        buf[7] ^= 1;
        let (_, tampered) =
            AnnouncementDeserializer::new(AnnouncementDeserializerArgs { max_listeners: 100 })
                .deserialize::<DeserializeError>(&buf)
                .unwrap();
        assert_ne!(tampered.hash, announcement.hash);
        assert!(peer_id
            .verify_signature(&tampered.hash, &tampered.signature)
            .is_err());
    }

    #[test]
    fn bounds_and_truncation() {
        let mut listeners = HashMap::new();
        listeners.insert("127.0.0.1:1".parse().unwrap(), TransportType::Tcp);
        listeners.insert("127.0.0.1:2".parse().unwrap(), TransportType::Tcp);
        let announcement = Announcement::new(
            listeners,
            Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
            &KeyPair::generate(0).unwrap(),
        )
        .unwrap();
        let mut buf = vec![];
        AnnouncementSerializer::new()
            .serialize(&announcement, &mut buf)
            .unwrap();
        assert!(
            AnnouncementDeserializer::new(AnnouncementDeserializerArgs { max_listeners: 1 })
                .deserialize::<DeserializeError>(&buf)
                .is_err()
        );
        let deser =
            AnnouncementDeserializer::new(AnnouncementDeserializerArgs { max_listeners: 2 });
        assert!(deser.deserialize::<DeserializeError>(&buf).is_ok());
        assert!(deser
            .deserialize::<DeserializeError>(&buf[..buf.len() - 1])
            .is_err());
        assert!(deser.deserialize::<DeserializeError>(&buf[..10]).is_err());
    }

    #[test]
    fn future_dated() {
        let announcement =
            Announcement::new(HashMap::new(), None, &KeyPair::generate(0).unwrap()).unwrap();
        let now = announcement.timestamp;
        assert!(!announcement.is_future_dated(now));
        assert!(!announcement.is_future_dated(now.saturating_sub(MAX_ANNOUNCEMENT_CLOCK_SKEW_MS)));
        assert!(announcement.is_future_dated(
            now.saturating_sub(MAX_ANNOUNCEMENT_CLOCK_SKEW_MS)
                .saturating_sub(1)
        ));
        assert!(!announcement.is_future_dated(UnixMillis(u64::MAX)));
    }
}
