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
 * - **New contacts.** Accepting a contact request consents to the chat; the
 *   requester's device founds it once the session is active, and the
 *   accepter's device adopts it without a prompt.
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
 *   the engine no longer needs are revoked. A contact the user accepted is
 *   never revoked.
 *
 * Nothing is stored about group traffic: a link names a group key next to a
 * peer the engine's own records already list as its member.
 */

import { type Contact, type Discussion, type Queries } from '../db/index.js';
import { toDiscussion } from '../utils/discussions.js';
import { deleteContact, isTemporaryContactName } from '../utils/contacts.js';
import { decodeUserId } from '../utils/userId.js';
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
import { EARLIER_FORMAT_VERSION } from './groups.js';
import type { DiscussionService } from './discussion.js';
import { SELF_CONTACT_ID } from './selfMessage.js';
import { Logger } from '../utils/logs.js';

const logger = new Logger('ConversationService');

/** How long before trying again a connection whose keys were missing. */
const CONNECTION_RETRY_MS = 30_000;

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
    void this.enqueue(async () => {
      await this.foundOwedDirectChats();
      await this.syncAcceptedContacts();
    }).catch(() => logger.error('direct chats not founded'));
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
   * links found, owed direct chats founded, connections opened and revoked.
   */
  catchUp(): Promise<void> {
    return this.enqueue(async () => {
      await this.declareArchives();
      await this.syncAcceptedContacts();
      await this.reconcileLinks();
      await this.foundOwedDirectChats();
      await this.syncConnections();
    });
  }

  /** After a session with `contactUserId` changed (an announcement read). */
  peerChanged(contactUserId: string): Promise<void> {
    void contactUserId;
    return this.enqueue(async () => {
      await this.foundOwedDirectChats();
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
   * "Migrate to a new group" (§5.12): founds the direct chat with the
   * archive's peer and links it. What was received is processed first, and
   * the peer's own migration takes precedence: with one pending, this
   * throws `MigrationUnavailableError('invitation-pending')`.
   */
  migrate(contactUserId: string): Promise<GroupId> {
    return this.enqueue(async () => {
      const d = await this.discussionOf(contactUserId);
      if (!d?.isArchive) throw new MigrationUnavailableError('not-an-archive');
      if (d.linkedGroupId && (await this.groups.get(d.linkedGroupId))) {
        throw new MigrationUnavailableError('already-linked');
      }
      if (await this.migrationInvitation(contactUserId)) {
        throw new MigrationUnavailableError('invitation-pending');
      }
      const groupId = await this.groups.createDirectChat('', contactUserId);
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
      if (ofTwo || options.addAsContact) await this.acceptAsContact(inv.owner);
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
   * Opens the chat with a contact: its direct chat, founded now if there is
   * none (`migrate_from = 0`). For an archive, see `migrate`.
   */
  startDirectChat(contactUserId: string): Promise<GroupId> {
    return this.enqueue(async () => {
      const held = await this.directChatWith(contactUserId);
      const d = await this.discussionOf(contactUserId);
      if (held) {
        if (d) await this.link(d, held);
        return held;
      }
      if (d?.isArchive && (await this.migrationInvitation(contactUserId))) {
        throw new MigrationUnavailableError('invitation-pending');
      }
      const groupId = await this.groups.createDirectChat('', contactUserId);
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
   * The requester's side of a new contact (§5.12): once the session is
   * active, found the direct chat it owes, unless one is held.
   */
  private async foundOwedDirectChats(): Promise<void> {
    for (const d of await this.discussionRows()) {
      if (!d.directChatOwed || d.linkedGroupId) continue;
      const status = this.session.peerSessionStatus(
        decodeUserId(d.contactUserId)
      );
      if (status !== SessionStatus.Active) continue;
      const held = await this.directChatWith(d.contactUserId);
      const groupId =
        held ?? (await this.groups.createDirectChat('', d.contactUserId));
      await this.link(d, groupId);
    }
  }

  /**
   * The accepter's side of a new contact: accepting the request consents to
   * the chat its requester founds (one-shot, for two weeks).
   */
  async contactRequestAccepted(contactUserId: string): Promise<void> {
    await this.groups.consentToDirectChat(contactUserId, true);
    await this.acceptAsContact(contactUserId);
    await this.syncAcceptedContacts();
  }

  /**
   * Declares to the engine the contacts the user accepted, and clears those
   * removed (§13.8). Automatic connections are never declared.
   */
  private async syncAcceptedContacts(): Promise<void> {
    const accepted = (await this.queries.contacts.getByOwner(this.owner))
      .filter(c => c.connection === 'accepted' && c.userId !== this.owner)
      .map(c => c.userId);
    await this.groups.setAcceptedContacts(accepted);
  }

  /**
   * Makes `contactUserId` a contact the user accepted: an automatic contact
   * is upgraded, and a member who is no contact is added with the keys the
   * engine holds (and no name: it is shown by its user ID until renamed).
   */
  private async acceptAsContact(contactUserId: string): Promise<void> {
    const c = await this.queries.contacts.getByOwnerAndUser(
      this.owner,
      contactUserId
    );
    if (c) {
      if (c.connection === 'automatic') {
        await this.queries.contacts.updateByOwnerAndUser(
          this.owner,
          contactUserId,
          { connection: 'accepted' }
        );
      }
      return;
    }
    const keys = await this.groups.keysOf(contactUserId);
    if (!keys) return;
    await this.queries.contacts.insert({
      ownerUserId: this.owner,
      userId: contactUserId,
      name: '',
      publicKeys: keys,
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
      connection: 'accepted',
    });
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
      void this.enqueue(() => this.openConnections()).catch(() => undefined);
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
      if (d && contact.connection !== 'automatic') {
        // This member asked for a session before this device accepted the
        // group, so it arrived as a request from someone who is no contact,
        // and the user never accepted it. Accepting it now opens a
        // connection (§5.12): it stays out of the contacts and the lists,
        // and is revoked once no group needs it.
        await this.queries.contacts.updateByOwnerAndUser(this.owner, peer, {
          connection: 'automatic',
          ...(isTemporaryContactName(contact.name) ? { name: '' } : {}),
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

  private async revokeConnections(): Promise<void> {
    const automatic = (await this.queries.contacts.getByOwner(this.owner))
      .filter(c => c.connection === 'automatic')
      .map(c => c.userId);
    for (const peer of await this.groups.connectionsToRevoke(automatic)) {
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

  /** Whether `contactUserId` is only an automatic connection. */
  async isAutomatic(contactUserId: string): Promise<boolean> {
    const c = await this.queries.contacts.getByOwnerAndUser(
      this.owner,
      contactUserId
    );
    return c?.connection === 'automatic';
  }
}
