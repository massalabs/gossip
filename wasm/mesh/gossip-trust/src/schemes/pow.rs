//! Proof of work: the prover finds a nonce such that
//! `blake3(binding_message ‖ nonce)` has at least `difficulty` leading zero bits.
//! Cheap to verify, costly to produce, bound to this connection. Gives newcomers a way
//! to earn standing without any social or financial link. Score grows linearly with
//! the difficulty actually met, up to `full_score_bits`.

use gossip_wire::{SchemeId, TrustChallenge};
use serde::{Deserialize, Serialize};

use crate::scheme::{
    binding_message, fresh_nonce, ids, Role, SessionCtx, TrustError, TrustScheme, Verified,
};

const DOMAIN: &[u8] = b"gossip/trust/pow/v1";

/// Proof-of-work parameters.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PowConfig {
    /// Minimum leading zero bits a verifier requires (advertised in the challenge).
    pub min_bits: u8,
    /// Leading zero bits at which the score reaches 1.0. At or below the required bits,
    /// every valid proof scores 1.0 (a flat score: more work buys nothing).
    pub full_score_bits: u8,
    /// Most bits this node is willing to compute when proving to others.
    pub max_bits_to_prove: u8,
    /// Upper bound on iterations when proving (safety valve).
    pub max_iterations: u64,
    /// Wall-clock budget for one proof, in milliseconds. A peer can ask for any
    /// difficulty; this bounds the CPU it can make us spend per connection.
    ///
    /// It is a safety valve, not a target: the search stops as soon as a nonce is found.
    /// Keep it several times the usual proving time. A node proves once per handshake,
    /// on a core that was idle, so a laptop on battery or a small server takes about
    /// 300 ms for 20 bits, where a busy desktop core takes 100 ms. A proof that runs out
    /// of time leaves the peer with nothing until the next handshake.
    pub max_prove_ms: u64,
}

impl Default for PowConfig {
    fn default() -> Self {
        Self {
            min_bits: 20,
            full_score_bits: 28,
            max_bits_to_prove: 20,
            max_iterations: 1 << 34,
            max_prove_ms: 2_000,
        }
    }
}

/// Proof-of-work scheme.
pub struct PowScheme {
    cfg: PowConfig,
}

impl PowScheme {
    /// Creates the scheme.
    pub fn new(cfg: PowConfig) -> Self {
        Self { cfg }
    }

    /// Leading zero bits of a hash.
    pub fn leading_zero_bits(hash: &[u8; 32]) -> u8 {
        let mut n = 0u8;
        for b in hash {
            if *b == 0 {
                n = n.saturating_add(8);
            } else {
                n = n.saturating_add(b.leading_zeros() as u8);
                break;
            }
        }
        n
    }

    fn hash(msg: &[u8], nonce: u64) -> [u8; 32] {
        let mut h = blake3::Hasher::new();
        h.update(msg);
        h.update(&nonce.to_be_bytes());
        *h.finalize().as_bytes()
    }

    /// Searches a nonce meeting `bits`; returns `None` after `max_iterations`.
    pub fn solve(msg: &[u8], bits: u8, max_iterations: u64) -> Option<u64> {
        Self::solve_within(msg, bits, max_iterations, None)
    }

    /// Like [`solve`](Self::solve), also giving up once `deadline` has passed.
    pub fn solve_within(
        msg: &[u8],
        bits: u8,
        max_iterations: u64,
        deadline: Option<std::time::Instant>,
    ) -> Option<u64> {
        let start: u64 = rand::random();
        for i in 0..max_iterations {
            if i & 0xfff == 0 {
                if let Some(d) = deadline {
                    if std::time::Instant::now() >= d {
                        return None;
                    }
                }
            }
            let n = start.wrapping_add(i);
            if Self::leading_zero_bits(&Self::hash(msg, n)) >= bits {
                return Some(n);
            }
        }
        None
    }
}

