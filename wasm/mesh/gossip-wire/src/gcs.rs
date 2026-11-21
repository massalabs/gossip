//! Golomb-coded sets: the compact summaries two phones exchange when a mesh link comes
//! up (see `docs/MESH.md`, "Compact link-up").
//!
//! A set of `n` items is hashed into `[0, n × 2^p)`, sorted, and the differences between
//! successive values are Golomb-Rice coded with parameter `p`. Membership tests have a
//! false-positive rate of `2^-p` and no false negatives.

use crate::peer_id::PeerId;

/// Smallest Golomb-Rice parameter a summary may use.
pub const GCS_MIN_P: u8 = 4;
/// Largest Golomb-Rice parameter a summary may use.
pub const GCS_MAX_P: u8 = 16;
/// Most values in one summary.
pub const GCS_MAX_ITEMS: u64 = 65_536;
/// Parameter of a `HaveSummary` (blob ids): one false match in 256.
pub const HAVE_SUMMARY_P: u8 = 8;
/// Parameter of a `WantedSummary` (seekers): one false match in 1024.
pub const WANTED_SUMMARY_P: u8 = 10;

const KEY_CONTEXT: &str = "gossip/mesh/gcs/v1";

/// An encoded Golomb-coded set, as carried on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gcs {
    /// Golomb-Rice parameter.
    pub p: u8,
    /// Number of values.
    pub n: u64,
    /// The coded differences, most significant bit first, zero padded.
    pub bits: Vec<u8>,
}

/// Why a set does not decode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GcsError {
    /// `p` or `n` out of bounds, or more bytes than `n` values can take.
    Bounds,
    /// The bits end before `n` values, a value reaches `n × 2^p`, or the padding is not
    /// zero.
    Malformed,
}

impl Gcs {
    /// Largest byte length `n` values coded with `p` can take: the quotients of sorted
    /// values below `n × 2^p` add up to less than `n`, so at most `n × (p + 2)` bits.
    pub fn max_len(n: u64, p: u8) -> u64 {
        (n * (u64::from(p) + 2)).div_ceil(8)
    }

    /// Whether `p`, `n` and the byte length are within bounds.
    pub fn in_bounds(&self) -> bool {
        (GCS_MIN_P..=GCS_MAX_P).contains(&self.p)
            && self.n <= GCS_MAX_ITEMS
            && self.bits.len() as u64 <= Self::max_len(self.n, self.p)
    }

    /// Codes `values`, which must all be below `n × 2^p` for `n = values.len()`.
    pub fn encode(mut values: Vec<u64>, p: u8) -> Self {
        values.sort_unstable();
        let mut writer = BitWriter::default();
        let mut last = 0;
        for v in &values {
            let d = v - last;
            last = *v;
            for _ in 0..(d >> p) {
                writer.push(true);
            }
            writer.push(false);
            for i in (0..p).rev() {
                writer.push((d >> i) & 1 == 1);
            }
        }
        Self {
            p,
            n: values.len() as u64,
            bits: writer.finish(),
        }
    }

    /// The sorted values.
    pub fn decode(&self) -> Result<Vec<u64>, GcsError> {
        if !self.in_bounds() {
            return Err(GcsError::Bounds);
        }
        let range = self.n << self.p;
        let mut reader = BitReader::new(&self.bits);
        let mut values = Vec::with_capacity(self.n as usize);
        let mut last = 0u64;
        for _ in 0..self.n {
            let mut q = 0u64;
            loop {
                match reader.next() {
                    Some(true) => q += 1,
                    Some(false) => break,
                    None => return Err(GcsError::Malformed),
                }
                if q >= self.n {
                    return Err(GcsError::Malformed);
                }
            }
            let mut r = 0u64;
            for _ in 0..self.p {
                r = (r << 1) | u64::from(reader.next().ok_or(GcsError::Malformed)?);
            }
            last += (q << self.p) | r;
            if last >= range {
                return Err(GcsError::Malformed);
            }
            values.push(last);
        }
        if !reader.only_padding_left() {
            return Err(GcsError::Malformed);
        }
        Ok(values)
    }
}

/// The hash key of the link between `a` and `b` (the same on both ends).
pub fn link_key(a: &PeerId, b: &PeerId) -> [u8; 32] {
    let (a, b) = (a.to_bytes(), b.to_bytes());
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut material = lo;
    material.extend_from_slice(&hi);
    blake3::derive_key(KEY_CONTEXT, &material)
}

/// The value of `item` in a set of `n` values coded with `p`.
pub fn item_value(key: &[u8; 32], item: &[u8], n: u64, p: u8) -> u64 {
    let hash = blake3::keyed_hash(key, item);
    let h = u64::from_be_bytes(hash.as_bytes()[..8].try_into().expect("8 bytes"));
    ((u128::from(h) * u128::from(n << p)) >> 64) as u64
}

