/**
 * Group chats (plausibly deniable group chats, `docs/plausibly-deniable-group-chats.md`).
 *
 * The protocol runs in the wasm engine (`GroupsNode`); this service gives it
 * time, storage and transport:
 *
 * - **Storage.** The engine is opened from the account's group records and
 *   every batch it commits is persisted in one transaction before anything it
 *   produced is encrypted (the binding refuses `is_current` until then). If a
 *   write fails, the engine is reopened from the database.
 * - **Transport.** A group plaintext travels in the one-to-one session of each
 *   recipient, inside a keep-alive (`serializeGroupPlaintext`). Right before
 *   encryption the plaintext is checked (`is_current`); its ciphertext is stored
 *   in the group outbox together with `handed_off`, then sent; `published` once
 *   the transport took it. A ciphertext that failed is retried as stored.
 * - **Time.** The engine is ticked at its `next_wakeup` and after each
 *   operation.
 *
 * Nothing about group traffic is logged or stored outside the engine's own
 * records and the outbox (which names a recipient, never a group).
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { GroupsNode, SessionStatus } from '../wasm/bindings.js';
import type { SessionModule } from '../wasm/session.js';
import type { IMessageProtocol } from '../api/messageProtocol/types.js';
import type { Queries, GroupBatch } from '../db/queries/index.js';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter.js';
import type { SdkConfig } from '../config/sdk.js';
import { serializeGroupPlaintext } from '../utils/messageSerialization.js';
import { decodeUserId, encodeUserId } from '../utils/userId.js';
import { Logger } from '../utils/logs.js';

const logger = new Logger('GroupService');

/** Group identifiers (group keys, epochs, sync objects) are lowercase hex. */
export type GroupId = string;

export type GroupMemberStatus =
  | 'member'
  | 'waiting'
  | 'left'
  | 'removed'
  | 'dissolved'
  | 'dissolved-deleted';

export interface GroupSummary {
  /** The group key (local). */
  groupId: GroupId;
  /** The current epoch, where new messages go. */
  currentEpoch: GroupId;
  name: string;
  localName: string | null;
  /** Gossip user IDs of the members of the current epoch. */
  members: string[];
  owner: string;
  status: GroupMemberStatus;
  sideBranches: GroupId[];
  /** This device owns competing ends and must resolve them before sending. */
  mustResolve: boolean;
  links: GroupId[];
}

export interface GroupInvitation {
  /** The epoch to accept or decline. */
  epochId: GroupId;
  name: string;
  members: string[];
  owner: string;
  /** The member that delivered it, when it is not the owner. */
  receivedFrom: string | null;
  /** It was closed on this device before: deleted content may reappear. */
  closedBefore: boolean;
  /** Accepting rejoins this group. */
  rejoins: GroupId | null;
}

export type GroupMessageBody =
  | { type: 'text'; text: string }
  | { type: 'forward'; contentType: string; content: Uint8Array }
  | { type: 'reaction'; reaction: Uint8Array }
  | { type: 'media'; media: Uint8Array };

export interface GroupMessage {
  kind: 'message';
  epochId: GroupId;
  syncObjId: GroupId;
  author: string;
  createdAt: number;
  lastModifiedAt: number;
  /** "Edited at" is shown (a claim, not a proof). */
  edited: boolean;
  body: GroupMessageBody;
  metadata: Record<string, Uint8Array>;
}

export type GroupLine =
  | { type: 'founded'; epoch: GroupId; owner: string }
  | {
      type: 'epochChange';
      epoch: GroupId;
      owner: string;
      added: string[];
      removed: string[];
      left: string[];
      renamed: string | null;
      newOwner: string | null;
    }
  | { type: 'youWereRemoved' }
  | { type: 'youLeft' }
  | { type: 'dissolved' }
  | { type: 'notAMember'; from: number; to: number };

export type GroupTimelineItem =
  | GroupMessage
  | { kind: 'line'; at: number; line: GroupLine };

export type GroupChangeKind =
  | 'Invitation'
  | 'Joined'
  | 'Membership'
  | 'Messages'
  | 'ReadOnly'
  | 'Fork'
  | 'Closed';

