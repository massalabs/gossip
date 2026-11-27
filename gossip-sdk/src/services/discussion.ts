/**
 * Discussion Service
 *
 * Class-based service for initializing, accepting, and managing discussions.
 */

import {
  type Discussion,
  type Contact,
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
  MessageType,
  serializeSendAnnouncement,
} from '../db/index.js';
import {
  toDiscussion,
  toSortedDiscussions,
  updateDiscussionName,
  updateDiscussionPin,
  type UpdateDiscussionNameResult,
} from '../utils/discussions.js';
import {
  AnnouncementPayload,
  encodeContactRequestPayload,
} from '../utils/announcementPayload.js';
import { UserPublicKeys, SessionStatus } from '../wasm/bindings.js';
import { AnnouncementService } from './announcement.js';
import { SessionModule } from '../wasm/session.js';
import { Logger } from '../utils/logs.js';
import { RefreshService } from './refresh.js';
import type { AuthService } from './auth.js';
import { Result } from '../utils/type.js';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter.js';
import { Queries } from '../db/queries/index.js';
import { canonicalUserId, decodeUserId } from '../utils/userId.js';
import { addContact } from '../utils/contacts.js';

const logger = new Logger('DiscussionService');

export interface DiscussionInitializationResult {
  discussionId: number;
  announcement: Uint8Array;
}

/**
 * Service for managing discussions between users.
 *
 * @example
 * ```typescript
 * const discussionService = new DiscussionService(announcementService, session, eventEmitter, refreshService);
 *
 * // Initialize a new discussion
 * const result = await discussionService.initialize(contact, 'Hello!');
 *
 * // Accept a discussion request
 * await discussionService.accept(discussion);
 *
 * // Renew a broken discussion
 * await discussionService.renew(contactUserId);
 * ```
 */
export class DiscussionService {
  private announcementService: AnnouncementService;
  private session: SessionModule;
  private eventEmitter: SdkEventEmitter;
  private refreshService?: RefreshService;
  private authService?: AuthService;
  private queries: Queries;

  constructor(
    announcementService: AnnouncementService,
    session: SessionModule,
    eventEmitter: SdkEventEmitter,
    queries: Queries,
    refreshService?: RefreshService
  ) {
    this.announcementService = announcementService;
    this.session = session;
    this.eventEmitter = eventEmitter;
    this.queries = queries;
    this.refreshService = refreshService;
  }

  setRefreshService(refreshService: RefreshService): void {
    this.refreshService = refreshService;
  }

  setAuthService(authService: AuthService): void {
    this.authService = authService;
  }

