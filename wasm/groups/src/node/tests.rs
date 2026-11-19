//! Unit tests of the engine: one rule per test where possible (§10 to §13, §15, §17.4).

mod direct;
mod dissemination;
pub(crate) mod membership;
mod neighbors;
mod packing;
mod queries;
mod regressions;
mod retrieval;
mod scans;
mod storage;
mod timeline;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use super::records::NodeStorage;
use super::*;
use crate::event::{Body, Content};
use crate::ids::{Challenge, GroupSecret, RequestId, ScanId};
use crate::rng::TestRng;
use crate::root::RootParams;
use crate::store::{MemoryStorage, StorageRead};
use crate::test_support::{Identity, identity};
use crate::wire::{
    Entry, EntryItem, Frame, NeighborRequest, Notice, Query, QueryEntry, QueryOp, Response,
    ResponseResult, Status,
};

pub(crate) const T0: u64 = 1_700_000_000_000;
pub(crate) const MIN: u64 = 60_000;
pub(crate) const HOUR: u64 = 60 * MIN;
pub(crate) const DAY: u64 = 24 * HOUR;

fn owner() -> &'static Identity {
    static OWNER: OnceLock<Identity> = OnceLock::new();
    OWNER.get_or_init(|| identity(1))
}

/// The GossipID of member `i`: the owner's for 0, a synthetic one otherwise.
pub(crate) fn member(i: usize) -> GossipId {
    if i == 0 {
        owner().id
    } else {
        let mut b = [0u8; 32];
        b[0] = 0x40;
        b[1..9].copy_from_slice(&(i as u64).to_be_bytes());
        GossipId::from_bytes(b)
    }
}

/// An epoch of `n` members (owned by member 0), with secret seed `seed`.
pub(crate) fn epoch_root(n: usize, seed: u8) -> Root {
    let params = RootParams {
        name: "Group".to_owned(),
        members: (0..n).map(member).collect(),
        group_secret: GroupSecret::from_bytes([seed; 32]),
        owner: owner().public.clone(),
        epoch_challenge: Challenge::from_bytes([seed.wrapping_add(1); 32]),
        ref_chat_id_challenge: Challenge::from_bytes([seed.wrapping_add(2); 32]),
        created_at: T0,
    };
    Root::create_successor(
        params,
        &[ChatId::from_bytes([seed.wrapping_add(3); 32])],
        &owner().secret.dsa_signing_key,
        [0x5a; 32],
    )
    .expect("valid root")
}

pub(crate) fn config(root: &Root) -> EpochConfig {
    EpochConfig {
        root: root.clone(),
        accepted: true,
        group_state: GroupState::Active,
        removed: BTreeSet::new(),
    }
}

/// One device: its engine and its store.
pub(crate) struct Dev {
    pub node: Node,
    pub store: MemoryStorage,
}

/// A few devices of one epoch connected by hand: tests choose what is delivered.
pub(crate) struct Net {
    pub root: Root,
    pub devs: Vec<Dev>,
    pub rng: TestRng,
    pub now: u64,
}

/// A plaintext as decoded frames.
pub(crate) fn frames(plaintext: &[u8]) -> Vec<Frame> {
    let pt = wire::decode_plaintext(plaintext).expect("valid plaintext");
    pt.frames().map(|f| f.expect("valid frame")).collect()
}

impl Net {
    /// `n` members; devices run for the first `devices` of them (the others are driven by
    /// hand as peers).
    pub(crate) fn new(n: usize, devices: usize) -> Self {
        let root = epoch_root(n, 0x10);
        let mut rng = TestRng::new(7);
        let devs = (0..devices)
            .map(|i| {
                let mut store = MemoryStorage::new();
                let mut node = Node::open(&store, member(i)).unwrap();
                node.install_epoch(&mut store, config(&root), false, T0, &mut rng)
                    .unwrap();
                Dev { node, store }
            })
            .collect();
        Self {
            root,
            devs,
            rng,
            now: T0,
        }
    }

    pub(crate) fn chat(&self) -> ChatId {
        self.root.chat_id()
    }

    /// Device `d` handles a plaintext from `from`.
    pub(crate) fn recv(&mut self, d: usize, from: GossipId, plaintext: &[u8]) {
        let now = self.now;
        let dev = &mut self.devs[d];
        dev.node
            .handle_plaintext(&mut dev.store, from, plaintext, now, &mut self.rng)
            .unwrap();
    }

