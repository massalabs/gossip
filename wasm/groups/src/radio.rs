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
//! Keys come from the epoch's group secret, which reached every member over Agraphon
//! sessions, so a non-member, the radio and the MeshCore mesh learn nothing but the clear
//! header. A replay rebuilds the same event ID, which a device already holds.

use crate::cbor::Value;
use crate::error::{Error, Result};
use crate::event::{Body, Content, MessageEvent, Payload};
use crate::hash::h;
use crate::ids::{EventId, GossipId, SyncObjId};
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

/// Body type of a radio message. Only text in version 1.
const TYPE_TEXT: u8 = 0;

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
    let head = header(ts, &nonce, &d.tag);
    let mut plaintext = Zeroizing::new(Vec::with_capacity(1 + text.len()));
    plaintext.push(TYPE_TEXT);
    plaintext.extend_from_slice(text.as_bytes());
    let sealed = crypto_aead::encrypt(
        &crypto_aead::Key::from_ref(&d.key),
        &crypto_aead::Nonce::from([0_u8; crypto_aead::NONCE_SIZE]),
        &plaintext,
        &head,
    );
    let mut datagram = Vec::with_capacity(HEADER_SIZE + sealed.len());
    datagram.extend_from_slice(&head);
    datagram.extend_from_slice(&sealed);
    debug_assert!(datagram.len() <= MAX_DATAGRAM);
    Ok(Sealed { event, datagram })
}

/// A radio message opened against one of the device's epochs.
#[derive(Debug, Clone)]
pub struct Opened {
    /// The rebuilt event.
    pub event: MessageEvent,
    /// Its author, as identified by the tag.
    pub author: GossipId,
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
            if plaintext.first() != Some(&TYPE_TEXT) {
                return None;
            }
            let text = String::from_utf8(plaintext[1..].to_vec()).ok()?;
            let event = rebuild(root, *member, ts, &d, text).ok()?;
            return Some(Opened {
                event,
                author: *member,
            });
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

    #[test]
    fn a_member_rebuilds_exactly_the_sent_event() {
        let (alice, bob, carol) = (identity(1), identity(2), identity(3));
        let root = founding(&alice, &[&alice, &bob, &carol]);
        let sealed = seal_text(&root, bob.id, TS, [1, 2, 3, 4], "on my way").unwrap();
        assert!(sealed.datagram.len() <= MAX_DATAGRAM);

        let opened = open(&sealed.datagram, [&root]).unwrap();
        assert_eq!(opened.author, bob.id);
        assert_eq!(opened.event, sealed.event);
        assert!(opened.event.parents().is_empty());
        assert_eq!(opened.event.timestamp(), TS);
        assert!(opened.event.check_against_root(&root).is_ok());
    }

    #[test]
    fn the_longest_text_fills_one_datagram_and_one_more_byte_is_refused() {
        let (alice, bob) = (identity(1), identity(2));
        let root = founding(&alice, &[&alice, &bob]);
        let text = "é".repeat(MAX_TEXT / 2) + &"x".repeat(MAX_TEXT % 2);
        assert_eq!(text.len(), MAX_TEXT);
        let sealed = seal_text(&root, alice.id, TS, [9; 4], &text).unwrap();
        assert_eq!(sealed.datagram.len(), MAX_DATAGRAM);
        assert_eq!(open(&sealed.datagram, [&root]).unwrap().event, sealed.event);
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
            open(&sealed.datagram, [&other, &root]).unwrap().author,
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
    fn a_replay_is_the_same_event_and_each_message_gets_its_own_ids() {
        let (alice, bob) = (identity(1), identity(2));
        let root = founding(&alice, &[&alice, &bob]);
        let one = seal_text(&root, alice.id, TS, [1; 4], "same").unwrap();
        let two = seal_text(&root, alice.id, TS, [2; 4], "same").unwrap();
        assert_eq!(
            open(&one.datagram, [&root]).unwrap().event.event_id(),
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
