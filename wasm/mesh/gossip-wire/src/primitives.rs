//! Wire primitives shared by every message: IP addresses, byte vectors, listener
//! maps, the protocol [`Version`] and the [`UnixMillis`] timestamp.
//!
//! Vendored from massa (rev d193d9ff89):
//! - `massa-models/src/serialization.rs` (`IpAddrSerializer`, `IpAddrDeserializer`,
//!   `VecU8Serializer`, `VecU8Deserializer`),
//! - `massa-models/src/version.rs` (`Version`),
//! - `massa-models/src/config/constants.rs` (`SIGNATURE_DESER_SIZE`),
//! - the listener-map encoding of
//!   `massa-protocol-worker/src/handlers/peer_handler/{messages.rs,announcement.rs}`.
//!
//! `MassaTime` is replaced by [`UnixMillis`] and `ModelsError` by [`WireError`].

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::ops::Bound::{self, Included};
use std::str::FromStr;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{convert::TryInto, fmt};

use crate::TransportType;
use massa_serialization::{
    Deserializer, SerializeError, Serializer, U32VarIntDeserializer, U32VarIntSerializer,
    U64VarIntDeserializer, U64VarIntSerializer,
};
use nom::branch::alt;
use nom::bytes::complete::take;
use nom::error::{context, ContextError, ErrorKind, ParseError};
use nom::multi::{length_count, length_data};
use nom::number::complete::{be_u16, u8 as nom_u8};
use nom::sequence::{preceded, tuple};
use nom::{IResult, Parser};
use serde::de::Unexpected;

use crate::error::WireError;

/// Serialized size of a Massa `Signature`: a one-byte version varint followed by the
/// 64-byte ed25519 signature (`massa-models/src/config/constants.rs`).
pub const SIGNATURE_DESER_SIZE: usize = 64 + 1;
/// Raw size of an ed25519 public key. On the wire a Massa `PublicKey` (and thus a
/// [`crate::PeerId`]) is prefixed by a one-byte version varint, see
/// [`PUBLIC_KEY_DESER_SIZE`].
pub const PUBLIC_KEY_SIZE_BYTES: usize = 32;
/// Serialized size of a Massa `PublicKey` / [`crate::PeerId`].
pub const PUBLIC_KEY_DESER_SIZE: usize = PUBLIC_KEY_SIZE_BYTES + 1;
/// Network version announced by this implementation during handshakes
/// (instance `GOSS`, major `0`, minor `1`). Peers are compatible when their instance
/// and major match, see [`Version::is_compatible`].
pub const GOSSIP_NET_VERSION: &str = "GOSS.1.0";

// ---------------------------------------------------------------------------
// IpAddr
// ---------------------------------------------------------------------------

/// Serializer for `IpAddr`: one tag byte (`4` or `6`) then the 4 or 16 address bytes.
#[derive(Default, Clone)]
pub struct IpAddrSerializer;

impl IpAddrSerializer {
    /// Creates a `IpAddrSerializer`
    pub const fn new() -> Self {
        Self
    }
}

impl Serializer<IpAddr> for IpAddrSerializer {
    /// ```
    /// use gossip_wire::primitives::IpAddrSerializer;
    /// use massa_serialization::Serializer;
    /// use std::net::{IpAddr, Ipv4Addr};
    ///
    /// let ip = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));
    /// let ip_serializer = IpAddrSerializer::new();
    /// let mut buffer = Vec::new();
    /// ip_serializer.serialize(&ip, &mut buffer).unwrap();
    /// assert_eq!(buffer, vec![4, 127, 0, 0, 1]);
    /// ```
    fn serialize(&self, value: &IpAddr, buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        match value {
            IpAddr::V4(ip_v4) => {
                buffer.push(4u8);
                buffer.extend(ip_v4.octets());
            }
            IpAddr::V6(ip_v6) => {
                buffer.push(6u8);
                buffer.extend(ip_v6.octets());
            }
        };
        Ok(())
    }
}

