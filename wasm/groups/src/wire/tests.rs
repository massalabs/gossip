use std::collections::BTreeMap;

use prost::Message;

use super::*;
use crate::event::{Body, Content, Payload};
use crate::ids::{ChatId, EventId, GossipId, RequestId, ScanId, SyncObjId};
use crate::root::tests::founding;
use crate::test_support::identity;

const TS: u64 = 1_700_000_000_000;

fn plaintext_of(frames: Vec<Vec<u8>>) -> Vec<u8> {
    let mut out = vec![0x01];
    proto::Container { frames }.encode(&mut out).unwrap();
    out
}

fn frame_bytes(kind: proto::FrameKind) -> Vec<u8> {
    proto::Frame { kind: Some(kind) }.encode_to_vec()
}

/// The frames of a plaintext, decoded.
fn frames_of(plaintext: &[u8]) -> Vec<Result<Frame>> {
    decode_plaintext(plaintext).unwrap().frames().collect()
}

fn one_frame(bytes: Vec<u8>) -> Result<Frame> {
    let mut frames = frames_of(&plaintext_of(vec![bytes]));
    assert_eq!(frames.len(), 1);
    frames.remove(0)
}

// ── Plaintext and container ──────────────────────────────────────────────────

#[test]
fn plaintext_prefix_and_size() {
    assert_eq!(decode_plaintext(&[]), Err(Error::InvalidVersionPrefix));
    assert_eq!(
        decode_plaintext(&[0x02]),
        Err(Error::UnsupportedHigherVersion(2))
    );
    assert_eq!(
        decode_plaintext(&[0x00]),
        Err(Error::UnsupportedLowerVersion(0))
    );
    assert!(frames_of(&[0x01]).is_empty());
    let mut big = vec![0x01];
    big.resize(MAX_PLAINTEXT_BYTES + 1, 0);
    assert_eq!(
        decode_plaintext(&big),
        Err(Error::PlaintextTooLarge(MAX_PLAINTEXT_BYTES + 1))
    );
}

#[test]
fn version_notice_shape() {
    let notice = version_notice();
    let p = decode_plaintext(&notice).unwrap();
    assert_eq!(p.version, PROTOCOL_VERSION);
    let Some(Ok(Frame::Response(r))) = &p.frames().next() else {
        panic!()
    };
    assert!(r.is_version_notice());
    assert_eq!(r.idx, 0);
    assert_eq!(r.result, ResponseResult::Status(Status::Unsupported));
    // An empty request_id in any other response is malformed.
    let other = frame_bytes(proto::FrameKind::Response(proto::Response {
        request_id: vec![],
        idx: 0,
        result: Some(proto::ResponseResult::Status(proto::Status::Busy as i32)),
    }));
    assert!(matches!(one_frame(other), Err(Error::BadLength { .. })));
    assert!(
        encode_plaintext(&[Frame::Response(Response {
            request_id: None,
            idx: 1,
            result: ResponseResult::Status(Status::Unsupported),
        })])
        .is_err()
    );
}

#[test]
fn container_errors_reject_everything_frame_errors_only_the_frame() {
    let good = frame_bytes(proto::FrameKind::LeaveRequest(proto::LeaveRequest {
        chat_id: vec![1; 32],
    }));
    // Unknown field in the Container.
    let mut bytes = plaintext_of(vec![good.clone()]);
    bytes.extend_from_slice(&[0x10, 0x01]);
    assert_eq!(
        decode_plaintext(&bytes),
        Err(Error::Malformed("unknown field"))
    );
    // Truncated container.
    let bytes = plaintext_of(vec![good.clone()]);
    assert!(decode_plaintext(&bytes[..bytes.len() - 1]).is_err());

    // A bad frame between good ones.
    let unknown_kind = vec![0x42, 0x00]; // field 8
    let bytes = plaintext_of(vec![good.clone(), unknown_kind, vec![], good]);
    let frames = frames_of(&bytes);
    assert!(frames[0].is_ok());
    assert_eq!(frames[1], Err(Error::Malformed("unknown field")));
    assert_eq!(frames[2], Err(Error::Missing("frame kind")));
    assert!(frames[3].is_ok());
}

#[test]
fn encode_limits() {
    let huge = Frame::Event(vec![0; MAX_PLAINTEXT_BYTES]);
    assert_eq!(encode_plaintext(&[huge]), Err(Error::DoesNotFitContainer));
    let half = Frame::Event(vec![0; MAX_PLAINTEXT_BYTES / 2]);
    assert!(encode_plaintext(std::slice::from_ref(&half)).is_ok());
    assert!(matches!(
        encode_plaintext(&[half.clone(), half]),
        Err(Error::PlaintextTooLarge(_))
    ));
}

// ── Queries ──────────────────────────────────────────────────────────────────

fn all_ops() -> Vec<QueryOp> {
    let c = ChatId::from_bytes([1; 32]);
    let s = ScanId::from_bytes([2; 32]);
    let g = GossipId::from_bytes([3; 32]);
    vec![
        QueryOp::ChatById(c),
        QueryOp::ChatByRef(crate::RefChatId::from_bytes([4; 32])),
        QueryOp::ChatByParent {
            chat_id: c,
            commitment: crate::ParentCommitment::from_bytes([5; 32]),
        },
        QueryOp::SharedChatsScan {
            scan_id: s,
            offset: 7,
        },
        QueryOp::Event {
            chat_id: c,
            event_id: EventId::new(TS, [6; 16]),
        },
        QueryOp::SyncObj {
            chat_id: c,
            sync_obj_id: SyncObjId::from_bytes([7; 32]),
        },
        QueryOp::SignedObject {
            chat_id: c,
            kind: SignedKind::Kick,
            id: [8; 32],
        },
        QueryOp::Removal {
            chat_id: c,
            gossip_id: g,
        },
        QueryOp::TipsScan {
            anchor: c,
            scan_id: s,
            offset: 0,
        },
        QueryOp::Keys {
            chat_id: c,
            gossip_id: g,
        },
    ]
}

fn query(entries: Vec<QueryEntry>) -> Frame {
    Frame::Query(Query {
        request_id: RequestId::from_bytes([9; 16]),
        sent_at: TS,
        ttl: 60_000,
        entries,
    })
}

#[test]
fn queries_round_trip() {
    let frame = query(all_ops().into_iter().map(QueryEntry::Op).collect());
    let bytes = encode_plaintext(std::slice::from_ref(&frame)).unwrap();
    assert_eq!(frames_of(&bytes), vec![Ok(frame)]);
}

fn raw_query(entries: Vec<Vec<u8>>, request_id: Vec<u8>) -> Vec<u8> {
    frame_bytes(proto::FrameKind::Query(proto::Query {
        request_id,
        sent_at: TS,
        ttl: 1,
        entries,
    }))
}

#[test]
fn bad_query_entries_are_isolated() {
    let good = all_ops()[0].encode();
    let mut unknown_inside = good.clone();
    unknown_inside.extend_from_slice(&[0x48, 0x00]); // field 9 of QueryEntry
    let bad_length = QueryOp::Event {
        chat_id: ChatId::from_bytes([1; 32]),
        event_id: EventId::new(1, [0; 16]),
    }
    .encode();
    // Shorten the event ID from 24 to 23 bytes by rewriting the entry by hand.
    let short = proto::QueryEntry {
        op: Some(proto::QueryOp::EventLookup(proto::EventLookup {
            chat_id: vec![1; 32],
            event_id: vec![0; 23],
        })),
    }
    .encode_to_vec();
    let event_kind_lookup = proto::QueryEntry {
        op: Some(proto::QueryOp::ObjectLookup(proto::ObjectLookup {
            chat_id: vec![1; 32],
            kind: proto::ObjectKind::Root as i32,
            id: vec![0; 32],
        })),
    }
    .encode_to_vec();
    let no_op = vec![];
    let no_key = proto::QueryEntry {
        op: Some(proto::QueryOp::ChatLookup(proto::ChatLookup { by: None })),
    }
    .encode_to_vec();
    let not_protobuf = vec![0xff];
    let bytes = raw_query(
        vec![
            good.clone(),
            unknown_inside,
            short,
            event_kind_lookup,
            no_op,
            no_key,
            not_protobuf,
            bad_length,
        ],
        vec![9; 16],
    );
    let Ok(Frame::Query(q)) = one_frame(bytes) else {
        panic!()
    };
    assert_eq!(q.entries.len(), 8);
    assert_eq!(q.entries[0], QueryEntry::Op(all_ops()[0].clone()));
    assert_eq!(
        q.entries[1],
        QueryEntry::Malformed(Error::Malformed("unknown field"))
    );
    assert!(matches!(
        q.entries[2],
        QueryEntry::Malformed(Error::BadLength { .. })
    ));
    assert_eq!(
        q.entries[3],
        QueryEntry::Malformed(Error::NotAllowed("object lookup kind"))
    );
    assert_eq!(
        q.entries[4],
        QueryEntry::Malformed(Error::Missing("query operation"))
    );
    assert_eq!(
        q.entries[5],
        QueryEntry::Malformed(Error::Missing("chat lookup key"))
    );
    assert!(matches!(q.entries[6], QueryEntry::Malformed(_)));
    assert!(matches!(q.entries[7], QueryEntry::Op(_)));
    // A malformed entry is never sent.
    assert!(encode_plaintext(&[query(vec![QueryEntry::Malformed(Error::Missing("x"))])]).is_err());
}

