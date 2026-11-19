//! The engine with its store and signer, behind a plain Rust interface that the wasm class
//! wraps (and that native tests drive).
//!
//! Inputs and outputs are bytes, `u64` milliseconds and JSON text in the encoding of
//! [`super::codec`]. Randomness comes from the app's generator ([`crypto_rng`]); time and
//! storage come from the caller.

use std::collections::BTreeMap;

use groups::node::{GroupChange, LeaveChoice, Node, NodeError, Outgoing};
use groups::{Body, ChatId, GossipId, KeySigner, LocalEdit, Published, SyncObjId};

use super::codec::{Codec, R, hex};
use super::json::J;
use super::store::{BatchOut, OpenReport, Store, decode_snapshot, encode_batch, encode_snapshot};

fn rng(dest: &mut [u8]) {
    crypto_rng::fill_buffer(dest);
}

fn err(e: NodeError) -> String {
    let code = match &e {
        NodeError::Storage(_) => "storage",
        NodeError::Change(_) => "change",
        NodeError::UnknownEpoch => "unknown-epoch",
        NodeError::UnknownHandle => "unknown-handle",
        NodeError::Root(_) => "invalid",
        NodeError::NotOwner => "not-owner",
        NodeError::NotAllowed => "not-allowed",
        NodeError::Fork => "fork",
        NodeError::UnknownKeys => "unknown-keys",
    };
    format!("groups:{code}: {e}")
}

pub fn id32<T: Codec>(bytes: &[u8]) -> R<T> {
    T::dec(&J::Str(hex(bytes)))
}

fn parse<T: Codec>(s: &str) -> R<T> {
    T::dec(&J::parse(s)?)
}

fn published(p: &Published) -> String {
    J::Obj(vec![
        ("eventId".into(), p.event.event_id().enc()),
        ("syncObjId".into(), p.event.payload().sync_obj_id().enc()),
        ("merge".into(), p.merge.enc()),
    ])
    .to_text()
}

/// The identity key as the engine's signer: it signs the 32-byte IDs of roots, kicks,
/// dissolve messages and leaves under their signing contexts (§4.1, §5.1).
fn signer<'a>(public: &auth::UserPublicKeys, secret: &'a auth::UserSecretKeys) -> KeySigner<'a> {
    KeySigner {
        public: public.clone(),
        signing_key: &secret.dsa_signing_key,
    }
}

/// The engine of one identity.
pub struct Core {
    node: Node,
    store: Store,
    public: auth::UserPublicKeys,
    secret: auth::UserSecretKeys,
    /// What opening found unusable.
    pub report: OpenReport,
}

impl Core {
    /// Opens the engine of the identity `public`/`secret` from a snapshot of its records.
    pub fn open(
        public: auth::UserPublicKeys,
        secret: auth::UserSecretKeys,
        snapshot: &BatchOut,
    ) -> R<Self> {
        let (mem, report) = decode_snapshot(snapshot)?;
        let store = Store {
            mem,
            pending: Vec::new(),
        };
        let me = GossipId::of_keys(&public);
        let node = Node::open(&store, me).map_err(err)?;
        Ok(Self {
            node,
            store,
            public,
            secret,
            report,
        })
    }

    pub fn me(&self) -> GossipId {
        self.node.me()
    }

    /// The batches committed since the last call, oldest first, to persist in that order.
    pub fn take_batches(&mut self) -> Vec<BatchOut> {
        self.store
            .pending
            .drain(..)
            .map(|b| encode_batch(&b))
            .collect()
    }

    /// The number of batches not taken yet.
    pub fn pending_batches(&self) -> usize {
        self.store.pending.len()
    }

    /// Every record, as one batch of upserts (to rebuild a database or for tests).
    pub fn snapshot(&self) -> R<BatchOut> {
        encode_snapshot(&self.store.mem).map_err(|e| e.to_string())
    }

    // ── Driving ──────────────────────────────────────────────────────────────

    pub fn learn_keys(&mut self, keys: &[u8], now: u64) -> R<GossipId> {
        self.node
            .learn_keys(&mut self.store, keys, now, &mut rng)
            .map_err(err)
    }

    pub fn set_session(&mut self, peer: GossipId, has_session: bool) {
        self.node.set_session(peer, has_session);
    }

    pub fn peer_reconnected(&mut self, peer: GossipId, now: u64) -> R<()> {
        self.node
            .peer_reconnected(&mut self.store, peer, now, &mut rng)
            .map_err(err)
    }

    pub fn handle_plaintext(&mut self, from: GossipId, bytes: &[u8], now: u64) -> R<()> {
        self.node
            .handle_plaintext(&mut self.store, from, bytes, now, &mut rng)
            .map_err(err)
    }

    /// Runs the timers; the signer lets the owner's device create the successors it owes
    /// (§5.5) and records its own keys.
    pub fn tick(&mut self, now: u64) -> R<()> {
        let signer = signer(&self.public, &self.secret);
        self.node
            .tick_with(&mut self.store, Some(&signer), now, &mut rng)
            .map_err(err)
    }

