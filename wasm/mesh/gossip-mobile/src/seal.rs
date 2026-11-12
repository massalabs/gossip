//! Link encryption (`docs/MESH.md`, "Link encryption"): after the two `hello`
//! messages, every message on a mesh link travels sealed.
//!
//! ```text
//! sealed = u64 BE counter ‖ ChaCha20-Poly1305(key of the sender's direction,
//!                                             nonce = 0u32 ‖ counter, plaintext)
//! ```
//!
//! The keys come from an ephemeral X25519 exchange, so a passive observer reads
//! nothing past the hellos and a recorded link cannot be decrypted later. Messages of
//! the two priority queues complete out of order on the radio, so the receiver accepts
//! any counter it has not seen within a window of [`WINDOW`] counters.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use x25519_dalek::{EphemeralSecret, PublicKey};
use zeroize::Zeroizing;

/// Bytes a sealed message adds: the counter and the tag.
pub const SEAL_OVERHEAD: usize = 8 + 16;
/// Counters accepted behind the highest one seen.
pub const WINDOW: u64 = 1 << 16;

const KEY_CONTEXT_LO: &str = "gossip/mesh/link/v2 key from the lower ephemeral key";
const KEY_CONTEXT_HI: &str = "gossip/mesh/link/v2 key from the higher ephemeral key";
const TRANSCRIPT_DOMAIN: &[u8] = b"gossip/mesh/link/v2 transcript";

/// Our half of the key exchange of one link.
pub struct KeyExchange {
    secret: EphemeralSecret,
    public: PublicKey,
}

impl KeyExchange {
    /// A fresh ephemeral key.
    pub fn new() -> Self {
        let secret = EphemeralSecret::random_from_rng(rand::rngs::OsRng);
        let public = PublicKey::from(&secret);
        Self { secret, public }
    }

    /// Our ephemeral public key, sent in the hello.
    pub fn public(&self) -> [u8; 32] {
        self.public.to_bytes()
    }

    /// Completes the exchange with the peer's ephemeral key: the transcript both sides
    /// bind their identity and proofs to, and the link cipher. Fails on a key that
    /// gives no shared secret (a low-order point) or on our own key echoed back.
    pub fn finish(self, theirs: &[u8; 32]) -> Result<([u8; 32], LinkCipher), &'static str> {
        let ours = self.public();
        if ours == *theirs {
            return Err("our own ephemeral key");
        }
        let shared = self.secret.diffie_hellman(&PublicKey::from(*theirs));
        if !shared.was_contributory() {
            return Err("ephemeral key gives no shared secret");
        }
        let (lo, hi) = if ours < *theirs {
            (ours, *theirs)
        } else {
            (*theirs, ours)
        };
        let mut t = blake3::Hasher::new();
        t.update(TRANSCRIPT_DOMAIN);
        t.update(&lo);
        t.update(&hi);
        let transcript = *t.finalize().as_bytes();
        let mut material = Zeroizing::new([0u8; 64]);
        material[..32].copy_from_slice(shared.as_bytes());
        material[32..].copy_from_slice(&transcript);
        let k_lo = Zeroizing::new(blake3::derive_key(KEY_CONTEXT_LO, material.as_slice()));
        let k_hi = Zeroizing::new(blake3::derive_key(KEY_CONTEXT_HI, material.as_slice()));
        let (send, recv) = if ours < *theirs {
            (k_lo, k_hi)
        } else {
            (k_hi, k_lo)
        };
        Ok((transcript, LinkCipher::new(&send, &recv)))
    }
}

impl Default for KeyExchange {
    fn default() -> Self {
        Self::new()
    }
}

/// The two directions of one encrypted link.
pub struct LinkCipher {
    send: ChaCha20Poly1305,
    recv: ChaCha20Poly1305,
    next: u64,
    window: ReplayWindow,
}

impl LinkCipher {
    fn new(send: &[u8; 32], recv: &[u8; 32]) -> Self {
        Self {
            send: ChaCha20Poly1305::new(Key::from_slice(send)),
            recv: ChaCha20Poly1305::new(Key::from_slice(recv)),
            next: 0,
            window: ReplayWindow::default(),
        }
    }

    fn nonce(counter: u64) -> Nonce {
        let mut n = [0u8; 12];
        n[4..].copy_from_slice(&counter.to_be_bytes());
        *Nonce::from_slice(&n)
    }

