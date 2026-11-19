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
 * - **Transport.** A group plaintext travels in the session of each recipient,
 *   as a session message of the group type (`serializeGroupPlaintext`), which
 *   carries nothing else and is used for nothing else. Right before
 *   encryption the plaintext is checked (`is_current`); its ciphertext is stored
 *   in the group outbox together with `handed_off`, then sent; `published` once
 *   the transport took it. A ciphertext that failed is retried as stored,
 *   unless the server refused it for good.
 * - **Time.** The engine is ticked at its `next_wakeup` and after each
 *   operation.
 *
 * Nothing about group traffic is logged or stored outside the engine's own
 * records and the outbox (which names a recipient, never a group).
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  GroupsNode,
  SessionStatus,
  group_max_metadata_bytes,
  group_max_text_bytes,
  group_metadata_bytes,
} from '../wasm/bindings.js';
import {
  SessionMessageTooLargeError,
  type SessionModule,
} from '../wasm/session.js';
import type { IMessageProtocol } from '../api/messageProtocol/types.js';
import type { Queries, GroupBatch } from '../db/queries/index.js';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter.js';
import type { SdkConfig } from '../config/sdk.js';
import { serializeGroupPlaintext } from '../utils/messageSerialization.js';
import { decodeUserId, encodeUserId } from '../utils/userId.js';
import { Logger } from '../utils/logs.js';
import { isFinalStatus } from '../api/restClient.js';

const logger = new Logger('GroupService');

/** Group identifiers (group keys, epochs, sync objects) are lowercase hex. */
export type GroupId = string;

export type GroupMemberStatus =
  | 'member'
  | 'waiting'
  | 'left'
  | 'removed'
  | 'dissolved'
  | 'dissolved-deleted'
  /**
   * A chat of two replaced by another chat of the same two (§5.12): kept,
   * read-only, as the earlier part of the chat that continues it
   * (`supersededBy`). Never a conversation of its own.
   */
  | 'superseded';

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
  /**
   * Ends of former owners in the current owner's line (§5.9): they block
   * nothing; on the current owner's device, resolving them is offered.
   */
  formerOwnerBranches: GroupId[];
  links: GroupId[];
  /** For a superseded chat of two: the chat that continues it. */
  supersededBy: GroupId | null;
  /**
   * A chat of two (§5.12): the chats of the same two it replaced, oldest
   * first, shown before it as one conversation.
   */
  earlier: GroupId[];
  /**
   * A chat of two this device founded automatically: whether the other
   * person took part in it. Null for any other group.
   */
  tookPart: boolean | null;
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
  /**
   * The format version of the earlier conversation its root says it continues
   * (§5.12), as carried; null for an ordinary group.
   */
  migrateFrom: number | null;
  /**
   * The peer (user ID) whose earlier conversation this device shows it as
   * continuing (§5.12): shown inside that archive. Null otherwise.
   */
  migrationOf: string | null;
  /**
   * The chat of two this invitation continues (§5.12): shown inside that
   * chat as "<owner> wants to continue this conversation in a new group";
   * accepting makes it the current chat and the other its history.
   */
  continues: GroupId | null;
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
  /** Milliseconds since the epoch, as claimed by the author (any u64). */
  createdAt: bigint;
  lastModifiedAt: bigint;
  /** "Edited at" is shown (a claim, not a proof). */
  edited: boolean;
  body: GroupMessageBody;
  metadata: Record<string, Uint8Array>;
  /**
   * The messages it replies to (§7.6). `epochId` is null when the target's
   * epoch is not one this device holds in the timeline.
   */
  replyTo: { epochId: GroupId | null; syncObjId: GroupId }[];
}

/** A message a reply or a forward points to. */
export interface GroupMessageRef {
  epochId: GroupId;
  syncObjId: GroupId;
}

/** What the root of an epoch says (for the resolution of competing ends). */
export interface GroupEpoch {
  epoch: GroupId;
  name: string;
  members: string[];
  owner: string;
  createdAt: bigint;
  /** The format version of the earlier conversation it continues, or null. */
  migrateFrom: number | null;
}

/** A local-only edit (§9.1): each given field replaces the stored one. */
export interface GroupLocalEdit {
  body?: GroupMessageBody;
  author?: string;
  createdAt?: number;
  lastModifiedAt?: number;
  edited?: boolean;
}

/**
 * The size limits of a message version, read from the engine. A version over
 * either is malformed for every device.
 */
export interface GroupMessageLimits {
  /** Text in UTF-8 bytes: a text body, or the content of a forward of text. */
  textBytes: number;
  /**
   * Metadata in bytes as encoded: every key and value with the framing of
   * its entry (`replyTo` included).
   */
  metadataBytes: number;
}

/** A message or an edit over a size limit, refused before the engine is called. */
export class GroupMessageTooLargeError extends Error {
  constructor(
    readonly part: 'text' | 'metadata',
    readonly size: number,
    readonly max: number
  ) {
    super(`groups:too-large: ${part} of ${size} bytes, at most ${max}`);
    this.name = 'GroupMessageTooLargeError';
  }
}

/** The longest a date may be set ahead of now (§7.2 `MAX_SCHEDULE`: two weeks minus five minutes). */
export const GROUP_MAX_SCHEDULE_MS = 1_209_600_000;