#[test]
fn query_level_errors_reject_the_frame() {
    let good = all_ops()[0].encode();
    assert!(matches!(
        one_frame(raw_query(vec![good.clone()], vec![9; 15])),
        Err(Error::BadLength { .. })
    ));
    assert!(one_frame(raw_query(vec![good.clone(); 16], vec![9; 16])).is_ok());
    assert!(matches!(
        one_frame(raw_query(vec![good.clone(); 17], vec![9; 16])),
        Err(Error::TooMany {
            field: "query entries",
            ..
        })
    ));
    let mut bytes = proto::Query {
        request_id: vec![9; 16],
        sent_at: 0,
        ttl: 0,
        entries: vec![good.clone()],
    }
    .encode_to_vec();
    bytes.extend_from_slice(&[0x28, 0x00]); // field 5 of Query
    let mut frame = vec![0x12];
    prost::encoding::encode_varint(bytes.len() as u64, &mut frame);
    frame.extend_from_slice(&bytes);
    assert_eq!(one_frame(frame), Err(Error::Malformed("unknown field")));
    assert!(matches!(
        encode_plaintext(&[query(vec![QueryEntry::Op(all_ops()[0].clone()); 17])]),
        Err(Error::TooMany { .. })
    ));
}

// ── Responses, pages and notices ─────────────────────────────────────────────

fn entry(i: u8) -> Entry {
    Entry {
        chat_id: ChatId::from_bytes([i; 32]),
        item: EntryItem::Event(EventId::new(u64::from(i), [i; 16])),
    }
}

fn response(result: ResponseResult) -> Frame {
    Frame::Response(Response {
        request_id: Some(RequestId::from_bytes([1; 16])),
        idx: 2,
        result,
    })
}

#[test]
fn responses_round_trip() {
    let entries = vec![
        entry(1),
        Entry {
            chat_id: ChatId::from_bytes([2; 32]),
            item: EntryItem::Root,
        },
        Entry {
            chat_id: ChatId::from_bytes([3; 32]),
            item: EntryItem::Leave(crate::LeaveId::from_bytes([4; 32])),
        },
        Entry {
            chat_id: ChatId::from_bytes([3; 32]),
            item: EntryItem::Kick(crate::KickId::from_bytes([5; 32])),
        },
        Entry {
            chat_id: ChatId::from_bytes([3; 32]),
            item: EntryItem::Dissolve(crate::DissolveId::from_bytes([6; 32])),
        },
    ];
    let page = Page {
        scan_id: ScanId::from_bytes([7; 32]),
        offset: 10,
        count: 5,
        entries: entries.clone(),
    };
    assert!(page.is_final());
    let frames = vec![
        response(ResponseResult::Page(page)),
        response(ResponseResult::Status(Status::NotAvailable)),
        response(ResponseResult::Status(Status::Restart)),
        response(ResponseResult::Status(Status::Expired)),
        response(ResponseResult::Status(Status::Malformed)),
        response(ResponseResult::Status(Status::Busy)),
        response(ResponseResult::Keys(identity(1).public.to_bytes())),
        Frame::Notice(Notice { entries }),
    ];
    let bytes = encode_plaintext(&frames).unwrap();
    let decoded: Vec<Frame> = frames_of(&bytes).into_iter().map(|f| f.unwrap()).collect();
    assert_eq!(decoded, frames);
    let Frame::Response(Response {
        result: ResponseResult::Keys(k),
        ..
    }) = &decoded[6]
    else {
        panic!()
    };
    assert!(crate::check_key_answer(k, &identity(1).id).is_ok());
}

#[test]
fn response_rules() {
    let raw = |result: Option<proto::ResponseResult>| {
        frame_bytes(proto::FrameKind::Response(proto::Response {
            request_id: vec![1; 16],
            idx: 0,
            result,
        }))
    };
    assert_eq!(one_frame(raw(None)), Err(Error::Missing("response result")));
    // Reserved status 1 and unknown status 7.
    assert_eq!(
        one_frame(raw(Some(proto::ResponseResult::Status(1)))),
        Err(Error::Malformed("unknown enum value"))
    );
    assert_eq!(
        one_frame(raw(Some(proto::ResponseResult::Status(7)))),
        Err(Error::Malformed("unknown enum value"))
    );
    // idx above u32::MAX.
    let mut r = proto::Response {
        request_id: vec![1; 16],
        idx: 0,
        result: Some(proto::ResponseResult::Status(0)),
    }
    .encode_to_vec();
    r.extend_from_slice(&[0x10, 0x80, 0x80, 0x80, 0x80, 0x10]);
    let mut frame = vec![0x1a];
    prost::encoding::encode_varint(r.len() as u64, &mut frame);
    frame.extend_from_slice(&r);
    assert_eq!(
        one_frame(frame),
        Err(Error::Malformed("uint32 out of range"))
    );
    // request_id of the wrong length.
    let bad = frame_bytes(proto::FrameKind::Response(proto::Response {
        request_id: vec![1; 17],
        idx: 0,
        result: Some(proto::ResponseResult::Status(0)),
    }));
    assert!(matches!(one_frame(bad), Err(Error::BadLength { .. })));
}

fn raw_page(entries: Vec<proto::Entry>, count: u64) -> Vec<u8> {
    frame_bytes(proto::FrameKind::Response(proto::Response {
        request_id: vec![1; 16],
        idx: 0,
        result: Some(proto::ResponseResult::Page(proto::Page {
            scan_id: vec![2; 32],
            offset: 0,
            count,
            entries,
        })),
    }))
}

#[test]
fn page_rules() {
    let e = |i| entry(i).to_proto();
    // A malformed page is kept as an invalid page with its `request_id` (D.23).
    let invalid = |f: Result<Frame>| {
        matches!(
            f,
            Ok(Frame::Response(Response {
                result: ResponseResult::InvalidPage,
                ..
            }))
        )
    };
    // Valid empty end page.
    assert!(one_frame(raw_page(vec![], 0)).is_ok());
    // Empty page with a positive count.
    assert!(invalid(one_frame(raw_page(vec![], 3))));
    // Count below the number of entries.
    assert!(invalid(one_frame(raw_page(vec![e(1), e(2)], 1))));
    // A non-final page.
    let Ok(Frame::Response(Response {
        result: ResponseResult::Page(p),
        ..
    })) = one_frame(raw_page(vec![e(1)], 9))
    else {
        panic!()
    };
    assert!(!p.is_final());
    // 128 entries, then 129.
    let many: Vec<proto::Entry> = (0..129).map(|i| e(i as u8)).collect();
    assert!(one_frame(raw_page(many[..128].to_vec(), 128)).is_ok());
    assert!(matches!(
        one_frame(raw_page(many, 129)),
        Err(Error::TooMany {
            field: "page entries",
            ..
        })
    ));
    // Scan ID length.
    let bad = frame_bytes(proto::FrameKind::Response(proto::Response {
        request_id: vec![1; 16],
        idx: 0,
        result: Some(proto::ResponseResult::Page(proto::Page {
            scan_id: vec![2; 31],
            offset: 0,
            count: 0,
            entries: vec![],
        })),
    }));
    assert!(invalid(one_frame(bad)));
    // The 16 KiB limit: entries made large by repeating a field (the last value wins).
    let mut fat = proto::Entry::default().encode_to_vec();
    for _ in 0..4 {
        fat.extend_from_slice(&e(1).encode_to_vec());
    }
    let fat_entry = proto::Entry::decode(fat.as_slice()).unwrap();
    assert_eq!(fat_entry, e(1));
    let mut page = proto::Page {
        scan_id: vec![2; 32],
        offset: 0,
        count: 0,
        entries: vec![],
    }
    .encode_to_vec();
    for _ in 0..80 {
        page.push(0x22);
        prost::encoding::encode_varint(fat.len() as u64, &mut page);
        page.extend_from_slice(&fat);
    }
    assert!(page.len() > crate::constants::MAX_PAGE_BYTES);
    let mut response = proto::Response {
        request_id: vec![1; 16],
        idx: 0,
        result: None,
    }
    .encode_to_vec();
    response.push(0x22);
    prost::encoding::encode_varint(page.len() as u64, &mut response);
    response.extend_from_slice(&page);
    let mut frame = vec![0x1a];
    prost::encoding::encode_varint(response.len() as u64, &mut frame);
    frame.extend_from_slice(&response);
    assert!(invalid(one_frame(frame)));
}

fn raw_entry(kind: proto::ObjectKind, chat_len: usize, id_len: usize) -> proto::Entry {
    proto::Entry {
        chat_id: vec![1; chat_len],
        kind: kind as i32,
        id: vec![2; id_len],
    }
}

fn notice_of(frame: Result<Frame>) -> Notice {
    match frame {
        Ok(Frame::Notice(n)) => n,
        other => panic!("{other:?}"),
    }
}

