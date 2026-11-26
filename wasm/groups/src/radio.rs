//! Group messages over low-bandwidth radio (MeshCore channel datagrams).
//!
//! A radio message is a real message event of a group epoch, sent in a compact form that a
//! member rebuilds exactly: the same event ID, the same content. Once rebuilt it is stored,
//! merged and relayed like any other event, so a group survives a change of transport.
//!
//! What is sent, at most [`MAX_DATAGRAM`] bytes:
//!
//! ```text
//! version (1) ‖ ts (8, big-endian ms) ‖ nonce (4) ‖ tag (4) ‖ AES-256-SIV(type (1) ‖ text)
//! ```
//!
//! Everything else is implied for a member of the epoch:
//!
//! - the epoch and the author are found by the tag, computed for every member of every epoch
//!   the device holds;
//! - the event ID random part and `syncObjId` are derived, so every rebuild agrees;
//! - `created_at = last_modified_at = ts`, no parents, not edited, no metadata;
//! - the secret proof is recomputed from the group secret (§4.2).
//!
//! A **relay** (body type 1) is a temporary copy of a message that travelled online, put on
//! the air by a member for members who only have radio: such a message has parents and
//! metadata, so it cannot be rebuilt as the same event. It carries the first
//! [`RELAY_REF_SIZE`] bytes of the message's `syncObjId`, the original author (in its tag)
//! and creation time (its `ts`), and the text, cut to [`MAX_RELAY_TEXT`] bytes. The receiver
//! shows it until the real message arrives.
//!
//! Keys come from the epoch's group secret, which reached every member over Agraphon
//! sessions, so a non-member, the radio and the MeshCore mesh learn nothing but the clear
//! header. A replay rebuilds the same event ID, which a device already holds.

use crate::cbor::Value;
use crate::error::{Error, Result};
use crate::event::{Body, Content, MessageEvent, Payload};
use crate::hash::h;
use crate::ids::{ChatId, EventId, GossipId, SyncObjId};
use crate::root::Root;
use std::collections::BTreeMap;
use zeroize::Zeroizing;

/// Radio format version.
pub const VERSION: u8 = 1;
/// Largest MeshCore channel datagram payload (measured on firmware v1.18.0).
pub const MAX_DATAGRAM: usize = 165;
/// Bytes of the clear header: version, timestamp, nonce, tag.
pub const HEADER_SIZE: usize = 1 + 8 + 4 + 4;
/// Bytes the AES-256-SIV tag adds.
pub const SIV_TAG_SIZE: usize = 16;
/// Largest UTF-8 text a radio message can carry.
pub const MAX_TEXT: usize = MAX_DATAGRAM - HEADER_SIZE - SIV_TAG_SIZE - 1;

/// Body type of a radio message: a text message event.
const TYPE_TEXT: u8 = 0;
/// Body type of a relay: `flags (1) ‖ ref (8) ‖ text`.
const TYPE_RELAY: u8 = 1;
/// Relay flag: the text was cut.
const FLAG_TRUNCATED: u8 = 0x01;
/// Bytes of a message's `syncObjId` a relay refers to it by.
pub const RELAY_REF_SIZE: usize = 8;
/// Largest UTF-8 text a relay carries; longer ones are cut at a character boundary.
pub const MAX_RELAY_TEXT: usize = MAX_TEXT - 1 - RELAY_REF_SIZE;

const DOMAIN_EPOCH: &str = "gossip.groups.radio.epoch.1";
const DOMAIN_TAG: &str = "gossip.groups.radio.tag.1";
const DOMAIN_KEY_A: &str = "gossip.groups.radio.key.a.1";
const DOMAIN_KEY_B: &str = "gossip.groups.radio.key.b.1";
const DOMAIN_EVENT: &str = "gossip.groups.radio.event.1";
const DOMAIN_SYNC_OBJ: &str = "gossip.groups.radio.sync_obj.1";

/// The radio key of an epoch: `H("gossip.groups.radio.epoch.1", chat_id, group_secret)`.
#[must_use]
pub fn epoch_key(root: &Root) -> Zeroizing<[u8; 32]> {
    Zeroizing::new(h(
        DOMAIN_EPOCH,
        vec![
            Value::Bytes(root.chat_id().as_bytes()),
            Value::Bytes(root.group_secret().as_bytes()),
        ],
    ))
}

/// What one message derives from the epoch key, its author and its clear header.
struct Derived {
    tag: [u8; 4],
    key: Zeroizing<[u8; crypto_aead::KEY_SIZE]>,
    event_random: [u8; 16],
    sync_obj_id: SyncObjId,
}

