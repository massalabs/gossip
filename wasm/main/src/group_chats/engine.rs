//! The engine with its store and signer, behind a plain Rust interface that the wasm class
//! wraps (and that native tests drive).
//!
//! Inputs and outputs are bytes, `u64` milliseconds and JSON text in the encoding of
//! [`super::codec`]. Randomness comes from the app's generator ([`crypto_rng`]); time and
//! storage come from the caller.

use std::collections::BTreeMap;

use groups::node::{GroupChange, LeaveChoice, Node, NodeError, Outgoing};
use groups::{Body, ChatId, GossipId, IdentitySigner, LocalEdit, Published, Signer, SyncObjId};

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

/// The size of message metadata, given as a list of `[name, hex]` pairs in JSON, as the
/// engine counts it against [`groups::constants::MAX_METADATA_BYTES`].
pub fn metadata_bytes(metadata: &str) -> R<usize> {
    let metadata: BTreeMap<String, Vec<u8>> = parse(metadata)?;
    Ok(groups::wire::metadata_len(&metadata))
}

fn published(p: &Published) -> String {
    J::Obj(vec![
        ("eventId".into(), p.event.event_id().enc()),
        ("syncObjId".into(), p.event.payload().sync_obj_id().enc()),
        ("merge".into(), p.merge.enc()),
    ])
    .to_text()
}

/// What the engine signs with: the identity's ML-DSA signing key and its public keys,
/// nothing else of the secret keys. It signs the 32-byte IDs of roots, kicks, dissolve
/// messages and leaves under their signing contexts (§4.1, §5.1).
pub struct IdentityKey {
    public: auth::UserPublicKeys,
    key: Box<dyn Signer>,
}

/// A copy of a signing key, through its `From<[u8; N]>`: the bytes are copied on the
/// stack into the new key (whose type zeroizes on drop); no heap buffer is left behind.
fn copy_key<K: From<[u8; N]> + Signer + 'static, const N: usize>(
    _: &K,
    bytes: &[u8; N],
) -> Box<dyn Signer> {
    Box::new(K::from(*bytes))
}

impl IdentityKey {
    /// Copies the signing key out of the identity's secret keys.
    pub fn new(public: auth::UserPublicKeys, secret: &auth::UserSecretKeys) -> Self {
        let key = copy_key(&secret.dsa_signing_key, secret.dsa_signing_key.as_bytes());
        Self { public, key }
    }
}

impl Signer for IdentityKey {
    fn sign_id(
        &self,
        context: &'static str,
        id: &[u8; 32],
        randomness: [u8; 32],
    ) -> groups::SignatureBytes {
        self.key.sign_id(context, id, randomness)
    }
}

impl IdentitySigner for IdentityKey {
    fn public_keys(&self) -> &auth::UserPublicKeys {
        &self.public
    }
}

/// The engine of one identity.
pub struct Core {
    node: Node,
    store: Store,
    identity: IdentityKey,
    /// What opening found unusable.
    pub report: OpenReport,
}

impl Core {
    /// Opens the engine of the identity `public`/`secret` from a snapshot of its records.
    ///
    /// # Errors
    ///
    /// `groups:undecodable: …` when a stored record cannot be decoded (one written by an
    /// earlier build): the caller may start the engine's tables again.
    pub fn open(identity: IdentityKey, snapshot: &BatchOut) -> R<Self> {
        let (mem, report) =
            decode_snapshot(snapshot).map_err(|e| format!("groups:undecodable: {e}"))?;
        let store = Store {
            mem,
            pending: Vec::new(),
        };
        let me = GossipId::of_keys(identity.public_keys());
        let node = Node::open(&store, me).map_err(err)?;
        Ok(Self {
            node,
            store,
            identity,
            report,
        })
    }

    pub fn me(&self) -> GossipId {
        self.node.me()
    }

    /// The batches committed since the last call, oldest first, to persist in that order.
    ///
    /// # Errors
    ///
    /// A record that could not be encoded: the batches stay pending, and the caller
    /// reopens the engine from its database.
    pub fn take_batches(&mut self) -> R<Vec<BatchOut>> {
        Ok(self
            .store
            .pending
            .drain(..)
            .map(|b| encode_batch(&b))
            .collect())
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
        let signer = &self.identity;
        self.node
            .tick_with(&mut self.store, Some(signer), now, &mut rng)
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
        let signer = &self.identity;
        self.node
            .create_group(&mut self.store, signer, name, members, now, &mut rng)
            .map_err(err)
    }

    /// As [`Core::create_group`], continuing an earlier conversation of format `migrate_from`
    /// with the one other member (§5.12), with the message timer `message_timer` (§7.7).
    /// Returns the group kept, which is the peer's when its migration is held and its owner
    /// sorts first.
    pub fn create_group_with(
        &mut self,
        name: String,
        members: Vec<GossipId>,
        migrate_from: Option<u64>,
        message_timer: u64,
        now: u64,
    ) -> R<ChatId> {
        let signer = &self.identity;
        let _ = message_timer;
        let options = groups::node::GroupOptions {
            migrate_from,
            ..Default::default()
        };
        self.node
            .create_group_with(
                &mut self.store,
                signer,
                name,
                members,
                options,
                now,
                &mut rng,
            )
            .map_err(err)
    }

    pub fn set_earlier_conversation(
        &mut self,
        peer: GossipId,
        version: u64,
        held: bool,
        now: u64,
    ) -> R<()> {
        self.node
            .set_earlier_conversation(&mut self.store, peer, version, held, now, &mut rng)
            .map_err(err)
    }

    pub fn consent_to_direct_chat(&mut self, peer: GossipId, consent: bool, now: u64) -> R<()> {
        self.node
            .consent_to_direct_chat(&mut self.store, peer, consent, now, &mut rng)
            .map_err(err)
    }

