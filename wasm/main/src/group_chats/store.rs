//! The storage bridge: the engine reads a synchronous in-memory copy of its records, loaded
//! from the SDK's database when the node opens, and every committed batch is queued for the
//! SDK to persist in one database transaction.
//!
//! The SDK's database is asynchronous while the engine's storage traits are synchronous, so
//! the copy answers the reads and the database is written after each operation. The engine's
//! crash guarantee (a batch is durable before any plaintext it produced reaches the
//! transport) is kept by the bindings: a plaintext cannot be checked for encryption
//! ([`super::GroupsNode::is_current`]) while a batch is waiting to be persisted.

use std::collections::BTreeMap;

use groups::node::records::{Batch, NodeChanges, NodeRecords, NodeStorage};
use groups::store::{
    Changes, EventRow, MemoryStorage, ObjectRecord, PendingItem, Role, RowState, Storage,
    StorageError, StorageRead,
};
use groups::{ChatId, EventId, MessageEvent, Payload, Root, SyncObjId};
use serde::{Deserialize, Serialize};

use super::codec::{Codec, R};
use super::json::J;

/// An event row as stored: `state` is `held`, `pruned` or `marker` (a temporary rejection);
/// `fields` holds the role and the event's fields of a held row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowOut {
    pub chat_id: String,
    pub event_id: String,
    pub state: String,
    pub fields: Option<String>,
}

/// The key of an event row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowKey {
    pub chat_id: String,
    pub event_id: String,
}

/// The parent edges of a processed event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeOut {
    pub chat_id: String,
    pub event_id: String,
    pub parents: String,
}

/// The key of a current object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectKey {
    pub chat_id: String,
    pub sync_obj_id: String,
}

/// A current object: its fields, and whether the device may offer its events on its own
/// initiative, in a field of its own ([`ObjectRecord::shareable`], §14.1).
///
/// `shareable` has no default, on purpose: every write states it, and a snapshot without it
/// is refused. A forgotten value would make a quiet record shareable, and its deletion
/// could then be renewed between devices forever (§7.7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectOut {
    pub chat_id: String,
    pub sync_obj_id: String,
    pub fields: String,
    pub shareable: bool,
}

/// A node record: its table (`kind`), its key, and its fields; no fields deletes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeOut {
    pub kind: String,
    pub key: String,
    pub fields: Option<String>,
}

/// One engine batch, to apply in one transaction in this order: `rows` (upserts),
/// `removedRows`, `edges`, `removedEdges`, `objects`, `removedObjects`, `node` (upserts and
/// deletions), then `erase`: every row, edge and object of these epochs is deleted.
///
/// `removedRows`, `removedEdges` and `removedObjects` delete one record each: a
/// temporary-rejection marker, or what the message timer erases of a message (§7.7). A key
/// is never both written and deleted by one batch.
///
/// The same shape, without deletions, is the snapshot the node opens from.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOut {
    pub rows: Vec<RowOut>,
    #[serde(default)]
    pub removed_rows: Vec<RowKey>,
    pub edges: Vec<EdgeOut>,
    #[serde(default)]
    pub removed_edges: Vec<RowKey>,
    pub objects: Vec<ObjectOut>,
    #[serde(default)]
    pub removed_objects: Vec<ObjectKey>,
    pub node: Vec<NodeOut>,
    #[serde(default)]
    pub erase: Vec<String>,
}

/// Calls `$m!` with every table of the node records.
macro_rules! node_tables {
    ($m:ident) => {
        $m!(
            epochs,
            group_recs,
            signed,
            keys,
            markers,
            replies,
            unverified,
            held_roots,
            events,
            peers,
            groups,
            tasks,
            scans_out,
            scans_in,
            requests,
            hints,
            queue,
            meta,
            lookup_results,
            earlier,
            consents,
            consent_timers,
            announced_timers,
            backoff,
            contacts,
            ref_lookups
        )
    };
}

fn text<T: Codec>(v: &T) -> String {
    v.enc().to_text()
}

fn parse<T: Codec>(s: &str) -> R<T> {
    T::dec(&J::parse(s)?)
}

// ── Encoding ─────────────────────────────────────────────────────────────────