/**
 * A line of a group timeline (§5.10, §7.5). `by` is who made the change: the
 * signer of the root (the owner it names, or for a handover the outgoing owner).
 */
export type GroupLine =
  /** "<owner> created the group": only on the device that created it. */
  | { type: 'founded'; epoch: GroupId; owner: string }
  /** "<by> added you": the first epoch held of a group created elsewhere. */
  | { type: 'joined'; epoch: GroupId; by: string }
  | {
      type: 'epochChange';
      epoch: GroupId;
      by: string;
      added: string[];
      removed: string[];
      left: string[];
      renamed: string | null;
      newOwner: string | null;
    }
  | { type: 'youWereRemoved' }
  | { type: 'youLeft' }
  | { type: 'dissolved' }
  | { type: 'notAMember'; from: bigint; to: bigint }
  /** "<by> added you back", after `notAMember` (§5.10). */
  | { type: 'addedBack'; epoch: GroupId; by: string };

export type GroupTimelineItem =
  | GroupMessage
  | { kind: 'line'; at: bigint; line: GroupLine };

export type GroupChangeKind =
  | 'Invitation'
  | 'Joined'
  | 'Membership'
  | 'Messages'
  | 'ReadOnly'
  | 'Fork'
  | 'Closed'
  /**
   * A chat of two replaced (§5.12): this group is kept read-only as the
   * earlier part of `by`, which continues the same conversation;
   * `hasMessages` if anything was written in it. Nothing is erased.
   */
  | 'Superseded'
  /**
   * What `isCoMember`, `connectionsToRevoke` and `peersWantingConnection`
   * answer may have changed (`groupId` is all zeros).
   */
  | 'Connections';

export interface GroupChange {
  /** The group key, or the epoch of an invitation. */
  groupId: GroupId;
  kind: GroupChangeKind;
  /** For `Superseded`: the group kept. */
  by?: GroupId;
  /** For `Superseded`: messages were written in the group replaced. */
  hasMessages?: boolean;
}

/** The key of the changes about the device rather than a group. */
export const GROUP_DEVICE_KEY: GroupId = '0'.repeat(64);

/** The format version of the earlier one-to-one conversations (§5.12). */
export const EARLIER_FORMAT_VERSION = 0;

function optionalNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** Concatenated 32-byte user IDs. */
function idsOf(users: string[]): Uint8Array {
  const ids = new Uint8Array(users.length * 32);
  users.forEach((m, i) => ids.set(decodeUserId(m), i * 32));
  return ids;
}

/** Users of concatenated 32-byte IDs. */
function usersOf(ids: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i + 32 <= ids.length; i += 32) {
    out.push(encodeUserId(ids.slice(i, i + 32)));
  }
  return out;
}

/** How a member leaves a group or declines an invitation (§5.2). */
export type LeaveChoice = 'Signed' | 'AskToBeKicked' | 'Silent';

type Raw = Record<string, unknown>;

const MAX_WAKEUP_MS = 60 * 60 * 1000;

/** The longest wait between two sends of a stored ciphertext. */
const MAX_OUTBOX_RETRY_MS = 60 * 60 * 1000;

/**
 * Whether a send failed for good: the server answered a 4xx other than a
 * timeout or rate limiting. A 409 means that it holds another value under the
 * seeker (the same value would have been taken), so this one never arrives.
 */
function isFinalSendError(error: unknown): boolean {
  const status = /HTTP (\d{3})/.exec(
    error instanceof Error ? error.message : ''
  );
  return status !== null && isFinalStatus(Number(status[1]));
}

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

const utf8 = new TextEncoder();

/** The text of a body as the text limit counts it, in UTF-8 bytes. */
function textBytes(b: GroupMessageBody): number {
  switch (b.type) {
    case 'text':
      return utf8.encode(b.text).length;
    case 'forward':
      return b.contentType === 'Text' ? b.content.length : 0;
    default:
      return 0;
  }
}

/** Throws a `GroupMessageTooLargeError` if the text is over its limit. */
function checkText(b: GroupMessageBody): void {
  const size = textBytes(b);
  const max = group_max_text_bytes();
  if (size > max) throw new GroupMessageTooLargeError('text', size, max);
}

/** Throws a `GroupMessageTooLargeError` if the metadata (as JSON) is over its limit. */
function checkMetadata(json: string): void {
  const size = group_metadata_bytes(json);
  const max = group_max_metadata_bytes();
  if (size > max) throw new GroupMessageTooLargeError('metadata', size, max);
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
    formerOwnerBranches: r.former_owner_branches as string[],
    links: r.links as string[],
    supersededBy: status === 'Superseded' ? (s.by as string) : null,
    earlier: (r.earlier as string[] | undefined) ?? [],
    tookPart: (r.took_part as boolean | null | undefined) ?? null,
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
    case 'Joined':
      return {
        type: 'joined',
        epoch: r.epoch as string,
        by: userIdOf(r.by as string),
      };
    case 'EpochChange':
      return {
        type: 'epochChange',
        epoch: r.epoch as string,
        by: userIdOf(r.by as string),
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
    case 'AddedBack':
      return {
        type: 'addedBack',
        epoch: r.epoch as string,
        by: userIdOf(r.by as string),
      };
    default:
      return {
        type: 'notAMember',
        from: BigInt(r.from as string),
        to: BigInt(r.to as string),
      };
  }
}

