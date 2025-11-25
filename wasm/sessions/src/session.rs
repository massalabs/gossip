//! Session-level secure messaging using the Agraphon protocol.
//!
//! This module implements the session layer for end-to-end encrypted messaging between two peers.
//! Sessions are established through a mutual announcement exchange and provide:
//!
//! - **End-to-end encryption**: Messages are encrypted using the Agraphon double-ratchet protocol
//! - **Forward secrecy**: Past messages remain secure even if current keys are compromised
//! - **Post-compromise security**: Security is restored after key compromise
//! - **Message ordering**: Lag detection and acknowledgment tracking
//! - **Seeker-based addressing**: Messages are identified by hashed Massa public keys derived from ephemeral keypairs
//!
//! # Protocol Flow
//!
//! 1. **Session Initiation**: Both parties create `OutgoingInitiationRequest`s containing their public keys
//! 2. **Announcement Exchange**: Announcements are posted to a public board and retrieved by the peer
//! 3. **Session Creation**: Each party combines their outgoing request with the peer's incoming request
//! 4. **Messaging**: Parties exchange encrypted messages identified by seeker hashes
//!
//! # Seeker Mechanism
//!
//! Messages are identified by "seekers" - database keys derived from hashed Massa public keys.
//! Each message uses an ephemeral Massa keypair whose public key is hashed to create the seeker.
//! This allows recipients to efficiently look up messages on a public message board without
//! scanning all messages or revealing their identity.
//!
//! During session initialization, each party generates a random 32-byte seeker seed and includes
//! it in their announcement. When establishing the session, both parties use a KDF to deterministically
//! derive initial seeker keypairs by combining both seeds (in appropriate order). This ensures both
//! parties can independently compute each other's initial seeker keys, while maintaining forward secrecy
//! through the message-level seeker ratchet.
//!
//! # Example
//!
//! ```no_run
//! # use auth::{UserPublicKeys, UserSecretKeys, derive_keys_from_static_root_secret, StaticRootSecret};
//! # let root_secret_a = StaticRootSecret::from_passphrase(b"alice");
//! # let (alice_pk, alice_sk) = derive_keys_from_static_root_secret(&root_secret_a);
//! # let root_secret_b = StaticRootSecret::from_passphrase(b"bob");
//! # let (bob_pk, bob_sk) = derive_keys_from_static_root_secret(&root_secret_b);
//! use sessions::{OutgoingInitiationRequest, IncomingInitiationRequest, Session};
//!
//! // Alice creates an outgoing announcement
//! let (alice_announcement_bytes, alice_outgoing) =
//!     OutgoingInitiationRequest::new(&alice_pk, &alice_sk, &bob_pk, vec![]);
//!
//! // Bob receives it and parses it
//! let (alice_incoming_at_bob, _user_data) =
//!     IncomingInitiationRequest::try_from(&alice_announcement_bytes, &bob_pk, &bob_sk)
//!         .expect("Failed to parse announcement");
//!
//! // Bob creates his own announcement and both establish sessions
//! let (bob_announcement_bytes, bob_outgoing) =
//!     OutgoingInitiationRequest::new(&bob_pk, &bob_sk, &alice_pk, vec![]);
//! let (bob_incoming_at_alice, _user_data) =
//!     IncomingInitiationRequest::try_from(&bob_announcement_bytes, &alice_pk, &alice_sk).unwrap();
//!
//! let mut alice_session =
//!     Session::from_initiation_request_pair(&alice_outgoing, &bob_incoming_at_alice);
//! let mut bob_session =
//!     Session::from_initiation_request_pair(&bob_outgoing, &alice_incoming_at_bob);
//!
//! // Alice sends a message
//! let output = alice_session.send_outgoing_message(b"Hello Bob!");
//!
//! // Bob retrieves it and decrypts
//! let seeker = alice_session.next_peer_message_seeker();
//! let received = bob_session
//!     .try_feed_incoming_message(&bob_sk, &seeker, &output.data)
//!     .expect("Failed to decrypt");
//!
//! assert_eq!(received.message, b"Hello Bob!");
//! ```

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// Database key suffix for message seekers.
/// Seekers are constructed as: [hash_length, hash_bytes..., MESSAGE_SEEKER_DB_KEY]
/// where hash_bytes is the massa_hash of the seeker's public key.
const MESSAGE_SEEKER_DB_KEY: &[u8] = &[1u8];

/// Session initialization payload embedded in announcements.
///
/// This is serialized, encrypted in an auth blob, and included in the announcement.
/// It contains the random seed used to derive the initial seeker keypair through KDF,
/// and the message timestamp.
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub(crate) struct SessionInitPayload {
    /// Random 32-byte seed used to derive the initial seeker keypair via KDF
    pub(crate) seeker_seed: [u8; 32],
    /// Unix timestamp in milliseconds when this payload was created
    pub(crate) unix_timestamp_millis: u128,
}

/// Auth payload embedded in announcements.
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub(crate) struct AuthPayload {
    /// Auth blob
    pub(crate) auth_blob: auth::AuthBlob,
    /// Custom user data
    pub(crate) user_data: Vec<u8>,
}

/// Internal message structure containing user data and metadata.
///
/// This is an internal type used by the session layer. User code interacts with
/// raw `&[u8]` message contents instead.
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub(crate) struct Message {
    /// Timestamp when the message was created (milliseconds since Unix epoch)
    pub timestamp: u128,
    /// Next Massa keypair for future seeker generation (part of the ratchet)
    #[zeroize(skip)]
    pub seeker_massa_keypair_next: massa_signature::KeyPair,
    /// Actual message contents provided by the user
    pub contents: Vec<u8>,
}

