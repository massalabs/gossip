//! The registry drives the trust round of the handshake on both sides and folds the
//! result into a [`TrustRecord`].

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use gossip_wire::{PeerId, SchemeId, TrustChallenge, TrustProof, UnixMillis};
use parking_lot::{Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

use crate::behaviour::{BehaviourLedger, Misbehaviour};
use crate::nullifier::NullifierRegistry;
use crate::policy::TrustPolicy;
use crate::record::TrustRecord;
use crate::scheme::{
    SessionCtx, Tag, TrustError, TrustScheme, EXPENSIVE_PROVE_COST, EXPENSIVE_VERIFY_COST,
};

/// Why `verify_all` refused the peer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VerifyFailure {
    /// a proof for one of our challenges failed
    #[error("proof for scheme {scheme} rejected: {error}")]
    BadProof {
        /// Scheme id.
        scheme: SchemeId,
        /// Error.
        error: TrustError,
    },
    /// the same scheme was answered twice
    #[error("duplicate proof for scheme {0}")]
    Duplicate(SchemeId),
    /// a tag from a proof is already held by another peer
    #[error("identity behind scheme {0} is already bound to another peer")]
    Sybil(SchemeId),
}

/// Releases a proving slot on drop and wakes one waiting handshake.
struct ProvingSlot<'a> {
    registry: &'a TrustRegistry,
}

impl Drop for ProvingSlot<'_> {
    fn drop(&mut self) {
        let mut busy = self.registry.proving_busy.lock();
        *busy = busy.saturating_sub(1);
        drop(busy);
        self.registry.proving_freed.notify_one();
    }
}

/// Releases an expensive-verification slot on drop and wakes one waiting verifier.
struct SlotGuard<'a> {
    registry: &'a TrustRegistry,
}

impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        let mut busy = self.registry.expensive_busy.lock();
        *busy = busy.saturating_sub(1);
        drop(busy);
        self.registry.expensive_freed.notify_one();
    }
}

/// The registered schemes, kept together so the two views never disagree.
#[derive(Default)]
struct SchemeSet {
    schemes: Vec<Arc<dyn TrustScheme>>,
    by_id: HashMap<SchemeId, usize>,
}

/// Registry of schemes plus the policy and shared anti-Sybil state.
///
/// Schemes and the policy can be changed while the node runs (the operator dashboard
/// does so), so both sit behind a lock and every reader takes a snapshot rather than
/// holding a guard across a verification.
pub struct TrustRegistry {
    set: RwLock<SchemeSet>,
    policy: RwLock<TrustPolicy>,
    nullifiers: Mutex<NullifierRegistry>,
    behaviour: Mutex<BehaviourLedger>,
    /// Bumped whenever a scheme is registered or removed.
    generation: AtomicU64,
    expensive_busy: Mutex<usize>,
    expensive_freed: Condvar,
    proving_busy: Mutex<usize>,
    proving_freed: Condvar,
    /// (available milliseconds, last refill)
    proving_bucket: Mutex<(f64, Instant)>,
}

impl TrustRegistry {
    /// Registry with no scheme.
    pub fn new(policy: TrustPolicy) -> Self {
        let policy_budget_ms = policy.proving_budget_ms_per_min as f64;
        Self {
            set: RwLock::new(SchemeSet::default()),
            policy: RwLock::new(policy),
            nullifiers: Mutex::new(NullifierRegistry::new()),
            behaviour: Mutex::new(BehaviourLedger::new()),
            generation: AtomicU64::new(0),
            expensive_busy: Mutex::new(0),
            expensive_freed: Condvar::new(),
            proving_busy: Mutex::new(0),
            proving_freed: Condvar::new(),
            proving_bucket: Mutex::new((policy_budget_ms, Instant::now())),
        }
    }