/// Deserializer for `IpAddr`
#[derive(Default, Clone)]
pub struct IpAddrDeserializer;

impl IpAddrDeserializer {
    /// Creates a `IpAddrDeserializer`
    pub const fn new() -> Self {
        Self
    }
}

impl Deserializer<IpAddr> for IpAddrDeserializer {
    /// ```
    /// use gossip_wire::primitives::{IpAddrSerializer, IpAddrDeserializer};
    /// use massa_serialization::{Serializer, Deserializer, DeserializeError};
    /// use std::net::{IpAddr, Ipv6Addr};
    ///
    /// let ip = IpAddr::V6(Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 1));
    /// let ip_serializer = IpAddrSerializer::new();
    /// let ip_deserializer = IpAddrDeserializer::new();
    /// let mut serialized = Vec::new();
    /// ip_serializer.serialize(&ip, &mut serialized).unwrap();
    /// let (rest, ip_deser) = ip_deserializer.deserialize::<DeserializeError>(&serialized).unwrap();
    /// assert!(rest.is_empty());
    /// assert_eq!(ip, ip_deser);
    /// ```
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], IpAddr, E> {
        context(
            "Failed IpAddr deserialization",
            alt((
                preceded(
                    |input| nom::bytes::complete::tag([4u8])(input),
                    |input: &'a [u8]| {
                        let (rest, addr) = take(4usize)(input)?;
                        // Safe because take would fail just above if less than 4
                        let addr: [u8; 4] = addr.try_into().unwrap();
                        Ok((rest, IpAddr::V4(Ipv4Addr::from(addr))))
                    },
                ),
                preceded(
                    |input| nom::bytes::complete::tag([6u8])(input),
                    |input: &'a [u8]| {
                        let (rest, addr) = take(16usize)(input)?;
                        // Safe because take would fail just above if less than 16
                        let addr: [u8; 16] = addr.try_into().unwrap();
                        Ok((rest, IpAddr::V6(Ipv6Addr::from(addr))))
                    },
                ),
            )),
        )(buffer)
    }
}

// ---------------------------------------------------------------------------
// Vec<u8>
// ---------------------------------------------------------------------------

/// Basic `Vec<u8>` serializer: `varint(len)` then the bytes.
#[derive(Clone)]
pub struct VecU8Serializer {
    len_serializer: U64VarIntSerializer,
}

impl VecU8Serializer {
    /// Creates a new `VecU8Serializer`
    pub fn new() -> Self {
        Self {
            len_serializer: U64VarIntSerializer::new(),
        }
    }
}

impl Default for VecU8Serializer {
    fn default() -> Self {
        Self::new()
    }
}

impl Serializer<Vec<u8>> for VecU8Serializer {
    /// ```
    /// use massa_serialization::Serializer;
    /// use gossip_wire::primitives::VecU8Serializer;
    ///
    /// let vec = vec![1, 2, 3];
    /// let mut buffer = Vec::new();
    /// let serializer = VecU8Serializer::new();
    /// serializer.serialize(&vec, &mut buffer).unwrap();
    /// assert_eq!(buffer, vec![3, 1, 2, 3]);
    /// ```
    fn serialize(&self, value: &Vec<u8>, buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        let len: u64 = value.len().try_into().map_err(|err| {
            SerializeError::NumberTooBig(format!("too many entries data in VecU8: {}", err))
        })?;
        self.len_serializer.serialize(&len, buffer)?;
        buffer.extend(value);
        Ok(())
    }
}

/// Basic `Vec<u8>` deserializer with an explicit length range.
#[derive(Clone)]
pub struct VecU8Deserializer {
    varint_u64_deserializer: U64VarIntDeserializer,
}

impl VecU8Deserializer {
    /// Creates a new `VecU8Deserializer`
    pub const fn new(min_length: Bound<u64>, max_length: Bound<u64>) -> Self {
        Self {
            varint_u64_deserializer: U64VarIntDeserializer::new(min_length, max_length),
        }
    }
}