fn held_fields(event: &MessageEvent, role: &Role) -> String {
    J::Obj(vec![
        ("role".into(), role.enc()),
        ("version".into(), J::Num(event.version())),
        ("parents".into(), event.parents().to_vec().enc()),
        ("payload".into(), event.payload().enc()),
    ])
    .to_text()
}

fn encode_row(chat: &str, row: &EventRow) -> RowOut {
    let (state, fields) = match &row.state {
        RowState::Held { event, role } => ("held", Some(held_fields(event, role))),
        RowState::Pruned => ("pruned", None),
        RowState::TemporarilyInvalid => ("marker", None),
    };
    RowOut {
        chat_id: chat.to_owned(),
        event_id: text(&row.event_id),
        state: state.into(),
        fields,
    }
}

fn encode_changes(c: &Changes, out: &mut BatchOut) {
    let chat = text(&c.chat_id);
    for row in c.rows.values() {
        out.rows.push(encode_row(&chat, row));
    }
    for id in &c.removed_rows {
        out.removed_rows.push(RowKey {
            chat_id: chat.clone(),
            event_id: text(id),
        });
    }
    for (child, parents) in &c.edges {
        out.edges.push(EdgeOut {
            chat_id: chat.clone(),
            event_id: text(child),
            parents: text(parents),
        });
    }
    for id in &c.removed_edges {
        out.removed_edges.push(RowKey {
            chat_id: chat.clone(),
            event_id: text(id),
        });
    }
    for obj in c.objects.values() {
        out.objects.push(ObjectOut {
            chat_id: chat.clone(),
            sync_obj_id: text(&obj.sync_obj_id),
            fields: object_fields(obj),
            shareable: obj.shareable,
        });
    }
    for sync in &c.removed_objects {
        out.removed_objects.push(ObjectKey {
            chat_id: chat.clone(),
            sync_obj_id: text(sync),
        });
    }
}

fn object_fields(o: &ObjectRecord) -> String {
    J::Obj(vec![
        ("current".into(), o.current.enc()),
        ("currentEvents".into(), o.current_events.enc()),
        ("pendingVersions".into(), o.pending_versions.enc()),
        ("pendingDeletions".into(), o.pending_deletions.enc()),
        ("expiresAt".into(), o.expires_at.enc()),
        ("eraseAt".into(), o.erase_at.enc()),
        ("stubs".into(), o.stubs.enc()),
    ])
    .to_text()
}

fn encode_node(n: &NodeChanges, out: &mut BatchOut) {
    macro_rules! each {
        ($($t:ident),*) => {$(
            for (k, v) in &n.$t {
                out.node.push(NodeOut {
                    kind: stringify!($t).into(),
                    key: text(k),
                    fields: v.as_ref().map(text),
                });
            }
        )*};
    }
    node_tables!(each);
}

/// The stored form of a batch.
pub fn encode_batch(b: &Batch) -> BatchOut {
    let mut out = BatchOut::default();
    for c in &b.epochs {
        encode_changes(c, &mut out);
    }
    encode_node(&b.node, &mut out);
    out.erase = b.erase.iter().map(text).collect();
    out
}

/// The stored form of every record, as one batch of upserts.
pub fn encode_snapshot(store: &MemoryStorage) -> Result<BatchOut, StorageError> {
    let records = store.load_node()?;
    let mut node = NodeChanges::default();
    macro_rules! each {
        ($($t:ident),*) => {$(
            node.$t = records.$t.iter().map(|(k, v)| (k.clone(), Some(v.clone()))).collect();
        )*};
    }
    node_tables!(each);
    let mut out = BatchOut::default();
    for chat in records.epochs.keys() {
        let mut c = Changes::new(*chat);
        c.rows = store
            .event_rows(chat)?
            .into_iter()
            .map(|r| (r.event_id, r))
            .collect();
        c.edges = store.edges(chat)?.into_iter().collect();
        c.objects = store
            .objects(chat)?
            .into_iter()
            .map(|o| (o.sync_obj_id, o))
            .collect();
        encode_changes(&c, &mut out);
    }
    encode_node(&node, &mut out);
    Ok(out)
}

// ── Decoding ─────────────────────────────────────────────────────────────────