    /// Adds a scheme, replacing one with the same id. Takes effect on the next
    /// handshake; connections already established keep the value they were given.
    pub fn register(&self, scheme: Arc<dyn TrustScheme>) {
        let id = scheme.id();
        let mut set = self.set.write();
        match set.by_id.get(&id).copied() {
            Some(i) => set.schemes[i] = scheme,
            None => {
                let i = set.schemes.len();
                set.by_id.insert(id, i);
                set.schemes.push(scheme);
            }
        }
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    /// Removes a scheme. `true` when it was registered. The node then neither offers
    /// it nor answers it, and peers that proved it keep their recorded value until
    /// their next trust round.
    pub fn unregister(&self, id: SchemeId) -> bool {
        let mut set = self.set.write();
        let Some(i) = set.by_id.remove(&id) else {
            return false;
        };
        set.schemes.remove(i);
        // indices after the removed one shift down
        for index in set.by_id.values_mut() {
            if *index > i {
                *index -= 1;
            }
        }
        self.generation.fetch_add(1, Ordering::Relaxed);
        true
    }

    /// A value that changes whenever what this node proves or challenges changes: a
    /// scheme registered or removed, or a scheme's [`TrustScheme::local_state`].
    pub fn local_state(&self) -> u64 {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.generation.load(Ordering::Relaxed).hash(&mut hasher);
        for scheme in self.schemes() {
            (scheme.id(), scheme.local_state()).hash(&mut hasher);
        }
        hasher.finish()
    }

    /// Builder-style [`register`](Self::register).
    pub fn with(self, scheme: Arc<dyn TrustScheme>) -> Self {
        self.register(scheme);
        self
    }

    /// A snapshot of the policy.
    pub fn policy(&self) -> TrustPolicy {
        self.policy.read().clone()
    }

    /// Replaces the policy. Weights and thresholds apply immediately; values already
    /// recorded for connected peers are re-folded at their next trust round.
    pub fn set_policy(&self, policy: TrustPolicy) {
        *self.policy.write() = policy;
    }

    /// Changes one scheme's weight in the fold.
    pub fn set_weight(&self, scheme: SchemeId, weight: f64) {
        self.policy.write().weights.insert(scheme, weight);
    }

    /// Registered schemes.
    pub fn schemes(&self) -> Vec<Arc<dyn TrustScheme>> {
        self.set.read().schemes.clone()
    }

    /// Scheme by id.
    pub fn scheme(&self, id: SchemeId) -> Option<Arc<dyn TrustScheme>> {
        let set = self.set.read();
        set.by_id.get(&id).map(|&i| set.schemes[i].clone())
    }

    /// Largest proof any registered scheme may produce or accept.
    pub fn max_proof_len(&self) -> usize {
        self.set
            .read()
            .schemes
            .iter()
            .map(|s| s.max_proof_len())
            .max()
            .unwrap_or(0)
    }

    /// Verifier side, step 1: the challenges we advertise to the peer.
    pub fn offer(&self, ctx: &SessionCtx) -> Vec<TrustChallenge> {
        self.schemes()
            .iter()
            .filter_map(|s| s.make_challenge(ctx))
            .collect()
    }

    /// Prover side: answer whatever challenges we can.
    pub fn prove_all(&self, challenges: &[TrustChallenge], ctx: &SessionCtx) -> Vec<TrustProof> {
        let mut seen = HashSet::new();
        challenges
            .iter()
            .filter(|c| seen.insert(c.scheme))
            .filter_map(|c| {
                let scheme = self.scheme(c.scheme)?;
                let bytes = if scheme.prove_cost() >= EXPENSIVE_PROVE_COST {
                    self.prove_expensive(scheme.as_ref(), c, ctx)?
                } else {
                    scheme.prove(c, ctx)?
                };
                if bytes.len() > scheme.max_proof_len() {
                    tracing::warn!(
                        scheme = c.scheme,
                        len = bytes.len(),
                        "proof exceeds scheme limit, dropping"
                    );
                    return None;
                }
                Some(TrustProof {
                    scheme: c.scheme,
                    bytes,
                })
            })
            .collect()
    }

    /// Answers an expensive challenge within the node-wide proving limits: waits for a
    /// proving slot (up to `proving_slot_wait_ms`), requires budget left, and charges the
    /// time actually spent.
    fn prove_expensive(
        &self,
        scheme: &dyn TrustScheme,
        challenge: &TrustChallenge,
        ctx: &SessionCtx,
    ) -> Option<Vec<u8>> {
        let Some(_slot) = self.wait_proving_slot() else {
            tracing::debug!(peer = %ctx.their_id, scheme = challenge.scheme, "no proving slot free, challenge left unanswered");
            return None;
        };
        if !self.proving_budget_left() {
            tracing::debug!(peer = %ctx.their_id, scheme = challenge.scheme, "proving budget exhausted, challenge left unanswered");
            return None;
        }
        let started = Instant::now();
        let proof = scheme.prove(challenge, ctx);
        self.charge_proving(started.elapsed());
        proof
    }

    fn wait_proving_slot(&self) -> Option<ProvingSlot<'_>> {
        let (max, wait_ms) = {
            let policy = self.policy.read();
            (
                policy.max_concurrent_expensive_proofs,
                policy.proving_slot_wait_ms,
            )
        };
        if max == 0 {
            return None;
        }
        let deadline = Instant::now() + Duration::from_millis(wait_ms);
        let mut busy = self.proving_busy.lock();
        while *busy >= max {
            if self
                .proving_freed
                .wait_until(&mut busy, deadline)
                .timed_out()
                && *busy >= max
            {
                return None;
            }
        }
        *busy += 1;
        Some(ProvingSlot { registry: self })
    }

