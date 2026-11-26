import { radioPriorityOf } from '@massalabs/gossip-sdk';
import type {
  GroupMessage,
  GroupRadioReceived,
  GroupRadioRelay,
  GroupService,
} from '@massalabs/gossip-sdk';

/**
 * Puts group messages that travelled online on the air for members who only
 * have radio (a relay: a temporary copy, see `groups::radio`).
 *
 * - **Demand.** A member is taken to have radio only when this device heard
 *   one of their radio messages before any internet copy, in the last
 *   {@link RADIO_ONLY_WINDOW_MS}. A group's messages are relayed only while
 *   such a member is known, unless their author asked for radio priority.
 * - **Override.** The author chooses per message (`radioPriorityOf`): `none`
 *   is never relayed, `priority` always and first.
 * - **Freshness.** Only messages written in the last {@link FRESH_MS}, and
 *   after the radio was connected: a backlog never goes on the air.
 * - **Order.** Priority first, then replies to a radio-only member, then
 *   chats of a few members, then the newest and the shortest.
 * - **Who relays.** Every device with a radio may; each waits longer the
 *   worse it heard the radio-only members, and gives up when it hears the
 *   relay (or the message itself) on the air. The author's own device goes
 *   first. When every radio-only member was heard directly, the relay is
 *   sent zero-hop: repeaters do not carry it.
 */

export const RADIO_ONLY_WINDOW_MS = 30 * 60_000;
export const FRESH_MS = 10 * 60_000;
/** Between two relays of this device: the radio queues few frames. */
export const SPACING_MS = 2_000;
/** A chat of at most this many members goes before larger groups. */
const SMALL_GROUP = 4;

interface Heard {
  at: number;
  snr: number;
  hops: number;
}

interface Pending {
  ref: string;
  message: GroupMessage;
  rank: number;
  readyAt: number;
  zeroHop: boolean;
}

export interface ForwarderDeps {
  groups: Pick<GroupService, 'timeline' | 'radioRecords' | 'sealRadioRelay'>;
  /** This account's user ID. */
  me: string;
  /** Members of a group (for the order of small chats). */
  memberCount: (groupId: string) => number;
  /** Puts a datagram on the air, flooded or zero-hop. */
  send: (datagram: Uint8Array, zeroHop: boolean) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** The start of a `syncObjId` a relay names its message by. */
export const relayRef = (syncObjId: string): string => syncObjId.slice(0, 16);

export class RadioForwarder {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly startedAt: number;
  /** Per group, the members heard by radio only, and how. */
  private readonly heard = new Map<string, Map<string, Heard>>();
  /** Messages already looked at, by `syncObjId`. */
  private readonly seen = new Set<string>();
  /** Relays heard (or sent), by reference: never relayed again. */
  private readonly done = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSent = -Infinity;
  private sending = false;
  private stopped = false;