impl Deserializer<Vec<u8>> for VecU8Deserializer {
    /// ```
    /// use std::ops::Bound::Included;
    /// use massa_serialization::{Serializer, Deserializer, DeserializeError};
    /// use gossip_wire::primitives::{VecU8Serializer, VecU8Deserializer};
    ///
    /// let vec = vec![1, 2, 3];
    /// let mut serialized = Vec::new();
    /// let serializer = VecU8Serializer::new();
    /// let deserializer = VecU8Deserializer::new(Included(0), Included(1000000));
    /// serializer.serialize(&vec, &mut serialized).unwrap();
    /// let (rest, vec_deser) = deserializer.deserialize::<DeserializeError>(&serialized).unwrap();
    /// assert!(rest.is_empty());
    /// assert_eq!(vec, vec_deser);
    /// ```
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], Vec<u8>, E> {
        context("Failed Vec<u8> deserialization", |input| {
            length_data(|input| self.varint_u64_deserializer.deserialize(input))(input)
        })
        .map(|res| res.to_vec())
        .parse(buffer)
    }
}

// ---------------------------------------------------------------------------
// Listener map
// ---------------------------------------------------------------------------

/// Listener map advertised by a peer: socket address to transport.
pub type Listeners = HashMap<SocketAddr, TransportType>;

/// Serializer for a [`Listeners`] map.
///
/// Encoding: `varint(count)` then, for each listener, the IP (see
/// [`IpAddrSerializer`]), the `be_u16` port and one `u8` transport type
/// (`0` = TCP, `1` = QUIC). Entries are written sorted by socket address so that the
/// encoding (and anything hashed or signed over it) is deterministic.
#[derive(Clone, Default)]
pub struct ListenersSerializer {
    len_serializer: U64VarIntSerializer,
    ip_addr_serializer: IpAddrSerializer,
}

impl ListenersSerializer {
    /// Creates a `ListenersSerializer`
    pub const fn new() -> Self {
        Self {
            len_serializer: U64VarIntSerializer::new(),
            ip_addr_serializer: IpAddrSerializer::new(),
        }
    }
}

impl Serializer<Listeners> for ListenersSerializer {
    fn serialize(&self, value: &Listeners, buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        let len: u64 = value
            .len()
            .try_into()
            .map_err(|err| SerializeError::NumberTooBig(format!("too many listeners: {}", err)))?;
        self.len_serializer.serialize(&len, buffer)?;
        let mut entries: Vec<(&SocketAddr, &TransportType)> = value.iter().collect();
        entries.sort_unstable_by_key(|(addr, _)| **addr);
        for (socket_addr, transport_type) in entries {
            self.ip_addr_serializer
                .serialize(&socket_addr.ip(), buffer)?;
            buffer.extend_from_slice(&socket_addr.port().to_be_bytes());
            buffer.push(*transport_type as u8);
        }
        Ok(())
    }
}

/// Bounded deserializer for a [`Listeners`] map.
#[derive(Clone)]
pub struct ListenersDeserializer {
    len_deserializer: U64VarIntDeserializer,
    ip_addr_deserializer: IpAddrDeserializer,
}

impl ListenersDeserializer {
    /// Creates a `ListenersDeserializer` accepting at most `max_listeners` entries.
    pub const fn new(max_listeners: u64) -> Self {
        Self {
            len_deserializer: U64VarIntDeserializer::new(Included(0), Included(max_listeners)),
            ip_addr_deserializer: IpAddrDeserializer::new(),
        }
    }
}

impl Deserializer<Listeners> for ListenersDeserializer {
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], Listeners, E> {
        context(
            "Failed listeners deserialization",
            length_count(
                context("Failed length listeners deserialization", |input| {
                    self.len_deserializer.deserialize(input)
                }),
                context("Failed listener deserialization", |input| {
                    listener_deserializer(input, &self.ip_addr_deserializer)
                }),
            ),
        )
        .map(|listeners: Vec<(SocketAddr, TransportType)>| listeners.into_iter().collect())
        .parse(buffer)
    }
}

