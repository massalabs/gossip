/**
 * Conversations (§2.1, §5.12): every conversation is a group, a chat between
 * two people included, and a session with a peer is only a connection.
 *
 * This service ties the group engine to the account's earlier one-to-one
 * discussions and contacts:
 *
 * - **Archives.** Every discussion from before group chats is an archive of
 *   a format 0 conversation (migration 0011). Each is declared to the engine
 *   (`set_earlier_conversation`), so that the peer's migration is shown in it.
 *   "Migrate" founds the direct chat and links it; a migration accepted is
 *   linked too, and the archive is shown first, read-only.
 * - **New contacts.** Adding a contact and starting a chat are two steps:
 *   a contact request, once accepted, opens a session and starts no chat
 *   (no chat is owed, no consent recorded). Either person then starts the
 *   pair's chat explicitly (`startDirectChat`), owns it, and the other
 *   receives it as an ordinary invitation.
 * - **Links.** A discussion names the direct chat that continues it
 *   (`linkedGroupId`); the link follows the chat that continues a replaced
 *   one (`Superseded`, kept as history), and is found again from the groups
 *   held.
 * - **Accepted contacts.** The contacts the user accepted are declared to the
 *   engine (only they get a version notice, §13.8); automatic connections
 *   never are.
 * - **Connections.** Members of groups this device accepted are connected
 *   automatically and silently (an `automatic` contact and its discussion,
 *   which is a session record, never a conversation); automatic connections
 *   the engine no longer needs are revoked (a chat the device is out of,
 *   kicked or left, needs none, its history kept or not), once nothing waits
 *   for the peer in the group outbox. A contact the user accepted is never
 *   revoked.
 * - **Adding a member as a contact.** A member who is no contact is made one
 *   on this device only (`addAsContact`, connection `added`): nothing is
 *   sent, the session already exists, and until the relationship is mutual
 *   the contact is neither declared to the engine nor kept connected beyond
 *   the automatic rule, so that the peer cannot tell it was added. A member who also asks to become a contact keeps the
 *   connection the chats need while the request waits (`requested`), and
 *   declining the request keeps it (`declineContactRequest`).
 *
 * Nothing is stored about group traffic: a link names a group key next to a
 * peer the engine's own records already list as its member.
 */

import { type Contact, type Discussion, type Queries } from '../db/index.js';
import { toDiscussion } from '../utils/discussions.js';
import { deleteContact, isTemporaryContactName } from '../utils/contacts.js';
import { canonicalUserId, decodeUserId } from '../utils/userId.js';
import type { SessionModule } from '../wasm/session.js';
import { SessionStatus } from '../wasm/bindings.js';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter.js';
import type {
  GroupChange,
  GroupId,
  GroupInvitation,
  GroupService,
  GroupSummary,
  LeaveChoice,
} from './groups.js';
import { EARLIER_FORMAT_VERSION, retentionToMessageTimer } from './groups.js';
import type { DiscussionService } from './discussion.js';
import type { AnnouncementPayload } from '../utils/announcementPayload.js';
import { SELF_CONTACT_ID } from './selfMessage.js';
import { Logger } from '../utils/logs.js';
import { dlog } from '../utils/debugLog.js';
import { errFields, shortId } from '../utils/debugFields.js';

const logger = new Logger('ConversationService');

/**
 * Whether a request waiting from `contact` is a contact request: it stated a
 * name or a message. The announcement of a connection states none and
 * leaves the temporary name (`openConnection`). A request that stated
 * neither cannot be told from it here, once stored.
 */
function carriesRequest(contact: Contact, d: Discussion): boolean {
  return (
    !!d.announcementMessage ||
    (contact.name !== '' && !isTemporaryContactName(contact.name))
  );
}

/** How long before trying again a connection whose keys were missing. */
const CONNECTION_RETRY_MS = 30_000;

/** What `addAsContact` did. */
export type AddAsContactResult =
  | { success: true }
  | {
      success: false;
      /**
       * `already-contact`: the user accepted this person already (or a
       * request of theirs is waiting as an ordinary request); `unknown`: no
       * contact row and no keys from any chat held; `empty-name`.
       */
      reason: 'already-contact' | 'unknown' | 'empty-name';
    };

/** What `sendContactRequest` did. */
export type SendContactRequestResult =
  | { success: true }
  | {
      success: false;
      /**
       * `not-added`: not a contact the user added on their own; `connected`:
       * its session is active, nothing has lapsed; `failed`: the request
       * could not be prepared (nothing changed).
       */
      reason: 'not-added' | 'connected' | 'failed';
    };

/** Why "Migrate" is not done. */
export class MigrationUnavailableError extends Error {
  constructor(
    readonly reason: 'not-an-archive' | 'invitation-pending' | 'already-linked'
  ) {
    super(`conversations:${reason}`);
    this.name = 'MigrationUnavailableError';
  }
}

