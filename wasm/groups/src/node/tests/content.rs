//! Reactions and media as the engine offers them (§7.6): publishing, the timeline, the
//! changes, and the media data read on its own.

use super::*;
use crate::display::VisibleMessage;
use crate::event::{Media, MessageType};
use crate::node::records::ChangeKind;

const THUMBS_UP: &str = "\u{1f44d}";

/// Two devices of one epoch, neighbors of each other.
fn pair() -> Net {
    let mut net = Net::new(2, 2);
    for d in 0..2 {
        net.tick(d);
    }
    net.exchange();
    net
}

impl Net {
    fn react(&mut self, d: usize, target: SyncObjId, emoji: &str, add: bool) -> Published {
        let now = self.now;
        let chat = self.chat();
        let dev = &mut self.devs[d];
        dev.node
            .publish_reaction(
                &mut dev.store,
                chat,
                target,
                emoji.to_owned(),
                add,
                now,
                &mut self.rng,
            )
            .unwrap()
    }

    fn messages(&self, d: usize) -> Vec<VisibleMessage> {
        self.devs[d]
            .node
            .timeline(&self.devs[d].store, &self.chat(), self.now)
            .unwrap()
            .into_iter()
            .filter_map(|i| match i {
                TimelineItem::Message(m) => Some(m),
                TimelineItem::Line { .. } => None,
            })
            .collect()
    }

    fn reactions(&self, d: usize) -> Vec<Vec<(GossipId, String)>> {
        self.messages(d).into_iter().map(|m| m.reactions).collect()
    }

    fn changes(&mut self, d: usize) -> Vec<ChangeKind> {
        let now = self.now;
        let dev = &mut self.devs[d];
        dev.node
            .take_changes(&mut dev.store, now, &mut self.rng)
            .unwrap()
            .into_iter()
            .map(|c| c.kind)
            .collect()
    }
}

fn sync_of(e: &MessageEvent) -> SyncObjId {
    e.payload().sync_obj_id()
}

#[test]
fn a_reaction_shows_on_its_target_on_every_device_until_it_is_removed() {
    let mut net = pair();
    let hello = net.publish(0, "hello");
    net.exchange();
    net.changes(0);
    net.now += MIN;
    let added = net.react(1, sync_of(&hello), THUMBS_UP, true);
    assert_eq!(added.merge, Merge::Won);
    assert_eq!(
        added.event.payload().sync_obj_id(),
        crate::hash::reaction_sync_obj_id(&sync_of(&hello), &member(1), THUMBS_UP)
    );
    net.exchange();
    for d in 0..2 {
        // The reaction is listed on its target, never as a message of its own.
        assert_eq!(
            net.reactions(d),
            vec![vec![(member(1), THUMBS_UP.to_owned())]],
            "device {d}"
        );
    }
    assert!(net.changes(0).contains(&ChangeKind::Messages));
    // Two emojis of one author, and one of another, sorted by author then emoji.
    net.react(1, sync_of(&hello), "+", true);
    net.react(0, sync_of(&hello), THUMBS_UP, true);
    net.exchange();
    let mut expected = vec![
        (member(0), THUMBS_UP.to_owned()),
        (member(1), "+".to_owned()),
        (member(1), THUMBS_UP.to_owned()),
    ];
    expected.sort();
    assert_eq!(net.reactions(0), vec![expected.clone()]);
    assert_eq!(net.reactions(1), vec![expected]);
    // Removed: a later version of the same object.
    net.now += MIN;
    let removed = net.react(1, sync_of(&hello), THUMBS_UP, false);
    assert_eq!(sync_of(&removed.event), sync_of(&added.event));
    net.exchange();
    let mut left = vec![
        (member(0), THUMBS_UP.to_owned()),
        (member(1), "+".to_owned()),
    ];
    left.sort();
    for d in 0..2 {
        assert_eq!(net.reactions(d), vec![left.clone()]);
    }
    // And added again.
    net.now += MIN;
    net.react(1, sync_of(&hello), THUMBS_UP, true);
    net.exchange();
    assert_eq!(net.reactions(0)[0].len(), 3);
}