/// Parses one listener entry: IP, `be_u16` port, `u8` transport type.
fn listener_deserializer<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
    buffer: &'a [u8],
    ip_addr_deserializer: &IpAddrDeserializer,
) -> IResult<&'a [u8], (SocketAddr, TransportType), E> {
    tuple((
        context("Failed SocketAddr deserialization", |input: &'a [u8]| {
            let (rest, ip) = ip_addr_deserializer.deserialize(input)?;
            let (rest, port) = be_u16(rest)?;
            Ok((rest, SocketAddr::new(ip, port)))
        }),
        context(
            "Failed TransportType deserialization",
            |input: &'a [u8]| {
                let (rest, id) = nom_u8(input)?;
                match id {
                    0 => Ok((rest, TransportType::Tcp)),
                    1 => Ok((rest, TransportType::Quic)),
                    _ => Err(nom::Err::Error(ParseError::from_error_kind(
                        input,
                        ErrorKind::Verify,
                    ))),
                }
            },
        ),
    ))(buffer)
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const INSTANCE_LEN: usize = 4;

/// Application version, checked during handshakes. Textual form `INST.major.minor`
/// (e.g. `GOSS.0.1`): a 4-char uppercase ASCII instance and two `u32`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Version {
    /// ASCII uppercase alpha
    instance: [char; INSTANCE_LEN],
    major: u32,
    minor: u32,
}

struct VersionVisitor;

impl serde::de::Visitor<'_> for VersionVisitor {
    type Value = Version;

    fn visit_str<E>(self, value: &str) -> Result<Version, E>
    where
        E: serde::de::Error,
    {
        Version::from_str(value).map_err(|_| E::invalid_value(Unexpected::Str(value), &self))
    }

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        write!(
            formatter,
            "an Version type representing a version identifier"
        )
    }
}

impl<'de> serde::Deserialize<'de> for Version {
    fn deserialize<D>(deserializer: D) -> Result<Version, D::Error>
    where
        D: serde::de::Deserializer<'de>,
    {
        deserializer.deserialize_str(VersionVisitor)
    }
}

impl serde::Serialize for Version {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Serializer for `Version`: 4 instance bytes, `varint(major)`, `varint(minor)`.
#[derive(Clone)]
pub struct VersionSerializer {
    u32_serializer: U32VarIntSerializer,
}

impl VersionSerializer {
    /// Creates a `VersionSerializer`
    pub const fn new() -> Self {
        Self {
            u32_serializer: U32VarIntSerializer::new(),
        }
    }
}

impl Default for VersionSerializer {
    fn default() -> Self {
        Self::new()
    }
}

impl Serializer<Version> for VersionSerializer {
    /// ```
    /// use std::str::FromStr;
    /// use massa_serialization::Serializer;
    /// use gossip_wire::primitives::{Version, VersionSerializer};
    ///
    /// let version: Version = Version::from_str("TEST.1.10").unwrap();
    /// let serializer = VersionSerializer::new();
    /// let mut buffer = Vec::new();
    /// serializer.serialize(&version, &mut buffer).unwrap();
    /// assert_eq!(buffer, b"TEST\x01\x0a");
    /// ```
    fn serialize(&self, value: &Version, buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        buffer.extend(value.instance.iter().map(|&c| c as u8));
        self.u32_serializer.serialize(&value.major, buffer)?;
        self.u32_serializer.serialize(&value.minor, buffer)?;
        Ok(())
    }
}

/// Deserializer for `Version`
#[derive(Clone)]
pub struct VersionDeserializer {
    u32_deserializer: U32VarIntDeserializer,
}

impl VersionDeserializer {
    /// Creates a `VersionDeserializer`
    pub const fn new() -> Self {
        Self {
            u32_deserializer: U32VarIntDeserializer::new(Included(0), Included(u32::MAX)),
        }
    }
}

impl Default for VersionDeserializer {
    fn default() -> Self {
        Self::new()
    }
}

impl Deserializer<Version> for VersionDeserializer {
    /// ```
    /// use std::str::FromStr;
    /// use massa_serialization::{Serializer, Deserializer, DeserializeError};
    /// use gossip_wire::primitives::{Version, VersionSerializer, VersionDeserializer};
    ///
    /// let version: Version = Version::from_str("TEST.1.10").unwrap();
    /// let mut serialized = Vec::new();
    /// let serializer = VersionSerializer::new();
    /// let deserializer = VersionDeserializer::new();
    /// serializer.serialize(&version, &mut serialized).unwrap();
    /// let (rest, version_deser) = deserializer.deserialize::<DeserializeError>(&serialized).unwrap();
    /// assert_eq!(rest.len(), 0);
    /// assert_eq!(version, version_deser);
    /// ```
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], Version, E> {
        context(
            "Failed Version deserialization",
            tuple((
                context("Failed instance deserialization", |input: &'a [u8]| {
                    let (rest, instance) = take(INSTANCE_LEN)(input)?;
                    if instance.iter().any(|c| {
                        !c.is_ascii() || !c.is_ascii_alphabetic() || !c.is_ascii_uppercase()
                    }) {
                        return Err(nom::Err::Error(ParseError::from_error_kind(
                            input,
                            ErrorKind::Char,
                        )));
                    }
                    // Safe: because `take` fail if there is not enough data
                    let instance: [char; INSTANCE_LEN] = instance
                        .iter()
                        .map(|&c| char::from(c))
                        .collect::<Vec<char>>()
                        .try_into()
                        .unwrap();
                    Ok((rest, instance))
                }),
                context("Failed major deserialization", |input: &'a [u8]| {
                    self.u32_deserializer.deserialize(input)
                }),
                context("Failed minor deserialization", |input: &'a [u8]| {
                    self.u32_deserializer.deserialize(input)
                }),
            )),
        )
        .map(|(instance, major, minor)| Version {
            instance,
            major,
            minor,
        })
        .parse(buffer)
    }
}

