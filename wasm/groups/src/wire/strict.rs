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
//! - text that is not UTF-8, a truncated field or a varint longer than 64 bits;
//! - two different cases of one `oneof`: a frame holds exactly one kind (§13.1, D.24);
//! - more occurrences of a repeated field than its limit (§4.1, §6.1, §7.6, §13.10).
//!
//! Repeated occurrences of a singular field are accepted as protobuf defines them (the last
//! scalar wins, embedded messages merge): they are other encodings of field values, and no
//! hash covers the encoded bytes (§13.1). The same holds for the same case of a `oneof` sent
//! twice. Because embedded messages merge, a singular embedded message is checked as the
//! concatenation of all its occurrences, which is what the decoder builds: its `oneof` cases
//! and the counts of its repeated fields are taken over every occurrence.
//!
//! The check allocates nothing, so the count limits are applied before `prost` builds
//! anything from the bytes.

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
    /// `string`: UTF-8.
    Str,
    /// A singular embedded message, checked recursively; its occurrences merge.
    Msg(&'static Schema),
    /// A repeated embedded message (or a map entry), each occurrence checked on its own.
    RepeatedMsg(&'static Schema),
    /// A length-delimited field checked separately by the caller (an embedded message whose
    /// failure is isolated, or an event blob with its own version).
    Opaque,
}

/// A repeated field whose number of occurrences is limited.
#[derive(Debug)]
pub(crate) struct Limit {
    /// The field number.
    pub field: u32,
    /// The most occurrences allowed.
    pub max: usize,
    /// The name reported in [`Error::TooMany`].
    pub name: &'static str,
}

/// The known fields of one message.
#[derive(Debug)]
pub(crate) struct Schema {
    pub name: &'static str,
    pub fields: &'static [(u32, Kind)],
    /// The field numbers of each `oneof`; at most one case of each may appear.
    pub oneofs: &'static [&'static [u32]],
    /// Count limits on repeated fields.
    pub limits: &'static [Limit],
}

const WIRE_VARINT: u64 = 0;
const WIRE_LEN: u64 = 2;

/// The greatest protobuf field number.
const MAX_FIELD_NUMBER: u64 = (1 << 29) - 1;

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

    pub(crate) fn len_delimited(&mut self) -> Result<&'a [u8]> {
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

/// The value of one field occurrence.
#[derive(Clone, Copy)]
enum Wire<'a> {
    Varint(u64),
    Len(&'a [u8]),
    /// Any other wire type; never valid in this schema, so its value is not read.
    Other,
}

/// Calls `f` with every field of the message reached by `path` (field numbers, outer first)
/// from `buf`. When a field of the path occurs several times, the fields of every occurrence
/// are visited in order: for singular embedded messages, this is the merged message the
/// decoder builds. Every level above the last must already have been checked.
fn walk<'a, F>(buf: &'a [u8], path: &[u32], f: &mut F) -> Result<()>
where
    F: FnMut(u32, Wire<'a>) -> Result<()>,
{
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let key = r.varint()?;
        let tag = key >> 3;
        if tag == 0 || tag > MAX_FIELD_NUMBER {
            return Err(Error::Malformed("invalid field number"));
        }
        let tag = u32::try_from(tag).map_err(|_| Error::Malformed("invalid field number"))?;
        let value = match key & 7 {
            WIRE_VARINT => Wire::Varint(r.varint()?),
            WIRE_LEN => Wire::Len(r.len_delimited()?),
            _ => Wire::Other,
        };
        match (path.split_first(), value) {
            (None, value) => {
                f(tag, value)?;
                if matches!(value, Wire::Other) {
                    // `f` refuses it; its length is unknown, so the walk cannot go on.
                    return Err(Error::Malformed("wrong wire type"));
                }
            }
            (Some(_), Wire::Other) => return Err(Error::Malformed("wrong wire type")),
            (Some((&first, rest)), Wire::Len(inner)) if tag == first => walk(inner, rest, f)?,
            (Some(_), _) => {}
        }
    }
    Ok(())
}

/// Checks `buf` against `schema`, recursively.
pub(crate) fn check(buf: &[u8], schema: &Schema) -> Result<()> {
    let mut path = Vec::new();
    check_at(buf, &mut path, schema)
}