/// Codes `items` into a set keyed by `key`; also returns each item's value, in the
/// order of `items`.
pub fn summarise<'a>(
    key: &[u8; 32],
    items: impl ExactSizeIterator<Item = &'a [u8]>,
    p: u8,
) -> (Gcs, Vec<u64>) {
    let n = items.len() as u64;
    let values: Vec<u64> = items.map(|item| item_value(key, item, n, p)).collect();
    (Gcs::encode(values.clone(), p), values)
}

#[derive(Default)]
struct BitWriter {
    bytes: Vec<u8>,
    used: u8,
}

impl BitWriter {
    fn push(&mut self, bit: bool) {
        if self.used == 0 {
            self.bytes.push(0);
        }
        if bit {
            *self.bytes.last_mut().expect("pushed") |= 0x80 >> self.used;
        }
        self.used = (self.used + 1) % 8;
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

struct BitReader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> BitReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn next(&mut self) -> Option<bool> {
        let byte = self.bytes.get(self.pos / 8)?;
        let bit = byte & (0x80 >> (self.pos % 8)) != 0;
        self.pos += 1;
        Some(bit)
    }

    /// Whether what is left is the zero padding of the last byte.
    fn only_padding_left(&self) -> bool {
        let total = self.bytes.len() * 8;
        if total - self.pos >= 8 {
            return false;
        }
        (self.pos..total).all(|i| self.bytes[i / 8] & (0x80 >> (i % 8)) == 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use massa_signature::KeyPair;

    fn peer() -> PeerId {
        PeerId::from_public_key(KeyPair::generate(0).unwrap().get_public_key())
    }

    #[test]
    fn round_trips_and_has_no_false_negatives() {
        let key = link_key(&peer(), &peer());
        for (count, p) in [
            (0usize, 8u8),
            (1, 4),
            (7, 8),
            (1000, 8),
            (3000, 10),
            (500, 16),
        ] {
            let items: Vec<[u8; 32]> = (0..count)
                .map(|i| *blake3::hash(&(i as u64).to_be_bytes()).as_bytes())
                .collect();
            let (gcs, values) = summarise(&key, items.iter().map(|i| i.as_slice()), p);
            assert!(gcs.in_bounds());
            let decoded = gcs.decode().unwrap();
            assert_eq!(decoded.len(), count);
            for v in values {
                assert!(decoded.binary_search(&v).is_ok());
            }
            // about p + 1.5 bits per value
            if count >= 1000 {
                let bits_per = gcs.bits.len() as f64 * 8.0 / count as f64;
                assert!(bits_per < f64::from(p) + 2.0, "{bits_per} bits at p={p}");
            }
        }
    }

    #[test]
    fn false_positive_rate_is_about_two_to_minus_p() {
        let key = link_key(&peer(), &peer());
        let n = 4000u64;
        let items: Vec<[u8; 8]> = (0..n).map(|i| i.to_be_bytes()).collect();
        let (gcs, _) = summarise(&key, items.iter().map(|i| i.as_slice()), 8);
        let decoded = gcs.decode().unwrap();
        let probes = 20_000u64;
        let hits = (n..n + probes)
            .filter(|i| {
                decoded
                    .binary_search(&item_value(&key, &i.to_be_bytes(), n, 8))
                    .is_ok()
            })
            .count();
        let rate = hits as f64 / probes as f64;
        assert!(rate < 2.0 / 256.0, "false positive rate {rate}");
    }

    #[test]
    fn both_ends_share_the_key_and_other_links_do_not() {
        let (a, b, c) = (peer(), peer(), peer());
        assert_eq!(link_key(&a, &b), link_key(&b, &a));
        assert_ne!(link_key(&a, &b), link_key(&a, &c));
    }

    #[test]
    fn malformed_sets_are_refused() {
        let good = Gcs::encode(vec![3, 300, 700], 8);
        assert!(good.decode().is_ok());
        // truncated
        let mut short = good.clone();
        short.bits.pop();
        assert!(short.decode().is_err());
        // a value at or above n × 2^p
        let big = Gcs::encode(vec![3 << 8], 8);
        assert_eq!(
            Gcs {
                n: 3,
                ..big.clone()
            }
            .decode(),
            Err(GcsError::Malformed)
        );
        assert_eq!(
            Gcs {
                n: 1,
                ..Gcs::encode(vec![1 << 8], 8)
            }
            .decode(),
            Err(GcsError::Malformed)
        );
        // trailing garbage, non-zero padding
        let mut trailing = good.clone();
        trailing.bits.push(0);
        assert!(trailing.decode().is_err());
        let mut padded = Gcs::encode(vec![1], 4);
        *padded.bits.last_mut().unwrap() |= 1;
        assert_eq!(padded.decode(), Err(GcsError::Malformed));
        // bounds
        assert_eq!(
            Gcs {
                p: 3,
                ..good.clone()
            }
            .decode(),
            Err(GcsError::Bounds)
        );
        assert_eq!(
            Gcs {
                n: GCS_MAX_ITEMS + 1,
                ..good.clone()
            }
            .decode(),
            Err(GcsError::Bounds)
        );
        let mut long = good;
        long.bits.resize(Gcs::max_len(3, 8) as usize + 1, 0);
        assert_eq!(long.decode(), Err(GcsError::Bounds));
    }
}
