//! Deterministic CBOR encoding of hash projections (§1.2).
//!
//! Every protocol hash is computed over a CBOR array in the core deterministic encoding of
//! RFC 8949 §4.2.1:
//!
//! - integer arguments (values, lengths, counts) use the shortest form;
//! - every array, map, byte string and text string has a definite length;
//! - map keys are sorted by the bytewise lexicographic order of their deterministic encodings,
//!   and no key appears twice.
//!
//! Hash inputs use only unsigned integers, byte strings, UTF-8 text strings, arrays, maps,
//! booleans and null (§1.2), so only those are representable here. Only an encoder is needed:
//! the protocol never decodes CBOR.

/// A CBOR data item of a hash projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value<'a> {
    /// Major type 0: an unsigned integer.
    Uint(u64),
    /// Major type 2: a byte string.
    Bytes(&'a [u8]),
    /// Major type 3: a UTF-8 text string.
    Text(&'a str),
    /// Major type 4: an array.
    Array(Vec<Value<'a>>),
    /// Major type 5: a map. Entries are sorted when encoded; keys must be distinct.
    Map(Vec<(Value<'a>, Value<'a>)>),
    /// Simple values 20 (false) and 21 (true).
    Bool(bool),
    /// Simple value 22.
    Null,
}

const MAJOR_UINT: u8 = 0;
const MAJOR_BYTES: u8 = 2;
const MAJOR_TEXT: u8 = 3;
const MAJOR_ARRAY: u8 = 4;
const MAJOR_MAP: u8 = 5;
const SIMPLE_FALSE: u8 = 0xf4;
const SIMPLE_TRUE: u8 = 0xf5;
const SIMPLE_NULL: u8 = 0xf6;

/// Writes a major type with its argument in the shortest form (RFC 8949 §4.2.1).
fn write_head(out: &mut Vec<u8>, major: u8, arg: u64) {
    let m = major << 5;
    if arg < 24 {
        // The argument fits the additional information itself.
        out.push(m | arg as u8);
    } else if let Ok(a) = u8::try_from(arg) {
        out.push(m | 24);
        out.push(a);
    } else if let Ok(a) = u16::try_from(arg) {
        out.push(m | 25);
        out.extend_from_slice(&a.to_be_bytes());
    } else if let Ok(a) = u32::try_from(arg) {
        out.push(m | 26);
        out.extend_from_slice(&a.to_be_bytes());
    } else {
        out.push(m | 27);
        out.extend_from_slice(&arg.to_be_bytes());
    }
}

/// The size of a head written by [`write_head`].
fn head_len(arg: u64) -> usize {
    match arg {
        0..24 => 1,
        24..=0xff => 2,
        0x100..=0xffff => 3,
        0x1_0000..=0xffff_ffff => 5,
        _ => 9,
    }
}

fn len_arg(len: usize) -> u64 {
    // usize is at most 64 bits on every supported target.
    u64::try_from(len).expect("length fits u64")
}

impl Value<'_> {
    /// Appends the deterministic encoding of this item to `out`.
    pub fn encode_into(&self, out: &mut Vec<u8>) {
        match self {
            Value::Uint(v) => write_head(out, MAJOR_UINT, *v),
            Value::Bytes(b) => {
                write_head(out, MAJOR_BYTES, len_arg(b.len()));
                out.extend_from_slice(b);
            }
            Value::Text(s) => {
                write_head(out, MAJOR_TEXT, len_arg(s.len()));
                out.extend_from_slice(s.as_bytes());
            }
            Value::Array(items) => {
                write_head(out, MAJOR_ARRAY, len_arg(items.len()));
                for item in items {
                    item.encode_into(out);
                }
            }
            Value::Map(entries) => {
                let mut encoded: Vec<(Vec<u8>, Vec<u8>)> = entries
                    .iter()
                    .map(|(k, v)| (k.encode(), v.encode()))
                    .collect();
                encoded.sort_by(|a, b| a.0.cmp(&b.0));
                assert!(
                    encoded.windows(2).all(|w| w[0].0 != w[1].0),
                    "deterministic CBOR forbids duplicate map keys"
                );
                write_head(out, MAJOR_MAP, len_arg(encoded.len()));
                for (k, v) in encoded {
                    out.extend_from_slice(&k);
                    out.extend_from_slice(&v);
                }
            }
            Value::Bool(false) => out.push(SIMPLE_FALSE),
            Value::Bool(true) => out.push(SIMPLE_TRUE),
            Value::Null => out.push(SIMPLE_NULL),
        }
    }

    /// The size of the deterministic encoding of this item.
    #[must_use]
    pub fn encoded_len(&self) -> usize {
        match self {
            Value::Uint(v) => head_len(*v),
            Value::Bytes(b) => head_len(len_arg(b.len())) + b.len(),
            Value::Text(s) => head_len(len_arg(s.len())) + s.len(),
            Value::Array(items) => {
                head_len(len_arg(items.len())) + items.iter().map(Value::encoded_len).sum::<usize>()
            }
            Value::Map(entries) => {
                head_len(len_arg(entries.len()))
                    + entries
                        .iter()
                        .map(|(k, v)| k.encoded_len() + v.encoded_len())
                        .sum::<usize>()
            }
            Value::Bool(_) | Value::Null => 1,
        }
    }

    /// Returns the deterministic encoding of this item, in a buffer of exactly its size (so
    /// that growing it leaves no stray copy of a secret item).
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.encoded_len());
        self.encode_into(&mut out);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The encoding in hex; also checks that `encoded_len` is exact.
    fn hex(v: &Value<'_>) -> String {
        let encoded = v.encode();
        assert_eq!(v.encoded_len(), encoded.len());
        hex::encode(encoded)
    }

    #[test]
    fn encoded_len_is_exact_for_long_items() {
        for n in [23, 24, 255, 256, 65_535, 65_536] {
            let bytes = vec![7; n];
            let text = "a".repeat(n);
            let items = vec![Value::Null; n];
            for v in [
                Value::Bytes(&bytes),
                Value::Text(&text),
                Value::Array(items.clone()),
            ] {
                assert_eq!(v.encoded_len(), v.encode().len());
            }
        }
    }

    // Vectors from RFC 8949 Appendix A.
    #[test]
    fn unsigned_integers_use_the_shortest_form() {
        assert_eq!(hex(&Value::Uint(0)), "00");
        assert_eq!(hex(&Value::Uint(1)), "01");
        assert_eq!(hex(&Value::Uint(10)), "0a");
        assert_eq!(hex(&Value::Uint(23)), "17");
        assert_eq!(hex(&Value::Uint(24)), "1818");
        assert_eq!(hex(&Value::Uint(25)), "1819");
        assert_eq!(hex(&Value::Uint(100)), "1864");
        assert_eq!(hex(&Value::Uint(255)), "18ff");
        assert_eq!(hex(&Value::Uint(256)), "190100");
        assert_eq!(hex(&Value::Uint(1000)), "1903e8");
        assert_eq!(hex(&Value::Uint(65_535)), "19ffff");
        assert_eq!(hex(&Value::Uint(65_536)), "1a00010000");
        assert_eq!(hex(&Value::Uint(1_000_000)), "1a000f4240");
        assert_eq!(hex(&Value::Uint(4_294_967_295)), "1affffffff");
        assert_eq!(hex(&Value::Uint(4_294_967_296)), "1b0000000100000000");
        assert_eq!(hex(&Value::Uint(1_000_000_000_000)), "1b000000e8d4a51000");
        assert_eq!(hex(&Value::Uint(u64::MAX)), "1bffffffffffffffff");
    }

    #[test]
    fn strings_and_simple_values() {
        assert_eq!(hex(&Value::Bytes(&[])), "40");
        assert_eq!(hex(&Value::Bytes(&[1, 2, 3, 4])), "4401020304");
        assert_eq!(hex(&Value::Text("")), "60");
        assert_eq!(hex(&Value::Text("a")), "6161");
        assert_eq!(hex(&Value::Text("IETF")), "6449455446");
        assert_eq!(hex(&Value::Text("\u{00fc}")), "62c3bc");
        assert_eq!(hex(&Value::Text("\u{6c34}")), "63e6b0b4");
        assert_eq!(hex(&Value::Bool(false)), "f4");
        assert_eq!(hex(&Value::Bool(true)), "f5");
        assert_eq!(hex(&Value::Null), "f6");
        // A 24-byte string needs a one-byte length argument.
        assert_eq!(&hex(&Value::Bytes(&[0u8; 24]))[..4], "5818");
        assert_eq!(&hex(&Value::Bytes(&[0u8; 256]))[..6], "590100");
    }

    #[test]
    fn arrays_and_nesting() {
        assert_eq!(hex(&Value::Array(vec![])), "80");
        assert_eq!(
            hex(&Value::Array(vec![
                Value::Uint(1),
                Value::Uint(2),
                Value::Uint(3)
            ])),
            "83010203"
        );
        assert_eq!(
            hex(&Value::Array(vec![
                Value::Uint(1),
                Value::Array(vec![Value::Uint(2), Value::Uint(3)]),
                Value::Array(vec![Value::Uint(4), Value::Uint(5)]),
            ])),
            "8301820203820405"
        );
        let items: Vec<Value<'_>> = (1..=25).map(Value::Uint).collect();
        assert_eq!(
            hex(&Value::Array(items)),
            "98190102030405060708090a0b0c0d0e0f101112131415161718181819"
        );
    }

    #[test]
    fn map_keys_are_sorted_by_their_encoding() {
        assert_eq!(hex(&Value::Map(vec![])), "a0");
        // RFC 8949 Appendix A: {"a": 1, "b": [2, 3]}, given out of order.
        let m = Value::Map(vec![
            (
                Value::Text("b"),
                Value::Array(vec![Value::Uint(2), Value::Uint(3)]),
            ),
            (Value::Text("a"), Value::Uint(1)),
        ]);
        assert_eq!(hex(&m), "a26161016162820203");
        // Bytewise order of encodings puts the shorter key first: "z" (0x617a) before
        // "aa" (0x626161), unlike plain string order.
        let m = Value::Map(vec![
            (Value::Text("aa"), Value::Bytes(&[])),
            (Value::Text("z"), Value::Bytes(&[])),
        ]);
        assert_eq!(hex(&m), "a2617a4062616140");
    }

    #[test]
    #[should_panic(expected = "duplicate map keys")]
    fn duplicate_map_keys_are_refused() {
        let _ = Value::Map(vec![
            (Value::Text("a"), Value::Uint(1)),
            (Value::Text("a"), Value::Uint(2)),
        ])
        .encode();
    }
}
