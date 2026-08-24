/// Return whether SQLite's uncompiled statement tail contains only
/// ignorable whitespace and complete SQL comments.
pub(crate) fn is_ignorable(mut tail: &[u8]) -> bool {
    loop {
        while tail.first().is_some_and(u8::is_ascii_whitespace) {
            tail = &tail[1..];
        }
        if tail.is_empty() {
            return true;
        }
        if tail.starts_with(b"--") {
            tail = tail
                .iter()
                .position(|byte| *byte == b'\n' || *byte == b'\r')
                .map_or(&[], |newline| &tail[newline + 1..]);
            continue;
        }
        if tail.starts_with(b"/*") {
            let Some(end) = tail[2..].windows(2).position(|pair| pair == b"*/") else {
                return false;
            };
            tail = &tail[end + 4..];
            continue;
        }
        return false;
    }
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
}