/// Checks the message reached by `path` from `root` (all occurrences merged) against `schema`.
/// `path` grows by one field per level of singular embedded messages, so its length is
/// bounded by the depth of the schema.
fn check_at(root: &[u8], path: &mut Vec<u32>, schema: &Schema) -> Result<()> {
    walk(root, path, &mut |tag, value| {
        check_field(schema, tag, value)
    })?;
    for group in schema.oneofs {
        let mut case: Option<u32> = None;
        walk(root, path, &mut |tag, _| {
            if group.contains(&tag) {
                match case {
                    Some(c) if c != tag => {
                        return Err(Error::Malformed("two cases of one oneof"));
                    }
                    _ => case = Some(tag),
                }
            }
            Ok(())
        })?;
    }
    for limit in schema.limits {
        let mut got = 0usize;
        walk(root, path, &mut |tag, _| {
            if tag == limit.field {
                got += 1;
            }
            Ok(())
        })?;
        if got > limit.max {
            return Err(Error::TooMany {
                field: limit.name,
                max: limit.max,
                got,
            });
        }
    }
    for (number, kind) in schema.fields {
        if let Kind::Msg(inner) = kind {
            path.push(*number);
            let result = check_at(root, path, inner);
            path.pop();
            result?;
        }
    }
    Ok(())
}

/// Checks one occurrence of a field of `schema`. A singular embedded message is only checked
/// for its wire type here; its content is checked merged, by [`check_at`].
fn check_field(schema: &Schema, tag: u32, value: Wire<'_>) -> Result<()> {
    let Some((_, kind)) = schema.fields.iter().find(|(number, _)| *number == tag) else {
        return Err(Error::Malformed("unknown field"));
    };
    match (kind, value) {
        (Kind::Uint64, Wire::Varint(_)) => {}
        (Kind::Uint32, Wire::Varint(v)) => {
            if v > u64::from(u32::MAX) {
                return Err(Error::Malformed("uint32 out of range"));
            }
        }
        (Kind::Bool, Wire::Varint(v)) => {
            if v > 1 {
                return Err(Error::Malformed("bool out of range"));
            }
        }
        (Kind::Enum(values), Wire::Varint(v)) => {
            if !values.contains(&v) {
                return Err(Error::Malformed("unknown enum value"));
            }
        }
        (Kind::Bytes | Kind::Opaque | Kind::Msg(_), Wire::Len(_)) => {}
        (Kind::Str, Wire::Len(s)) => {
            if core::str::from_utf8(s).is_err() {
                return Err(Error::InvalidUtf8(schema.name));
            }
        }
        (Kind::RepeatedMsg(inner), Wire::Len(m)) => check(m, inner)?,
        _ => return Err(Error::Malformed("wrong wire type")),
    }
    Ok(())
}