#[test]
fn a_reaction_cannot_be_deleted_and_is_not_shown_without_its_target() {
    let mut net = pair();
    let hello = net.publish(0, "hello");
    net.exchange();
    let r = net.react(1, sync_of(&hello), THUMBS_UP, true);
    // A deletion of a reaction is refused here, and has no effect when received.
    let now = net.now;
    let chat = net.chat();
    let dev = &mut net.devs[1];
    assert_eq!(
        dev.node
            .publish_deletion(
                &mut dev.store,
                chat,
                sync_of(&r.event),
                None,
                now,
                &mut net.rng
            )
            .map(|p| p.merge),
        Err(NodeError::Change(ChangeError::Invalid(Error::NotAllowed(
            "a reaction"
        ))))
    );
    let forged = MessageEvent::create(
        &net.root,
        EventId::new(now, [0x33; 16]),
        &[],
        Payload::Delete {
            sync_obj_id: sync_of(&r.event),
            scheduled_at: None,
        },
    )
    .unwrap();
    // Device 0 holds it before the reaction, device 1 after.
    net.give(0, 1, &forged);
    net.give(1, 0, &forged);
    net.exchange();
    assert_eq!(
        net.reactions(0),
        vec![vec![(member(1), THUMBS_UP.to_owned())]]
    );
    assert_eq!(
        net.reactions(1),
        vec![vec![(member(1), THUMBS_UP.to_owned())]]
    );
    // A reaction to a message the device does not hold is shown nowhere.
    net.react(1, SyncObjId::from_bytes([0x99; 32]), "?", true);
    net.exchange();
    assert_eq!(net.messages(0).len(), 1);
    // Once its target is deleted, the reaction is not listed, though it is kept.
    net.now += MIN;
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .publish_deletion(
            &mut dev.store,
            chat,
            sync_of(&hello),
            None,
            now,
            &mut net.rng,
        )
        .unwrap();
    net.exchange();
    assert!(net.messages(0).is_empty() && net.messages(1).is_empty());
    let kept = net.devs[0]
        .store
        .object(&chat, &sync_of(&r.event))
        .unwrap()
        .and_then(|o| o.current);
    assert!(matches!(kept, Some(crate::store::StoredResult::Content(c)) if c.is_reaction()));
}

#[test]
fn media_is_listed_by_its_length_and_read_by_id() {
    let mut net = pair();
    let data: Vec<u8> = (0..20_000u32).map(|i| i as u8).collect();
    let now = net.now;
    let chat = net.chat();
    let dev = &mut net.devs[0];
    let p = dev
        .node
        .publish_media(
            &mut dev.store,
            chat,
            "image/png".to_owned(),
            data.clone(),
            BTreeMap::from([("name".to_owned(), b"cat.png".to_vec())]),
            now,
            &mut net.rng,
        )
        .unwrap();
    net.exchange();
    let sync = sync_of(&p.event);
    for d in 0..2 {
        let m = &net.messages(d)[0];
        // The timeline carries the mimetype and the length, not the data (no text limit
        // applies to it).
        assert_eq!(
            m.content.body,
            Body::Media(Media {
                mimetype: "image/png".into(),
                data: vec![],
            })
        );
        assert_eq!(m.data_len, Some(20_000));
        assert_eq!(m.content.metadata["name"], b"cat.png");
        // The result hash is the one of the whole result.
        assert_eq!(m.result_hash, p.event.result_hash());
        let dev = &net.devs[d];
        assert_eq!(
            dev.node.media(&dev.store, &chat, &sync, net.now).unwrap(),
            Some(Media {
                mimetype: "image/png".into(),
                data: data.clone(),
            })
        );
    }
    // A forwarded media message, likewise.
    let forwarded = Media {
        mimetype: "text/vcard".into(),
        data: b"BEGIN:VCARD".to_vec(),
    };
    let now = net.now;
    let dev = &mut net.devs[1];
    let f = dev
        .node
        .publish_message(
            &mut dev.store,
            chat,
            Body::Forward {
                content_type: MessageType::Media,
                content: forwarded.encode(),
            },
            BTreeMap::new(),
            None,
            now,
            &mut net.rng,
        )
        .unwrap();
    net.exchange();
    let m = net
        .messages(0)
        .into_iter()
        .find(|m| m.sync_obj_id() == sync_of(&f.event))
        .unwrap();
    assert_eq!(m.data_len, Some(11));
    assert_eq!(
        m.content.body,
        Body::Forward {
            content_type: MessageType::Media,
            content: Media {
                mimetype: "text/vcard".into(),
                data: vec![],
            }
            .encode(),
        }
    );
    let dev = &net.devs[0];
    assert_eq!(
        dev.node
            .media(&dev.store, &chat, &sync_of(&f.event), net.now)
            .unwrap(),
        Some(forwarded)
    );
    // Text has no length of data and no media to read; an unknown ID neither.
    let t = net.publish(0, "t");
    let dev = &net.devs[0];
    assert_eq!(
        dev.node.media(&dev.store, &chat, &sync_of(&t), net.now),
        Ok(None)
    );
    assert_eq!(
        dev.node
            .media(&dev.store, &chat, &SyncObjId::from_bytes([1; 32]), net.now),
        Ok(None)
    );
    // A mimetype of another form is refused before anything is sent.
    let now = net.now;
    let dev = &mut net.devs[0];
    assert_eq!(
        dev.node
            .publish_media(
                &mut dev.store,
                chat,
                "image/png; q=1".to_owned(),
                vec![],
                BTreeMap::new(),
                now,
                &mut net.rng,
            )
            .map(|p| p.merge),
        Err(NodeError::Change(ChangeError::Invalid(Error::NotAllowed(
            "mimetype"
        ))))
    );
}