impl Version {
    /// Builds a version; fails if `instance` is not 4-char uppercase ASCII alphabetic.
    pub fn new(instance: &str, major: u32, minor: u32) -> Result<Self, WireError> {
        Self::from_str(&format!("{}.{}.{}", instance, major, minor))
    }

    /// The version [`GOSSIP_NET_VERSION`] this implementation speaks.
    pub fn gossip_net() -> Self {
        Self::from_str(GOSSIP_NET_VERSION).expect("GOSSIP_NET_VERSION is a valid version")
    }

    /// Instance identifier (4 uppercase ASCII letters).
    pub fn instance(&self) -> String {
        self.instance.iter().collect()
    }

    /// Major number.
    pub fn major(&self) -> u32 {
        self.major
    }

    /// Minor number.
    pub fn minor(&self) -> u32 {
        self.minor
    }

    /// true if instance and major are the same
    pub fn is_compatible(&self, other: &Version) -> bool {
        self.instance == other.instance && self.major == other.major
    }
}

impl fmt::Display for Version {
    /// ```rust
    /// # use gossip_wire::primitives::Version;
    /// # use std::str::FromStr;
    /// let v: Version = Version::from_str("TEST.1.10").unwrap();
    /// assert_eq!(v.to_string(), "TEST.1.10");
    /// ```
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let network_str: String = self.instance.iter().cloned().collect();
        write!(f, "{}.{}.{}", network_str, self.major, self.minor)
    }
}

impl FromStr for Version {
    type Err = WireError;

