//! The mesh link handshake (`docs/MESH.md`, "Link handshake"), version `GMSH.2.1`.
//!
//! Both sides open with a plaintext `hello` carrying only the version and an
//! ephemeral X25519 key; everything after it is sealed with the keys of that exchange
//! (see [`crate::seal`]). Inside, each side sends a fresh per-link peer id, a coarse
//! clock, its capabilities and a duplicate token, signed over the transcript, then the
//! trust round of `WIRE-PROTOCOL.md` (role `2`: the side whose peer id bytes compare
//! lower is the initiator). There is no `ListPeers`.
//!
//! Messages from the peer arrive whole and in order (the chunk layer reassembles them,
//! the node opens them), so the state machine only counts them:
//!
//! | # | Both | Initiator receives | Responder receives |
//! |---|---|---|---|
//! | 0 | hello (plaintext) | | |
//! | 1 | identity ‖ signature over the transcript | | |
//! | 2 | role ‖ trust offer | | |
//! | 3 | | verdict | proofs |
//! | 4 | | proofs (when admitted) | verdict |

use std::sync::Arc;

use gossip_trust::{SessionCtx, TrustRecord, TrustRegistry};
use gossip_wire::{
    Hash, KeyPair, PeerId, PeerIdDeserializer, PeerIdSerializer, PeerLimits, Signature,
    TrustChallenge, TrustOffer, TrustOfferDeserializer, TrustOfferSerializer, TrustProofs,
    TrustProofsDeserializer, TrustProofsSerializer, TrustVerdict, TrustVerdictDeserializer,
    TrustVerdictSerializer, UnixMillis, Version, VersionDeserializer, VersionSerializer,
    DEFAULT_MAX_TRUST_PROOF_LEN, MAX_TRUST_CHALLENGES, MAX_TRUST_PARAMS_LEN, MAX_TRUST_PROOFS,
    SIGNATURE_DESER_SIZE,
};
use massa_serialization::{DeserializeError, Deserializer, Serializer};

use crate::seal::{KeyExchange, LinkCipher};

/// Protocol instance of mesh links.
pub const MESH_INSTANCE: &str = "GMSH";

/// Oldest minor version of the current major a link accepts: `GMSH.2.1` added the
/// local-only flags (`LocalBlobs`, the `Wanted` flags byte), which `2.0` cannot parse.
pub const MIN_MESH_MINOR: u32 = 1;

/// The version mesh links speak.
pub fn mesh_version() -> Version {
    Version::new(MESH_INSTANCE, 2, 1).expect("valid version")
}

/// Identity capability: the sender bridges to the upstream now.
pub const CAP_BRIDGE: u8 = 0b01;
/// Identity capability: the sender stores mesh announcements.
pub const CAP_BULLETIN: u8 = 0b10;

/// Length of the duplicate token of the identity message.
pub const DEDUPE_TOKEN_LEN: usize = 16;
/// The clock of the identity message is rounded down to this many milliseconds, so
/// that it does not fingerprint the phone more finely than mesh time needs.
pub const CLOCK_GRANULARITY_MS: u64 = 30_000;

const AUTH_DOMAIN: &[u8] = b"gossip/mesh/link/v2 identity";

/// What the handshake asks of the node.
pub trait Admission: Send + Sync {
    /// Whether a peer that proved `record` gets a link slot.
    fn admit(&self, peer: &PeerId, record: &TrustRecord) -> bool;
    /// What we accept from a peer we granted `trust`.
    fn limits(&self, trust: f64) -> PeerLimits;
}

/// What happened after a message.
pub enum Step {
    /// Messages to send, in order.
    Send(Vec<Vec<u8>>),
    /// Send these, then the link is up with this peer.
    Ready(Vec<Vec<u8>>, Box<Done>),
    /// Send these (a refusal verdict, or nothing), then close the link.
    Fail(Vec<Vec<u8>>, String),
}

