//! Domain separation strings for all KDF and AEAD operations.
//!
//! Every string generated here is unique per usage context, preventing
//! key reuse across different cryptographic operations.
//!
//! Block-level functions (`block_*`) write into a caller-provided buffer
//! to avoid allocations in per-block loops.

use std::fmt::Write as _;

use crate::types::SessionIndex;

/// Root domain: `{domain}:secureStorage`
#[must_use]
pub fn root(domain: &str) -> String {
    format!("{domain}:secureStorage")
}

/// Session scope: `{root}:session:v{version}:i{index}`
#[must_use]
pub fn session_scope(domain: &str, version: u32, index: SessionIndex) -> String {
    format!("{domain}:secureStorage:session:v{version}:i{}", index.as_u8())
}

/// Block scope: `{session_scope}:n{namespace}:b{block_index}`
///
/// Each (session, namespace, block_index) triple gets a unique scope, used as
/// the AAD root for AEAD encryption. Different namespaces within the same
/// session never collide because the namespace byte is part of the scope.
///
/// Writes into `buf` (cleared first) to avoid allocations in per-block loops.
pub fn block_scope(
    buf: &mut String,
    domain: &str,
    version: u32,
    index: SessionIndex,
    namespace: u8,
    block: u64,
) {
    buf.clear();
    // String::write_fmt is infallible — unwrap is safe.
    write!(
        buf,
        "{domain}:secureStorage:session:v{version}:i{}:n{namespace}:b{block}",
        index.as_u8()
    )
    .unwrap();
}

/// Salt for password KDF: `{root}:password_kdf`
#[must_use]
pub fn password_kdf_salt(domain: &str) -> String {
    format!("{domain}:secureStorage:password_kdf")
}

/// Salt for root KDF: `{domain}:kdf:salt`
#[must_use]
pub fn root_kdf_salt(domain: &str) -> String {
    format!("{domain}:secureStorage:kdf:salt")
}

/// AAD for secret key wrapping: `{session_scope}:pq_sk_wrap`
#[must_use]
pub fn sk_wrap_aad(domain: &str, version: u32, index: SessionIndex) -> String {
    format!(
        "{domain}:secureStorage:session:v{version}:i{}:pq_sk_wrap",
        index.as_u8()
    )
}

/// Salt for per-block KDF: `{block_scope}:kdf:salt`
///
/// Writes into `buf` (cleared first) to avoid allocations in per-block loops.
pub fn block_kdf_salt(
    buf: &mut String,
    domain: &str,
    version: u32,
    index: SessionIndex,
    namespace: u8,
    block: u64,
) {
    buf.clear();
    // String::write_fmt is infallible — unwrap is safe.
    write!(
        buf,
        "{domain}:secureStorage:session:v{version}:i{}:n{namespace}:b{block}:kdf:salt",
        index.as_u8()
    )
    .unwrap();
}

/// Label for per-block AEAD key derivation: `{block_scope}:kdf:block_aead_key`
///
/// Writes into `buf` (cleared first) to avoid allocations in per-block loops.
pub fn block_aead_key_label(
    buf: &mut String,
    domain: &str,
    version: u32,
    index: SessionIndex,
    namespace: u8,
    block: u64,
) {
    buf.clear();
    // String::write_fmt is infallible — unwrap is safe.
    write!(
        buf,
        "{domain}:secureStorage:session:v{version}:i{}:n{namespace}:b{block}:kdf:block_aead_key",
        index.as_u8()
    )
    .unwrap();
}

/// AAD for block AEAD encryption: `{block_scope}:block_aead`
///
/// Writes into `buf` (cleared first) to avoid allocations in per-block loops.
pub fn block_aead_aad(
    buf: &mut String,
    domain: &str,
    version: u32,
    index: SessionIndex,
    namespace: u8,
    block: u64,
) {
    buf.clear();
    // String::write_fmt is infallible — unwrap is safe.
    write!(
        buf,
        "{domain}:secureStorage:session:v{version}:i{}:n{namespace}:b{block}:block_aead",
        index.as_u8()
    )
    .unwrap();
}

/// Label for sk_wrap_key derivation: `{root}:kdf:sk_wrap_key`
#[must_use]
pub fn sk_wrap_key_label(domain: &str) -> String {
    format!("{domain}:secureStorage:kdf:sk_wrap_key")
}