    /// Seals one message.
    pub fn seal(&mut self, plain: &[u8]) -> Vec<u8> {
        let counter = self.next;
        self.next += 1;
        let ct = self
            .send
            .encrypt(&Self::nonce(counter), plain)
            .expect("ChaCha20-Poly1305 seals any message below 256 GiB");
        let mut out = Vec::with_capacity(8 + ct.len());
        out.extend_from_slice(&counter.to_be_bytes());
        out.extend_from_slice(&ct);
        out
    }

    /// Opens one message: fails when it does not authenticate or replays a counter.
    pub fn open(&mut self, sealed: &[u8]) -> Result<Vec<u8>, &'static str> {
        if sealed.len() < SEAL_OVERHEAD {
            return Err("sealed message too short");
        }
        let counter = u64::from_be_bytes(sealed[..8].try_into().expect("8 bytes"));
        if !self.window.fresh(counter) {
            return Err("replayed or too old a message");
        }
        let plain = self
            .recv
            .decrypt(&Self::nonce(counter), &sealed[8..])
            .map_err(|_| "message does not authenticate")?;
        self.window.mark(counter);
        Ok(plain)
    }
}

/// Counters seen, over the last [`WINDOW`] below the highest.
struct ReplayWindow {
    /// One more than the highest counter seen (0: none yet).
    top: u64,
    bits: Vec<u64>,
}

impl Default for ReplayWindow {
    fn default() -> Self {
        Self {
            top: 0,
            bits: vec![0; (WINDOW / 64) as usize],
        }
    }
}

impl ReplayWindow {
    fn slot(counter: u64) -> (usize, u64) {
        let i = counter % WINDOW;
        ((i / 64) as usize, 1u64 << (i % 64))
    }

    fn fresh(&self, counter: u64) -> bool {
        if counter >= self.top {
            return counter < u64::MAX;
        }
        if self.top - counter > WINDOW {
            return false;
        }
        let (w, b) = Self::slot(counter);
        self.bits[w] & b == 0
    }

    fn mark(&mut self, counter: u64) {
        if counter >= self.top {
            // clear the slots the window slides over
            if counter - self.top >= WINDOW {
                self.bits.iter_mut().for_each(|w| *w = 0);
            } else {
                for c in self.top..counter {
                    let (w, b) = Self::slot(c);
                    self.bits[w] &= !b;
                }
            }
            self.top = counter + 1;
        }
        let (w, b) = Self::slot(counter);
        self.bits[w] |= b;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (LinkCipher, LinkCipher) {
        let (a, b) = (KeyExchange::new(), KeyExchange::new());
        let (pa, pb) = (a.public(), b.public());
        let (ta, ca) = a.finish(&pb).unwrap();
        let (tb, cb) = b.finish(&pa).unwrap();
        assert_eq!(ta, tb, "both sides derive the same transcript");
        (ca, cb)
    }

    #[test]
    fn messages_open_in_any_order_once() {
        let (mut a, mut b) = pair();
        let sealed: Vec<Vec<u8>> = (0..5u8).map(|i| a.seal(&[i; 10])).collect();
        assert_ne!(sealed[0][8..], [0u8; 10][..], "encrypted");
        for i in [3usize, 0, 4, 1, 2] {
            assert_eq!(b.open(&sealed[i]).unwrap(), vec![i as u8; 10]);
        }
        assert!(b.open(&sealed[2]).is_err(), "a replay is refused");
        // the other direction has its own key
        let back = b.seal(b"hi");
        assert!(b.open(&back).is_err());
        assert_eq!(a.open(&back).unwrap(), b"hi");
    }

    #[test]
    fn tampering_and_old_counters_are_refused() {
        let (mut a, mut b) = pair();
        let mut m = a.seal(b"payload");
        m[10] ^= 1;
        assert!(b.open(&m).is_err());
        assert!(b.open(&[0; 5]).is_err());
        let first = a.seal(b"first");
        for _ in 0..WINDOW + 1 {
            a.seal(b"");
        }
        let last = a.seal(b"last");
        assert_eq!(b.open(&last).unwrap(), b"last");
        assert!(b.open(&first).is_err(), "out of the window");
    }

    #[test]
    fn a_low_order_key_is_refused() {
        assert!(KeyExchange::new().finish(&[0; 32]).is_err());
        let a = KeyExchange::new();
        let own = a.public();
        assert!(a.finish(&own).is_err());
    }
}
