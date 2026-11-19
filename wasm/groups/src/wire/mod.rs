//! The wire format (§13, Appendix C): the plaintext with its version prefix, the container,
//! frames, and event blobs with their own version prefix.
//!
//! ```text
//! plaintext = varint(PROTOCOL_VERSION) ‖ protobuf(Container)
//! eventBlob = varint(eventVersion) ‖ protobuf(Event)
//! ```

mod frames;
pub mod proto;
pub(crate) mod strict;

pub use frames::{
    Entry, EntryItem, Frame, LeaveRequest, NeighborRequest, NeighborResponse, Notice, Page, Query,
    QueryEntry, QueryOp, Response, ResponseResult, SignedKind, Status,
};

use crate::constants::{MAX_PLAINTEXT_BYTES, PROTOCOL_VERSION};
use crate::error::{Error, Result};
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

/// Whether an event blob of `blob_len` bytes fits one empty container (§4.6, §13.10): the
/// plaintext holding it alone in one event frame is at most 262,144 bytes.
#[must_use]
pub fn fits_empty_container(blob_len: usize) -> bool {
    single_frame_plaintext_len(len_field(blob_len)) <= MAX_PLAINTEXT_BYTES
}

/// A decoded plaintext: its version and each frame, decoded on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plaintext {
    /// The plaintext prefix version; event blobs inside are decoded against it.
    pub version: u64,
    /// Each frame, or why it was rejected. A bad frame does not reject the others.
    pub frames: Vec<Result<Frame>>,
}

/// Decodes a received plaintext (§13.1, §13.7, §13.8, §13.10).
///
/// The size limit is checked first, then the version prefix is read before any protobuf
/// parsing. An invalid container rejects the whole plaintext; each frame is then decoded and
/// validated on its own, and inside a query each entry is isolated.
///
/// # Errors
///
/// [`Error::PlaintextTooLarge`], [`Error::InvalidVersionPrefix`],
/// [`Error::UnsupportedHigherVersion`] (answer with [`version_notice`], at most once per peer
/// and version per 24 hours), [`Error::UnsupportedLowerVersion`] (drop silently), or
/// [`Error::Malformed`] for an invalid container.
pub fn decode_plaintext(bytes: &[u8]) -> Result<Plaintext> {
    if bytes.len() > MAX_PLAINTEXT_BYTES {
        return Err(Error::PlaintextTooLarge(bytes.len()));
    }
    let mut r = Reader::new(bytes);
    let version = r.varint().map_err(|_| Error::InvalidVersionPrefix)?;
    if version > PROTOCOL_VERSION {
        return Err(Error::UnsupportedHigherVersion(version));
    }
    if version < PROTOCOL_VERSION {
        return Err(Error::UnsupportedLowerVersion(version));
    }
    let container: proto::Container = strict::decode(r.rest(), &proto::CONTAINER)?;
    let frames = container.frames.iter().map(|f| Frame::decode(f)).collect();
    Ok(Plaintext { version, frames })
}

/// Encodes frames into one plaintext at [`PROTOCOL_VERSION`].
///
/// # Errors
///
/// A frame that breaks a rule of §13 or does not fit an empty container, or
/// [`Error::PlaintextTooLarge`] if the whole plaintext exceeds 262,144 bytes. Nothing is
/// fragmented (§13.10).
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
    let mut out = Vec::new();
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
