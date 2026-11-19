//! Strict protobuf check run before every decode (§1.1, §13.8).
//!
//! The schema of a protocol version is closed. This walks the raw protobuf encoding against
//! the field numbers, wire types and enum values of Appendix C and rejects:
//!
//! - an unknown field number (this also covers an unknown `oneof` case);
//! - a known field with the wrong wire type, or a group wire type;
//! - an enum value that the schema does not define (status 1 is reserved, so unknown);
//! - a `uint32` above `u32::MAX` and a `bool` other than 0 or 1, which a decoder would
//!   otherwise convert lossily (§1.1);
//! - a truncated field or a varint longer than 64 bits.
//!
//! Repeated fields and repeated occurrences of a singular field are accepted as protobuf
//! defines them (the last scalar wins, embedded messages merge): they are other encodings of
//! field values, and no hash covers the encoded bytes (§13.1).

use crate::error::{Error, Result};

/// How a field is encoded, and what its value may be.
#[derive(Debug)]
pub(crate) enum Kind {
    /// `uint64`: any varint.
    Uint64,
    /// `uint32`: a varint at most `u32::MAX`.
    Uint32,
    /// `bool`: a varint 0 or 1.
    Bool,
    /// An enum: a varint among the listed values.
    Enum(&'static [u64]),
    /// `bytes`.
    Bytes,
    /// An embedded message, checked recursively.
    Msg(&'static Schema),
    /// A length-delimited field checked separately by the caller (an embedded message whose
    /// failure is isolated, or an event blob with its own version).
    Opaque,
}

/// The known fields of one message.
#[derive(Debug)]
pub(crate) struct Schema {
    pub name: &'static str,
    pub fields: &'static [(u32, Kind)],
}

const WIRE_VARINT: u64 = 0;
const WIRE_LEN: u64 = 2;

/// A cursor over protobuf bytes.
pub(crate) struct Reader<'a> {
    buf: &'a [u8],
}

impl<'a> Reader<'a> {
    pub(crate) fn new(buf: &'a [u8]) -> Self {
        Self { buf }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub(crate) fn rest(&self) -> &'a [u8] {
        self.buf
    }

    /// Reads a protobuf unsigned varint of at most 10 bytes whose value fits 64 bits.
    pub(crate) fn varint(&mut self) -> Result<u64> {
        let mut value: u64 = 0;
        for i in 0..10 {
            let Some((&byte, rest)) = self.buf.split_first() else {
                return Err(Error::Malformed("truncated varint"));
            };
            self.buf = rest;
            let bits = u64::from(byte & 0x7f);
            if i == 9 && bits > 1 {
                return Err(Error::Malformed("varint exceeds 64 bits"));
            }
            value |= bits << (7 * i);
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(Error::Malformed("varint exceeds 64 bits"))
    }

    fn len_delimited(&mut self) -> Result<&'a [u8]> {
        let len = self.varint()?;
        let len = usize::try_from(len).map_err(|_| Error::Malformed("length overflow"))?;
        if len > self.buf.len() {
            return Err(Error::Malformed("truncated length-delimited field"));
        }
        let (field, rest) = self.buf.split_at(len);
        self.buf = rest;
        Ok(field)
    }
}

/// Checks `buf` against `schema`, recursively.
pub(crate) fn check(buf: &[u8], schema: &Schema) -> Result<()> {
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let key = r.varint()?;
        let tag = key >> 3;
        let wire_type = key & 7;
        if tag == 0 || tag > u64::from(u32::MAX >> 3) {
            return Err(Error::Malformed("invalid field number"));
        }
        let Some((_, kind)) = schema
            .fields
            .iter()
            .find(|(number, _)| u64::from(*number) == tag)
        else {
            return Err(Error::Malformed("unknown field"));
        };
        match (kind, wire_type) {
            (Kind::Uint64, WIRE_VARINT) => {
                r.varint()?;
            }
            (Kind::Uint32, WIRE_VARINT) => {
                if r.varint()? > u64::from(u32::MAX) {
                    return Err(Error::Malformed("uint32 out of range"));
                }
            }
            (Kind::Bool, WIRE_VARINT) => {
                if r.varint()? > 1 {
                    return Err(Error::Malformed("bool out of range"));
                }
            }
            (Kind::Enum(values), WIRE_VARINT) => {
                if !values.contains(&r.varint()?) {
                    return Err(Error::Malformed("unknown enum value"));
                }
            }
            (Kind::Bytes | Kind::Opaque, WIRE_LEN) => {
                r.len_delimited()?;
            }
            (Kind::Msg(inner), WIRE_LEN) => check(r.len_delimited()?, inner)?,
            _ => return Err(Error::Malformed("wrong wire type")),
        }
    }
    Ok(())
}