    fn proving_budget_left(&self) -> bool {
        let capacity = self.policy.read().proving_budget_ms_per_min as f64;
        if capacity <= 0.0 {
            return false;
        }
        let mut bucket = self.proving_bucket.lock();
        let now = Instant::now();
        let refill = now.duration_since(bucket.1).as_secs_f64() * 1000.0 * capacity / 60_000.0;
        bucket.0 = (bucket.0 + refill).min(capacity);
        bucket.1 = now;
        bucket.0 > 0.0
    }

    fn charge_proving(&self, spent: Duration) {
        self.proving_bucket.lock().0 -= spent.as_secs_f64() * 1000.0;
    }

    /// Verifier side, step 2: [`verify_proofs`](Self::verify_proofs) then
    /// [`claim_tags`](Self::claim_tags) for the peer. Convenient when admission cannot
    /// fail afterwards; the handshake uses the two steps separately.
    pub fn verify_all(
        &self,
        our_challenges: &[TrustChallenge],
        proofs: &[TrustProof],
        ctx: &SessionCtx,
    ) -> Result<TrustRecord, VerifyFailure> {
        let record = self.verify_proofs(our_challenges, proofs, ctx)?;
        self.claim_tags(&ctx.their_id, &record, ctx.now)?;
        Ok(record)
    }

    /// Verifies the peer's proofs to our challenges and folds them into a record,
    /// **without** claiming anti-Sybil tags (they are listed in `record.tags`).
    ///
    /// Proofs for schemes we did not challenge are ignored. Proofs are verified
    /// cheapest first ([`TrustScheme::verify_cost`]); an expensive proof is skipped
    /// without penalty when every expensive-verification slot is busy. A forged or
    /// malformed proof is an error (when the policy says so) and a misbehaviour; a proof
    /// that is merely not acceptable is ignored.
    pub fn verify_proofs(
        &self,
        our_challenges: &[TrustChallenge],
        proofs: &[TrustProof],
        ctx: &SessionCtx,
    ) -> Result<TrustRecord, VerifyFailure> {
        self.verify_proofs_within(our_challenges, proofs, ctx, Duration::ZERO)
    }

    /// [`verify_proofs`](Self::verify_proofs), but an expensive proof waits up to
    /// `slot_wait` for a verification slot before it is skipped. For callers that
    /// would rather be late than drop a proof, such as a trust refresh, where a
    /// skipped proof would lower the trust of a peer that proved it.
    pub fn verify_proofs_within(
        &self,
        our_challenges: &[TrustChallenge],
        proofs: &[TrustProof],
        ctx: &SessionCtx,
        slot_wait: Duration,
    ) -> Result<TrustRecord, VerifyFailure> {
        let challenged: HashMap<SchemeId, &TrustChallenge> =
            our_challenges.iter().map(|c| (c.scheme, c)).collect();
        let mut seen = HashSet::new();
        for p in proofs {
            if !seen.insert(p.scheme) {
                return Err(VerifyFailure::Duplicate(p.scheme));
            }
        }
        let policy = self.policy();
        let mut ordered: Vec<(&TrustProof, Arc<dyn TrustScheme>, &TrustChallenge)> = proofs
            .iter()
            .filter_map(|p| Some((p, self.scheme(p.scheme)?, *challenged.get(&p.scheme)?)))
            .collect();
        ordered.sort_by_key(|(_, scheme, _)| scheme.verify_cost());

        let mut scores: Vec<(SchemeId, f64)> = Vec::new();
        let mut tags: Vec<(SchemeId, Tag)> = Vec::new();
        for (p, scheme, challenge) in ordered {
            let _slot = if scheme.verify_cost() >= EXPENSIVE_VERIFY_COST {
                match self.expensive_slot(slot_wait) {
                    Some(guard) => Some(guard),
                    None => {
                        tracing::debug!(peer = %ctx.their_id, scheme = p.scheme, "expensive verification slots busy, proof skipped");
                        continue;
                    }
                }
            } else {
                None
            };
            let res = if p.bytes.len() > scheme.max_proof_len() {
                Err(TrustError::TooLarge)
            } else {
                scheme.verify(challenge, &p.bytes, ctx)
            };
            match res {
                Ok(v) => {
                    if let Some(tag) = v.tag {
                        tags.push((p.scheme, tag));
                    }
                    scores.push((p.scheme, v.score));
                }
                // A forged or malformed proof is misbehaviour. A proof that is merely not
                // acceptable to us (old root, unknown keyring, ring size outside our
                // bounds), or that we failed to check, is ignored: an honest peer with
                // different data or settings must not be penalised.
                Err(
                    error @ (TrustError::BadProof(_)
                    | TrustError::Malformed(_)
                    | TrustError::TooLarge
                    | TrustError::Sybil),
                ) => {
                    tracing::debug!(peer = %ctx.their_id, scheme = p.scheme, %error, "proof rejected");
                    self.record_misbehaviour(&ctx.their_id, Misbehaviour::BadProof, ctx.now);
                    if policy.reject_on_bad_proof {
                        return Err(VerifyFailure::BadProof {
                            scheme: p.scheme,
                            error,
                        });
                    }
                }
                Err(error) => {
                    tracing::debug!(peer = %ctx.their_id, scheme = p.scheme, %error, "proof not acceptable, ignored");
                }
            }
        }
        let raw = policy.fold(&scores);
        let mult = self.behaviour.lock().multiplier(
            &ctx.their_id,
            ctx.now,
            policy.behaviour_ttl_ms,
            policy.behaviour_penalty,
        );
        Ok(TrustRecord {
            value: raw * mult,
            proven: scores,
            last_proof_at: ctx.now,
            tags,
        })
    }