export interface GroupChange {
  /** The group key, or the epoch of an invitation. */
  groupId: GroupId;
  kind: GroupChangeKind;
}

/** How a member leaves a group or declines an invitation (§5.2). */
export type LeaveChoice = 'Signed' | 'AskToBeKicked' | 'Silent';

type Raw = Record<string, unknown>;

const MAX_WAKEUP_MS = 60 * 60 * 1000;

function userIdOf(hex: string): string {
  return encodeUserId(hexToBytes(hex));
}

function hexOfUser(userId: string): string {
  return bytesToHex(decodeUserId(userId));
}

function variant(v: unknown): [string, Raw] {
  if (typeof v === 'string') return [v, {}];
  const r = v as Raw;
  return [r.t as string, r];
}

function body(raw: unknown): GroupMessageBody {
  const [t, r] = variant(raw);
  switch (t) {
    case 'Text':
      return { type: 'text', text: r.text as string };
    case 'Forward':
      return {
        type: 'forward',
        contentType: variant(r.content_type)[0],
        content: hexToBytes(r.content as string),
      };
    case 'Reaction':
      return { type: 'reaction', reaction: hexToBytes(r.reaction as string) };
    default:
      return { type: 'media', media: hexToBytes(r.media as string) };
  }
}

function bodyJson(b: GroupMessageBody): string {
  switch (b.type) {
    case 'text':
      return JSON.stringify({ t: 'Text', text: b.text });
    case 'forward':
      return JSON.stringify({
        t: 'Forward',
        content_type: b.contentType,
        content: bytesToHex(b.content),
      });
    case 'reaction':
      return JSON.stringify({
        t: 'Reaction',
        reaction: bytesToHex(b.reaction),
      });
    case 'media':
      return JSON.stringify({ t: 'Media', media: bytesToHex(b.media) });
  }
}

function metadataJson(m: Record<string, Uint8Array> | undefined): string {
  return JSON.stringify(
    Object.entries(m ?? {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, bytesToHex(v)])
  );
}

function summary(r: Raw): GroupSummary {
  const [status, s] = variant(r.status);
  return {
    groupId: r.group as string,
    currentEpoch: r.current as string,
    name: r.name as string,
    localName: (r.local_name as string | null) ?? null,
    members: (r.members as string[]).map(userIdOf),
    owner: userIdOf(r.owner as string),
    status:
      status === 'Dissolved'
        ? s.deleted
          ? 'dissolved-deleted'
          : 'dissolved'
        : (status.toLowerCase() as GroupMemberStatus),
    sideBranches: r.side_branches as string[],
    mustResolve: r.must_resolve as boolean,
    links: r.links as string[],
  };
}

function line(raw: unknown): GroupLine {
  const [t, r] = variant(raw);
  switch (t) {
    case 'Founded':
      return {
        type: 'founded',
        epoch: r.epoch as string,
        owner: userIdOf(r.owner as string),
      };
    case 'EpochChange':
      return {
        type: 'epochChange',
        epoch: r.epoch as string,
        owner: userIdOf(r.owner as string),
        added: (r.added as string[]).map(userIdOf),
        removed: (r.removed as string[]).map(userIdOf),
        left: (r.left as string[]).map(userIdOf),
        renamed: (r.renamed as string | null) ?? null,
        newOwner: r.new_owner ? userIdOf(r.new_owner as string) : null,
      };
    case 'YouWereRemoved':
      return { type: 'youWereRemoved' };
    case 'YouLeft':
      return { type: 'youLeft' };
    case 'Dissolved':
      return { type: 'dissolved' };
    default:
      return {
        type: 'notAMember',
        from: r.from as number,
        to: r.to as number,
      };
  }
}

function timelineItem(raw: unknown): GroupTimelineItem {
  const [t, r] = variant(raw);
  if (t === 'Line') {
    return { kind: 'line', at: r.at as number, line: line(r.line) };
  }
  const m = r.message as Raw;
  const c = m.content as Raw;
  return {
    kind: 'message',
    epochId: m.chat_id as string,
    syncObjId: c.sync_obj_id as string,
    author: userIdOf(c.author as string),
    createdAt: c.created_at as number,
    lastModifiedAt: c.last_modified_at as number,
    edited: c.edited as boolean,
    body: body(c.body),
    metadata: Object.fromEntries(
      (c.metadata as [string, string][]).map(([k, v]) => [k, hexToBytes(v)])
    ),
  };
}

