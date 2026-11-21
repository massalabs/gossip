//! BLE chunks (`docs/MESH.md`, "Chunks"): one network message is cut into chunks of at
//! most `min(ATT MTU − 3, 512)` bytes, each with a one-byte header.
//!
//! ```text
//! chunk  = u8 header ‖ body
//! header = kind (bits 7–6) ‖ stream (bits 5–0)
//! kind   = 0b00 single | 0b01 first | 0b10 middle | 0b11 last
//! first body = u32 BE total length ‖ first part
//! ```

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Largest message carried by a mesh link.
pub const MAX_MESSAGE: usize = 256 * 1024;
/// Most reassemblies open at once on one link.
pub const MAX_OPEN_STREAMS: usize = 8;
/// Most bytes buffered for reassembly on one link.
pub const MAX_BUFFERED: usize = 512 * 1024;
/// A stream with no chunk for this long is dropped.
pub const STREAM_TIMEOUT: Duration = Duration::from_secs(30);
/// Number of stream numbers.
pub const STREAMS: u8 = 64;
/// Longest attribute value Bluetooth allows, whatever the MTU: Android cuts a longer
/// write or notification to this length.
pub const MAX_ATT_VALUE: usize = 512;

/// The largest chunk a link with ATT MTU `mtu` carries whole.
pub fn max_chunk(mtu: i32) -> usize {
    (mtu.max(23) as usize).saturating_sub(3).min(MAX_ATT_VALUE)
}

const SINGLE: u8 = 0b00 << 6;
const FIRST: u8 = 0b01 << 6;
const MIDDLE: u8 = 0b10 << 6;
const LAST: u8 = 0b11 << 6;

/// Why a link must close.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChunkError {
    /// A chunk that does not follow the format or the bounds.
    #[error("chunk protocol violation: {0}")]
    Violation(&'static str),
}

/// Cuts `message` into chunks of at most `max_chunk` bytes on `stream`.
pub fn split(message: &[u8], max_chunk: usize, stream: u8) -> Vec<Vec<u8>> {
    let max_chunk = max_chunk.max(6);
    let stream = stream % STREAMS;
    if message.len() < max_chunk {
        let mut c = Vec::with_capacity(message.len() + 1);
        c.push(SINGLE | stream);
        c.extend_from_slice(message);
        return vec![c];
    }
    let mut out = Vec::new();
    let first_len = max_chunk - 5;
    let mut c = Vec::with_capacity(max_chunk);
    c.push(FIRST | stream);
    c.extend_from_slice(&(message.len() as u32).to_be_bytes());
    c.extend_from_slice(&message[..first_len]);
    out.push(c);
    let mut rest = &message[first_len..];
    while !rest.is_empty() {
        let n = rest.len().min(max_chunk - 1);
        let kind = if n == rest.len() { LAST } else { MIDDLE };
        let mut c = Vec::with_capacity(n + 1);
        c.push(kind | stream);
        c.extend_from_slice(&rest[..n]);
        out.push(c);
        rest = &rest[n..];
    }
    out
}

struct Partial {
    buf: Vec<u8>,
    total: usize,
    last: Instant,
}

/// Largest message before a link's handshake ends: the handshake messages are small.
pub const MAX_HANDSHAKE_MESSAGE: usize = 16 * 1024;

/// Reassembles the chunks of one link, in order.
pub struct Reassembler {
    streams: HashMap<u8, Partial>,
    buffered: usize,
    max_message: usize,
    max_buffered: usize,
}

impl Default for Reassembler {
    fn default() -> Self {
        Self::new()
    }
}

impl Reassembler {
    /// An empty reassembler for messages up to [`MAX_MESSAGE`].
    pub fn new() -> Self {
        Self::with_limit(MAX_MESSAGE)
    }