/// A completed handshake.
#[derive(Debug, Clone)]
pub struct Done {
    /// The authenticated peer id of this link.
    pub peer: PeerId,
    /// What it proved.
    pub record: TrustRecord,
    /// Its clock minus ours, in milliseconds (to [`CLOCK_GRANULARITY_MS`]).
    pub clock_offset_ms: i64,
    /// Its capabilities.
    pub capabilities: u8,
    /// The summary key of the link: the link starts with summaries.
    pub compact_link_up: Option<[u8; 32]>,
    /// The peer's duplicate token: two links with the same one go to the same phone.
    pub dedupe_token: [u8; DEDUPE_TOKEN_LEN],
    /// A key both ends compute alike for this link, to agree on which of two duplicate
    /// links to keep.
    pub link_key: [u8; 32],
    /// What it accepts from us.
    pub their_limits: PeerLimits,
}

/// One handshake in progress.
pub struct Handshake {
    keypair: Arc<KeyPair>,
    our_id: PeerId,
    registry: Arc<TrustRegistry>,
    admission: Arc<dyn Admission>,
    exchange: Option<KeyExchange>,
    our_ephemeral: [u8; 32],
    peer_ephemeral: [u8; 32],
    capabilities_out: u8,
    dedupe_out: [u8; DEDUPE_TOKEN_LEN],
    cipher: Option<LinkCipher>,
    received: u8,
    their_id: Option<PeerId>,
    transcript: [u8; 32],
    initiator: bool,
    our_challenges: Vec<TrustChallenge>,
    their_challenges: Vec<TrustChallenge>,
    clock_offset_ms: i64,
    capabilities: u8,
    dedupe_token: [u8; DEDUPE_TOKEN_LEN],
    record: Option<TrustRecord>,
    their_limits: PeerLimits,
}

fn ser<T>(s: &impl Serializer<T>, v: &T) -> Vec<u8> {
    let mut b = Vec::new();
    s.serialize(v, &mut b).expect("serializable");
    b
}

fn de<'a, T>(d: &impl Deserializer<T>, b: &'a [u8], what: &str) -> Result<(&'a [u8], T), String> {
    d.deserialize::<DeserializeError>(b)
        .map_err(|e| format!("bad {what}: {e}"))
}

/// What the identity signature covers: the transcript and every field of the identity
/// message, so that it holds for this link only.
fn auth_hash(
    transcript: &[u8; 32],
    ephemeral: &[u8; 32],
    id: &PeerId,
    clock: u64,
    caps: u8,
    token: &[u8; DEDUPE_TOKEN_LEN],
) -> Hash {
    let mut data = Vec::with_capacity(AUTH_DOMAIN.len() + 32 + 32 + 33 + 8 + 1 + 16);
    data.extend_from_slice(AUTH_DOMAIN);
    data.extend_from_slice(transcript);
    data.extend_from_slice(ephemeral);
    data.extend_from_slice(&id.to_bytes());
    data.extend_from_slice(&clock.to_be_bytes());
    data.push(caps);
    data.extend_from_slice(token);
    Hash::compute_from(&data)
}

impl Handshake {
    /// Starts a handshake with `keypair` (fresh for this link) and our duplicate token:
    /// returns it and the first message (the plaintext hello).
    pub fn start(
        keypair: Arc<KeyPair>,
        registry: Arc<TrustRegistry>,
        admission: Arc<dyn Admission>,
        capabilities: u8,
        dedupe_token: [u8; DEDUPE_TOKEN_LEN],
    ) -> (Self, Vec<Vec<u8>>) {
        let our_id = PeerId::from_public_key(keypair.get_public_key());
        let exchange = KeyExchange::new();
        let our_ephemeral = exchange.public();
        let mut hello = ser(&VersionSerializer::new(), &mesh_version());
        hello.extend_from_slice(&our_ephemeral);
        let hs = Self {
            keypair,
            our_id,
            registry,
            admission,
            exchange: Some(exchange),
            our_ephemeral,
            peer_ephemeral: [0; 32],
            capabilities_out: capabilities,
            dedupe_out: dedupe_token,
            cipher: None,
            received: 0,
            their_id: None,
            transcript: [0; 32],
            initiator: false,
            our_challenges: Vec::new(),
            their_challenges: Vec::new(),
            clock_offset_ms: 0,
            capabilities: 0,
            dedupe_token: [0; DEDUPE_TOKEN_LEN],
            record: None,
            their_limits: PeerLimits::default(),
        };
        (hs, vec![hello])
    }