fn decode_node(nodes: &[NodeOut]) -> R<NodeRecords> {
    let mut r = NodeRecords::default();
    for n in nodes {
        let Some(fields) = &n.fields else {
            return Err(format!("a snapshot record of {} has no fields", n.kind));
        };
        macro_rules! each {
            ($($t:ident),*) => {
                match n.kind.as_str() {
                    $(stringify!($t) => {
                        r.$t.insert(
                            parse(&n.key).map_err(|e| format!("{} key: {e}", n.kind))?,
                            parse(fields).map_err(|e| format!("{} record: {e}", n.kind))?,
                        );
                    })*
                    other => return Err(format!("unknown record kind {other}")),
                }
            };
        }
        node_tables!(each);
    }
    Ok(r)
}

/// A row that needs no root: a pruned stub or a temporary-rejection marker.
fn decode_stub(row: &RowOut) -> R<EventRow> {
    let event_id: EventId = parse(&row.event_id)?;
    let state = match row.state.as_str() {
        "pruned" => RowState::Pruned,
        "marker" => RowState::TemporarilyInvalid,
        s => return Err(format!("bad row state {s}")),
    };
    Ok(EventRow { event_id, state })
}

fn decode_row(root: &Root, row: &RowOut) -> R<EventRow> {
    let event_id: EventId = parse(&row.event_id)?;
    let state = match (row.state.as_str(), &row.fields) {
        ("pruned", _) => RowState::Pruned,
        ("marker", _) => RowState::TemporarilyInvalid,
        ("held", Some(f)) => {
            let j = J::parse(f)?;
            let version = j.field("version")?.as_u64()?;
            if version != groups::constants::EVENT_VERSION {
                return Err(format!("unsupported stored event version {version}"));
            }
            let parents: Vec<EventId> = Codec::dec(j.field("parents")?)?;
            let payload: Payload = Codec::dec(j.field("payload")?)?;
            let event = MessageEvent::create(root, event_id, &parents, payload)
                .map_err(|e| e.to_string())?;
            RowState::Held {
                event,
                role: Codec::dec(j.field("role")?)?,
            }
        }
        (s, _) => return Err(format!("bad row state {s}")),
    };
    Ok(EventRow { event_id, state })
}

/// What opening from a snapshot found that it could not use.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct OpenReport {
    /// Retained event rows of an epoch without an epoch record (they cannot be rebuilt
    /// without its root): the engine never keeps them, so they are dropped.
    pub orphans: u32,
}

/// Loads a snapshot into a fresh in-memory store.
pub fn decode_snapshot(s: &BatchOut) -> R<(MemoryStorage, OpenReport)> {
    let records = decode_node(&s.node)?;
    let mut report = OpenReport::default();
    let mut epochs: BTreeMap<ChatId, Changes> = BTreeMap::new();
    fn entry(epochs: &mut BTreeMap<ChatId, Changes>, chat: ChatId) -> &mut Changes {
        epochs.entry(chat).or_insert_with(|| Changes::new(chat))
    }
    for row in &s.rows {
        let chat: ChatId = parse(&row.chat_id)?;
        // A held row is rebuilt against its epoch's root; the engine never keeps one
        // without it, so one found alone is what an interrupted erase left.
        let root = records.epochs.get(&chat).map(|r| &r.root);
        if row.state == "held" && root.is_none() {
            report.orphans += 1;
            continue;
        }
        let r = match root {
            Some(root) => decode_row(root, row),
            None => decode_stub(row),
        }
        .map_err(|e| format!("row {}: {e}", row.event_id))?;
        entry(&mut epochs, chat).rows.insert(r.event_id, r);
    }
    for e in &s.edges {
        let chat: ChatId = parse(&e.chat_id)?;
        entry(&mut epochs, chat)
            .edges
            .insert(parse(&e.event_id)?, parse(&e.parents)?);
    }
    for o in &s.objects {
        let chat: ChatId = parse(&o.chat_id)?;
        let sync_obj_id: SyncObjId = parse(&o.sync_obj_id)?;
        let j = J::parse(&o.fields)?;
        let obj = ObjectRecord {
            sync_obj_id,
            current: Codec::dec(j.field("current")?)?,
            current_events: Codec::dec(j.field("currentEvents")?)?,
            pending_versions: Codec::dec(j.field("pendingVersions")?)?,
            pending_deletions: Codec::dec(j.field("pendingDeletions")?)?,
            // The moment of the message timer (§7.7); absent from an object stored before
            // the timer existed, which had none.
            expires_at: match j.field("expiresAt") {
                Ok(v) => Codec::dec(v)?,
                Err(_) => None,
            },
            // When the timer erases the object, and the stubs it erases with it (§7.7);
            // absent from an object stored before the erasure existed, which the timer then
            // deletes and never erases, as it did.
            erase_at: match j.field("eraseAt") {
                Ok(v) => Codec::dec(v)?,
                Err(_) => None,
            },
            stubs: match j.field("stubs") {
                Ok(v) => Codec::dec(v)?,
                Err(_) => Default::default(),
            },
            // Stored in its own column, with no default (§14.1).
            shareable: o.shareable,
        };
        entry(&mut epochs, chat).objects.insert(sync_obj_id, obj);
    }
    let mut node = NodeChanges::default();
    macro_rules! each {
        ($($t:ident),*) => {$(
            node.$t = records.$t.into_iter().map(|(k, v)| (k, Some(v))).collect();
        )*};
    }
    node_tables!(each);
    let mut mem = MemoryStorage::default();
    mem.commit_batch(Batch {
        epochs: epochs.into_values().collect(),
        node,
        erase: Default::default(),
    })
    .map_err(|e| e.to_string())?;
    Ok((mem, report))
}

