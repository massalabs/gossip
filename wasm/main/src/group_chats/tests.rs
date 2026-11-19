//! Several identities exchanging group plaintexts through the bindings' Rust interface,
//! with every batch persisted into a model of the SDK's tables and every node reopened from
//! those tables.

use std::collections::{BTreeMap, BTreeSet};

use super::codec::{Codec, hex};
use super::engine::{Core, IdentityKey};
use super::json::J;
use super::store::BatchOut;
use groups::{ChatId, GossipId};

/// The SDK's tables, keyed as their primary keys.
#[derive(Default, Clone)]
struct Db {
    rows: BTreeMap<(String, String), (String, Option<String>)>,
    edges: BTreeMap<(String, String), String>,
    objects: BTreeMap<(String, String), String>,
    node: BTreeMap<(String, String), String>,
}

impl Db {
    fn apply(&mut self, b: &BatchOut) {
        for r in &b.rows {
            self.rows.insert(
                (r.chat_id.clone(), r.event_id.clone()),
                (r.state.clone(), r.fields.clone()),
            );
        }
        for k in &b.removed_rows {
            self.rows.remove(&(k.chat_id.clone(), k.event_id.clone()));
        }
        for e in &b.edges {
            self.edges
                .insert((e.chat_id.clone(), e.event_id.clone()), e.parents.clone());
        }
        for o in &b.objects {
            self.objects
                .insert((o.chat_id.clone(), o.sync_obj_id.clone()), o.fields.clone());
        }
        for c in &b.erase {
            self.rows.retain(|(chat, _), _| chat != c);
            self.edges.retain(|(chat, _), _| chat != c);
            self.objects.retain(|(chat, _), _| chat != c);
        }
        for n in &b.node {
            let k = (n.kind.clone(), n.key.clone());
            match &n.fields {
                Some(f) => {
                    self.node.insert(k, f.clone());
                }
                None => {
                    self.node.remove(&k);
                }
            }
        }
    }

    fn snapshot(&self) -> BatchOut {
        use super::store::{EdgeOut, NodeOut, ObjectOut, RowOut};
        BatchOut {
            rows: self
                .rows
                .iter()
                .map(|((c, e), (s, f))| RowOut {
                    chat_id: c.clone(),
                    event_id: e.clone(),
                    state: s.clone(),
                    fields: f.clone(),
                })
                .collect(),
            edges: self
                .edges
                .iter()
                .map(|((c, e), p)| EdgeOut {
                    chat_id: c.clone(),
                    event_id: e.clone(),
                    parents: p.clone(),
                })
                .collect(),
            objects: self
                .objects
                .iter()
                .map(|((c, s), f)| ObjectOut {
                    chat_id: c.clone(),
                    sync_obj_id: s.clone(),
                    fields: f.clone(),
                })
                .collect(),
            node: self
                .node
                .iter()
                .map(|((k, key), f)| NodeOut {
                    kind: k.clone(),
                    key: key.clone(),
                    fields: Some(f.clone()),
                })
                .collect(),
            ..BatchOut::default()
        }
    }

    /// Whether any stored text mentions `needle` (a hex identifier).
    fn mentions(&self, needle: &str) -> bool {
        self.rows.iter().any(|((c, e), (_, f))| {
            c.contains(needle)
                || e.contains(needle)
                || f.as_ref().is_some_and(|f| f.contains(needle))
        }) || self
            .edges
            .iter()
            .any(|((c, _), p)| c.contains(needle) || p.contains(needle))
            || self
                .objects
                .iter()
                .any(|((c, _), f)| c.contains(needle) || f.contains(needle))
            || self
                .node
                .iter()
                .any(|((_, k), f)| k.contains(needle) || f.contains(needle))
    }
}

/// A snapshot with its lists in key order, to compare two of them.
fn normalized(mut s: BatchOut) -> BatchOut {
    s.rows
        .sort_by(|a, b| (&a.chat_id, &a.event_id).cmp(&(&b.chat_id, &b.event_id)));
    s.edges
        .sort_by(|a, b| (&a.chat_id, &a.event_id).cmp(&(&b.chat_id, &b.event_id)));
    s.objects
        .sort_by(|a, b| (&a.chat_id, &a.sync_obj_id).cmp(&(&b.chat_id, &b.sync_obj_id)));
    s.node
        .sort_by(|a, b| (&a.kind, &a.key).cmp(&(&b.kind, &b.key)));
    s
}