/// Total encoded size of the length-delimited fields reached by `path` (field numbers, outer
/// first), summed over every occurrence. Used to apply byte limits to the bytes received
/// rather than to a re-encoding. `buf` must already have passed [`check`].
pub(crate) fn raw_len(buf: &[u8], path: &[u32]) -> Result<usize> {
    let Some((&last, parents)) = path.split_last() else {
        return Ok(buf.len());
    };
    let mut total = 0usize;
    walk(buf, parents, &mut |tag, value| {
        if let (true, Wire::Len(field)) = (tag == last, value) {
            total = total
                .checked_add(field.len())
                .ok_or(Error::Overflow("length"))?;
        }
        Ok(())
    })?;
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
        fields: &[(1, Kind::Bytes), (2, Kind::Bytes), (3, Kind::Bytes)],
        oneofs: &[&[2, 3]],
        limits: &[Limit {
            field: 1,
            max: 2,
            name: "inner ones",
        }],
    };
    static TEST: Schema = Schema {
        name: "Test",
        fields: &[
            (1, Kind::Uint64),
            (2, Kind::Uint32),
            (3, Kind::Bool),
            (4, Kind::Enum(&[0, 2])),
            (5, Kind::Str),
            (6, Kind::Msg(&INNER)),
            (7, Kind::Opaque),
            (8, Kind::RepeatedMsg(&INNER)),
            (9, Kind::Bytes),
            (10, Kind::Bytes),
        ],
        oneofs: &[&[9, 10]],
        limits: &[Limit {
            field: 8,
            max: 3,
            name: "repeated inners",
        }],
    };

    #[test]
    fn accepts_known_fields() {
        // 1: 300, 2: 7, 3: true, 4: 2, 5: "hé", 6: {1: 0x01}, 7: opaque garbage
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
            check(&[0x58, 0x01], &TEST),
            Err(Error::Malformed("unknown field"))
        );
        // Unknown inside an embedded message, singular or repeated.
        assert_eq!(
            check(&[0x32, 0x02, 0x20, 0x01], &TEST),
            Err(Error::Malformed("unknown field"))
        );
        assert_eq!(
            check(&[0x42, 0x02, 0x20, 0x01], &TEST),
            Err(Error::Malformed("unknown field"))
        );
        // Unknown with a fixed64 wire type: reported as unknown, its value is not read.
        assert_eq!(
            check(&[0x59], &TEST),
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
        // Field 5 (string) as varint.
        assert!(check(&[0x28, 0x00], &TEST).is_err());
        // Fixed64, fixed32 and group wire types.
        assert!(check(&[0x09, 0, 0, 0, 0, 0, 0, 0, 0], &TEST).is_err());
        assert!(check(&[0x0d, 0, 0, 0, 0], &TEST).is_err());
        assert!(check(&[0x0b], &TEST).is_err());
        // An embedded message as a varint.
        assert!(check(&[0x30, 0x00], &TEST).is_err());
        assert!(check(&[0x40, 0x00], &TEST).is_err());
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
    fn rejects_invalid_utf8_and_truncation() {
        assert_eq!(
            check(&[0x2a, 0x01, 0xff], &TEST),
            Err(Error::InvalidUtf8("Test"))
        );
        assert!(check(&[0x2a, 0x05, b'a'], &TEST).is_err());
        assert!(check(&[0x08], &TEST).is_err());
        assert!(check(&[0x08, 0x80], &TEST).is_err());
        // A field cannot continue from one occurrence of a message into the next.
        assert!(check(&[0x32, 0x01, 0x0a, 0x32, 0x01, 0x00], &TEST).is_err());
    }

    #[test]
    fn two_cases_of_one_oneof_are_malformed() {
        // 9 then 10, and 10 then 9.
        assert_eq!(
            check(&[0x4a, 0x00, 0x52, 0x00], &TEST),
            Err(Error::Malformed("two cases of one oneof"))
        );
        assert_eq!(
            check(&[0x52, 0x00, 0x08, 0x01, 0x4a, 0x00], &TEST),
            Err(Error::Malformed("two cases of one oneof"))
        );
        // The same case twice is standard protobuf: the last wins.
        assert_eq!(check(&[0x4a, 0x00, 0x4a, 0x01, 0x07], &TEST), Ok(()));
        // Inside a singular embedded message, and across two occurrences of it, which merge.
        assert_eq!(
            check(&[0x32, 0x04, 0x12, 0x00, 0x1a, 0x00], &TEST),
            Err(Error::Malformed("two cases of one oneof"))
        );
        assert_eq!(
            check(&[0x32, 0x02, 0x12, 0x00, 0x32, 0x02, 0x1a, 0x00], &TEST),
            Err(Error::Malformed("two cases of one oneof"))
        );
        assert_eq!(
            check(&[0x32, 0x02, 0x12, 0x00, 0x32, 0x02, 0x12, 0x00], &TEST),
            Ok(())
        );
        // Repeated messages are separate messages: one case in each is fine.
        assert_eq!(
            check(&[0x42, 0x02, 0x12, 0x00, 0x42, 0x02, 0x1a, 0x00], &TEST),
            Ok(())
        );
        assert_eq!(
            check(&[0x42, 0x04, 0x12, 0x00, 0x1a, 0x00], &TEST),
            Err(Error::Malformed("two cases of one oneof"))
        );
    }

    #[test]
    fn count_limits() {
        // Three repeated inners, then four.
        let three = [0x42, 0x00, 0x42, 0x00, 0x42, 0x00];
        assert_eq!(check(&three, &TEST), Ok(()));
        assert_eq!(
            check(&[&three[..], &[0x42, 0x00]].concat(), &TEST),
            Err(Error::TooMany {
                field: "repeated inners",
                max: 3,
                got: 4
            })
        );
        // Inside a singular message the count runs over every occurrence, which merge.
        assert_eq!(check(&[0x32, 0x04, 0x0a, 0x00, 0x0a, 0x00], &TEST), Ok(()));
        assert_eq!(
            check(
                &[0x32, 0x04, 0x0a, 0x00, 0x0a, 0x00, 0x32, 0x02, 0x0a, 0x00],
                &TEST
            ),
            Err(Error::TooMany {
                field: "inner ones",
                max: 2,
                got: 3
            })
        );
        // Each repeated message has its own count.
        assert_eq!(
            check(
                &[0x42, 0x04, 0x0a, 0x00, 0x0a, 0x00, 0x42, 0x02, 0x0a, 0x00],
                &TEST
            ),
            Ok(())
        );
    }

    #[test]
    fn raw_len_sums_every_occurrence() {
        // 6: {1: h'01'} twice, 7: two bytes.
        let buf = [
            0x32, 0x03, 0x0a, 0x01, 0x01, 0x32, 0x03, 0x0a, 0x01, 0x01, 0x3a, 0x02, 0xff, 0xff,
        ];
        assert_eq!(check(&buf, &TEST), Ok(()));
        assert_eq!(raw_len(&buf, &[]), Ok(buf.len()));
        assert_eq!(raw_len(&buf, &[6]), Ok(6));
        assert_eq!(raw_len(&buf, &[6, 1]), Ok(2));
        assert_eq!(raw_len(&buf, &[7]), Ok(2));
        assert_eq!(raw_len(&buf, &[9]), Ok(0));
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