    /// Our peer id in this handshake.
    pub fn our_id(&self) -> PeerId {
        self.our_id
    }

    /// The link cipher, once the hellos are exchanged: every later message is sealed
    /// with it, including the ones this handshake returns from then on.
    pub fn take_cipher(&mut self) -> Option<LinkCipher> {
        self.cipher.take()
    }

    fn ctx(&self) -> SessionCtx {
        SessionCtx {
            our_id: self.our_id,
            their_id: self.their_id.expect("after the identity"),
            transcript: self.transcript,
            now: UnixMillis::now(),
            local_keypair: self.keypair.clone(),
        }
    }

    /// Feeds the next message from the peer (opened, after the hello).
    pub fn on_message(&mut self, msg: &[u8]) -> Step {
        let n = self.received;
        self.received = self.received.saturating_add(1);
        match self.step(n, msg) {
            Ok(step) => step,
            Err(e) => Step::Fail(Vec::new(), e),
        }
    }

    fn identity(&self) -> Result<Vec<u8>, String> {
        let clock = UnixMillis::now().as_millis() / CLOCK_GRANULARITY_MS * CLOCK_GRANULARITY_MS;
        let hash = auth_hash(
            &self.transcript,
            &self.our_ephemeral,
            &self.our_id,
            clock,
            self.capabilities_out,
            &self.dedupe_out,
        );
        let sig = self.keypair.sign(&hash).map_err(|e| format!("sign: {e}"))?;
        let mut m = ser(&PeerIdSerializer::new(), &self.our_id);
        m.extend_from_slice(&clock.to_be_bytes());
        m.push(self.capabilities_out);
        m.extend_from_slice(&self.dedupe_out);
        m.extend_from_slice(&sig.to_bytes());
        Ok(m)
    }

