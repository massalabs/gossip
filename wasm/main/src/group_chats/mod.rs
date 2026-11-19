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

use self::engine::{Core, id32};
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

/// The group engine of one identity.
#[wasm_bindgen]
pub struct GroupsNode {
    core: Core,
}

#[wasm_bindgen]
impl GroupsNode {
    /// Opens the engine of the identity from a snapshot of its stored records
    /// (`{rows, edges, objects, node}`, see `take_batches`; empty arrays for a new account).
    /// The secret keys are copied; the copy is erased when this object is freed.
    pub fn open(
        public_keys: &UserPublicKeys,
        secret_keys: &UserSecretKeys,
        snapshot: JsValue,
    ) -> Result<GroupsNode, JsValue> {
        let snapshot: BatchOut = serde_wasm_bindgen::from_value(snapshot)
            .map_err(|e| JsValue::from_str(&format!("groups:invalid: snapshot: {e}")))?;
        let config = bincode::config::standard();
        let bytes = bincode::serde::encode_to_vec(&secret_keys.inner, config)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let secret: auth::UserSecretKeys = bincode::serde::decode_from_slice(&bytes, config)
            .map_err(|e| JsValue::from_str(&e.to_string()))?
            .0;
        let mut bytes = bytes;
        for b in bytes.iter_mut() {
            // Volatile so that the copy of the key is cleared even though it is dropped next.
            unsafe { std::ptr::write_volatile(b, 0) };
        }
        let core = Core::open(public_keys.inner.clone(), secret, &snapshot).map_err(js)?;
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
        let b = self.core.take_batches();
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

    /// `change`: `{"t":"Successor","add":[hex],"remove":[hex],"name":null|string}`,
    /// `{"t":"Handover","new_owner":hex,"leave":bool,"remove":[hex],"name":…}` or
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
    /// "last_modified_at":…|null,"metadata":…|null,"edited":bool|null}`.
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

    /// The verified keys held for `id`, if any.
    pub fn keys(&self, id: &[u8]) -> Result<Option<Vec<u8>>, JsValue> {
        Ok(self.core.keys(peer(id)?))
    }
}

#[cfg(test)]
mod tests;