    fn from_str(str_version: &str) -> Result<Self, Self::Err> {
        let parts: Vec<String> = str_version.split('.').map(|v| v.to_string()).collect();
        if parts.len() != 3 {
            return Err(WireError::InvalidVersion(
                "version identifier is not in 3 parts separates by a dot".into(),
            ));
        }
        if parts[0].len() != 4
            || !parts[0].is_ascii()
            || parts[0]
                .chars()
                .any(|c| !c.is_ascii_alphabetic() || !c.is_ascii_uppercase())
        {
            return Err(WireError::InvalidVersion(
                "version identifier instance part is not 4-char uppercase alphabetic ASCII".into(),
            ));
        }
        let instance: [char; 4] = parts[0].chars().collect::<Vec<char>>().try_into().unwrap(); // will not panic as the length and type were checked above
        let major: u32 = u32::from_str(&parts[1]).map_err(|_| {
            WireError::InvalidVersion("version identifier major number invalid".into())
        })?;
        let minor: u32 = u32::from_str(&parts[2]).map_err(|_| {
            WireError::InvalidVersion("version identifier minor number invalid".into())
        })?;
        Ok(Version {
            instance,
            major,
            minor,
        })
    }
}

// ---------------------------------------------------------------------------
// UnixMillis
// ---------------------------------------------------------------------------

/// A point in time as milliseconds since the Unix epoch (replaces `MassaTime`).
///
/// Serde representation is the plain `u64`; the wire representation is a `u64`
/// varint, see [`UnixMillisSerializer`].
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    serde::Serialize,
    serde::Deserialize,
)]
#[serde(transparent)]
pub struct UnixMillis(pub u64);

impl UnixMillis {
    /// Current wall-clock time. Saturates at `0` if the system clock is before the epoch
    /// and at `u64::MAX` if it does not fit.
    pub fn now() -> Self {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        Self(millis.min(u64::MAX as u128) as u64)
    }

    /// Milliseconds since the epoch.
    pub const fn as_millis(self) -> u64 {
        self.0
    }

    /// `self + ms`, saturating at `u64::MAX`.
    pub const fn saturating_add(self, ms: u64) -> Self {
        Self(self.0.saturating_add(ms))
    }

    /// `self - ms`, saturating at `0`.
    pub const fn saturating_sub(self, ms: u64) -> Self {
        Self(self.0.saturating_sub(ms))
    }

    /// Absolute difference with `other`, in milliseconds.
    pub const fn abs_diff(self, other: Self) -> u64 {
        self.0.abs_diff(other.0)
    }

    /// Duration since the epoch.
    pub const fn to_duration(self) -> Duration {
        Duration::from_millis(self.0)
    }

    /// Estimates the monotonic [`Instant`] corresponding to this timestamp:
    /// `Instant::now()` shifted by the difference between `self` and [`Self::now`].
    /// A timestamp too far in the past to be representable maps to `Instant::now()`.
    pub fn estimate_instant(self) -> Instant {
        let (now, now_instant) = (Self::now(), Instant::now());
        if self.0 >= now.0 {
            now_instant
                .checked_add(Duration::from_millis(self.0 - now.0))
                .unwrap_or(now_instant)
        } else {
            now_instant
                .checked_sub(Duration::from_millis(now.0 - self.0))
                .unwrap_or(now_instant)
        }
    }
}

impl From<u64> for UnixMillis {
    fn from(ms: u64) -> Self {
        Self(ms)
    }
}

impl From<UnixMillis> for u64 {
    fn from(t: UnixMillis) -> Self {
        t.0
    }
}

