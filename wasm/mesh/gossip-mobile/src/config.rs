//! The JSON configuration the app passes to `start`, with the phone defaults of
//! `docs/MESH.md`.

use serde::Deserialize;

/// Mobile node configuration. Every field is optional in the JSON.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct MobileConfig {
    /// Hex of a 32-byte key encrypting the pools at rest (from the app's secure
    /// storage). Required unless `allow_plaintext` is set.
    pub pool_key_hex: Option<String>,
    /// Keep the pools in plaintext when no key is given (tests and development only).
    pub allow_plaintext: bool,
    /// Most mesh links with a completed handshake.
    pub max_links: usize,
    /// Of those, most to peers whose trust is below 0.2.
    pub max_low_trust_links: usize,
    /// Proof-of-work bits offered and proved on mesh links.
    pub pow_bits: u8,
    /// Mesh retention, milliseconds.
    pub mesh_retention_ms: u64,
    /// Mesh storage cap, bytes.
    pub mesh_max_bytes: u64,
    /// Mesh blob count cap.
    pub mesh_max_blob_count: u64,
    /// How long the duplicate token shown to peers lasts, milliseconds (default 15 min,
    /// about a BLE address epoch). Peer ids are fresh for every link.
    pub peer_id_rotation_ms: u64,
    /// A full phone replaces its oldest link for a newcomer only when that link is at
    /// least this old, milliseconds (default 10 min).
    pub min_replaced_link_age_ms: u64,
    /// And at most once per this interval, milliseconds (default 2 min).
    pub link_replace_interval_ms: u64,
    /// Bridge uploads per minute.
    pub bridge_upload_per_min: u32,
    /// Bridge loop period (uploads, wanted fetches, beacon), milliseconds.
    pub bridge_interval_ms: u64,
    /// Upstream request timeout, milliseconds.
    pub upstream_timeout_ms: u64,
    /// Guided forwarding (see `docs/MESH.md`).
    pub guided: bool,
}

impl Default for MobileConfig {
    fn default() -> Self {
        Self {
            pool_key_hex: None,
            allow_plaintext: false,
            max_links: 8,
            max_low_trust_links: 4,
            pow_bits: 12,
            mesh_retention_ms: 72 * 60 * 60 * 1000,
            mesh_max_bytes: 64 * 1024 * 1024,
            mesh_max_blob_count: 20_000,
            peer_id_rotation_ms: 15 * 60 * 1000,
            min_replaced_link_age_ms: 10 * 60 * 1000,
            link_replace_interval_ms: 2 * 60 * 1000,
            bridge_upload_per_min: 600,
            bridge_interval_ms: 10_000,
            upstream_timeout_ms: 10_000,
            guided: true,
        }
    }
}

impl MobileConfig {
    /// Parses the app's JSON; an empty string gives the defaults.
    pub fn from_json(json: &str) -> Result<Self, String> {
        if json.trim().is_empty() {
            return Ok(Self::default());
        }
        serde_json::from_str(json).map_err(|e| format!("bad mesh config: {e}"))
    }

    /// The pool key, if one is set and valid.
    pub fn pool_key(&self) -> Result<Option<[u8; 32]>, String> {
        let Some(hex) = &self.pool_key_hex else {
            return Ok(None);
        };
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("x"), 16))
            .collect::<Result<Vec<u8>, _>>()
            .map_err(|_| "pool_key_hex is not hex".to_string())?;
        <[u8; 32]>::try_from(bytes)
            .map(Some)
            .map_err(|_| "pool_key_hex must be 32 bytes".to_string())
    }
}