/// D.23 and D.37, settled: one entry of a notice or a scan page that cannot be read (an ID of
/// the wrong length) makes the whole notice or page malformed; nothing of it is used.
#[test]
fn an_unreadable_entry_makes_the_whole_notice_or_page_malformed() {
    let raw = |entries: Vec<proto::Entry>| {
        frame_bytes(proto::FrameKind::Notice(proto::Notice { entries }))
    };
    for (kind, len) in [
        (proto::ObjectKind::Event, 24),
        (proto::ObjectKind::Root, 0),
        (proto::ObjectKind::Leave, 32),
        (proto::ObjectKind::Kick, 32),
        (proto::ObjectKind::Dissolve, 32),
    ] {
        let n = notice_of(one_frame(raw(vec![raw_entry(kind, 32, len)])));
        assert_eq!(n.entries.len(), 1);
        // One byte more, one less, or a chat ID of the wrong length, beside a valid entry.
        assert!(
            one_frame(raw(vec![
                raw_entry(kind, 32, len + 1),
                raw_entry(kind, 32, len)
            ]))
            .is_err()
        );
        assert!(
            one_frame(raw(vec![
                raw_entry(kind, 32, len),
                raw_entry(kind, 31, len)
            ]))
            .is_err()
        );
        if len > 0 {
            assert!(one_frame(raw(vec![raw_entry(kind, 32, len - 1)])).is_err());
        }
    }
    let bad = || raw_entry(proto::ObjectKind::Event, 32, 32);
    assert!(one_frame(raw(vec![entry(1).to_proto(), bad(), entry(2).to_proto()])).is_err());
    // An unknown kind is an unknown enum value, which rejects the whole frame (§1).
    let mut unknown = raw_entry(proto::ObjectKind::Event, 32, 24);
    unknown.kind = 5;
    assert_eq!(
        one_frame(raw(vec![entry(1).to_proto(), unknown])),
        Err(Error::Malformed("unknown enum value"))
    );
    // A page alike, whatever its count: kept as an invalid page with its `request_id`, so
    // that the scan it answers ends at once; it is never sent.
    for count in [2, 5] {
        assert!(matches!(
            one_frame(raw_page(vec![entry(1).to_proto(), bad()], count)),
            Ok(Frame::Response(Response {
                result: ResponseResult::InvalidPage,
                ..
            }))
        ));
    }
    assert_eq!(
        encode_plaintext(&[response(ResponseResult::InvalidPage)]),
        Err(Error::NotAllowed("invalid page"))
    );
    assert!(one_frame(raw_page(vec![entry(1).to_proto(), entry(2).to_proto()], 2)).is_ok());
}

#[test]
fn notice_limits() {
    let entries: Vec<Entry> = (0..129).map(entry).collect();
    assert!(
        encode_plaintext(&[Frame::Notice(Notice {
            entries: entries[..128].to_vec(),
        })])
        .is_ok()
    );
    assert!(matches!(
        encode_plaintext(&[Frame::Notice(Notice {
            entries: entries.clone(),
        })]),
        Err(Error::TooMany { .. })
    ));
    let raw = frame_bytes(proto::FrameKind::Notice(proto::Notice {
        entries: entries.iter().map(|e| e.to_proto()).collect(),
    }));
    assert!(matches!(
        one_frame(raw),
        Err(Error::TooMany {
            field: "notice entries",
            ..
        })
    ));
    // The 16 KiB limit, with entries inflated by repeated fields.
    let mut fat = Vec::new();
    for _ in 0..4 {
        fat.extend_from_slice(&entry(1).to_proto().encode_to_vec());
    }
    let mut notice = Vec::new();
    for _ in 0..80 {
        notice.push(0x0a);
        prost::encoding::encode_varint(fat.len() as u64, &mut notice);
        notice.extend_from_slice(&fat);
    }
    let mut frame = vec![0x22];
    prost::encoding::encode_varint(notice.len() as u64, &mut frame);
    frame.extend_from_slice(&notice);
    assert!(matches!(
        one_frame(frame),
        Err(Error::TooMany {
            field: "notice bytes",
            ..
        })
    ));
}

// ── Neighbor and leave-request frames ────────────────────────────────────────

#[test]
fn neighbor_and_leave_request_frames() {
    let c = ChatId::from_bytes([1; 32]);
    let ids: Vec<GossipId> = (1..=11).map(|i| GossipId::from_bytes([i; 32])).collect();
    let frames = vec![
        Frame::NeighborRequest(NeighborRequest { chat_id: c }),
        Frame::NeighborResponse(NeighborResponse {
            chat_id: c,
            accepted: true,
            suggestions: vec![],
        }),
        Frame::NeighborResponse(NeighborResponse {
            chat_id: c,
            accepted: false,
            suggestions: ids[..10].to_vec(),
        }),
        Frame::LeaveRequest(LeaveRequest { chat_id: c }),
    ];
    let bytes = encode_plaintext(&frames).unwrap();
    let decoded: Vec<Frame> = frames_of(&bytes).into_iter().map(|f| f.unwrap()).collect();
    assert_eq!(decoded, frames);

    let raw = |accepted: bool, suggestions: Vec<Vec<u8>>| {
        frame_bytes(proto::FrameKind::NeighborResponse(
            proto::NeighborResponse {
                chat_id: vec![1; 32],
                accepted,
                suggestions,
            },
        ))
    };
    let s = |i: usize| ids[i].as_bytes().to_vec();
    assert!(matches!(
        one_frame(raw(false, (0..11).map(s).collect())),
        Err(Error::TooMany { .. })
    ));
    assert_eq!(
        one_frame(raw(false, vec![s(0), s(0)])),
        Err(Error::Duplicate("suggestions"))
    );
    assert_eq!(
        one_frame(raw(true, vec![s(0)])),
        Err(Error::MustBeAbsent("suggestions"))
    );
    assert!(matches!(
        one_frame(raw(false, vec![vec![1; 31]])),
        Err(Error::BadLength { .. })
    ));
    let bad = frame_bytes(proto::FrameKind::LeaveRequest(proto::LeaveRequest {
        chat_id: vec![1; 33],
    }));
    assert!(matches!(one_frame(bad), Err(Error::BadLength { .. })));
    let bad = frame_bytes(proto::FrameKind::NeighborRequest(proto::NeighborRequest {
        chat_id: vec![],
    }));
    assert!(matches!(one_frame(bad), Err(Error::BadLength { .. })));
    assert!(
        encode_plaintext(&[Frame::NeighborResponse(NeighborResponse {
            chat_id: c,
            accepted: true,
            suggestions: vec![ids[0]],
        })])
        .is_err()
    );
}

// ── Event blobs ──────────────────────────────────────────────────────────────

fn objects() -> Vec<EventObject> {
    let alice = identity(1);
    let bob = identity(2);
    let root = founding(&alice, &[&alice, &bob]);
    let message = MessageEvent::create(
        &root,
        EventId::new(TS, [9; 16]),
        &[EventId::new(TS - 1, [1; 16])],
        Payload::Content(Content {
            sync_obj_id: SyncObjId::from_bytes([7; 32]),
            author: bob.id,
            created_at: TS,
            last_modified_at: TS,
            body: Body::Text("hello".into()),
            edited: false,
            metadata: BTreeMap::from([("k".to_owned(), vec![1, 2, 3])]),
        }),
    )
    .unwrap();
    let leave = Leave::sign(&root, &bob.public, &bob.secret.dsa_signing_key, [1; 32]).unwrap();
    let kick = Kick::sign(&root, bob.id, &alice.secret.dsa_signing_key, [2; 32]).unwrap();
    let dissolve = Dissolve::sign(&root, true, &alice.secret.dsa_signing_key, [3; 32]).unwrap();
    vec![
        EventObject::Root(Box::new(root)),
        EventObject::Message(message),
        EventObject::Leave(leave),
        EventObject::Kick(kick),
        EventObject::Dissolve(dissolve),
    ]
}

#[test]
fn event_blobs_round_trip() {
    for object in objects() {
        let blob = encode_event_blob(&object).unwrap();
        assert_eq!(blob[0], 0x01, "version prefix");
        assert_eq!(decode_event_blob(&blob, 1).unwrap(), object);
        // Through a plaintext, in an event frame and in a response.
        let response = Frame::Response(Response {
            request_id: Some(RequestId::from_bytes([4; 16])),
            idx: 3,
            result: ResponseResult::Event(blob.clone()),
        });
        let bytes = encode_plaintext(&[Frame::Event(blob.clone()), response.clone()]).unwrap();
        let p = decode_plaintext(&bytes).unwrap();
        assert_eq!(p.version, 1);
        let frames: Vec<Result<Frame>> = p.frames().collect();
        assert_eq!(frames, vec![Ok(Frame::Event(blob.clone())), Ok(response)]);
        let Ok(Frame::Event(b)) = &frames[0] else {
            panic!()
        };
        assert_eq!(decode_event_blob(b, p.version).unwrap(), object);
    }
}

