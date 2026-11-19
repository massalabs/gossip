use prost::Message;

use super::*;
use crate::ids::{ChatId, EventId, GossipId, RequestId, ScanId, SyncObjId};
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

fn one_frame(bytes: Vec<u8>) -> Result<Frame> {
    let mut p = decode_plaintext(&plaintext_of(vec![bytes])).unwrap();
    assert_eq!(p.frames.len(), 1);
    p.frames.remove(0)
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
    let empty = decode_plaintext(&[0x01]).unwrap();
    assert!(empty.frames.is_empty());
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
    let Ok(Frame::Response(r)) = &p.frames[0] else {
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
    let p = decode_plaintext(&bytes).unwrap();
    assert!(p.frames[0].is_ok());
    assert_eq!(p.frames[1], Err(Error::Malformed("unknown field")));
    assert_eq!(p.frames[2], Err(Error::Missing("frame kind")));
    assert!(p.frames[3].is_ok());
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
    assert_eq!(decode_plaintext(&bytes).unwrap().frames, vec![Ok(frame)]);
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
    let decoded: Vec<Frame> = decode_plaintext(&bytes)
        .unwrap()
        .frames
        .into_iter()
        .map(|f| f.unwrap())
        .collect();
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
    // Valid empty end page.
    assert!(one_frame(raw_page(vec![], 0)).is_ok());
    // Empty page with a positive count.
    assert_eq!(
        one_frame(raw_page(vec![], 3)),
        Err(Error::NotAllowed("page count"))
    );
    // Count below the number of entries.
    assert_eq!(
        one_frame(raw_page(vec![e(1), e(2)], 1)),
        Err(Error::NotAllowed("page count"))
    );
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
    assert!(matches!(one_frame(bad), Err(Error::BadLength { .. })));
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
    assert!(matches!(
        one_frame(frame),
        Err(Error::TooMany {
            field: "page bytes",
            ..
        })
    ));
}

#[test]
fn entry_id_lengths() {
    let raw = |kind: proto::ObjectKind, id_len: usize| {
        frame_bytes(proto::FrameKind::Notice(proto::Notice {
            entries: vec![proto::Entry {
                chat_id: vec![1; 32],
                kind: kind as i32,
                id: vec![2; id_len],
            }],
        }))
    };
    for (kind, len) in [
        (proto::ObjectKind::Event, 24),
        (proto::ObjectKind::Root, 0),
        (proto::ObjectKind::Leave, 32),
        (proto::ObjectKind::Kick, 32),
        (proto::ObjectKind::Dissolve, 32),
    ] {
        assert!(one_frame(raw(kind, len)).is_ok());
        assert!(matches!(
            one_frame(raw(kind, len + 1)),
            Err(Error::BadLength { .. })
        ));
    }
    assert!(one_frame(raw(proto::ObjectKind::Event, 32)).is_err());
    let bad_chat = frame_bytes(proto::FrameKind::Notice(proto::Notice {
        entries: vec![proto::Entry {
            chat_id: vec![1; 24],
            kind: 1,
            id: vec![],
        }],
    }));
    assert!(matches!(one_frame(bad_chat), Err(Error::BadLength { .. })));
}

#[test]
fn notice_limits() {
    let entries: Vec<Entry> = (0..129).map(entry).collect();
    assert!(
        encode_plaintext(&[Frame::Notice(Notice {
            entries: entries[..128].to_vec()
        })])
        .is_ok()
    );
    assert!(matches!(
        encode_plaintext(&[Frame::Notice(Notice {
            entries: entries.clone()
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
    let decoded: Vec<Frame> = decode_plaintext(&bytes)
        .unwrap()
        .frames
        .into_iter()
        .map(|f| f.unwrap())
        .collect();
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