/// Output from sending a message.
///
/// Contains the seeker (database lookup key) and the encrypted message data
/// that should be posted to the public message board.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SendOutgoingMessageOutput {
    /// Message timestamp (milliseconds since Unix epoch)
    pub timestamp: u128,
    /// Seeker bytes - database key for message lookup on the message board
    /// Format: [hash_length, hash_bytes..., MESSAGE_SEEKER_DB_KEY]
    /// where hash_bytes is the massa_hash of the seeker public key
    pub seeker: Vec<u8>,
    /// Encrypted message data to post to the message board
    /// Format: [seeker_pubkey_len, seeker_pubkey, sig_len, signature, encrypted_agraphon_message]
    pub data: Vec<u8>,
}

/// Output from successfully decrypting an incoming message.
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct FeedIncomingMessageOutput {
    /// Message timestamp (milliseconds since Unix epoch)
    pub timestamp: u128,
    /// Decrypted message contents
    pub message: Vec<u8>,
    /// List of seekers for our messages that were acknowledged by this message
    /// (the peer has received these messages, so we can prune them from history)
    pub newly_acknowledged_self_seekers: Vec<Vec<u8>>,
    /// User Id of the peer that sent the message
    pub user_id: Vec<u8>,
}

/// Incoming session initiation request from a peer.
///
/// Created by parsing announcement bytes received from the peer.
/// Contains their public keys and the Agraphon announcement needed to establish a session.
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct IncomingInitiationRequest {
    /// Agraphon protocol announcement from the peer
    agraphon_announcement: crypto_agraphon::IncomingAnnouncement,
    /// Peer's long-term public keys
    pub(crate) origin_public_keys: auth::UserPublicKeys,
    /// Timestamp when the peer created this announcement (milliseconds since Unix epoch)
    pub(crate) timestamp_millis: u128,
    /// Peer's random seed used to derive their initial seeker keypair via KDF
    seeker_seed: [u8; 32],
}

impl IncomingInitiationRequest {
    /// Tries to parse an incoming initiation request from bytes.
    ///
    /// # Arguments
    ///
    /// * `bytes` - The raw announcement bytes received from the peer
    /// * `our_pk` - Our static public key
    /// * `our_sk` - Our static secret key
    ///
    /// # Returns
    ///
    /// A tuple containing the incoming initiation request and the user data from the announcement.
    /// If the parsing fails, the function returns `None`.
    pub fn try_from(
        bytes: &[u8],
        our_pk: &auth::UserPublicKeys,
        our_sk: &auth::UserSecretKeys,
    ) -> Option<(Self, Vec<u8>)> {
        // parse announcement precursor
        let incoming_announcement_precursor =
            crypto_agraphon::IncomingAnnouncementPrecursor::try_from_incoming_announcement_bytes(
                bytes,
                &our_pk.kem_public_key,
                &our_sk.kem_secret_key,
            )?;

        // get auth payload and key
        let auth_payload = incoming_announcement_precursor.auth_payload();
        let auth_key = incoming_announcement_precursor.auth_key();

        // deserialize announcement contents
        let auth_payload: AuthPayload =
            bincode::serde::decode_from_slice(auth_payload, bincode::config::standard())
                .ok()?
                .0;

        // verify auth blob
        if !auth_payload.auth_blob.verify(auth_key) {
            return None;
        }

        // deserialize inner data
        let init_payload: SessionInitPayload = bincode::serde::decode_from_slice(
            auth_payload.auth_blob.public_payload(),
            bincode::config::standard(),
        )
        .ok()?
        .0;

        // finalize agraphon announcement
        let agraphon_announcement = incoming_announcement_precursor
            .finalize(auth_payload.auth_blob.public_keys().kem_public_key.clone())?;

        Some((
            Self {
                agraphon_announcement: agraphon_announcement.clone(),
                origin_public_keys: auth_payload.auth_blob.public_keys().clone(),
                timestamp_millis: init_payload.unix_timestamp_millis,
                seeker_seed: init_payload.seeker_seed,
            },
            auth_payload.user_data.clone(),
        ))
    }
}

/// Outgoing session initiation request.
///
/// Created when initiating a session with a peer. Contains the Agraphon announcement
/// and a random seed that will be used (combined with the peer's seed) to derive
/// initial seeker keypairs.
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct OutgoingInitiationRequest {
    agraphon_announcement: crypto_agraphon::OutgoingAnnouncement,
    pub(crate) timestamp_millis: u128,
    /// Random seed for deriving initial seeker keypair
    seeker_seed: [u8; 32],
}

impl OutgoingInitiationRequest {
    pub fn new(
        our_pk: &auth::UserPublicKeys,
        our_sk: &auth::UserSecretKeys,
        peer_pk: &auth::UserPublicKeys,
        user_data: Vec<u8>,
    ) -> (Vec<u8>, Self) {
        // get current timestamp
        let timestamp_millis = crate::utils::timestamp_millis();

        // prepare agraphon outgoing announcement precursor
        let agraphon_announcement_precursor =
            crypto_agraphon::OutgoingAnnouncementPrecursor::new(&peer_pk.kem_public_key);

        // get auth key
        let auth_key = agraphon_announcement_precursor.auth_key();

        // Generate a cryptographically random 32-byte seed that will be used
        // (combined with the peer's seed via KDF) to derive initial seeker keypairs
        let seeker_seed = {
            let mut seeker_seed = [0u8; 32];
            crypto_rng::fill_buffer(&mut seeker_seed);
            seeker_seed
        };

        // create initiation payload
        let session_init_payload = SessionInitPayload {
            seeker_seed,
            unix_timestamp_millis: timestamp_millis,
        };
        let session_init_payload_bytes =
            bincode::serde::encode_to_vec(&session_init_payload, bincode::config::standard())
                .expect("Failed to serialize outgoing session initiation request");

        // create auth payload
        let auth_payload = AuthPayload {
            auth_blob: auth::AuthBlob::new(
                our_pk.clone(),
                our_sk,
                session_init_payload_bytes,
                auth_key,
            ),
            user_data,
        };
        let auth_payload_bytes = Zeroizing::new(
            bincode::serde::encode_to_vec(&auth_payload, bincode::config::standard())
                .expect("Failed to serialize auth blob"),
        );

        // finalize announcement
        let (announcement_bytes, announcement) =
            agraphon_announcement_precursor.finalize(auth_payload_bytes.as_slice());

        (
            announcement_bytes,
            Self {
                agraphon_announcement: announcement,
                timestamp_millis,
                seeker_seed,
            },
        )
    }
}