#[test]
fn event_blob_version_rules() {
    let blob = encode_event_blob(&objects().remove(2)).unwrap();
    let rest = &blob[1..];
    let with = |v: &[u8]| [v, rest].concat();
    assert_eq!(
        decode_event_blob(&with(&[0x02]), 1),
        Err(Error::EventVersionAbovePlaintext {
            event: 2,
            plaintext: 1
        })
    );
    // Supported plaintext, unsupported event version.
    assert_eq!(
        decode_event_blob(&with(&[0x02]), 2),
        Err(Error::UnsupportedEventVersion(2))
    );
    assert_eq!(
        decode_event_blob(&with(&[0x00]), 1),
        Err(Error::UnsupportedEventVersion(0))
    );
    // A non-minimal varint still reads as version 1.
    assert!(decode_event_blob(&with(&[0x81, 0x00]), 1).is_ok());
    assert_eq!(decode_event_blob(&[], 1), Err(Error::InvalidVersionPrefix));
    assert_eq!(
        decode_event_blob(&[0x80], 1),
        Err(Error::InvalidVersionPrefix)
    );
}

#[test]
fn event_blob_malformed() {
    let blob = encode_event_blob(&objects().remove(4)).unwrap();
    // Unknown field in Event.
    let mut b = blob.clone();
    b.extend_from_slice(&[0x30, 0x00]);
    assert_eq!(
        decode_event_blob(&b, 1),
        Err(Error::Malformed("unknown field"))
    );
    // Unknown oneof case of Event (field 6).
    assert_eq!(
        decode_event_blob(&[0x01, 0x32, 0x00], 1),
        Err(Error::Malformed("unknown field"))
    );
    // No kind.
    assert_eq!(
        decode_event_blob(&[0x01], 1),
        Err(Error::Missing("event kind"))
    );
    // Dissolve with must_delete = 2.
    let mut d = proto::Dissolve {
        chat_id: vec![1; 32],
        must_delete: false,
        signature: vec![0; crypto_dsa::SIGNATURE_SIZE],
    }
    .encode_to_vec();
    d.extend_from_slice(&[0x10, 0x02]);
    let mut b = vec![0x01, 0x2a];
    prost::encoding::encode_varint(d.len() as u64, &mut b);
    b.extend_from_slice(&d);
    assert_eq!(
        decode_event_blob(&b, 1),
        Err(Error::Malformed("bool out of range"))
    );
    // Unknown root type.
    let EventObject::Root(root) = objects().remove(0) else {
        panic!()
    };
    let mut r = root.to_proto();
    r.r#type = 7;
    let b = [
        vec![0x01],
        proto::Event {
            kind: Some(proto::EventKind::GroupRoot(r)),
        }
        .encode_to_vec(),
    ]
    .concat();
    assert_eq!(
        decode_event_blob(&b, 1),
        Err(Error::Malformed("unknown enum value"))
    );
    // Unknown message type.
    let EventObject::Message(m) = objects().remove(1) else {
        panic!()
    };
    let mut p = m.to_proto();
    p.payload.as_mut().unwrap().r#type = 5;
    let b = [
        vec![0x01],
        proto::Event {
            kind: Some(proto::EventKind::GroupMessageEvent(p)),
        }
        .encode_to_vec(),
    ]
    .concat();
    assert_eq!(
        decode_event_blob(&b, 1),
        Err(Error::Malformed("unknown enum value"))
    );
    // Invalid UTF-8 in a text body.
    let mut p = m.to_proto();
    p.payload.as_mut().unwrap().body = Some(proto::Body::Text("\u{1}".into()));
    let mut b = [
        vec![0x01],
        proto::Event {
            kind: Some(proto::EventKind::GroupMessageEvent(p)),
        }
        .encode_to_vec(),
    ]
    .concat();
    // Turn the one byte of field 7 into a byte that is never UTF-8.
    let pos = b.windows(3).position(|w| w == [0x3a, 0x01, 0x01]).unwrap();
    b[pos + 2] = 0xff;
    assert_eq!(
        decode_event_blob(&b, 1),
        Err(Error::InvalidUtf8("MessagePayload"))
    );
}

/// The blob of a message event whose payload is `payload` once `edit` changed its encoding.
fn message_blob_with(payload: Payload, edit: impl Fn(Vec<u8>) -> Vec<u8>) -> Vec<u8> {
    let alice = identity(1);
    let root = founding(&alice, &[&alice]);
    let m = MessageEvent::create(&root, EventId::new(TS, [9; 16]), &[], payload).unwrap();
    let mut p = m.to_proto();
    let encoded = edit(p.payload.take().unwrap().encode_to_vec());
    let mut event = p.encode_to_vec();
    event.extend(raw_field(0x2a, &encoded));
    blob_of(&raw_field(0x12, &event))
}

fn reaction_payload(author: GossipId, emoji: &str, action: crate::ReactionAction) -> Payload {
    let r = crate::Reaction {
        target: SyncObjId::from_bytes([7; 32]),
        emoji: emoji.into(),
        action,
    };
    Payload::Content(Content {
        sync_obj_id: r.sync_obj_id(&author),
        author,
        created_at: TS,
        last_modified_at: TS,
        body: Body::Reaction(r),
        edited: false,
        metadata: BTreeMap::new(),
    })
}

fn media_payload(author: GossipId, mimetype: &str, data: Vec<u8>) -> Payload {
    Payload::Content(Content {
        sync_obj_id: SyncObjId::from_bytes([8; 32]),
        author,
        created_at: TS,
        last_modified_at: TS,
        body: Body::Media(crate::Media {
            mimetype: mimetype.into(),
            data,
        }),
        edited: false,
        metadata: BTreeMap::new(),
    })
}

#[test]
fn reactions_and_media_are_structured_and_strict() {
    let alice = identity(1).id;
    let same = |b: Vec<u8>| b;
    // Both round-trip through an event blob.
    for payload in [
        reaction_payload(alice, "\u{1f44d}", crate::ReactionAction::Add),
        reaction_payload(alice, "\u{1f44d}", crate::ReactionAction::Remove),
        media_payload(alice, "image/png", vec![1, 2, 3]),
        media_payload(alice, "text/vcard", vec![]),
    ] {
        let blob = message_blob_with(payload.clone(), same);
        let Ok(EventObject::Message(m)) = decode_event_blob(&blob, 1) else {
            panic!("{payload:?}")
        };
        assert_eq!(*m.payload(), payload);
    }
    let reaction = reaction_payload(alice, "\u{1f44d}", crate::ReactionAction::Add);
    let media = media_payload(alice, "image/png", vec![1, 2, 3]);
    // The reaction's fields: key 0x5a (11), then target 0x0a, emoji 0x12, action 0x18.
    let find = |b: &[u8], w: &[u8]| b.windows(w.len()).position(|x| x == w).unwrap();
    // An action other than add or remove.
    let bad_action = message_blob_with(reaction.clone(), |mut b| {
        b.extend([0x5a, 0x02, 0x18, 0x02]);
        b
    });
    assert_eq!(
        decode_event_blob(&bad_action, 1),
        Err(Error::Malformed("unknown enum value"))
    );
    // An unknown field inside the reaction or the media message.
    let unknown = message_blob_with(reaction.clone(), |mut b| {
        b.extend([0x5a, 0x02, 0x20, 0x00]);
        b
    });
    assert_eq!(
        decode_event_blob(&unknown, 1),
        Err(Error::Malformed("unknown field"))
    );
    let unknown = message_blob_with(media.clone(), |mut b| {
        b.extend([0x62, 0x02, 0x18, 0x00]);
        b
    });
    assert_eq!(
        decode_event_blob(&unknown, 1),
        Err(Error::Malformed("unknown field"))
    );
    // An emoji that is not UTF-8.
    let not_utf8 = message_blob_with(reaction.clone(), |mut b| {
        let at = find(&b, &[0x12, 0x04, 0xf0, 0x9f]);
        b[at + 2] = 0xff;
        b
    });
    assert_eq!(
        decode_event_blob(&not_utf8, 1),
        Err(Error::InvalidUtf8("Reaction"))
    );
    // A reaction body under the media type, and two bodies.
    let swapped = message_blob_with(reaction.clone(), |mut b| {
        // The payload starts with the 32-byte syncObjId, then the type.
        assert_eq!(b[34..36], [0x10, 0x02]);
        b[35] = 0x03;
        b
    });
    assert_eq!(
        decode_event_blob(&swapped, 1),
        Err(Error::NotAllowed("body for this message type"))
    );
    let two = message_blob_with(reaction, |mut b| {
        b.extend([0x62, 0x00]);
        b
    });
    assert_eq!(
        decode_event_blob(&two, 1),
        Err(Error::Malformed("two cases of one oneof"))
    );
    // Field 9, the opaque body before reactions and media had their own messages, is
    // reserved: unknown.
    let nine = message_blob_with(media, |mut b| {
        let at = find(&b, &[0x62, 0x10, 0x0a, 0x09]);
        b.truncate(at);
        b.extend([0x4a, 0x01, 0x01]);
        b
    });
    assert_eq!(
        decode_event_blob(&nine, 1),
        Err(Error::Malformed("unknown field"))
    );
}

