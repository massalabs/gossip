//! Several identities exchanging group plaintexts through the bindings' Rust interface,
//! with every batch persisted into a model of the SDK's tables and every node reopened from
//! those tables.

use std::collections::BTreeMap;

use super::codec::{Codec, hex};
use super::engine::Core;
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
        let core = Core::open(public.clone(), secret, &BatchOut::default()).unwrap();
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

    /// Drops the engine and opens it again from the tables.
    fn reopen(&mut self) {
        self.persist();
        let (_, secret) = keys(&self.secret_seed);
        self.core = Core::open(self.public.clone(), secret, &self.db.snapshot()).unwrap();
        assert_eq!(self.core.report.orphans, 0);
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

    // Bob leaves with a signed leave: the group is closed on his device and erased from
    // his tables but for a closed-chat marker per end.
    net.peers[1]
        .core
        .leave_group(group, "Signed", net.now)
        .unwrap();
    net.peers[1].persist();
    net.settle(1_000);
    assert_eq!(net.peers[1].core.group(group), "null");
    // The request correlation references of the closed group's queries stay until they
    // expire, `sent_at + 1.05 × ttl + 5 min` (the engine does not drop them on close); the
    // change notices until taken.
    net.peers[1].core.take_changes(net.now).unwrap();
    net.now += 600_000;
    net.peers[1].core.tick(net.now).unwrap();
    net.peers[1].persist();
    assert!(net.peers[1].db.rows.is_empty());
    assert!(net.peers[1].db.edges.is_empty());
    assert!(net.peers[1].db.objects.is_empty());
    assert!(
        !net.peers[1].db.mentions(&hex(group.as_bytes())) || {
            // Only the closed-chat marker may name the group.
            net.peers[1].db.node.iter().all(|((k, key), f)| {
                !(key.contains(&hex(group.as_bytes())) || f.contains(&hex(group.as_bytes())))
                    || k == "markers"
            })
        }
    );
    let kinds: Vec<&str> = net.peers[1]
        .db
        .node
        .keys()
        .map(|(k, _)| k.as_str())
        .filter(|k| !matches!(*k, "keys" | "peers" | "meta"))
        .collect();
    assert!(kinds.iter().all(|k| *k == "markers"), "{kinds:?}");
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
