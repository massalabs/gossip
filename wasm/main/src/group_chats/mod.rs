//! Bindings of the group protocol engine (`groups::node::Node`) for the SDK.
//!
//! [`GroupsNode`] holds one identity's engine. The SDK drives it: it supplies the time, opens
//! it from the records stored in its database, persists the batches each operation commits
//! ([`GroupsNode::take_batches`]) and carries the plaintexts of the outbox inside the
//! one-to-one sessions. Identifiers are 32-byte arrays, times are milliseconds since the
//! epoch, and structured values are JSON text (see [`codec`]).
//!
//! The order the SDK follows after every call that changes something:
//!
//! 1. `take_batches()` and persist them, in order, each in one transaction;
//! 2. `poll_outbox(now)`, then persist the batch it committed;
//! 3. for each plaintext: `is_current(handle, now)` right before encrypting (it refuses while
//!    a batch is not persisted), then `handed_off(handle, now)` once the ciphertext is stored
//!    for sending, or `abandon(handle)`; `published(handle, now)` once it is sent.
//!
//! If persisting a batch fails, the in-memory engine is ahead of the database: the SDK drops
//! this object and opens a new one from the database.

pub mod codec;
pub mod engine;
pub mod json;
pub mod store;

use wasm_bindgen::prelude::*;

use self::engine::{Core, IdentityKey, id32};
use self::store::BatchOut;
use crate::{UserPublicKeys, UserSecretKeys};
use groups::{ChatId, GossipId, SyncObjId};

fn js(e: String) -> JsValue {
    JsValue::from_str(&e)
}

fn ms(t: f64) -> Result<u64, JsValue> {
    if (0.0..=9_007_199_254_740_991.0).contains(&t) {
        Ok(t as u64)
    } else {
        Err(JsValue::from_str("groups:invalid: bad time"))
    }
}

fn chat(b: &[u8]) -> Result<ChatId, JsValue> {
    id32(b).map_err(js)
}

fn peer(b: &[u8]) -> Result<GossipId, JsValue> {
    id32(b).map_err(js)
}

fn sync(b: &[u8]) -> Result<SyncObjId, JsValue> {
    id32(b).map_err(js)
}

fn set(o: &js_sys::Object, k: &str, v: &JsValue) {
    let _ = js_sys::Reflect::set(o, &JsValue::from_str(k), v);
}

// ── Size limits ──────────────────────────────────────────────────────────────

/// The largest group plaintext, in bytes (§13.10).
#[wasm_bindgen]
pub fn group_max_plaintext_bytes() -> u32 {
    groups::constants::MAX_PLAINTEXT_BYTES as u32
}

/// The largest text of a message version, in UTF-8 bytes: a text body, or the content of a
/// forward of text. A longer one is refused by the engine and by every receiver.
#[wasm_bindgen]
pub fn group_max_text_bytes() -> u32 {
    groups::constants::MAX_TEXT_BYTES as u32
}

/// The largest metadata of a message version, in bytes as [`group_metadata_bytes`] counts.
#[wasm_bindgen]
pub fn group_max_metadata_bytes() -> u32 {
    groups::constants::MAX_METADATA_BYTES as u32
}

/// The size of message metadata, given as `publish_message` takes it (a list of
/// `[name, hex]` pairs in JSON): its encoded size, every entry's framing included.
#[wasm_bindgen]
pub fn group_metadata_bytes(metadata: &str) -> Result<u32, JsValue> {
    engine::metadata_bytes(metadata)
        .map(|n| n as u32)
        .map_err(js)
}

/// The group engine of one identity.
#[wasm_bindgen]
pub struct GroupsNode {
    core: Core,
}

#[wasm_bindgen]
impl GroupsNode {
    /// Opens the engine of the identity from a snapshot of its stored records
    /// (`{rows, edges, objects, node}`, see `take_batches`; empty arrays for a new account).
    /// Only the ML-DSA signing key is copied out of the secret keys; the copy is erased
    /// when this object is freed.
    pub fn open(
        public_keys: &UserPublicKeys,
        secret_keys: &UserSecretKeys,
        snapshot: JsValue,
    ) -> Result<GroupsNode, JsValue> {
        let snapshot: BatchOut = serde_wasm_bindgen::from_value(snapshot)
            .map_err(|e| JsValue::from_str(&format!("groups:invalid: snapshot: {e}")))?;
        // Only the signing key is copied; the other secrets stay where they are.
        let identity = IdentityKey::new(public_keys.inner.clone(), &secret_keys.inner);
        let core = Core::open(identity, &snapshot).map_err(js)?;
        Ok(GroupsNode { core })
    }