    /// An empty reassembler for messages up to `max_message` bytes (and twice that
    /// buffered, at most [`MAX_BUFFERED`]).
    pub fn with_limit(max_message: usize) -> Self {
        let max_message = max_message.min(MAX_MESSAGE);
        Self {
            streams: HashMap::new(),
            buffered: 0,
            max_message,
            max_buffered: max_message.saturating_mul(2).min(MAX_BUFFERED),
        }
    }

    /// Raises (or lowers) the message limit, for a link whose handshake ended.
    pub fn set_limit(&mut self, max_message: usize) {
        let buffered = self.buffered;
        *self = Self {
            streams: std::mem::take(&mut self.streams),
            buffered,
            ..Self::with_limit(max_message)
        };
    }

    /// Feeds one chunk; returns a complete message when this chunk ends one.
    pub fn push(&mut self, chunk: &[u8], now: Instant) -> Result<Option<Vec<u8>>, ChunkError> {
        self.expire(now);
        let (&header, body) = chunk
            .split_first()
            .ok_or(ChunkError::Violation("empty chunk"))?;
        let stream = header & 0x3f;
        match header & 0xc0 {
            SINGLE => {
                if self.streams.contains_key(&stream) {
                    return Err(ChunkError::Violation("single on a busy stream"));
                }
                if body.len() > self.max_message {
                    return Err(ChunkError::Violation("message too large"));
                }
                Ok(Some(body.to_vec()))
            }
            FIRST => {
                if self.streams.contains_key(&stream) {
                    return Err(ChunkError::Violation("first on a busy stream"));
                }
                if body.len() < 4 {
                    return Err(ChunkError::Violation("short first chunk"));
                }
                let total = u32::from_be_bytes(body[..4].try_into().expect("4 bytes")) as usize;
                let part = &body[4..];
                if total > self.max_message || part.len() >= total {
                    return Err(ChunkError::Violation("bad total length"));
                }
                if self.streams.len() >= MAX_OPEN_STREAMS {
                    return Err(ChunkError::Violation("too many open streams"));
                }
                self.charge(part.len())?;
                // grows with what arrives: only received bytes take memory
                let buf = part.to_vec();
                self.streams.insert(
                    stream,
                    Partial {
                        buf,
                        total,
                        last: now,
                    },
                );
                Ok(None)
            }
            kind => {
                let Some(p) = self.streams.get_mut(&stream) else {
                    return Err(ChunkError::Violation("continuation on an idle stream"));
                };
                if p.buf.len() + body.len() > p.total {
                    return Err(ChunkError::Violation("longer than announced"));
                }
                p.buf.extend_from_slice(body);
                p.last = now;
                let done = p.buf.len() == p.total;
                if kind == LAST && !done {
                    return Err(ChunkError::Violation("shorter than announced"));
                }
                if kind == MIDDLE && done {
                    return Err(ChunkError::Violation("middle chunk ends the message"));
                }
                self.charge(body.len())?;
                if done {
                    let p = self.streams.remove(&stream).expect("present");
                    self.buffered -= p.buf.len();
                    return Ok(Some(p.buf));
                }
                Ok(None)
            }
        }
    }

    fn charge(&mut self, n: usize) -> Result<(), ChunkError> {
        self.buffered += n;
        if self.buffered > self.max_buffered {
            return Err(ChunkError::Violation("too much buffered"));
        }
        Ok(())
    }