/// An established session between two peers.
///
/// Sessions provide end-to-end encrypted messaging with forward secrecy and post-compromise
/// security through the Agraphon double-ratchet protocol. Messages are addressed using seekers
/// derived from ephemeral Massa keypairs.
///
/// The initial seeker keypairs are deterministically derived from the random seeds exchanged
/// during session initialization using a KDF. Each subsequent message includes the next seeker
/// keypair in the ratchet, ensuring forward secrecy.
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct Session {
    /// Agraphon protocol instance handling encryption and ratcheting
    agraphon_instance: crypto_agraphon::Agraphon,
    /// Peer's long-term public keys
    peer_public_keys: auth::UserPublicKeys,
    /// Current Massa keypair for the next message we expect to receive from the peer
    #[zeroize(skip)]
    peer_seeker_massa_keypair: massa_signature::KeyPair,
    /// Current Massa keypair for the next message we will send to the peer
    #[zeroize(skip)]
    self_seeker_massa_keypair: massa_signature::KeyPair,
}

impl Session {
    /// Creates a new session from a pair of initiation requests.
    ///
    /// This combines your outgoing announcement with the peer's incoming announcement to
    /// establish a shared session. The initial seeker keypairs are deterministically derived
    /// from the random seeds exchanged in the announcements using HKDF.
    ///
    /// # Seeker Key Derivation
    ///
    /// The initial seeker keypairs are derived using a key derivation function (KDF) that
    /// combines both parties' random seeds:
    /// - Peer's seeker key: `KDF(peer_seed || our_seed, "session.seeker.key")`
    /// - Our seeker key: `KDF(our_seed || peer_seed, "session.seeker.key")`
    ///
    /// The order of inputs ensures each party derives different keys for sending vs receiving.
    /// The keys are formatted as Massa Ed25519 keypairs (33 bytes: version byte + 32-byte secret).
    ///
    /// # Arguments
    ///
    /// * `outgoing_initiation_request` - Our announcement that was sent to the peer
    /// * `incoming_initiation_request` - The peer's announcement that we received
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use auth::*;
    /// # use sessions::*;
    /// # let (alice_pk, alice_sk) = derive_keys_from_static_root_secret(&StaticRootSecret::from_passphrase(b"alice"));
    /// # let (bob_pk, bob_sk) = derive_keys_from_static_root_secret(&StaticRootSecret::from_passphrase(b"bob"));
    /// let (announcement_bytes, outgoing) = OutgoingInitiationRequest::new(&alice_pk, &alice_sk, &bob_pk, vec![]);
    /// # let (bob_announcement, _) = OutgoingInitiationRequest::new(&bob_pk, &bob_sk, &alice_pk, vec![]);
    /// # let (incoming, _user_data) = IncomingInitiationRequest::try_from(&bob_announcement, &alice_pk, &alice_sk).unwrap();
    /// let session = Session::from_initiation_request_pair(&outgoing, &incoming);
    /// ```
    pub fn from_initiation_request_pair(
        outgoing_initiation_request: &OutgoingInitiationRequest,
        incoming_initiation_request: &IncomingInitiationRequest,
    ) -> Self {
        // create agraphon instance
        let agraphon_instance = crypto_agraphon::Agraphon::from_announcement_pair(
            &outgoing_initiation_request.agraphon_announcement,
            &incoming_initiation_request.agraphon_announcement,
        );

        // Derive peer's initial seeker keypair from [peer_seed, our_seed]
        // This produces the key the peer will use to send their first message to us
        let peer_seeker_massa_keypair = {
            let mut kdf = crypto_kdf::Extract::new(b"session.seeker.kdf.salt---------");
            kdf.input_item(incoming_initiation_request.seeker_seed.as_slice());
            kdf.input_item(outgoing_initiation_request.seeker_seed.as_slice());
            let expander = kdf.finalize();
            // Massa keypair format: [version_byte, 32_secret_key_bytes]
            let mut seeker_key = [0u8; 33];
            expander.expand(b"session.seeker.key", &mut seeker_key[1..]);
            massa_signature::KeyPair::from_bytes(seeker_key.as_slice())
                .expect("Failed to generate peer seeker keypair")
        };

        // Derive our initial seeker keypair from [our_seed, peer_seed]
        // This produces the key we will use to send our first message to the peer
        let self_seeker_massa_keypair = {
            let mut kdf = crypto_kdf::Extract::new(b"session.seeker.kdf.salt---------");
            kdf.input_item(outgoing_initiation_request.seeker_seed.as_slice());
            kdf.input_item(incoming_initiation_request.seeker_seed.as_slice());
            let expander = kdf.finalize();
            // Massa keypair format: [version_byte, 32_secret_key_bytes]
            let mut seeker_key = [0u8; 33];
            expander.expand(b"session.seeker.key", &mut seeker_key[1..]);
            massa_signature::KeyPair::from_bytes(seeker_key.as_slice())
                .expect("Failed to generate self seeker keypair")
        };

        // create session
        Self {
            agraphon_instance,
            peer_public_keys: incoming_initiation_request.origin_public_keys.clone(),
            peer_seeker_massa_keypair,
            self_seeker_massa_keypair,
        }
    }