function timelineItem(raw: unknown): GroupTimelineItem {
  const [t, r] = variant(raw);
  if (t === 'Line') {
    return { kind: 'line', at: BigInt(r.at as string), line: line(r.line) };
  }
  const m = r.message as Raw;
  const c = m.content as Raw;
  return {
    kind: 'message',
    epochId: m.chat_id as string,
    syncObjId: c.sync_obj_id as string,
    author: userIdOf(c.author as string),
    createdAt: BigInt(c.created_at as string),
    lastModifiedAt: BigInt(c.last_modified_at as string),
    edited: c.edited as boolean,
    body: body(c.body),
    metadata: Object.fromEntries(
      (c.metadata as [string, string][]).map(([k, v]) => [k, hexToBytes(v)])
    ),
    replyTo: [],
  };
}

/** The result of publishing a message, an edit or a deletion. */
export interface GroupPublished {
  eventId: GroupId;
  syncObjId: GroupId;
  /** How it merged locally: `Won`, `Lost`, `Identical` or `Pending`. */
  merge: string;
}

/** How long logout waits for the operation in progress (sending is cut short). */
const CLOSE_WAIT_MS = 5_000;
/** First and longest delay before opening the engine again after a failure. */
const REOPEN_BASE_MS = 1_000;
const REOPEN_MAX_MS = 5 * 60_000;

/** Whether an error comes from a trapped wasm instance, which must not be called again. */
function isWasmTrap(error: unknown): boolean {
  return (
    typeof WebAssembly !== 'undefined' &&
    error instanceof WebAssembly.RuntimeError
  );
}

export class GroupService {
  private node: GroupsNode | null = null;
  /** Serializes the engine's operations with the writes they need. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Settles when an open or reopen in progress ends; reads wait for it. */
  private opening: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  private reopenDelay = 0;
  private closed = false;
  /** Failed sends of each outbox row since this service opened. */
  private outboxFailures = new Map<number, number>();
  /** A send is queued on the chain and has not started yet. */
  private pumpQueued = false;
  /**
   * Ciphertexts encrypted and not stored yet (their session state is not
   * durable yet, or storing failed), oldest first. Memory only: they never
   * left the device.
   */
  private encrypted: {
    node: GroupsNode;
    handle: number | null;
    to: Uint8Array;
    seeker: Uint8Array;
    ciphertext: Uint8Array;
  }[] = [];
  private readonly onSessionStatus = (p: {
    contactUserId: string;
    status: SessionStatus;
  }) => {
    // Only the session state: a renewal is reported by SESSION_RENEWED.
    void this.run(node => {
      node.set_session(
        decodeUserId(p.contactUserId),
        p.status === SessionStatus.Active
      );
    }).catch(() => logger.error('session status not applied'));
  };
  private readonly onSessionRenewed = (d: { contactUserId: string }) => {
    void this.run(node => {
      const peer = decodeUserId(d.contactUserId);
      node.set_session(peer, true);
      node.peer_reconnected(peer, this.now());
    }).catch(() => logger.error('session renewal not applied'));
  };

