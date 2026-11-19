//! The wire format (§13, Appendix C): the plaintext with its version prefix, the container,
//! frames, and event blobs with their own version prefix.
//!
//! ```text
//! plaintext = varint(PROTOCOL_VERSION) ‖ protobuf(Container)
//! eventBlob = varint(eventVersion) ‖ protobuf(Event)
//! ```
//!
//! [`decode_plaintext`] and [`decode_event_blob`] are the only ways in, and
//! [`encode_plaintext`] and [`encode_event_blob`] the only ways out: each runs the strict check
//! of Appendix C before `prost` sees the bytes, and the limits of §13.10. The protobuf structs
//! and the conversions of the typed objects to and from them stay inside the crate, so that a
//! caller cannot decode with `prost` directly and skip those checks.
//!
//! ```compile_fail
//! use groups::wire::proto;
//! ```
//!
//! ```compile_fail
//! let _ = groups::Leave::from_proto(&Default::default());
//! ```
//!
//! ```compile_fail
//! let _ = groups::Root::from_proto(1, Default::default());
//! ```

mod frames;
pub(crate) mod proto;
pub(crate) mod strict;

pub use frames::{
    Entry, EntryItem, Frame, LeaveRequest, NeighborRequest, NeighborResponse, Notice, Page, Query,
    QueryEntry, QueryOp, Response, ResponseResult, SignedKind, Status,
};

use std::collections::BTreeMap;

use crate::constants::{
    EVENT_VERSION, MAX_EVENT_BLOB_BYTES, MAX_PLAINTEXT_BYTES, PROTOCOL_VERSION, REQUEST_ID_SIZE,
};
use crate::error::{Error, Result};
use crate::event::MessageEvent;
use crate::root::Root;
use crate::signed::{Dissolve, Kick, Leave};
use strict::Reader;

/// Number of bytes of `value` as a protobuf varint.
#[must_use]
pub fn varint_len(value: u64) -> usize {
    prost::encoding::encoded_len_varint(value)
}

fn encode_varint(value: u64, out: &mut Vec<u8>) {
    prost::encoding::encode_varint(value, out);
}

/// Size of a length-delimited field whose key fits one byte (field numbers 1 to 15).
fn len_field(inner: usize) -> usize {
    1 + varint_len(inner as u64) + inner
}

/// Size of message metadata as [`crate::constants::MAX_METADATA_BYTES`] counts it: the
/// `metadata` field of `MessagePayload` (number 10) in its canonical encoding, computed from
/// the decoded map, so the same on every device whatever encoding was received.
#[must_use]
pub fn metadata_len(metadata: &BTreeMap<String, Vec<u8>>) -> usize {
    prost::encoding::btree_map::encoded_len(
        prost::encoding::string::encoded_len,
        prost::encoding::bytes::encoded_len,
        proto::METADATA_FIELD,
        metadata,
    )
}

/// Size of an event blob whose `Event` holds one kind of `inner_len` encoded bytes.
#[must_use]
pub fn event_blob_len(version: u64, inner_len: usize) -> usize {
    varint_len(version) + len_field(inner_len)
}

/// Size of a plaintext holding a single frame of `frame_len` encoded bytes.
#[must_use]
pub fn single_frame_plaintext_len(frame_len: usize) -> usize {
    varint_len(PROTOCOL_VERSION) + len_field(frame_len)
}

/// Size of the largest frame that can carry an event blob of `blob_len` bytes: a response
/// frame with a full `request_id` and the longest `idx` encoding (a `u32`), which is larger
/// than an event frame.
#[must_use]
pub fn largest_carrier_frame_len(blob_len: usize) -> usize {
    let response =
        len_field(REQUEST_ID_SIZE) + 1 + varint_len(u64::from(u32::MAX)) + len_field(blob_len);
    len_field(response).max(len_field(blob_len))
}

/// Whether an event blob of `blob_len` bytes fits one empty container (§4.6, §13.10) in any
/// frame that can carry it: the plaintext holding it alone in a response frame with the
/// largest `request_id` and `idx` is at most [`MAX_PLAINTEXT_BYTES`], that is the blob is at
/// most [`MAX_EVENT_BLOB_BYTES`]. §13.10 states the bound for an event frame; an event admitted by
/// it could not always be served in an answer.
#[must_use]
pub fn fits_empty_container(blob_len: usize) -> bool {
    blob_len <= MAX_EVENT_BLOB_BYTES
}

