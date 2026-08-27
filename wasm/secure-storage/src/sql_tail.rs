use std::ffi::CStr;

pub(crate) const MULTIPLE_STATEMENTS: &str = "multiple SQL statements are not allowed";
pub(crate) const LEADING_EMPTY_STATEMENT: &str = "leading empty SQL statements are not allowed";
pub(crate) const NUL_BYTE: &str = "sql contains nul byte";
pub(crate) const UNSUPPORTED_BOUNDARY_WHITESPACE: &str = "unsupported sql boundary whitespace";

/// Match exactly the whitespace removed by ECMAScript `String.prototype.trim`.
/// The JavaScript worker classifies the original statement after that trim, so
/// Rust must neither remove a broader Unicode set nor execute different bytes.
fn is_ecmascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn consume_ignorable(mut input: &[u8], allow_empty_statements: bool) -> Option<()> {
    loop {
        while input.first().is_some_and(u8::is_ascii_whitespace) {
            input = &input[1..];
        }
        if input.is_empty() {
            return Some(());
        }
        if allow_empty_statements && input.starts_with(b";") {
            input = &input[1..];
            continue;
        }
        if input.starts_with(b"--") {
            input = input
                .iter()
                .position(|byte| *byte == b'\n' || *byte == b'\r')
                .map_or(&[], |newline| &input[newline + 1..]);
            continue;
        }
        if input.starts_with(b"/*") {
            let end = input[2..].windows(2).position(|pair| pair == b"*/")?;
            input = &input[end + 4..];
            continue;
        }
        return None;
    }
}

/// Return whether a prepared statement's uncompiled tail contains only
/// whitespace and complete SQL comments.
pub(crate) fn is_ignorable(tail: &[u8]) -> bool {
    consume_ignorable(tail, false).is_some()
}

fn is_empty_statement_prefix(prefix: &[u8]) -> bool {
    consume_ignorable(prefix, true).is_some()
}

/// Reject additional statements without preparing SQL against a live
/// connection. `sqlite3_complete` performs SQLite's own lexical boundary
/// recognition without executing or preparing a statement, including its
/// special handling for triggers, comments, and quoted semicolons.
pub(crate) fn validate<F>(sql: &str, mut sqlite_complete: F) -> Result<&str, &'static str>
where
    F: FnMut(&CStr) -> bool,
{
    // Enforce this at our boundary rather than relying on rusqlite's current
    // SmallCString NUL check. A future SQLite wrapper must never turn a NUL
    // suffix into ignored SQL that the JavaScript classifier still observes.
    if sql.as_bytes().contains(&0) {
        return Err(NUL_BYTE);
    }
    // Normalize exactly as the JavaScript classifier does. rusqlite's
    // statement cache later applies Rust `str::trim`, whose broader Unicode
    // set includes U+0085. Reject any remaining Rust-only boundary whitespace
    // before preparation rather than letting native execution observe bytes
    // that JavaScript did not classify.
    let sql = sql.trim_matches(is_ecmascript_whitespace);
    if sql.trim() != sql {
        return Err(UNSUPPORTED_BOUNDARY_WHITESPACE);
    }
    if !sql.as_bytes().contains(&b';') {
        return Ok(sql);
    }

    let mut prefix = sql.as_bytes().to_vec();
    prefix.push(0);
    for index in sql
        .as_bytes()
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| (*byte == b';').then_some(index))
    {
        let saved = prefix[index + 1];
        prefix[index + 1] = 0;
        // SAFETY: embedded NUL bytes were rejected above and this slice ends
        // at the temporary terminator written immediately after `index`.
        let candidate = unsafe { CStr::from_bytes_with_nul_unchecked(&prefix[..=index + 1]) };
        let complete = sqlite_complete(candidate);
        prefix[index + 1] = saved;

        if complete {
            if is_empty_statement_prefix(&sql.as_bytes()[..=index]) {
                return Err(LEADING_EMPTY_STATEMENT);
            }
            return if is_ignorable(&sql.as_bytes()[index + 1..]) {
                Ok(sql)
            } else {
                Err(MULTIPLE_STATEMENTS)
            };
        }
    }
    Ok(sql)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_whitespace_and_complete_comments() {
        assert!(is_ignorable(b""));
        assert!(is_ignorable(b"  \n\t-- trace\n/* done */ "));
        assert!(!is_ignorable(b" SELECT 1"));
        assert!(!is_ignorable(b";"));
        assert!(!is_ignorable(b"/* unterminated"));
    }

    #[test]
    fn rejects_nul_and_normalizes_boundary_whitespace_before_completion() {
        let mut called = false;
        let complete = |_: &CStr| {
            called = true;
            true
        };
        assert_eq!(validate("BEGIN\0ignored", complete), Err(NUL_BYTE));
        assert!(!called);

        assert_eq!(validate("\u{a0}BEGIN\u{a0}", |_| false), Ok("BEGIN"));
        assert_eq!(validate("\u{feff}BEGIN\u{feff}", |_| false), Ok("BEGIN"));
        assert_eq!(
            validate("\u{85}BEGIN", |_| false),
            Err(UNSUPPORTED_BOUNDARY_WHITESPACE)
        );
        assert_eq!(
            validate("BEGIN\u{85}", |_| false),
            Err(UNSUPPORTED_BOUNDARY_WHITESPACE)
        );
    }

    #[test]
    fn rejects_empty_prefixes_and_a_complete_statement_tail() {
        let complete =
            |candidate: &CStr| matches!(candidate.to_bytes(), b";" | b";;" | b";; SELECT 1;");
        assert_eq!(
            validate(";; SELECT 1; -- done", complete),
            Err(LEADING_EMPTY_STATEMENT)
        );
        assert_eq!(
            validate(";; SELECT 1; SELECT 2", complete),
            Err(LEADING_EMPTY_STATEMENT)
        );
    }
}