    fn compute_seeker(seeker_public_key: &massa_signature::PublicKey) -> Vec<u8> {
        // Hash the public key bytes to get a fixed-size identifier
        let public_key_bytes = seeker_public_key.to_bytes();
        let hash = massa_hash::Hash::compute_from(&public_key_bytes);
        let hash_bytes = hash.to_bytes();

        [
            &[hash_bytes.len() as u8],
            hash_bytes.as_slice(),
            MESSAGE_SEEKER_DB_KEY,
        ]
        .concat()
    }

    fn compute_seeker_data_to_sign(datastore_key: &[u8], message_bytes: &[u8]) -> Vec<u8> {
        [&[datastore_key.len() as u8], datastore_key, message_bytes].concat()
    }

    /// Sends an outgoing message on the session and returns the seeker and encrypted message data.
    ///
    /// This method:
    /// 1. Generates a new random seeker keypair for the next message
    /// 2. Uses the current seeker keypair to create the message seeker (address)
    /// 3. Encrypts the message using the Agraphon protocol
    /// 4. Signs the encrypted message with the current seeker keypair
    /// 5. Updates the session's seeker keypair for the next message
    ///
    /// The peer must have the corresponding seeker to decrypt the message. The message
    /// includes the next seeker keypair, maintaining the forward-ratcheting property.
    ///
    /// # Arguments
    ///
    /// * `message` - The plaintext message bytes to send
    ///
    /// # Returns
    ///
    /// A [`SendOutgoingMessageOutput`] containing the seeker (database key) and encrypted data
    /// that should be posted to the message board.
    pub fn send_outgoing_message(&mut self, message: &[u8]) -> SendOutgoingMessageOutput {
        // get timestamp
        let timestamp = crate::utils::timestamp_millis();

        // generate seeker for next message on our side
        let mut seeker_keypair =
            massa_signature::KeyPair::generate(0).expect("Failed to generate seeker keypair");

        // flip with the current seeker
        std::mem::swap(&mut seeker_keypair, &mut self.self_seeker_massa_keypair);
        // seeker_keypair is now the "current" seeker

        // compute ephemeral seeker public key
        let seeker_public_key = seeker_keypair.get_public_key();

        // assemble seeker datastore key
        let seeker = Self::compute_seeker(&seeker_public_key);

        // create message
        let msg = Message {
            timestamp,
            seeker_massa_keypair_next: self.self_seeker_massa_keypair.clone(),
            contents: message.to_vec(),
        };

        // serialize message
        let msg_bytes: Zeroizing<Vec<u8>> = Zeroizing::new(
            bincode::serde::encode_to_vec(&msg, bincode::config::standard())
                .expect("Failed to serialize message"),
        );

        // feed agraphon
        let agraphon_message_bytes = self.agraphon_instance.send_outgoing_message(
            &seeker,
            &msg_bytes,
            &self.peer_public_keys.kem_public_key,
        );

        // assemble the data to sign
        let data_to_sign = Zeroizing::new(Self::compute_seeker_data_to_sign(
            &seeker,
            &agraphon_message_bytes,
        ));

        // hash the data to sign
        let hash_to_sign = massa_hash::Hash::compute_from(&data_to_sign);

        // sign the data
        let signature = seeker_keypair
            .sign(&hash_to_sign)
            .expect("Failed to sign message");
        let signature_bytes = signature.to_bytes();

        // assemble the data
        let seeker_public_key_bytes = seeker_public_key.to_bytes();
        let data = [
            &[seeker_public_key_bytes.len() as u8],
            seeker_public_key_bytes.as_slice(),
            &[signature_bytes.len() as u8],
            signature_bytes.as_slice(),
            agraphon_message_bytes.as_slice(),
        ]
        .concat();

        SendOutgoingMessageOutput {
            timestamp,
            seeker: seeker.to_vec(),
            data,
        }
    }

    /// Returns the seeker (database key) for the next message from the peer.
    ///
    /// Use this to look up the peer's next message on the message board. The seeker
    /// is derived from the peer's current seeker keypair by hashing its public key.
    ///
    /// After successfully receiving a message via [`try_feed_incoming_message`](Self::try_feed_incoming_message),
    /// this seeker will be updated to point to the subsequent message.
    pub fn next_peer_message_seeker(&self) -> Vec<u8> {
        Self::compute_seeker(&self.peer_seeker_massa_keypair.get_public_key())
    }