    fn expire(&mut self, now: Instant) {
        let mut freed = 0;
        self.streams.retain(|_, p| {
            let keep = now.duration_since(p.last) < STREAM_TIMEOUT;
            if !keep {
                freed += p.buf.len();
            }
            keep
        });
        self.buffered -= freed;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chunk_never_exceeds_the_longest_attribute_value() {
        assert_eq!(max_chunk(23), 20);
        assert_eq!(max_chunk(185), 182);
        assert_eq!(max_chunk(515), 512);
        // the MTU Android asks for: 514 bytes would arrive cut to 512
        assert_eq!(max_chunk(517), 512);
        assert_eq!(max_chunk(i32::MAX), 512);
    }

    #[test]
    fn messages_round_trip_whatever_the_size() {
        for len in [
            0usize,
            1,
            100,
            239,
            240,
            241,
            244,
            1000,
            3600,
            9000,
            MAX_MESSAGE,
        ] {
            let msg: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let chunks = split(&msg, 244, 7);
            assert!(chunks.iter().all(|c| c.len() <= 244));
            let mut r = Reassembler::new();
            let now = Instant::now();
            let mut out = None;
            for (i, c) in chunks.iter().enumerate() {
                let got = r.push(c, now).unwrap();
                if i + 1 < chunks.len() {
                    assert!(got.is_none());
                } else {
                    out = got;
                }
            }
            assert_eq!(out.unwrap(), msg, "len {len}");
        }
    }

    #[test]
    fn interleaved_streams_reassemble() {
        let a: Vec<u8> = vec![1; 1000];
        let b: Vec<u8> = vec![2; 30];
        let ca = split(&a, 100, 1);
        let cb = split(&b, 100, 2);
        let mut r = Reassembler::new();
        let now = Instant::now();
        assert!(r.push(&ca[0], now).unwrap().is_none());
        assert_eq!(r.push(&cb[0], now).unwrap().unwrap(), b);
        let mut got = None;
        for c in &ca[1..] {
            got = r.push(c, now).unwrap();
        }
        assert_eq!(got.unwrap(), a);
    }

    #[test]
    fn a_handshaking_link_takes_small_messages_only() {
        let now = Instant::now();
        let mut r = Reassembler::with_limit(MAX_HANDSHAKE_MESSAGE);
        let big = split(&vec![0u8; MAX_HANDSHAKE_MESSAGE + 1], 244, 0);
        assert!(r.push(&big[0], now).is_err(), "announced too large");
        // a first chunk claiming 256 KiB holds only what arrived
        let mut r = Reassembler::new();
        let mut first = vec![FIRST];
        first.extend_from_slice(&(MAX_MESSAGE as u32).to_be_bytes());
        first.extend_from_slice(&[0; 10]);
        r.push(&first, now).unwrap();
        assert_eq!(r.buffered, 10);
        let p = r.streams.get(&0).unwrap();
        assert!(
            p.buf.capacity() < 1024,
            "no allocation of the announced total"
        );
        // once ready, the full limit applies
        let mut r = Reassembler::with_limit(MAX_HANDSHAKE_MESSAGE);
        r.set_limit(MAX_MESSAGE);
        assert!(r.push(&big[0], now).is_ok());
    }

    #[test]
    fn violations_are_refused() {
        let now = Instant::now();
        let mut r = Reassembler::new();
        assert!(r.push(&[], now).is_err());
        assert!(r.push(&[MIDDLE | 3, 1, 2], now).is_err(), "idle stream");
        let mut big = vec![FIRST];
        big.extend_from_slice(&((MAX_MESSAGE as u32) + 1).to_be_bytes());
        big.push(0);
        assert!(Reassembler::new().push(&big, now).is_err());
        // a last chunk that ends early
        let chunks = split(&[9u8; 500], 100, 0);
        let mut r = Reassembler::new();
        r.push(&chunks[0], now).unwrap();
        assert!(r.push(&[LAST, 1], now).is_err());
        // too many open streams
        let mut r = Reassembler::new();
        for s in 0..MAX_OPEN_STREAMS as u8 {
            r.push(&split(&[0u8; 500], 100, s)[0], now).unwrap();
        }
        assert!(r.push(&split(&[0u8; 500], 100, 60)[0], now).is_err());
        // idle streams expire
        let later = now + STREAM_TIMEOUT + Duration::from_secs(1);
        assert!(r.push(&split(&[0u8; 500], 100, 61)[0], later).is_ok());
    }
}