    fn step(&mut self, n: u8, msg: &[u8]) -> Result<Step, String> {
        match n {
            0 => {
                let (rest, version) = de(&VersionDeserializer::new(), msg, "version")?;
                if !version.is_compatible(&mesh_version()) || version.minor() < MIN_MESH_MINOR {
                    return Err(format!("incompatible version {version}"));
                }
                let theirs: [u8; 32] = rest.try_into().map_err(|_| "bad hello")?;
                let exchange = self.exchange.take().ok_or("hello twice")?;
                let (transcript, cipher) = exchange.finish(&theirs)?;
                self.peer_ephemeral = theirs;
                self.transcript = transcript;
                self.cipher = Some(cipher);
                // the identity goes out sealed (the node seals what follows the cipher)
                Ok(Step::Send(vec![self.identity()?]))
            }
            1 => {
                let (rest, id) = de(&PeerIdDeserializer::new(), msg, "peer id")?;
                if rest.len() != 8 + 1 + DEDUPE_TOKEN_LEN + SIGNATURE_DESER_SIZE {
                    return Err("bad identity".into());
                }
                let clock = u64::from_be_bytes(rest[..8].try_into().expect("8 bytes"));
                let caps = rest[8];
                if caps & !(CAP_BRIDGE | CAP_BULLETIN) != 0 {
                    return Err("unknown capability bits".into());
                }
                let token: [u8; DEDUPE_TOKEN_LEN] =
                    rest[9..9 + DEDUPE_TOKEN_LEN].try_into().expect("16 bytes");
                let sig = Signature::from_bytes(&rest[9 + DEDUPE_TOKEN_LEN..])
                    .map_err(|e| format!("signature: {e}"))?;
                if id == self.our_id {
                    return Err("talking to ourselves".into());
                }
                let their_ephemeral = self.their_ephemeral();
                id.verify_signature(
                    &auth_hash(&self.transcript, &their_ephemeral, &id, clock, caps, &token),
                    &sig,
                )
                .map_err(|e| format!("peer does not hold its key: {e}"))?;
                self.clock_offset_ms = (i128::from(clock)
                    - i128::from(UnixMillis::now().as_millis()))
                .clamp(i128::from(i64::MIN), i128::from(i64::MAX))
                    as i64;
                self.capabilities = caps;
                self.dedupe_token = token;
                self.initiator = self.our_id.to_bytes() < id.to_bytes();
                self.their_id = Some(id);
                let ctx = self.ctx();
                self.our_challenges = self.registry.offer(&ctx);
                let mut offer = vec![2u8];
                offer.extend(ser(
                    &TrustOfferSerializer::new(),
                    &TrustOffer {
                        challenges: self.our_challenges.clone(),
                    },
                ));
                Ok(Step::Send(vec![offer]))
            }
            2 => {
                let (&role, rest) = msg.split_first().ok_or("empty offer")?;
                if role > 2 {
                    return Err("bad role".into());
                }
                let (rest, offer) = de(
                    &TrustOfferDeserializer::new(MAX_TRUST_CHALLENGES, MAX_TRUST_PARAMS_LEN),
                    rest,
                    "offer",
                )?;
                if !rest.is_empty() {
                    return Err("trailing bytes after offer".into());
                }
                self.their_challenges = offer.challenges;
                if self.initiator {
                    return Ok(Step::Send(vec![self.proofs()]));
                }
                Ok(Step::Send(Vec::new()))
            }
            3 if self.initiator => {
                let verdict = self.verdict(msg)?;
                if !verdict.admitted {
                    return Err(format!("refused by the peer (reason {})", verdict.reason));
                }
                self.their_limits = verdict.limits;
                Ok(Step::Send(Vec::new()))
            }
            3 => {
                // responder: their proofs, then our verdict and proofs
                let record = self.check_proofs(msg)?;
                let admitted = self
                    .admission
                    .admit(&self.their_id.expect("identity"), &record);
                let verdict = self.our_verdict(admitted, &record);
                if !admitted {
                    // the refused peer learns why; no proof is computed for it
                    return Ok(Step::Fail(vec![verdict], "no slot for this peer".into()));
                }
                self.record = Some(record);
                Ok(Step::Send(vec![verdict, self.proofs()]))
            }
            4 if self.initiator => {
                let record = self.check_proofs(msg)?;
                let admitted = self
                    .admission
                    .admit(&self.their_id.expect("identity"), &record);
                let verdict = self.our_verdict(admitted, &record);
                if !admitted {
                    return Ok(Step::Fail(vec![verdict], "no slot for this peer".into()));
                }
                let peer = self.their_id.expect("identity");
                self.registry
                    .claim_tags(&peer, &record, UnixMillis::now())
                    .map_err(|e| format!("identity already bound: {e:?}"))?;
                Ok(Step::Ready(vec![verdict], Box::new(self.done(record))))
            }
            4 => {
                let verdict = self.verdict(msg)?;
                if !verdict.admitted {
                    return Err(format!("refused by the peer (reason {})", verdict.reason));
                }
                self.their_limits = verdict.limits;
                let peer = self.their_id.expect("identity");
                let record = self.record.clone().expect("checked at 3");
                self.registry
                    .claim_tags(&peer, &record, UnixMillis::now())
                    .map_err(|e| format!("identity already bound: {e:?}"))?;
                Ok(Step::Ready(Vec::new(), Box::new(self.done(record))))
            }
            _ => Err("message after the handshake ended".into()),
        }
    }

    /// The peer's ephemeral key, from its hello.
    fn their_ephemeral(&self) -> [u8; 32] {
        self.peer_ephemeral
    }

    fn done(&self, record: TrustRecord) -> Done {
        let peer = self.their_id.expect("identity");
        let link_key = gossip_wire::gcs::link_key(&self.our_id, &peer);
        Done {
            peer,
            record,
            clock_offset_ms: self.clock_offset_ms,
            capabilities: self.capabilities,
            compact_link_up: Some(link_key),
            dedupe_token: self.dedupe_token,
            link_key,
            their_limits: self.their_limits,
        }
    }

    fn proofs(&self) -> Vec<u8> {
        let ctx = self.ctx();
        let proofs = self.registry.prove_all(&self.their_challenges, &ctx);
        ser(&TrustProofsSerializer::new(), &TrustProofs { proofs })
    }

