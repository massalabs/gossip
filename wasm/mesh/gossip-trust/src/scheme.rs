//! The unit of extensibility: a trust scheme.

use std::sync::Arc;

use gossip_wire::{PeerId, SchemeId, TrustChallenge, UnixMillis};
use massa_signature::KeyPair;

/// Well-known scheme identifiers. Ids below 256 are reserved for schemes shipped with
/// the backend; forks should use ids ≥ 4096.
pub mod ids {
    use gossip_wire::SchemeId;
    /// Placeholder scheme that never proves anything (useful in tests and as a probe).
    pub const NOOP: SchemeId = 0;
    /// Membership in a keyring, proven by a signature that reveals the member key.
    pub const KEYRING_DIRECT: SchemeId = 1;
    /// Membership in a keyring, proven by a linkable ring signature (anonymous).
    pub const KEYRING_RING: SchemeId = 2;
    /// Proof of work bound to the challenge.
    pub const POW: SchemeId = 3;
    /// The peer id itself is in a configured allowlist (signature by the peer key).
    pub const PEER_ALLOWLIST: SchemeId = 4;
    /// Zero-knowledge proof of holding at least X active rolls on Massa.
    pub const MASSA_STAKE_ZK: SchemeId = 16;
}

/// Which side of the handshake the local node plays for a given call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// We answer the peer's challenge.
    Prover,
    /// We check the peer's answer to our challenge.
    Verifier,
}

/// Everything a scheme may need to know about the connection being negotiated.
#[derive(Clone)]
pub struct SessionCtx {
    /// Our own peer id.
    pub our_id: PeerId,
    /// The remote peer id (already authenticated by the transport handshake).
    pub their_id: PeerId,
    /// Transcript binding: blake3 of both handshake random challenges. Proofs are bound
    /// to it so they cannot be relayed to another connection.
    pub transcript: [u8; 32],
    /// Current time.
    pub now: UnixMillis,
    /// Our keypair, for schemes that sign with the node key.
    pub local_keypair: Arc<KeyPair>,
}

impl SessionCtx {
    /// `(prover, verifier)` peer ids for the given role.
    pub fn parties(&self, role: Role) -> (&PeerId, &PeerId) {
        match role {
            Role::Prover => (&self.our_id, &self.their_id),
            Role::Verifier => (&self.their_id, &self.our_id),
        }
    }
}

/// The message every scheme signs or hashes into its proof. Binds the proof to the
/// scheme, the verifier's nonce, the transcript and both peer ids.
pub fn binding_message(
    domain: &[u8],
    challenge: &TrustChallenge,
    ctx: &SessionCtx,
    role: Role,
) -> Vec<u8> {
    let (prover, verifier) = ctx.parties(role);
    let prover = prover.to_bytes();
    let verifier = verifier.to_bytes();
    let mut m = Vec::with_capacity(domain.len() + 2 + 32 + 32 + prover.len() + verifier.len() + 8);
    m.extend_from_slice(&(domain.len() as u16).to_be_bytes());
    m.extend_from_slice(domain);
    m.extend_from_slice(&challenge.scheme.to_be_bytes());
    m.extend_from_slice(&challenge.nonce);
    m.extend_from_slice(&ctx.transcript);
    m.extend_from_slice(&(prover.len() as u16).to_be_bytes());
    m.extend_from_slice(&prover);
    m.extend_from_slice(&(verifier.len() as u16).to_be_bytes());
    m.extend_from_slice(&verifier);
    m
}

/// A linkability tag produced by a proof: a nullifier or key image. Two proofs with the
/// same `(scheme, scope, value)` come from the same underlying identity.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Tag {
    /// Scope within which the tag is stable (e.g. an epoch, or a keyring id).
    pub scope: Vec<u8>,
    /// The tag value.
    pub value: [u8; 32],
}

/// Outcome of a successful verification.
#[derive(Clone, Debug, PartialEq)]
pub struct Verified {
    /// Scheme-local score in `0.0..=1.0` (the policy weights it).
    pub score: f64,
    /// Optional linkability tag for the anti-Sybil registry.
    pub tag: Option<Tag>,
}

impl Verified {
    /// Score without a tag.
    pub fn score(score: f64) -> Self {
        Self {
            score: score.clamp(0.0, 1.0),
            tag: None,
        }
    }
}

/// Why a proof was rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TrustError {
    /// the proof does not verify
    #[error("invalid proof: {0}")]
    BadProof(String),
    /// the proof is well-formed but refers to data we do not accept (old root, unknown set…)
    #[error("proof not acceptable: {0}")]
    NotAcceptable(String),
    /// malformed proof or parameters
    #[error("malformed: {0}")]
    Malformed(String),
    /// proof bytes exceed the scheme limit
    #[error("proof too large")]
    TooLarge,
    /// the tag is already claimed by another peer
    #[error("identity already used by another peer")]
    Sybil,
    /// internal failure while verifying
    #[error("internal error: {0}")]
    Internal(String),
}

/// A pluggable trust scheme: a claim about a peer, the challenge a verifier issues, the
/// proof a prover returns, and the procedure to check it.
pub trait TrustScheme: Send + Sync {
    /// Scheme id (see [`ids`]).
    fn id(&self) -> SchemeId;
    /// Human-readable name for logs and config.
    fn name(&self) -> &'static str;
    /// Upper bound on proof size this scheme may produce or accept.
    fn max_proof_len(&self) -> usize;
    /// Verifier side: build the challenge to advertise, or `None` to not offer the
    /// scheme on this connection (e.g. reference data is missing).
    fn make_challenge(&self, ctx: &SessionCtx) -> Option<TrustChallenge>;
    /// Prover side: answer a peer's challenge, or `None` if we cannot satisfy it.
    fn prove(&self, challenge: &TrustChallenge, ctx: &SessionCtx) -> Option<Vec<u8>>;
    /// Verifier side: check a proof against the challenge we issued.
    fn verify(
        &self,
        challenge: &TrustChallenge,
        proof: &[u8],
        ctx: &SessionCtx,
    ) -> Result<Verified, TrustError>;

    /// Relative cost of [`verify`](Self::verify). Proofs are verified cheapest first,
    /// and schemes at or above [`EXPENSIVE_VERIFY_COST`] only run while a slot of the
    /// registry's concurrency cap is free. Guidance: hashing 1, one signature 2-5, ring
    /// signatures 100, zero-knowledge receipts 1000.
    fn verify_cost(&self) -> u32 {
        10
    }

    /// Relative cost of [`prove`](Self::prove) for this node. Schemes at or above
    /// [`EXPENSIVE_PROVE_COST`] take a node-wide proving slot and draw on the policy's
    /// proving budget, so peers cannot make the node spend unbounded CPU answering
    /// challenges. Guidance: loading a stored proof 1, one signature 2-5, proof of work or
    /// ring signatures 100.
    fn prove_cost(&self) -> u32 {
        10
    }

    /// A value that changes whenever what this node can prove or challenge with this
    /// scheme changes (a new proof file, reference data that became available...).
    /// Polled every few seconds: a change makes the node refresh the trust round of
    /// every connection, so it must be cheap and must not change for no reason.
    fn local_state(&self) -> u64 {
        0
    }
}

/// Verification cost at or above which a scheme counts as expensive.
pub const EXPENSIVE_VERIFY_COST: u32 = 50;

/// Proving cost at or above which answering a challenge counts as expensive.
pub const EXPENSIVE_PROVE_COST: u32 = 50;

/// Fresh 32-byte nonce.
pub fn fresh_nonce() -> [u8; 32] {
    let mut n = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut n);
    n
}