/// Total encoded size of the length-delimited fields reached by `path` (field numbers, outer
/// first), summed over every occurrence. Used to apply byte limits to the bytes received
/// rather than to a re-encoding. `buf` must already have passed [`check`].
pub(crate) fn raw_len(buf: &[u8], path: &[u32]) -> Result<usize> {
    let Some((&first, rest)) = path.split_first() else {
        return Ok(buf.len());
    };
    let mut r = Reader::new(buf);
    let mut total = 0usize;
    while !r.is_empty() {
        let key = r.varint()?;
        match key & 7 {
            WIRE_VARINT => {
                r.varint()?;
            }
            WIRE_LEN => {
                let field = r.len_delimited()?;
                if key >> 3 == u64::from(first) {
                    total = total
                        .checked_add(raw_len(field, rest)?)
                        .ok_or(Error::Overflow("length"))?;
                }
            }
            _ => return Err(Error::Malformed("wrong wire type")),
        }
    }
    Ok(total)
}

/// Strict check, then decode with `prost`.
pub(crate) fn decode<M: prost::Message + Default>(buf: &[u8], schema: &Schema) -> Result<M> {
    check(buf, schema)?;
    M::decode(buf).map_err(|_| Error::Malformed(schema.name))
}

#[cfg(test)]
mod tests {
    use super::*;

    static INNER: Schema = Schema {
        name: "Inner",
        fields: &[(1, Kind::Bytes)],
    };
    static TEST: Schema = Schema {
        name: "Test",
        fields: &[
            (1, Kind::Uint64),
            (2, Kind::Uint32),
            (3, Kind::Bool),
            (4, Kind::Enum(&[0, 2])),
            (5, Kind::Bytes),
            (6, Kind::Msg(&INNER)),
            (7, Kind::Opaque),
        ],
    };

    #[test]
    fn accepts_known_fields() {
        // 1: 300, 2: 7, 3: true, 4: 2, 5: b"h\xc3\xa9", 6: {1: 0x01}, 7: opaque garbage
        let buf = [
            0x08, 0xac, 0x02, 0x10, 0x07, 0x18, 0x01, 0x20, 0x02, 0x2a, 0x03, b'h', 0xc3, 0xa9,
            0x32, 0x03, 0x0a, 0x01, 0x01, 0x3a, 0x02, 0xff, 0xff,
        ];
        assert_eq!(check(&buf, &TEST), Ok(()));
        assert_eq!(check(&[], &TEST), Ok(()));
    }

    #[test]
    fn rejects_unknown_fields() {
        assert_eq!(
            check(&[0x40, 0x01], &TEST),
            Err(Error::Malformed("unknown field"))
        );
        // Unknown inside an embedded message.
        assert_eq!(
            check(&[0x32, 0x02, 0x10, 0x01], &TEST),
            Err(Error::Malformed("unknown field"))
        );
        // Field number 0.
        assert!(check(&[0x00, 0x01], &TEST).is_err());
    }

    #[test]
    fn rejects_wrong_wire_types() {
        // Field 1 (uint64) as length-delimited.
        assert_eq!(
            check(&[0x0a, 0x00], &TEST),
            Err(Error::Malformed("wrong wire type"))
        );
        // Field 5 (bytes) as varint.
        assert!(check(&[0x28, 0x00], &TEST).is_err());
        // Fixed64, fixed32 and group wire types.
        assert!(check(&[0x09, 0, 0, 0, 0, 0, 0, 0, 0], &TEST).is_err());
        assert!(check(&[0x0d, 0, 0, 0, 0], &TEST).is_err());
        assert!(check(&[0x0b], &TEST).is_err());
    }

    #[test]
    fn rejects_out_of_range_values() {
        // uint32 of 2^32.
        assert_eq!(
            check(&[0x10, 0x80, 0x80, 0x80, 0x80, 0x10], &TEST),
            Err(Error::Malformed("uint32 out of range"))
        );
        assert!(check(&[0x10, 0xff, 0xff, 0xff, 0xff, 0x0f], &TEST).is_ok());
        assert_eq!(
            check(&[0x18, 0x02], &TEST),
            Err(Error::Malformed("bool out of range"))
        );
        assert_eq!(
            check(&[0x20, 0x01], &TEST),
            Err(Error::Malformed("unknown enum value"))
        );
        // An enum value that only matches after truncation to 32 bits: 2^32 + 2.
        assert!(check(&[0x20, 0x82, 0x80, 0x80, 0x80, 0x10], &TEST).is_err());
    }

    #[test]
    fn rejects_truncation() {
        assert!(check(&[0x2a, 0x05, b'a'], &TEST).is_err());
        assert!(check(&[0x08], &TEST).is_err());
        assert!(check(&[0x08, 0x80], &TEST).is_err());
    }

    #[test]
    fn varint_limits() {
        let max = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
        assert_eq!(Reader::new(&max).varint(), Ok(u64::MAX));
        let over = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02];
        assert!(Reader::new(&over).varint().is_err());
        let eleven = [0x80; 11];
        assert!(Reader::new(&eleven).varint().is_err());
    }
}