    fn check_proofs(&self, msg: &[u8]) -> Result<TrustRecord, String> {
        let max = (self.registry.max_proof_len() as u64).max(DEFAULT_MAX_TRUST_PROOF_LEN);
        let (rest, proofs) = de(
            &TrustProofsDeserializer::new(MAX_TRUST_PROOFS, max),
            msg,
            "proofs",
        )?;
        if !rest.is_empty() {
            return Err("trailing bytes after proofs".into());
        }
        self.registry
            .verify_proofs(&self.our_challenges, &proofs.proofs, &self.ctx())
            .map_err(|e| format!("proof failed: {e:?}"))
    }

    fn verdict(&self, msg: &[u8]) -> Result<TrustVerdict, String> {
        let (rest, v) = de(&TrustVerdictDeserializer::new(), msg, "verdict")?;
        if !rest.is_empty() {
            return Err("trailing bytes after verdict".into());
        }
        Ok(v)
    }

    fn our_verdict(&self, admitted: bool, record: &TrustRecord) -> Vec<u8> {
        ser(
            &TrustVerdictSerializer::new(),
            &TrustVerdict {
                admitted,
                trust_hint: (record.value.clamp(0.0, 1.0) * 10_000.0) as u16,
                reason: if admitted { 0 } else { 2 },
                limits: if admitted {
                    self.admission.limits(record.value)
                } else {
                    PeerLimits::default()
                },
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gossip_trust::schemes::pow::{PowConfig, PowScheme};
    use gossip_trust::TrustPolicy;

    struct Open;
    impl Admission for Open {
        fn admit(&self, _: &PeerId, _: &TrustRecord) -> bool {
            true
        }
        fn limits(&self, _: f64) -> PeerLimits {
            PeerLimits {
                max_message_size: 1000,
                ..PeerLimits::default()
            }
        }
    }

    fn registry() -> Arc<TrustRegistry> {
        let reg =
            TrustRegistry::new(TrustPolicy::default()).with(Arc::new(PowScheme::new(PowConfig {
                min_bits: 8,
                max_bits_to_prove: 8,
                ..PowConfig::default()
            })));
        Arc::new(reg)
    }

    /// One side of a link as the node runs it: the handshake, and the cipher once the
    /// hellos are through.
    struct Side {
        hs: Handshake,
        cipher: Option<LinkCipher>,
        out: Vec<Vec<u8>>,
        result: Option<Result<Done, String>>,
        /// Plaintext of what this side sent, for tests that look inside.
        sent_plain: Vec<Vec<u8>>,
    }

    impl Side {
        fn new(token: u8, caps: u8) -> Self {
            let (hs, first) = Handshake::start(
                Arc::new(KeyPair::generate(0).unwrap()),
                registry(),
                Arc::new(Open),
                caps,
                [token; DEDUPE_TOKEN_LEN],
            );
            Self {
                hs,
                cipher: None,
                sent_plain: first.clone(),
                out: first,
                result: None,
            }
        }

        fn feed(&mut self, sealed: Vec<Vec<u8>>) {
            for m in sealed {
                if self.result.is_some() {
                    return;
                }
                let plain = match &mut self.cipher {
                    Some(c) => c.open(&m).expect("opens"),
                    None => m,
                };
                let step = self.hs.on_message(&plain);
                if let Some(c) = self.hs.take_cipher() {
                    self.cipher = Some(c);
                }
                let (send, outcome) = match step {
                    Step::Send(v) => (v, None),
                    Step::Ready(v, d) => (v, Some(Ok(*d))),
                    Step::Fail(v, e) => (v, Some(Err(e))),
                };
                for p in send {
                    self.sent_plain.push(p.clone());
                    let c = self.cipher.as_mut().expect("sealed after the hello");
                    self.out.push(c.seal(&p));
                }
                self.result = outcome;
            }
        }
    }

    fn run(mut a: Side, mut b: Side) -> (Side, Side) {
        for _ in 0..20 {
            let to_b = std::mem::take(&mut a.out);
            b.feed(to_b);
            let to_a = std::mem::take(&mut b.out);
            a.feed(to_a);
            if a.result.is_some() && b.result.is_some() {
                break;
            }
        }
        (a, b)
    }

    #[test]
    fn two_phones_authenticate_and_prove_work_over_a_sealed_link() {
        let (a, b) = run(Side::new(1, CAP_BRIDGE), Side::new(2, 0));
        let ida = a.hs.our_id();
        let idb = b.hs.our_id();
        let da = a.result.unwrap().unwrap();
        let db = b.result.unwrap().unwrap();
        assert_eq!(da.peer, idb);
        assert_eq!(db.peer, ida);
        assert_eq!(db.capabilities, CAP_BRIDGE);
        assert_eq!(da.dedupe_token, [2; DEDUPE_TOKEN_LEN]);
        assert_eq!(db.dedupe_token, [1; DEDUPE_TOKEN_LEN]);
        assert!(da.clock_offset_ms.abs() <= CLOCK_GRANULARITY_MS as i64 + 5_000);
        // proof of work was proved and verified both ways
        assert!(da.record.proven.iter().any(|(s, _)| *s == 3));
        assert!(db.record.proven.iter().any(|(s, _)| *s == 3));
        assert_eq!(da.their_limits.max_message_size, 1000);
        assert_eq!(da.link_key, db.link_key);
        assert_eq!(da.compact_link_up, db.compact_link_up);
    }

    #[test]
    fn only_the_version_and_an_ephemeral_key_travel_in_clear() {
        let a = Side::new(1, 0);
        let hello = a.out[0].clone();
        // "GMSH" ‖ varint(2) ‖ varint(1) ‖ 32-byte key: no peer id, no clock
        assert_eq!(hello.len(), 4 + 1 + 1 + 32);
        assert_eq!(&hello[..6], b"GMSH\x02\x01");
        let (a, _) = run(a, Side::new(2, 0));
        let id = a.hs.our_id().to_bytes();
        // the peer id is in what a sent, never in clear on the radio
        assert!(a.sent_plain[1].windows(id.len()).any(|w| w == id));
        for wire in a.out.iter().chain(std::iter::once(&hello)) {
            assert!(!wire.windows(id.len()).any(|w| w == id));
        }
    }

    #[test]
    fn a_relayed_identity_fails_on_another_link() {
        // a man in the middle runs two links and passes a's identity on to c
        let mut a = Side::new(1, 0);
        let mut b = Side::new(2, 0);
        let mut c = Side::new(3, 0);
        // hellos: a↔b and b'↔c with fresh exchanges each
        b.feed(std::mem::take(&mut a.out));
        a.feed(vec![b.out.remove(0)]);
        let b_hello_for_c = Side::new(4, 0);
        c.feed(b_hello_for_c.out.clone());
        // a's identity, opened by b, sealed again toward c by the middle
        let a_identity = a.sent_plain[1].clone();
        let mut middle = b_hello_for_c;
        middle.feed(vec![c.out.remove(0)]);
        let resealed = middle.cipher.as_mut().unwrap().seal(&a_identity);
        c.feed(vec![resealed]);
        assert!(
            matches!(c.result, Some(Err(_))),
            "bound to the other transcript"
        );
    }

    #[test]
    fn a_wrong_version_or_a_low_order_key_fails() {
        let mut b = Side::new(2, 0);
        let mut hello = ser(&VersionSerializer::new(), &Version::gossip_net());
        hello.extend_from_slice(&[9; 32]);
        b.feed(vec![hello]);
        assert!(matches!(b.result, Some(Err(_))));
        let mut b = Side::new(2, 0);
        let mut hello = ser(&VersionSerializer::new(), &mesh_version());
        hello.extend_from_slice(&[0; 32]);
        b.feed(vec![hello]);
        assert!(matches!(b.result, Some(Err(_))));
        // a GMSH.2.0 hello (no local-only flags) is refused
        let mut b = Side::new(2, 0);
        let mut old = ser(
            &VersionSerializer::new(),
            &Version::new(MESH_INSTANCE, 2, 0).unwrap(),
        );
        old.extend_from_slice(&[9; 32]);
        b.feed(vec![old]);
        assert!(matches!(b.result, Some(Err(_))));
        // a GMSH.1.x hello is refused too
        let mut b = Side::new(2, 0);
        let mut old = ser(
            &VersionSerializer::new(),
            &Version::new(MESH_INSTANCE, 1, 1).unwrap(),
        );
        old.extend_from_slice(&[9; 32]);
        b.feed(vec![old]);
        assert!(matches!(b.result, Some(Err(_))));
    }
}