#[test]
fn oversized_event_blobs_are_refused() {
    let blob = [vec![0x01], vec![0; MAX_PLAINTEXT_BYTES]].concat();
    assert_eq!(decode_event_blob(&blob, 1), Err(Error::DoesNotFitContainer));
    let alice = identity(1);
    let root = founding(&alice, &[&alice]);
    let big = Payload::Content(Content {
        sync_obj_id: SyncObjId::from_bytes([7; 32]),
        author: alice.id,
        created_at: TS,
        last_modified_at: TS,
        body: Body::Media(crate::Media {
            mimetype: "application/octet-stream".into(),
            data: vec![0; MAX_PLAINTEXT_BYTES],
        }),
        edited: false,
        metadata: BTreeMap::new(),
    });
    assert_eq!(
        MessageEvent::create(&root, EventId::new(TS, [0; 16]), &[], big),
        Err(Error::DoesNotFitContainer)
    );
    // The bound is exact.
    let n = MAX_EVENT_BLOB_BYTES;
    assert!(fits_empty_container(n) && !fits_empty_container(n + 1));
    assert_eq!(
        single_frame_plaintext_len(largest_carrier_frame_len(n)),
        MAX_PLAINTEXT_BYTES
    );
    assert!(single_frame_plaintext_len(largest_carrier_frame_len(n + 1)) > MAX_PLAINTEXT_BYTES);
    // A response frame carrying it with the longest fields fits, as encoded.
    let pt = encode_plaintext(&[Frame::Response(Response {
        request_id: Some(RequestId::from_bytes([0xff; 16])),
        idx: u32::MAX,
        result: ResponseResult::Event(vec![0; n]),
    })])
    .unwrap();
    assert_eq!(pt.len(), MAX_PLAINTEXT_BYTES);
}

#[test]
fn metadata_len_bounds_the_encoded_metadata_field() {
    let maps = [
        BTreeMap::new(),
        BTreeMap::from([(String::new(), vec![])]),
        BTreeMap::from([("a".to_owned(), vec![])]),
        BTreeMap::from([(String::new(), vec![1])]),
        BTreeMap::from([
            ("replyTo".to_owned(), vec![7; 2_048]),
            ("\u{e9}t\u{e9}".to_owned(), vec![0; 300]),
            ("z".to_owned(), vec![1; 20_000]),
        ]),
    ];
    for metadata in maps {
        let len = metadata_len(&metadata);
        // Prost leaves an empty key or value out; with none, the count is its encoding.
        let full = metadata.iter().all(|(k, v)| !k.is_empty() && !v.is_empty());
        let p = proto::MessagePayload {
            metadata,
            ..Default::default()
        };
        assert!(len >= p.encoded_len());
        assert_eq!(len == p.encoded_len(), full);
    }
}

/// §13.10, settled: every metadata entry counts both its key and its value fields, empty or
/// not: per entry 1 tag byte, the varint length of the entry, then `1 + varint(len key) +
/// key` and `1 + varint(len value) + value`.
#[test]
fn metadata_len_counts_the_key_and_the_value_of_every_entry() {
    let one = |k: &str, v: usize| BTreeMap::from([(k.to_owned(), vec![0u8; v])]);
    assert_eq!(metadata_len(&BTreeMap::new()), 0);
    // An entry of 4 bytes: two empty fields of 2 bytes each.
    assert_eq!(metadata_len(&one("", 0)), 1 + 1 + 4);
    assert_eq!(metadata_len(&one("a", 0)), 1 + 1 + 5);
    assert_eq!(metadata_len(&one("", 1)), 1 + 1 + 5);
    assert_eq!(
        metadata_len(&one("ab", 3)),
        1 + 1 + (1 + 1 + 2) + (1 + 1 + 3)
    );
    // A value of 200 bytes takes a 2-byte varint, the entry (206 bytes) too.
    assert_eq!(
        metadata_len(&one("k", 200)),
        1 + 2 + (1 + 1 + 1) + (1 + 2 + 200)
    );
    let two = BTreeMap::from([("a".to_owned(), vec![]), ("b".to_owned(), vec![1])]);
    assert_eq!(metadata_len(&two), 7 + 8);
}

// ── The largest objects ──────────────────────────────────────────────────────

/// The size of `object` as an event blob, checked to fit one empty container in the largest
/// frame that can carry it, as encoded.
fn fitting_blob_len(object: &EventObject) -> usize {
    let blob = encode_event_blob(object).unwrap();
    assert!(fits_empty_container(blob.len()), "{} bytes", blob.len());
    let pt = encode_plaintext(&[Frame::Response(Response {
        request_id: Some(RequestId::from_bytes([0xff; 16])),
        idx: u32::MAX,
        result: ResponseResult::Event(blob.clone()),
    })])
    .unwrap();
    assert!(pt.len() <= MAX_PLAINTEXT_BYTES);
    assert_eq!(decode_event_blob(&blob, 1).as_ref(), Ok(object));
    blob.len()
}

/// The largest valid root: 512 members, 32 parents, a 256-byte name, the owner's keys, the
/// longest `created_at`, `migrate_from` and message timer, and a settings map of 128 entries
/// of 64-byte keys filling its 16,384 bytes exactly.
fn largest_root(owner: &crate::test_support::Identity) -> crate::Root {
    let mut members: Vec<GossipId> = (1u16..512)
        .map(|i| {
            let mut m = [0xff; 32];
            m[30..].copy_from_slice(&i.to_be_bytes());
            GossipId::from_bytes(m)
        })
        .collect();
    members.push(owner.id);
    let mut params = crate::root::tests::params(owner, &[], 0x10);
    params.name = "\u{e9}".repeat(128);
    params.members = members;
    params.created_at = u64::MAX;
    params.message_timer = u64::MAX;
    // Each entry: 1 + 1 + (1 + 1 + 64) + (1 + 1 + 58) = 128 bytes; 128 of them, 16,384.
    params.settings = (0..crate::constants::MAX_SETTINGS_ENTRIES)
        .map(|i| (format!("{i:0>64}"), vec![0xa5; 58]))
        .collect();
    assert_eq!(
        metadata_len(&params.settings),
        crate::constants::MAX_SETTINGS_BYTES
    );
    let parents: Vec<ChatId> = (0u8..32).map(|i| ChatId::from_bytes([i; 32])).collect();
    let root =
        crate::Root::create_successor(params, &parents, &owner.secret.dsa_signing_key, [0; 32])
            .unwrap();
    // `migrate_from` at its longest encoding, signed again.
    let mut p = root.to_proto();
    p.migrate_from = Some(u64::MAX);
    let root = crate::Root::forge(p, &owner.secret.dsa_signing_key);
    assert_eq!(
        root.settings().len(),
        crate::constants::MAX_SETTINGS_ENTRIES
    );
    assert_eq!(root.name().len(), crate::constants::MAX_NAME_BYTES);
    assert_eq!(root.members().len(), crate::constants::MAX_MEMBERS);
    assert_eq!(root.parents().len(), crate::constants::MAX_ROOT_PARENTS);
    root
}

#[test]
fn the_largest_root_and_signed_objects_fit_one_container() {
    let alice = identity(1);
    let root = largest_root(&alice);
    let leave = Leave::sign(&root, &alice.public, &alice.secret.dsa_signing_key, [1; 32]);
    let kick = Kick::sign(
        &root,
        root.members()[0],
        &alice.secret.dsa_signing_key,
        [2; 32],
    );
    let dissolve = Dissolve::sign(&root, true, &alice.secret.dsa_signing_key, [3; 32]);
    let sizes = [
        ("root", fitting_blob_len(&EventObject::Root(Box::new(root)))),
        (
            "leave",
            fitting_blob_len(&EventObject::Leave(leave.unwrap())),
        ),
        ("kick", fitting_blob_len(&EventObject::Kick(kick.unwrap()))),
        (
            "dissolve",
            fitting_blob_len(&EventObject::Dissolve(dissolve.unwrap())),
        ),
    ];
    println!("{sizes:?} of at most {MAX_EVENT_BLOB_BYTES}");
    // A root of 512 members is about 24 KB (§4.4); with a full settings map about 41.8 KB,
    // still within the container with about 15 KB to spare (§4.6).
    assert_eq!(sizes[0].1, LARGEST_ROOT_BLOB);
}

/// The event blob of the largest root, in bytes.
const LARGEST_ROOT_BLOB: usize = 41_823;