/// A root, a signed object or a message event: the content of an event blob (§13.1).
///
/// `==` compares the signatures of roots and signed objects, which differ between two valid
/// copies of one object; deduplicate by ID (see [`Root`] and [`Leave`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventObject {
    /// `GROUP_ROOT` (boxed: a root carries the owner's keys inline).
    Root(Box<Root>),
    /// `GROUP_MESSAGE_EVENT`.
    Message(MessageEvent),
    /// `LEAVE`.
    Leave(Leave),
    /// `KICK`.
    Kick(Kick),
    /// `DISSOLVE`.
    Dissolve(Dissolve),
}

impl EventObject {
    /// The event version the object is encoded under.
    #[must_use]
    pub fn version(&self) -> u64 {
        match self {
            EventObject::Root(r) => r.version(),
            EventObject::Message(m) => m.version(),
            // Signed objects exist only in version 1; they keep no other version.
            EventObject::Leave(_) | EventObject::Kick(_) | EventObject::Dissolve(_) => {
                EVENT_VERSION
            }
        }
    }

    fn to_proto(&self) -> proto::EventKind {
        match self {
            EventObject::Root(r) => proto::EventKind::GroupRoot(r.to_proto()),
            EventObject::Message(m) => proto::EventKind::GroupMessageEvent(m.to_proto()),
            EventObject::Leave(l) => proto::EventKind::Leave(l.to_proto()),
            EventObject::Kick(k) => proto::EventKind::Kick(k.to_proto()),
            EventObject::Dissolve(d) => proto::EventKind::Dissolve(d.to_proto()),
        }
    }
}

/// Encodes an event blob under the object's own version.
///
/// # Errors
///
/// [`Error::DoesNotFitContainer`] if the blob would not fit one empty container (§13.10).
pub fn encode_event_blob(object: &EventObject) -> Result<Vec<u8>> {
    let event = proto::Event {
        kind: Some(object.to_proto()),
    };
    // Sized exactly, so that growing leaves no stray copy of a root's group secret.
    let mut out =
        Vec::with_capacity(varint_len(object.version()) + prost::Message::encoded_len(&event));
    encode_varint(object.version(), &mut out);
    prost::Message::encode(&event, &mut out).expect("a Vec grows as needed");
    if !fits_empty_container(out.len()) {
        return Err(Error::DoesNotFitContainer);
    }
    Ok(out)
}

/// Decodes and validates an event blob carried in a plaintext of version `plaintext_version`
/// (§13.1).
///
/// The event version is read first; it must be at most the plaintext's and supported. The
/// object is then validated under its own version: roots by §4.7 steps 1 and 3, message
/// events by §6.1, §6.2 and §7.2, signed objects by their field lengths. Signatures, secret
/// proofs and membership need the epoch and are checked separately.
///
/// # Errors
///
/// [`Error::EventVersionAbovePlaintext`], [`Error::UnsupportedEventVersion`],
/// [`Error::DoesNotFitContainer`], [`Error::Malformed`] or the rule the object breaks.
pub fn decode_event_blob(blob: &[u8], plaintext_version: u64) -> Result<EventObject> {
    let mut r = Reader::new(blob);
    let version = r.varint().map_err(|_| Error::InvalidVersionPrefix)?;
    if version > plaintext_version {
        return Err(Error::EventVersionAbovePlaintext {
            event: version,
            plaintext: plaintext_version,
        });
    }
    if version != EVENT_VERSION {
        return Err(Error::UnsupportedEventVersion(version));
    }
    if !fits_empty_container(blob.len()) {
        return Err(Error::DoesNotFitContainer);
    }
    let event: proto::Event = strict::decode(r.rest(), &proto::EVENT)?;
    match event.kind.ok_or(Error::Missing("event kind"))? {
        proto::EventKind::GroupRoot(p) => {
            Root::from_proto(version, p).map(|r| EventObject::Root(Box::new(r)))
        }
        proto::EventKind::GroupMessageEvent(p) => {
            MessageEvent::from_proto(version, p).map(EventObject::Message)
        }
        proto::EventKind::Leave(p) => Leave::from_proto(&p).map(EventObject::Leave),
        proto::EventKind::Kick(p) => Kick::from_proto(&p).map(EventObject::Kick),
        proto::EventKind::Dissolve(p) => Dissolve::from_proto(&p).map(EventObject::Dissolve),
    }
}

/// A received plaintext whose prefix and container passed the checks of §13.1 and §13.8.
///
/// Frames are decoded one at a time by [`Plaintext::frames`], so that nothing is built for a
/// frame before it is judged: a full plaintext of 57,344 bytes can hold 28,671 empty frames,
/// and decoding them all at once would allocate far more than the plaintext itself.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Plaintext<'a> {
    /// The plaintext prefix version; event blobs inside are decoded against it.
    pub version: u64,
    /// The encoded `Container`, already checked.
    container: &'a [u8],
}