fn derive(rk: &[u8; 32], author: &GossipId, ts: u64, nonce: &[u8; 4]) -> Derived {
    let items = || {
        vec![
            Value::Bytes(rk),
            Value::Bytes(author.as_bytes()),
            Value::Uint(ts),
            Value::Bytes(nonce),
        ]
    };
    let tag_full = h(DOMAIN_TAG, items());
    let mut key = Zeroizing::new([0_u8; crypto_aead::KEY_SIZE]);
    key[..32].copy_from_slice(&h(DOMAIN_KEY_A, items()));
    key[32..].copy_from_slice(&h(DOMAIN_KEY_B, items()));
    let event_full = h(DOMAIN_EVENT, items());
    let mut event_random = [0_u8; 16];
    event_random.copy_from_slice(&event_full[..16]);
    Derived {
        tag: [tag_full[0], tag_full[1], tag_full[2], tag_full[3]],
        key,
        event_random,
        sync_obj_id: SyncObjId::from_bytes(h(DOMAIN_SYNC_OBJ, items())),
    }
}

/// The message event a radio message stands for.
fn rebuild(
    root: &Root,
    author: GossipId,
    ts: u64,
    d: &Derived,
    text: String,
) -> Result<MessageEvent> {
    MessageEvent::create(
        root,
        EventId::new(ts, d.event_random),
        &[],
        Payload::Content(Content {
            sync_obj_id: d.sync_obj_id,
            author,
            created_at: ts,
            last_modified_at: ts,
            body: Body::Text(text),
            edited: false,
            metadata: BTreeMap::new(),
        }),
    )
}

fn header(ts: u64, nonce: &[u8; 4], tag: &[u8; 4]) -> [u8; HEADER_SIZE] {
    let mut out = [0_u8; HEADER_SIZE];
    out[0] = VERSION;
    out[1..9].copy_from_slice(&ts.to_be_bytes());
    out[9..13].copy_from_slice(nonce);
    out[13..17].copy_from_slice(tag);
    out
}

/// A radio message and the event it stands for.
#[derive(Debug, Clone)]
pub struct Sealed {
    /// The event, to store and publish like any other.
    pub event: MessageEvent,
    /// The datagram to hand to the radio.
    pub datagram: Vec<u8>,
}

/// Builds the radio form of a text message by `author` in the epoch `root`, created at `ts`
/// with the fresh random `nonce`.
///
/// # Errors
///
/// [`Error::TooMany`] when the text does not fit a datagram, and every rule of
/// [`MessageEvent::create`].
pub fn seal_text(
    root: &Root,
    author: GossipId,
    ts: u64,
    nonce: [u8; 4],
    text: &str,
) -> Result<Sealed> {
    if text.len() > MAX_TEXT {
        return Err(Error::TooMany {
            field: "radio text",
            max: MAX_TEXT,
            got: text.len(),
        });
    }
    let rk = epoch_key(root);
    let d = derive(&rk, &author, ts, &nonce);
    let event = rebuild(root, author, ts, &d, text.to_owned())?;
    let mut plaintext = Zeroizing::new(Vec::with_capacity(1 + text.len()));
    plaintext.push(TYPE_TEXT);
    plaintext.extend_from_slice(text.as_bytes());
    let datagram = seal(&d, ts, &nonce, &plaintext);
    Ok(Sealed { event, datagram })
}

/// Builds a relay of the message `sync_obj_id` of `author`, created at `ts`, in the epoch
/// `root`, with the fresh random `nonce`. A text over [`MAX_RELAY_TEXT`] bytes is cut.
///
/// # Errors
///
/// [`Error::NotMember`] when `author` is not a member of the epoch: members find a relay
/// by the author's tag.
pub fn seal_relay(
    root: &Root,
    author: GossipId,
    ts: u64,
    nonce: [u8; 4],
    sync_obj_id: &SyncObjId,
    text: &str,
) -> Result<Vec<u8>> {
    if !root.members().contains(&author) {
        return Err(Error::NotMember("relay author"));
    }
    let mut cut = text.len().min(MAX_RELAY_TEXT);
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let rk = epoch_key(root);
    let d = derive(&rk, &author, ts, &nonce);
    let mut plaintext = Zeroizing::new(Vec::with_capacity(2 + RELAY_REF_SIZE + cut));
    plaintext.push(TYPE_RELAY);
    plaintext.push(if cut < text.len() { FLAG_TRUNCATED } else { 0 });
    plaintext.extend_from_slice(&sync_obj_id.as_bytes()[..RELAY_REF_SIZE]);
    plaintext.extend_from_slice(&text.as_bytes()[..cut]);
    Ok(seal(&d, ts, &nonce, &plaintext))
}

