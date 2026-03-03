//! Key derivation for bordercrypt.

use zeroize::Zeroizing;

use crate::domain::{block_aead_key_label, block_kdf_salt};
use crate::types::SessionIndex;

/// Derive the per-block AEAD key for a given session and block index.
///
/// Uses HKDF-SHA256 with domain-separated salt and label, plus canonical
/// big-endian encoding of the session index and block index as input items.
///
/// `buf` is a reusable `String` buffer (cleared internally) to avoid
/// allocations in per-block loops.
pub fn derive_block_aead_key(
    buf: &mut String,
    domain: &str,
    version: u32,
    index: SessionIndex,
    root_aead_key: &[u8],
    block: u64,
) -> Zeroizing<[u8; crypto_aead::KEY_SIZE]> {
    block_kdf_salt(buf, domain, version, index, block);
    let expander = {
        let mut extract = crypto_kdf::Extract::new(buf.as_bytes());
        extract.input_item(root_aead_key);
        extract.input_item(&u32::from(index.as_u8()).to_be_bytes());
        extract.input_item(&block.to_be_bytes());
        extract.finalize()
    };

    block_aead_key_label(buf, domain, version, index, block);
    let mut key = Zeroizing::new([0u8; crypto_aead::KEY_SIZE]);
    expander.expand(buf.as_bytes(), key.as_mut());
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT_KEY: [u8; 32] = [0xAA; 32];

    fn idx(i: u8) -> SessionIndex {
        SessionIndex::new(i).unwrap()
    }

    fn derive(
        domain: &str,
        version: u32,
        session: u8,
        root: &[u8],
        block: u64,
    ) -> [u8; crypto_aead::KEY_SIZE] {
        let mut buf = String::new();
        *derive_block_aead_key(&mut buf, domain, version, idx(session), root, block)
    }

    #[test]
    fn deterministic() {
        let k1 = derive("d", 0, 0, &ROOT_KEY, 0);
        let k2 = derive("d", 0, 0, &ROOT_KEY, 0);
        assert_eq!(k1, k2);
    }

    #[test]
    fn different_blocks() {
        let k0 = derive("d", 0, 0, &ROOT_KEY, 0);
        let k1 = derive("d", 0, 0, &ROOT_KEY, 1);
        assert_ne!(k0, k1);
    }

    #[test]
    fn different_sessions() {
        let k0 = derive("d", 0, 0, &ROOT_KEY, 0);
        let k1 = derive("d", 0, 1, &ROOT_KEY, 0);
        assert_ne!(k0, k1);
    }

    #[test]
    fn different_versions() {
        let k0 = derive("d", 0, 0, &ROOT_KEY, 0);
        let k1 = derive("d", 1, 0, &ROOT_KEY, 0);
        assert_ne!(k0, k1);
    }

    #[test]
    fn different_root_keys() {
        let other_root = [0xBB; 32];
        let k0 = derive("d", 0, 0, &ROOT_KEY, 0);
        let k1 = derive("d", 0, 0, &other_root, 0);
        assert_ne!(k0, k1);
    }

    #[test]
    fn different_domains() {
        let k0 = derive("d", 0, 0, &ROOT_KEY, 0);
        let k1 = derive("other-domain", 0, 0, &ROOT_KEY, 0);
        assert_ne!(k0, k1);
    }
}