impl fmt::Display for UnixMillis {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Serializer for [`UnixMillis`] as a `u64` varint.
#[derive(Clone, Default)]
pub struct UnixMillisSerializer {
    u64_serializer: U64VarIntSerializer,
}

impl UnixMillisSerializer {
    /// Creates a `UnixMillisSerializer`
    pub const fn new() -> Self {
        Self {
            u64_serializer: U64VarIntSerializer::new(),
        }
    }
}

impl Serializer<UnixMillis> for UnixMillisSerializer {
    fn serialize(&self, value: &UnixMillis, buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        self.u64_serializer.serialize(&value.0, buffer)
    }
}

/// Bounded deserializer for [`UnixMillis`] (a `u64` varint within a range).
#[derive(Clone)]
pub struct UnixMillisDeserializer {
    u64_deserializer: U64VarIntDeserializer,
}

impl UnixMillisDeserializer {
    /// Creates a `UnixMillisDeserializer` accepting values in `[min, max]`.
    pub const fn new(min: Bound<UnixMillis>, max: Bound<UnixMillis>) -> Self {
        Self {
            u64_deserializer: U64VarIntDeserializer::new(map_bound(min), map_bound(max)),
        }
    }
}

const fn map_bound(b: Bound<UnixMillis>) -> Bound<u64> {
    match b {
        Bound::Included(t) => Bound::Included(t.0),
        Bound::Excluded(t) => Bound::Excluded(t.0),
        Bound::Unbounded => Bound::Unbounded,
    }
}

impl Default for UnixMillisDeserializer {
    /// Accepts any `u64`.
    fn default() -> Self {
        Self::new(Bound::Unbounded, Bound::Unbounded)
    }
}

impl Deserializer<UnixMillis> for UnixMillisDeserializer {
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], UnixMillis, E> {
        context("Failed UnixMillis deserialization", |input| {
            self.u64_deserializer.deserialize(input)
        })
        .map(UnixMillis)
        .parse(buffer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use massa_serialization::DeserializeError;

    #[test]
    fn ip_addr_roundtrip_and_bad_tag() {
        let ser = IpAddrSerializer::new();
        let deser = IpAddrDeserializer::new();
        for ip in [
            IpAddr::V4(Ipv4Addr::new(10, 1, 2, 3)),
            IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1)),
        ] {
            let mut buf = Vec::new();
            ser.serialize(&ip, &mut buf).unwrap();
            let (rest, back) = deser.deserialize::<DeserializeError>(&buf).unwrap();
            assert!(rest.is_empty());
            assert_eq!(back, ip);
        }
        assert!(deser
            .deserialize::<DeserializeError>(&[5, 1, 2, 3, 4])
            .is_err());
        assert!(deser.deserialize::<DeserializeError>(&[4, 1, 2]).is_err());
    }

    #[test]
    fn vec_u8_bounds() {
        let ser = VecU8Serializer::new();
        let mut buf = Vec::new();
        ser.serialize(&vec![7u8; 10], &mut buf).unwrap();
        let (rest, back) = VecU8Deserializer::new(Included(0), Included(10))
            .deserialize::<DeserializeError>(&buf)
            .unwrap();
        assert!(rest.is_empty());
        assert_eq!(back, vec![7u8; 10]);
        assert!(VecU8Deserializer::new(Included(0), Included(9))
            .deserialize::<DeserializeError>(&buf)
            .is_err());
        assert!(VecU8Deserializer::new(Included(0), Included(10))
            .deserialize::<DeserializeError>(&buf[..5])
            .is_err());
    }

    #[test]
    fn listeners_roundtrip_is_deterministic_and_bounded() {
        let mut listeners = Listeners::new();
        listeners.insert("127.0.0.1:8081".parse().unwrap(), TransportType::Tcp);
        listeners.insert("[::1]:8082".parse().unwrap(), TransportType::Quic);
        listeners.insert("10.0.0.1:1".parse().unwrap(), TransportType::Tcp);
        let ser = ListenersSerializer::new();
        let mut a = Vec::new();
        ser.serialize(&listeners, &mut a).unwrap();
        // re-serializing a rebuilt map gives the same bytes (sorted entries)
        let rebuilt: Listeners = listeners.iter().map(|(k, v)| (*k, *v)).collect();
        let mut b = Vec::new();
        ser.serialize(&rebuilt, &mut b).unwrap();
        assert_eq!(a, b);
        // count 3, then 1+4+2+1 twice and 1+16+2+1 once
        assert_eq!(a.len(), 1 + 8 + 8 + 20);

        let (rest, back) = ListenersDeserializer::new(3)
            .deserialize::<DeserializeError>(&a)
            .unwrap();
        assert!(rest.is_empty());
        assert_eq!(back, listeners);
        assert!(ListenersDeserializer::new(2)
            .deserialize::<DeserializeError>(&a)
            .is_err());
        assert!(ListenersDeserializer::new(3)
            .deserialize::<DeserializeError>(&a[..a.len() - 1])
            .is_err());
        // bad transport byte
        let mut bad = a.clone();
        *bad.last_mut().unwrap() = 9;
        assert!(ListenersDeserializer::new(3)
            .deserialize::<DeserializeError>(&bad)
            .is_err());
    }