    /// Message records found without their epoch when opening, and dropped.
    pub fn orphans(&self) -> u32 {
        self.core.report.orphans
    }

    /// This identity's GossipID.
    pub fn me(&self) -> Vec<u8> {
        self.core.me().as_bytes().to_vec()
    }

    /// The batches committed since the last call, oldest first: an array of
    /// `{rows, removedRows, edges, objects, node, erase}`, to apply in order.
    pub fn take_batches(&mut self) -> Result<JsValue, JsValue> {
        let b = self.core.take_batches().map_err(js)?;
        serde_wasm_bindgen::to_value(&b).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// The number of batches waiting to be taken.
    pub fn pending_batches(&self) -> u32 {
        self.core.pending_batches() as u32
    }

    /// Every record as one batch of upserts.
    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        let s = self.core.snapshot().map_err(js)?;
        serde_wasm_bindgen::to_value(&s).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    // ── Driving ──────────────────────────────────────────────────────────────

    /// Adds the `UserPublicKeys` bytes of a contact or a session peer to the key cache.
    /// Returns its GossipID.
    pub fn learn_keys(&mut self, keys: &[u8], now: f64) -> Result<Vec<u8>, JsValue> {
        let id = self.core.learn_keys(keys, ms(now)?).map_err(js)?;
        Ok(id.as_bytes().to_vec())
    }

    /// Whether a session with `peer` exists (in memory only; report it again after opening).
    pub fn set_session(&mut self, peer_id: &[u8], has_session: bool) -> Result<(), JsValue> {
        self.core.set_session(peer(peer_id)?, has_session);
        Ok(())
    }

    pub fn peer_reconnected(&mut self, peer_id: &[u8], now: f64) -> Result<(), JsValue> {
        self.core
            .peer_reconnected(peer(peer_id)?, ms(now)?)
            .map_err(js)
    }

    /// A group plaintext received from `from` in its one-to-one session.
    pub fn handle_plaintext(&mut self, from: &[u8], bytes: &[u8], now: f64) -> Result<(), JsValue> {
        self.core
            .handle_plaintext(peer(from)?, bytes, ms(now)?)
            .map_err(js)
    }

    pub fn tick(&mut self, now: f64) -> Result<(), JsValue> {
        self.core.tick(ms(now)?).map_err(js)
    }

    /// When to call `tick` next, or `undefined`.
    pub fn next_wakeup(&self, now: f64) -> Result<Option<f64>, JsValue> {
        Ok(self
            .core
            .next_wakeup(ms(now)?)
            .map_err(js)?
            .map(|t| t.min(9_007_199_254_740_991) as f64))
    }

    /// The plaintexts to send: an array of `{handle, to, plaintext}`.
    pub fn poll_outbox(&mut self, now: f64) -> Result<js_sys::Array, JsValue> {
        let out = self.core.poll_outbox(ms(now)?).map_err(js)?;
        let arr = js_sys::Array::new();
        for o in out {
            let obj = js_sys::Object::new();
            set(&obj, "handle", &JsValue::from_f64(o.handle as f64));
            set(
                &obj,
                "to",
                &js_sys::Uint8Array::from(o.to.as_bytes().as_slice()).into(),
            );
            set(
                &obj,
                "plaintext",
                &js_sys::Uint8Array::from(o.plaintext.as_slice()).into(),
            );
            arr.push(&obj);
        }
        Ok(arr)
    }

    pub fn is_current(&self, handle: f64, now: f64) -> Result<bool, JsValue> {
        self.core.is_current(handle as u64, ms(now)?).map_err(js)
    }

    pub fn handed_off(&mut self, handle: f64, now: f64) -> Result<(), JsValue> {
        self.core.handed_off(handle as u64, ms(now)?).map_err(js)
    }

    pub fn published(&mut self, handle: f64, now: f64) -> Result<(), JsValue> {
        self.core.published(handle as u64, ms(now)?).map_err(js)
    }

    pub fn abandon(&mut self, handle: f64) {
        self.core.abandon(handle as u64);
    }

    // ── Group actions ────────────────────────────────────────────────────────

    /// Founds a group; `members` is the concatenation of their 32-byte GossipIDs. Returns
    /// the group key.
    pub fn create_group(
        &mut self,
        name: String,
        members: &[u8],
        now: f64,
    ) -> Result<Vec<u8>, JsValue> {
        if !members.len().is_multiple_of(32) {
            return Err(JsValue::from_str("groups:invalid: members"));
        }
        let members = members
            .chunks(32)
            .map(peer)
            .collect::<Result<Vec<_>, _>>()?;
        let g = self
            .core
            .create_group(name, members, ms(now)?)
            .map_err(js)?;
        Ok(g.as_bytes().to_vec())
    }

    /// As `create_group`, for an automatic group of this device and the one other member
    /// (§5.12): `migrate_from = 0` both for a migration of an earlier conversation and for the
    /// chat founded after an accepted contact request; `undefined` for "New group". Returns
    /// the group kept: the peer's own creation, when it is held and its owner sorts first
    /// ("two creations at once").
    pub fn create_group_with(
        &mut self,
        name: String,
        members: &[u8],
        migrate_from: Option<f64>,
        now: f64,
    ) -> Result<Vec<u8>, JsValue> {
        if !members.len().is_multiple_of(32) {
            return Err(JsValue::from_str("groups:invalid: members"));
        }
        let members = members
            .chunks(32)
            .map(peer)
            .collect::<Result<Vec<_>, _>>()?;
        let migrate_from = migrate_from.map(ms).transpose()?;
        let g = self
            .core
            .create_group_with(name, members, migrate_from, ms(now)?)
            .map_err(js)?;
        Ok(g.as_bytes().to_vec())
    }

    /// Records (`held`) or clears that this device holds an earlier conversation of format
    /// `version` with `peer` (§5.12, condition 3): stored, until cleared.
    pub fn set_earlier_conversation(
        &mut self,
        peer_id: &[u8],
        version: f64,
        held: bool,
        now: f64,
    ) -> Result<(), JsValue> {
        self.core
            .set_earlier_conversation(peer(peer_id)?, ms(version)?, held, ms(now)?)
            .map_err(js)
    }

    /// The earlier conversations declared, in JSON: `[["<peer hex>", "<version>"], …]` (integers as decimal strings, as every view).
    pub fn earlier_conversations(&self) -> String {
        self.core.earlier_conversations()
    }

    /// Gives (`consent`) or withdraws the consent to the group of two `peer` creates after
    /// its contact request was accepted (§5.12): one-shot, for 14 days.
    pub fn consent_to_direct_chat(
        &mut self,
        peer_id: &[u8],
        consent: bool,
        now: f64,
    ) -> Result<(), JsValue> {
        self.core
            .consent_to_direct_chat(peer(peer_id)?, consent, ms(now)?)
            .map_err(js)
    }

    /// The consents not used yet, in JSON: `[["<peer hex>", "<expires at>"], …]`.
    pub fn direct_chat_consents(&self) -> String {
        self.core.direct_chat_consents()
    }

    /// Whether this device holds a direct chat with `peer` (an automatic group of the two,
    /// however it grew since): a later creation from it is then an ordinary invitation.
    pub fn holds_direct_chat(&self, peer_id: &[u8]) -> Result<bool, JsValue> {
        Ok(self.core.holds_direct_chat(peer(peer_id)?))
    }

    /// Whether `peer` is a member of a group this device holds and has accepted: a
    /// connection it asks for may be opened automatically (§5.12).
    pub fn is_co_member(&self, peer_id: &[u8]) -> Result<bool, JsValue> {
        Ok(self.core.is_co_member(peer(peer_id)?))
    }

    /// Among `candidates` (concatenated 32-byte GossipIDs), those whose automatic connection
    /// may be revoked: no group shared, no held epoch lists them (§5.12). Concatenated.
    pub fn connections_to_revoke(&self, candidates: &[u8]) -> Result<Vec<u8>, JsValue> {
        if !candidates.len().is_multiple_of(32) {
            return Err(JsValue::from_str("groups:invalid: candidates"));
        }
        let c = candidates
            .chunks(32)
            .map(peer)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(self
            .core
            .connections_to_revoke(&c)
            .iter()
            .flat_map(|p| p.as_bytes().to_vec())
            .collect())
    }

    /// The members of accepted groups with which no session is reported (`set_session`):
    /// the connections to open. Concatenated 32-byte GossipIDs.
    pub fn peers_wanting_connection(&self) -> Vec<u8> {
        self.core
            .peers_wanting_connection()
            .iter()
            .flat_map(|p| p.as_bytes().to_vec())
            .collect()
    }

    /// `change`: `{"t":"Successor","add":[hex],"remove":[hex],"name":null|string}`,
    /// `{"t":"Handover","new_owner":hex,"leave":bool,"name":…}` or
    /// `{"t":"Resolve","members":[hex],"name":…}`. Returns the new epoch.
    pub fn change_group(
        &mut self,
        group: &[u8],
        change: &str,
        now: f64,
    ) -> Result<Vec<u8>, JsValue> {
        let e = self
            .core
            .change_group(chat(group)?, change, ms(now)?)
            .map_err(js)?;
        Ok(e.as_bytes().to_vec())
    }

    pub fn dissolve_group(
        &mut self,
        group: &[u8],
        must_delete: bool,
        now: f64,
    ) -> Result<(), JsValue> {
        self.core
            .dissolve_group(chat(group)?, must_delete, ms(now)?)
            .map_err(js)
    }

    /// `choice`: `Signed`, `AskToBeKicked` or `Silent`.
    pub fn leave_group(&mut self, group: &[u8], choice: &str, now: f64) -> Result<(), JsValue> {
        self.core
            .leave_group(chat(group)?, choice, ms(now)?)
            .map_err(js)
    }

    pub fn delete_group(&mut self, group: &[u8], now: f64) -> Result<(), JsValue> {
        self.core.delete_group(chat(group)?, ms(now)?).map_err(js)
    }

    pub fn accept_invitation(&mut self, epoch: &[u8], now: f64) -> Result<Vec<u8>, JsValue> {
        let g = self
            .core
            .accept_invitation(chat(epoch)?, ms(now)?)
            .map_err(js)?;
        Ok(g.as_bytes().to_vec())
    }

    pub fn decline_invitation(
        &mut self,
        epoch: &[u8],
        choice: &str,
        now: f64,
    ) -> Result<(), JsValue> {
        self.core
            .decline_invitation(chat(epoch)?, choice, ms(now)?)
            .map_err(js)
    }

    pub fn resend_root(&mut self, group: &[u8], now: f64) -> Result<(), JsValue> {
        self.core.resend_root(chat(group)?, ms(now)?).map_err(js)
    }

    pub fn set_local_name(
        &mut self,
        group: &[u8],
        name: Option<String>,
        now: f64,
    ) -> Result<(), JsValue> {
        self.core
            .set_local_name(chat(group)?, name, ms(now)?)
            .map_err(js)
    }

    pub fn link_groups(
        &mut self,
        a: &[u8],
        b: &[u8],
        linked: bool,
        now: f64,
    ) -> Result<(), JsValue> {
        self.core
            .link_groups(chat(a)?, chat(b)?, linked, ms(now)?)
            .map_err(js)
    }

    pub fn scan_shared_chats(&mut self, peer_id: &[u8], now: f64) -> Result<(), JsValue> {
        self.core
            .scan_shared_chats(peer(peer_id)?, ms(now)?)
            .map_err(js)
    }

    // ── Messages ─────────────────────────────────────────────────────────────

    /// `body`: `{"t":"Text","text":…}`, `{"t":"Forward","content_type":"Text","content":hex}`,
    /// `{"t":"Reaction","reaction":hex}` or `{"t":"Media","media":hex}`; `metadata`: an array
    /// of `[name, hex]`. Returns `{eventId, syncObjId, merge}` in JSON.
    pub fn publish_message(
        &mut self,
        epoch: &[u8],
        body: &str,
        metadata: &str,
        scheduled_for: Option<f64>,
        now: f64,
    ) -> Result<String, JsValue> {
        let scheduled_for = scheduled_for.map(ms).transpose()?;
        self.core
            .publish_message(chat(epoch)?, body, metadata, scheduled_for, ms(now)?)
            .map_err(js)
    }

    /// An edit starts from the message's current metadata (§2.2: entries a client does not
    /// know, `replyTo` included, survive it). `metadata` is a patch: `[]` or `null` keeps
    /// everything, an array of `[name, hex]` sets those entries, and
    /// `{"set":[[name, hex], …],"remove":[name, …]}` also removes.
    pub fn publish_edit(
        &mut self,
        epoch: &[u8],
        sync_obj_id: &[u8],
        body: &str,
        metadata: &str,
        scheduled_for: Option<f64>,
        now: f64,
    ) -> Result<String, JsValue> {
        let scheduled_for = scheduled_for.map(ms).transpose()?;
        self.core
            .publish_edit(
                chat(epoch)?,
                sync(sync_obj_id)?,
                body,
                metadata,
                scheduled_for,
                ms(now)?,
            )
            .map_err(js)
    }

    pub fn publish_deletion(
        &mut self,
        epoch: &[u8],
        sync_obj_id: &[u8],
        scheduled_for: Option<f64>,
        now: f64,
    ) -> Result<String, JsValue> {
        let scheduled_for = scheduled_for.map(ms).transpose()?;
        self.core
            .publish_deletion(chat(epoch)?, sync(sync_obj_id)?, scheduled_for, ms(now)?)
            .map_err(js)
    }

    pub fn retry(&mut self, epoch: &[u8], sync_obj_id: &[u8], now: f64) -> Result<String, JsValue> {
        self.core
            .retry(chat(epoch)?, sync(sync_obj_id)?, ms(now)?)
            .map_err(js)
    }

    /// `edit`: `{"body":…|null,"author":hex|null,"created_at":…|null,
    /// "last_modified_at":…|null,"metadata":…|null,"edited":bool|null}`; `metadata` is a
    /// patch as for `publish_edit`, `null` keeping everything.
    pub fn local_edit(
        &mut self,
        epoch: &[u8],
        sync_obj_id: &[u8],
        edit: &str,
        now: f64,
    ) -> Result<String, JsValue> {
        self.core
            .local_edit(chat(epoch)?, sync(sync_obj_id)?, edit, ms(now)?)
            .map_err(js)
    }

    pub fn local_delete(
        &mut self,
        epoch: &[u8],
        sync_obj_id: &[u8],
        now: f64,
    ) -> Result<String, JsValue> {
        self.core
            .local_delete(chat(epoch)?, sync(sync_obj_id)?, ms(now)?)
            .map_err(js)
    }

    pub fn lookup_sync_object(
        &mut self,
        epoch: &[u8],
        sync_obj_id: &[u8],
        now: f64,
    ) -> Result<(), JsValue> {
        self.core
            .lookup_sync_object(chat(epoch)?, sync(sync_obj_id)?, ms(now)?)
            .map_err(js)
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    /// Every group, in JSON.
    pub fn groups(&self) -> String {
        self.core.groups()
    }

    /// One group by any of its epochs, in JSON (`null` when unknown).
    pub fn group(&self, epoch: &[u8]) -> Result<String, JsValue> {
        Ok(self.core.group(chat(epoch)?))
    }

    pub fn invitations(&self, now: f64) -> Result<String, JsValue> {
        Ok(self.core.invitations(ms(now)?))
    }

    pub fn timeline(&self, epoch: &[u8], now: f64) -> Result<String, JsValue> {
        self.core.timeline(chat(epoch)?, ms(now)?).map_err(js)
    }

    /// The changes since the last call, in JSON: `[{group, kind}]`.
    pub fn take_changes(&mut self, now: f64) -> Result<String, JsValue> {
        self.core.take_changes(ms(now)?).map_err(js)
    }

    /// The root of a held epoch in JSON: `{epoch, name, members, owner, created_at}`, or
    /// `null`.
    pub fn epoch(&self, epoch: &[u8]) -> Result<String, JsValue> {
        Ok(self.core.epoch(chat(epoch)?))
    }

    /// The reference (§4.5) of a held epoch, which reply targets name.
    pub fn ref_chat_id(&self, epoch: &[u8]) -> Result<Option<Vec<u8>>, JsValue> {
        Ok(self
            .core
            .ref_chat_id(chat(epoch)?)
            .map(|r| r.as_bytes().to_vec()))
    }

    /// The value of the metadata key `replyTo`: `targets` is
    /// `[{"ref_chat_id":hex,"sync_obj_id":hex}]`, 1 to 32 of them.
    pub fn encode_reply_to(&self, targets: &str) -> Result<Vec<u8>, JsValue> {
        self.core.encode_reply_to(targets).map_err(js)
    }

    /// The targets of a `replyTo` value, in the JSON form `encode_reply_to` takes.
    pub fn decode_reply_to(&self, value: &[u8]) -> Result<String, JsValue> {
        self.core.decode_reply_to(value).map_err(js)
    }

    /// The verified keys held for `id`, if any.
    pub fn keys(&self, id: &[u8]) -> Result<Option<Vec<u8>>, JsValue> {
        Ok(self.core.keys(peer(id)?))
    }
}

#[cfg(test)]
mod tests;