fn seal(d: &Derived, ts: u64, nonce: &[u8; 4], plaintext: &[u8]) -> Vec<u8> {
    let head = header(ts, nonce, &d.tag);
    let sealed = crypto_aead::encrypt(
        &crypto_aead::Key::from_ref(&d.key),
        &crypto_aead::Nonce::from([0_u8; crypto_aead::NONCE_SIZE]),
        plaintext,
        &head,
    );
    let mut datagram = Vec::with_capacity(HEADER_SIZE + sealed.len());
    datagram.extend_from_slice(&head);
    datagram.extend_from_slice(&sealed);
    debug_assert!(datagram.len() <= MAX_DATAGRAM);
    datagram
}

/// A radio datagram opened against one of the device's epochs.
#[derive(Debug, Clone)]
pub enum Opened {
    /// A radio message: the rebuilt event.
    Message {
        /// The event.
        event: MessageEvent,
        /// Its author, as identified by the tag.
        author: GossipId,
    },
    /// A relay: a temporary copy of a message sent online.
    Relay(Relayed),
}

/// A relay opened (see the module documentation).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relayed {
    /// The epoch it was opened with.
    pub chat_id: ChatId,
    /// The message's author.
    pub author: GossipId,
    /// The message's creation time.
    pub ts: u64,
    /// The first bytes of the message's `syncObjId`.
    pub sync_ref: [u8; RELAY_REF_SIZE],
    /// Its text, possibly cut.
    pub text: String,
    /// The text was cut.
    pub truncated: bool,
}