    #[test]
    fn version_parse_display_compat() {
        let v = Version::from_str("GOSS.1.0").unwrap();
        assert_eq!(v.to_string(), "GOSS.1.0");
        assert_eq!(v.instance(), "GOSS");
        assert_eq!((v.major(), v.minor()), (1, 0));
        assert_eq!(Version::gossip_net(), v);
        assert!(v.is_compatible(&Version::from_str("GOSS.1.7").unwrap()));
        // the verdict frame changed shape in 1.0: older nodes are refused at the version
        // frame instead of failing to parse a verdict later
        assert!(!v.is_compatible(&Version::from_str("GOSS.0.1").unwrap()));
        assert!(!v.is_compatible(&Version::from_str("GOSS.2.0").unwrap()));
        assert!(!v.is_compatible(&Version::from_str("TEST.1.0").unwrap()));
        assert!(Version::from_str("goss.0.1").is_err());
        assert!(Version::from_str("GOSS.0").is_err());
        assert!(Version::from_str("GOSSI.0.1").is_err());
        assert!(Version::from_str("GOSS.x.1").is_err());
        assert!(Version::new("GOSS", 1, 2).is_ok());
        assert!(Version::new("GO", 1, 2).is_err());
    }

    #[test]
    fn version_wire_and_serde() {
        let v = Version::from_str("GOSS.300.1").unwrap();
        let mut buf = Vec::new();
        VersionSerializer::new().serialize(&v, &mut buf).unwrap();
        let (rest, back) = VersionDeserializer::new()
            .deserialize::<DeserializeError>(&buf)
            .unwrap();
        assert!(rest.is_empty());
        assert_eq!(back, v);
        // lowercase instance on the wire is rejected
        let mut bad = buf.clone();
        bad[0] = b'g';
        assert!(VersionDeserializer::new()
            .deserialize::<DeserializeError>(&bad)
            .is_err());
        let json = serde_json::to_string(&v).unwrap();
        assert_eq!(json, "\"GOSS.300.1\"");
        let back: Version = serde_json::from_str(&json).unwrap();
        assert_eq!(back, v);
        assert!(serde_json::from_str::<Version>("\"bad\"").is_err());
    }

    #[test]
    fn unix_millis_arith_and_wire() {
        let t = UnixMillis(1_000);
        assert_eq!(t.saturating_add(5).as_millis(), 1_005);
        assert_eq!(t.saturating_sub(5_000), UnixMillis(0));
        assert_eq!(UnixMillis(u64::MAX).saturating_add(1), UnixMillis(u64::MAX));
        assert_eq!(t.abs_diff(UnixMillis(400)), 600);
        assert_eq!(t.to_duration(), Duration::from_millis(1_000));
        assert!(UnixMillis::now() > UnixMillis(1_600_000_000_000));
        let soon = UnixMillis::now().saturating_add(10_000);
        assert!(soon.estimate_instant() > Instant::now());
        let past = UnixMillis(0);
        assert!(past.estimate_instant() <= Instant::now());

        let mut buf = Vec::new();
        UnixMillisSerializer::new().serialize(&t, &mut buf).unwrap();
        assert_eq!(buf, vec![0xe8, 0x07]);
        let (rest, back) = UnixMillisDeserializer::default()
            .deserialize::<DeserializeError>(&buf)
            .unwrap();
        assert!(rest.is_empty());
        assert_eq!(back, t);
        assert!(
            UnixMillisDeserializer::new(Included(UnixMillis(0)), Included(UnixMillis(999)))
                .deserialize::<DeserializeError>(&buf)
                .is_err()
        );
        assert_eq!(serde_json::to_string(&t).unwrap(), "1000");
        assert_eq!(serde_json::from_str::<UnixMillis>("1000").unwrap(), t);
    }
}