/// Label for root_aead_key derivation: `{root}:kdf:root_aead_key`
#[must_use]
pub fn root_aead_key_label(domain: &str) -> String {
    format!("{domain}:secureStorage:kdf:root_aead_key")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_root_format() {
        assert_eq!(root("app:ns"), "app:ns:secureStorage");
    }

    #[test]
    fn test_session_scope_format() {
        let idx = SessionIndex::new(2).unwrap();
        assert_eq!(
            session_scope("app:ns", 1, idx),
            "app:ns:secureStorage:session:v1:i2"
        );
    }

    #[test]
    fn test_block_scope_format() {
        let idx = SessionIndex::new(0).unwrap();
        let mut buf = String::new();
        block_scope(&mut buf, "app:ns", 0, idx, 0, 42);
        assert_eq!(buf, "app:ns:secureStorage:session:v0:i0:n0:b42");
    }

    #[test]
    fn test_block_scope_namespace_changes_output() {
        let idx = SessionIndex::new(0).unwrap();
        let mut buf0 = String::new();
        let mut buf1 = String::new();
        block_scope(&mut buf0, "app", 0, idx, 0, 42);
        block_scope(&mut buf1, "app", 0, idx, 1, 42);
        assert_ne!(buf0, buf1);
    }

    #[test]
    fn test_password_kdf_salt() {
        assert_eq!(
            password_kdf_salt("app:ns"),
            "app:ns:secureStorage:password_kdf"
        );
    }

    #[test]
    fn test_root_kdf_salt() {
        assert_eq!(root_kdf_salt("app:ns"), "app:ns:secureStorage:kdf:salt");
    }

    #[test]
    fn test_sk_wrap_aad() {
        let idx = SessionIndex::new(1).unwrap();
        assert_eq!(
            sk_wrap_aad("app:ns", 0, idx),
            "app:ns:secureStorage:session:v0:i1:pq_sk_wrap"
        );
    }

    #[test]
    fn test_block_kdf_salt() {
        let idx = SessionIndex::new(0).unwrap();
        let mut buf = String::new();
        block_kdf_salt(&mut buf, "app:ns", 0, idx, 0, 5);
        assert_eq!(buf, "app:ns:secureStorage:session:v0:i0:n0:b5:kdf:salt");
    }

    #[test]
    fn test_block_aead_key_label() {
        let idx = SessionIndex::new(0).unwrap();
        let mut buf = String::new();
        block_aead_key_label(&mut buf, "app:ns", 0, idx, 0, 5);
        assert_eq!(
            buf,
            "app:ns:secureStorage:session:v0:i0:n0:b5:kdf:block_aead_key"
        );
    }

    #[test]
    fn test_block_aead_aad() {
        let idx = SessionIndex::new(0).unwrap();
        let mut buf = String::new();
        block_aead_aad(&mut buf, "app:ns", 0, idx, 0, 5);
        assert_eq!(buf, "app:ns:secureStorage:session:v0:i0:n0:b5:block_aead");
    }

    #[test]
    fn test_sk_wrap_key_label() {
        assert_eq!(
            sk_wrap_key_label("app:ns"),
            "app:ns:secureStorage:kdf:sk_wrap_key"
        );
    }

    #[test]
    fn test_root_aead_key_label() {
        assert_eq!(
            root_aead_key_label("app:ns"),
            "app:ns:secureStorage:kdf:root_aead_key"
        );
    }

    #[test]
    fn test_all_labels_unique() {
        let idx = SessionIndex::new(0).unwrap();
        let domain = "test";
        let mut buf = String::new();

        block_kdf_salt(&mut buf, domain, 0, idx, 0, 0);
        let bks = buf.clone();
        block_aead_key_label(&mut buf, domain, 0, idx, 0, 0);
        let bakl = buf.clone();
        block_aead_aad(&mut buf, domain, 0, idx, 0, 0);
        let baa = buf.clone();

        let labels = vec![
            password_kdf_salt(domain),
            root_kdf_salt(domain),
            sk_wrap_aad(domain, 0, idx),
            bks,
            bakl,
            baa,
            sk_wrap_key_label(domain),
            root_aead_key_label(domain),
        ];

        let mut sorted = labels.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(
            labels.len(),
            sorted.len(),
            "Duplicate labels found: {labels:?}"
        );
    }

    #[test]
    fn test_different_sessions_different_labels() {
        let s0 = SessionIndex::new(0).unwrap();
        let s1 = SessionIndex::new(1).unwrap();
        let mut buf0 = String::new();
        let mut buf1 = String::new();

        block_aead_aad(&mut buf0, "d", 0, s0, 0, 0);
        block_aead_aad(&mut buf1, "d", 0, s1, 0, 0);
        assert_ne!(buf0, buf1);
    }

    #[test]
    fn test_different_namespaces_different_labels() {
        let idx = SessionIndex::new(0).unwrap();
        let mut buf0 = String::new();
        let mut buf1 = String::new();

        block_aead_aad(&mut buf0, "d", 0, idx, 0, 5);
        block_aead_aad(&mut buf1, "d", 0, idx, 1, 5);
        assert_ne!(buf0, buf1);
    }

    #[test]
    fn test_different_blocks_different_labels() {
        let idx = SessionIndex::new(0).unwrap();
        let mut buf0 = String::new();
        let mut buf1 = String::new();

        block_aead_aad(&mut buf0, "d", 0, idx, 0, 0);
        block_aead_aad(&mut buf1, "d", 0, idx, 0, 1);
        assert_ne!(buf0, buf1);
    }

    #[test]
    fn test_different_versions_different_labels() {
        let idx = SessionIndex::new(0).unwrap();
        let mut buf0 = String::new();
        let mut buf1 = String::new();

        block_aead_aad(&mut buf0, "d", 0, idx, 0, 0);
        block_aead_aad(&mut buf1, "d", 1, idx, 0, 0);
        assert_ne!(buf0, buf1);
    }

    #[test]
    fn test_buffer_reuse() {
        let idx = SessionIndex::new(0).unwrap();
        let mut buf = String::new();

        block_aead_aad(&mut buf, "d", 0, idx, 0, 0);
        let first = buf.clone();

        block_aead_aad(&mut buf, "d", 0, idx, 0, 1);
        assert_ne!(first, buf, "buffer should be overwritten on reuse");
    }
}