// ── The store the engine runs on ─────────────────────────────────────────────

/// The in-memory copy with the batches committed since the SDK last took them.
#[derive(Default)]
pub struct Store {
    pub mem: MemoryStorage,
    pub pending: Vec<Batch>,
}

impl StorageRead for Store {
    fn event_row(&self, c: &ChatId, e: &EventId) -> Result<Option<EventRow>, StorageError> {
        self.mem.event_row(c, e)
    }
    fn event_rows(&self, c: &ChatId) -> Result<Vec<EventRow>, StorageError> {
        self.mem.event_rows(c)
    }
    fn edges(&self, c: &ChatId) -> Result<Vec<(EventId, Vec<EventId>)>, StorageError> {
        self.mem.edges(c)
    }
    fn parents(&self, c: &ChatId, e: &EventId) -> Result<Option<Vec<EventId>>, StorageError> {
        self.mem.parents(c, e)
    }
    fn held_ids(&self, c: &ChatId) -> Result<Vec<EventId>, StorageError> {
        self.mem.held_ids(c)
    }
    fn carriers(&self, c: &ChatId, ts: u64, limit: usize) -> Result<Vec<EventRow>, StorageError> {
        self.mem.carriers(c, ts, limit)
    }
    fn markers(&self, c: &ChatId, limit: usize) -> Result<Vec<EventId>, StorageError> {
        self.mem.markers(c, limit)
    }
    fn object(&self, c: &ChatId, s: &SyncObjId) -> Result<Option<ObjectRecord>, StorageError> {
        self.mem.object(c, s)
    }
    fn objects(&self, c: &ChatId) -> Result<Vec<ObjectRecord>, StorageError> {
        self.mem.objects(c)
    }
    fn pending_until(&self, c: &ChatId, until: u64) -> Result<Vec<PendingItem>, StorageError> {
        self.mem.pending_until(c, until)
    }
    fn first_pending(&self, c: &ChatId) -> Result<Option<PendingItem>, StorageError> {
        self.mem.first_pending(c)
    }
    fn reactions_to(&self, c: &ChatId, t: &SyncObjId) -> Result<Vec<SyncObjId>, StorageError> {
        self.mem.reactions_to(c, t)
    }
}

impl Storage for Store {
    fn commit(&mut self, changes: Changes) -> Result<(), StorageError> {
        self.mem.commit(changes.clone())?;
        self.pending.push(Batch {
            epochs: vec![changes],
            ..Batch::default()
        });
        Ok(())
    }
}

impl NodeStorage for Store {
    fn load_node(&self) -> Result<NodeRecords, StorageError> {
        self.mem.load_node()
    }

    fn commit_batch(&mut self, batch: Batch) -> Result<(), StorageError> {
        if batch.is_empty() {
            return Ok(());
        }
        self.mem.commit_batch(batch.clone())?;
        self.pending.push(batch);
        Ok(())
    }
}