/// §4.6, §13.10: the largest root fits one group plaintext with its frame, pushed in full as
/// an event frame and as the answer to a chat lookup (a response frame with the longest
/// `request_id` and `idx`).
#[test]
fn the_largest_root_fits_one_plaintext_pushed_and_as_a_lookup_answer() {
    let alice = identity(1);
    let blob = encode_event_blob(&EventObject::Root(Box::new(largest_root(&alice)))).unwrap();
    let pushed = encode_plaintext(&[Frame::Event(blob.clone())]).unwrap();
    let answer = encode_plaintext(&[Frame::Response(Response {
        request_id: Some(RequestId::from_bytes([0xff; 16])),
        idx: u32::MAX,
        result: ResponseResult::Event(blob.clone()),
    })])
    .unwrap();
    println!(
        "largest root: blob {}, pushed {}, answer {}, of {MAX_PLAINTEXT_BYTES}",
        blob.len(),
        pushed.len(),
        answer.len()
    );
    assert_eq!(blob.len(), LARGEST_ROOT_BLOB);
    assert_eq!(pushed.len(), LARGEST_ROOT_PUSHED);
    assert_eq!(answer.len(), LARGEST_ROOT_ANSWER);
    assert!(answer.len() <= MAX_PLAINTEXT_BYTES);
    // Where a root travels with other objects, each is a frame of its own, packed greedily
    // and split across plaintexts (§4.6 step 6, §5.3, D.62): a leave then the root still
    // share one plaintext; a root takes 4 kicks with it, the others follow; two of the
    // largest roots never share one.
    let alice_leave = Leave::sign(
        &largest_root(&alice),
        &alice.public,
        &alice.secret.dsa_signing_key,
        [1; 32],
    )
    .unwrap();
    let leave = Frame::Event(encode_event_blob(&EventObject::Leave(alice_leave)).unwrap());
    let both = encode_plaintext(&[leave, Frame::Event(blob.clone())]).unwrap();
    println!("a leave then the largest root: {}", both.len());
    let root = largest_root(&alice);
    let kick = |i: usize| {
        let k = Kick::sign(
            &root,
            root.members()[i],
            &alice.secret.dsa_signing_key,
            [2; 32],
        )
        .unwrap();
        Frame::Event(encode_event_blob(&EventObject::Kick(k)).unwrap())
    };
    let mut frames = vec![Frame::Event(blob.clone())];
    while encode_plaintext(&frames).is_ok() {
        frames.push(kick(frames.len()));
    }
    assert_eq!(frames.len() - 2, 4);
    assert!(encode_plaintext(&[Frame::Event(blob.clone()), Frame::Event(blob)]).is_err());
}

/// The largest root pushed alone in a plaintext, and as a lookup answer, in bytes.
const LARGEST_ROOT_PUSHED: usize = 41_832;
const LARGEST_ROOT_ANSWER: usize = 41_860;

/// A maximal message event: 16 parents, 32 reply targets, metadata and text at their
/// limits, the longest timestamps; `body` turns the text into the body.
fn maximal_event(body: impl Fn(String) -> Body) -> MessageEvent {
    use crate::constants::{
        MAX_EVENT_PARENTS, MAX_METADATA_BYTES, MAX_REPLY_TARGETS, MAX_SCHEDULE_MS, MAX_TEXT_BYTES,
    };
    use crate::event::{ReplyTarget, encode_reply_to};
    let alice = identity(1);
    let root = founding(&alice, &[&alice]);
    let ts = u64::MAX - MAX_SCHEDULE_MS;
    let parents: Vec<EventId> = (0..MAX_EVENT_PARENTS as u8)
        .map(|i| EventId::new(ts - 1, [i; 16]))
        .collect();
    let targets: Vec<ReplyTarget> = (0..MAX_REPLY_TARGETS as u8)
        .map(|i| ReplyTarget {
            ref_chat_id: crate::RefChatId::from_bytes([i; 32]),
            sync_obj_id: SyncObjId::from_bytes([!i; 32]),
        })
        .collect();
    let mut metadata = BTreeMap::from([(
        crate::constants::METADATA_KEY_REPLY_TO.to_owned(),
        encode_reply_to(&targets).unwrap(),
    )]);
    // Filled up to the limit exactly.
    let mut n = MAX_METADATA_BYTES - metadata_len(&metadata);
    loop {
        metadata.insert("m".to_owned(), vec![0xa5; n]);
        if metadata_len(&metadata) <= MAX_METADATA_BYTES {
            break;
        }
        n -= 1;
    }
    assert_eq!(metadata_len(&metadata), MAX_METADATA_BYTES);
    MessageEvent::create(
        &root,
        EventId::new(ts, [0xff; 16]),
        &parents,
        Payload::Content(Content {
            sync_obj_id: SyncObjId::from_bytes([0xff; 32]),
            author: alice.id,
            created_at: u64::MAX,
            last_modified_at: u64::MAX,
            body: body("\u{e9}".repeat(MAX_TEXT_BYTES / 2)),
            edited: true,
            metadata,
        }),
    )
    .unwrap()
}

#[test]
fn a_maximal_message_event_fits_one_container_with_room() {
    let text = maximal_event(Body::Text);
    let forward = maximal_event(|t| Body::Forward {
        content_type: crate::event::MessageType::Text,
        content: t.into_bytes(),
    });
    for event in [text, forward] {
        let event = EventObject::Message(event);
        let len = fitting_blob_len(&event);
        // How many travel together in one plaintext, as event frames.
        let blob = encode_event_blob(&event).unwrap();
        let mut frames = vec![Frame::Event(blob.clone())];
        while encode_plaintext(&frames).is_ok() {
            frames.push(Frame::Event(blob.clone()));
        }
        let per_container = frames.len() - 1;
        println!("maximal event: {len} bytes, {per_container} per container");
        // Text and metadata are about 32 KiB: one fits with about 24 KB to spare.
        assert!(len < 34_000 && MAX_EVENT_BLOB_BYTES - len > 23_000, "{len}");
        assert_eq!(per_container, 1);
    }
}

// ── Strict check: one case per `oneof`, counts before decoding ───────────────

/// `key ‖ len ‖ bytes` for a length-delimited field whose key fits one byte.
fn raw_field(key: u8, bytes: &[u8]) -> Vec<u8> {
    let mut out = vec![key];
    prost::encoding::encode_varint(bytes.len() as u64, &mut out);
    out.extend_from_slice(bytes);
    out
}

fn blob_of(event: &[u8]) -> Vec<u8> {
    [&[0x01][..], event].concat()
}

#[test]
fn a_frame_holds_one_kind() {
    let leave_request = frame_bytes(proto::FrameKind::LeaveRequest(proto::LeaveRequest {
        chat_id: vec![1; 32],
    }));
    let neighbor_request = frame_bytes(proto::FrameKind::NeighborRequest(proto::NeighborRequest {
        chat_id: vec![1; 32],
    }));
    assert_eq!(
        one_frame([leave_request.clone(), neighbor_request.clone()].concat()),
        Err(Error::Malformed("two cases of one oneof"))
    );
    // An event frame and another kind.
    let event = frame_bytes(proto::FrameKind::Event(vec![0x01]));
    assert_eq!(
        one_frame([neighbor_request, event].concat()),
        Err(Error::Malformed("two cases of one oneof"))
    );
    // The same kind twice is standard protobuf: the occurrences merge.
    let other = frame_bytes(proto::FrameKind::LeaveRequest(proto::LeaveRequest {
        chat_id: vec![2; 32],
    }));
    assert_eq!(
        one_frame([leave_request, other].concat()),
        Ok(Frame::LeaveRequest(LeaveRequest {
            chat_id: ChatId::from_bytes([2; 32])
        }))
    );
}

#[test]
fn every_oneof_holds_one_case() {
    // Event.kind: a leave and a kick in one blob.
    let objects = objects();
    let leave = encode_event_blob(&objects[2]).unwrap();
    let kick = encode_event_blob(&objects[3]).unwrap();
    let both = [&leave[..], &kick[1..]].concat();
    assert_eq!(
        decode_event_blob(&both, 1),
        Err(Error::Malformed("two cases of one oneof"))
    );

    // MessagePayload.body: a text and a media body.
    let EventObject::Message(m) = &objects[1] else {
        panic!()
    };
    let mut event = m.to_proto();
    let payload = event.payload.take().unwrap();
    let payload = [payload.encode_to_vec(), raw_field(0x62, &[])].concat();
    let message = [event.encode_to_vec(), raw_field(0x2a, &payload)].concat();
    assert_eq!(
        decode_event_blob(&blob_of(&raw_field(0x12, &message)), 1),
        Err(Error::Malformed("two cases of one oneof"))
    );

    // QueryEntry.op: two operations in one entry; only that entry is malformed.
    let ops = all_ops();
    let two_ops = [ops[3].encode(), ops[4].encode()].concat();
    // ChatLookup.by: a chat ID and a reference, sent as two occurrences of chat_lookup, which
    // merge into one lookup with two keys.
    let two_keys = [ops[0].encode(), ops[1].encode()].concat();
    let Ok(Frame::Query(q)) = one_frame(raw_query(
        vec![two_ops, two_keys, ops[0].encode()],
        vec![9; 16],
    )) else {
        panic!()
    };
    assert_eq!(
        q.entries,
        vec![
            QueryEntry::Malformed(Error::Malformed("two cases of one oneof")),
            QueryEntry::Malformed(Error::Malformed("two cases of one oneof")),
            QueryEntry::Op(ops[0].clone()),
        ]
    );

    // Response.result: a status and keys.
    let response = proto::Response {
        request_id: vec![1; 16],
        idx: 0,
        result: Some(proto::ResponseResult::Status(proto::Status::Busy as i32)),
    }
    .encode_to_vec();
    let response = [response, raw_field(0x32, &[1, 2])].concat();
    assert_eq!(
        one_frame(raw_field(0x1a, &response)),
        Err(Error::Malformed("two cases of one oneof"))
    );
}