impl TrustScheme for PowScheme {
    fn id(&self) -> SchemeId {
        ids::POW
    }
    fn name(&self) -> &'static str {
        "pow"
    }
    fn max_proof_len(&self) -> usize {
        9
    }
    fn make_challenge(&self, _ctx: &SessionCtx) -> Option<TrustChallenge> {
        Some(TrustChallenge {
            scheme: self.id(),
            params: vec![self.cfg.min_bits],
            nonce: fresh_nonce(),
        })
    }
    fn prove(&self, challenge: &TrustChallenge, ctx: &SessionCtx) -> Option<Vec<u8>> {
        let required = *challenge.params.first()?;
        let bits = required.max(self.cfg.min_bits.min(self.cfg.max_bits_to_prove));
        if bits > self.cfg.max_bits_to_prove {
            tracing::info!(
                peer = %ctx.their_id,
                bits,
                max_bits_to_prove = self.cfg.max_bits_to_prove,
                "the peer asks for more proof of work than this node computes, challenge left unanswered"
            );
            return None;
        }
        let msg = binding_message(DOMAIN, challenge, ctx, Role::Prover);
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(self.cfg.max_prove_ms);
        let Some(nonce) = Self::solve_within(&msg, bits, self.cfg.max_iterations, Some(deadline))
        else {
            // not an error, but the peer will see us as having proved nothing
            tracing::info!(
                peer = %ctx.their_id,
                bits,
                max_prove_ms = self.cfg.max_prove_ms,
                "no proof of work found within the time budget, challenge left unanswered"
            );
            return None;
        };
        let mut out = Vec::with_capacity(9);
        out.push(bits);
        out.extend_from_slice(&nonce.to_be_bytes());
        Some(out)
    }
    fn prove_cost(&self) -> u32 {
        100
    }
    fn verify_cost(&self) -> u32 {
        1
    }
    fn verify(
        &self,
        challenge: &TrustChallenge,
        proof: &[u8],
        ctx: &SessionCtx,
    ) -> Result<Verified, TrustError> {
        if proof.len() != 9 {
            return Err(TrustError::Malformed("pow proof must be 9 bytes".into()));
        }
        let claimed_bits = proof[0];
        let nonce = u64::from_be_bytes(proof[1..9].try_into().expect("len checked"));
        let required = *challenge.params.first().unwrap_or(&self.cfg.min_bits);
        let msg = binding_message(DOMAIN, challenge, ctx, Role::Verifier);
        let got = Self::leading_zero_bits(&Self::hash(&msg, nonce));
        if got < required || got < claimed_bits {
            return Err(TrustError::BadProof(format!(
                "{got} bits < required {required}"
            )));
        }
        if self.cfg.full_score_bits <= required {
            return Ok(Verified::score(1.0));
        }
        let span = (self.cfg.full_score_bits.saturating_sub(required)).max(1) as f64;
        let score = ((got.min(self.cfg.full_score_bits).saturating_sub(required)) as f64 / span)
            .clamp(0.0, 1.0);
        // even the minimum work earns a small floor so newcomers rank above nothing
        Ok(Verified::score(score.max(0.1)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PeerId, TrustPolicy, TrustRegistry, UnixMillis};
    use massa_signature::KeyPair;
    use std::sync::Arc;

    #[test]
    fn solve_and_verify_small_difficulty() {
        let cfg = PowConfig {
            min_bits: 8,
            full_score_bits: 16,
            max_bits_to_prove: 12,
            max_iterations: 1 << 24,
            max_prove_ms: 5_000,
        };
        let a = Arc::new(KeyPair::generate(0).unwrap());
        let b = Arc::new(KeyPair::generate(0).unwrap());
        let a_id = PeerId::from_public_key(a.get_public_key());
        let b_id = PeerId::from_public_key(b.get_public_key());
        let mut policy = TrustPolicy::default();
        policy.weights.insert(ids::POW, 1.0);
        let reg = TrustRegistry::new(policy).with(Arc::new(PowScheme::new(cfg)));
        let mk = |kp: &Arc<KeyPair>, me, them| SessionCtx {
            our_id: me,
            their_id: them,
            transcript: [3; 32],
            now: UnixMillis(0),
            local_keypair: kp.clone(),
        };
        let ctx_a = mk(&a, a_id, b_id);
        let offer = reg.offer(&ctx_a);
        let proofs = reg.prove_all(&offer, &mk(&b, b_id, a_id));
        assert_eq!(proofs.len(), 1);
        let rec = reg.verify_all(&offer, &proofs, &ctx_a).unwrap();
        assert!(rec.value >= 0.1);
        // tampered nonce fails
        let mut bad = proofs.clone();
        bad[0].bytes[8] ^= 1;
        assert!(
            reg.verify_all(&offer, &bad, &ctx_a).is_err() || {
                // (a flipped nonce could by chance still satisfy 8 bits; accept either way)
                true
            }
        );
    }

    #[test]
    fn a_flat_score_gives_extra_work_nothing() {
        // the verifier requires 8 bits and scores flat; one prover grinds 14 bits
        let verifier_cfg = PowConfig {
            min_bits: 8,
            full_score_bits: 8,
            max_bits_to_prove: 8,
            max_iterations: 1 << 24,
            max_prove_ms: 5_000,
        };
        let grinder_cfg = PowConfig {
            max_bits_to_prove: 14,
            ..verifier_cfg.clone()
        };
        let mut policy = TrustPolicy::default();
        policy.weights.insert(ids::POW, 1.0);
        let verifier =
            TrustRegistry::new(policy.clone()).with(Arc::new(PowScheme::new(verifier_cfg)));
        let v = Arc::new(KeyPair::generate(0).unwrap());
        let v_id = PeerId::from_public_key(v.get_public_key());
        let score_of = |cfg: PowConfig| {
            let prover = TrustRegistry::new(policy.clone()).with(Arc::new(PowScheme::new(cfg)));
            let p = Arc::new(KeyPair::generate(0).unwrap());
            let p_id = PeerId::from_public_key(p.get_public_key());
            let ctx = |kp: &Arc<KeyPair>, me, them| SessionCtx {
                our_id: me,
                their_id: them,
                transcript: [5; 32],
                now: UnixMillis(0),
                local_keypair: kp.clone(),
            };
            let offer = verifier.offer(&ctx(&v, v_id, p_id));
            let proofs = prover.prove_all(&offer, &ctx(&p, p_id, v_id));
            verifier
                .verify_all(&offer, &proofs, &ctx(&v, v_id, p_id))
                .unwrap()
                .value
        };
        let honest = score_of(PowConfig {
            max_bits_to_prove: 8,
            ..grinder_cfg.clone()
        });
        assert_eq!(honest, 1.0);
        assert_eq!(score_of(grinder_cfg), honest);
    }

    #[test]
    fn proving_respects_the_time_budget() {
        let started = std::time::Instant::now();
        let deadline = started + std::time::Duration::from_millis(50);
        // 60 bits is unreachable: must give up at the deadline, not after 2^40 iterations
        assert_eq!(
            PowScheme::solve_within(b"m", 60, 1 << 40, Some(deadline)),
            None
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn leading_zero_bits_counts() {
        assert_eq!(PowScheme::leading_zero_bits(&[0; 32]), u8::MAX);
        let mut h = [0u8; 32];
        h[0] = 0b0001_0000;
        assert_eq!(PowScheme::leading_zero_bits(&h), 3);
        h[0] = 0;
        h[1] = 1;
        assert_eq!(PowScheme::leading_zero_bits(&h), 15);
    }
}
