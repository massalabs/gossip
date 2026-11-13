// Vendored from massa-protocol-worker/src/sig_verifier.rs and adapted for Gossip.
// Copyright (c) 2022 MASSA LABS <info@massa.net>

//! Optimized batch signature verifier

use massa_hash::Hash;
use massa_signature::{verify_signature_batch, PublicKey, Signature};
use rayon::{prelude::ParallelIterator, slice::ParallelSlice};

use crate::error::ReplError;

//TODO: Benchmark
/// Limit for small batch optimization
const SMALL_BATCH_LIMIT: usize = 2;

/// Efficiently verifies a batch of signatures in parallel.
/// Returns an error if at least one of them fails to verify.
pub fn verify_sigs_batch(ops: &[(Hash, Signature, PublicKey)]) -> Result<(), ReplError> {
    // if it's a small batch, use single-core verification
    if ops.len() <= SMALL_BATCH_LIMIT {
        return verify_signature_batch(ops).map_err(|_err| ReplError::WrongSignature);
    }

    // otherwise, use parallel batch verif

    // compute chunk size for parallelization with ceiling division to ensure we batch properly.
    // note that current_num_threads() will not return 0.
    let chunk_size = std::cmp::max(
        SMALL_BATCH_LIMIT,
        ops.len().div_ceil(rayon::current_num_threads()),
    );
    // process chunks in parallel
    ops.par_chunks(chunk_size)
        .try_for_each(verify_signature_batch)
        .map_err(|_err| ReplError::WrongSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use massa_signature::KeyPair;

    #[test]
    fn batch_accepts_valid_and_rejects_one_bad() {
        let items: Vec<(Hash, Signature, PublicKey)> = (0..10u8)
            .map(|i| {
                let kp = KeyPair::generate(0).unwrap();
                let hash = Hash::compute_from(&[i]);
                (hash, kp.sign(&hash).unwrap(), kp.get_public_key())
            })
            .collect();
        assert!(verify_sigs_batch(&[]).is_ok());
        assert!(verify_sigs_batch(&items[..1]).is_ok());
        assert!(verify_sigs_batch(&items).is_ok());
        let mut bad = items.clone();
        bad[7].0 = Hash::compute_from(b"tampered");
        assert!(matches!(
            verify_sigs_batch(&bad),
            Err(ReplError::WrongSignature)
        ));
        assert!(verify_sigs_batch(&bad[7..8]).is_err());
    }
}