  constructor(
    private session: SessionModule,
    private messageProtocol: IMessageProtocol,
    private queries: Queries,
    private eventEmitter: SdkEventEmitter,
    private config: SdkConfig,
    /**
     * Persists the session state durably as it is now, or throws
     * (`GossipSdk.persistSessionDurably`).
     */
    private persistSession: () => Promise<void>,
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
   * contacts, tells it which peers have an active session, and starts its
   * timer.
   */
  async open(): Promise<void> {
    this.closed = false;
    await this.reopen();
    this.eventEmitter.on(
      SdkEventType.SESSION_STATUS_CHANGED,
      this.onSessionStatus
    );
    this.eventEmitter.on(SdkEventType.SESSION_RENEWED, this.onSessionRenewed);
    this.kick();
  }

  /** Opens the engine again from the database (after a failure). */
  private reopen(): Promise<void> {
    const opening = (async () => {
      this.dropNode(true);
      const node = await this.openNode();
      try {
        const now = this.now();
        node.learn_keys(this.session.ourPk.to_bytes(), now);
        // Contacts' keys are not loaded here: the engine keeps keys only of
        // identities it shares a group with, and asks members for the keys it
        // lacks; members added by this device are learnt from their contact.
        this.tellSessions(node);
        // Not through `persist`, which reopens on failure.
        await this.queries.groups.applyBatches(
          this.owner,
          node.take_batches() as GroupBatch[]
        );
      } catch (error) {
        try {
          node.free();
        } catch {
          // A trapped instance cannot be freed; it is dropped.
        }
        throw error;
      }
      if (this.closed) {
        node.free();
        return;
      }
      this.node = node;
      this.reopenDelay = 0;
    })();
    this.opening = opening.finally(() => {
      if (this.opening === guarded) this.opening = null;
    });
    const guarded = this.opening;
    return opening;
  }

  /**
   * Opens the engine from the account's records. Records an earlier build
   * wrote that this one cannot decode are erased (the group engine's tables
   * only: earlier one-to-one conversations live elsewhere), and the engine
   * starts empty.
   */
  private async openNode(): Promise<GroupsNode> {
    const snapshot = await this.queries.groups.loadSnapshot(this.owner);
    try {
      return GroupsNode.open(this.session.ourPk, this.session.ourSk, snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('groups:undecodable')) throw error;
    }
    logger.error('group records of an earlier version reset');
    await this.queries.groups.resetEngine(this.owner);
    return GroupsNode.open(this.session.ourPk, this.session.ourSk, {
      rows: [],
      edges: [],
      objects: [],
      node: [],
    });
  }

  /**
   * Tells the engine which peers have an active session: every peer of the
   * session manager, and every member of a group (a member without a
   * discussion has none), so that it assembles nothing for the others.
   */
  private tellSessions(node: GroupsNode): void {
    const told = new Set<string>();
    for (const peer of this.session.peerList()) {
      told.add(bytesToHex(peer));
      node.set_session(
        peer,
        this.session.peerSessionStatus(peer) === SessionStatus.Active
      );
    }
    const me = bytesToHex(this.session.userId);
    for (const g of JSON.parse(node.groups()) as Raw[]) {
      for (const m of g.members as string[]) {
        if (m !== me && !told.has(m)) {
          told.add(m);
          node.set_session(hexToBytes(m), false);
        }
      }
    }
  }

  /** Forgets the engine, freeing it unless it trapped. */
  private dropNode(free: boolean): void {
    const node = this.node;
    this.node = null;
    if (node && free) {
      try {
        node.free();
      } catch {
        // Nothing more can be done with it.
      }
    }
  }

  /**
   * After a failure: the engine is dropped (a trapped one without calling into
   * it again) and reopened from the database, with a growing delay while that
   * fails.
   */
  private recover(error: unknown): void {
    this.dropNode(!isWasmTrap(error));
    if (this.closed || this.reopenTimer) return;
    const attempt = () => {
      this.reopenTimer = null;
      if (this.closed || this.node) return;
      this.reopen()
        .then(() => this.kick())
        .catch(() => {
          logger.error('group engine not reopened');
          this.reopenDelay = Math.min(
            this.reopenDelay === 0 ? REOPEN_BASE_MS : this.reopenDelay * 2,
            REOPEN_MAX_MS
          );
          this.reopenTimer = setTimeout(attempt, this.reopenDelay);
          (this.reopenTimer as { unref?: () => void }).unref?.();
        });
    };
    if (this.reopenDelay === 0) {
      attempt();
    } else {
      this.reopenTimer = setTimeout(attempt, this.reopenDelay);
      (this.reopenTimer as { unref?: () => void }).unref?.();
    }
  }

  /**
   * Waits for the operation in progress (at most a few seconds: sending is
   * cut short), stops the timers and frees the engine. Never throws.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.eventEmitter.off(
      SdkEventType.SESSION_STATUS_CHANGED,
      this.onSessionStatus
    );
    this.eventEmitter.off(SdkEventType.SESSION_RENEWED, this.onSessionRenewed);
    if (this.timer) clearTimeout(this.timer);
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.timer = null;
    this.reopenTimer = null;
    // A last try to store what was encrypted: the session state is persisted
    // at logout, and a ciphertext left behind would block its chain.
    this.chain = this.chain
      .then(() => this.storeEncrypted())
      .catch(() => undefined);
    let waited: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      this.chain,
      this.opening?.catch(() => undefined),
      new Promise<void>(resolve => {
        waited = setTimeout(resolve, CLOSE_WAIT_MS);
      }),
    ]);
    if (waited) clearTimeout(waited);
    this.dropNode(true);
  }

  /** Waits for an open in progress, then gives the engine. */
  private async readyNode(): Promise<GroupsNode> {
    if (this.opening) await this.opening.catch(() => undefined);
    if (!this.node) throw new Error('Groups are not open');
    return this.node;
  }

  // ── Operation plumbing ───────────────────────────────────────────────────

  /**
   * Runs `op` on the engine and persists what it committed; resolves once
   * that is durable. Sending what it produced continues in the background on
   * the same serialized chain, and its failures never reach the caller.
   */
  private run<T>(op: (node: GroupsNode) => Promise<T> | T): Promise<T> {
    const next = this.chain.then(async () => {
      const node = await this.readyNode();
      let result: T;
      try {
        result = await op(node);
      } catch (error) {
        if (isWasmTrap(error)) {
          this.recover(error);
          throw error;
        }
        await this.persist();
        throw error;
      }
      await this.persist();
      return result;
    });
    this.chain = next.catch(() => undefined);
    this.kick();
    return next;
  }

  /** Queues a send of what the outbox holds, unless one is already queued. */
  private kick(): void {
    if (this.closed || this.pumpQueued) return;
    this.pumpQueued = true;
    this.chain = this.chain
      .then(async () => {
        this.pumpQueued = false;
        await this.pump();
      })
      .catch(error => {
        logger.error('group send failed');
        if (isWasmTrap(error)) this.recover(error);
      })
      .finally(() => this.schedule());
  }

  /** Persists the pending batches; on failure the engine is reopened. */
  private async persist(
    extra?: Parameters<Queries['groups']['applyBatches']>[2]
  ): Promise<void> {
    const node = this.node;
    if (!node) return;
    let batches: GroupBatch[];
    try {
      batches = node.take_batches() as GroupBatch[];
    } catch (error) {
      this.recover(error);
      throw error;
    }
    try {
      await this.queries.groups.applyBatches(this.owner, batches, extra);
    } catch (error) {
      // The engine is ahead of the database: start again from the database.
      this.recover(error);
      throw error;
    }
  }

  /** Whether `node` is still the open engine (after an await). */
  private alive(node: GroupsNode): boolean {
    return !this.closed && this.node === node;
  }

  /** Sends what the outbox holds and reports the changes. */
  private async pump(): Promise<void> {
    await this.storeEncrypted();
    const node = this.node;
    if (!node || this.closed) return;
    node.tick(this.now());
    await this.persist();
    for (let round = 0; round < 64 && this.alive(node); round++) {
      const out = node.poll_outbox(this.now()) as {
        handle: number;
        to: Uint8Array;
        plaintext: Uint8Array;
      }[];
      await this.persist();
      if (out.length === 0) break;
      let sent = 0;
      let i = 0;
      try {
        for (; i < out.length; i++) {
          if (!this.alive(node)) break;
          if (await this.sendOne(node, out[i])) sent++;
        }
      } finally {
        // Whatever was not sent is assembled again later.
        if (this.node === node) {
          for (let j = i; j < out.length; j++) node.abandon(out[j].handle);
        }
      }
      // A round that sent nothing would only repeat itself.
      if (sent === 0) break;
    }
    if (!this.alive(node)) return;
    await this.retryOutbox();
    if (!this.alive(node)) return;
    const changes = JSON.parse(node.take_changes(this.now())) as Raw[];
    await this.persist();
    if (changes.length > 0) {
      this.eventEmitter.emit(SdkEventType.GROUPS_CHANGED, {
        changes: changes.map(c => {
          const [kind, r] = variant(c.kind);
          const change: GroupChange = {
            groupId: c.group as string,
            kind: kind as GroupChangeKind,
          };
          if (kind === 'Superseded') {
            change.by = r.by as string;
            change.hasMessages = r.has_messages === true;
          }
          return change;
        }),
      });
    }
  }

  /**
   * Encrypts one plaintext, then stores and sends its ciphertext. Returns
   * whether it was encrypted; otherwise it is abandoned and its work
   * assembled again later.
   */
  private async sendOne(
    node: GroupsNode,
    o: { handle: number; to: Uint8Array; plaintext: Uint8Array }
  ): Promise<boolean> {
    if (this.session.peerSessionStatus(o.to) !== SessionStatus.Active) {
      // The engine's view was stale (a status change it was not told of).
      node.abandon(o.handle);
      node.set_session(o.to, false);
      return false;
    }
    if (!node.is_current(o.handle, this.now())) {
      node.abandon(o.handle);
      return false;
    }
    let sent: Awaited<ReturnType<SessionModule['sendMessage']>>;
    try {
      sent = await this.session.sendMessage(
        o.to,
        serializeGroupPlaintext(o.plaintext)
      );
    } catch (error) {
      // Refused before encryption (it may not fit one packet): the session
      // did not move. The engine never assembles one this large.
      if (!(error instanceof SessionMessageTooLargeError)) throw error;
      node.abandon(o.handle);
      return false;
    }
    if (!this.alive(node)) return false;
    if (!sent) {
      // The session refused to encrypt (the peer lags too far behind) while
      // its status is still Active: abandoning backs this peer's work off for
      // a while in the engine. Marking the peer without a session would hold
      // its work back until a status change that may never come.
      node.abandon(o.handle);
      return false;
    }
    this.encrypted.push({
      node,
      handle: o.handle,
      to: o.to,
      seeker: sent.seeker,
      ciphertext: sent.data,
    });
    await this.storeEncrypted();
    return true;
  }

  /**
   * Stores and sends the ciphertexts encrypted so far, in order.
   *
   * The session state that produced a ciphertext is made durable first: a
   * crash before that loses a ciphertext that never left the device, and the
   * session restarts from a state that produced nothing visible. A ciphertext
   * is never dropped once encrypted, because the recipient reads its
   * session's messages in order and a missing one would block the chain: it
   * waits in memory until its state is durable and it is stored, and is
   * tried again on every send.
   */
  private async storeEncrypted(): Promise<void> {
    if (this.encrypted.length === 0) return;
    try {
      await this.persistSession();
    } catch {
      return;
    }
    while (this.encrypted.length > 0) {
      const e = this.encrypted[0];
      const node = this.node;
      // The hand-off goes with the ciphertext, if the engine that assembled
      // it is still the open one; otherwise its work is assembled again.
      const handOff = e.handle !== null && node !== null && e.node === node;
      if (handOff) node!.handed_off(e.handle!, this.now());
      let id: number | null = null;
      const store = async (
        tx: Parameters<Queries['groups']['insertOutbox']>[0]
      ) => {
        id = await this.queries.groups.insertOutbox(tx, {
          ownerUserId: this.owner,
          contactUserId: encodeUserId(e.to),
          seeker: e.seeker,
          ciphertext: e.ciphertext,
          whenToSend: new Date(this.now()),
        });
      };
      try {
        if (handOff) {
          await this.persist(store);
        } else {
          await this.queries.groups.applyBatches(this.owner, [], store);
        }
      } catch {
        // The engine was reopened (its hand-off is lost and its work will be
        // assembled again); the ciphertext itself stays to be stored.
        e.handle = null;
        return;
      }
      this.encrypted.shift();
      try {
        await this.messageProtocol.sendMessage({
          seeker: e.seeker,
          ciphertext: e.ciphertext,
        });
      } catch (error) {
        if (id !== null) {
          await this.outboxFailed(id, error).catch(() => undefined);
        }
        continue;
      }
      if (id !== null) {
        this.outboxFailures.delete(id);
        await this.queries.groups.deleteOutbox(id).catch(() => undefined);
      }
      if (handOff && this.alive(e.node)) {
        e.node.published(e.handle!, this.now());
        await this.persist();
      }
    }
  }

  /** Sends again, as stored, the ciphertexts that failed. */
  private async retryOutbox(): Promise<void> {
    const due = await this.queries.groups.dueOutbox(
      this.owner,
      new Date(this.now())
    );
    for (const row of due) {
      if (this.closed) return;
      try {
        await this.messageProtocol.sendMessage({
          seeker: row.seeker,
          ciphertext: row.ciphertext,
        });
      } catch (error) {
        await this.outboxFailed(row.id, error).catch(() => undefined);
        continue;
      }
      this.outboxFailures.delete(row.id);
      await this.queries.groups.deleteOutbox(row.id).catch(() => undefined);
    }
  }

  /**
   * A stored ciphertext that failed to send. One the server refused for good
   * is deleted: its plaintext was handed off but is never published, so the
   * engine records no delivery hint for it and its events stay to be
   * synchronised. Any other failure is retried, each wait twice the one
   * before, up to an hour.
   */
  private async outboxFailed(id: number, error: unknown): Promise<void> {
    if (isFinalSendError(error)) {
      this.outboxFailures.delete(id);
      await this.queries.groups.deleteOutbox(id);
      return;
    }
    const failures = (this.outboxFailures.get(id) ?? 0) + 1;
    this.outboxFailures.set(id, failures);
    const delay = Math.min(
      MAX_OUTBOX_RETRY_MS,
      this.config.messages.retryDelayMs * 2 ** Math.min(failures - 1, 20)
    );
    await this.queries.groups.rescheduleOutbox(
      id,
      new Date(this.now() + delay)
    );
  }

  /**
   * Arms the timer at the engine's next wake-up or the next outbox retry,
   * whichever comes first (always re-armed, also after a failure).
   */
  private schedule(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.now();
    let at = now + MAX_WAKEUP_MS;
    try {
      const wake = this.node?.next_wakeup(now);
      if (wake !== undefined && wake !== null) at = Math.min(at, wake);
    } catch (error) {
      if (isWasmTrap(error)) this.recover(error);
    }
    void this.queries.groups
      .nextOutboxRetry(this.owner)
      .catch(() => null)
      .then(retry => {
        if (this.closed) return;
        const when = retry ? Math.min(at, retry.getTime()) : at;
        const delay = Math.min(MAX_WAKEUP_MS, Math.max(1000, when - now));
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          this.kick();
        }, delay);
        (this.timer as { unref?: () => void }).unref?.();
      });
  }

  // ── Transport ────────────────────────────────────────────────────────────

  /**
   * A group plaintext received from `from` (32-byte user ID). Resolves once
   * what it changed is durable; replies are sent in the background.
   */
  handlePlaintext(from: Uint8Array, plaintext: Uint8Array): Promise<void> {
    // The sender's keys are not added from its contact: a plaintext may be
    // for a group closed here, and the engine asks for the keys it needs.
    return this.run(async node => {
      node.handle_plaintext(from, plaintext, this.now());
    });
  }

  /** Runs the engine's timers; sending follows in the background. */
  async tick(): Promise<void> {
    await this.run(() => undefined);
  }

  /**
   * Resolves once everything queued so far, sending included, has run (for
   * tests and for callers that need the outbox drained).
   */
  async settle(): Promise<void> {
    this.kick();
    await this.chain;
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
      return bytesToHex(node.create_group(name, idsOf(members), this.now()));
    });
  }

  /**
   * Founds the direct chat of this device and `peer` (§5.12), for a
   * migration or a new contact: a group of two with `migrate_from = 0`.
   * Returns the group kept, which is the peer's own creation when it is held
   * and its owner sorts first.
   */
  createDirectChat(name: string, peer: string): Promise<GroupId> {
    return this.run(async node => {
      await this.learnMembers(node, [peer]);
      return bytesToHex(
        node.create_group_with(
          name,
          idsOf([peer]),
          EARLIER_FORMAT_VERSION,
          this.now()
        )
      );
    });
  }

  /**
   * Declares the earlier conversations this device holds (§5.12, condition
   * 3), one per peer, in format 0; those already declared are left as they
   * are. Never cleared here: an archive stays an earlier conversation.
   */
  declareEarlierConversations(peers: string[]): Promise<void> {
    return this.run(node => {
      const declared = new Set(
        (JSON.parse(node.earlier_conversations()) as [string, string][])
          .filter(([, v]) => Number(v) === EARLIER_FORMAT_VERSION)
          .map(([p]) => p)
      );
      for (const peer of peers) {
        if (declared.has(hexOfUser(peer))) continue;
        node.set_earlier_conversation(
          decodeUserId(peer),
          EARLIER_FORMAT_VERSION,
          true,
          this.now()
        );
      }
    });
  }

  /**
   * Consents (or withdraws the consent) to the direct chat `peer` founds
   * after this user accepted its contact request (§5.12): one-shot, 14 days.
   */
  consentToDirectChat(peer: string, consent: boolean): Promise<void> {
    return this.run(node =>
      node.consent_to_direct_chat(decodeUserId(peer), consent, this.now())
    );
  }

  /**
   * Declares the contacts the user accepted (§13.8: only they get a version
   * notice), and clears those declared that are no longer: `accepted` is the
   * full list. Automatic connections are never declared.
   */
  setAcceptedContacts(accepted: string[]): Promise<void> {
    return this.run(node => {
      const declared = new Set(
        JSON.parse(node.accepted_contacts()) as string[]
      );
      const wanted = new Set(accepted.map(hexOfUser));
      for (const peer of wanted) {
        if (!declared.has(peer)) {
          node.set_accepted_contact(hexToBytes(peer), true, this.now());
        }
      }
      for (const peer of declared) {
        if (!wanted.has(peer)) {
          node.set_accepted_contact(hexToBytes(peer), false, this.now());
        }
      }
    });
  }

  /** Whether this device holds a direct chat with `peer` (§5.12). */
  holdsDirectChat(peer: string): Promise<boolean> {
    return this.read(n => n.holds_direct_chat(decodeUserId(peer)));
  }

  /** Whether `peer` is a member of a group this device has accepted. */
  isCoMember(peer: string): Promise<boolean> {
    return this.read(n => n.is_co_member(decodeUserId(peer)));
  }

  /** Among `peers`, those whose automatic connection may be revoked. */
  async connectionsToRevoke(peers: string[]): Promise<string[]> {
    if (peers.length === 0) return [];
    return usersOf(await this.read(n => n.connections_to_revoke(idsOf(peers))));
  }

  /** Members of accepted groups with which no session is reported. */
  async peersWantingConnection(): Promise<string[]> {
    return usersOf(await this.read(n => n.peers_wanting_connection()));
  }

  /** The public keys the engine holds for `peer` (a member), if any. */
  keysOf(peer: string): Promise<Uint8Array | null> {
    return this.read(n => n.keys(decodeUserId(peer)) ?? null);
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

  /**
   * As the owner: hands the group over to a member, possibly leaving it
   * ("hand over and leave"). The handover keeps every other member.
   */
  handOver(
    groupId: GroupId,
    newOwner: string,
    options: { leave?: boolean; name?: string | null } = {}
  ): Promise<GroupId> {
    return this.run(async node => {
      await this.learnMembers(node, [newOwner]);
      const json = JSON.stringify({
        t: 'Handover',
        new_owner: hexOfUser(newOwner),
        leave: options.leave ?? false,
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

  /** The size limits of a message version, as the engine enforces them. */
  get messageLimits(): GroupMessageLimits {
    return {
      textBytes: group_max_text_bytes(),
      metadataBytes: group_max_metadata_bytes(),
    };
  }

  private published(json: string): GroupPublished {
    const r = JSON.parse(json) as Raw;
    return {
      eventId: r.eventId as string,
      syncObjId: r.syncObjId as string,
      merge: variant(r.merge)[0],
    };
  }

  /** Sends a message to the group's current epoch, possibly as a reply. */
  sendMessage(
    groupId: GroupId,
    message: GroupMessageBody | string,
    options: {
      metadata?: Record<string, Uint8Array>;
      scheduledFor?: number;
      replyTo?: GroupMessageRef[];
    } = {}
  ): Promise<GroupPublished> {
    const b =
      typeof message === 'string'
        ? { type: 'text' as const, text: message }
        : message;
    try {
      checkText(b);
    } catch (e) {
      return Promise.reject(e);
    }
    return this.run(node => {
      const epoch = this.currentEpoch(node, groupId);
      const metadata = { ...(options.metadata ?? {}) };
      if (options.replyTo && options.replyTo.length > 0) {
        const targets = options.replyTo.map(t => {
          const reference = node.ref_chat_id(hexToBytes(t.epochId));
          if (!reference) {
            throw new Error('groups:unknown-epoch: reply target');
          }
          return {
            ref_chat_id: bytesToHex(reference),
            sync_obj_id: t.syncObjId,
          };
        });
        metadata.replyTo = node.encode_reply_to(JSON.stringify(targets));
      }
      const meta = metadataJson(metadata);
      checkMetadata(meta);
      return this.published(
        node.publish_message(
          hexToBytes(epoch),
          bodyJson(b),
          meta,
          options.scheduledFor,
          this.now()
        )
      );
    });
  }

  /**
   * Edits one of this account's messages, in the epoch that holds it. The
   * edit keeps the message's metadata (§2.2: entries this client does not
   * know, `replyTo` included): `metadata` sets entries and `removeMetadata`
   * removes them; neither keeps everything.
   */
  editMessage(
    epochId: GroupId,
    syncObjId: GroupId,
    message: GroupMessageBody | string,
    options: {
      metadata?: Record<string, Uint8Array>;
      removeMetadata?: string[];
      scheduledFor?: number;
    } = {}
  ): Promise<GroupPublished> {
    const b =
      typeof message === 'string'
        ? { type: 'text' as const, text: message }
        : message;
    const set = metadataJson(options.metadata);
    const remove = [...new Set(options.removeMetadata ?? [])].sort();
    const meta =
      remove.length > 0
        ? JSON.stringify({ set: JSON.parse(set), remove })
        : options.metadata && Object.keys(options.metadata).length > 0
          ? set
          : 'null';
    try {
      checkText(b);
      checkMetadata(set);
    } catch (e) {
      return Promise.reject(e);
    }
    return this.run(node =>
      this.published(
        node.publish_edit(
          hexToBytes(epochId),
          hexToBytes(syncObjId),
          bodyJson(b),
          meta,
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

  /**
   * Changes a message on this device only (§9.1): nothing is sent, no
   * indicator is added, and this device stops serving any version of it.
   */
  editMessageLocally(
    epochId: GroupId,
    syncObjId: GroupId,
    edit: GroupLocalEdit
  ): Promise<void> {
    const limit = this.now() + GROUP_MAX_SCHEDULE_MS;
    for (const t of [edit.createdAt, edit.lastModifiedAt]) {
      if (t !== undefined && t > limit) {
        return Promise.reject(new Error('groups:invalid: date too far ahead'));
      }
    }
    if (edit.body) {
      try {
        checkText(edit.body);
      } catch (e) {
        return Promise.reject(e);
      }
    }
    const json = JSON.stringify({
      body: edit.body ? JSON.parse(bodyJson(edit.body)) : null,
      author: edit.author ? hexOfUser(edit.author) : null,
      created_at: edit.createdAt ?? null,
      last_modified_at: edit.lastModifiedAt ?? null,
      metadata: null,
      edited: edit.edited ?? null,
    });
    return this.run(node => {
      node.local_edit(
        hexToBytes(epochId),
        hexToBytes(syncObjId),
        json,
        this.now()
      );
    });
  }

  /** Retry synchronisation of a message (§9.4): republishes its stored result. */
  retryMessage(epochId: GroupId, syncObjId: GroupId): Promise<GroupPublished> {
    return this.run(node =>
      this.published(
        node.retry(hexToBytes(epochId), hexToBytes(syncObjId), this.now())
      )
    );
  }

  private currentEpoch(node: GroupsNode, groupId: GroupId): GroupId {
    const g = JSON.parse(node.group(hexToBytes(groupId))) as Raw | null;
    if (!g) throw new Error('groups:unknown-epoch: unknown group');
    return g.current as string;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /**
   * Runs a read on the engine, waiting for an open or reopen in progress; a
   * trapped engine is dropped and reopened.
   */
  private async read<T>(f: (node: GroupsNode) => T): Promise<T> {
    const node = await this.readyNode();
    try {
      return f(node);
    } catch (error) {
      if (isWasmTrap(error)) this.recover(error);
      throw error;
    }
  }

  async list(): Promise<GroupSummary[]> {
    return (JSON.parse(await this.read(n => n.groups())) as Raw[]).map(summary);
  }

  async get(groupId: GroupId): Promise<GroupSummary | null> {
    const g = JSON.parse(
      await this.read(n => n.group(hexToBytes(groupId)))
    ) as Raw | null;
    return g ? summary(g) : null;
  }

  async invitations(): Promise<GroupInvitation[]> {
    return (
      JSON.parse(await this.read(n => n.invitations(this.now()))) as Raw[]
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
      migrateFrom: optionalNumber(r.migrate_from),
      migrationOf: r.migration_of ? userIdOf(r.migration_of as string) : null,
      continues: (r.continues as string | null | undefined) ?? null,
    }));
  }

  /** What the root of a held epoch says, or null. */
  async epoch(epochId: GroupId): Promise<GroupEpoch | null> {
    const r = JSON.parse(
      await this.read(n => n.epoch(hexToBytes(epochId)))
    ) as Raw | null;
    if (!r) return null;
    return {
      epoch: r.epoch as string,
      name: r.name as string,
      members: (r.members as string[]).map(userIdOf),
      owner: userIdOf(r.owner as string),
      createdAt: BigInt(r.created_at as string),
      migrateFrom: optionalNumber(r.migrate_from),
    };
  }

  /**
   * The visible messages and lines of a group (and the groups linked to it),
   * with the targets of replies resolved against the epochs it shows.
   */
  async timeline(groupId: GroupId): Promise<GroupTimelineItem[]> {
    const node = await this.readyNode();
    const items = (
      JSON.parse(
        await this.read(n => n.timeline(hexToBytes(groupId), this.now()))
      ) as unknown[]
    ).map(timelineItem);
    const epochs = new Set<string>();
    for (const i of items) {
      if (i.kind === 'message') epochs.add(i.epochId);
      else if ('epoch' in i.line) {
        epochs.add(i.line.epoch);
      }
    }
    const byReference = new Map<string, string>();
    for (const e of epochs) {
      const reference = node.ref_chat_id(hexToBytes(e));
      if (reference) byReference.set(bytesToHex(reference), e);
    }
    for (const i of items) {
      if (i.kind !== 'message' || !i.metadata.replyTo) continue;
      try {
        const targets = JSON.parse(
          node.decode_reply_to(i.metadata.replyTo)
        ) as { ref_chat_id: string; sync_obj_id: string }[];
        i.replyTo = targets.map(t => ({
          epochId: byReference.get(t.ref_chat_id) ?? null,
          syncObjId: t.sync_obj_id,
        }));
      } catch {
        // A malformed list is shown without its targets (§7.6, D.21).
      }
    }
    return items;
  }
}