    /// Attempts to decrypt and process an incoming message from the peer.
    ///
    /// This method verifies the message signature, decrypts the content, and updates
    /// the session state including the peer's seeker keypair for the next message.
    ///
    /// # Arguments
    ///
    /// * `self_static_sk` - Your long-term secret keys (needed for decryption)
    /// * `seeker` - The seeker (database key) used to retrieve this message
    /// * `message` - The encrypted message data retrieved from the message board
    ///
    /// # Returns
    ///
    /// - `Some(FeedIncomingMessageOutput)` if decryption succeeds, containing the plaintext
    ///   message and list of acknowledged seekers and the user id of the peer that sent the message
    /// - `None` if the message is invalid, cannot be decrypted, or has an invalid signature
    pub fn try_feed_incoming_message(
        &mut self,
        self_static_sk: &auth::UserSecretKeys,
        seeker: &[u8],
        message: &[u8],
    ) -> Option<FeedIncomingMessageOutput> {
        // decompose seeker
        let hash_len = *seeker.first()? as usize;
        let hash_bytes = seeker.get(1..1 + hash_len)?;
        if seeker.get(1 + hash_len..) != Some(MESSAGE_SEEKER_DB_KEY) {
            return None;
        }

        // decompose the data
        let seeker_public_key_len = *message.first()? as usize;
        let seeker_public_key_bytes = message.get(1..1 + seeker_public_key_len)?;
        let seeker_public_key =
            massa_signature::PublicKey::from_bytes(seeker_public_key_bytes).ok()?;

        let signature_offset = 1 + seeker_public_key_len;
        let signature_len = *message.get(signature_offset)? as usize;
        let signature_bytes =
            message.get(signature_offset + 1..signature_offset + 1 + signature_len)?;
        let signature = massa_signature::Signature::from_bytes(signature_bytes).ok()?;

        let message_bytes = message
            .get(signature_offset + 1 + signature_len..)?
            .to_vec();

        // check that the hash derives from the seeker public key by recomputing it
        let public_key_bytes = seeker_public_key.to_bytes();
        let expected_hash = massa_hash::Hash::compute_from(&public_key_bytes);
        let expected_hash_bytes = expected_hash.to_bytes();

        if hash_bytes != expected_hash_bytes.as_slice() {
            return None;
        }

        // check that the signature is valid
        let data_to_sign = Self::compute_seeker_data_to_sign(seeker, &message_bytes);
        let hash_to_verify = massa_hash::Hash::compute_from(&data_to_sign);
        if seeker_public_key
            .verify_signature(&hash_to_verify, &signature)
            .is_err()
        {
            return None;
        }

        // try to read message from agraphon
        let agraphon_result = self
            .agraphon_instance
            .try_feed_incoming_message(&self_static_sk.kem_secret_key, &message_bytes)?;

        // deserialize the message
        let message: Message = bincode::serde::decode_from_slice(
            &agraphon_result.message_bytes,
            bincode::config::standard(),
        )
        .ok()?
        .0;

        // update peer seeker keypair for next message
        self.peer_seeker_massa_keypair = message.seeker_massa_keypair_next.clone();

        // get user id of the peer that sent the message
        let user_id = self.peer_public_keys.derive_id();

        Some(FeedIncomingMessageOutput {
            timestamp: message.timestamp,
            message: message.contents.clone(),
            newly_acknowledged_self_seekers: agraphon_result
                .newly_acknowledged_self_seekers
                .clone(),
            user_id: user_id.as_bytes().to_vec(),
        })
    }

