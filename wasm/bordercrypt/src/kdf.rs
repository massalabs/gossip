//! Key derivation for bordercrypt.

use zeroize::Zeroizing;

use crate::domain::{block_aead_key_label, block_kdf_salt, block_scope};
use crate::types::SessionIndex;

/// Derived session keys from a password.
pub struct SessionKeys {
    pub sk_wrap_key: Zeroizing<[u8; crypto_aead::KEY_SIZE]>,
    pub root_aead_key: Zeroizing<[u8; crypto_aead::KEY_SIZE]>,
}

/// Derive session keys (sk_wrap_key, root_aead_key) from a password and domain.
pub fn derive_session_keys(domain: &str, password: &[u8]) -> SessionKeys {
    let salt = crate::domain::password_kdf_salt(domain);
    let mut root_key = Zeroizing::new([0u8; 32]);
    crypto_password_kdf::derive(password, salt.as_bytes(), root_key.as_mut());

    let root_kdf_salt = crate::domain::root_kdf_salt(domain);
    let expander = {
        let mut extract = crypto_kdf::Extract::new(root_kdf_salt.as_bytes());
        extract.input_item(root_key.as_ref());
        extract.finalize()
    };

    let sk_wrap_label = crate::domain::sk_wrap_key_label(domain);
    let mut sk_wrap_key = Zeroizing::new([0u8; crypto_aead::KEY_SIZE]);
    expander.expand(sk_wrap_label.as_bytes(), sk_wrap_key.as_mut());

    let root_aead_label = crate::domain::root_aead_key_label(domain);
    let mut root_aead_key = Zeroizing::new([0u8; crypto_aead::KEY_SIZE]);
    expander.expand(root_aead_label.as_bytes(), root_aead_key.as_mut());

    SessionKeys {
        sk_wrap_key,
        root_aead_key,
    }
}

/// Derive the per-block AEAD key and block scope for a given session and block index.
///
/// Returns `(aead_key, block_scope)` where `block_scope` is the domain-separated
/// string for the block, used as the root of the AEAD AAD.
pub fn derive_block_aead_key(
    domain: &str,
    version: u32,
    index: SessionIndex,
    root_aead_key: &[u8],
    block: u64,
) -> (Zeroizing<[u8; crypto_aead::KEY_SIZE]>, String) {
    let mut buf = String::new();

    block_kdf_salt(&mut buf, domain, version, index, block);
    let expander = {
        let mut extract = crypto_kdf::Extract::new(buf.as_bytes());
        extract.input_item(root_aead_key);
        extract.input_item(&u32::from(index.as_u8()).to_be_bytes());
        extract.input_item(&block.to_be_bytes());
        extract.finalize()
    };

    block_aead_key_label(&mut buf, domain, version, index, block);
    let mut key = Zeroizing::new([0u8; crypto_aead::KEY_SIZE]);
    expander.expand(buf.as_bytes(), key.as_mut());

    block_scope(&mut buf, domain, version, index, block);
    (key, buf)
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
        let (key, _scope) = derive_block_aead_key(domain, version, idx(session), root, block);
        *key
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

    #[test]
    fn returns_block_scope() {
        let (_key, scope) = derive_block_aead_key("app", 0, idx(2), &ROOT_KEY, 5);
        assert_eq!(scope, "app:bordercrypt:session:v0:i2:b5");
    }
}