    /// Device `d` handles frames from `from`.
    pub(crate) fn recv_frames(&mut self, d: usize, from: GossipId, f: &[Frame]) {
        let pt = wire::encode_plaintext(f).unwrap();
        self.recv(d, from, &pt);
    }

    pub(crate) fn tick(&mut self, d: usize) {
        let now = self.now;
        let dev = &mut self.devs[d];
        dev.node.tick(&mut dev.store, now, &mut self.rng).unwrap();
    }

    /// Device `d` assembles and hands off everything it has; returns the plaintexts.
    pub(crate) fn poll(&mut self, d: usize) -> Vec<(GossipId, Vec<u8>)> {
        let now = self.now;
        let dev = &mut self.devs[d];
        let out = dev
            .node
            .poll_outbox(&mut dev.store, now, &mut self.rng)
            .unwrap();
        let mut sent = Vec::new();
        for o in out {
            assert!(o.plaintext.len() <= crate::constants::MAX_PLAINTEXT_BYTES);
            dev.node
                .handed_off(&mut dev.store, o.handle, now, &mut self.rng)
                .unwrap();
            dev.node
                .published(&mut dev.store, o.handle, now, &mut self.rng)
                .unwrap();
            sent.push((o.to, o.plaintext));
        }
        sent
    }

    /// The frames device `d` sends, by recipient.
    pub(crate) fn poll_frames(&mut self, d: usize) -> BTreeMap<GossipId, Vec<Frame>> {
        let mut out: BTreeMap<GossipId, Vec<Frame>> = BTreeMap::new();
        for (to, pt) in self.poll(d) {
            out.entry(to).or_default().extend(frames(&pt));
        }
        out
    }

    /// Delivers everything the devices send to each other, at the current time, until
    /// nothing is left. Plaintexts for members without a device are returned.
    pub(crate) fn exchange(&mut self) -> Vec<(GossipId, Vec<u8>)> {
        let mut outside = Vec::new();
        for _ in 0..50 {
            let mut any = false;
            for d in 0..self.devs.len() {
                let from = member(d);
                for (to, pt) in self.poll(d) {
                    any = true;
                    match (0..self.devs.len()).find(|i| member(*i) == to) {
                        Some(r) => self.recv(r, from, &pt),
                        None => outside.push((to, pt)),
                    }
                }
            }
            if !any {
                return outside;
            }
        }
        panic!("the devices never went quiet");
    }

    /// The sync-object lookup results of device `d`, taken.
    pub(crate) fn take_lookup_results(
        &mut self,
        d: usize,
    ) -> Vec<(ChatId, SyncObjId, LookupResult)> {
        let now = self.now;
        let dev = &mut self.devs[d];
        dev.node
            .take_lookup_results(&mut dev.store, now, &mut self.rng)
            .unwrap()
    }

    pub(crate) fn publish(&mut self, d: usize, text: &str) -> MessageEvent {
        let now = self.now;
        let chat = self.chat();
        let dev = &mut self.devs[d];
        dev.node
            .publish_message(
                &mut dev.store,
                chat,
                Body::Text(text.into()),
                BTreeMap::new(),
                None,
                now,
                &mut self.rng,
            )
            .unwrap()
            .event
    }

    pub(crate) fn held(&self, d: usize, id: &EventId) -> bool {
        self.devs[d]
            .store
            .event_row(&self.chat(), id)
            .unwrap()
            .is_some_and(|r| r.event().is_some())
    }

    pub(crate) fn known(&self, d: usize, id: &EventId) -> bool {
        self.devs[d]
            .store
            .event_row(&self.chat(), id)
            .unwrap()
            .is_some()
    }

    /// An event of this epoch created by hand, with `parents`.
    pub(crate) fn event(&self, ts: u64, r: u8, parents: &[EventId], author: usize) -> MessageEvent {
        MessageEvent::create(
            &self.root,
            EventId::new(ts, [r; 16]),
            parents,
            Payload::Content(Content {
                sync_obj_id: SyncObjId::from_bytes([r; 32]),
                author: member(author),
                created_at: ts,
                last_modified_at: ts,
                body: Body::Text(format!("m{r}")),
                edited: false,
                metadata: BTreeMap::new(),
            }),
        )
        .unwrap()
    }

