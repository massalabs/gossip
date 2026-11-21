//! `[propagation]` configuration: blob announcement, retrieval and synchronisation
//! tuning (field names are those of `config/config.toml`; `*_ms` fields are
//! milliseconds).

use std::time::Duration;

use gossip_wire::{MAX_BLOB_KEY_LEN, MAX_BLOB_PAYLOAD_LEN};
use serde::{Deserialize, Serialize};

/// `[propagation]`: blob announcement, retrieval and synchronisation tuning.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PropagationConfig {
    /// Announcement batch flush period.
    pub announcement_interval_ms: u64,
    /// Announcement batch size that triggers an early flush.
    pub announcement_buffer_capacity: usize,
    /// Period of the deferred-ask processing tick (base of the trust-scaled delay).
    pub batch_proc_period_ms: u64,
    /// Maximum number of deferred ask batches kept.
    pub batch_buffer_capacity: usize,
    /// Size of the LRU of blob ids whose ask state is tracked.
    pub asked_blobs_buffer_capacity: usize,
    /// Maximum ids per `Announce` / `Ask` / `SyncIds` message.
    pub max_ids_per_message: usize,
    /// Maximum envelopes per `Blobs` message.
    pub max_blobs_per_message: usize,
    /// Maximum total envelope bytes per `Blobs` message.
    pub max_blobs_message_bytes: usize,
    /// Cap on the number of blobs kept queued for propagation.
    pub max_blobs_kept_for_propagation: usize,
    /// Blobs older than this leave the propagation queue.
    pub max_blob_propagation_time_ms: u64,
    /// Size of the LRU of blob ids checked recently.
    pub max_known_blobs_size: usize,
    /// Size of the per-peer LRU of blob ids known by that peer.
    pub max_peer_known_blobs_size: usize,
    /// Ids per anti-entropy page.
    pub sync_page_size: usize,
    /// Period of the periodic resynchronisation with random high-trust peers.
    pub resync_interval_ms: u64,
    /// Base ingest budget per peer in bytes per minute; scaled by `0.25 + 0.75 × trust`.
    pub peer_ingest_bytes_per_min: u64,
    /// Base ingest budget per peer in blobs per minute; scaled by `0.25 + 0.75 × trust`.
    pub peer_ingest_blobs_per_min: u64,
    /// Base egress budget per peer in bytes per minute (blobs served to its `Ask`s);
    /// scaled by `0.25 + 0.75 × trust`.
    pub peer_egress_bytes_per_min: u64,
    /// Base number of `SyncRequest` pages served per peer per minute; scaled by
    /// `0.25 + 0.75 × trust`.
    pub peer_sync_requests_per_min: u64,
    /// Largest envelope payload accepted from the wire (the node copies
    /// `[pools].max_payload_len` here).
    pub max_payload_len: usize,
    /// Largest envelope key accepted from the wire (the node copies
    /// `[pools].max_key_len` here).
    pub max_key_len: usize,
}

impl Default for PropagationConfig {
    fn default() -> Self {
        Self {
            announcement_interval_ms: 300,
            announcement_buffer_capacity: 2000,
            batch_proc_period_ms: 500,
            batch_buffer_capacity: 10024,
            asked_blobs_buffer_capacity: 600_000,
            max_ids_per_message: 5000,
            max_blobs_per_message: 64,
            max_blobs_message_bytes: 2_097_152,
            max_blobs_kept_for_propagation: 100_000,
            max_blob_propagation_time_ms: 600_000,
            max_known_blobs_size: 1_000_000,
            max_peer_known_blobs_size: 200_000,
            sync_page_size: 5000,
            resync_interval_ms: 3_600_000,
            peer_ingest_bytes_per_min: 104_857_600,
            peer_ingest_blobs_per_min: 6000,
            peer_egress_bytes_per_min: 64 * 1024 * 1024,
            peer_sync_requests_per_min: 6,
            max_payload_len: MAX_BLOB_PAYLOAD_LEN,
            max_key_len: MAX_BLOB_KEY_LEN,
        }
    }
}

impl PropagationConfig {
    /// [`Self::announcement_interval_ms`] as a `Duration`.
    pub fn announcement_interval(&self) -> Duration {
        Duration::from_millis(self.announcement_interval_ms)
    }
    /// [`Self::batch_proc_period_ms`] as a `Duration`.
    pub fn batch_proc_period(&self) -> Duration {
        Duration::from_millis(self.batch_proc_period_ms)
    }
    /// [`Self::max_blob_propagation_time_ms`] as a `Duration`.
    pub fn max_blob_propagation_time(&self) -> Duration {
        Duration::from_millis(self.max_blob_propagation_time_ms)
    }
    /// [`Self::resync_interval_ms`] as a `Duration`.
    pub fn resync_interval(&self) -> Duration {
        Duration::from_millis(self.resync_interval_ms)
    }
}