    pub fn set_accepted_contact(&mut self, peer: GossipId, accepted: bool, now: u64) -> R<()> {
        self.node
            .set_accepted_contact(&mut self.store, peer, accepted, now, &mut rng)
            .map_err(err)
    }

    pub fn accepted_contacts(&self) -> String {
        self.node.accepted_contacts().enc().view_text()
    }

    pub fn holds_direct_chat(&self, peer: GossipId) -> bool {
        self.node.holds_direct_chat(&peer)
    }

    pub fn is_co_member(&self, peer: GossipId) -> bool {
        self.node.is_co_member(&peer)
    }

    pub fn connections_to_revoke(&self, candidates: &[GossipId]) -> Vec<GossipId> {
        self.node.connections_to_revoke(candidates)
    }

    pub fn peers_wanting_connection(&self) -> Vec<GossipId> {
        self.node.peers_wanting_connection()
    }

    /// `[[peer hex, version], …]`.
    pub fn earlier_conversations(&self) -> String {
        self.node.earlier_conversations().enc().view_text()
    }

    /// `[[peer hex, expires at], …]`.
    pub fn direct_chat_consents(&self) -> String {
        self.node.direct_chat_consents().enc().view_text()
    }

    /// `change` is a [`GroupChange`] in JSON.
    pub fn change_group(&mut self, group: ChatId, change: &str, now: u64) -> R<ChatId> {
        let change: GroupChange = parse(change)?;
        let signer = &self.identity;
        self.node
            .change_group(&mut self.store, signer, group, change, now, &mut rng)
            .map_err(err)
    }

    pub fn dissolve_group(&mut self, group: ChatId, must_delete: bool, now: u64) -> R<()> {
        let signer = &self.identity;
        self.node
            .dissolve_group(&mut self.store, signer, group, must_delete, now, &mut rng)
            .map_err(err)
    }

    /// `choice` is a [`LeaveChoice`] name: `Signed`, `AskToBeKicked` or `Silent`.
    pub fn leave_group(&mut self, group: ChatId, choice: &str, now: u64) -> R<()> {
        let choice: LeaveChoice = Codec::dec(&J::Str(choice.into()))?;
        let signer = &self.identity;
        self.node
            .leave_group(&mut self.store, signer, group, choice, now, &mut rng)
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
        let signer = &self.identity;
        self.node
            .decline_invitation(&mut self.store, signer, chat, choice, now, &mut rng)
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

    /// A media message of `data` (any bytes) and `mimetype` (`type/subtype`, §7.6), with
    /// `metadata` as for [`Self::publish_message`].
    pub fn publish_media(
        &mut self,
        chat: ChatId,
        mimetype: String,
        data: Vec<u8>,
        metadata: &str,
        now: u64,
    ) -> R<String> {
        let metadata: BTreeMap<String, Vec<u8>> = parse(metadata)?;
        self.node
            .publish_media(
                &mut self.store,
                chat,
                mimetype,
                data,
                metadata,
                now,
                &mut rng,
            )
            .map(|p| published(&p))
            .map_err(err)
    }

    /// Adds or removes this device's reaction `emoji` to the message `target` of the epoch
    /// `chat` (§7.6).
    pub fn publish_reaction(
        &mut self,
        chat: ChatId,
        target: SyncObjId,
        emoji: String,
        add: bool,
        now: u64,
    ) -> R<String> {
        self.node
            .publish_reaction(&mut self.store, chat, target, emoji, add, now, &mut rng)
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
        let metadata: groups::MetadataPatch = parse(metadata)?;
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
        self.node.groups().enc().view_text()
    }

    pub fn group(&self, chat: ChatId) -> String {
        self.node.group(&chat).enc().view_text()
    }

    pub fn invitations(&self, now: u64) -> String {
        self.node.invitations(now).enc().view_text()
    }

    pub fn timeline(&self, chat: ChatId, now: u64) -> R<String> {
        self.node
            .timeline(&self.store, &chat, now)
            .map(|t| t.enc().view_text())
            .map_err(err)
    }

    /// The media message `sync_obj_id` of the epoch `chat` with its data, which the timeline
    /// leaves out: `(mimetype, data)`, or `None` when the message is not visible or holds no
    /// media.
    pub fn media(
        &self,
        chat: ChatId,
        sync_obj_id: SyncObjId,
        now: u64,
    ) -> R<Option<(String, Vec<u8>)>> {
        self.node
            .media(&self.store, &chat, &sync_obj_id, now)
            .map(|m| m.map(|m| (m.mimetype, m.data)))
            .map_err(err)
    }

    /// The changes since the last call (removing them is itself a committed operation).
    pub fn take_changes(&mut self, now: u64) -> R<String> {
        self.node
            .take_changes(&mut self.store, now, &mut rng)
            .map(|c| c.enc().view_text())
            .map_err(err)
    }

    /// What the root of a held epoch says, in JSON: `{epoch, name, members, owner,
    /// created_at, migrate_from}`, or `null`. The resolution of competing ends shows each end's list
    /// (§4.9).
    pub fn epoch(&self, chat: ChatId) -> String {
        match self.node.root(&chat) {
            Some(r) => J::Obj(vec![
                ("epoch".into(), chat.enc()),
                ("name".into(), J::Str(r.name().to_owned())),
                ("members".into(), r.members().to_vec().enc()),
                ("owner".into(), r.owner_id().enc()),
                ("created_at".into(), J::Num(r.created_at())),
                ("migrate_from".into(), r.migrate_from().enc()),
            ])
            .view_text(),
            None => "null".into(),
        }
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