    pub(crate) fn deletion(&self, ts: u64, r: u8, sync: u8) -> MessageEvent {
        MessageEvent::create(
            &self.root,
            EventId::new(ts, [r; 16]),
            &[],
            Payload::Delete {
                sync_obj_id: SyncObjId::from_bytes([sync; 32]),
                scheduled_at: None,
            },
        )
        .unwrap()
    }

    /// Device `d` receives `event` in an event frame from member `from`.
    pub(crate) fn give(&mut self, d: usize, from: usize, event: &MessageEvent) {
        let blob = blob(event);
        self.recv_frames(d, member(from), &[Frame::Event(blob)]);
    }
}

pub(crate) fn blob(event: &MessageEvent) -> Vec<u8> {
    wire::encode_event_blob(&EventObject::Message(event.clone())).unwrap()
}

pub(crate) fn notice(chat: ChatId, ids: &[EventId]) -> Frame {
    Frame::Notice(Notice {
        entries: ids
            .iter()
            .map(|id| Entry {
                chat_id: chat,
                item: EntryItem::Event(*id),
            })
            .collect(),
        skipped: 0,
    })
}

pub(crate) fn query(rid: u8, sent_at: u64, ttl: u64, ops: Vec<QueryOp>) -> Frame {
    Frame::Query(Query {
        request_id: RequestId::from_bytes([rid; 16]),
        sent_at,
        ttl,
        entries: ops.into_iter().map(QueryEntry::Op).collect(),
    })
}

/// The queries in `frames`, as `(request_id, sent_at, ttl, ops)`.
pub(crate) fn queries(frames: &[Frame]) -> Vec<(RequestId, u64, u64, Vec<QueryOp>)> {
    frames
        .iter()
        .filter_map(|f| match f {
            Frame::Query(q) => Some((
                q.request_id,
                q.sent_at,
                q.ttl,
                q.entries
                    .iter()
                    .map(|e| match e {
                        QueryEntry::Op(op) => op.clone(),
                        QueryEntry::Malformed(e) => panic!("malformed {e:?}"),
                    })
                    .collect(),
            )),
            _ => None,
        })
        .collect()
}

/// The responses in `frames`.
pub(crate) fn responses(frames: &[Frame]) -> Vec<Response> {
    frames
        .iter()
        .filter_map(|f| match f {
            Frame::Response(r) => Some(r.clone()),
            _ => None,
        })
        .collect()
}

/// The event IDs announced in `frames`.
pub(crate) fn announced(frames: &[Frame]) -> Vec<EventId> {
    frames
        .iter()
        .flat_map(|f| match f {
            Frame::Notice(n) => n
                .entries
                .iter()
                .filter_map(|e| match e.item {
                    EntryItem::Event(id) => Some(id),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        })
        .collect()
}

/// The event IDs sent in full in `frames` (event frames).
pub(crate) fn full_events(frames: &[Frame]) -> Vec<EventId> {
    frames
        .iter()
        .filter_map(|f| match f {
            Frame::Event(b) => match wire::decode_event_blob(b, 1) {
                Ok(EventObject::Message(e)) => Some(e.event_id()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// The event carried by an answer.
pub(crate) fn answer_event(r: &Response) -> Option<MessageEvent> {
    match &r.result {
        ResponseResult::Event(b) => match wire::decode_event_blob(b, 1) {
            Ok(EventObject::Message(e)) => Some(e),
            _ => None,
        },
        _ => None,
    }
}

pub(crate) fn status(r: &Response) -> Option<Status> {
    match r.result {
        ResponseResult::Status(s) => Some(s),
        _ => None,
    }
}

pub(crate) fn scan_id(n: u8) -> ScanId {
    ScanId::from_bytes([n; 32])
}

#[test]
fn a_message_reaches_every_device_through_the_protocol() {
    let mut net = Net::new(3, 3);
    // Neighbors form by requests and answers.
    for d in 0..3 {
        net.tick(d);
    }
    net.exchange();
    for d in 0..3 {
        assert_eq!(
            net.devs[d].node.neighbors(&net.chat()).len(),
            2,
            "device {d}"
        );
    }
    let e = net.publish(0, "hello");
    net.exchange();
    assert!(net.held(1, &e.event_id()) && net.held(2, &e.event_id()));
}