struct Peer {
    core: Core,
    db: Db,
    public: auth::UserPublicKeys,
    secret_seed: String,
}

fn keys(seed: &str) -> (auth::UserPublicKeys, auth::UserSecretKeys) {
    let root = auth::StaticRootSecret::from_passphrase(seed.as_bytes());
    auth::derive_keys_from_static_root_secret(&root)
}

impl Peer {
    fn new(seed: &str) -> Self {
        let (public, secret) = keys(seed);
        let core = Core::open(
            IdentityKey::new(public.clone(), &secret),
            &BatchOut::default(),
        )
        .unwrap();
        Self {
            core,
            db: Db::default(),
            public,
            secret_seed: seed.into(),
        }
    }

    fn id(&self) -> GossipId {
        self.core.me()
    }

    fn persist(&mut self) {
        for b in self.core.take_batches().unwrap() {
            self.db.apply(&b);
        }
    }

    /// Drops the engine and opens it again from the tables: the tables hold exactly the
    /// engine's records, and the engine opened from them holds them again.
    fn reopen(&mut self) {
        self.persist();
        let tables = normalized(self.db.snapshot());
        assert_eq!(normalized(self.core.snapshot().unwrap()), tables);
        let (_, secret) = keys(&self.secret_seed);
        self.core = Core::open(
            IdentityKey::new(self.public.clone(), &secret),
            &self.db.snapshot(),
        )
        .unwrap();
        assert_eq!(self.core.report.orphans, 0);
        assert_eq!(normalized(self.core.snapshot().unwrap()), tables);
    }
}

struct Net {
    peers: Vec<Peer>,
    now: u64,
}

impl Net {
    fn new(n: usize) -> Self {
        let mut peers: Vec<Peer> = (0..n).map(|i| Peer::new(&format!("peer {i}"))).collect();
        let all: Vec<Vec<u8>> = peers.iter().map(|p| p.public.to_bytes()).collect();
        let now = 1_700_000_000_000;
        for p in &mut peers {
            for k in &all {
                let id = p.core.learn_keys(k, now).unwrap();
                if id != p.id() {
                    p.core.set_session(id, true);
                }
            }
            p.persist();
        }
        Self { peers, now }
    }

    fn index(&self, id: GossipId) -> usize {
        self.peers.iter().position(|p| p.id() == id).unwrap()
    }

    /// Delivers until nothing is left to send, advancing the clock by `step` each round.
    fn settle(&mut self, step: u64) {
        for _ in 0..200 {
            let mut sent = 0;
            for i in 0..self.peers.len() {
                let now = self.now;
                self.peers[i].core.tick(now).unwrap();
                self.peers[i].persist();
                let out = self.peers[i].core.poll_outbox(now).unwrap();
                self.peers[i].persist();
                for o in out {
                    assert!(self.peers[i].core.is_current(o.handle, now).unwrap());
                    self.peers[i].core.handed_off(o.handle, now).unwrap();
                    self.peers[i].persist();
                    let to = self.index(o.to);
                    let from = self.peers[i].id();
                    self.peers[to]
                        .core
                        .handle_plaintext(from, &o.plaintext, now)
                        .unwrap();
                    self.peers[to].persist();
                    self.peers[i].core.published(o.handle, now).unwrap();
                    self.peers[i].persist();
                    sent += 1;
                }
            }
            self.now += step;
            if sent == 0 {
                return;
            }
        }
        panic!("the network does not settle");
    }

    fn timeline_texts(&self, i: usize, group: ChatId) -> Vec<String> {
        let t = J::parse(&self.peers[i].core.timeline(group, self.now).unwrap()).unwrap();
        t.as_arr()
            .unwrap()
            .iter()
            .filter_map(|item| {
                let m = item.field("message").ok()?;
                let body = m.field("content").ok()?.field("body").ok()?;
                Some(body.field("text").ok()?.as_str().ok()?.to_owned())
            })
            .collect()
    }
}