  constructor(private readonly deps: ForwarderDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.startedAt = this.now();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  /** Relays waiting, for tests and diagnostics. */
  get queued(): string[] {
    return [...this.pending.keys()];
  }

  /**
   * A datagram this device heard, with the signal it came with: a radio
   * message newly accepted tells that its author has radio only; any copy
   * of a message on the air ends the wait to relay it.
   */
  heardOnRadio(
    r: GroupRadioReceived | GroupRadioRelay,
    snr: number,
    hops: number
  ): void {
    const ref = r.kind === 'message' ? relayRef(r.syncObjId) : r.syncRef;
    this.done.add(ref);
    this.pending.delete(ref);
    if (r.kind === 'message') {
      this.seen.add(r.syncObjId);
      if (r.accepted && !r.olderKey && r.author !== this.deps.me) {
        let members = this.heard.get(r.groupId);
        if (!members) this.heard.set(r.groupId, (members = new Map()));
        members.set(r.author, { at: this.now(), snr, hops });
      }
    }
  }

  /** The members of a group heard by radio only lately, but for `except`. */
  private radioOnly(groupId: string, except: string): Map<string, Heard> {
    const out = new Map<string, Heard>();
    const since = this.now() - RADIO_ONLY_WINDOW_MS;
    for (const [m, h] of this.heard.get(groupId) ?? []) {
      if (h.at >= since && m !== except) out.set(m, h);
    }
    return out;
  }

  /** The messages of a group changed: queues the relays they call for. */
  async groupChanged(groupId: string): Promise<void> {
    if (this.stopped) return;
    const timeline = await this.deps.groups.timeline(groupId);
    const now = this.now();
    const fresh = timeline.filter(
      (i): i is GroupMessage =>
        i.kind === 'message' &&
        !this.seen.has(i.syncObjId) &&
        i.body.type === 'text' &&
        Number(i.createdAt) >= Math.max(now - FRESH_MS, this.startedAt)
    );
    for (const m of timeline) {
      if (m.kind === 'message') this.seen.add(m.syncObjId);
    }
    if (fresh.length === 0) return;
    // Those that travelled by radio already are on the air.
    const records = await this.deps.groups.radioRecords(
      fresh.map(m => m.syncObjId)
    );
    for (const m of fresh) {
      const ref = relayRef(m.syncObjId);
      if (records.has(m.syncObjId) || this.done.has(ref)) continue;
      const priority = radioPriorityOf(m.metadata);
      if (priority === 'none') continue;
      const targets = this.radioOnly(groupId, m.author);
      if (priority === 'auto' && targets.size === 0) continue;
      const repliesToTarget = m.replyTo.some(
        r => r.message !== null && targets.has(r.message.author)
      );
      const rank =
        priority === 'priority'
          ? 0
          : repliesToTarget
            ? 1
            : this.deps.memberCount(groupId) <= SMALL_GROUP
              ? 2
              : 3;
      this.pending.set(ref, {
        ref,
        message: m,
        rank,
        readyAt: now + this.wait(m, targets),
        zeroHop:
          targets.size > 0 && [...targets.values()].every(h => h.hops === 0),
      });
    }
    this.schedule();
  }

  /**
   * How long to wait before relaying: the author first, then the devices
   * that heard the radio-only members best, with some jitter.
   */
  private wait(m: GroupMessage, targets: Map<string, Heard>): number {
    const jitter = this.random() * 500;
    if (m.author === this.deps.me) return 300 + jitter;
    if (targets.size === 0) return 2_000 + this.random() * 4_000;
    const best = Math.max(...[...targets.values()].map(h => h.snr));
    return 500 + Math.min(6_000, Math.max(0, (10 - best) * 400)) + jitter;
  }

  private schedule(): void {
    if (this.stopped || this.sending) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size === 0) return;
    const first = Math.min(...[...this.pending.values()].map(p => p.readyAt));
    const at = Math.max(first, this.lastSent + SPACING_MS);
    this.timer = setTimeout(
      () => void this.sendNext(),
      Math.max(0, at - this.now())
    );
  }

  /** Sends the first relay ready, in the order of the module comment. */
  private async sendNext(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    const now = this.now();
    const ready: Pending[] = [];
    for (const p of this.pending.values()) {
      if (Number(p.message.createdAt) < now - FRESH_MS) {
        this.pending.delete(p.ref);
      } else if (p.readyAt <= now) {
        ready.push(p);
      }
    }
    ready.sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(b.message.createdAt) - Number(a.message.createdAt) ||
        textLength(a.message) - textLength(b.message)
    );
    const next = ready[0];
    if (next) {
      this.pending.delete(next.ref);
      this.done.add(next.ref);
      this.sending = true;
      try {
        const datagram = await this.deps.groups.sealRadioRelay(next.message);
        if (datagram && !this.stopped) {
          await this.deps.send(datagram, next.zeroHop);
          this.lastSent = this.now();
        }
      } catch {
        // A relay is best effort: the message itself arrives online.
      } finally {
        this.sending = false;
      }
    }
    this.schedule();
  }
}

function textLength(m: GroupMessage): number {
  return m.body.type === 'text' ? m.body.text.length : 0;
}