/** The result of publishing a message, an edit or a deletion. */
export interface GroupPublished {
  eventId: GroupId;
  syncObjId: GroupId;
  /** How it merged locally: `Won`, `Lost`, `Identical` or `Pending`. */
  merge: string;
}

export class GroupService {
  private node: GroupsNode | null = null;
  /** Serializes the engine's operations with the writes they need. */
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly onSessionStatus = (p: {
    contactUserId: string;
    status: SessionStatus;
  }) => {
    void this.run(async node => {
      const peer = decodeUserId(p.contactUserId);
      const active = p.status === SessionStatus.Active;
      node.set_session(peer, active);
      if (active) node.peer_reconnected(peer, this.now());
    }).catch(() => logger.error('session status not applied'));
  };

  constructor(
    private session: SessionModule,
    private messageProtocol: IMessageProtocol,
    private queries: Queries,
    private eventEmitter: SdkEventEmitter,
    private config: SdkConfig,
    private persistFlusher: () => Promise<void>,
    /** The clock (milliseconds); replaceable in tests. */
    private now: () => number = () => Date.now()
  ) {}

  private get owner(): string {
    return this.session.userIdEncoded;
  }

  /** Whether the engine is open. */
  get isOpen(): boolean {
    return this.node !== null;
  }

  /**
   * Opens the engine from the account's records, adds the keys of the
   * contacts and the sessions known, and starts its timer.
   */
  async open(): Promise<void> {
    this.closed = false;
    await this.reopen();
    this.eventEmitter.on(
      SdkEventType.SESSION_STATUS_CHANGED,
      this.onSessionStatus
    );
    await this.run(async () => undefined);
  }

  private async reopen(): Promise<void> {
    this.node?.free();
    this.node = null;
    const snapshot = await this.queries.groups.loadSnapshot(this.owner);
    const node = GroupsNode.open(
      this.session.ourPk,
      this.session.ourSk,
      snapshot
    );
    const now = this.now();
    node.learn_keys(this.session.ourPk.to_bytes(), now);
    for (const contact of await this.queries.contacts.getByOwner(this.owner)) {
      try {
        node.learn_keys(contact.publicKeys, now);
      } catch {
        // Keys that are not canonical are not cached.
      }
    }
    for (const peer of this.session.peerList()) {
      node.set_session(
        peer,
        this.session.peerSessionStatus(peer) === SessionStatus.Active
      );
    }
    this.node = node;
    // Not through `persist`, which reopens on failure.
    await this.queries.groups.applyBatches(
      this.owner,
      node.take_batches() as GroupBatch[]
    );
  }

  /** Waits for the operation in progress, stops the timer and frees the engine. */
  async close(): Promise<void> {
    this.closed = true;
    this.eventEmitter.off(
      SdkEventType.SESSION_STATUS_CHANGED,
      this.onSessionStatus
    );
    await this.chain;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.node?.free();
    this.node = null;
  }

  // ── Operation plumbing ───────────────────────────────────────────────────