    pub fn next_wakeup(&self, now: u64) -> R<Option<u64>> {
        self.node.next_wakeup(&self.store, now).map_err(err)
    }

    pub fn poll_outbox(&mut self, now: u64) -> R<Vec<Outgoing>> {
        self.node
            .poll_outbox(&mut self.store, now, &mut rng)
            .map_err(err)
    }

    /// Whether the plaintext `handle` may be encrypted now. Refused while a batch waits to
    /// be persisted: what the plaintext carries must be durable before it leaves.
    pub fn is_current(&self, handle: u64, now: u64) -> R<bool> {
        if !self.store.pending.is_empty() {
            return Err("groups:unpersisted: persist the pending batches first".into());
        }
        Ok(self.node.is_current(handle, now))
    }

    pub fn handed_off(&mut self, handle: u64, now: u64) -> R<()> {
        self.node
            .handed_off(&mut self.store, handle, now, &mut rng)
            .map_err(err)
    }

    pub fn published(&mut self, handle: u64, now: u64) -> R<()> {
        self.node
            .published(&mut self.store, handle, now, &mut rng)
            .map_err(err)
    }

    pub fn abandon(&mut self, handle: u64) {
        self.node.abandon(handle);
    }

    // ── Group actions ────────────────────────────────────────────────────────

    pub fn create_group(&mut self, name: String, members: Vec<GossipId>, now: u64) -> R<ChatId> {
        let signer = signer(&self.public, &self.secret);
        self.node
            .create_group(&mut self.store, &signer, name, members, now, &mut rng)
            .map_err(err)
    }

    /// `change` is a [`GroupChange`] in JSON.
    pub fn change_group(&mut self, group: ChatId, change: &str, now: u64) -> R<ChatId> {
        let change: GroupChange = parse(change)?;
        let signer = signer(&self.public, &self.secret);
        self.node
            .change_group(&mut self.store, &signer, group, change, now, &mut rng)
            .map_err(err)
    }

    pub fn dissolve_group(&mut self, group: ChatId, must_delete: bool, now: u64) -> R<()> {
        let signer = signer(&self.public, &self.secret);
        self.node
            .dissolve_group(&mut self.store, &signer, group, must_delete, now, &mut rng)
            .map_err(err)
    }

    /// `choice` is a [`LeaveChoice`] name: `Signed`, `AskToBeKicked` or `Silent`.
    pub fn leave_group(&mut self, group: ChatId, choice: &str, now: u64) -> R<()> {
        let choice: LeaveChoice = Codec::dec(&J::Str(choice.into()))?;
        let signer = signer(&self.public, &self.secret);
        self.node
            .leave_group(&mut self.store, &signer, group, choice, now, &mut rng)
            .map_err(err)
    }

    pub fn delete_group(&mut self, group: ChatId, now: u64) -> R<()> {
        self.node
            .delete_group(&mut self.store, group, now, &mut rng)
            .map_err(err)
    }

    pub fn accept_invitation(&mut self, chat: ChatId, now: u64) -> R<ChatId> {
        self.node
            .accept_invitation(&mut self.store, chat, now, &mut rng)
            .map_err(err)
    }

    pub fn decline_invitation(&mut self, chat: ChatId, choice: &str, now: u64) -> R<()> {
        let choice: LeaveChoice = Codec::dec(&J::Str(choice.into()))?;
        let signer = signer(&self.public, &self.secret);
        self.node
            .decline_invitation(&mut self.store, &signer, chat, choice, now, &mut rng)
            .map_err(err)
    }

    pub fn resend_root(&mut self, group: ChatId, now: u64) -> R<()> {
        self.node
            .resend_root(&mut self.store, group, now, &mut rng)
            .map_err(err)
    }

    pub fn set_local_name(&mut self, group: ChatId, name: Option<String>, now: u64) -> R<()> {
        self.node
            .set_local_name(&mut self.store, group, name, now, &mut rng)
            .map_err(err)
    }

    pub fn link_groups(&mut self, a: ChatId, b: ChatId, linked: bool, now: u64) -> R<()> {
        self.node
            .link_groups(&mut self.store, a, b, linked, now, &mut rng)
            .map_err(err)
    }

    pub fn scan_shared_chats(&mut self, peer: GossipId, now: u64) -> R<()> {
        self.node
            .scan_shared_chats(&mut self.store, peer, now, &mut rng)
            .map_err(err)
    }

    // ── Messages ─────────────────────────────────────────────────────────────

