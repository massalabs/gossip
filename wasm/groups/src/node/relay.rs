//! What this device publishes that leaves like a relay (§10.2, §10.3): a message or a Retry
//! attributed to another member, and every edit that is not the user's own edit of the
//! user's own message (see [`Node::disseminate_own`]).
//!
//! Such an event is handled as if another member had delivered it to this device and this
//! device relayed it (D.95, decided by the owner on 2026-11-27):
//!
//! 1. it keeps its TRUE timestamp, and is shown on this device at once;
//! 2. the device waits a random time, uniform between [`RELAY_WAIT_MIN_MS`] and
//!    [`RELAY_WAIT_MAX_MS`] (provisional, D.96), durably: a restart during the wait still
//!    sends the notices once it is over;
//! 3. then it writes ONE hint, "this peer has this event", for the event only, and queues
//!    notices to exactly the normal set of a dissemination (the eligible neighbors plus the
//!    random extra peers, §10.2), nothing added or removed for anyone;
//! 4. a request for the event is answered with the full event, whoever asks, as for any
//!    event (§10.3: hints never stop an answer).
//!
//! The hint names the claimed author when the event is attributed to another member ("they
//! sent it to me"), whether or not that member is a neighbor. For an edit that gives the
//! message to the user it names ONE peer drawn at random INSIDE the notice set: the previous
//! author would point at who gave the message up, and a peer outside the set would be one
//! this device never notifies, whom the hint would then keep from ever being told. An entry
//! only says "this peer has this event", which becomes true once that peer fetched it. In a
//! chat of two the only peer is the previous author, who knows anyway.
//!
//! The peer the hint names is notified anyway when it is in the set: the hint is written
//! after the notices are queued, and the one notice to that peer is not cancelled by it at
//! assembly ([`Node::notify_despite_hint`]). Why the claimed author is not forced into the
//! set: in a chat of 500, notices that always take a route through the claimed author
//! would be observable.
//!
//! Not imitated on purpose (known limits, §16.13): the sample of ancestors a real arrival
//! marks as seen by the deliverer (the claimed author may lack them, and the device would
//! then skip real notices to that member); the credit a deliverer gets in the peer score
//! (postponed).

use super::timing::{RELAY_WAIT_MAX_MS, RELAY_WAIT_MIN_MS, relay_wait};
use super::{Cx, EpochEntry, Form, Node, NodeError};
use crate::event::{MessageEvent, Payload};
use crate::ids::{ChatId, EventId, GossipId};
use crate::rng::uniform_below;

use super::records::Relay;

// Both bounds are part of the documented behaviour; keep them used in the docs.
const _: () = assert!(RELAY_WAIT_MIN_MS <= RELAY_WAIT_MAX_MS);

impl Node {
    /// Records that `event`, just published by this device, leaves like a relay once a
    /// random wait is over (see the module documentation). Nothing is queued now.
    pub(crate) fn defer_relay(
        &mut self,
        cx: &mut Cx<'_>,
        entry: &EpochEntry,
        event: &MessageEvent,
    ) {
        let chat = entry.root.chat_id();
        let wait = relay_wait(cx.rng);
        let due = cx.now.saturating_add(wait);
        self.t
            .relays
            .insert((chat, event.event_id()), Relay { due, notify: None });
        dbg_event!(Debug, "engine.publish.relay_like", {
            "step" => "waiting", "epoch" => crate::debug::short(&chat),
            "id" => crate::debug::short(&event.event_id()), "wait" => wait,
            "as_other" => matches!(event.payload(), Payload::Content(c) if c.author != self.me),
        });
    }

    /// The earliest relay still waiting.
    pub(crate) fn relay_wakeup(&self) -> Option<u64> {
        self.t
            .relays
            .iter()
            .filter(|(_, r)| r.notify.is_none())
            .map(|(_, r)| r.due)
            .min()
    }

    /// Writes the hint and queues the notices of every relay whose wait is over.
    pub(crate) fn relay_timers(&mut self, cx: &mut Cx<'_>) -> Result<(), NodeError> {
        let due: Vec<(ChatId, EventId)> = self
            .t
            .relays
            .iter()
            .filter(|(_, r)| r.notify.is_none() && r.due <= cx.now)
            .map(|(k, _)| *k)
            .collect();
        for (chat, id) in due {
            self.t.relays.remove(&(chat, id));
            self.fire_relay(cx, chat, id)?;
        }
        Ok(())
    }

    fn fire_relay(&mut self, cx: &mut Cx<'_>, chat: ChatId, id: EventId) -> Result<(), NodeError> {
        let Some(entry) = self.epochs.get(&chat).cloned() else {
            return Ok(());
        };
        // A device no longer active in the group sends nothing (§10.4, D.74).
        if !self.serves(&chat) {
            return Ok(());
        }
        // Only an event still held and available is announced (§10.2); one pruned or
        // replaced during the wait has nothing left to announce.
        let Some(event) = entry.epoch().serve(cx.ov, &id, cx.now)? else {
            return Ok(());
        };
        let Payload::Content(content) = event.payload() else {
            return Ok(());
        };
        let author = content.author;
        let recipients = self.disseminate(cx, &entry, &event, Form::Notice, true)?;
        // Who the hint names (D.97): the claimed author, or for a re-appropriation one peer
        // drawn uniformly inside the notice set.
        let named: Option<GossipId> = if author == self.me {
            (!recipients.is_empty()).then(|| recipients[uniform_below(cx.rng, recipients.len())])
        } else {
            Some(author)
        };
        if let Some(peer) = named {
            // Written after the notices are queued, so that it does not cancel the one to
            // `peer`; for the event only, never its ancestors (see the module documentation).
            // A hint that exists already keeps its first time: it is never rewritten.
            self.put_hint(chat, peer, id, cx.now);
            if recipients.contains(&peer) && self.notice_queued(peer, chat, id) {
                self.t.relays.insert(
                    (chat, id),
                    Relay {
                        due: cx.now,
                        notify: Some(peer),
                    },
                );
            }
        }
        dbg_event!(Debug, "engine.publish.relay_like", {
            "step" => "announced", "epoch" => crate::debug::short(&chat),
            "id" => crate::debug::short(&id), "notices" => recipients.len(),
            "hint_in_set" => named.is_some_and(|p| recipients.contains(&p)),
            "as_other" => author != self.me,
        });
        Ok(())
    }

    /// Whether the notice of `id` to `peer` must be sent although a hint says `peer` has
    /// the event: it is the peer the hint of a relay-like publication names, and in its
    /// notice set (see the module documentation).
    pub(crate) fn notify_despite_hint(&self, chat: ChatId, peer: GossipId, id: EventId) -> bool {
        self.t
            .relays
            .get(&(chat, id))
            .is_some_and(|r| r.notify == Some(peer))
    }

    /// The notice of `id` to `peer` left the queue (handed off, or dropped): the record that
    /// kept the hint from cancelling it is not needed any more.
    pub(crate) fn notice_left_queue(&mut self, chat: ChatId, peer: GossipId, id: EventId) {
        if self.notify_despite_hint(chat, peer, id) {
            self.t.relays.remove(&(chat, id));
        }
    }

    /// Forgets the relays of the epoch `chat` (its messages are erased).
    pub(crate) fn forget_relays_in(&mut self, chat: &ChatId) {
        let keys: Vec<(ChatId, EventId)> = self
            .t
            .relays
            .keys()
            .filter(|k| k.0 == *chat)
            .copied()
            .collect();
        for k in keys {
            self.t.relays.remove(&k);
        }
    }
}
