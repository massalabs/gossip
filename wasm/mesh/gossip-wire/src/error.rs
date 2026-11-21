//! Error type of the wire crate.
//!
//! Replaces `massa_models::error::ModelsError` and
//! `massa_protocol_exports::ProtocolError` in the code vendored from massa
//! (rev d193d9ff89).

use displaydoc::Display;
use massa_serialization::SerializeError;
use thiserror::Error;

/// Errors produced by the wire layer.
#[non_exhaustive]
#[derive(Display, Error, Debug, Clone)]
pub enum WireError {
    /// serialization error: {0}
    Serialization(String),
    /// deserialization error: {0}
    Deserialization(String),
    /// signature error: {0}
    Signature(#[from] massa_signature::MassaSignatureError),
    /// invalid ip address: {0}
    InvalidIp(String),
    /// time error: {0}
    Time(String),
    /// invalid version: {0}
    InvalidVersion(String),
}

impl From<SerializeError> for WireError {
    fn from(err: SerializeError) -> Self {
        Self::Serialization(err.to_string())
    }
}
