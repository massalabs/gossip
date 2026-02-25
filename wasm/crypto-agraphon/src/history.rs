//! Message history tracking for asynchronous communication.
//!
//! This module maintains the state needed to support out-of-order message delivery.
//! Each party tracks their own sent messages and the peer's most recent message.

use crypto_kem as kem;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// History item representing one of our sent messages.
///
/// When we send a message, we store this information so we can later decrypt
/// the peer's response to that specific message. This enables asynchronous
/// communication where messages can be sent and received in any order.
///
/// # Fields
///
/// - `sk_next`: The secret key to use for decrypting responses to this message
/// - `k_next`: Root key derived after sending this message
/// - `seeker_next`: Seeker seed for identifying responses to this message
///
/// # Protocol Context
///
/// We maintain a queue of recent sent messages. When receiving a message from
/// the peer, we compute seekers for each item in this queue to determine which
/// of our messages they're responding to.
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct HistoryItemSelf {
    /// Seeker for this message
    pub(crate) seeker: Vec<u8>,
    /// Unique identifier for this message
    pub(crate) height: u64,
    /// Secret key for decrypting responses (Static or Ephemeral)
    pub(crate) sk_next: kem::SecretKey,
    /// Root key for children messages
    pub(crate) k_next: [u8; 32],
    /// Height of the peer message this message acknowledges as parent
    pub(crate) peer_parent_height: u64,
}

/// History item representing the peer's most recent message.
///
/// We only need to track the peer's latest message (not their entire history)
/// because we always respond to their most recent communication.
///
/// # Fields
///
/// - `our_parent_height`: Which of our messages they were responding to
/// - `pk_next`: Their next public key (for us to encapsulate to)
/// - `k_next`: Their root key after this message
/// - `seeker_next`: Their seeker seed for future message identification
///
/// # Protocol Context
///
/// When the peer sends a message:
/// 1. They include which of our messages they're responding to (`our_parent_height`)
/// 2. They include their next public key (`pk_next`)
/// 3. We update this structure with their new state
/// 4. We can delete our history items older than `our_parent_height` (they've been acknowledged)
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct HistoryItemPeer {
    /// Monotonic height of the latest peer message we have successfully processed
    pub(crate) height: u64,
    /// Which of our messages they were responding to
    pub(crate) our_parent_height: u64,
    /// Their next public key for us to encapsulate to
    pub(crate) pk_next: kem::PublicKey,
    /// Their master key after this message
    pub(crate) k_next: [u8; 32],
}

#[cfg(test)]
mod tests {
    use super::*;
    use crypto_rng as rng;

    #[test]
    fn test_history_item_self_creation() {
        // Generate a key pair
        let mut rand = [0u8; kem::KEY_GENERATION_RANDOMNESS_SIZE];
        rng::fill_buffer(&mut rand);
        let (sk_next, _) = kem::generate_key_pair(rand);

        let k_next = [42u8; 32];

        let seeker = [0u8; 32];

        let history_item = HistoryItemSelf {
            height: 1,
            sk_next,
            k_next,
            seeker: seeker.to_vec(),
            peer_parent_height: 0,
        };

        assert_eq!(history_item.height, 1);
        assert_eq!(history_item.k_next, k_next);
    }

    #[test]
    fn test_history_item_peer_creation() {
        // Generate a key pair
        let mut rand = [0u8; kem::KEY_GENERATION_RANDOMNESS_SIZE];
        rng::fill_buffer(&mut rand);
        let (_, pk_next) = kem::generate_key_pair(rand);

        let k_next = [42u8; 32];

        let history_item = HistoryItemPeer {
            height: 7,
            our_parent_height: 5,
            pk_next,
            k_next,
        };

        assert_eq!(history_item.height, 7);
        assert_eq!(history_item.our_parent_height, 5);
        assert_eq!(history_item.k_next, k_next);
    }
}
