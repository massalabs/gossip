//! A minimal JSON value with an exact writer and parser.
//!
//! The group records are handed to JavaScript as JSON text that the SDK stores as it is, so
//! integers are kept exact (a `u64` never goes through a JavaScript number) and the parser
//! only needs to read what the writer writes: objects, arrays, strings, unsigned integers,
//! booleans and `null`.

use std::fmt::Write as _;

/// A JSON value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum J {
    Null,
    Bool(bool),
    /// An unsigned integer, written and read exactly.
    Num(u64),
    Str(String),
    Arr(Vec<J>),
    /// Fields in the order they are written.
    Obj(Vec<(String, J)>),
}

impl J {
    /// The JSON text.
    pub fn to_text(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            J::Null => out.push_str("null"),
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Num(n) => {
                let _ = write!(out, "{n}");
            }
            J::Str(s) => write_str(s, out),
            J::Arr(items) => {
                out.push('[');
                for (i, v) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write(out);
                }
                out.push(']');
            }
            J::Obj(fields) => {
                out.push('{');
                for (i, (k, v)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_str(k, out);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }

    /// Parses JSON text.
    pub fn parse(text: &str) -> Result<J, String> {
        let mut p = Parser {
            s: text.as_bytes(),
            i: 0,
        };
        let v = p.value(0)?;
        p.ws();
        if p.i != p.s.len() {
            return Err("trailing characters".into());
        }
        Ok(v)
    }

    /// The field `name` of an object.
    pub fn field(&self, name: &str) -> Result<&J, String> {
        match self {
            J::Obj(fields) => fields
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v)
                .ok_or_else(|| format!("missing field {name}")),
            _ => Err(format!("expected an object for field {name}")),
        }
    }

    pub fn as_u64(&self) -> Result<u64, String> {
        match self {
            J::Num(n) => Ok(*n),
            _ => Err("expected a number".into()),
        }
    }

    pub fn as_bool(&self) -> Result<bool, String> {
        match self {
            J::Bool(b) => Ok(*b),
            _ => Err("expected a boolean".into()),
        }
    }

    pub fn as_str(&self) -> Result<&str, String> {
        match self {
            J::Str(s) => Ok(s),
            _ => Err("expected a string".into()),
        }
    }

    pub fn as_arr(&self) -> Result<&[J], String> {
        match self {
            J::Arr(a) => Ok(a),
            _ => Err("expected an array".into()),
        }
    }
}

fn write_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Nesting deeper than this is refused (the records nest a handful of levels).
const MAX_DEPTH: usize = 64;

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\n' | b'\r' | b'\t') {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn eat(&mut self, c: u8) -> Result<(), String> {
        self.ws();
        if self.peek() == Some(c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("expected '{}' at {}", c as char, self.i))
        }
    }

    fn lit(&mut self, word: &str, v: J) -> Result<J, String> {
        if self.s[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(format!("unexpected token at {}", self.i))
        }
    }

    fn value(&mut self, depth: usize) -> Result<J, String> {
        if depth > MAX_DEPTH {
            return Err("nesting too deep".into());
        }
        self.ws();
        match self.peek().ok_or("unexpected end")? {
            b'n' => self.lit("null", J::Null),
            b't' => self.lit("true", J::Bool(true)),
            b'f' => self.lit("false", J::Bool(false)),
            b'"' => Ok(J::Str(self.string()?)),
            b'0'..=b'9' => {
                let start = self.i;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.i += 1;
                }
                let digits = core::str::from_utf8(&self.s[start..self.i]).expect("ascii");
                digits
                    .parse::<u64>()
                    .map(J::Num)
                    .map_err(|_| "number out of range".into())
            }
            b'[' => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.peek() == Some(b']') {
                    self.i += 1;
                    return Ok(J::Arr(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(J::Arr(items));
                        }
                        _ => return Err(format!("expected ',' or ']' at {}", self.i)),
                    }
                }
            }
            b'{' => {
                self.i += 1;
                let mut fields = Vec::new();
                self.ws();
                if self.peek() == Some(b'}') {
                    self.i += 1;
                    return Ok(J::Obj(fields));
                }
                loop {
                    self.ws();
                    let k = self.string()?;
                    self.eat(b':')?;
                    let v = self.value(depth + 1)?;
                    fields.push((k, v));
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(J::Obj(fields));
                        }
                        _ => return Err(format!("expected ',' or '}}' at {}", self.i)),
                    }
                }
            }
            _ => Err(format!("unexpected character at {}", self.i)),
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let h = self.s.get(self.i..self.i + 4).ok_or("short escape")?;
        self.i += 4;
        u32::from_str_radix(core::str::from_utf8(h).map_err(|_| "bad escape")?, 16)
            .map_err(|_| "bad escape".into())
    }

    fn string(&mut self) -> Result<String, String> {
        if self.peek() != Some(b'"') {
            return Err(format!("expected a string at {}", self.i));
        }
        self.i += 1;
        let mut out = Vec::new();
        loop {
            let c = self.peek().ok_or("unterminated string")?;
            self.i += 1;
            match c {
                b'"' => break,
                b'\\' => {
                    let e = self.peek().ok_or("unterminated escape")?;
                    self.i += 1;
                    let ch = match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'u' => {
                            let mut cp = self.hex4()?;
                            if (0xd800..0xdc00).contains(&cp) {
                                if self.s.get(self.i..self.i + 2) != Some(b"\\u") {
                                    return Err("lone surrogate".into());
                                }
                                self.i += 2;
                                let lo = self.hex4()?;
                                if !(0xdc00..0xe000).contains(&lo) {
                                    return Err("bad surrogate pair".into());
                                }
                                cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                            }
                            char::from_u32(cp).ok_or("bad code point")?
                        }
                        _ => return Err("bad escape".into()),
                    };
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                c => out.push(c),
            }
        }
        String::from_utf8(out).map_err(|_| "invalid UTF-8".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_kind() {
        let v = J::Obj(vec![
            ("a".into(), J::Num(u64::MAX)),
            (
                "b".into(),
                J::Str("quote \" back \\ nl \n ctl \u{1} é 😀".into()),
            ),
            (
                "c".into(),
                J::Arr(vec![J::Null, J::Bool(true), J::Bool(false), J::Arr(vec![])]),
            ),
            ("d".into(), J::Obj(vec![])),
        ]);
        assert_eq!(J::parse(&v.to_text()).unwrap(), v);
    }

    #[test]
    fn reads_escapes_written_by_javascript() {
        let v = J::parse(r#" { "s" : "\u00e9\ud83d\ude00\/" } "#).unwrap();
        assert_eq!(v.field("s").unwrap().as_str().unwrap(), "é😀/");
    }

    #[test]
    fn refuses_what_it_does_not_write() {
        for bad in [
            "-1",
            "1.5",
            "18446744073709551616",
            "[1,]",
            "{\"a\"}",
            "\"\\ud800\"",
            "[] x",
        ] {
            assert!(J::parse(bad).is_err(), "{bad}");
        }
    }
}