/// Opens `datagram` against the epochs in `roots`: the first epoch and member whose tag and
/// encryption match. `None` for anything else (not ours, damaged, unknown version), without
/// saying why.
#[must_use]
pub fn open<'a>(datagram: &[u8], roots: impl IntoIterator<Item = &'a Root>) -> Option<Opened> {
    if datagram.len() < HEADER_SIZE + SIV_TAG_SIZE + 1
        || datagram.len() > MAX_DATAGRAM
        || datagram[0] != VERSION
    {
        return None;
    }
    let ts = u64::from_be_bytes(datagram[1..9].try_into().ok()?);
    let nonce: [u8; 4] = datagram[9..13].try_into().ok()?;
    let tag: [u8; 4] = datagram[13..17].try_into().ok()?;
    let head = &datagram[..HEADER_SIZE];
    let sealed = &datagram[HEADER_SIZE..];
    for root in roots {
        let rk = epoch_key(root);
        for member in root.members() {
            let d = derive(&rk, member, ts, &nonce);
            if d.tag != tag {
                continue;
            }
            let Some(plaintext) = crypto_aead::decrypt(
                &crypto_aead::Key::from_ref(&d.key),
                &crypto_aead::Nonce::from([0_u8; crypto_aead::NONCE_SIZE]),
                sealed,
                head,
            ) else {
                // A 4-byte tag collides now and then; keep looking.
                continue;
            };
            let plaintext = Zeroizing::new(plaintext);
            return match plaintext.first() {
                Some(&TYPE_TEXT) => {
                    let text = String::from_utf8(plaintext[1..].to_vec()).ok()?;
                    let event = rebuild(root, *member, ts, &d, text).ok()?;
                    Some(Opened::Message {
                        event,
                        author: *member,
                    })
                }
                Some(&TYPE_RELAY) if plaintext.len() >= 2 + RELAY_REF_SIZE => {
                    let flags = plaintext[1];
                    let sync_ref: [u8; RELAY_REF_SIZE] =
                        plaintext[2..2 + RELAY_REF_SIZE].try_into().ok()?;
                    let text = String::from_utf8(plaintext[2 + RELAY_REF_SIZE..].to_vec()).ok()?;
                    Some(Opened::Relay(Relayed {
                        chat_id: root.chat_id(),
                        author: *member,
                        ts,
                        sync_ref,
                        text,
                        truncated: flags & FLAG_TRUNCATED != 0,
                    }))
                }
                _ => None,
            };
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::root::tests::{founding, params};
    use crate::test_support::identity;

    const TS: u64 = 1_700_000_100_000;

    fn message(opened: Option<Opened>) -> (MessageEvent, GossipId) {
        match opened {
            Some(Opened::Message { event, author }) => (event, author),
            other => panic!("not a message: {other:?}"),
        }
    }

    #[test]
    fn a_member_rebuilds_exactly_the_sent_event() {
        let (alice, bob, carol) = (identity(1), identity(2), identity(3));
        let root = founding(&alice, &[&alice, &bob, &carol]);
        let sealed = seal_text(&root, bob.id, TS, [1, 2, 3, 4], "on my way").unwrap();
        assert!(sealed.datagram.len() <= MAX_DATAGRAM);

        let Some(Opened::Message { event, author }) = open(&sealed.datagram, [&root]) else {
            panic!("not a message");
        };
        assert_eq!(author, bob.id);
        assert_eq!(event, sealed.event);
        assert!(event.parents().is_empty());
        assert_eq!(event.timestamp(), TS);
        assert!(event.check_against_root(&root).is_ok());
    }

    #[test]
    fn the_longest_text_fills_one_datagram_and_one_more_byte_is_refused() {
        let (alice, bob) = (identity(1), identity(2));
        let root = founding(&alice, &[&alice, &bob]);
        let text = "é".repeat(MAX_TEXT / 2) + &"x".repeat(MAX_TEXT % 2);
        assert_eq!(text.len(), MAX_TEXT);
        let sealed = seal_text(&root, alice.id, TS, [9; 4], &text).unwrap();
        assert_eq!(sealed.datagram.len(), MAX_DATAGRAM);
        assert_eq!(message(open(&sealed.datagram, [&root])).0, sealed.event);
        assert!(matches!(
            seal_text(&root, alice.id, TS, [9; 4], &(text + "x")),
            Err(Error::TooMany { .. })
        ));
    }

    #[test]
    fn another_epoch_or_a_damaged_datagram_opens_nothing() {
        let (alice, bob, mallory) = (identity(1), identity(2), identity(4));
        let root = founding(&alice, &[&alice, &bob]);
        let other = Root::create_successor(
            params(&mallory, &[&mallory, &bob], 0x20),
            &[crate::ids::ChatId::from_bytes([0xd1; 32])],
            &mallory.secret.dsa_signing_key,
            [0x5b; 32],
        )
        .unwrap();
        let sealed = seal_text(&root, alice.id, TS, [7; 4], "hello").unwrap();

        assert!(open(&sealed.datagram, [&other]).is_none());
        // Found among several epochs.
        assert_eq!(
            message(open(&sealed.datagram, [&other, &root])).1,
            alice.id
        );
        for i in 0..sealed.datagram.len() {
            let mut damaged = sealed.datagram.clone();
            damaged[i] ^= 0x01;
            assert!(open(&damaged, [&root]).is_none(), "byte {i}");
        }
        assert!(open(&sealed.datagram[..20], [&root]).is_none());
    }

    #[test]
    fn a_relay_opens_to_its_reference_and_text_and_cuts_long_texts() {
        let (alice, bob, mallory) = (identity(1), identity(2), identity(4));
        let root = founding(&alice, &[&alice, &bob]);
        let sync = SyncObjId::from_bytes([0x42; 32]);
        let datagram = seal_relay(&root, alice.id, TS, [3; 4], &sync, "sent online").unwrap();
        let Some(Opened::Relay(r)) = open(&datagram, [&root]) else {
            panic!("not a relay");
        };
        assert_eq!(r.chat_id, root.chat_id());
        assert_eq!(r.author, alice.id);
        assert_eq!(r.ts, TS);
        assert_eq!(r.sync_ref, [0x42; RELAY_REF_SIZE]);
        assert_eq!(r.text, "sent online");
        assert!(!r.truncated);

        // Cut at a character boundary, and still one datagram.
        let long = "é".repeat(MAX_RELAY_TEXT);
        let datagram = seal_relay(&root, bob.id, TS, [4; 4], &sync, &long).unwrap();
        assert_eq!(datagram.len(), MAX_DATAGRAM - usize::from(MAX_RELAY_TEXT % 2 == 1));
        let Some(Opened::Relay(r)) = open(&datagram, [&root]) else {
            panic!("not a relay");
        };
        assert!(r.truncated);
        assert_eq!(r.text, "é".repeat(MAX_RELAY_TEXT / 2));

        assert!(matches!(
            seal_relay(&root, mallory.id, TS, [5; 4], &sync, "x"),
            Err(Error::NotMember(_))
        ));
        assert!(!datagram.windows(2).any(|w| w == "é".as_bytes()));
    }

    #[test]
    fn a_replay_is_the_same_event_and_each_message_gets_its_own_ids() {
        let (alice, bob) = (identity(1), identity(2));
        let root = founding(&alice, &[&alice, &bob]);
        let one = seal_text(&root, alice.id, TS, [1; 4], "same").unwrap();
        let two = seal_text(&root, alice.id, TS, [2; 4], "same").unwrap();
        assert_eq!(
            message(open(&one.datagram, [&root])).0.event_id(),
            one.event.event_id()
        );
        assert_ne!(one.event.event_id(), two.event.event_id());
        assert_ne!(
            one.event.payload().sync_obj_id(),
            two.event.payload().sync_obj_id()
        );
        // Nothing of the text is in clear.
        assert!(!one.datagram.windows(4).any(|w| w == b"same"));
    }
}
