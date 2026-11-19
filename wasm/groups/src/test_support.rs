//! Deterministic identities for tests.

use auth::{StaticRootSecret, UserPublicKeys, UserSecretKeys, derive_keys_from_static_root_secret};

use crate::ids::GossipId;

pub(crate) struct Identity {
    pub public: UserPublicKeys,
    pub secret: UserSecretKeys,
    pub id: GossipId,
}

/// The identity derived by `auth` from the root secret `[seed; 32]`.
pub(crate) fn identity(seed: u8) -> Identity {
    let (public, secret) =
        derive_keys_from_static_root_secret(&StaticRootSecret::from_bytes([seed; 32]));
    let id = GossipId::of_keys(&public);
    Identity { public, secret, id }
}