    /// `body` is a [`Body`] and `metadata` a list of `[name, hex]` pairs, in JSON. Returns
    /// `{eventId, syncObjId, merge}`.
    pub fn publish_message(
        &mut self,
        chat: ChatId,
        body: &str,
        metadata: &str,
        scheduled_for: Option<u64>,
        now: u64,
    ) -> R<String> {
        let body: Body = parse(body)?;
        let metadata: BTreeMap<String, Vec<u8>> = parse(metadata)?;
        self.node
            .publish_message(
                &mut self.store,
                chat,
                body,
                metadata,
                scheduled_for,
                now,
                &mut rng,
            )
            .map(|p| published(&p))
            .map_err(err)
    }

    pub fn publish_edit(
        &mut self,
        chat: ChatId,
        sync_obj_id: SyncObjId,
        body: &str,
        metadata: &str,
        scheduled_for: Option<u64>,
        now: u64,
    ) -> R<String> {
        let body: Body = parse(body)?;
        let metadata: BTreeMap<String, Vec<u8>> = parse(metadata)?;
        self.node
            .publish_edit(
                &mut self.store,
                chat,
                sync_obj_id,
                body,
                metadata,
                scheduled_for,
                now,
                &mut rng,
            )
            .map(|p| published(&p))
            .map_err(err)
    }

    pub fn publish_deletion(
        &mut self,
        chat: ChatId,
        sync_obj_id: SyncObjId,
        scheduled_for: Option<u64>,
        now: u64,
    ) -> R<String> {
        self.node
            .publish_deletion(
                &mut self.store,
                chat,
                sync_obj_id,
                scheduled_for,
                now,
                &mut rng,
            )
            .map(|p| published(&p))
            .map_err(err)
    }

    pub fn retry(&mut self, chat: ChatId, sync_obj_id: SyncObjId, now: u64) -> R<String> {
        self.node
            .retry(&mut self.store, chat, sync_obj_id, now, &mut rng)
            .map(|p| published(&p))
            .map_err(err)
    }

    /// `edit` is a [`LocalEdit`] in JSON. Returns the pruned event IDs in JSON.
    pub fn local_edit(
        &mut self,
        chat: ChatId,
        sync_obj_id: SyncObjId,
        edit: &str,
        now: u64,
    ) -> R<String> {
        let edit: LocalEdit = parse(edit)?;
        self.node
            .local_edit(&mut self.store, chat, sync_obj_id, edit, now, &mut rng)
            .map(|p| p.enc().to_text())
            .map_err(err)
    }

    pub fn local_delete(&mut self, chat: ChatId, sync_obj_id: SyncObjId, now: u64) -> R<String> {
        self.node
            .local_delete(&mut self.store, chat, sync_obj_id, now, &mut rng)
            .map(|p| p.enc().to_text())
            .map_err(err)
    }

    pub fn lookup_sync_object(&mut self, chat: ChatId, sync_obj_id: SyncObjId, now: u64) -> R<()> {
        self.node
            .lookup_sync_object(&mut self.store, chat, sync_obj_id, now, &mut rng)
            .map_err(err)
    }

    // ── Reads, in JSON ───────────────────────────────────────────────────────

    pub fn groups(&self) -> String {
        self.node.groups().enc().to_text()
    }

    pub fn group(&self, chat: ChatId) -> String {
        self.node.group(&chat).enc().to_text()
    }

    pub fn invitations(&self, now: u64) -> String {
        self.node.invitations(now).enc().to_text()
    }

    pub fn timeline(&self, chat: ChatId, now: u64) -> R<String> {
        self.node
            .timeline(&self.store, &chat, now)
            .map(|t| t.enc().to_text())
            .map_err(err)
    }

    /// The changes since the last call (removing them is itself a committed operation).
    pub fn take_changes(&mut self, now: u64) -> R<String> {
        self.node
            .take_changes(&mut self.store, now, &mut rng)
            .map(|c| c.enc().to_text())
            .map_err(err)
    }

    /// The reference of a held epoch (§4.5), which replies name.
    pub fn ref_chat_id(&self, chat: ChatId) -> Option<groups::RefChatId> {
        self.node.root(&chat).map(|r| r.ref_chat_id())
    }

    /// The value of the metadata key `replyTo` for these targets, given as
    /// `[{ref_chat_id, sync_obj_id}]` in JSON (§7.6).
    pub fn encode_reply_to(&self, targets: &str) -> R<Vec<u8>> {
        let targets: Vec<groups::ReplyTarget> = parse(targets)?;
        groups::encode_reply_to(&targets).map_err(|e| format!("groups:invalid: {e}"))
    }

    /// The targets of a `replyTo` value, in JSON, or an error for an invalid value.
    pub fn decode_reply_to(&self, value: &[u8]) -> R<String> {
        groups::decode_reply_to(value)
            .map(|t| t.enc().to_text())
            .map_err(|e| format!("groups:invalid: {e}"))
    }

    /// The verified keys this device holds for `id`.
    pub fn keys(&self, id: GossipId) -> Option<Vec<u8>> {
        self.node.keys(&id)
    }

    #[cfg(test)]
    pub fn is_current_unchecked(&self, handle: u64, now: u64) -> bool {
        self.node.is_current(handle, now)
    }
}