export class ConversationService {
  /** Serializes the work below, so that no direct chat is founded twice. */
  private chain: Promise<unknown> = Promise.resolve();
  private started = false;
  /** Peers a connection was opened to since this service started. */
  private opened = new Set<string>();

  private readonly onGroupsChanged = ({
    changes,
  }: {
    changes: GroupChange[];
  }) => {
    void this.enqueue(() => this.applyChanges(changes)).catch(() =>
      logger.error('group changes not applied to conversations')
    );
  };

  private readonly onSessionStatus = (p: {
    contactUserId: string;
    status: SessionStatus;
  }) => {
    if (p.status !== SessionStatus.Active) return;
    void this.enqueue(() => this.syncAcceptedContacts()).catch(() =>
      logger.error('accepted contacts not declared')
    );
  };

  private readonly onContactDeleted = () => {
    void this.enqueue(() => this.syncAcceptedContacts()).catch(() =>
      logger.error('accepted contacts not declared')
    );
  };

  constructor(
    private session: SessionModule,
    private queries: Queries,
    private eventEmitter: SdkEventEmitter,
    private groups: GroupService,
    private discussions: DiscussionService
  ) {}

  private get owner(): string {
    return this.session.userIdEncoded;
  }

  private enqueue<T>(f: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => (this.started ? f() : (undefined as T)));
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Subscribes to the group and session changes and catches up. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.eventEmitter.on(SdkEventType.GROUPS_CHANGED, this.onGroupsChanged);
    this.eventEmitter.on(
      SdkEventType.SESSION_STATUS_CHANGED,
      this.onSessionStatus
    );
    this.eventEmitter.on(SdkEventType.CONTACT_DELETED, this.onContactDeleted);
    await this.catchUp().catch(() =>
      logger.error('conversations not caught up')
    );
  }

  stop(): void {
    this.started = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.revokeTimer) clearTimeout(this.revokeTimer);
    this.revokeTimer = null;
    this.eventEmitter.off(SdkEventType.GROUPS_CHANGED, this.onGroupsChanged);
    this.eventEmitter.off(
      SdkEventType.SESSION_STATUS_CHANGED,
      this.onSessionStatus
    );
    this.eventEmitter.off(SdkEventType.CONTACT_DELETED, this.onContactDeleted);
  }

  /** Resolves once the work queued so far has run (for tests). */
  async settle(): Promise<void> {
    await this.chain;
  }

  /**
   * Everything this service keeps true, from the start: archives declared,
   * links found, connections opened and revoked.
   *
   * A discussion of 0.1.0 or 0.1.1 may still say that this device owes the
   * chat of a contact request it sent (`directChatOwed`): it is no longer
   * read, so no chat is ever founded by itself; the user starts one.
   */
  catchUp(): Promise<void> {
    return this.enqueue(async () => {
      await this.declareArchives();
      await this.syncAcceptedContacts();
      await this.reconcileLinks();
      await this.upgradeMutualContacts();
      await this.syncConnections();
    });
  }

  private async discussionRows(): Promise<Discussion[]> {
    return (await this.queries.discussions.getByOwner(this.owner))
      .filter(d => d.contactUserId !== SELF_CONTACT_ID)
      .map(toDiscussion);
  }

  private emitDiscussion(d: Discussion): void {
    if (d.id !== undefined) {
      this.eventEmitter.emit(SdkEventType.DISCUSSION_UPDATED, d.id);
    }
  }

  private async link(d: Discussion, groupId: GroupId | null): Promise<void> {
    if (d.linkedGroupId === groupId || d.id === undefined) return;
    await this.queries.discussions.updateById(d.id, {
      linkedGroupId: groupId,
      directChatOwed: false,
      directChatTimer: null,
      updatedAt: new Date(),
    });
    this.emitDiscussion(d);
  }

  // ── Archives ─────────────────────────────────────────────────────────────

  /** Declares every archive to the engine as an earlier conversation. */
  private async declareArchives(): Promise<void> {
    const peers = (await this.discussionRows())
      .filter(d => d.isArchive)
      .map(d => d.contactUserId);
    if (peers.length > 0) await this.groups.declareEarlierConversations(peers);
  }

  /** The migration invitation shown inside the archive with `peer`, if any. */
  async migrationInvitation(peer: string): Promise<GroupInvitation | null> {
    await this.groups.settle();
    return (
      (await this.groups.invitations()).find(i => i.migrationOf === peer) ??
      null
    );
  }

  /**
   * The message timer (§7.7, milliseconds, 0 = forever) a migration of the
   * conversation with `contactUserId` starts with: the retention it has
   * today (none is forever, the earlier "1 month" is 28 days). The archive
   * itself keeps its own rule.
   */
  async migrationTimer(contactUserId: string): Promise<number> {
    const d = await this.discussionOf(contactUserId);
    return retentionToMessageTimer(d?.messageRetentionDuration);
  }

  /**
   * "Migrate to a new group" (§5.12): founds the direct chat with the
   * archive's peer and links it, with the message timer chosen or the one
   * the conversation has (`migrationTimer`). What was received is processed
   * first, and the peer's own migration takes precedence: with one pending,
   * this throws `MigrationUnavailableError('invitation-pending')`.
   */
  migrate(
    contactUserId: string,
    options: { messageTimer?: number } = {}
  ): Promise<GroupId> {
    return this.enqueue(async () => {
      const d = await this.discussionOf(contactUserId);
      if (!d?.isArchive) throw new MigrationUnavailableError('not-an-archive');
      if (d.linkedGroupId && (await this.groups.get(d.linkedGroupId))) {
        throw new MigrationUnavailableError('already-linked');
      }
      if (await this.migrationInvitation(contactUserId)) {
        throw new MigrationUnavailableError('invitation-pending');
      }
      const groupId = await this.groups.createDirectChat(
        '',
        contactUserId,
        options.messageTimer ??
          retentionToMessageTimer(d.messageRetentionDuration)
      );
      await this.link(d, groupId);
      return groupId;
    });
  }

  /**
   * Accepts an invitation. A direct chat (a group of this device and its
   * owner) is linked to the discussion with the owner, and accepting it also
   * accepts the owner as a contact (§5.12: a person who asks for a chat asks
   * to become a contact too); `addAsContact` does the same for any group.
   */
  acceptInvitation(
    epochId: GroupId,
    options: { addAsContact?: boolean } = {}
  ): Promise<GroupId> {
    return this.enqueue(async () => {
      const inv = (await this.groups.invitations()).find(
        i => i.epochId === epochId
      );
      const groupId = await this.groups.acceptInvitation(epochId);
      if (!inv) return groupId;
      const ofTwo =
        inv.members.length === 2 &&
        inv.members.includes(this.owner) &&
        inv.owner !== this.owner;
      // Accepting a chat of two from its owner is mutual and known to them:
      // an accepted contact. Adding the owner of any other group is this
      // user's own choice, unknown to them: `added`.
      if (ofTwo) {
        await this.acceptAsContact(inv.owner);
        await this.syncAcceptedContacts();
      } else if (options.addAsContact) {
        await this.acceptAsContact(inv.owner, undefined, 'added');
      }
      const d = await this.discussionOf(inv.owner);
      if (
        d &&
        (inv.migrationOf === inv.owner ||
          inv.continues !== null ||
          !d.linkedGroupId ||
          !(await this.groups.get(d.linkedGroupId))) &&
        (await this.isDirectChat(groupId))
      ) {
        await this.link(d, groupId);
      }
      return groupId;
    });
  }

  /** Declines an invitation (a migration included). */
  declineInvitation(epochId: GroupId, choice: LeaveChoice): Promise<void> {
    return this.enqueue(() => this.groups.declineInvitation(epochId, choice));
  }

  /** Moves an archive to the archived list, or back. */
  async setArchived(contactUserId: string, archived: boolean): Promise<void> {
    const d = await this.discussionOf(contactUserId);
    if (!d?.id) return;
    await this.queries.discussions.updateById(d.id, {
      archived,
      updatedAt: new Date(),
    });
    this.emitDiscussion(d);
  }

  // ── Direct chats ─────────────────────────────────────────────────────────

  private async discussionOf(
    contactUserId: string
  ): Promise<Discussion | undefined> {
    const row = await this.queries.discussions.getByOwnerAndContact(
      this.owner,
      contactUserId
    );
    return row ? toDiscussion(row) : undefined;
  }

  /**
   * The other member of a direct chat held: a group whose founding root is
   * of this device and one other person, with `migrate_from` 0 (§5.12).
   */
  private async directPeer(g: GroupSummary): Promise<string | null> {
    const e = await this.groups.epoch(g.groupId);
    if (!e || e.migrateFrom !== EARLIER_FORMAT_VERSION) return null;
    if (e.members.length !== 2 || !e.members.includes(this.owner)) return null;
    return e.members.find(m => m !== this.owner) ?? null;
  }

  private async isDirectChat(groupId: GroupId): Promise<boolean> {
    const g = await this.groups.get(groupId);
    return g !== null && (await this.directPeer(g)) !== null;
  }

  /**
   * The group that continues `groupId`: itself, or for a replaced chat of two
   * the chat that superseded it, followed to the end. Null when not held.
   */
  private async continuing(groupId: GroupId): Promise<GroupSummary | null> {
    let g = await this.groups.get(groupId);
    for (
      let i = 0;
      i < 32 && g?.status === 'superseded' && g.supersededBy;
      i++
    ) {
      g = await this.groups.get(g.supersededBy);
    }
    return g;
  }

  /** The direct chat with `peer` this device holds, by its group key. */
  async directChatWith(peer: string): Promise<GroupId | null> {
    const d = await this.discussionOf(peer);
    if (d?.linkedGroupId) {
      const g = await this.continuing(d.linkedGroupId);
      if (g && g.status !== 'dissolved-deleted' && g.status !== 'superseded') {
        return g.groupId;
      }
    }
    for (const g of await this.groups.list()) {
      if (g.status === 'dissolved-deleted' || g.status === 'superseded') {
        continue;
      }
      if ((await this.directPeer(g)) === peer) return g.groupId;
    }
    return null;
  }

  /**
   * The invitation to the pair's chat (a chat of two with `migrate_from`,
   * §5.12) that `peer` started and this device has not answered, if any.
   * While it waits, the contact's screen shows it instead of "Start a chat".
   */
  async directChatInvitation(peer: string): Promise<GroupInvitation | null> {
    await this.groups.settle();
    return (
      (await this.groups.invitations()).find(
        i =>
          i.owner === peer &&
          i.migrateFrom === EARLIER_FORMAT_VERSION &&
          i.members.length === 2 &&
          i.members.includes(this.owner)
      ) ?? null
    );
  }

  /**
   * "Start a chat" with a contact (§5.12): the pair's chat, founded now if
   * none is held (`migrate_from = 0`), with the message timer chosen or the
   * account's default. Whoever starts it owns it; the other person receives
   * an ordinary invitation. Nothing calls it by itself: adding a contact or
   * opening one starts no chat. For an archive, see `migrate`.
   *
   * With an invitation to the pair's chat from that person waiting (or
   * their migration of the archive), this throws
   * `MigrationUnavailableError('invitation-pending')`: it is accepted
   * instead. Two people who start at the same moment still end with one
   * chat, by the tie rule.
   */
  startDirectChat(
    contactUserId: string,
    options: { messageTimer?: number } = {}
  ): Promise<GroupId> {
    contactUserId = canonicalUserId(contactUserId);
    return this.enqueue(async () => {
      const held = await this.directChatWith(contactUserId);
      const d = await this.discussionOf(contactUserId);
      if (held) {
        dlog('engine', 'chat.start', {
          peer: shortId(contactUserId),
          result: 'held',
          group: shortId(held),
        });
        if (d) await this.link(d, held);
        return held;
      }
      if (await this.directChatInvitation(contactUserId)) {
        dlog('engine', 'chat.start', {
          peer: shortId(contactUserId),
          result: 'invitation-pending',
        });
        throw new MigrationUnavailableError('invitation-pending');
      }
      const groupId = await this.groups.createDirectChat(
        '',
        contactUserId,
        options.messageTimer
      );
      dlog('engine', 'chat.start', {
        peer: shortId(contactUserId),
        result: 'founded',
        group: shortId(groupId),
        timer: options.messageTimer ?? null,
      });
      if (d) await this.link(d, groupId);
      return groupId;
    });
  }

  /**
   * Finds each discussion's direct chat again from the groups held: a link
   * to a group no longer held moves to the direct chat held with that peer,
   * if any, and an unlinked discussion is linked to it.
   */
  private async reconcileLinks(): Promise<void> {
    const held = new Map<string, GroupId>();
    const keys = new Set<GroupId>();
    const superseded = new Set<GroupId>();
    for (const g of await this.groups.list()) {
      if (g.status === 'dissolved-deleted') continue;
      if (g.status === 'superseded') {
        superseded.add(g.groupId);
        continue;
      }
      keys.add(g.groupId);
      const peer = await this.directPeer(g);
      if (peer && !held.has(peer)) held.set(peer, g.groupId);
    }
    for (const d of await this.discussionRows()) {
      if (d.linkedGroupId && keys.has(d.linkedGroupId)) continue;
      if (d.linkedGroupId && superseded.has(d.linkedGroupId)) {
        // The archive's link follows the chat that continues it.
        const g = await this.continuing(d.linkedGroupId);
        if (g && keys.has(g.groupId)) {
          await this.link(d, g.groupId);
          continue;
        }
      }
      const found = held.get(d.contactUserId);
      if (found) await this.link(d, found);
    }
  }

  /**
   * The accepter's side of a new contact (§5.12): the requester becomes a
   * contact the user accepted. No consent to a chat is recorded and no chat
   * is founded: either person starts one later, and the other receives it
   * as an ordinary invitation. _Why:_ whoever starts a chat owns it, so the
   * request commits nobody to a chat, and nothing races an automatic chat
   * (the engine's consent, D.89, is unused from 0.1.2).
   */
  async contactRequestAccepted(contactUserId: string): Promise<void> {
    await this.acceptAsContact(contactUserId);
    await this.syncAcceptedContacts();
  }

  /**
   * Declares to the engine the contacts the user accepted, and clears those
   * removed (§13.8). Automatic connections are never declared, nor contacts
   * added on this device only (`added`).
   *
   * _Why `added` is not declared (decided by the owner, D.91):_ the engine
   * answers a plaintext of a newer, unsupported version with a version
   * notice to declared contacts only. A modified client could send one on
   * purpose and learn from the answer that this user added it, although
   * adding sends nothing. A contact added on this device only therefore
   * stays silent to that probe, as a member who is no contact does, until
   * the relationship is mutual: they accepted this user's request or chat of
   * two, or this user accepted theirs.
   * _Cost:_ such a contact on a newer version is not told that this device
   * cannot read their messages until then.
   */
  private async syncAcceptedContacts(): Promise<void> {
    const accepted = (await this.queries.contacts.getByOwner(this.owner))
      .filter(c => c.connection === 'accepted' && c.userId !== this.owner)
      .map(c => c.userId);
    await this.groups.setAcceptedContacts(accepted);
  }

  /**
   * Makes `contactUserId` a contact of the user: `accepted` when the
   * relationship is mutual and known to the other person (the default), or
   * `added` when only this user chose it. An automatic contact (a request
   * waiting included) is upgraded, an `added` one becomes `accepted` once
   * mutual, and a member who is no contact is added with the keys the
   * engine holds (and no name unless `name` is given: it is shown by its
   * user ID until renamed). Local: sends nothing. False when the person is
   * neither a contact nor known by a chat held.
   */
  private async acceptAsContact(
    contactUserId: string,
    name?: string,
    connection: 'accepted' | 'added' = 'accepted'
  ): Promise<boolean> {
    const c = await this.queries.contacts.getByOwnerAndUser(
      this.owner,
      contactUserId
    );
    if (c) {
      if (
        c.connection === 'automatic' ||
        c.connection === 'requested' ||
        (c.connection === 'added' && connection === 'accepted')
      ) {
        dlog('engine', 'contact.connection', {
          peer: shortId(contactUserId),
          from: c.connection,
          to: connection,
        });
        await this.queries.contacts.updateByOwnerAndUser(
          this.owner,
          contactUserId,
          { connection, ...(name ? { name } : {}) }
        );
        this.eventEmitter.emit(SdkEventType.CONTACT_UPDATED, {
          contactUserId,
        });
      }
      return true;
    }
    // The keys the engine fetched from the chat's members (§12.9), never
    // from the backend, which would learn who shares a chat.
    const keys = await this.groups.keysOf(contactUserId);
    if (!keys) return false;
    dlog('engine', 'contact.connection', {
      peer: shortId(contactUserId),
      from: null,
      to: connection,
    });
    await this.queries.contacts.insert({
      ownerUserId: this.owner,
      userId: contactUserId,
      name: name ?? '',
      publicKeys: keys,
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
      connection,
    });
    this.eventEmitter.emit(SdkEventType.CONTACT_UPDATED, { contactUserId });
    return true;
  }

  /**
   * Contacts added on this device only (`added`) whose relationship has
   * become mutual and known to them: the pair's chat is held and they are in
   * it, because they accepted the chat this user started (they took part in
   * it) or this user holds theirs. They become accepted contacts, declared
   * to the engine (§13.8).
   */
  private async upgradeMutualContacts(): Promise<void> {
    let changed = false;
    for (const c of await this.queries.contacts.getByOwner(this.owner)) {
      if (c.connection !== 'added') continue;
      const groupId = await this.directChatWith(c.userId);
      const g = groupId ? await this.groups.get(groupId) : null;
      if (!g || g.status !== 'member') continue;
      if (g.owner === this.owner && g.tookPart !== true) continue;
      await this.acceptAsContact(c.userId);
      changed = true;
    }
    if (changed) await this.syncAcceptedContacts();
  }

  /**
   * "Add as contact" (§5.12): makes a member of a chat held, who is no
   * contact (an automatic connection, or no connection yet), a contact of the
   * user named `name`, on this device only (`added`).
   *
   * Nothing is sent: the session the chats need already exists or is opened
   * as for any member. _Why:_ privacy first: no message exists that tells
   * the other person, or anyone, who added whom; they learn nothing until a
   * chat is started with them, which reaches them as an ordinary invitation.
   * Being a contact is then one-sided until the other adds back or accepts
   * a chat. Until then the contact is not declared to the engine and its
   * connection follows the automatic rule (`syncAcceptedContacts`,
   * `revokeConnections`, D.91), so that nothing observable differs from a
   * member who is no contact.
   *
   * A member whose own contact request waits (`requested`) is added by
   * accepting that request, as the request screen does: it sends nothing
   * and, as any accepted request, starts no chat and consents to none. A
   * contact the user accepted, or an ordinary request waiting, is refused
   * (`already-contact`).
   */
  async addAsContact(
    contactUserId: string,
    name: string
  ): Promise<AddAsContactResult> {
    contactUserId = canonicalUserId(contactUserId);
    const trimmed = name.trim();
    if (!trimmed) return { success: false, reason: 'empty-name' };
    if (contactUserId === this.owner) {
      return { success: false, reason: 'already-contact' };
    }
    const result = await this.enqueue(async (): Promise<AddAsContactResult> => {
      const c = await this.queries.contacts.getByOwnerAndUser(
        this.owner,
        contactUserId
      );
      if (c && c.connection !== 'automatic' && c.connection !== 'requested') {
        return { success: false, reason: 'already-contact' };
      }
      if (c?.connection === 'requested') {
        dlog('engine', 'contact.add.requested', {
          peer: shortId(contactUserId),
        });
        await this.queries.contacts.updateByOwnerAndUser(
          this.owner,
          contactUserId,
          { name: trimmed }
        );
        const d = await this.discussionOf(contactUserId);
        if (d) {
          const accepted = await this.discussions.accept(d);
          if (!accepted.success) {
            return { success: false, reason: 'unknown' };
          }
          return { success: true };
        }
      }
      if (!(await this.acceptAsContact(contactUserId, trimmed, 'added'))) {
        return { success: false, reason: 'unknown' };
      }
      return { success: true };
    });
    return result ?? { success: false, reason: 'unknown' };
  }

  /**
   * "Send a contact request" (§5.12, D.100) to a contact the user added on
   * their own (`added`) whose connection has lapsed: no active session, the
   * last shared chat gone. The request is an ORDINARY contact request,
   * identical to the one sent to someone new with the same `payload`
   * (optional username, optional message), with no field that tells it
   * apart. _Why:_ such a field would tell the other person that this user
   * already had them as a contact, which adding someone on this device must
   * never reveal; the difference is handled here only, by sending the
   * request for the existing contact instead of refusing it as a duplicate.
   *
   * The contact keeps its name. Its connection becomes what a contact the
   * user added with a request has (`accepted`, as `contacts.add` then
   * `discussions.start` leave it); it is declared to the engine once the
   * session is active, that is once the other person accepted, as any
   * accepted contact. If they decline or never answer, the contact stays,
   * not connected, as any contact whose request waits. The other person
   * sees an ordinary request, whatever their own row says (D2): nothing if
   * they have no row, an `added` contact of theirs gets it as a request too.
   */
  async sendContactRequest(
    contactUserId: string,
    payload?: AnnouncementPayload
  ): Promise<SendContactRequestResult> {
    contactUserId = canonicalUserId(contactUserId);
    const result = await this.enqueue(
      async (): Promise<SendContactRequestResult> => {
        const c = await this.queries.contacts.getByOwnerAndUser(
          this.owner,
          contactUserId
        );
        if (!c || c.connection !== 'added') {
          return { success: false, reason: 'not-added' };
        }
        if (
          this.session.peerSessionStatus(decodeUserId(contactUserId)) ===
          SessionStatus.Active
        ) {
          return { success: false, reason: 'connected' };
        }
        const sent = await this.discussions.requestAgain(c, payload);
        if (!sent.success) return { success: false, reason: 'failed' };
        dlog('engine', 'contact.connection', {
          peer: shortId(contactUserId),
          from: 'added',
          to: 'accepted',
          step: 'request_sent',
        });
        await this.queries.contacts.updateByOwnerAndUser(
          this.owner,
          contactUserId,
          { connection: 'accepted' }
        );
        this.eventEmitter.emit(SdkEventType.CONTACT_UPDATED, {
          contactUserId,
        });
        return { success: true };
      }
    );
    return result ?? { success: false, reason: 'failed' };
  }

  /**
   * Declines a contact request. An ordinary request goes with its contact,
   * as before. The request of a member of a chat held (`requested`) is
   * declined, but its connection stays automatic, so that the chats keep
   * flowing; it is revoked as any other once no chat needs it. Nothing is
   * sent either way. _Why:_ the connection was answered when the request
   * arrived, whatever the user would choose, and it lives as long as the
   * chats need it, so neither the requester nor anyone else can tell a
   * declined request from one not answered yet.
   */
  async declineContactRequest(contactUserId: string): Promise<void> {
    contactUserId = canonicalUserId(contactUserId);
    // Not started (no group engine): an ordinary request is still declined.
    if (!this.started) return this.declineRequest(contactUserId);
    await this.enqueue(() => this.declineRequest(contactUserId));
  }

  private async declineRequest(contactUserId: string): Promise<void> {
    const c = await this.queries.contacts.getByOwnerAndUser(
      this.owner,
      contactUserId
    );
    if (!c) return;
    if (c.connection !== 'requested') {
      const result = await deleteContact(
        this.owner,
        contactUserId,
        this.session,
        this.queries
      );
      if (result.success) {
        this.eventEmitter.emit(SdkEventType.CONTACT_DELETED, {
          contactUserId,
        });
      }
      return;
    }
    dlog('engine', 'contact.connection', {
      peer: shortId(contactUserId),
      from: 'requested',
      to: 'automatic',
    });
    await this.queries.contacts.updateByOwnerAndUser(
      this.owner,
      contactUserId,
      {
        connection: 'automatic',
        // Hidden again, as an automatic connection is.
        ...(isTemporaryContactName(c.name) ? { name: '' } : {}),
      }
    );
    const d = await this.discussionOf(contactUserId);
    if (d?.id !== undefined) {
      await this.queries.discussions.updateById(d.id, {
        announcementMessage: null,
        updatedAt: new Date(),
      });
    }
    // The request's message is gone with the request, as a declined
    // request's is.
    for (const m of await this.queries.messages.getAnnouncementsByContact(
      this.owner,
      contactUserId
    )) {
      if (m.id !== undefined) await this.queries.messages.deleteById(m.id);
    }
    this.eventEmitter.emit(SdkEventType.CONTACT_UPDATED, { contactUserId });
    // A connection no chat needs any more goes now, as an automatic one does.
    if (this.started) {
      await this.syncConnections().catch(() =>
        logger.error('connections not synced')
      );
    }
  }

  private async applyChanges(changes: GroupChange[]): Promise<void> {
    let connections = false;
    for (const c of changes) {
      if (c.kind === 'Connections') connections = true;
      if (c.kind !== 'Superseded' || !c.by) continue;
      // A chat of two replaced: the conversation continues in `by`, the
      // replaced chat kept as its history.
      const d = (await this.discussionRows()).find(
        x => x.linkedGroupId === c.groupId
      );
      if (d) await this.link(d, c.by);
      this.eventEmitter.emit(SdkEventType.DIRECT_CHAT_SUPERSEDED, {
        contactUserId: d?.contactUserId ?? null,
        groupId: c.groupId,
        by: c.by,
        hasMessages: c.hasMessages === true,
      });
    }
    await this.reconcileLinks();
    await this.upgradeMutualContacts();
    if (connections) {
      await this.syncConnections();
    } else {
      // The keys of a member may have arrived since a connection to it was
      // wanted: try those not opened yet.
      await this.openConnections();
    }
  }

  // ── Connections ──────────────────────────────────────────────────────────

  /**
   * Whether a session asked by `contactUserId` may be accepted silently: a
   * member of a group this device holds and has accepted (§5.12).
   */
  async isCoMember(contactUserId: string): Promise<boolean> {
    try {
      return await this.groups.isCoMember(contactUserId);
    } catch {
      return false;
    }
  }

  /**
   * Opens the connections the engine wants (members of accepted groups with
   * no session and no discussion here), and revokes the automatic ones it no
   * longer needs.
   */
  private async syncConnections(): Promise<void> {
    await this.revokeConnections();
    await this.openConnections();
  }

  /** A later try of the connections whose keys had not arrived yet. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private retryConnectionsLater(): void {
    if (this.retryTimer || !this.started) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.enqueue(() => this.openConnections()).catch(error =>
        dlog(
          'engine',
          'engine.ignored_failure',
          { step: 'open_connections', ...errFields(error) },
          { lvl: 'error' }
        )
      );
    }, CONNECTION_RETRY_MS);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  private async openConnections(): Promise<void> {
    for (const peer of await this.groups.peersWantingConnection()) {
      if (peer === this.owner || this.opened.has(peer)) continue;
      const d = await this.discussionOf(peer);
      if (d?.weAccepted) continue; // its session is recovered as usual
      this.opened.add(peer);
      let contact: Contact | undefined =
        await this.queries.contacts.getByOwnerAndUser(this.owner, peer);
      if (!contact) {
        // The keys the engine fetched from the group's members (§12.9),
        // never from the backend, which would learn who shares a group.
        const keys = await this.groups.keysOf(peer);
        if (!keys) {
          this.opened.delete(peer);
          this.retryConnectionsLater();
          continue;
        }
        await this.queries.contacts.insert({
          ownerUserId: this.owner,
          userId: peer,
          name: '',
          publicKeys: keys,
          isOnline: false,
          lastSeen: new Date(),
          createdAt: new Date(),
          connection: 'automatic',
        });
        contact = await this.queries.contacts.getByOwnerAndUser(
          this.owner,
          peer
        );
      }
      if (!contact) continue;
      if (
        d &&
        contact.connection !== 'automatic' &&
        contact.connection !== 'requested' &&
        contact.connection !== 'added'
      ) {
        // This member asked for a session before this device accepted the
        // group, so it arrived as a request from someone who is no contact,
        // and the user never accepted it. Accepting it now opens a
        // connection (§5.12), answered below as for any member.
        // - A connection asked without a request (no name, message or
        //   timer: another member's device connecting) stays out of the
        //   contacts and the lists, and is revoked once no group needs it.
        // - A contact request stays shown until the user answers it
        //   (`requested`): joining a chat never removes it.
        const asked = carriesRequest(contact, d);
        dlog('engine', 'contact.connection', {
          peer: shortId(peer),
          from: contact.connection,
          to: asked ? 'requested' : 'automatic',
        });
        await this.queries.contacts.updateByOwnerAndUser(this.owner, peer, {
          connection: asked ? 'requested' : 'automatic',
          ...(!asked && isTemporaryContactName(contact.name)
            ? { name: '' }
            : {}),
        });
        this.eventEmitter.emit(SdkEventType.CONTACT_UPDATED, {
          contactUserId: peer,
        });
      }
      const result = d
        ? await this.discussions.createSessionForContact(
            peer,
            new Uint8Array(0)
          )
        : await this.discussions.openConnection(contact);
      if (!result.success) {
        this.opened.delete(peer);
        logger.error('connection not opened');
      }
    }
  }

  /** A later try of the revocations held for a ciphertext still waiting. */
  private revokeTimer: ReturnType<typeof setTimeout> | null = null;

  private revokeLater(): void {
    if (this.revokeTimer || !this.started) return;
    this.revokeTimer = setTimeout(() => {
      this.revokeTimer = null;
      void this.enqueue(() => this.revokeConnections()).catch(error =>
        dlog(
          'engine',
          'engine.ignored_failure',
          { step: 'revoke_connections', ...errFields(error) },
          { lvl: 'error' }
        )
      );
    }, CONNECTION_RETRY_MS);
    (this.revokeTimer as { unref?: () => void }).unref?.();
  }

  private async revokeConnections(): Promise<void> {
    const contacts = await this.queries.contacts.getByOwner(this.owner);
    // A contact added on this device only (`added`) follows the automatic
    // rule exactly (D.91): a connection kept alive past the last shared chat
    // would show the peer that it was added.
    const automatic = contacts
      .filter(
        c =>
          c.connection === 'automatic' ||
          c.connection === 'requested' ||
          c.connection === 'added'
      )
      .map(c => c.userId);
    const requested = new Set(
      contacts
        .filter(c => c.connection === 'requested' || c.connection === 'added')
        .map(c => c.userId)
    );
    for (const peer of await this.groups.connectionsToRevoke(automatic)) {
      // A ciphertext still waiting for this peer, such as the signed leave
      // pushed once a chat is closed, would be deleted with the contact: the
      // connection goes once it is sent (§5.12, D.86).
      if (await this.queries.groups.hasOutboxFor(this.owner, peer)) {
        this.revokeLater();
        continue;
      }
      if (requested.has(peer)) {
        // A request still waits: the connection goes as any automatic one
        // does, whatever the user will answer, so that its lifetime tells
        // nothing of the answer; the request stays shown, now as an
        // ordinary request with no session (accepting it announces anew).
        // A contact added on this device only stays listed, with its name
        // and no session.
        await this.dropSessionKeepRequest(peer);
        this.opened.delete(peer);
        continue;
      }
      const result = await deleteContact(
        this.owner,
        peer,
        this.session,
        this.queries
      );
      this.opened.delete(peer);
      if (result.success) {
        this.eventEmitter.emit(SdkEventType.CONTACT_DELETED, {
          contactUserId: peer,
        });
      }
    }
  }

  /**
   * Drops the session with `peer` and keeps its contact request: the
   * discussion stays, as a request this device has not answered, with
   * nothing to send.
   */
  private async dropSessionKeepRequest(peer: string): Promise<void> {
    const d = await this.discussionOf(peer);
    // Dropped already, or a new announcement of the peer waits as an
    // ordinary request: nothing to drop.
    if (!d?.weAccepted) return;
    if (d.id !== undefined) {
      await this.queries.discussions.updateById(d.id, {
        weAccepted: false,
        sendAnnouncement: null,
        updatedAt: new Date(),
      });
    }
    await this.session.peerDiscard(decodeUserId(peer));
    this.eventEmitter.emit(SdkEventType.CONTACT_UPDATED, {
      contactUserId: peer,
    });
  }

  /** Whether `contactUserId` is only an automatic connection. */
  async isAutomatic(contactUserId: string): Promise<boolean> {
    const c = await this.queries.contacts.getByOwnerAndUser(
      this.owner,
      contactUserId
    );
    return c?.connection === 'automatic';
  }
}