    /// Returns the number of unacknowledged messages sent by this session.
    ///
    /// The lag length increases when you send messages and decreases when the peer
    /// acknowledges them (by sending messages back to you). This can be used to
    /// implement flow control or detect communication issues.
    pub fn lag_length(&self) -> u64 {
        self.agraphon_instance.lag_length()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper function to generate a random keypair for testing
    fn generate_test_keypair() -> (auth::UserPublicKeys, auth::UserSecretKeys) {
        // Generate a random passphrase for testing
        let mut passphrase = [0u8; 32];
        crypto_rng::fill_buffer(&mut passphrase);
        let root_secret = auth::StaticRootSecret::from_passphrase(&passphrase);
        auth::derive_keys_from_static_root_secret(&root_secret)
    }

    /// Helper function to create a test message with given contents
    fn create_test_message(contents: &[u8]) -> Message {
        Message {
            timestamp: crate::utils::timestamp_millis(),
            seeker_massa_keypair_next: massa_signature::KeyPair::generate(0)
                .expect("Failed to generate placeholder keypair"),
            contents: contents.to_vec(),
        }
    }

    // Tests for internal Message type removed - Message is now internal implementation detail
    // and is created automatically by send_outgoing_message

    /// Tests that OutgoingInitiationRequest can be created successfully with valid keypairs
    #[test]
    fn test_outgoing_initiation_request_creation() {
        let (our_pk, our_sk) = generate_test_keypair();
        let (peer_pk, _peer_sk) = generate_test_keypair();

        let (announcement_bytes, outgoing_req) =
            OutgoingInitiationRequest::new(&our_pk, &our_sk, &peer_pk, vec![]);

        assert!(!announcement_bytes.is_empty());
        assert!(outgoing_req.timestamp_millis > 0);
    }

    /// Tests that an incoming initiation request can be parsed from announcement bytes
    /// and contains the expected public keys and timestamp
    #[test]
    fn test_incoming_initiation_request_parsing() {
        let (our_pk, our_sk) = generate_test_keypair();
        let (peer_pk, peer_sk) = generate_test_keypair();

        // Create an outgoing request from peer's perspective
        let (announcement_bytes, _) =
            OutgoingInitiationRequest::new(&peer_pk, &peer_sk, &our_pk, vec![]);

        // Parse it as incoming from our perspective
        let incoming_req =
            IncomingInitiationRequest::try_from(&announcement_bytes, &our_pk, &our_sk);

        assert!(incoming_req.is_some());
        let (incoming_req, user_data) = incoming_req.unwrap();
        assert!(user_data.is_empty());
        assert!(incoming_req.timestamp_millis > 0);
        assert_eq!(
            incoming_req.origin_public_keys.derive_id(),
            peer_pk.derive_id()
        );
    }

    /// Tests that parsing an announcement intended for a different recipient fails
    #[test]
    fn test_incoming_initiation_request_wrong_recipient() {
        let (our_pk, our_sk) = generate_test_keypair();
        let (peer_pk, peer_sk) = generate_test_keypair();
        let (wrong_pk, _wrong_sk) = generate_test_keypair();

        // Create an announcement for wrong_pk
        let (announcement_bytes, _) =
            OutgoingInitiationRequest::new(&peer_pk, &peer_sk, &wrong_pk, vec![]);

        // Try to parse with our keys - should fail
        let incoming_req =
            IncomingInitiationRequest::try_from(&announcement_bytes, &our_pk, &our_sk);

        assert!(incoming_req.is_none());
    }

    /// Tests that parsing invalid announcement data fails gracefully
    #[test]
    fn test_incoming_initiation_request_invalid_data() {
        let (our_pk, our_sk) = generate_test_keypair();
        let invalid_bytes = b"not a valid announcement";

        let incoming_req = IncomingInitiationRequest::try_from(invalid_bytes, &our_pk, &our_sk);
        assert!(incoming_req.is_none());
    }

    /// Tests that sessions can be created from a pair of initiation requests.
    /// Verifies that the KDF-based seeker keypair derivation produces valid sessions.
    #[test]
    fn test_session_creation_from_initiation_pair() {
        let (alice_pk, alice_sk) = generate_test_keypair();
        let (bob_pk, bob_sk) = generate_test_keypair();

        // Alice creates outgoing request to Bob
        let (alice_announcement, alice_outgoing) =
            OutgoingInitiationRequest::new(&alice_pk, &alice_sk, &bob_pk, vec![]);

        // Bob creates outgoing request to Alice
        let (bob_announcement, bob_outgoing) =
            OutgoingInitiationRequest::new(&bob_pk, &bob_sk, &alice_pk, vec![]);

        // Alice receives Bob's announcement
        let (bob_incoming_at_alice, _) =
            IncomingInitiationRequest::try_from(&bob_announcement, &alice_pk, &alice_sk)
                .expect("Failed to parse Bob's announcement at Alice");

        // Bob receives Alice's announcement
        let (alice_incoming_at_bob, _) =
            IncomingInitiationRequest::try_from(&alice_announcement, &bob_pk, &bob_sk)
                .expect("Failed to parse Alice's announcement at Bob");

        // Both create sessions
        let _alice_session =
            Session::from_initiation_request_pair(&alice_outgoing, &bob_incoming_at_alice);
        let _bob_session =
            Session::from_initiation_request_pair(&bob_outgoing, &alice_incoming_at_bob);

        // Sessions created successfully (KeyPairs are generated randomly, so we can't compare them)
    }

    /// Tests basic message sending and receiving in a session
    #[test]
    fn test_session_send_and_receive_message() {
        let (alice_pk, alice_sk) = generate_test_keypair();
        let (bob_pk, bob_sk) = generate_test_keypair();

        // Establish sessions
        let _timestamp = crate::utils::timestamp_millis();
        let (alice_announcement, alice_outgoing) =
            OutgoingInitiationRequest::new(&alice_pk, &alice_sk, &bob_pk, vec![]);
        let (bob_announcement, bob_outgoing) =
            OutgoingInitiationRequest::new(&bob_pk, &bob_sk, &alice_pk, vec![]);

        let (bob_incoming_at_alice, _) =
            IncomingInitiationRequest::try_from(&bob_announcement, &alice_pk, &alice_sk).unwrap();
        let (alice_incoming_at_bob, _) =
            IncomingInitiationRequest::try_from(&alice_announcement, &bob_pk, &bob_sk).unwrap();

        let mut alice_session =
            Session::from_initiation_request_pair(&alice_outgoing, &bob_incoming_at_alice);
        let mut bob_session =
            Session::from_initiation_request_pair(&bob_outgoing, &alice_incoming_at_bob);

        // Alice sends a message to Bob
        let message = create_test_message(b"Hello Bob!");
        let send_output = alice_session.send_outgoing_message(&message.contents);

        assert!(!send_output.seeker.is_empty());
        assert!(!send_output.data.is_empty());

        // Bob receives the message
        let receive_output = bob_session
            .try_feed_incoming_message(&bob_sk, &send_output.seeker, &send_output.data)
            .expect("Failed to decrypt message");

        assert_eq!(receive_output.message, b"Hello Bob!");
        // Sender should be Alice
        let alice_id = alice_pk.derive_id();
        assert_eq!(receive_output.user_id, alice_id.as_bytes().to_vec());
        assert_eq!(receive_output.user_id.len(), 32);
        // Timestamps might differ slightly due to test timing
        assert!((receive_output.timestamp as u128).abs_diff(message.timestamp) < 10);
    }

    /// Tests that messages can be sent in both directions and multiple times
    #[test]
    fn test_session_bidirectional_messaging() {
        let (alice_pk, alice_sk) = generate_test_keypair();
        let (bob_pk, bob_sk) = generate_test_keypair();

        // Establish sessions
        let _timestamp = crate::utils::timestamp_millis();
        let (alice_announcement, alice_outgoing) =
            OutgoingInitiationRequest::new(&alice_pk, &alice_sk, &bob_pk, vec![]);
        let (bob_announcement, bob_outgoing) =
            OutgoingInitiationRequest::new(&bob_pk, &bob_sk, &alice_pk, vec![]);

        let (bob_incoming_at_alice, _) =
            IncomingInitiationRequest::try_from(&bob_announcement, &alice_pk, &alice_sk).unwrap();
        let (alice_incoming_at_bob, _) =
            IncomingInitiationRequest::try_from(&alice_announcement, &bob_pk, &bob_sk).unwrap();

        let mut alice_session =
            Session::from_initiation_request_pair(&alice_outgoing, &bob_incoming_at_alice);
        let mut bob_session =
            Session::from_initiation_request_pair(&bob_outgoing, &alice_incoming_at_bob);

        // Alice -> Bob
        let msg1 = create_test_message(b"Hello Bob!");
        let output1 = alice_session.send_outgoing_message(&msg1.contents);
        let received1 = bob_session
            .try_feed_incoming_message(&bob_sk, &output1.seeker, &output1.data)
            .unwrap();
        assert_eq!(received1.message, b"Hello Bob!");
        let alice_id = alice_pk.derive_id();
        assert_eq!(received1.user_id, alice_id.as_bytes().to_vec());

        // Bob -> Alice
        let msg2 = create_test_message(b"Hi Alice!");
        let output2 = bob_session.send_outgoing_message(&msg2.contents);
        let received2 = alice_session
            .try_feed_incoming_message(&alice_sk, &output2.seeker, &output2.data)
            .unwrap();
        assert_eq!(received2.message, b"Hi Alice!");
        let bob_id = bob_pk.derive_id();
        assert_eq!(received2.user_id, bob_id.as_bytes().to_vec());

        // Alice -> Bob (second message)
        let msg3 = create_test_message(b"How are you?");
        let output3 = alice_session.send_outgoing_message(&msg3.contents);
        let received3 = bob_session
            .try_feed_incoming_message(&bob_sk, &output3.seeker, &output3.data)
            .unwrap();
        assert_eq!(received3.message, b"How are you?");
        assert_eq!(received3.user_id, alice_id.as_bytes().to_vec());
    }

    /// Tests that a message encrypted for one recipient cannot be decrypted by another.
    /// This verifies the end-to-end encryption security property.
    #[test]
    fn test_session_wrong_recipient_cannot_decrypt() {
        let (alice_pk, alice_sk) = generate_test_keypair();
        let (bob_pk, bob_sk) = generate_test_keypair();
        let (eve_pk, eve_sk) = generate_test_keypair();

        // Establish session between Alice and Bob
        let _timestamp = crate::utils::timestamp_millis();
        let (alice_announcement, alice_outgoing) =
            OutgoingInitiationRequest::new(&alice_pk, &alice_sk, &bob_pk, vec![]);
        let (bob_announcement, _bob_outgoing) =
            OutgoingInitiationRequest::new(&bob_pk, &bob_sk, &alice_pk, vec![]);

        let (bob_incoming_at_alice, _) =
            IncomingInitiationRequest::try_from(&bob_announcement, &alice_pk, &alice_sk).unwrap();
        let (_alice_incoming_at_bob, _) =
            IncomingInitiationRequest::try_from(&alice_announcement, &bob_pk, &bob_sk).unwrap();

        let mut alice_session =
            Session::from_initiation_request_pair(&alice_outgoing, &bob_incoming_at_alice);

        // Eve establishes her own session with Alice
        let (eve_announcement, eve_outgoing) =
            OutgoingInitiationRequest::new(&eve_pk, &eve_sk, &alice_pk, vec![]);
        let (eve_incoming_at_alice, _) =
            IncomingInitiationRequest::try_from(&eve_announcement, &alice_pk, &alice_sk).unwrap();
        let (alice_to_eve_announcement, _alice_to_eve_outgoing) =
            OutgoingInitiationRequest::new(&alice_pk, &alice_sk, &eve_pk, vec![]);
        let (_alice_incoming_at_eve, _) =
            IncomingInitiationRequest::try_from(&alice_to_eve_announcement, &eve_pk, &eve_sk)
                .unwrap();
        let mut eve_session =
            Session::from_initiation_request_pair(&eve_outgoing, &eve_incoming_at_alice);

        // Alice sends message to Bob
        let message = create_test_message(b"Secret message for Bob");
        let send_output = alice_session.send_outgoing_message(&message.contents);

        // Eve tries to decrypt (should fail)
        let eve_attempt =
            eve_session.try_feed_incoming_message(&eve_sk, &send_output.seeker, &send_output.data);
        assert!(eve_attempt.is_none());
    }

    /// Tests that seekers are constructed correctly and have the expected structure
    #[test]
    fn test_session_seeker_construction() {
        let (alice_pk, alice_sk) = generate_test_keypair();
        let (bob_pk, bob_sk) = generate_test_keypair();

        let (alice_announcement, alice_outgoing) =
            OutgoingInitiationRequest::new(&alice_pk, &alice_sk, &bob_pk, vec![]);
        let (bob_announcement, _bob_outgoing) =
            OutgoingInitiationRequest::new(&bob_pk, &bob_sk, &alice_pk, vec![]);

        let (bob_incoming_at_alice, _) =
            IncomingInitiationRequest::try_from(&bob_announcement, &alice_pk, &alice_sk).unwrap();
        let (_alice_incoming_at_bob, _) =
            IncomingInitiationRequest::try_from(&alice_announcement, &bob_pk, &bob_sk).unwrap();
        let alice_session =
            Session::from_initiation_request_pair(&alice_outgoing, &bob_incoming_at_alice);

        // Get seeker for next peer message
        let peer_seeker = alice_session.next_peer_message_seeker();

        // Seeker should now be a Massa hash of the public key (starts with length byte, then hash bytes, then MESSAGE_SEEKER_DB_KEY)
        assert!(!peer_seeker.is_empty());
        // Just verify it's non-empty and has reasonable structure
        assert!(peer_seeker.len() > 10); // Hash + metadata
    }

    /// Tests that lag length increases when messages are sent without acknowledgment
    #[test]
    fn test_session_lag_length() {
        let (alice_pk, alice_sk) = generate_test_keypair();
        let (bob_pk, bob_sk) = generate_test_keypair();

        let (alice_announcement, alice_outgoing) =
            OutgoingInitiationRequest::new(&alice_pk, &alice_sk, &bob_pk, vec![]);
        let (bob_announcement, _bob_outgoing) =
            OutgoingInitiationRequest::new(&bob_pk, &bob_sk, &alice_pk, vec![]);

        let (bob_incoming_at_alice, _) =
            IncomingInitiationRequest::try_from(&bob_announcement, &alice_pk, &alice_sk).unwrap();
        let (_alice_incoming_at_bob, _) =
            IncomingInitiationRequest::try_from(&alice_announcement, &bob_pk, &bob_sk).unwrap();
        let mut alice_session =
            Session::from_initiation_request_pair(&alice_outgoing, &bob_incoming_at_alice);

        // Get initial lag
        let initial_lag = alice_session.lag_length();

        // Send messages (lag increases without acknowledgments)
        alice_session.send_outgoing_message(&create_test_message(b"msg1").contents);
        let lag1 = alice_session.lag_length();
        assert!(lag1 > initial_lag);

        alice_session.send_outgoing_message(&create_test_message(b"msg2").contents);
        let lag2 = alice_session.lag_length();
        assert!(lag2 > lag1);
    }

    /// Tests that sent messages are acknowledged when the peer replies
    #[test]
    fn test_session_acknowledgments() {
        let (alice_pk, alice_sk) = generate_test_keypair();
        let (bob_pk, bob_sk) = generate_test_keypair();

        // Establish sessions
        let _timestamp = crate::utils::timestamp_millis();
        let (alice_announcement, alice_outgoing) =
            OutgoingInitiationRequest::new(&alice_pk, &alice_sk, &bob_pk, vec![]);
        let (bob_announcement, bob_outgoing) =
            OutgoingInitiationRequest::new(&bob_pk, &bob_sk, &alice_pk, vec![]);

        let (bob_incoming_at_alice, _) =
            IncomingInitiationRequest::try_from(&bob_announcement, &alice_pk, &alice_sk).unwrap();
        let (alice_incoming_at_bob, _) =
            IncomingInitiationRequest::try_from(&alice_announcement, &bob_pk, &bob_sk).unwrap();

        let mut alice_session =
            Session::from_initiation_request_pair(&alice_outgoing, &bob_incoming_at_alice);
        let mut bob_session =
            Session::from_initiation_request_pair(&bob_outgoing, &alice_incoming_at_bob);

        // Alice sends multiple messages
        let msg1 = create_test_message(b"msg1");
        let output1 = alice_session.send_outgoing_message(&msg1.contents);
        let msg2 = create_test_message(b"msg2");
        let _output2 = alice_session.send_outgoing_message(&msg2.contents);

        // Bob receives first message
        let received1 = bob_session
            .try_feed_incoming_message(&bob_sk, &output1.seeker, &output1.data)
            .unwrap();
        assert_eq!(received1.message, b"msg1");
        let alice_id = alice_pk.derive_id();
        assert_eq!(received1.user_id, alice_id.as_bytes().to_vec());

        // Bob sends a reply (which acknowledges Alice's messages)
        let reply = create_test_message(b"reply");
        let reply_output = bob_session.send_outgoing_message(&reply.contents);

        // Alice receives Bob's reply
        let received_reply = alice_session
            .try_feed_incoming_message(&alice_sk, &reply_output.seeker, &reply_output.data)
            .unwrap();
        assert_eq!(received_reply.message, b"reply");
        let bob_id = bob_pk.derive_id();
        assert_eq!(received_reply.user_id, bob_id.as_bytes().to_vec());

        // Check if there are newly acknowledged seekers
        assert!(!received_reply.newly_acknowledged_self_seekers.is_empty());
    }

    /// Tests that empty messages can be sent and received (useful for keep-alive)
    #[test]
    fn test_session_empty_message() {
        let (alice_pk, alice_sk) = generate_test_keypair();
        let (bob_pk, bob_sk) = generate_test_keypair();

        // Establish sessions
        let _timestamp = crate::utils::timestamp_millis();
        let (alice_announcement, alice_outgoing) =
            OutgoingInitiationRequest::new(&alice_pk, &alice_sk, &bob_pk, vec![]);
        let (bob_announcement, bob_outgoing) =
            OutgoingInitiationRequest::new(&bob_pk, &bob_sk, &alice_pk, vec![]);

        let (bob_incoming_at_alice, _) =
            IncomingInitiationRequest::try_from(&bob_announcement, &alice_pk, &alice_sk).unwrap();
        let (alice_incoming_at_bob, _) =
            IncomingInitiationRequest::try_from(&alice_announcement, &bob_pk, &bob_sk).unwrap();

        let mut alice_session =
            Session::from_initiation_request_pair(&alice_outgoing, &bob_incoming_at_alice);
        let mut bob_session =
            Session::from_initiation_request_pair(&bob_outgoing, &alice_incoming_at_bob);

        // Send empty message (for keep-alive)
        let empty_message = create_test_message(b"");
        let send_output = alice_session.send_outgoing_message(&empty_message.contents);

        let receive_output = bob_session
            .try_feed_incoming_message(&bob_sk, &send_output.seeker, &send_output.data)
            .unwrap();

        assert!(receive_output.message.is_empty());
        let alice_id = alice_pk.derive_id();
        assert_eq!(receive_output.user_id, alice_id.as_bytes().to_vec());
    }

    /// Tests that large messages (10KB) can be successfully sent and received
    #[test]
    fn test_session_large_message() {
        let (alice_pk, alice_sk) = generate_test_keypair();
        let (bob_pk, bob_sk) = generate_test_keypair();

        // Establish sessions
        let _timestamp = crate::utils::timestamp_millis();
        let (alice_announcement, alice_outgoing) =
            OutgoingInitiationRequest::new(&alice_pk, &alice_sk, &bob_pk, vec![]);
        let (bob_announcement, bob_outgoing) =
            OutgoingInitiationRequest::new(&bob_pk, &bob_sk, &alice_pk, vec![]);

        let (bob_incoming_at_alice, _) =
            IncomingInitiationRequest::try_from(&bob_announcement, &alice_pk, &alice_sk).unwrap();
        let (alice_incoming_at_bob, _) =
            IncomingInitiationRequest::try_from(&alice_announcement, &bob_pk, &bob_sk).unwrap();

        let mut alice_session =
            Session::from_initiation_request_pair(&alice_outgoing, &bob_incoming_at_alice);
        let mut bob_session =
            Session::from_initiation_request_pair(&bob_outgoing, &alice_incoming_at_bob);

        // Send large message (10KB)
        let large_content = vec![42u8; 10_000];
        let large_message = create_test_message(&large_content);
        let send_output = alice_session.send_outgoing_message(&large_message.contents);

        let receive_output = bob_session
            .try_feed_incoming_message(&bob_sk, &send_output.seeker, &send_output.data)
            .unwrap();

        assert_eq!(receive_output.message, large_content);
        let alice_id = alice_pk.derive_id();
        assert_eq!(receive_output.user_id, alice_id.as_bytes().to_vec());
    }

    // test_seeker_prefix_uniqueness removed - seekers now use randomly generated Massa keypairs,
    // so uniqueness is guaranteed by cryptographic randomness rather than prefixes
}