    /// Claims every tag of `record` for `peer`, all or nothing. On a collision nothing
    /// new stays claimed (tags `peer` already held before the call are kept), a
    /// [`Misbehaviour::SybilAttempt`] is recorded and the scheme is returned.
    pub fn claim_tags(
        &self,
        peer: &PeerId,
        record: &TrustRecord,
        now: UnixMillis,
    ) -> Result<(), VerifyFailure> {
        let grace = self.policy.read().nullifier_transfer_grace_ms;
        let mut reg = self.nullifiers.lock();
        let mut newly_claimed: Vec<(SchemeId, Tag)> = Vec::new();
        for (scheme, tag) in &record.tags {
            let already_ours = reg.holder(*scheme, tag) == Some(peer);
            if reg.claim(*scheme, tag.clone(), peer, now, grace).is_err() {
                for (s, t) in &newly_claimed {
                    reg.remove(*s, t);
                }
                drop(reg);
                self.record_misbehaviour(peer, Misbehaviour::SybilAttempt, now);
                return Err(VerifyFailure::Sybil(*scheme));
            }
            if !already_ours {
                newly_claimed.push((*scheme, tag.clone()));
            }
        }
        Ok(())
    }

    /// Releases every tag held by `peer` immediately. Call it when a handshake fails
    /// after [`claim_tags`](Self::claim_tags), or when the connection is refused.
    pub fn release_tags(&self, peer: &PeerId) {
        self.nullifiers.lock().release(peer);
    }

    /// Whether the peer's strikes reached the ban threshold.
    pub fn should_ban(&self, peer: &PeerId, now: UnixMillis) -> bool {
        self.strikes(peer, now) >= self.policy.read().ban_after_strikes
    }