  /**
   * Runs `op` on the engine, then persists what it committed, sends what is
   * due and reports the changes; one operation at a time.
   */
  private run<T>(op: (node: GroupsNode) => Promise<T> | T): Promise<T> {
    const next = this.chain.then(async () => {
      const node = this.node;
      if (!node) throw new Error('Groups are not open');
      let result: T;
      try {
        result = await op(node);
      } finally {
        await this.persist();
      }
      await this.pump();
      return result;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Persists the pending batches; on failure the engine is reopened. */
  private async persist(
    extra?: Parameters<Queries['groups']['applyBatches']>[2]
  ): Promise<void> {
    const node = this.node;
    if (!node) return;
    const batches = node.take_batches() as GroupBatch[];
    try {
      await this.queries.groups.applyBatches(this.owner, batches, extra);
    } catch (error) {
      // The engine is ahead of the database: start again from the database.
      await this.reopen();
      throw error;
    }
  }

  /** Sends what the outbox holds and reports the changes. */
  private async pump(): Promise<void> {
    const node = this.node;
    if (!node) return;
    const now = this.now();
    node.tick(now);
    await this.persist();
    for (let round = 0; round < 64; round++) {
      const out = node.poll_outbox(this.now()) as {
        handle: number;
        to: Uint8Array;
        plaintext: Uint8Array;
      }[];
      await this.persist();
      if (out.length === 0) break;
      for (const o of out) await this.sendOne(node, o);
    }
    await this.retryOutbox();
    const changes = JSON.parse(node.take_changes(this.now())) as Raw[];
    await this.persist();
    if (changes.length > 0) {
      this.eventEmitter.emit(SdkEventType.GROUPS_CHANGED, {
        changes: changes.map(c => ({
          groupId: c.group as string,
          kind: variant(c.kind)[0] as GroupChangeKind,
        })),
      });
    }
    this.schedule();
  }

  private async sendOne(
    node: GroupsNode,
    o: { handle: number; to: Uint8Array; plaintext: Uint8Array }
  ): Promise<void> {
    if (this.session.peerSessionStatus(o.to) !== SessionStatus.Active) {
      node.abandon(o.handle);
      node.set_session(o.to, false);
      return;
    }
    if (!node.is_current(o.handle, this.now())) {
      node.abandon(o.handle);
      return;
    }
    const sent = await this.session.sendMessage(
      o.to,
      serializeGroupPlaintext(o.plaintext)
    );
    if (!sent) {
      node.abandon(o.handle);
      return;
    }
    const seeker = sent.seeker;
    const ciphertext = sent.data;
    // The ciphertext and the engine's hand-off are stored together.
    node.handed_off(o.handle, this.now());
    let id = 0;
    await this.persist(async tx => {
      id = await this.queries.groups.insertOutbox(tx, {
        ownerUserId: this.owner,
        contactUserId: encodeUserId(o.to),
        seeker,
        ciphertext,
        whenToSend: new Date(this.now()),
      });
    });
    await this.persistFlusher();
    try {
      await this.messageProtocol.sendMessage({ seeker, ciphertext });
      await this.queries.groups.deleteOutbox(id);
      node.published(o.handle, this.now());
      await this.persist();
    } catch {
      await this.queries.groups.rescheduleOutbox(
        id,
        new Date(this.now() + this.config.messages.retryDelayMs)
      );
    }
  }

  /** Sends again, as stored, the ciphertexts that failed. */
  private async retryOutbox(): Promise<void> {
    const due = await this.queries.groups.dueOutbox(
      this.owner,
      new Date(this.now())
    );
    for (const row of due) {
      try {
        await this.messageProtocol.sendMessage({
          seeker: row.seeker,
          ciphertext: row.ciphertext,
        });
        await this.queries.groups.deleteOutbox(row.id);
      } catch {
        await this.queries.groups.rescheduleOutbox(
          row.id,
          new Date(this.now() + this.config.messages.retryDelayMs)
        );
      }
    }
  }

  private schedule(): void {
    if (this.closed || !this.node) return;
    if (this.timer) clearTimeout(this.timer);
    const now = this.now();
    const at = this.node.next_wakeup(now);
    const delay = Math.min(
      MAX_WAKEUP_MS,
      Math.max(1000, (at ?? now + MAX_WAKEUP_MS) - now)
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch(() => logger.error('group timer failed'));
    }, delay);
    (this.timer as { unref?: () => void }).unref?.();
  }

  // ── Transport ────────────────────────────────────────────────────────────

  /** A group plaintext received from `from` (32-byte user ID). */
  handlePlaintext(from: Uint8Array, plaintext: Uint8Array): Promise<void> {
    return this.run(async node => {
      if (!node.keys(from)) {
        const contact = await this.queries.contacts.getByOwnerAndUser(
          this.owner,
          encodeUserId(from)
        );
        if (contact) {
          try {
            node.learn_keys(contact.publicKeys, this.now());
          } catch {
            // Not canonical keys: the engine asks for them.
          }
        }
      }
      node.handle_plaintext(from, plaintext, this.now());
    });
  }

  /** Runs the engine's timers and sends what is due. */
  tick(): Promise<void> {
    return this.run(() => undefined);
  }

  /** Adds the keys of a contact (when a contact or session is added). */
  learnKeys(publicKeys: Uint8Array): Promise<string> {
    return this.run(node =>
      encodeUserId(node.learn_keys(publicKeys, this.now()))
    );
  }

  private async learnMembers(node: GroupsNode, members: string[]) {
    for (const m of members) {
      const id = decodeUserId(m);
      if (node.keys(id)) continue;
      const contact = await this.queries.contacts.getByOwnerAndUser(
        this.owner,
        m
      );
      if (contact) node.learn_keys(contact.publicKeys, this.now());
    }
  }

  // ── Groups ───────────────────────────────────────────────────────────────

  /** Founds a group with these members (Gossip user IDs). Returns its key. */
  createGroup(name: string, members: string[]): Promise<GroupId> {
    return this.run(async node => {
      await this.learnMembers(node, members);
      const ids = new Uint8Array(members.length * 32);
      members.forEach((m, i) => ids.set(decodeUserId(m), i * 32));
      return bytesToHex(node.create_group(name, ids, this.now()));
    });
  }

  /** As the owner: adds and removes members, renames. Returns the new epoch. */
  changeMembers(
    groupId: GroupId,
    change: { add?: string[]; remove?: string[]; name?: string | null }
  ): Promise<GroupId> {
    return this.run(async node => {
      await this.learnMembers(node, change.add ?? []);
      const json = JSON.stringify({
        t: 'Successor',
        add: (change.add ?? []).map(hexOfUser),
        remove: (change.remove ?? []).map(hexOfUser),
        name: change.name ?? null,
      });
      return bytesToHex(
        node.change_group(hexToBytes(groupId), json, this.now())
      );
    });
  }

  /** As the owner: hands the group over to a member, possibly leaving it. */
  handOver(
    groupId: GroupId,
    newOwner: string,
    options: { leave?: boolean; remove?: string[]; name?: string | null } = {}
  ): Promise<GroupId> {
    return this.run(async node => {
      await this.learnMembers(node, [newOwner]);
      const json = JSON.stringify({
        t: 'Handover',
        new_owner: hexOfUser(newOwner),
        leave: options.leave ?? false,
        remove: (options.remove ?? []).map(hexOfUser),
        name: options.name ?? null,
      });
      return bytesToHex(
        node.change_group(hexToBytes(groupId), json, this.now())
      );
    });
  }

  /** As the owner: resolves competing ends with this member list (§4.9). */
  resolveFork(
    groupId: GroupId,
    members: string[],
    name?: string | null
  ): Promise<GroupId> {
    return this.run(node => {
      const json = JSON.stringify({
        t: 'Resolve',
        members: members.map(hexOfUser),
        name: name ?? null,
      });
      return bytesToHex(
        node.change_group(hexToBytes(groupId), json, this.now())
      );
    });
  }

  dissolve(groupId: GroupId, deleteMessages: boolean): Promise<void> {
    return this.run(node =>
      node.dissolve_group(hexToBytes(groupId), deleteMessages, this.now())
    );
  }

  leave(groupId: GroupId, choice: LeaveChoice): Promise<void> {
    return this.run(node =>
      node.leave_group(hexToBytes(groupId), choice, this.now())
    );
  }

  /** Deletes a kicked, left or dissolved group from this device. */
  deleteGroup(groupId: GroupId): Promise<void> {
    return this.run(node => node.delete_group(hexToBytes(groupId), this.now()));
  }

  acceptInvitation(epochId: GroupId): Promise<GroupId> {
    return this.run(node =>
      bytesToHex(node.accept_invitation(hexToBytes(epochId), this.now()))
    );
  }

  declineInvitation(epochId: GroupId, choice: LeaveChoice): Promise<void> {
    return this.run(node =>
      node.decline_invitation(hexToBytes(epochId), choice, this.now())
    );
  }

  /** Retry synchronisation: sends the current root again (§9.4). */
  resendRoot(groupId: GroupId): Promise<void> {
    return this.run(node => node.resend_root(hexToBytes(groupId), this.now()));
  }

  setLocalName(groupId: GroupId, name: string | null): Promise<void> {
    return this.run(node =>
      node.set_local_name(hexToBytes(groupId), name ?? undefined, this.now())
    );
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  private published(json: string): GroupPublished {
    const r = JSON.parse(json) as Raw;
    return {
      eventId: r.eventId as string,
      syncObjId: r.syncObjId as string,
      merge: variant(r.merge)[0],
    };
  }

  /** Sends a message to the group's current epoch. */
  sendMessage(
    groupId: GroupId,
    message: GroupMessageBody | string,
    options: {
      metadata?: Record<string, Uint8Array>;
      scheduledFor?: number;
    } = {}
  ): Promise<GroupPublished> {
    const b =
      typeof message === 'string'
        ? { type: 'text' as const, text: message }
        : message;
    return this.run(node => {
      const epoch = this.currentEpoch(node, groupId);
      return this.published(
        node.publish_message(
          hexToBytes(epoch),
          bodyJson(b),
          metadataJson(options.metadata),
          options.scheduledFor,
          this.now()
        )
      );
    });
  }

  /** Edits one of this account's messages, in the epoch that holds it. */
  editMessage(
    epochId: GroupId,
    syncObjId: GroupId,
    message: GroupMessageBody | string,
    options: {
      metadata?: Record<string, Uint8Array>;
      scheduledFor?: number;
    } = {}
  ): Promise<GroupPublished> {
    const b =
      typeof message === 'string'
        ? { type: 'text' as const, text: message }
        : message;
    return this.run(node =>
      this.published(
        node.publish_edit(
          hexToBytes(epochId),
          hexToBytes(syncObjId),
          bodyJson(b),
          metadataJson(options.metadata),
          options.scheduledFor,
          this.now()
        )
      )
    );
  }

  /** Deletes a message for everyone, now or at `scheduledFor`. */
  deleteMessage(
    epochId: GroupId,
    syncObjId: GroupId,
    scheduledFor?: number
  ): Promise<GroupPublished> {
    return this.run(node =>
      this.published(
        node.publish_deletion(
          hexToBytes(epochId),
          hexToBytes(syncObjId),
          scheduledFor,
          this.now()
        )
      )
    );
  }

  /** Deletes a message on this device only (§9.2). */
  deleteMessageLocally(epochId: GroupId, syncObjId: GroupId): Promise<void> {
    return this.run(node => {
      node.local_delete(hexToBytes(epochId), hexToBytes(syncObjId), this.now());
    });
  }

  private currentEpoch(node: GroupsNode, groupId: GroupId): GroupId {
    const g = JSON.parse(node.group(hexToBytes(groupId))) as Raw | null;
    if (!g) throw new Error('groups:unknown-epoch: unknown group');
    return g.current as string;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  private requireNode(): GroupsNode {
    if (!this.node) throw new Error('Groups are not open');
    return this.node;
  }

  list(): GroupSummary[] {
    return (JSON.parse(this.requireNode().groups()) as Raw[]).map(summary);
  }

  get(groupId: GroupId): GroupSummary | null {
    const g = JSON.parse(
      this.requireNode().group(hexToBytes(groupId))
    ) as Raw | null;
    return g ? summary(g) : null;
  }

  invitations(): GroupInvitation[] {
    return (
      JSON.parse(this.requireNode().invitations(this.now())) as Raw[]
    ).map(r => ({
      epochId: r.chat_id as string,
      name: r.name as string,
      members: (r.members as string[]).map(userIdOf),
      owner: userIdOf(r.owner as string),
      receivedFrom: r.received_from
        ? userIdOf(r.received_from as string)
        : null,
      closedBefore: r.closed_before as boolean,
      rejoins: (r.rejoins as string | null) ?? null,
    }));
  }

  /** The visible messages and lines of a group (and the groups linked to it). */
  timeline(groupId: GroupId): GroupTimelineItem[] {
    return (
      JSON.parse(
        this.requireNode().timeline(hexToBytes(groupId), this.now())
      ) as unknown[]
    ).map(timelineItem);
  }
}