  /**
   * Initialize a discussion with a contact using SessionManager: the contact
   * request (§5.12). It opens a session and starts no chat: either person
   * starts one later (`conversations.startDirectChat`).
   * @param contact - The contact to start a discussion with
   * @param payload - Optional payload to include in the announcement (username and message)
   * @returns The discussion ID and the created announcement
   *
   * @example
   * ```ts
   * const payload: AnnouncementPayload = {
   *   username: 'alice',
   *   message: 'Hello!',
   * };
   *
   * const { discussionId, announcement } =
   *   await discussionService.initialize(contact, payload);
   * ```
   */
  async initialize(
    contact: Contact,
    payload?: AnnouncementPayload
  ): Promise<Result<DiscussionInitializationResult, Error>> {
    const log = logger.forMethod('initialize');

    try {
      const userId = this.session.userIdEncoded;

      const existing = await this.queries.discussions.getByOwnerAndContact(
        userId,
        contact.userId
      );

      if (existing?.id) {
        return {
          success: false,
          error: new Error('Discussion already exists'),
        };
      }

      log.info(
        `${userId} is establishing session with contact ${contact.name}`
      );
      const discussionId = await this.queries.discussions.insert({
        ownerUserId: userId,
        contactUserId: contact.userId,
        weAccepted: true,
        direction: DiscussionDirection.INITIATED,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      log.info(`discussion created with id: ${discussionId}`);

      // Never empty: a contact request is told from a connection by its
      // payload (§5.12). No message timer: the request starts no chat.
      const result = await this.createSessionForContact(
        contact.userId,
        encodeContactRequestPayload(payload?.username, payload?.message)
      );

      if (!result.success) {
        await this.queries.discussions.deleteById(discussionId);
        return { success: false, error: result.error };
      }

      if (payload?.message) {
        await this.queries.messages.insert({
          ownerUserId: userId,
          contactUserId: contact.userId,
          content: payload.message,
          type: MessageType.ANNOUNCEMENT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.READ,
          timestamp: new Date(),
        });
        // Store the announcement message on the discussion so the UI can display it
        await this.queries.discussions.updateById(discussionId, {
          announcementMessage: payload.message,
        });
      }

      // Emit status change event
      const discussion = await this.queries.discussions.getById(discussionId);
      if (discussion) {
        this.eventEmitter.emit(
          SdkEventType.SESSION_CREATED,
          toDiscussion(discussion)
        );
      }

      return {
        success: true,
        data: { discussionId, announcement: result.data },
      };
    } catch (error) {
      return {
        success: false,
        error: new Error('Discussion initialization failed, error: ' + error),
      };
    }
  }

  /**
   * Opens a connection with `contact` (§5.12): a session, recorded by a
   * discussion that is never a conversation, without a request message and
   * without a direct chat owed. Used for the members of accepted groups.
   */
  async openConnection(contact: Contact): Promise<Result<Uint8Array, Error>> {
    const userId = this.session.userIdEncoded;
    const existing = await this.queries.discussions.getByOwnerAndContact(
      userId,
      contact.userId
    );
    if (existing) {
      return this.createSessionForContact(contact.userId, new Uint8Array(0));
    }
    const discussionId = await this.queries.discussions.insert({
      ownerUserId: userId,
      contactUserId: contact.userId,
      weAccepted: true,
      direction: DiscussionDirection.INITIATED,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await this.createSessionForContact(
      contact.userId,
      new Uint8Array(0)
    );
    if (!result.success) {
      await this.queries.discussions.deleteById(discussionId);
    }
    return result;
  }

  /**
   * Called when the user accepts a contact request, before the session is
   * accepted: the requester becomes a contact the user accepted (§5.12).
   * It gives no consent to a chat: accepting a contact starts none.
   */
  private onContactAccepted?: (contactUserId: string) => Promise<void>;

  setOnContactAccepted(
    hook: ((contactUserId: string) => Promise<void>) | undefined
  ): void {
    this.onContactAccepted = hook;
  }

  /**
   * Accept a discussion request from a contact using SessionManager.
   * Accepting a contact request makes the requester a contact and opens the
   * session; it starts no chat and consents to none (§5.12): either person
   * starts one later, which the other receives as an ordinary invitation.
   * @param discussion - The discussion to accept
   */
  async accept(discussion: Discussion): Promise<Result<Uint8Array, Error>> {
    const log = logger.forMethod('accept');
    try {
      if (!discussion.id) {
        return { success: false, error: new Error('Discussion ID is missing') };
      }

      // The request of a member of a chat held (§5.12): its connection was
      // answered when it arrived, and the session is open. Accepting sends
      // nothing more: a new announcement would only tell the requester when
      // the user answered, and replace a session the chats use.
      const contact = await this.queries.contacts.getByOwnerAndUser(
        this.session.userIdEncoded,
        discussion.contactUserId
      );
      const connected =
        contact?.connection === 'requested' &&
        this.session.peerSessionStatus(
          decodeUserId(discussion.contactUserId)
        ) === SessionStatus.Active;

      try {
        await this.onContactAccepted?.(discussion.contactUserId);
      } catch {
        log.error('contact not marked accepted');
      }

      if (connected) {
        await this.queries.discussions.updateById(discussion.id, {
          weAccepted: true,
          updatedAt: new Date(),
        });
        this.eventEmitter.emit(
          SdkEventType.SESSION_ACCEPTED,
          discussion.contactUserId
        );
        return { success: true, data: new Uint8Array(0) };
      }

      const result = await this.createSessionForContact(
        discussion.contactUserId,
        new Uint8Array(0)
      );

      if (result.success) {
        log.info(
          `Discussion with contact ${discussion.contactUserId} accepted`,
          {
            contactUserId: discussion.contactUserId,
            bytes: result.data?.length ?? 0,
          }
        );

        // Emit status change event
        const updatedDiscussion = await this.queries.discussions.getById(
          discussion.id!
        );
        if (updatedDiscussion) {
          this.eventEmitter.emit(
            SdkEventType.SESSION_ACCEPTED,
            updatedDiscussion.contactUserId
          );
        }

        await this.refreshService?.stateUpdate();
      }

      return result;
    } catch (error) {
      log.error(`Failed to accept pending discussion, error: ${error}`);
      return {
        success: false,
        error: new Error(
          'Failed to accept pending discussion, error: ' + error
        ),
      };
    }
  }

  /**
   * Create or recreate an outgoing encrypted session with a peer and queue the new announcement to be sent to the contact.
   * Updates the discussion with the new announcement and resets the outgoing message send queue.
   * Warining : This function can only be called on a peer with whom we have a discussion.
   * @param contactUserId - Encoded user ID of the contact to create the session for
   * @param userData - Optional extra data to include in the announcement (usually empty)
   * @returns A Result containing the announcement bytes if successful, or an Error if failed
   */

  async createSessionForContact(
    contactUserId: string,
    userData: Uint8Array,
    options: { resetQueue?: boolean; triggerRefresh?: boolean } = {}
  ): Promise<Result<Uint8Array, Error>> {
    const log = logger.forMethod('createSessionForContact');
    const ownerUserId = this.session.userIdEncoded;
    contactUserId = canonicalUserId(contactUserId);

    const discussion = await this.queries.discussions.getByOwnerAndContact(
      ownerUserId,
      contactUserId
    );
    if (!discussion) {
      return { success: false, error: new Error('Discussion not found') };
    }

    const contact = await this.queries.contacts.getByOwnerAndUser(
      ownerUserId,
      contactUserId
    );
    if (!contact) {
      return { success: false, error: new Error('Contact not found') };
    }

    // Establish a new outgoing encrypted session with the peer
    const sessionResult = await this.announcementService.establishSession(
      UserPublicKeys.from_bytes(contact.publicKeys),
      userData
    );

    if (!sessionResult.success) {
      log.error('failed to establish outgoing session', {
        contactUserId,
        error: sessionResult.error,
      });
      return sessionResult;
    }

    const now = new Date();

    try {
      // add the new announcement to the discussion
      await this.queries.discussions.updateById(discussion.id!, {
        weAccepted: true,
        sendAnnouncement: serializeSendAnnouncement({
          announcement_bytes: sessionResult.data.announcement,
          mailbox: sessionResult.data.mailbox,
          when_to_send: now,
        }),
        initiationAnnouncement: sessionResult.data.announcement,
        updatedAt: now,
      });

      // Bulk recovery prepares all queues in one prior SQL transaction.
      if (options.resetQueue !== false) {
        await this.queries.messages.resetSendQueue(ownerUserId, contactUserId);
      }
    } catch (error) {
      return {
        success: false,
        error: new Error('Failed to update discussion: ' + error),
      };
    }

    try {
      /* trigger a state update to send the new announcement
      If the stateUpdate function is already running, it will be skipped.
      Explicit restoration keeps this disabled until its durable phase-5 gate.
      */
      if (options.triggerRefresh !== false) {
        await this.refreshService?.stateUpdate();
      }
    } catch (error) {
      return {
        success: false,
        error: new Error('Failed to trigger state update: ' + error),
      };
    }

    return { success: true, data: sessionResult.data.announcement };
  }

  // ─────────────────────────────────────────────────────────────────
  // Consumer-facing convenience methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Start a new discussion with a contact.
   * Wraps initialize() and triggers state update on success.
   */
  async start(
    contact: Contact,
    payload?: AnnouncementPayload
  ): Promise<Result<DiscussionInitializationResult, Error>> {
    const result = await this.initialize(contact, payload);
    if (result.success) {
      await this.refreshService?.stateUpdate();
      this.eventEmitter.emit(
        SdkEventType.DISCUSSION_UPDATED,
        result.data.discussionId
      );
    }
    return result;
  }

  /**
   * Start a discussion by userId (simplified).
   * Fetches public keys, adds the contact if needed, starts the discussion,
   * and triggers state update.
   */
  async startByUserId(
    contactUserId: string,
    name: string,
    payload?: AnnouncementPayload
  ): Promise<Result<DiscussionInitializationResult, Error>> {
    if (!this.authService) {
      return { success: false, error: new Error('AuthService not set') };
    }
    contactUserId = canonicalUserId(contactUserId);

    const pubKeys =
      await this.authService.fetchPublicKeyByUserId(contactUserId);
    const owner = this.session.userIdEncoded;
    const existing = await this.queries.contacts.getByOwnerAndUser(
      owner,
      contactUserId
    );

    let contact: Contact;
    if (existing) {
      contact = existing;
    } else {
      const addResult = await addContact(
        owner,
        contactUserId,
        name,
        pubKeys,
        this.queries
      );
      if (!addResult.success || !addResult.contact) {
        return {
          success: false,
          error: new Error(addResult.error ?? 'Failed to add contact'),
        };
      }
      contact = addResult.contact;
    }

    const result = await this.initialize(contact, payload);
    if (result.success) await this.refreshService?.stateUpdate();
    return result;
  }

  /** Renew a broken discussion (re-create outgoing session) */
  renew(contactUserId: string): Promise<Result<Uint8Array, Error>> {
    return this.createSessionForContact(contactUserId, new Uint8Array(0));
  }

  /** Get the session status with a contact */
  getStatus(contactUserId: string): SessionStatus {
    return this.session.peerSessionStatus(decodeUserId(contactUserId));
  }

  /** List all discussions for the current user */
  async list(): Promise<Discussion[]> {
    const all = await this.queries.discussions.getByOwner(
      this.session.userIdEncoded
    );
    return toSortedDiscussions(all);
  }

  /** Get a specific discussion by contact userId */
  async get(contactUserId: string): Promise<Discussion | undefined> {
    const row = await this.queries.discussions.getByOwnerAndContact(
      this.session.userIdEncoded,
      canonicalUserId(contactUserId)
    );
    return row ? toDiscussion(row) : undefined;
  }

  /** Update the custom name of a discussion */
  updateName(
    discussionId: number,
    name: string | undefined
  ): Promise<UpdateDiscussionNameResult> {
    return updateDiscussionName(discussionId, name, this.queries);
  }

  /** Pin or unpin a discussion */
  pin(discussionId: number, pinned: boolean) {
    return updateDiscussionPin(discussionId, pinned, this.queries);
  }

  /** Mute or unmute notifications for a discussion */
  async setMuted(discussionId: number, muted: boolean): Promise<void> {
    await this.queries.discussions.updateById(discussionId, {
      mutedNotifications: muted,
    });
    await this.refreshService?.stateUpdate();
  }

  /**
   * Set the auto-delete retention policy of a discussion, on this device
   * only: the earlier one-to-one format, which carried it to the peer, is no
   * longer sent (§2.1).
   *
   * @param contactUserId - The contact user ID of the discussion
   * @param durationSeconds - Retention duration in seconds, or null to disable
   */
  async setRetentionPolicy(
    contactUserId: string,
    durationSeconds: number | null
  ): Promise<void> {
    await this.queries.discussions.updateByOwnerAndContact(
      this.session.userIdEncoded,
      contactUserId,
      {
        messageRetentionDuration: durationSeconds,
        retentionPolicySetAt: Date.now(),
      }
    );
    await this.refreshService?.stateUpdate();
  }
}