fn group_json(p: &Peer, g: ChatId) -> J {
    J::parse(&p.core.group(g)).unwrap()
}

fn text(s: &str) -> String {
    format!(r#"{{"t":"Text","text":"{s}"}}"#)
}

#[test]
fn three_members_create_invite_message_edit_delete_remove_leave() {
    let mut net = Net::new(3);
    let (a, b, c) = (net.peers[0].id(), net.peers[1].id(), net.peers[2].id());
    let now = net.now;
    let group = net.peers[0]
        .core
        .create_group("Trip".into(), vec![b, c], now)
        .unwrap();
    net.peers[0].persist();
    net.settle(1_000);

    // Bob and Carol get the invitation and accept it.
    for i in [1, 2] {
        let inv = J::parse(&net.peers[i].core.invitations(net.now)).unwrap();
        let inv = inv.as_arr().unwrap();
        assert_eq!(inv.len(), 1, "peer {i}");
        let epoch: ChatId = Codec::dec(inv[0].field("chat_id").unwrap()).unwrap();
        assert_eq!(epoch, group);
        let g = net.peers[i].core.accept_invitation(epoch, net.now).unwrap();
        assert_eq!(g, group);
        net.peers[i].persist();
    }
    net.settle(1_000);

    // Alice writes, Bob answers.
    let p = net.peers[0]
        .core
        .publish_message(group, &text("hello"), "[]", None, net.now)
        .unwrap();
    let sync = J::parse(&p).unwrap().field("syncObjId").unwrap().clone();
    net.peers[0].persist();
    net.now += 10;
    net.peers[1]
        .core
        .publish_message(group, &text("hi alice"), "[]", None, net.now)
        .unwrap();
    net.peers[1].persist();
    net.settle(1_000);
    for i in 0..3 {
        assert_eq!(
            net.timeline_texts(i, group),
            vec!["hello", "hi alice"],
            "peer {i}"
        );
    }

    // Alice edits, then Bob deletes his message.
    let sync_a = Codec::dec(&sync).unwrap();
    net.peers[0]
        .core
        .publish_edit(group, sync_a, &text("hello all"), "[]", None, net.now)
        .unwrap();
    net.peers[0].persist();
    net.settle(1_000);
    let tl = J::parse(&net.peers[1].core.timeline(group, net.now).unwrap()).unwrap();
    let bob_msg = tl
        .as_arr()
        .unwrap()
        .iter()
        .filter_map(|i| i.field("message").ok())
        .find(|m| m.field("content").unwrap().field("author").unwrap() == &b.enc())
        .unwrap()
        .field("content")
        .unwrap()
        .field("sync_obj_id")
        .unwrap()
        .clone();
    net.peers[1]
        .core
        .publish_deletion(group, Codec::dec(&bob_msg).unwrap(), None, net.now)
        .unwrap();
    net.peers[1].persist();
    net.settle(1_000);
    for i in 0..3 {
        assert_eq!(net.timeline_texts(i, group), vec!["hello all"], "peer {i}");
    }

    // Every node reopens from its tables to the same state.
    for i in 0..3 {
        let before = (net.peers[i].core.groups(), net.timeline_texts(i, group));
        net.peers[i].reopen();
        for (j, k) in [a, b, c].iter().enumerate() {
            if j != i {
                net.peers[i].core.set_session(*k, true);
            }
        }
        assert_eq!(
            (net.peers[i].core.groups(), net.timeline_texts(i, group)),
            before
        );
    }

    // Alice removes Carol.
    let change = format!(
        r#"{{"t":"Successor","add":[],"remove":["{}"],"name":null}}"#,
        hex(c.as_bytes())
    );
    net.peers[0]
        .core
        .change_group(group, &change, net.now)
        .unwrap();
    net.peers[0].persist();
    net.settle(1_000);
    let members = |p: &Peer| group_json(p, group).field("members").unwrap().clone();
    assert_eq!(members(&net.peers[0]), vec![a, b].enc());
    assert_eq!(members(&net.peers[1]), vec![a, b].enc());
    assert_eq!(
        group_json(&net.peers[2], group).field("status").unwrap(),
        &J::Str("Removed".into())
    );

    // Every node reopens again, now holding kicks, removed states and later epochs.
    for i in 0..3 {
        net.peers[i].reopen();
    }

    // Bob leaves with a signed leave: the group is closed on his device and erased from
    // his tables but for a closed-chat marker per end.
    net.peers[1]
        .core
        .leave_group(group, "Signed", net.now)
        .unwrap();
    net.peers[1].persist();
    net.settle(1_000);
    assert_eq!(net.peers[1].core.group(group), "null");
    net.peers[1].core.take_changes(net.now).unwrap();
    net.peers[1].persist();
    // Bob shared no other group with anyone: nothing is left but the closed-chat
    // marker(s) and the engine's counter, without waiting for anything to expire.
    assert!(net.peers[1].db.rows.is_empty());
    assert!(net.peers[1].db.edges.is_empty());
    assert!(net.peers[1].db.objects.is_empty());
    // Bob's own keys are the one exception: the signer records them again at every
    // tick, and they are not about the group.
    let own = J::Str(hex(b.as_bytes())).to_text();
    let left: Vec<(String, String)> = net.peers[1]
        .db
        .node
        .keys()
        .filter(|(kind, key)| !(kind == "keys" && *key == own))
        .cloned()
        .collect();
    let kinds: BTreeSet<&str> = left.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(kinds, BTreeSet::from(["markers", "meta"]), "{left:?}");
    // Message content is gone from Bob's tables.
    assert!(!net.peers[1].db.mentions(&hex("hello all".as_bytes())));
    assert!(!net.peers[1].db.mentions("hello all"));
}

#[test]
fn a_plaintext_waits_for_its_batch() {
    let mut net = Net::new(2);
    let b = net.peers[1].id();
    let now = net.now;
    net.peers[0]
        .core
        .create_group("G".into(), vec![b], now)
        .unwrap();
    let out = net.peers[0].core.poll_outbox(now).unwrap();
    assert!(!out.is_empty());
    assert!(net.peers[0].core.is_current(out[0].handle, now).is_err());
    net.peers[0].persist();
    assert!(net.peers[0].core.is_current(out[0].handle, now).unwrap());
    assert!(net.peers[0].core.is_current_unchecked(out[0].handle, now));
}

#[test]
fn a_reply_names_the_reference_of_its_target_epoch() {
    let mut net = Net::new(2);
    let b = net.peers[1].id();
    let now = net.now;
    let group = net.peers[0]
        .core
        .create_group("G".into(), vec![b], now)
        .unwrap();
    let reference = net.peers[0].core.ref_chat_id(group).unwrap();
    assert_ne!(reference.as_bytes(), group.as_bytes());
    let targets = format!(
        r#"[{{"ref_chat_id":"{}","sync_obj_id":"{}"}}]"#,
        hex(reference.as_bytes()),
        hex(&[7; 32])
    );
    let value = net.peers[0].core.encode_reply_to(&targets).unwrap();
    assert_eq!(net.peers[0].core.decode_reply_to(&value).unwrap(), targets);
    assert!(net.peers[0].core.encode_reply_to("[]").is_err());
    assert!(net.peers[0].core.decode_reply_to(&[0xff]).is_err());
    assert!(net.peers[1].core.ref_chat_id(group).is_none());
    let e = J::parse(&net.peers[0].core.epoch(group)).unwrap();
    assert_eq!(e.field("name").unwrap(), &J::Str("G".into()));
    assert_eq!(e.field("members").unwrap().as_arr().unwrap().len(), 2);
    assert_eq!(net.peers[1].core.epoch(group), "null");
}

#[test]
fn messages_over_the_size_limits_are_refused_with_their_measure() {
    let mut net = Net::new(2);
    let b = net.peers[1].id();
    let now = net.now;
    let group = net.peers[0]
        .core
        .create_group("G".into(), vec![b], now)
        .unwrap();
    let max = groups::constants::MAX_TEXT_BYTES;
    let core = &mut net.peers[0].core;
    assert!(
        core.publish_message(group, &text(&"x".repeat(max)), "[]", None, now)
            .is_ok()
    );
    let e = core
        .publish_message(group, &text(&"x".repeat(max + 1)), "[]", None, now)
        .unwrap_err();
    assert!(e.starts_with("groups:change: text: at most 16384"), "{e}");
    // Metadata, measured as the engine counts it: one entry of a 1-byte key and an
    // n-byte value is 9 + n bytes here.
    let meta = |n: usize| format!(r#"[["m","{}"]]"#, "00".repeat(n));
    assert_eq!(
        super::engine::metadata_bytes(&meta(16_375)).unwrap(),
        16_384
    );
    assert_eq!(super::engine::metadata_bytes("[]").unwrap(), 0);
    assert!(super::engine::metadata_bytes("[1]").is_err());
    assert!(
        core.publish_message(group, &text("x"), &meta(16_375), None, now)
            .is_ok()
    );
    let e = core
        .publish_message(group, &text("x"), &meta(16_376), None, now)
        .unwrap_err();
    assert!(
        e.starts_with("groups:change: metadata: at most 16384"),
        "{e}"
    );
}

/// A store over the SQL-table model, as the SDK's database applies batches: reads decode
/// the tables, a commit applies the encoded batch, and a failure can be injected.
struct DbStore {
    db: Db,
    fail: bool,
}

impl DbStore {
    fn mem(&self) -> groups::store::MemoryStorage {
        super::store::decode_snapshot(&self.db.snapshot())
            .unwrap()
            .0
    }
}

mod db_store {
    use super::DbStore;
    use groups::node::records::{Batch, NodeRecords, NodeStorage};
    use groups::store::{
        Changes, EventRow, ObjectRecord, PendingItem, Storage, StorageError, StorageRead,
    };
    use groups::{ChatId, EventId, SyncObjId};

    type R<T> = Result<T, StorageError>;

    impl StorageRead for DbStore {
        fn event_row(&self, c: &ChatId, e: &EventId) -> R<Option<EventRow>> {
            self.mem().event_row(c, e)
        }
        fn event_rows(&self, c: &ChatId) -> R<Vec<EventRow>> {
            self.mem().event_rows(c)
        }
        fn edges(&self, c: &ChatId) -> R<Vec<(EventId, Vec<EventId>)>> {
            self.mem().edges(c)
        }
        fn parents(&self, c: &ChatId, e: &EventId) -> R<Option<Vec<EventId>>> {
            self.mem().parents(c, e)
        }
        fn held_ids(&self, c: &ChatId) -> R<Vec<EventId>> {
            self.mem().held_ids(c)
        }
        fn carriers(&self, c: &ChatId, ts: u64, limit: usize) -> R<Vec<EventRow>> {
            self.mem().carriers(c, ts, limit)
        }
        fn markers(&self, c: &ChatId, limit: usize) -> R<Vec<EventId>> {
            self.mem().markers(c, limit)
        }
        fn object(&self, c: &ChatId, s: &SyncObjId) -> R<Option<ObjectRecord>> {
            self.mem().object(c, s)
        }
        fn objects(&self, c: &ChatId) -> R<Vec<ObjectRecord>> {
            self.mem().objects(c)
        }
        fn pending_until(&self, c: &ChatId, until: u64) -> R<Vec<PendingItem>> {
            self.mem().pending_until(c, until)
        }
        fn first_pending(&self, c: &ChatId) -> R<Option<PendingItem>> {
            self.mem().first_pending(c)
        }
    }

    impl Storage for DbStore {
        fn commit(&mut self, changes: Changes) -> R<()> {
            self.commit_batch(Batch {
                epochs: vec![changes],
                ..Batch::default()
            })
        }
    }

    impl NodeStorage for DbStore {
        fn load_node(&self) -> R<NodeRecords> {
            self.mem().load_node()
        }
        fn commit_batch(&mut self, batch: Batch) -> R<()> {
            if self.fail {
                return Err(StorageError("injected".into()));
            }
            self.db.apply(&super::super::store::encode_batch(&batch));
            Ok(())
        }
    }
}

#[test]
fn the_table_model_passes_the_engine_conformance_check() {
    let mut store = DbStore {
        db: Db::default(),
        fail: false,
    };
    groups::node::conformance::check_batch_with_erase(&mut store, &mut |s, fail| s.fail = fail)
        .unwrap();
}

/// §5.12 through the bindings: two devices migrate their earlier conversation at once, the
/// declarations survive a reopen, both keep the group whose owner sorts first and the loser
/// is told; a consented contact's group is adopted without a prompt; the connection
/// queries answer from the groups held.
#[test]
fn crossing_migrations_consents_and_connections() {
    let mut net = Net::new(3);
    let ids: Vec<GossipId> = net.peers.iter().map(Peer::id).collect();
    let now = net.now;
    net.peers[0]
        .core
        .set_earlier_conversation(ids[1], 0, true, now)
        .unwrap();
    net.peers[1]
        .core
        .set_earlier_conversation(ids[0], 0, true, now)
        .unwrap();
    for p in &mut net.peers {
        p.reopen();
    }
    assert_eq!(
        net.peers[0].core.earlier_conversations(),
        format!(r#"[["{}","0"]]"#, hex(ids[1].as_bytes()))
    );
    let a = net.peers[0]
        .core
        .create_group_with("a".into(), vec![ids[1]], Some(0), now)
        .unwrap();
    let b = net.peers[1]
        .core
        .create_group_with("b".into(), vec![ids[0]], Some(0), now)
        .unwrap();
    for p in &mut net.peers {
        p.persist();
    }
    net.settle(1_000);
    let (keep, lose, loser) = if ids[0].as_bytes() < ids[1].as_bytes() {
        (a, b, 1)
    } else {
        (b, a, 0)
    };
    for i in 0..2 {
        net.peers[i].reopen();
        let groups = J::parse(&net.peers[i].core.groups()).unwrap();
        let groups = groups.as_arr().unwrap();
        // The replaced chat is kept, superseded by the one both keep.
        assert_eq!(groups.len(), 2, "peer {i}");
        for g in groups {
            let key = g.field("group").unwrap().as_str().unwrap();
            let status = g.field("status").unwrap();
            if key == hex(keep.as_bytes()) {
                assert_eq!(status.as_str().unwrap(), "Member", "peer {i}");
            } else {
                assert_eq!(key, hex(lose.as_bytes()), "peer {i}");
                assert_eq!(
                    status.field("by").unwrap().as_str().unwrap(),
                    hex(keep.as_bytes()),
                    "peer {i}"
                );
            }
        }
    }
    let changes = net.peers[loser].core.take_changes(net.now).unwrap();
    assert!(
        changes.contains(&format!(
            r#"{{"group":"{}","kind":{{"t":"Superseded","by":"{}","has_messages":false}}}}"#,
            hex(lose.as_bytes()),
            hex(keep.as_bytes())
        )),
        "{changes}"
    );
    assert!(changes.contains(r#""kind":"Connections""#), "{changes}");
    // Connections.
    assert!(net.peers[0].core.is_co_member(ids[1]));
    assert!(!net.peers[0].core.is_co_member(ids[2]));
    assert_eq!(net.peers[0].core.connections_to_revoke(&ids), vec![ids[2]]);
    // Sessions are in memory: none is reported after the reopen.
    assert_eq!(net.peers[0].core.peers_wanting_connection(), vec![ids[1]]);
    net.peers[0].core.set_session(ids[1], true);
    assert!(net.peers[0].core.peers_wanting_connection().is_empty());
    net.peers[0].core.set_session(ids[1], false);
    assert_eq!(net.peers[0].core.peers_wanting_connection(), vec![ids[1]]);
    net.peers[0].core.set_session(ids[1], true);
    // A consented contact: peer 2 accepted peer 0's request, peer 0 creates.
    let now = net.now;
    net.peers[2]
        .core
        .consent_to_direct_chat(ids[0], true, now)
        .unwrap();
    net.peers[2].reopen();
    assert!(
        net.peers[2]
            .core
            .direct_chat_consents()
            .contains(&hex(ids[0].as_bytes()))
    );
    let c = net.peers[0]
        .core
        .create_group_with("c".into(), vec![ids[2]], Some(0), now)
        .unwrap();
    net.peers[0].persist();
    net.settle(1_000);
    net.peers[2].reopen();
    assert_eq!(
        group_json(&net.peers[2], c)
            .field("group")
            .unwrap()
            .as_str()
            .unwrap(),
        hex(c.as_bytes())
    );
    assert_eq!(net.peers[2].core.invitations(net.now), "[]");
    assert_eq!(net.peers[2].core.direct_chat_consents(), "[]");
    assert!(net.peers[2].core.holds_direct_chat(ids[0]));
    assert!(!net.peers[2].core.holds_direct_chat(ids[1]));
}

/// Reactions and media through the bindings (§7.6): a reaction is listed on its target in the
/// timeline JSON and removed by a later version; a media message comes with its length and
/// its data is read on its own.
#[test]
fn reactions_and_media_through_the_bindings() {
    let mut net = Net::new(2);
    let b = net.peers[1].id();
    let now = net.now;
    let g = net.peers[0]
        .core
        .create_group("g".into(), vec![b], now)
        .unwrap();
    net.peers[0].persist();
    net.settle(1_000);
    let inv = J::parse(&net.peers[1].core.invitations(net.now)).unwrap();
    let epoch: ChatId = Codec::dec(inv.as_arr().unwrap()[0].field("chat_id").unwrap()).unwrap();
    net.peers[1].core.accept_invitation(epoch, net.now).unwrap();
    net.peers[1].persist();
    net.settle(1_000);
    let sync_of = |published: &str| -> groups::SyncObjId {
        Codec::dec(J::parse(published).unwrap().field("syncObjId").unwrap()).unwrap()
    };
    let now = net.now;
    let hello = net.peers[0]
        .core
        .publish_message(g, &text("hello"), "[]", None, now)
        .unwrap();
    let data = vec![7u8; 3_000];
    let media = net.peers[0]
        .core
        .publish_media(
            g,
            "image/png".into(),
            data.clone(),
            r#"[["name","00"]]"#,
            now,
        )
        .unwrap();
    net.peers[0].persist();
    net.settle(1_000);
    let now = net.now;
    net.peers[1]
        .core
        .publish_reaction(g, sync_of(&hello), "\u{1f44d}".into(), true, now)
        .unwrap();
    net.peers[1].persist();
    net.settle(1_000);
    let messages = |net: &Net, i: usize| -> Vec<J> {
        let t = J::parse(&net.peers[i].core.timeline(g, net.now).unwrap()).unwrap();
        t.as_arr()
            .unwrap()
            .iter()
            .filter_map(|item| item.field("message").ok().cloned())
            .collect()
    };
    for i in 0..2 {
        let m = messages(&net, i);
        assert_eq!(m.len(), 2, "peer {i}: a reaction is no message");
        let with = m
            .iter()
            .find(|m| {
                m.field("content")
                    .unwrap()
                    .field("body")
                    .unwrap()
                    .field("t")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    == "Text"
            })
            .unwrap();
        assert_eq!(
            with.field("reactions").unwrap().to_text(),
            format!("[[\"{}\",\"\u{1f44d}\"]]", hex(b.as_bytes()))
        );
        let pic = m
            .iter()
            .find(|m| m.field("data_len").unwrap() != &J::Null)
            .unwrap();
        // A JavaScript read: every integer as a decimal string.
        assert_eq!(pic.field("data_len").unwrap().as_str().unwrap(), "3000");
        let shown = pic
            .field("content")
            .unwrap()
            .field("body")
            .unwrap()
            .field("media")
            .unwrap();
        assert_eq!(
            shown.field("mimetype").unwrap().as_str().unwrap(),
            "image/png"
        );
        assert_eq!(shown.field("data").unwrap().as_str().unwrap(), "");
        assert_eq!(
            net.peers[i]
                .core
                .media(g, sync_of(&media), net.now)
                .unwrap(),
            Some(("image/png".to_owned(), data.clone()))
        );
    }
    // Removed by a later version.
    net.now += 1_000;
    let now = net.now;
    net.peers[1]
        .core
        .publish_reaction(g, sync_of(&hello), "\u{1f44d}".into(), false, now)
        .unwrap();
    net.peers[1].persist();
    net.settle(1_000);
    for i in 0..2 {
        assert!(
            messages(&net, i)
                .iter()
                .all(|m| m.field("reactions").unwrap().to_text() == "[]")
        );
    }
    // Refused with the engine's error: a mimetype with parameters, an empty emoji.
    let now = net.now;
    let e = net.peers[0]
        .core
        .publish_media(g, "image/png; q=1".into(), vec![], "[]", now)
        .unwrap_err();
    assert!(e.starts_with("groups:change:"), "{e}");
    let e = net.peers[0]
        .core
        .publish_reaction(g, sync_of(&hello), String::new(), true, now)
        .unwrap_err();
    assert!(e.starts_with("groups:change:"), "{e}");
}

/// §2.2 through the bindings: an edit keeps the metadata it does not patch, `[]` keeping
/// everything, and a patch may remove entries.
#[test]
fn an_edit_keeps_metadata_by_default() {
    let mut net = Net::new(2);
    let ids: Vec<GossipId> = net.peers.iter().map(Peer::id).collect();
    let now = net.now;
    let g = net.peers[0]
        .core
        .create_group("g".into(), vec![ids[1]], now)
        .unwrap();
    let published = net.peers[0]
        .core
        .publish_message(
            g,
            &text("hi"),
            r#"[["x.unknown","0102"],["k","03"]]"#,
            None,
            now,
        )
        .unwrap();
    let sync: groups::SyncObjId =
        Codec::dec(J::parse(&published).unwrap().field("syncObjId").unwrap()).unwrap();
    let metadata = |net: &Net| -> String {
        let t = J::parse(&net.peers[0].core.timeline(g, net.now + 60_000).unwrap()).unwrap();
        t.as_arr()
            .unwrap()
            .iter()
            .find_map(|i| {
                i.field("message").ok().map(|m| {
                    m.field("content")
                        .unwrap()
                        .field("metadata")
                        .unwrap()
                        .to_text()
                })
            })
            .unwrap()
    };
    net.peers[0]
        .core
        .publish_edit(g, sync, &text("edited"), "[]", None, now + 1)
        .unwrap();
    assert_eq!(metadata(&net), r#"[["k","03"],["x.unknown","0102"]]"#);
    net.peers[0]
        .core
        .publish_edit(
            g,
            sync,
            &text("again"),
            r#"{"remove":["k"]}"#,
            None,
            now + 2,
        )
        .unwrap();
    assert_eq!(metadata(&net), r#"[["x.unknown","0102"]]"#);
    net.peers[0]
        .core
        .local_edit(g, sync, r#"{"body":null,"author":null,"created_at":null,"last_modified_at":null,"metadata":null,"edited":null}"#, now + 3)
        .unwrap();
    assert_eq!(metadata(&net), r#"[["x.unknown","0102"]]"#);
}

/// Records the engine can no longer decode (stored by an earlier build) are refused with an
/// error the caller recognises, so that it can start the engine's tables again.
#[test]
fn records_that_no_longer_decode_are_refused_as_undecodable() {
    let mut net = Net::new(2);
    let b = net.peers[1].id();
    let g = net.peers[0]
        .core
        .create_group("x".into(), vec![b], net.now)
        .unwrap();
    assert_ne!(g, ChatId::from_bytes([0; 32]));
    net.peers[0].persist();
    let mut snapshot = net.peers[0].db.snapshot();
    let record = snapshot
        .node
        .iter_mut()
        .find(|n| n.kind == "group_recs")
        .expect("a group record");
    record.fields = Some(r#"{"status":"Active"}"#.into());
    let (public, secret) = keys("peer 0");
    let error = Core::open(IdentityKey::new(public, &secret), &snapshot)
        .err()
        .expect("refused");
    assert!(error.starts_with("groups:undecodable: "), "{error}");
}