impl<'a> Plaintext<'a> {
    /// Each frame in order, decoded and validated on its own, or why it was rejected. A bad
    /// frame does not reject the others.
    pub fn frames(&self) -> impl Iterator<Item = Result<Frame>> + 'a {
        let mut r = Reader::new(self.container);
        core::iter::from_fn(move || {
            if r.is_empty() {
                return None;
            }
            // The container passed the strict check: every field is a complete `frames`.
            let frame = r.varint().and_then(|_| r.len_delimited());
            Some(frame.and_then(Frame::decode))
        })
    }
}

impl core::fmt::Debug for Plaintext<'_> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Plaintext")
            .field("version", &self.version)
            .field("container", &crate::redact::Bytes(self.container.len()))
            .finish()
    }
}

/// Decodes a received plaintext (§13.1, §13.7, §13.8, §13.10).
///
/// The version prefix is read first, before any other check, the size limit included: a
/// later wire version may have a larger container, and its sender must still learn that this
/// device speaks version 1. Only the varint prefix of a plaintext of another version is read
/// (at most ten bytes); nothing more of it is parsed or kept. A prefix that is no valid varint
/// is a damaged plaintext. For version 1, the size limit comes next, then the container: an
/// invalid one rejects the whole plaintext; each frame is then decoded and validated on its
/// own by [`Plaintext::frames`], and inside a query each entry is isolated.
///
/// # Errors
///
/// [`Error::InvalidVersionPrefix`], [`Error::UnsupportedHigherVersion`] (answered with
/// [`version_notice`] under the rules of [`crate::node`]), [`Error::UnsupportedLowerVersion`]
/// (dropped silently), [`Error::PlaintextTooLarge`], or [`Error::Malformed`] for an invalid
/// container.
pub fn decode_plaintext(bytes: &[u8]) -> Result<Plaintext<'_>> {
    let mut r = Reader::new(bytes);
    let version = r.varint().map_err(|_| Error::InvalidVersionPrefix)?;
    if version > PROTOCOL_VERSION {
        return Err(Error::UnsupportedHigherVersion(version));
    }
    if version < PROTOCOL_VERSION {
        return Err(Error::UnsupportedLowerVersion(version));
    }
    if bytes.len() > MAX_PLAINTEXT_BYTES {
        return Err(Error::PlaintextTooLarge(bytes.len()));
    }
    strict::check(r.rest(), &proto::CONTAINER)?;
    Ok(Plaintext {
        version,
        container: r.rest(),
    })
}

/// Encodes frames into one plaintext at [`PROTOCOL_VERSION`].
///
/// # Errors
///
/// A frame that breaks a rule of §13 or does not fit an empty container, or
/// [`Error::PlaintextTooLarge`] if the whole plaintext exceeds [`MAX_PLAINTEXT_BYTES`].
/// Nothing is fragmented (§13.10).
pub fn encode_plaintext(frames: &[Frame]) -> Result<Vec<u8>> {
    let mut container = proto::Container {
        frames: Vec::with_capacity(frames.len()),
    };
    for frame in frames {
        let encoded = frame.encode()?;
        if single_frame_plaintext_len(encoded.len()) > MAX_PLAINTEXT_BYTES {
            return Err(Error::DoesNotFitContainer);
        }
        container.frames.push(encoded);
    }
    // Sized exactly, so that growing leaves no stray copy of an event blob; the encoded
    // frames are zeroed when `container` is dropped.
    let mut out =
        Vec::with_capacity(varint_len(PROTOCOL_VERSION) + prost::Message::encoded_len(&container));
    encode_varint(PROTOCOL_VERSION, &mut out);
    prost::Message::encode(&container, &mut out).expect("a Vec grows as needed");
    if out.len() > MAX_PLAINTEXT_BYTES {
        return Err(Error::PlaintextTooLarge(out.len()));
    }
    Ok(out)
}

/// The version notice of §13.8: one plaintext at this receiver's highest version holding one
/// response frame with an empty `request_id`, `idx = 0` and status `unsupported`.
#[must_use]
pub fn version_notice() -> Vec<u8> {
    encode_plaintext(&[Frame::Response(Response {
        request_id: None,
        idx: 0,
        result: ResponseResult::Status(Status::Unsupported),
    })])
    .expect("the version notice is valid and small")
}

#[cfg(test)]
mod tests;