    /// Takes an expensive-verification slot, waiting up to `wait` for one to free.
    fn expensive_slot(&self, wait: Duration) -> Option<SlotGuard<'_>> {
        let max = self.policy.read().max_concurrent_expensive_verifications;
        if max == 0 {
            return None;
        }
        let deadline = Instant::now() + wait;
        let mut busy = self.expensive_busy.lock();
        while *busy >= max {
            if self
                .expensive_freed
                .wait_until(&mut busy, deadline)
                .timed_out()
                && *busy >= max
            {
                return None;
            }
        }
        *busy += 1;
        Some(SlotGuard { registry: self })
    }

    /// Effective trust of a stored record now: the scores the peer proved, folded with
    /// the weights **in force now**, dropped to zero once the proofs age out, times the
    /// behaviour multiplier.
    ///
    /// Folding now rather than reusing the value recorded at proof time means a weight
    /// change moves every peer immediately, and that the behaviour penalty is applied
    /// exactly once.
    pub fn effective_trust(&self, peer: &PeerId, record: &TrustRecord, now: UnixMillis) -> f64 {
        let policy = self.policy();
        if now.0.saturating_sub(record.last_proof_at.0) > policy.proof_ttl_ms {
            return 0.0;
        }
        // a scheme this node no longer offers counts for nobody, even if peers proved
        // it earlier and its weight is still in the policy
        let registered = self.set.read();
        let scores: Vec<(SchemeId, f64)> = record
            .proven
            .iter()
            .filter(|(scheme, _)| registered.by_id.contains_key(scheme))
            .copied()
            .collect();
        drop(registered);
        let base = policy.fold(&scores);
        let multiplier = self.behaviour.lock().multiplier(
            peer,
            now,
            policy.behaviour_ttl_ms,
            policy.behaviour_penalty,
        );
        (base * multiplier).clamp(0.0, 1.0)
    }

    /// Records a misbehaviour; returns `true` when the peer should be banned.
    pub fn record_misbehaviour(&self, peer: &PeerId, kind: Misbehaviour, now: UnixMillis) -> bool {
        let (ttl, ban_after) = {
            let policy = self.policy.read();
            (policy.behaviour_ttl_ms, policy.ban_after_strikes)
        };
        let strikes = self.behaviour.lock().record(peer, kind, now, ttl);
        strikes >= ban_after
    }

    /// Current strike count.
    pub fn strikes(&self, peer: &PeerId, now: UnixMillis) -> u32 {
        let ttl = self.policy.read().behaviour_ttl_ms;
        self.behaviour.lock().strikes(peer, now, ttl)
    }

    /// Peer disconnected: its tags enter the transfer grace period.
    pub fn peer_disconnected(&self, peer: &PeerId, now: UnixMillis) {
        self.nullifiers.lock().disconnected(peer, now);
    }

    /// Peer still alive.
    pub fn peer_alive(&self, peer: &PeerId, now: UnixMillis) {
        self.nullifiers.lock().touch(peer, now);
    }

    /// Periodic maintenance.
    pub fn prune(&self, now: UnixMillis, scope_expired: impl Fn(SchemeId, &[u8]) -> bool) {
        let (proof_ttl, behaviour_ttl) = {
            let policy = self.policy.read();
            (policy.proof_ttl_ms, policy.behaviour_ttl_ms)
        };
        self.nullifiers.lock().prune(now, proof_ttl, scope_expired);
        self.behaviour.lock().prune(now, behaviour_ttl);
    }

    /// Lifts a ban: forgets strikes.
    pub fn forgive(&self, peer: &PeerId) {
        self.behaviour.lock().forget(peer);
    }

    /// Access to the nullifier registry (tests, diagnostics).
    pub fn nullifiers(&self) -> &Mutex<NullifierRegistry> {
        &self.nullifiers
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheme::{fresh_nonce, Role, Verified};
    use massa_signature::KeyPair;

    /// Test scheme: proof = nonce xor 0xff; tag = params.
    struct Echo {
        id: SchemeId,
        tagged: bool,
        offer: bool,
    }
    impl TrustScheme for Echo {
        fn id(&self) -> SchemeId {
            self.id
        }
        fn name(&self) -> &'static str {
            "echo"
        }
        fn max_proof_len(&self) -> usize {
            64
        }
        fn make_challenge(&self, _ctx: &SessionCtx) -> Option<TrustChallenge> {
            self.offer.then(|| TrustChallenge {
                scheme: self.id,
                params: vec![7],
                nonce: fresh_nonce(),
            })
        }
        fn prove(&self, c: &TrustChallenge, _ctx: &SessionCtx) -> Option<Vec<u8>> {
            Some(c.nonce.iter().map(|b| b ^ 0xff).collect())
        }
        fn verify(
            &self,
            c: &TrustChallenge,
            proof: &[u8],
            _ctx: &SessionCtx,
        ) -> Result<Verified, TrustError> {
            let expected: Vec<u8> = c.nonce.iter().map(|b| b ^ 0xff).collect();
            if proof != expected.as_slice() {
                return Err(TrustError::BadProof("mismatch".into()));
            }
            Ok(Verified {
                score: 1.0,
                tag: self.tagged.then(|| Tag {
                    scope: b"s".to_vec(),
                    value: [self.id as u8; 32],
                }),
            })
        }
    }

    fn ctx(a: &Arc<KeyPair>, b: &PeerId) -> SessionCtx {
        SessionCtx {
            our_id: PeerId::from_public_key(a.get_public_key()),
            their_id: *b,
            transcript: [1; 32],
            now: UnixMillis(1_000),
            local_keypair: a.clone(),
        }
    }

    fn peers() -> (Arc<KeyPair>, Arc<KeyPair>) {
        (
            Arc::new(KeyPair::generate(0).unwrap()),
            Arc::new(KeyPair::generate(0).unwrap()),
        )
    }

    #[test]
    fn full_round_folds_weights() {
        let mut policy = TrustPolicy::default();
        policy.weights.insert(1, 0.4);
        policy.weights.insert(2, 0.4);
        let reg = TrustRegistry::new(policy)
            .with(Arc::new(Echo {
                id: 1,
                tagged: false,
                offer: true,
            }))
            .with(Arc::new(Echo {
                id: 2,
                tagged: true,
                offer: true,
            }))
            .with(Arc::new(Echo {
                id: 3,
                tagged: false,
                offer: false,
            }));
        let (a, b) = peers();
        let a_id = PeerId::from_public_key(a.get_public_key());
        let b_id = PeerId::from_public_key(b.get_public_key());
        let ctx_a = ctx(&a, &b_id); // A verifies B
        let ctx_b = ctx(&b, &a_id); // B proves to A
        let offer = reg.offer(&ctx_a);
        assert_eq!(offer.len(), 2);
        let proofs = reg.prove_all(&offer, &ctx_b);
        let rec = reg.verify_all(&offer, &proofs, &ctx_a).unwrap();
        assert!((rec.value - 0.8).abs() < 1e-9);
        assert_eq!(rec.tags.len(), 1);
        assert!(rec.is_proven());
        // the same identity (same tag) from another peer id is a Sybil
        let (c, _) = peers();
        let c_id = PeerId::from_public_key(c.get_public_key());
        let ctx_a2 = ctx(&a, &c_id);
        let offer2 = reg.offer(&ctx_a2);
        let proofs2 = reg.prove_all(&offer2, &ctx(&c, &a_id));
        assert_eq!(
            reg.verify_all(&offer2, &proofs2, &ctx_a2).unwrap_err(),
            VerifyFailure::Sybil(2)
        );
        assert_eq!(reg.strikes(&c_id, UnixMillis(1_000)), 3);
        let _ = Role::Prover;
    }

    /// Scheme whose proofs are always "not acceptable" (e.g. a stale root).
    struct Stale;
    impl TrustScheme for Stale {
        fn id(&self) -> SchemeId {
            7
        }
        fn name(&self) -> &'static str {
            "stale"
        }
        fn max_proof_len(&self) -> usize {
            8
        }
        fn make_challenge(&self, _ctx: &SessionCtx) -> Option<TrustChallenge> {
            Some(TrustChallenge {
                scheme: 7,
                params: vec![],
                nonce: fresh_nonce(),
            })
        }
        fn prove(&self, _c: &TrustChallenge, _ctx: &SessionCtx) -> Option<Vec<u8>> {
            Some(vec![1])
        }
        fn verify(
            &self,
            _c: &TrustChallenge,
            _p: &[u8],
            _ctx: &SessionCtx,
        ) -> Result<Verified, TrustError> {
            Err(TrustError::NotAcceptable("old root".into()))
        }
    }

    #[test]
    fn not_acceptable_proof_is_ignored_without_penalty() {
        let reg = TrustRegistry::new(TrustPolicy::default()).with(Arc::new(Stale));
        let (a, b) = peers();
        let b_id = PeerId::from_public_key(b.get_public_key());
        let ctx_a = ctx(&a, &b_id);
        let offer = reg.offer(&ctx_a);
        let proofs = vec![TrustProof {
            scheme: 7,
            bytes: vec![1],
        }];
        let rec = reg.verify_all(&offer, &proofs, &ctx_a).unwrap();
        assert_eq!(rec.value, 0.0);
        assert!(!rec.is_proven());
        assert_eq!(reg.strikes(&b_id, UnixMillis(1_000)), 0);
    }

    /// Scheme with a fixed tag value and configurable cost.
    struct Tagged {
        id: SchemeId,
        value: u8,
        cost: u32,
    }
    impl TrustScheme for Tagged {
        fn id(&self) -> SchemeId {
            self.id
        }
        fn name(&self) -> &'static str {
            "tagged"
        }
        fn max_proof_len(&self) -> usize {
            8
        }
        fn make_challenge(&self, _ctx: &SessionCtx) -> Option<TrustChallenge> {
            Some(TrustChallenge {
                scheme: self.id,
                params: vec![],
                nonce: fresh_nonce(),
            })
        }
        fn prove(&self, _c: &TrustChallenge, _ctx: &SessionCtx) -> Option<Vec<u8>> {
            Some(vec![1])
        }
        fn verify(
            &self,
            _c: &TrustChallenge,
            _p: &[u8],
            _ctx: &SessionCtx,
        ) -> Result<Verified, TrustError> {
            Ok(Verified {
                score: 1.0,
                tag: Some(Tag {
                    scope: b"s".to_vec(),
                    value: [self.value; 32],
                }),
            })
        }
        fn verify_cost(&self) -> u32 {
            self.cost
        }
    }

    #[test]
    fn verify_proofs_does_not_claim_and_failed_claims_roll_back() {
        let mut policy = TrustPolicy::default();
        policy.weights.insert(20, 0.5);
        policy.weights.insert(21, 0.5);
        let reg = TrustRegistry::new(policy)
            .with(Arc::new(Tagged {
                id: 20,
                value: 1,
                cost: 1,
            }))
            .with(Arc::new(Tagged {
                id: 21,
                value: 2,
                cost: 1,
            }));
        let (a, b) = peers();
        let (c, _) = peers();
        let b_id = PeerId::from_public_key(b.get_public_key());
        let c_id = PeerId::from_public_key(c.get_public_key());
        let ctx_b = ctx(&a, &b_id);
        let offer = reg.offer(&ctx_b);
        let proofs: Vec<TrustProof> = offer
            .iter()
            .map(|ch| TrustProof {
                scheme: ch.scheme,
                bytes: vec![1],
            })
            .collect();

        let rec_b = reg.verify_proofs(&offer, &proofs, &ctx_b).unwrap();
        assert_eq!(rec_b.tags.len(), 2);
        assert!(
            reg.nullifiers().lock().is_empty(),
            "verify_proofs must not claim"
        );

        // c holds only scheme 21's tag; b's claim of both must fail and leave 20 unclaimed
        let tag21 = rec_b.tags.iter().find(|(s, _)| *s == 21).unwrap().clone();
        let only_21 = TrustRecord {
            tags: vec![tag21],
            ..rec_b.clone()
        };
        reg.claim_tags(&c_id, &only_21, UnixMillis(1_000)).unwrap();
        assert_eq!(
            reg.claim_tags(&b_id, &rec_b, UnixMillis(1_000))
                .unwrap_err(),
            VerifyFailure::Sybil(21)
        );
        let tag20 = rec_b.tags.iter().find(|(s, _)| *s == 20).unwrap().1.clone();
        assert_eq!(
            reg.nullifiers().lock().holder(20, &tag20),
            None,
            "partial claim rolled back"
        );

        // releasing c frees the tag immediately for b
        reg.release_tags(&c_id);
        reg.claim_tags(&b_id, &rec_b, UnixMillis(1_000)).unwrap();
        assert!(
            reg.should_ban(&b_id, UnixMillis(1_000)),
            "sybil attempt = 3 strikes = ban threshold"
        );
    }

    #[test]
    fn expensive_proofs_are_skipped_when_no_slot_is_free() {
        let mut policy = TrustPolicy::default();
        policy.weights.insert(30, 1.0);
        policy.max_concurrent_expensive_verifications = 0;
        let reg = TrustRegistry::new(policy).with(Arc::new(Tagged {
            id: 30,
            value: 9,
            cost: EXPENSIVE_VERIFY_COST,
        }));
        let (a, b) = peers();
        let b_id = PeerId::from_public_key(b.get_public_key());
        let ctx_b = ctx(&a, &b_id);
        let offer = reg.offer(&ctx_b);
        let proofs = vec![TrustProof {
            scheme: 30,
            bytes: vec![1],
        }];
        let rec = reg.verify_proofs(&offer, &proofs, &ctx_b).unwrap();
        assert_eq!(rec.value, 0.0);
        assert!(rec.tags.is_empty());
    }

    /// Scheme whose proving takes `sleep_ms` and costs `cost`.
    struct SlowProver {
        id: SchemeId,
        sleep_ms: u64,
        cost: u32,
    }
    impl TrustScheme for SlowProver {
        fn id(&self) -> SchemeId {
            self.id
        }
        fn name(&self) -> &'static str {
            "slow-prover"
        }
        fn max_proof_len(&self) -> usize {
            8
        }
        fn make_challenge(&self, _ctx: &SessionCtx) -> Option<TrustChallenge> {
            Some(TrustChallenge {
                scheme: self.id,
                params: vec![],
                nonce: fresh_nonce(),
            })
        }
        fn prove(&self, _c: &TrustChallenge, _ctx: &SessionCtx) -> Option<Vec<u8>> {
            std::thread::sleep(Duration::from_millis(self.sleep_ms));
            Some(vec![1])
        }
        fn verify(
            &self,
            _c: &TrustChallenge,
            _p: &[u8],
            _ctx: &SessionCtx,
        ) -> Result<Verified, TrustError> {
            Ok(Verified::score(1.0))
        }
        fn prove_cost(&self) -> u32 {
            self.cost
        }
    }

    #[test]
    fn expensive_proving_stops_when_the_budget_is_spent() {
        let policy = TrustPolicy {
            proving_budget_ms_per_min: 50,
            ..TrustPolicy::default()
        };
        let reg = TrustRegistry::new(policy).with(Arc::new(SlowProver {
            id: 40,
            sleep_ms: 40,
            cost: EXPENSIVE_PROVE_COST,
        }));
        let (a, b) = peers();
        let b_id = PeerId::from_public_key(b.get_public_key());
        let ctx_a = ctx(&a, &b_id);
        let offer = reg.offer(&ctx_a);
        let answered: Vec<usize> = (0..3)
            .map(|_| reg.prove_all(&offer, &ctx_a).len())
            .collect();
        // 50 ms budget: two 40 ms proofs start with budget left, the third finds it spent
        assert_eq!(answered, vec![1, 1, 0]);
    }

    #[test]
    fn cheap_proofs_ignore_the_proving_budget() {
        let policy = TrustPolicy {
            proving_budget_ms_per_min: 0,
            max_concurrent_expensive_proofs: 0,
            ..TrustPolicy::default()
        };
        let reg = TrustRegistry::new(policy)
            .with(Arc::new(SlowProver {
                id: 41,
                sleep_ms: 0,
                cost: 1,
            }))
            .with(Arc::new(SlowProver {
                id: 42,
                sleep_ms: 0,
                cost: EXPENSIVE_PROVE_COST,
            }));
        let (a, b) = peers();
        let b_id = PeerId::from_public_key(b.get_public_key());
        let ctx_a = ctx(&a, &b_id);
        let offer = reg.offer(&ctx_a);
        let proofs = reg.prove_all(&offer, &ctx_a);
        assert_eq!(
            proofs.iter().map(|p| p.scheme).collect::<Vec<_>>(),
            vec![41]
        );
    }

    #[test]
    fn a_busy_proving_slot_times_out_the_waiting_handshake() {
        let policy = TrustPolicy {
            max_concurrent_expensive_proofs: 1,
            proving_slot_wait_ms: 50,
            ..TrustPolicy::default()
        };
        let reg = Arc::new(TrustRegistry::new(policy).with(Arc::new(SlowProver {
            id: 43,
            sleep_ms: 400,
            cost: EXPENSIVE_PROVE_COST,
        })));
        let (a, b) = peers();
        let b_id = PeerId::from_public_key(b.get_public_key());
        let ctx_a = ctx(&a, &b_id);
        let offer = reg.offer(&ctx_a);
        let first = {
            let (reg, offer, ctx_a) = (reg.clone(), offer.clone(), ctx_a.clone());
            std::thread::spawn(move || reg.prove_all(&offer, &ctx_a).len())
        };
        std::thread::sleep(Duration::from_millis(100));
        // the slot is held for 400 ms; waiting 50 ms is not enough
        assert_eq!(reg.prove_all(&offer, &ctx_a).len(), 0);
        assert_eq!(first.join().unwrap(), 1);
        // once free, the slot is available again
        assert_eq!(reg.prove_all(&offer, &ctx_a).len(), 1);
    }

    #[test]
    fn bad_proof_rejects_and_penalises() {
        let reg = TrustRegistry::new(TrustPolicy::default()).with(Arc::new(Echo {
            id: 1,
            tagged: false,
            offer: true,
        }));
        let (a, b) = peers();
        let b_id = PeerId::from_public_key(b.get_public_key());
        let ctx_a = ctx(&a, &b_id);
        let offer = reg.offer(&ctx_a);
        let bad = vec![TrustProof {
            scheme: 1,
            bytes: vec![0; 32],
        }];
        assert!(matches!(
            reg.verify_all(&offer, &bad, &ctx_a),
            Err(VerifyFailure::BadProof { scheme: 1, .. })
        ));
        assert_eq!(reg.strikes(&b_id, UnixMillis(1_000)), 3);
        // unchallenged scheme is ignored, duplicates are refused
        let ignored = vec![TrustProof {
            scheme: 9,
            bytes: vec![],
        }];
        assert_eq!(reg.verify_all(&offer, &ignored, &ctx_a).unwrap().value, 0.0);
        let dup = vec![
            TrustProof {
                scheme: 9,
                bytes: vec![],
            },
            TrustProof {
                scheme: 9,
                bytes: vec![],
            },
        ];
        assert_eq!(
            reg.verify_all(&offer, &dup, &ctx_a).unwrap_err(),
            VerifyFailure::Duplicate(9)
        );
    }
}
