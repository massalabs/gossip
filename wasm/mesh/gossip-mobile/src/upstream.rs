//! The bridge's HTTP client to internet nodes: the client API of `docs/API.md`, the
//! same one the app speaks.

use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::json;

/// An upstream call failure.
#[derive(Debug, thiserror::Error)]
pub enum UpstreamError {
    /// No upstream answered (network, timeout, server errors).
    #[error("upstream: {0}")]
    Http(String),
    /// An upstream answered with a status worth retrying later (`429`).
    #[error("upstream busy: {0}")]
    Busy(String),
    /// An upstream refused this item for good (a `4xx` other than `409` and `429`):
    /// retrying it would only block what follows.
    #[error("upstream refused: {0}")]
    Rejected(String),
    /// The node answered `409 key_taken`: another value holds the seeker.
    #[error("key taken upstream")]
    KeyTaken,
}

/// The error for an unexpected status of `what`.
fn status_error(what: &str, status: u16, text: &str) -> UpstreamError {
    let msg = format!("{what}: {status} {text}");
    if status == 429 {
        UpstreamError::Busy(msg)
    } else if (400..500).contains(&status) {
        UpstreamError::Rejected(msg)
    } else {
        UpstreamError::Http(msg)
    }
}

#[derive(Deserialize)]
struct KeyValueJson {
    key: String,
    value: String,
}

/// Seeker and value pairs.
pub type KeyValues = Vec<(Vec<u8>, Vec<u8>)>;

/// A client to one or more internet nodes; the first that answers is used.
pub struct Upstream {
    agent: ureq::Agent,
    urls: Vec<String>,
}

impl Upstream {
    /// A client for `urls` (each the API root, e.g. `https://api.usegossip.com/api`).
    pub fn new(urls: Vec<String>, timeout: Duration) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            .build()
            .into();
        Self {
            agent,
            urls: urls
                .into_iter()
                .map(|u| u.trim_end_matches('/').to_string())
                .collect(),
        }
    }

    /// Whether any URL is configured.
    pub fn is_configured(&self) -> bool {
        !self.urls.is_empty()
    }

    fn post(&self, path: &str, body: serde_json::Value) -> Result<(u16, String), UpstreamError> {
        let mut last = String::from("no upstream configured");
        for base in &self.urls {
            match self.agent.post(&format!("{base}{path}")).send_json(&body) {
                Ok(mut resp) => {
                    let status = resp.status().as_u16();
                    let text = resp.body_mut().read_to_string().unwrap_or_default();
                    if status < 500 {
                        return Ok((status, text));
                    }
                    last = format!("{base}{path}: status {status}");
                }
                Err(e) => last = format!("{base}{path}: {e}"),
            }
        }
        Err(UpstreamError::Http(last))
    }

    /// Whether an upstream answers (`GET /bulletin/counter`, which every node serves).
    pub fn reachable(&self) -> bool {
        self.urls.iter().any(|base| {
            self.agent
                .get(&format!("{base}/bulletin/counter"))
                .call()
                .is_ok_and(|r| r.status().is_success())
        })
    }

    /// `POST /messages/`.
    pub fn put_message(&self, key: &[u8], value: &[u8]) -> Result<(), UpstreamError> {
        let (status, text) = self.post(
            "/messages/",
            json!({ "key": B64.encode(key), "value": B64.encode(value) }),
        )?;
        match status {
            200..=299 => Ok(()),
            409 => Err(UpstreamError::KeyTaken),
            s => Err(status_error("messages", s, &text)),
        }
    }

    /// `POST /bulletin`.
    pub fn put_announcement(&self, data: &[u8]) -> Result<(), UpstreamError> {
        let (status, text) = self.post("/bulletin", json!({ "data": B64.encode(data) }))?;
        match status {
            200..=299 => Ok(()),
            s => Err(status_error("bulletin", s, &text)),
        }
    }

    /// `POST /auth`.
    pub fn put_keys(&self, value: &[u8]) -> Result<(), UpstreamError> {
        let (status, text) = self.post("/auth", json!({ "value": B64.encode(value) }))?;
        match status {
            200..=299 => Ok(()),
            s => Err(status_error("auth", s, &text)),
        }
    }

    /// `POST /messages/fetch`: the entries held for `seekers`.
    pub fn fetch(&self, seekers: &[Vec<u8>]) -> Result<KeyValues, UpstreamError> {
        if seekers.is_empty() {
            return Ok(Vec::new());
        }
        let list: Vec<String> = seekers.iter().map(|s| B64.encode(s)).collect();
        let (status, text) = self.post("/messages/fetch", json!({ "seekers": list }))?;
        if !(200..=299).contains(&status) {
            return Err(UpstreamError::Http(format!("fetch: {status} {text}")));
        }
        let items: Vec<KeyValueJson> = serde_json::from_str(&text)
            .map_err(|e| UpstreamError::Http(format!("fetch body: {e}")))?;
        Ok(items
            .into_iter()
            .filter_map(|kv| Some((B64.decode(kv.key).ok()?, B64.decode(kv.value).ok()?)))
            .collect())
    }
}