#[test]
fn counts_are_limited_across_merged_occurrences() {
    // Two notices of 100 entries in one frame merge into one of 200.
    let notice = |n: u8| {
        frame_bytes(proto::FrameKind::Notice(proto::Notice {
            entries: (0..n).map(|i| entry(i).to_proto()).collect(),
        }))
    };
    assert!(one_frame(notice(100)).is_ok());
    assert_eq!(
        one_frame([notice(100), notice(100)].concat()),
        Err(Error::TooMany {
            field: "notice entries",
            max: 128,
            got: 200
        })
    );
    // Two query frames of 9 entries each merge into one of 18.
    let q = raw_query(vec![all_ops()[0].encode(); 9], vec![9; 16]);
    assert_eq!(
        one_frame([q.clone(), q].concat()),
        Err(Error::TooMany {
            field: "query entries",
            max: 16,
            got: 18
        })
    );
}

#[test]
fn event_blob_counts_are_limited_before_decoding() {
    let objects = objects();
    let EventObject::Root(root) = &objects[0] else {
        panic!()
    };
    let blob = |kind: proto::EventKind| blob_of(&proto::Event { kind: Some(kind) }.encode_to_vec());
    let mut p = root.to_proto();
    p.members = (0u16..513)
        .map(|i| {
            let mut m = vec![0; 32];
            m[30..].copy_from_slice(&i.to_be_bytes());
            m
        })
        .collect();
    assert_eq!(
        decode_event_blob(&blob(proto::EventKind::GroupRoot(p)), 1),
        Err(Error::TooMany {
            field: "members",
            max: 512,
            got: 513
        })
    );
    let mut p = root.to_proto();
    p.parents = vec![vec![]; 33];
    assert_eq!(
        decode_event_blob(&blob(proto::EventKind::GroupRoot(p)), 1),
        Err(Error::TooMany {
            field: "parents",
            max: 32,
            got: 33
        })
    );
    let EventObject::Message(m) = &objects[1] else {
        panic!()
    };
    let mut p = m.to_proto();
    p.parents = vec![vec![]; 17];
    assert_eq!(
        decode_event_blob(&blob(proto::EventKind::GroupMessageEvent(p)), 1),
        Err(Error::TooMany {
            field: "parents",
            max: 16,
            got: 17
        })
    );
}

#[test]
fn a_plaintext_of_empty_frames_is_judged_frame_by_frame() {
    // 28,671 empty frames: each is rejected on its own as it is read.
    let n = (MAX_PLAINTEXT_BYTES - 1) / 2;
    let mut bytes = vec![0x01];
    for _ in 0..n {
        bytes.extend_from_slice(&[0x0a, 0x00]);
    }
    assert!(bytes.len() <= MAX_PLAINTEXT_BYTES && bytes.len() + 2 > MAX_PLAINTEXT_BYTES);
    let p = decode_plaintext(&bytes).unwrap();
    let mut count = 0;
    for frame in p.frames() {
        assert_eq!(frame, Err(Error::Missing("frame kind")));
        count += 1;
    }
    assert_eq!(count, n);
}

// ── Debug output ─────────────────────────────────────────────────────────────

#[test]
fn debug_hides_secrets_and_content() {
    const TEXT: &str = "the words of a message";
    let objects = objects();
    let EventObject::Root(root) = &objects[0] else {
        panic!()
    };
    // The test root's group secret is 32 bytes of 0x10.
    let secret_bytes = format!("{:?}", vec![0x10u8; 4]);
    let secret_bytes = &secret_bytes[1..secret_bytes.len() - 1];
    let shown = format!("{:?} {:?}", root.to_proto(), root);
    assert!(shown.contains("group_secret: <32 bytes>"), "{shown}");
    assert!(!shown.contains(secret_bytes), "{shown}");

    let EventObject::Message(m) = &objects[1] else {
        panic!()
    };
    let mut content = match m.payload() {
        Payload::Content(c) => c.clone(),
        Payload::Delete { .. } => panic!(),
    };
    content.body = Body::Text(TEXT.into());
    content
        .metadata
        .insert("note".into(), TEXT.as_bytes().to_vec());
    let message = MessageEvent::create(
        root,
        m.event_id(),
        m.parents(),
        Payload::Content(content.clone()),
    )
    .unwrap();
    let blob = encode_event_blob(&EventObject::Message(message.clone())).unwrap();
    let forward = Body::Forward {
        content_type: crate::MessageType::Text,
        content: TEXT.as_bytes().to_vec(),
    };
    let response = Frame::Response(Response {
        request_id: Some(RequestId::from_bytes([1; 16])),
        idx: 0,
        result: ResponseResult::Event(blob.clone()),
    });
    let plaintext = encode_plaintext(&[Frame::Event(blob.clone()), response.clone()]).unwrap();
    let mut forward_proto = message.to_proto();
    forward_proto.payload.as_mut().unwrap().body = Some(proto::Body::Forward(proto::Forward {
        content_type: 0,
        content: TEXT.as_bytes().to_vec(),
    }));
    let edit = crate::LocalEdit {
        body: Some(Body::Text(TEXT.into())),
        metadata: content.metadata.clone().into(),
        ..Default::default()
    };
    let shown = [
        format!("{message:?}"),
        format!("{content:?}"),
        format!("{forward:?}"),
        format!(
            "{:?}",
            Body::Media(crate::Media {
                mimetype: "text/plain".into(),
                data: TEXT.as_bytes().to_vec()
            })
        ),
        format!(
            "{:?}",
            Body::Reaction(crate::Reaction {
                target: SyncObjId::from_bytes([1; 32]),
                emoji: TEXT.into(),
                action: crate::ReactionAction::Add
            })
        ),
        format!("{:?}", message.to_proto()),
        format!("{forward_proto:?}"),
        format!("{:?}", Frame::Event(blob.clone())),
        format!("{response:?}"),
        format!(
            "{:?}",
            proto::Frame {
                kind: Some(proto::FrameKind::Event(blob.clone()))
            }
        ),
        format!("{:?}", decode_plaintext(&plaintext).unwrap()),
        format!("{:?}", frames_of(&plaintext)),
        format!("{edit:?}"),
    ];
    let as_numbers = format!("{:?}", &TEXT.as_bytes()[..4]);
    let as_numbers = &as_numbers[1..as_numbers.len() - 1];
    for s in shown {
        assert!(!s.contains("words"), "{s}");
        assert!(!s.contains(as_numbers), "{s}");
        assert!(s.contains("bytes>"), "{s}");
    }
}

#[test]
fn migrate_from_and_the_message_timer_are_strict_uint64_the_settings_a_map_and_field_14_is_unknown()
{
    let objects = objects();
    let EventObject::Root(root) = &objects[0] else {
        panic!()
    };
    let root_bytes = root.to_proto().encode_to_vec();
    let event = |root: &[u8]| blob_of(&raw_field(0x0a, root));
    // Field 11 with the length-delimited wire type.
    let wrong = [root_bytes.clone(), raw_field(0x5a, &[0])].concat();
    assert!(matches!(
        decode_event_blob(&event(&wrong), 1),
        Err(Error::Malformed(_))
    ));
    // Field 12, the message timer, with the length-delimited wire type.
    let wrong = [root_bytes.clone(), raw_field(0x62, &[0])].concat();
    assert!(matches!(
        decode_event_blob(&event(&wrong), 1),
        Err(Error::Malformed(_))
    ));
    // Field 12 as a varint: the timer.
    let timed = [root_bytes.clone(), vec![0x60, 0x80, 0xdd, 0xdb, 0x01]].concat();
    let r = decode_event_blob(&event(&timed), 1);
    assert!(matches!(r, Ok(EventObject::Root(ref x)) if x.message_timer() == 3_600_000));
    // Field 13 as a varint is malformed; as entries, the settings map.
    let wrong = [root_bytes.clone(), vec![0x68, 0x00]].concat();
    assert!(matches!(
        decode_event_blob(&event(&wrong), 1),
        Err(Error::Malformed(_))
    ));
    let set = [root_bytes.clone(), raw_field(0x6a, &[0x0a, 0x01, b'k'])].concat();
    let r = decode_event_blob(&event(&set), 1);
    assert!(
        matches!(r, Ok(EventObject::Root(ref x)) if x.settings().get("k") == Some(&Vec::new()))
    );
    // Field 14, unknown in wire version 1 (§13.8).
    let unknown = [root_bytes.clone(), vec![0x70, 0x00]].concat();
    assert!(matches!(
        decode_event_blob(&event(&unknown), 1),
        Err(Error::Malformed(_))
    ));
    // Field 11 as a varint, on any root: decoded, presence kept apart from the value 0.
    let with = [root_bytes, vec![0x58, 0x00]].concat();
    let r = decode_event_blob(&event(&with), 1);
    assert!(matches!(r, Ok(EventObject::Root(ref x)) if x.migrate_from() == Some(0)));
}

// ── Golden vectors (§2.2: formats are fixed for the whole wire version) ──────────────

