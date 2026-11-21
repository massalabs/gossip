//! Randomness passed in by the caller. The crate has no randomness source of its own.

/// A source of random bytes. Production callers pass a cryptographically secure generator
/// (event IDs and sync-object IDs need fresh random bytes, §3); tests pass a seeded one.
pub trait Randomness {
    /// Fills `dest` with random bytes.
    fn fill(&mut self, dest: &mut [u8]);
}

impl<F: FnMut(&mut [u8])> Randomness for F {
    fn fill(&mut self, dest: &mut [u8]) {
        self(dest);
    }
}

/// `N` random bytes.
pub(crate) fn bytes<const N: usize>(rng: &mut dyn Randomness) -> [u8; N] {
    let mut b = [0u8; N];
    rng.fill(&mut b);
    b
}

/// A uniform index in `0..n` (`n > 0`), by rejection sampling, so without modulo bias.
pub(crate) fn uniform_below(rng: &mut dyn Randomness, n: usize) -> usize {
    assert!(n > 0, "uniform_below needs a non-empty range");
    let n = n as u64;
    // The largest multiple of n that fits, so that every residue is equally likely.
    let zone = u64::MAX - (u64::MAX % n);
    loop {
        let v = u64::from_le_bytes(bytes::<8>(rng));
        if v < zone {
            return (v % n) as usize;
        }
    }
}

/// A seeded generator for tests and simulations: SplitMix64. Not cryptographic.
#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct TestRng(u64);

#[cfg(test)]
impl TestRng {
    pub(crate) fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub(crate) fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

#[cfg(test)]
impl Randomness for TestRng {
    fn fill(&mut self, dest: &mut [u8]) {
        for chunk in dest.chunks_mut(8) {
            let v = self.next_u64().to_le_bytes();
            chunk.copy_from_slice(&v[..chunk.len()]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uniform_below_stays_in_range_and_covers_it() {
        let mut rng = TestRng::new(7);
        let mut seen = [0u32; 5];
        for _ in 0..1000 {
            seen[uniform_below(&mut rng, 5)] += 1;
        }
        assert!(seen.iter().all(|c| *c > 150));
        assert_eq!(uniform_below(&mut rng, 1), 0);
    }

    #[test]
    fn test_rng_is_reproducible() {
        let mut a = TestRng::new(42);
        let mut b = TestRng::new(42);
        assert_eq!(bytes::<32>(&mut a), bytes::<32>(&mut b));
    }
}