/// The pinned values, by label: hashes and IDs as hex, small encodings as hex, and an
/// encoding that carries keys or a signature as its length and BLAKE3 digest.
fn golden_values() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let digest = |b: &[u8]| {
        format!(
            "{} bytes, blake3 {}",
            b.len(),
            hex::encode(blake3::hash(b).as_bytes())
        )
    };
    let alice = identity(1);
    let bob = identity(2);
    let carol = identity(3);
    // A handover root and a root with several parents.
    let parent = founding(&alice, &[&alice, &bob, &carol]);
    let handover = crate::Root::create_handover(
        crate::root::tests::params(&bob, &[&bob, &carol], 0x30),
        &parent,
        &alice.secret.dsa_signing_key,
        [2; 32],
    )
    .unwrap();
    out.push((
        "handover root ID".into(),
        hex::encode(handover.chat_id().as_bytes()),
    ));
    let multi = crate::Root::create_successor(
        crate::root::tests::params(&alice, &[&alice, &bob], 0x20),
        &[ChatId::from_bytes([1; 32]), ChatId::from_bytes([2; 32])],
        &alice.secret.dsa_signing_key,
        [1; 32],
    )
    .unwrap();
    out.push((
        "multi-parent root ID".into(),
        hex::encode(multi.chat_id().as_bytes()),
    ));
    // A root with a message timer of one week and two settings (§4.1).
    let mut p = crate::root::tests::params(&alice, &[&alice, &bob], 0x40);
    p.message_timer = 604_800_000;
    p.settings = BTreeMap::from([
        ("gossip.example.a".to_owned(), vec![1, 2]),
        ("b".to_owned(), Vec::new()),
    ]);
    let timed = crate::Root::create_successor(
        p,
        &[ChatId::from_bytes([3; 32])],
        &alice.secret.dsa_signing_key,
        [3; 32],
    )
    .unwrap();
    out.push((
        "timed root ID".into(),
        hex::encode(timed.chat_id().as_bytes()),
    ));
    out.push((
        "timed root event blob".into(),
        digest(&encode_event_blob(&EventObject::Root(Box::new(timed))).unwrap()),
    ));
    // Result projections of a forward, a reaction added and removed, and a media message;
    // with the reactions and the media message as event blobs.
    let chat = ChatId::from_bytes([5; 32]);
    let reaction = |action| crate::Reaction {
        target: SyncObjId::from_bytes([7; 32]),
        emoji: "\u{1f44d}".into(),
        action,
    };
    out.push((
        "reaction ID".into(),
        hex::encode(
            reaction(crate::ReactionAction::Add)
                .sync_obj_id(&bob.id)
                .as_bytes(),
        ),
    ));
    let root = founding(&alice, &[&alice, &bob]);
    for (label, body, sync) in [
        (
            "forward",
            Body::Forward {
                content_type: crate::MessageType::Text,
                content: b"hi".to_vec(),
            },
            SyncObjId::from_bytes([7; 32]),
        ),
        (
            "reaction add",
            Body::Reaction(reaction(crate::ReactionAction::Add)),
            reaction(crate::ReactionAction::Add).sync_obj_id(&bob.id),
        ),
        (
            "reaction remove",
            Body::Reaction(reaction(crate::ReactionAction::Remove)),
            reaction(crate::ReactionAction::Add).sync_obj_id(&bob.id),
        ),
        (
            "media",
            Body::Media(crate::Media {
                mimetype: "image/png".into(),
                data: vec![1, 2, 3, 4],
            }),
            SyncObjId::from_bytes([7; 32]),
        ),
        (
            "forwarded media",
            Body::Forward {
                content_type: crate::MessageType::Media,
                content: crate::Media {
                    mimetype: "image/png".into(),
                    data: vec![1, 2, 3, 4],
                }
                .encode(),
            },
            SyncObjId::from_bytes([7; 32]),
        ),
    ] {
        let p = Payload::Content(Content {
            sync_obj_id: sync,
            author: bob.id,
            created_at: TS,
            last_modified_at: TS,
            body,
            edited: false,
            metadata: BTreeMap::new(),
        });
        out.push((
            format!("{label} result hash"),
            hex::encode(p.result_hash(&chat)),
        ));
        if label != "forward" {
            let e = MessageEvent::create(&root, EventId::new(TS, [9; 16]), &[], p).unwrap();
            out.push((
                format!("{label} event blob"),
                hex::encode(encode_event_blob(&EventObject::Message(e)).unwrap()),
            ));
        }
    }
    // Every event type, as an event blob.
    for (label, o) in ["root", "message", "leave", "kick", "dissolve"]
        .iter()
        .zip(objects())
    {
        let blob = encode_event_blob(&o).unwrap();
        let v = if *label == "message" {
            hex::encode(&blob)
        } else {
            digest(&blob)
        };
        out.push((format!("{label} event blob"), v));
    }
    // Every frame kind, every query operation, every status, in a plaintext of its own.
    let mut frames: Vec<(String, Frame)> = Vec::new();
    let message = encode_event_blob(&objects().remove(1)).unwrap();
    frames.push(("event frame".into(), Frame::Event(message.clone())));
    for (i, op) in all_ops().into_iter().enumerate() {
        frames.push((format!("query op {i}"), query(vec![QueryEntry::Op(op)])));
    }
    for s in [
        Status::NotAvailable,
        Status::Restart,
        Status::Expired,
        Status::Malformed,
        Status::Unsupported,
        Status::Busy,
    ] {
        frames.push((format!("status {s:?}"), response(ResponseResult::Status(s))));
    }
    frames.push((
        "response event".into(),
        response(ResponseResult::Event(message)),
    ));
    frames.push((
        "response page".into(),
        response(ResponseResult::Page(Page {
            scan_id: ScanId::from_bytes([2; 32]),
            offset: 0,
            count: 2,
            entries: vec![entry(1), entry(2)],
        })),
    ));
    frames.push((
        "response keys".into(),
        response(ResponseResult::Keys(alice.public.to_bytes())),
    ));
    frames.push((
        "notice".into(),
        Frame::Notice(Notice {
            entries: vec![entry(1), entry(3)],
        }),
    ));
    let c = ChatId::from_bytes([1; 32]);
    frames.push((
        "neighbor request".into(),
        Frame::NeighborRequest(NeighborRequest { chat_id: c }),
    ));
    frames.push((
        "neighbor response".into(),
        Frame::NeighborResponse(NeighborResponse {
            chat_id: c,
            accepted: false,
            suggestions: vec![GossipId::from_bytes([3; 32])],
        }),
    ));
    frames.push((
        "leave request".into(),
        Frame::LeaveRequest(LeaveRequest { chat_id: c }),
    ));
    for (label, f) in frames {
        let bytes = encode_plaintext(&[f]).unwrap();
        let v = if label == "response keys" {
            digest(&bytes)
        } else {
            hex::encode(&bytes)
        };
        out.push((label, v));
    }
    out
}

#[test]
fn golden_vectors() {
    let expected = include_str!("golden.txt");
    let got: String = golden_values()
        .into_iter()
        .map(|(k, v)| format!("{k}: {v}\n"))
        .collect();
    if std::env::var("GROUPS_PRINT_GOLDEN").is_ok() {
        print!("{got}");
    }
    assert_eq!(got, expected);
}

/// One stored signature per signing context, which must verify (§4.1, §5.3, §5.6, §5.8): a
/// change of a context string, of the signed ID or of the verification fails here.
#[test]
fn stored_signatures_verify() {
    if std::env::var("GROUPS_PRINT_GOLDEN").is_ok() {
        for (k, o) in ["root", "message", "leave", "kick", "dissolve"]
            .iter()
            .zip(objects())
        {
            let sig = match o {
                EventObject::Root(r) => r.signature().as_bytes().to_vec(),
                EventObject::Leave(l) => l.signature().as_bytes().to_vec(),
                EventObject::Kick(k) => k.signature().as_bytes().to_vec(),
                EventObject::Dissolve(d) => d.signature().as_bytes().to_vec(),
                EventObject::Message(_) => continue,
            };
            println!("SIG {k}: {}", hex::encode(sig));
        }
    }
    let stored: BTreeMap<&str, Vec<u8>> = include_str!("golden_signatures.txt")
        .lines()
        .filter_map(|l| l.split_once(": "))
        .map(|(k, v)| (k, hex::decode(v).unwrap()))
        .collect();
    let alice = identity(1);
    let bob = identity(2);
    let root = founding(&alice, &[&alice, &bob]);
    let stored_root = crate::Root::from_fields(
        root.version(),
        root.root_type(),
        root.name().to_owned(),
        root.parents(),
        root.members(),
        root.group_secret(),
        root.owner_bytes().to_vec(),
        root.epoch_challenge(),
        root.ref_chat_id_challenge(),
        root.created_at(),
        root.migrate_from(),
        root.message_timer(),
        root.settings(),
        &stored["root"],
    )
    .unwrap();
    stored_root.verify_signature(None).unwrap();
    crate::Leave::from_fields(root.chat_id(), bob.id, &stored["leave"])
        .unwrap()
        .verify(&root, &bob.public)
        .unwrap();
    crate::Kick::from_fields(root.chat_id(), bob.id, &stored["kick"])
        .unwrap()
        .verify(&root)
        .unwrap();
    crate::Dissolve::from_fields(root.chat_id(), true, &stored["dissolve"])
        .unwrap()
        .verify(&root)
        .unwrap();
    // Each one fails under another context.
    assert!(
        crate::Kick::from_fields(root.chat_id(), bob.id, &stored["leave"])
            .unwrap()
            .verify(&root)
            .is_err()
    );
}
